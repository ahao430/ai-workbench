//! 自动更新：tauri-plugin-updater 封装。
//!
//! 更新源（latest.json 的 URL）写死为本仓库 GitHub Releases 地址，不可在设置页
//! 修改；签名公钥编译进应用（私钥构建时经 TAURI_SIGNING_PRIVATE_KEY 提供）。
//!
//! latest.json 结构（tauri-action 在发布工作流中自动生成并挂到 Release）：
//! { "version": "x.y.z", "notes": "...", "pub_date": "...",
//!   "platforms": { "darwin-aarch64": { "signature": "...", "url": "https://…/app.tar.gz" } } }

use serde::Serialize;
use tauri::AppHandle;

use tauri_plugin_updater::UpdaterExt;

use crate::error::AppError;

/// 更新包签名公钥（与构建时注入的 TAURI_SIGNING_PRIVATE_KEY 私钥配对）
const UPDATER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY5QkQyRkRDMTk4MzE0MEMKUldRTUZJTVozQys5K2UvWlBMM2thbnEyYmEvRVRDdkxvWE5NcklrNWhGVHU3eHJBRmY0Tk00bEoK";

/// 更新源地址（写死：本仓库 GitHub Releases 的 latest.json，由发布工作流自动生成）
const UPDATER_ENDPOINT: &str = "https://github.com/ahao430/ai-workbench/releases/latest/download/latest.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatus {
    pub version: String,
    pub endpoint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub current_version: String,
}

#[tauri::command]
pub async fn updater_get_status(app: AppHandle) -> Result<UpdaterStatus, AppError> {
    Ok(UpdaterStatus {
        version: app.package_info().version.to_string(),
        endpoint: UPDATER_ENDPOINT.to_string(),
    })
}

/// 更新源已写死为 OSS 地址，此命令保留兼容但不再实际修改
#[tauri::command]
pub async fn updater_set_endpoint(_app: AppHandle, _endpoint: String) -> Result<(), AppError> {
    Ok(())
}

async fn check_update(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, AppError> {
    let url = tauri::Url::parse(UPDATER_ENDPOINT)
        .map_err(|e| AppError::config(format!("更新源地址无效：{e}")))?;
    let builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| AppError::internal(format!("更新源不可用：{e}")))?;
    let updater = builder
        .pubkey(UPDATER_PUBKEY.to_string())
        .build()
        .map_err(|e| AppError::internal(format!("初始化更新器失败：{e}")))?;
    updater
        .check()
        .await
        .map_err(|e| AppError::network(format!("检查更新失败：{e}")))
}

/// 检查更新：None = 已是最新
#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<Option<UpdateInfo>, AppError> {
    match check_update(&app).await? {
        Some(u) => Ok(Some(UpdateInfo {
            version: u.version.clone(),
            notes: u.body.clone(),
            current_version: u.current_version.to_string(),
        })),
        None => Ok(None),
    }
}

// ===== GitHub Releases 简版检查（不依赖 latest.json 签名源，托盘/弹窗共用） =====

/// 发布仓库（release.yml 推 tag 自动出三平台安装包）
const GH_REPO: &str = "ahao430/ai-workbench";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUpdateInfo {
    pub current_version: String,
    /// 无任何发布时为空串
    pub latest_version: String,
    pub has_update: bool,
    pub release_url: String,
    pub notes: Option<String>,
}

/// "a.b.c" 数值逐段比较：a 是否比 b 新。段内非数值按 0 处理；
/// 同号数值时无预发布后缀（a.b.c）视为比带后缀（a.b.c-beta）更新。
fn version_newer(a: &str, b: &str) -> bool {
    let seg = |s: &str| -> Vec<(u64, bool)> {
        s.split('.')
            .map(|x| {
                let (n, suffix) = x.trim().split_once('-').unwrap_or((x.trim(), ""));
                (n.parse().unwrap_or(0), !suffix.is_empty())
            })
            .collect()
    };
    let (va, vb) = (seg(a), seg(b));
    for i in 0..va.len().max(vb.len()) {
        let x = va.get(i).copied().unwrap_or((0, false));
        let y = vb.get(i).copied().unwrap_or((0, false));
        if x.0 != y.0 {
            return x.0 > y.0;
        }
        if x.1 != y.1 {
            return !x.1;
        }
    }
    false
}

