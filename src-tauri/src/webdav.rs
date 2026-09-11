//! WebDAV 同步：把应用配置（config.json）与业务数据库（workbench.db）备份到
//! WebDAV 服务（默认坚果云 https://dav.jianguoyun.com/dav/），支持恢复。
//! 密码存 secrets.db（条目 "aw-webdav"），不回传前端；密钥库 secrets.db 与笔记文件不参与同步。
//! 恢复流程：下载 → 落盘替换 → 应用自动重启（sqlx 连接池需重启后重开新库文件）。

use std::path::PathBuf;

use reqwest::Method;
use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::http::http_client;
use crate::secrets;
use crate::store::{self, WebDavConfig};

const PASSWORD_REF: &str = "aw-webdav";
const DEFAULT_URL: &str = "https://dav.jianguoyun.com/dav/";
const DEFAULT_DIR: &str = "ai-workbench-sync";
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebDavState {
    pub config: Option<WebDavConfig>,
    pub has_password: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
}

struct Ctx {
    /// 目录完整 URL（带尾斜杠）
    dir_url: String,
    username: String,
    password: Option<String>,
}

fn load_ctx(app: &AppHandle) -> Result<Ctx, AppError> {
    let cfg = store::load_config(app)
        .webdav
        .ok_or_else(|| AppError::config("尚未配置 WebDAV"))?;
    let url = cfg.url.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err(AppError::config("WebDAV 服务地址不能为空"));
    }
    let dir = if cfg.dir.trim().is_empty() { DEFAULT_DIR } else { cfg.dir.trim() };
    Ok(Ctx {
        dir_url: format!("{url}/{dir}/"),
        username: cfg.username.trim().to_string(),
        password: secrets::get(PASSWORD_REF)?,
    })
}

fn req(ctx: &Ctx, method: Method, url: &str) -> reqwest::RequestBuilder {
    let mut r = http_client().request(method, url);
    if !ctx.username.is_empty() || ctx.password.is_some() {
        r = r.basic_auth(&ctx.username, ctx.password.clone());
    }
    r
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::internal(format!("无法获取应用配置目录：{e}")))
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn webdav_get_config(app: AppHandle) -> Result<WebDavState, AppError> {
    let cfg = store::load_config(&app).webdav;
    let has_password = secrets::get(PASSWORD_REF)?.map(|p| !p.is_empty()).unwrap_or(false);
    Ok(WebDavState { config: cfg, has_password })
}

/// password：None = 不修改；空串 = 清除
#[tauri::command]
pub async fn webdav_save_config(
    app: AppHandle,
    mut config: WebDavConfig,
    password: Option<String>,
) -> Result<WebDavState, AppError> {
    config.url = config.url.trim().to_string();
    if config.url.is_empty() {
        config.url = DEFAULT_URL.into();
    }
    config.username = config.username.trim().to_string();
    config.dir = config.dir.trim().trim_matches('/').to_string();
    if let Some(p) = password {
        let p = p.trim();
        if p.is_empty() {
            let _ = secrets::delete(PASSWORD_REF);
        } else {
            secrets::set(PASSWORD_REF, p)?;
        }
    }
    let mut appcfg = store::load_config(&app);
    // 保留历史时间戳
    if let Some(old) = &appcfg.webdav {
        config.last_upload_at = old.last_upload_at;
        config.last_download_at = old.last_download_at;
    }
    appcfg.webdav = Some(config);
    store::save_config(&app, &appcfg)?;
    webdav_get_config(app).await
}

#[tauri::command]
pub async fn webdav_test(app: AppHandle) -> Result<TestResult, AppError> {
    let ctx = load_ctx(&app)?;
    let propfind = Method::from_bytes(b"PROPFIND").expect("valid method");
    // 1. 探服务根（可达性 + 鉴权）
    let root_url = ctx.dir_url.trim_end_matches('/').rsplit_once('/').map(|(base, _)| base.to_string()).unwrap_or_else(|| ctx.dir_url.clone());
    let resp = req(&ctx, propfind.clone(), &root_url)
        .header("Depth", "0")
        .send()
        .await
        .map_err(|e| AppError::network(format!("请求失败：{e}")))?;
    let status = resp.status();
    if status.as_u16() == 401 {
        return Ok(TestResult { ok: false, message: "认证失败（坚果云请使用「应用密码」，不是登录密码）".into() });
    }
    if status.as_u16() == 404 {
        return Ok(TestResult { ok: false, message: "服务地址未找到（坚果云应为 https://dav.jianguoyun.com/dav/）".into() });
    }
    if !(status.is_success() || status.as_u16() == 207) {
        return Ok(TestResult { ok: false, message: format!("HTTP {status}：服务不可达或地址有误") });
    }
    // 2. 探同步目录（不存在不算失败，上传时会自动创建）
    let resp = req(&ctx, propfind, &ctx.dir_url)
        .header("Depth", "0")
        .send()
        .await
        .map_err(|e| AppError::network(format!("请求失败：{e}")))?;
    if resp.status().as_u16() == 404 {
        return Ok(TestResult { ok: true, message: "连接正常（同步目录将在上传时自动创建）".into() });
    }
    Ok(TestResult { ok: true, message: "连接正常".into() })
}

