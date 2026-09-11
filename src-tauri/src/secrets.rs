//! 密钥存储。按用户要求存本地 sqlite（app_data_dir/secrets.db，0600）而非系统钥匙串
//! ——钥匙串对未签名开发版应用每次访问都要求授权。打包签名后可再切回 keyring。
//! 接口保持 get/set/delete，调用点不感知存储介质。

use std::path::PathBuf;
use std::sync::OnceLock;

use rusqlite::Connection;
use serde::Deserialize;

use crate::error::AppError;

/// 网关（公司 NewAPI）系统访问令牌的条目名

static DB_PATH: OnceLock<PathBuf> = OnceLock::new();

fn db_path() -> &'static PathBuf {
    DB_PATH.get_or_init(|| PathBuf::from("secrets-uninitialized.db"))
}

/// 由 lib.rs setup 调用一次，固定存储路径
pub fn init(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(p) = DB_PATH.get() {
        if p.file_name().and_then(|f| f.to_str()) == Some("secrets-uninitialized.db") {
            let _ = std::fs::remove_file(p);
        }
    }
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = DB_PATH.set(dir.join("secrets.db"));
    }
}

fn conn() -> Result<Connection, AppError> {
    let path = db_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| AppError::internal(format!("创建数据目录失败：{e}")))?;
    }
    let c = Connection::open(path).map_err(|e| AppError::internal(format!("打开密钥库失败：{e}")))?;
    c.execute(
        "CREATE TABLE IF NOT EXISTS secrets (account TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )
    .map_err(|e| AppError::internal(format!("初始化密钥库失败：{e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(c)
}

pub fn set(account: &str, value: &str) -> Result<(), AppError> {
    conn()?.execute(
        "INSERT INTO secrets (account, value) VALUES (?1, ?2) ON CONFLICT (account) DO UPDATE SET value = ?2",
        [account, value],
    )
    .map_err(|e| AppError::internal(format!("密钥写入失败：{e}")))?;
    Ok(())
}

pub fn get(account: &str) -> Result<Option<String>, AppError> {
    let c = conn()?;
    let mut st = c
        .prepare("SELECT value FROM secrets WHERE account = ?1")
        .map_err(|e| AppError::internal(format!("密钥读取失败：{e}")))?;
    let mut rows = st
        .query_map([account], |r| r.get::<_, String>(0))
        .map_err(|e| AppError::internal(format!("密钥读取失败：{e}")))?;
    Ok(rows.next().transpose().ok().flatten())
}

pub fn delete(account: &str) -> Result<(), AppError> {
    conn()?
        .execute("DELETE FROM secrets WHERE account = ?1", [account])
        .map_err(|e| AppError::internal(format!("密钥删除失败：{e}")))?;
    Ok(())
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, AppError> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| AppError::api(format!("base64 解码失败：{e}")))
}

pub fn b64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// ===== 供前端管理供应商密钥的通用命令（只写/删，不回读——密钥不进 WebView） =====

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretPutArgs {
    pub account: String,
    pub value: String,
}

#[tauri::command]
pub fn secret_put(args: SecretPutArgs) -> Result<(), AppError> {
    if args.account.trim().is_empty() {
        return Err(AppError::config("account 不能为空"));
    }
    set(args.account.trim(), &args.value)
}

#[tauri::command]
pub fn secret_remove(account: String) -> Result<(), AppError> {
    delete(account.trim())
}
