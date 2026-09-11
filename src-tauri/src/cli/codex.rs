//! Codex：`~/.codex/config.toml` 定向编辑（toml_edit 保留注释与 [mcp_servers]）。
//! 密钥经 `experimental_bearer_token` 注入 provider 表，**不触碰 auth.json**，
//! 保住用户的 ChatGPT 登录态（cc-switch 验证过的做法）。

use toml_edit::{value, DocumentMut, Item, Table};

use super::fsutil::{home_dir, read_text_opt};
use super::{ConfigCtx, FileOp};
use crate::error::AppError;

pub const ID: &str = "codex";
const PROVIDER_KEY: &str = "gyworkbench";

pub fn config_path() -> Result<std::path::PathBuf, AppError> {
    Ok(home_dir()?.join(".codex").join("config.toml"))
}

pub fn ops(ctx: &ConfigCtx) -> Result<Vec<FileOp>, AppError> {
    let path = config_path()?;
    let existing = read_text_opt(&path)?;
    let mut doc = match &existing {
        Some(s) if !s.trim().is_empty() => s.parse::<DocumentMut>().map_err(|e| {
            AppError::config(format!("config.toml 解析失败：{e}；请先手工修复后再配置"))
        })?,
        _ => DocumentMut::new(),
    };

    if !doc.contains_key("model_providers") {
        doc["model_providers"] = Item::Table(Table::new());
    }
    let providers = doc["model_providers"]
        .as_table_mut()
        .ok_or_else(|| AppError::config("config.toml 的 model_providers 不是表"))?;

    let mut entry = Table::new();
    entry["name"] = value(ctx.label.clone());
    entry["base_url"] = value(format!("{}/v1", ctx.base_url.trim_end_matches('/')));
    entry["wire_api"] = value("responses");
    entry["requires_openai_auth"] = value(true);
    entry["experimental_bearer_token"] = value(ctx.api_key.clone());
    providers.insert(PROVIDER_KEY, Item::Table(entry));

    doc["model_provider"] = value(PROVIDER_KEY);
    if let Some(m) = &ctx.model {
        doc["model"] = value(m.clone());
    }
    // 中转服务不需要 OpenAI 侧存储 responses
    doc["disable_response_storage"] = value(true);

    Ok(vec![FileOp { path, content: doc.to_string(), secret: true }])
}

/// 当前生效配置：model_provider 指向的 provider（name + base_url）+ model
pub(crate) async fn current() -> Option<(String, Option<String>, Option<String>)> {
    use super::fsutil::read_text_opt;
    let text = read_text_opt(&config_path().ok()?).ok()??;
    let doc: toml_edit::DocumentMut = text.parse().ok()?;
    let key = doc.get("model_provider")?.as_str()?.to_string();
    let entry = doc.get("model_providers")?.as_table()?.get(&key)?;
    let base = entry.get("base_url")?.as_str()?.to_string();
    let label = entry.get("name").and_then(|n| n.as_str()).map(str::to_string);
    let model = doc.get("model").and_then(|m| m.as_str()).map(str::to_string);
    Some((base, label, model))
}
