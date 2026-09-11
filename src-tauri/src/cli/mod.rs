//! CLI 一键配置：工具检测（PATH 扫描 + 版本）、凭据解析（网关令牌/自定义）、
//! 变更预览（不写盘）、应用（备份 + 原子写入）。
//!
//! 写入策略遵循 cc-switch 调研结论：Claude/Codex 定向合并保留用户其他配置，
//! OpenCode/Pi 增量共存；Codex 走 experimental_bearer_token 不碰 auth.json。

mod claude;
mod codex;
pub(crate) mod fsutil;
mod opencode;
mod pi;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::AppError;
use crate::service::{self, ServiceRef};

/// 一次配置任务的上下文
#[derive(Clone)]
pub(crate) struct ConfigCtx {
    pub base_url: String,
    pub api_key: String,
    pub label: String,
    pub model: Option<String>,
    /// 按家族的模型映射（Claude：fable/opus/sonnet/haiku → ANTHROPIC_DEFAULT_*_MODEL）
    pub models: Option<std::collections::HashMap<String, String>>,
    /// 可选 Anthropic 格式端点（Claude Code 优先使用）
    pub anthropic_base_url: Option<String>,
}

/// 单个文件的写入操作（secret = 含密钥，落盘时收紧权限）
pub(crate) struct FileOp {
    pub path: std::path::PathBuf,
    pub content: String,
    pub secret: bool,
}

type OpsFn = fn(&ConfigCtx) -> Result<Vec<FileOp>, AppError>;
type PathsFn = fn() -> Result<Vec<std::path::PathBuf>, AppError>;

/// 安装/升级方式：npm 全局包，或 pi 包管理器（oh-my-pi 需经 pi install 才会被 Pi 加载）
#[derive(PartialEq, Clone, Copy)]
enum InstallKind {
    Npm,
    PiPackage,
}

struct Adapter {
    id: &'static str,
    name: &'static str,
    binary: &'static str,
    /// npm 全局包名（版本检查/升级用）
    npm_pkg: &'static str,
    /// 是否支持向导写入供应商配置（oh-my-pi 只是 Pi 的扩展，不写凭据）
    configurable: bool,
    install: InstallKind,
    ops: OpsFn,
    config_paths: PathsFn,
}

fn no_ops(_ctx: &ConfigCtx) -> Result<Vec<FileOp>, AppError> {
    Ok(vec![])
}

fn ohmypipi_paths() -> Result<Vec<std::path::PathBuf>, AppError> {
    Ok(vec![pi::settings_path()?])
}

fn claude_paths() -> Result<Vec<std::path::PathBuf>, AppError> {
    Ok(vec![claude::config_path()?])
}
fn codex_paths() -> Result<Vec<std::path::PathBuf>, AppError> {
    Ok(vec![codex::config_path()?])
}
fn opencode_paths() -> Result<Vec<std::path::PathBuf>, AppError> {
    Ok(vec![opencode::config_path()?])
}
fn pi_paths() -> Result<Vec<std::path::PathBuf>, AppError> {
    Ok(vec![pi::models_path()?, pi::settings_path()?])
}

const ADAPTERS: &[Adapter] = &[
    Adapter {
        id: claude::ID,
        name: "Claude Code",
        binary: "claude",
        npm_pkg: "@anthropic-ai/claude-code",
        configurable: true,
        install: InstallKind::Npm,
        ops: claude::ops,
        config_paths: claude_paths,
    },
    Adapter {
        id: codex::ID,
        name: "Codex",
        binary: "codex",
        npm_pkg: "@openai/codex",
        configurable: true,
        install: InstallKind::Npm,
        ops: codex::ops,
        config_paths: codex_paths,
    },
    Adapter {
        id: opencode::ID,
        name: "OpenCode",
        binary: "opencode",
        npm_pkg: "opencode-ai",
        configurable: true,
        install: InstallKind::Npm,
        ops: opencode::ops,
        config_paths: opencode_paths,
    },
    Adapter {
        id: pi::ID,
        name: "Pi",
        binary: "pi",
        npm_pkg: "@mariozechner/pi-coding-agent",
        configurable: true,
        install: InstallKind::Npm,
        ops: pi::ops,
        config_paths: pi_paths,
    },
    Adapter {
        id: "oh-my-pi",
        name: "Oh My Pi",
        binary: "oh-my-pi",
        npm_pkg: "oh-my-pi",
        configurable: false,
        install: InstallKind::PiPackage,
        ops: no_ops,
        config_paths: ohmypipi_paths,
    },
];