pub async fn github_check(app: &AppHandle) -> Result<GithubUpdateInfo, AppError> {
    let current = app.package_info().version.to_string();
    let fallback_url = format!("https://github.com/{GH_REPO}/releases");
    let resp = crate::http::http_client()
        .get(format!("https://api.github.com/repos/{GH_REPO}/releases/latest"))
        .send()
        .await
        .map_err(|e| AppError::network(format!("访问 GitHub 失败：{e}")))?;
    if resp.status().as_u16() == 404 {
        // 仓库还没有任何 Release
        return Ok(GithubUpdateInfo {
            current_version: current,
            latest_version: String::new(),
            has_update: false,
            release_url: fallback_url,
            notes: None,
        });
    }
    if !resp.status().is_success() {
        return Err(AppError::network(format!("GitHub 返回 HTTP {}", resp.status())));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| AppError::api("GitHub 响应解析失败"))?;
    let tag = v["tag_name"].as_str().unwrap_or("").trim().trim_start_matches('v').to_string();
    let url = v["html_url"]
        .as_str()
        .map(str::to_string)
        .unwrap_or(fallback_url);
    let notes = v["body"].as_str().map(|s| s.chars().take(500).collect::<String>());
    if tag.is_empty() {
        return Ok(GithubUpdateInfo {
            current_version: current,
            latest_version: String::new(),
            has_update: false,
            release_url: url,
            notes,
        });
    }
    let has_update = version_newer(&tag, &current);
    Ok(GithubUpdateInfo {
        current_version: current,
        latest_version: tag,
        has_update,
        release_url: url,
        notes,
    })
}

#[tauri::command]
pub async fn update_check_github(app: AppHandle) -> Result<GithubUpdateInfo, AppError> {
    github_check(&app).await
}

/// 下载进度事件（经 ipc Channel 推送到前端）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ProgressEvent {
    #[serde(rename = "started")]
    Started { total: u64 },
    #[serde(rename = "progress")]
    Progress { chunk: u64 },
    #[serde(rename = "finished")]
    Finished,
}

/// 下载并安装更新，完成后重启应用
#[tauri::command]
pub async fn updater_download_install(
    app: AppHandle,
    on_progress: tauri::ipc::Channel<ProgressEvent>,
) -> Result<(), AppError> {
    let Some(update) = check_update(&app).await? else {
        return Err(AppError::api("当前没有可用更新"));
    };
    let on_progress = std::sync::Arc::new(on_progress);
    let progress_cb = on_progress.clone();
    let finish_cb = on_progress.clone();
    let mut first_chunk = true;
    update
        .download_and_install(
            move |chunk_len, content_len| {
                if first_chunk {
                    first_chunk = false;
                    let _ = progress_cb.send(ProgressEvent::Started {
                        total: content_len.unwrap_or(0),
                    });
                }
                let _ = progress_cb.send(ProgressEvent::Progress {
                    chunk: chunk_len as u64,
                });
            },
            move || {
                let _ = finish_cb.send(ProgressEvent::Finished);
            },
        )
        .await
        .map_err(|e| AppError::network(format!("下载/安装更新失败：{e}")))?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::version_newer;

    #[test]
    fn version_compare() {
        assert!(version_newer("0.0.2", "0.0.1"));
        assert!(!version_newer("0.0.1", "0.0.1"));
        assert!(version_newer("1.2", "1.1.9"));
        assert!(version_newer("0.10.0", "0.9.0"));
        assert!(!version_newer("0.9.0", "0.10.0"));
        // 同号数值：正式版比预发布版新；非数值后缀按 0 处理不 panic
        assert!(version_newer("0.1.0", "0.1.0-beta"));
        assert!(!version_newer("0.1.0-beta", "0.1.0"));
    }
}