/// 用 rusqlite backup API 拿到一致快照（在线数据库直接读文件可能截到写一半的页）
fn snapshot_db(db_path: &PathBuf, dest: &PathBuf) -> Result<(), AppError> {
    let src = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| AppError::internal(format!("打开业务数据库失败：{e}")))?;
    let mut dst = Connection::open(dest).map_err(|e| AppError::internal(format!("创建快照失败：{e}")))?;
    let bak = Backup::new(&src, &mut dst).map_err(|e| AppError::internal(format!("初始化备份失败：{e}")))?;
    bak.run_to_completion(64, std::time::Duration::from_millis(2), None)
        .map_err(|e| AppError::internal(format!("备份数据库失败：{e}")))?;
    drop(bak);
    drop(src);
    dst.close()
        .map_err(|(_, e)| AppError::internal(format!("关闭快照失败：{e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn webdav_upload(app: AppHandle) -> Result<WebDavState, AppError> {
    let ctx = load_ctx(&app)?;
    let dir = data_dir(&app)?;
    let db_path = dir.join("workbench.db");
    let cfg_path = dir.join("config.json");
    if !db_path.exists() {
        return Err(AppError::config("本地还没有数据可备份"));
    }

    // 远端目录（405 = 已存在，忽略）
    let mkcol = Method::from_bytes(b"MKCOL").expect("valid method");
    let resp = req(&ctx, mkcol, ctx.dir_url.trim_end_matches('/'))
        .send()
        .await
        .map_err(|e| AppError::network(format!("创建远端目录失败：{e}")))?;
    let s = resp.status().as_u16();
    if s == 401 {
        return Err(AppError::unauthorized("认证失败（坚果云请使用「应用密码」）"));
    }
    if !(resp.status().is_success() || s == 405 || s == 301 || s == 409) {
        return Err(AppError::api(format!("创建远端目录失败（HTTP {s}）")));
    }

    // 一致性快照后上传
    let snap = dir.join(format!("workbench.db.snap-{}", std::process::id()));
    snapshot_db(&db_path, &snap)?;
    let db_bytes = tokio::fs::read(&snap)
        .await
        .map_err(|e| AppError::internal(format!("读取快照失败：{e}")))?;
    let _ = tokio::fs::remove_file(&snap).await;
    let put_db = req(&ctx, Method::PUT, &format!("{}workbench.db", ctx.dir_url))
        .header("content-type", "application/octet-stream")
        .body(db_bytes)
        .send()
        .await
        .map_err(|e| AppError::network(format!("上传数据库失败：{e}")))?;
    if !put_db.status().is_success() {
        return Err(AppError::api(format!("上传数据库失败（HTTP {}）", put_db.status())));
    }

    if let Ok(cfg_bytes) = tokio::fs::read(&cfg_path).await {
        let put_cfg = req(&ctx, Method::PUT, &format!("{}config.json", ctx.dir_url))
            .header("content-type", "application/json")
            .body(cfg_bytes)
            .send()
            .await
            .map_err(|e| AppError::network(format!("上传配置失败：{e}")))?;
        if !put_cfg.status().is_success() {
            return Err(AppError::api(format!("上传配置失败（HTTP {}）", put_cfg.status())));
        }
    }

    let mut appcfg = store::load_config(&app);
    if let Some(w) = &mut appcfg.webdav {
        w.last_upload_at = Some(now_millis());
    }
    store::save_config(&app, &appcfg)?;
    webdav_get_config(app).await
}

/// 下载云端备份并覆盖本地（config.json + workbench.db），完成后应用自动重启生效
#[tauri::command]
pub async fn webdav_restore(app: AppHandle) -> Result<(), AppError> {
    let ctx = load_ctx(&app)?;
    let dir = data_dir(&app)?;

    let resp = req(&ctx, Method::GET, &format!("{}workbench.db", ctx.dir_url))
        .send()
        .await
        .map_err(|e| AppError::network(format!("下载数据库失败：{e}")))?;
    if resp.status().as_u16() == 404 {
        return Err(AppError::config("云端还没有备份，请先在源设备上传"));
    }
    if !resp.status().is_success() {
        return Err(AppError::api(format!("下载数据库失败（HTTP {}）", resp.status())));
    }
    let db_bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::network(format!("读取数据库失败：{e}")))?;
    if !db_bytes.starts_with(SQLITE_MAGIC) {
        return Err(AppError::api("云端数据库文件校验失败（不是有效的 SQLite 文件）"));
    }

    let resp = req(&ctx, Method::GET, &format!("{}config.json", ctx.dir_url))
        .send()
        .await
        .map_err(|e| AppError::network(format!("下载配置失败：{e}")))?;
    let cfg_bytes = if resp.status().is_success() {
        resp.bytes().await.map_err(|e| AppError::network(format!("读取配置失败：{e}")))?
    } else {
        // config.json 缺失可容忍（旧备份），保留本地配置
        tokio::fs::read(dir.join("config.json")).await.unwrap_or_default().into()
    };

    // 校验通过再落盘替换，然后重启加载
    tokio::fs::write(dir.join("workbench.db"), &db_bytes)
        .await
        .map_err(|e| AppError::internal(format!("写入数据库失败：{e}")))?;
    if !cfg_bytes.is_empty() {
        tokio::fs::write(dir.join("config.json"), &cfg_bytes)
            .await
            .map_err(|e| AppError::internal(format!("写入配置失败：{e}")))?;
    }
    let mut appcfg = store::load_config(&app);
    if let Some(w) = &mut appcfg.webdav {
        w.last_download_at = Some(now_millis());
    }
    let _ = store::save_config(&app, &appcfg);
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_produces_valid_sqlite() {
        let base = std::env::temp_dir().join(format!("aw-webdav-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let src = base.join("src.db");
        let conn = Connection::open(&src).unwrap();
        conn.execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (1);").unwrap();
        conn.close().unwrap();

        let dst = base.join("snap.db");
        snapshot_db(&src, &dst).unwrap();
        let bytes = std::fs::read(&dst).unwrap();
        assert!(bytes.starts_with(SQLITE_MAGIC));

        // 源不存在应报错
        assert!(snapshot_db(&base.join("missing.db"), &base.join("x.db")).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
