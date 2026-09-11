//! CLI 配置写入的文件工具：home 目录、原子写入、备份。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::AppError;

/// 用户主目录。Windows 用 USERPROFILE（避免 Git-Bash 的 HOME 污染——cc-switch 踩过的坑）
pub fn home_dir() -> Result<PathBuf, AppError> {
    #[cfg(windows)]
    let v = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let v = std::env::var_os("HOME");
    v.map(PathBuf::from)
        .ok_or_else(|| AppError::internal("无法获取用户主目录"))
}

/// 读文件；不存在返回 None
pub fn read_text_opt(path: &Path) -> Result<Option<String>, AppError> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::internal(format!("读取 {} 失败：{e}", path.display()))),
    }
}

/// 原子写入：临时文件 + rename；含密钥的文件权限收紧为 0600（unix）
pub fn atomic_write(path: &Path, content: &str, secret: bool) -> Result<(), AppError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| AppError::internal(format!("创建目录 {} 失败：{e}", dir.display())))?;
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp-gyworkbench");
    let tmp = PathBuf::from(tmp);
    {
        let mut f =
            fs::File::create(&tmp).map_err(|e| AppError::internal(format!("创建临时文件失败：{e}")))?;
        f.write_all(content.as_bytes())
            .map_err(|e| AppError::internal(format!("写入临时文件失败：{e}")))?;
    }
    #[cfg(unix)]
    if secret {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|e| AppError::internal(format!("设置文件权限失败：{e}")))?;
    }
    fs::rename(&tmp, path)
        .map_err(|e| AppError::internal(format!("落盘 {} 失败：{e}", path.display())))
}

/// 原文件存在时备份为 {path}.bak（覆盖旧备份）
pub fn backup(path: &Path) -> Result<Option<PathBuf>, AppError> {
    if !path.exists() {
        return Ok(None);
    }
    let mut s = path.as_os_str().to_os_string();
    s.push(".bak");
    let bak = PathBuf::from(s);
    fs::copy(path, &bak)
        .map_err(|e| AppError::internal(format!("备份 {} 失败：{e}", path.display())))?;
    Ok(Some(bak))
}