fn adapter(id: &str) -> Result<&'static Adapter, AppError> {
    ADAPTERS
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| AppError::config(format!("未知工具：{id}")))
}

// ===== 对外 DTO =====

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTool {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub config_paths: Vec<String>,
    /// 是否支持向导写入供应商配置
    pub configurable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCredential {
    pub base_url: String,
    pub api_key: String,
    pub label: String,
    /// 可选 Anthropic 格式端点（Claude Code 用）
    pub anthropic_base_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSpec {
    pub tool: String,
    pub model: Option<String>,
    /// 按家族的模型映射（Claude：fable/opus/sonnet/haiku）
    #[serde(default)]
    pub models: Option<std::collections::HashMap<String, String>>,
    /// 用户在向导里直接编辑的完整文件内容（跳过模板生成，整体替换）
    #[serde(default)]
    pub content: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliPlanEntry {
    pub tool: String,
    pub label: String,
    pub config_path: String,
    pub exists: bool,
    pub changed: bool,
    pub before: Option<String>,
    pub after: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliApplyResult {
    pub tool: String,
    pub label: String,
    pub ok: bool,
    pub message: String,
}

// ===== 命令 =====

#[tauri::command]
pub async fn cli_detect() -> Result<Vec<CliTool>, AppError> {
    let mut out = Vec::new();
    for a in ADAPTERS {
        let bin = which(a.binary);
        let version = match &bin {
            Some(p) => run_version(p).await,
            None => None,
        };
        let config_paths = (a.config_paths)()
            .map(|ps| ps.iter().map(|p| p.display().to_string()).collect())
            .unwrap_or_default();
        out.push(CliTool {
            id: a.id.into(),
            name: a.name.into(),
            installed: tool_installed(a).await,
            path: bin,
            version,
            config_paths,
            configurable: a.configurable,
        });
    }
    Ok(out)
}

/// 解析凭据：网关令牌（服务端 reveal）/ 已存供应商（钥匙串）/ 自定义直传
#[tauri::command]
pub async fn cli_resolve_credential(
    app: AppHandle,
    spec: ServiceRef,
) -> Result<ResolvedCredential, AppError> {
    let s = service::resolve_service(&app, &spec).await?;
    Ok(ResolvedCredential {
        base_url: s.base_url,
        api_key: s.api_key,
        label: s.label,
        anthropic_base_url: s.anthropic_base_url,
    })
}

/// 预览每个目标文件的 before/after（不写盘）
#[tauri::command]
pub async fn cli_preview(
    base_url: String,
    api_key: String,
    label: String,
    targets: Vec<TargetSpec>,
    anthropic_base_url: Option<String>,
) -> Result<Vec<CliPlanEntry>, AppError> {
    let mut out = Vec::new();
    for t in targets {
        let a = adapter(&t.tool)?;
        // 用户直接提供文件内容：跳过模板生成
        if let Some(text) = override_content(&t) {
            for p in (a.config_paths)()? {
                let before = fsutil::read_text_opt(&p)?;
                out.push(CliPlanEntry {
                    tool: a.id.into(),
                    label: a.name.into(),
                    config_path: p.display().to_string(),
                    exists: before.is_some(),
                    changed: before.as_deref() != Some(text),
                    before,
                    after: text.to_string(),
                });
            }
            continue;
        }
        let ctx = ConfigCtx {
            base_url: base_url.clone(),
            api_key: api_key.clone(),
            label: label.clone(),
            model: t.model.filter(|m| !m.trim().is_empty()),
            models: t.models.clone(),
            anthropic_base_url: anthropic_base_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        };
        for op in (a.ops)(&ctx)? {
            let before = fsutil::read_text_opt(&op.path)?;
            out.push(CliPlanEntry {
                tool: a.id.into(),
                label: a.name.into(),
                config_path: op.path.display().to_string(),
                exists: before.is_some(),
                changed: before.as_deref() != Some(op.content.as_str()),
                before,
                after: op.content,
            });
        }
    }
    Ok(out)
}

/// 应用：逐文件 备份(.bak) + 原子写入；无变更则跳过
#[tauri::command]
pub async fn cli_apply(
    base_url: String,
    api_key: String,
    label: String,
    targets: Vec<TargetSpec>,
    anthropic_base_url: Option<String>,
) -> Result<Vec<CliApplyResult>, AppError> {
    let mut out = Vec::new();
    for t in targets {
        let a = adapter(&t.tool)?;
        // 用户直接提供文件内容：跳过模板生成，整体替换（含密钥，落盘收紧权限）
        if let Some(text) = override_content(&t) {
            for p in (a.config_paths)()? {
                let before = fsutil::read_text_opt(&p)?;
                let item_label = format!("{} · {}", a.name, p.display());
                if before.as_deref() == Some(text) {
                    out.push(CliApplyResult {
                        tool: a.id.into(),
                        label: item_label,
                        ok: true,
                        message: "无变更，已跳过".into(),
                    });
                    continue;
                }
                let msg = match fsutil::backup(&p) {
                    Err(e) => Err(e),
                    Ok(bak) => fsutil::atomic_write(&p, text, true).map(|_| bak),
                };
                out.push(match msg {
                    Ok(Some(b)) => CliApplyResult {
                        tool: a.id.into(),
                        label: item_label,
                        ok: true,
                        message: format!("已写入（备份 {}）", b.display()),
                    },
                    Ok(None) => CliApplyResult {
                        tool: a.id.into(),
                        label: item_label,
                        ok: true,
                        message: "已写入（新建文件）".into(),
                    },
                    Err(e) => CliApplyResult {
                        tool: a.id.into(),
                        label: item_label,
                        ok: false,
                        message: e.message,
                    },
                });
            }
            continue;
        }
        let ctx = ConfigCtx {
            base_url: base_url.clone(),
            api_key: api_key.clone(),
            label: label.clone(),
            model: t.model.filter(|m| !m.trim().is_empty()),
            models: t.models.clone(),
            anthropic_base_url: anthropic_base_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        };
        let ops = (a.ops)(&ctx);
        match ops {
            Err(e) => out.push(CliApplyResult {
                tool: a.id.into(),
                label: a.name.into(),
                ok: false,
                message: e.message,
            }),
            Ok(ops) => {
                for op in ops {
                    let before = fsutil::read_text_opt(&op.path)?;
                    let item_label = format!("{} · {}", a.name, op.path.display());
                    let apply = |op: FileOp, before: Option<String>| -> Result<String, AppError> {
                        if before.as_deref() == Some(op.content.as_str()) {
                            return Ok("无变更，已跳过".into());
                        }
                        let bak = fsutil::backup(&op.path)?;
                        fsutil::atomic_write(&op.path, &op.content, op.secret)?;
                        Ok(match bak {
                            Some(b) => format!("已写入（备份 {}）", b.display()),
                            None => "已写入（新建文件）".into(),
                        })
                    };
                    match apply(op, before) {
                        Ok(msg) => out.push(CliApplyResult {
                            tool: a.id.into(),
                            label: item_label,
                            ok: true,
                            message: msg,
                        }),
                        Err(e) => out.push(CliApplyResult {
                            tool: a.id.into(),
                            label: item_label,
                            ok: false,
                            message: e.message,
                        }),
                    }
                }
            }
        }
    }
    Ok(out)
}

// ===== 当前配置读取（首页 CLI 状态展示） =====

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCurrent {
    pub tool: String,
    pub tool_name: String,
    /// 是否读到有效配置
    pub configured: bool,
    pub base_url: Option<String>,
    /// 配置文件内嵌的供应商名（codex/pi）
    pub provider_label: Option<String>,
    pub model: Option<String>,
}

/// 读取每个 CLI 当前生效的供应商地址与模型
#[tauri::command]
pub async fn cli_current_status() -> Result<Vec<CliCurrent>, AppError> {
    let mut out = Vec::new();
    for a in ADAPTERS {
        let cur = match a.id {
            "claude" => claude::current().await,
            "codex" => codex::current().await,
            "opencode" => opencode::current().await,
            "pi" => pi::current().await,
            _ => None,
        };
        out.push(match cur {
            Some((base_url, label, model)) => CliCurrent {
                tool: a.id.into(),
                tool_name: a.name.into(),
                configured: true,
                base_url: Some(base_url),
                provider_label: label,
                model,
            },
            None => CliCurrent {
                tool: a.id.into(),
                tool_name: a.name.into(),
                configured: false,
                base_url: None,
                provider_label: None,
                model: None,
            },
        });
    }
    Ok(out)
}

async fn read_json_file(path: &std::path::Path) -> Option<serde_json::Value> {
    let text = fsutil::read_text_opt(path).ok()??;
    serde_json::from_str(&text).ok()
}

/// cc-switch 数据库导入用：把库（连同 WAL/SHM，保证一致性）复制到临时固定路径。
/// 插件连接副本而非原库——避免 cc-switch 运行时的文件锁，也避免插件连接池
/// 直接持有外部应用文件（副本路径固定，进程内复用同一健康池，绝不 close）。
#[tauri::command]
pub async fn ccswitch_db_path() -> Result<Option<String>, AppError> {
    let src = fsutil::home_dir()?.join(".cc-switch").join("cc-switch.db");
    if !src.is_file() {
        return Ok(None);
    }
    let dst = std::env::temp_dir().join("gywb-ccswitch-copy.db");
    std::fs::copy(&src, &dst)
        .map_err(|e| AppError::internal(format!("复制 cc-switch 数据库失败：{e}")))?;
    for ext in ["-wal", "-shm"] {
        let mut s = src.as_os_str().to_os_string();
        s.push(ext);
        let ps = std::path::PathBuf::from(s);
        if ps.is_file() {
            let mut d = dst.as_os_str().to_os_string();
            d.push(ext);
            let _ = std::fs::copy(&ps, std::path::PathBuf::from(d));
        }
    }
    Ok(Some(dst.display().to_string()))
}

// ===== 版本检查与升级（npm 全局包） =====

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateInfo {
    pub id: String,
    pub name: String,
    pub installed: bool,
    /// 本地 --version 原始输出
    pub version: Option<String>,
    /// 从输出中提取的 semver
    pub current: Option<String>,
    /// npm registry 上的最新版
    pub latest: Option<String>,
    pub update_available: bool,
    pub npm_package: String,
    pub error: Option<String>,
}

/// 从 "2.1.261 (Claude Code)" / "opencode 1.18.29" 之类输出提取首个 semver
fn first_semver(s: &str) -> Option<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"\d+\.\d+(?:\.\d+)?").unwrap());
    re.find(s).map(|m| m.as_str().to_string())
}

/// 目标里用户直接提供的完整文件内容（去空白后非空才算）
fn override_content(t: &TargetSpec) -> Option<&str> {
    t.content.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

async fn npm_latest(pkg: &str) -> Result<String, AppError> {
    let resp = crate::http::http_client()
        .get(format!("https://registry.npmjs.org/{pkg}/latest"))
        .send()
        .await
        .map_err(|e| AppError::network(format!("访问 npm registry 失败：{e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::network(format!(
            "npm registry 返回 HTTP {}",
            resp.status()
        )));
    }
    let v: serde_json::Value =
        resp.json().await.map_err(|_| AppError::api("npm registry 响应解析失败"))?;
    v["version"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::api("npm registry 响应缺少 version 字段"))
}

/// 检测各 CLI 的本地版本 vs npm 最新版
#[tauri::command]
pub async fn cli_check_updates() -> Result<Vec<CliUpdateInfo>, AppError> {
    let mut out = Vec::new();
    for a in ADAPTERS {
        let bin = which(a.binary);
        let version = match &bin {
            Some(p) => run_version(p).await,
            None => None,
        };
        let installed = tool_installed(a).await;
        let current = version.as_deref().and_then(first_semver);
        let (latest, error) = match npm_latest(a.npm_pkg).await {
            Ok(v) => (Some(v), None),
            Err(e) => (None, Some(e.message)),
        };
        let update_available = match (&current, &latest) {
            (Some(c), Some(l)) => c != l,
            // 装了但读不到本地版本（如 pi 包管理）→ 也提供升级入口
            (None, Some(_)) => installed,
            _ => false,
        };
        out.push(CliUpdateInfo {
            id: a.id.into(),
            name: a.name.into(),
            installed,
            version,
            current,
            latest,
            update_available,
            npm_package: a.npm_pkg.into(),
            error,
        });
    }
    Ok(out)
}

/// 通过 npm 全局安装（或 pi 包管理器）升级到最新版；完成后重新读取本地版本
#[tauri::command]
pub async fn cli_upgrade_tool(id: String) -> Result<CliApplyResult, AppError> {
    let a = adapter(&id)?;
    let mut cmd = match a.install {
        InstallKind::PiPackage => {
            let pi = which("pi").ok_or_else(|| {
                AppError::config("Oh My Pi 是 Pi 的扩展包，需要先安装 Pi CLI 才能安装")
            })?;
            let mut c = tokio::process::Command::new(pi);
            c.args(["install", a.npm_pkg]);
            c
        }
        InstallKind::Npm => {
            let pkg = format!("{}@latest", a.npm_pkg);
            if cfg!(windows) {
                let mut c = tokio::process::Command::new("cmd");
                c.args(["/C", "npm", "install", "-g", &pkg]);
                c
            } else {
                let mut c = tokio::process::Command::new("npm");
                c.args(["install", "-g", &pkg]);
                c
            }
        }
    };
    cmd.stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
        .await
        .map_err(|_| AppError::network("升级超时（5 分钟）"))?
        .map_err(|e| AppError::internal(format!("执行 npm 失败：{e}")))?;
    if !out.status.success() {
        let mut text = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if text.is_empty() {
            text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
        let tail: String = text.chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect();
        return Ok(CliApplyResult {
            tool: a.id.into(),
            label: a.name.into(),
            ok: false,
            message: format!("npm 升级失败：{tail}"),
        });
    }
    let ver = match which(a.binary) {
        Some(p) => run_version(&p).await,
        None => None,
    };
    Ok(CliApplyResult {
        tool: a.id.into(),
        label: a.name.into(),
        ok: true,
        message: match ver {
            Some(v) => format!("已升级 → {v}"),
            None => "升级完成".into(),
        },
    })
}

// ===== CLI 向导模型列表（OpenAI / Anthropic 双端口） =====

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliModelLists {
    /// 主列表：OpenAI 端口（anthropic 协议供应商则为其自身端点）
    pub openai: Vec<String>,
    /// Anthropic 端口列表（无 Anthropic 地址时为空）
    pub anthropic: Vec<String>,
    pub openai_error: Option<String>,
    pub anthropic_error: Option<String>,
}

/// CLI 向导用：一次返回两个端口的模型列表，密钥解析留在后端
#[tauri::command]
pub async fn cli_models(
    app: AppHandle,
    spec: ServiceRef,
    anthropic_base_url: Option<String>,
) -> Result<CliModelLists, AppError> {
    let svc = service::resolve_service(&app, &spec).await?;
    let anth = anthropic_base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| svc.anthropic_base_url.clone());

    let primary = if svc.api_format == "anthropic" {
        crate::llm::fetch_models_anthropic(&svc.base_url, &svc.api_key).await
    } else {
        crate::llm::fetch_models_openai(&svc.base_url, &svc.api_key).await
    };
    let (openai, openai_error) = match primary {
        Ok(v) => (v, None),
        Err(e) => (Vec::new(), Some(e.message)),
    };
    let (anthropic, anthropic_error) = match &anth {
        None => (Vec::new(), None),
        Some(ab) => match crate::llm::fetch_models_anthropic(ab, &svc.api_key).await {
            Ok(v) => (v, None),
            Err(e) => (Vec::new(), Some(e.message)),
        },
    };
    Ok(CliModelLists {
        openai,
        anthropic,
        openai_error,
        anthropic_error,
    })
}

// ===== 检测工具 =====

/// pi 包管理器安装记录（~/.pi/agent/settings.json）中是否出现某包
async fn pi_settings_contains(pkg: &str) -> bool {
    let path = match pi::settings_path() {
        Ok(p) => p,
        Err(_) => return false,
    };
    matches!(read_json_file(&path).await, Some(v) if v.to_string().contains(pkg))
}

/// 工具是否已安装：二进制在 PATH，或（pi 包）出现在 pi 安装记录里
async fn tool_installed(a: &Adapter) -> bool {
    if which(a.binary).is_some() {
        return true;
    }
    matches!(a.install, InstallKind::PiPackage) && pi_settings_contains(a.npm_pkg).await
}

fn which(name: &str) -> Option<String> {
    let path_env = std::env::var_os("PATH")?;
    let candidates: Vec<String> = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&path_env) {
        for c in &candidates {
            let p = dir.join(c);
            if p.is_file() {
                return Some(p.display().to_string());
            }
        }
    }
    None
}

