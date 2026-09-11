//! OpenCode：`~/.config/opencode/opencode.json` 增量写入（多 provider 共存，保留用户配置）。

use serde_json::{json, Map, Value};

use super::fsutil::{home_dir, read_text_opt};
use super::{ConfigCtx, FileOp};
use crate::error::AppError;

pub const ID: &str = "opencode";
const PROVIDER_KEY: &str = "ai-workbench";

pub fn config_path() -> Result<std::path::PathBuf, AppError> {
    Ok(home_dir()?
        .join(".config")
        .join("opencode")
        .join("opencode.json"))
}

pub fn ops(ctx: &ConfigCtx) -> Result<Vec<FileOp>, AppError> {
    let path = config_path()?;
    let existing = read_text_opt(&path)?;
    let mut root: Map<String, Value> = match &existing {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Value>(s)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .ok_or_else(|| {
                AppError::config(format!(
                    "{} 不是合法 JSON，请先手工修复后再配置",
                    path.display()
                ))
            })?,
        _ => Map::new(),
    };

    let mut entry = json!({
        "npm": "@ai-sdk/openai-compatible",
        "options": {
            "baseURL": format!("{}/v1", ctx.base_url.trim_end_matches('/')),
            "apiKey": ctx.api_key,
            "setCacheKey": true,
        },
    });
    if let Some(m) = &ctx.model {
        // 模型表合并：保留已注册的其他模型（OpenCode 只能选表内模型）
        let mut mm = root
            .get("provider")
            .and_then(|v| v.get(PROVIDER_KEY))
            .and_then(|v| v.get("models"))
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        mm.insert(m.clone(), json!({ "name": m.clone() }));
        entry["models"] = Value::Object(mm);
    }
    {
        let providers = root
            .entry("provider")
            .or_insert_with(|| Value::Object(Map::new()));
        let providers = providers
            .as_object_mut()
            .ok_or_else(|| AppError::config("opencode.json 的 provider 字段不是对象"))?;
        providers.insert(PROVIDER_KEY.into(), entry);
    }
    // 根级 model 指针一并切换——不写指针时 OpenCode 仍用旧 provider/模型
    if let Some(m) = &ctx.model {
        root.insert("model".into(), json!(format!("{PROVIDER_KEY}/{m}")));
    }

    let mut out = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| AppError::internal(format!("序列化失败：{e}")))?;
    out.push('\n');
    Ok(vec![FileOp { path, content: out, secret: true }])
}

/// 当前生效配置：根级 model 字段 "provider/model" → 对应 provider 的 baseURL
pub(crate) async fn current() -> Option<(String, Option<String>, Option<String>)> {
    use super::read_json_file;
    let v = read_json_file(&config_path().ok()?).await?;
    let model_field = v.get("model")?.as_str()?.to_string();
    let (pid, model) = model_field.split_once('/')?;
    let entry = v.get("provider")?.get(pid)?;
    let base = entry.get("options")?.get("baseURL")?.as_str()?.to_string();
    Some((base, Some(pid.to_string()), Some(model.to_string())))
}