async fn run_version(bin: &str) -> Option<String> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        tokio::process::Command::new(bin).arg("--version").output(),
    )
    .await
    .ok()?
    .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let line = if stdout.is_empty() { stderr } else { stdout };
    let first = line.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HOME 是进程级环境变量，涉及它的测试必须串行：
    /// 每个测试先取锁，再调用 make_home
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn make_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gywb-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HOME", &dir);
        dir
    }

    /// 测试用 mock 凭据值（不用 sk- 前缀避免安全扫描误报为真实密钥）
    const MOCK_KEY: &str = "test-key-123";

    fn ctx() -> ConfigCtx {
        ConfigCtx {
            base_url: "https://gw.example.com".into(),
            api_key: MOCK_KEY.into(),
            label: "测试网关".into(),
            model: Some("test-model".into()),
            models: None,
            anthropic_base_url: None,
        }
    }

    #[test]
    fn first_semver_extracts_from_noisy_version_output() {
        assert_eq!(first_semver("2.1.261 (Claude Code)").as_deref(), Some("2.1.261"));
        assert_eq!(first_semver("opencode 1.18.29").as_deref(), Some("1.18.29"));
        assert_eq!(first_semver("0.153.4").as_deref(), Some("0.153.4"));
        assert_eq!(first_semver("no version here"), None);
    }

    #[test]
    fn switch_model_keeps_registered_models_and_points_active() {
        let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = make_home("switch");

        // opencode：已有 provider 带两个注册模型 → 应用后模型表合并且根级指针切换
        let oc = home.join(".config").join("opencode").join("opencode.json");
        std::fs::create_dir_all(oc.parent().unwrap()).unwrap();
        std::fs::write(
            &oc,
            r#"{"theme":"dark","model":"ai-workbench/old","provider":{"ai-workbench":{"models":{"old":{"name":"old"},"keep":{"name":"keep"}}}}}"#,
        )
        .unwrap();
        let ops = opencode::ops(&ctx()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&ops[0].content).unwrap();
        assert_eq!(v["model"], "ai-workbench/test-model", "根级 model 指针应切到新模型");
        assert!(v["provider"]["ai-workbench"]["models"]["keep"].is_object(), "已注册模型应保留");
        assert!(v["provider"]["ai-workbench"]["models"]["test-model"].is_object());
        assert_eq!(v["theme"], "dark", "用户根级字段保留");

        // pi：已有 provider 带注册模型 → 应用后模型表合并且 defaultModel 切换
        let pi_dir = home.join(".pi").join("agent");
        std::fs::create_dir_all(&pi_dir).unwrap();
        std::fs::write(pi_dir.join("settings.json"), r#"{"defaultProvider":"ai-workbench","defaultModel":"old"}"#).unwrap();
        std::fs::write(
            pi_dir.join("models.json"),
            r#"{"providers":{"ai-workbench":{"baseUrl":"https://gw.example.com/v1","apiKey":"k","models":[{"id":"old","model":"old"}]}}}"#,
        )
        .unwrap();
        let ops = pi::ops(&ctx()).unwrap();
        let m: serde_json::Value = serde_json::from_str(
            &ops.iter().find(|o| o.path.ends_with("models.json")).unwrap().content,
        )
        .unwrap();
        let s: serde_json::Value = serde_json::from_str(
            &ops.iter().find(|o| o.path.ends_with("settings.json")).unwrap().content,
        )
        .unwrap();
        assert_eq!(s["defaultModel"], "test-model");
        let ids: Vec<&str> = m["providers"]["ai-workbench"]["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["id"].as_str().unwrap())
            .collect();
        assert!(ids.contains(&"old"), "已注册模型应保留：{ids:?}");
        assert!(ids.contains(&"test-model"), "新模型应合入：{ids:?}");
    }

    #[test]
    fn service_ref_accepts_camel_case() {
        let custom: ServiceRef = serde_json::from_value(serde_json::json!({
            "kind": "custom", "baseUrl": "https://x.com", "apiKey": "sk-1", "label": "自"
        }))
        .expect("custom camelCase 反序列化失败");
        assert!(matches!(custom, ServiceRef::Custom { .. }));

        let stored: ServiceRef = serde_json::from_value(serde_json::json!({
            "kind": "stored", "baseUrl": "https://x.com", "secretRef": "abc"
        }))
        .expect("stored camelCase 反序列化失败");
        assert!(matches!(stored, ServiceRef::Stored { .. }));
    }

    #[test]
    fn claude_merges_env_and_keeps_user_settings() {
        let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = make_home("claude");
        let settings = home.join(".claude").join("settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(
            &settings,
            r#"{ "env": { "CUSTOM_KEEP": "yes" }, "permissions": { "allow": ["Bash"] } }"#,
        )
        .unwrap();

        let ops = claude::ops(&ctx()).unwrap();
        assert_eq!(ops.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&ops[0].content).unwrap();
        let env = v.get("env").unwrap();
        assert_eq!(env.get("CUSTOM_KEEP").unwrap(), "yes");
        assert_eq!(env.get("ANTHROPIC_BASE_URL").unwrap(), "https://gw.example.com");
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN").unwrap(), MOCK_KEY);
        assert_eq!(env.get("ANTHROPIC_MODEL").unwrap(), "test-model");
        assert_eq!(env.get("ANTHROPIC_DEFAULT_SONNET_MODEL").unwrap(), "test-model");
        assert!(v.get("permissions").is_some(), "用户 permissions 应保留");
    }

    #[test]
    fn claude_prefers_anthropic_endpoint() {
        let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = make_home("claude-anth");
        let mut c = ctx();
        c.anthropic_base_url = Some("https://anthropic.example.com".into());
        let ops = claude::ops(&c).unwrap();
        let v: serde_json::Value = serde_json::from_str(&ops[0].content).unwrap();
        assert_eq!(
            v["env"]["ANTHROPIC_BASE_URL"],
            "https://anthropic.example.com",
            "Claude Code 应优先使用 Anthropic 专用端点"
        );
    }

    #[test]
    fn claude_family_models_map_to_default_envs() {
        let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = make_home("claude-family");
        let mut c = ctx();
        c.model = None;
        let mut m = std::collections::HashMap::new();
        m.insert("fable".to_string(), "claude-fable-5".to_string());
        m.insert("sonnet".to_string(), "glm-5.2[1M]".to_string());
        c.models = Some(m);
        let ops = claude::ops(&c).unwrap();
        let v: serde_json::Value = serde_json::from_str(&ops[0].content).unwrap();
        let env = v.get("env").unwrap();
        assert_eq!(env.get("ANTHROPIC_DEFAULT_FABLE_MODEL").unwrap(), "claude-fable-5");
        assert_eq!(env.get("ANTHROPIC_DEFAULT_SONNET_MODEL").unwrap(), "glm-5.2[1M]");
        assert!(env.get("ANTHROPIC_MODEL").is_none(), "无主模型时不写 ANTHROPIC_MODEL");
        assert!(env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").is_none(), "未填家族不写对应 env");
    }

    #[test]
    fn codex_edits_targeted_and_keeps_comments_and_mcp() {
        let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = make_home("codex");
        let cfg = home.join(".codex").join("config.toml");
        std::fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        std::fs::write(
            &cfg,
            "# 用户注释\nmodel = \"gpt-4o\"\n\n[mcp_servers.foo]\ncommand = \"npx\"\n",
        )
        .unwrap();

        let ops = codex::ops(&ctx()).unwrap();
        let s = &ops[0].content;
        assert!(s.contains("# 用户注释"), "注释应保留");
        assert!(s.contains("[mcp_servers.foo]"), "[mcp_servers] 应保留");
        assert!(s.contains("base_url = \"https://gw.example.com/v1\""));
        assert!(s.contains(&format!("experimental_bearer_token = \"{}\"", MOCK_KEY)));
        assert!(s.contains("wire_api = \"responses\""));
        assert!(s.contains("model = \"test-model\""));
        // 不触碰 auth.json
        assert!(!home.join(".codex").join("auth.json").exists());
    }

    #[test]
    fn opencode_additive_and_pi_pointer() {
        let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = make_home("oc-pi");
        let oc = home.join(".config").join("opencode").join("opencode.json");
        std::fs::create_dir_all(oc.parent().unwrap()).unwrap();
        std::fs::write(&oc, r#"{ "$schema": "x", "theme": "dark" }"#).unwrap();

        let ops = opencode::ops(&ctx()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&ops[0].content).unwrap();
        assert_eq!(v.get("$schema").unwrap(), "x", "用户根级字段保留");
        let entry = &v["provider"]["ai-workbench"];
        assert_eq!(entry["options"]["baseURL"], "https://gw.example.com/v1");
        assert_eq!(entry["options"]["apiKey"], MOCK_KEY);

        let ops = pi::ops(&ctx()).unwrap();
        assert_eq!(ops.len(), 2, "pi 应写 models.json + settings.json");
        let m: serde_json::Value =
            serde_json::from_str(&ops.iter().find(|o| o.path.ends_with("models.json")).unwrap().content)
                .unwrap();
        let p = &m["providers"]["ai-workbench"];
        assert_eq!(p["baseUrl"], "https://gw.example.com/v1");
        assert_eq!(p["api"], "openai-completions");
        assert_eq!(p["models"][0]["id"], "test-model");
        let s: serde_json::Value = serde_json::from_str(
            &ops.iter().find(|o| o.path.ends_with("settings.json")).unwrap().content,
        )
        .unwrap();
        assert_eq!(s["defaultProvider"], "ai-workbench");
        assert_eq!(s["defaultModel"], "test-model");
    }

    #[test]
    fn apply_writes_backs_up_and_skips_unchanged() {
        let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = make_home("apply");
        let settings = home.join(".claude").join("settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(&settings, r#"{"env":{}}"#).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let results = rt.block_on(cli_apply(
            "https://gw.example.com".into(),
            MOCK_KEY.into(),
            "测试".into(),
            vec![TargetSpec { tool: "claude".into(), model: None, models: None, content: None }],
            None,
        ))
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok);
        assert!(results[0].message.contains("备份"), "应生成 .bak：{}", results[0].message);
        assert!(settings.with_extension("json.bak").exists());
        let written = std::fs::read_to_string(&settings).unwrap();
        assert!(written.contains("ANTHROPIC_AUTH_TOKEN"));

        // 二次应用：无变更应跳过
        let again = rt.block_on(cli_apply(
            "https://gw.example.com".into(),
            MOCK_KEY.into(),
            "测试".into(),
            vec![TargetSpec { tool: "claude".into(), model: None, models: None, content: None }],
            None,
        ))
        .unwrap();
        assert!(again[0].message.contains("无变更"));
    }

    #[test]
    fn apply_writes_user_content_verbatim_and_skips_unchanged() {
        let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = make_home("apply-override");
        let settings = home.join(".claude").join("settings.json");

        let rt = tokio::runtime::Runtime::new().unwrap();
        let results = rt
            .block_on(cli_apply(
                "https://gw.example.com".into(),
                MOCK_KEY.into(),
                "测试".into(),
                vec![TargetSpec {
                    tool: "claude".into(),
                    model: None,
                    models: None,
                    content: Some(r#"{"env":{"ANTHROPIC_BASE_URL":"https://custom.example.com"}}"#.into()),
                }],
                None,
            ))
            .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "{}", results[0].message);
        let written = std::fs::read_to_string(&settings).unwrap();
        assert_eq!(
            written.trim(),
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://custom.example.com"}}"#,
            "用户内容应原样落盘（不混入模板 env）"
        );

        // 相同内容再次应用 → 跳过
        let again = rt
            .block_on(cli_apply(
                "https://gw.example.com".into(),
                MOCK_KEY.into(),
                "测试".into(),
                vec![TargetSpec {
                    tool: "claude".into(),
                    model: None,
                    models: None,
                    content: Some(r#"{"env":{"ANTHROPIC_BASE_URL":"https://custom.example.com"}}"#.into()),
                }],
                None,
            ))
            .unwrap();
        assert!(again[0].message.contains("无变更"));
    }
}
