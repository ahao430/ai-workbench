//! pi：`~/.pi/agent/models.json` 增量写入 providers map + `~/.pi/agent/settings.json`
//! 激活指针（defaultProvider / defaultModel，字段名经 cc-switch 源码确认）。
//! 不触碰 pi 自己的登录凭证。

use serde_json::{json, Map, Value};

use super::fsutil::{home_dir, read_text_opt};
use super::{ConfigCtx, FileOp};
use crate::error::AppError;

pub const ID: &str = "pi";
pub const PROVIDER_KEY: &str = "ai-workbench";

pub fn models_path() -> Result<std::path::PathBuf, AppError> {
    Ok(home_dir()?.join(".pi").join("agent").join("models.json"))
}

pub fn settings_path() -> Result<std::path::PathBuf, AppError> {
    Ok(home_dir()?.join(".pi").join("agent").join("settings.json"))
}

fn parse_object(path: &std::path::PathBuf, existing: &Option<String>) -> Result<Map<String, Value>, AppError> {
    match existing {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Value>(s)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .ok_or_else(|| {
                // pi 的 models.json 可能含注释（JSON5），我们保守报错不动它
                AppError::config(format!(
                    "{} 不是合法 JSON（若含注释请先去除），请手工处理后重试",
                    path.display()
                ))
            }),
        _ => Ok(Map::new()),
    }
}

pub fn ops(ctx: &ConfigCtx) -> Result<Vec<FileOp>, AppError> {
    // models.json：providers map 下新增/覆盖条目
    let m_path = models_path()?;
    let mut root = parse_object(&m_path, &read_text_opt(&m_path)?)?;
    let providers = root
        .entry("providers")
        .or_insert_with(|| Value::Object(Map::new()));
    let providers = providers
        .as_object_mut()
        .ok_or_else(|| AppError::config("models.json 的 providers 不是对象"))?;

    // 剔除无 apiKey 的 provider：pi 对 models.json 做全文件校验，任一 provider
    // 缺 apiKey 会让整个文件加载失败（含我们的 ai-workbench 也注册不上）
    let dead: Vec<String> = providers
        .iter()
        .filter(|(k, v)| {
            k.as_str() != PROVIDER_KEY
                && v.get("apiKey").and_then(|x| x.as_str()).unwrap_or("").trim().is_empty()
        })
        .map(|(k, _)| k.clone())
        .collect();
    for k in &dead {
        providers.remove(k);
    }

    let models = match &ctx.model {
        Some(m) => {
            // 模型表合并：保留 pi 里已注册的其他模型（新模型追加而非整表替换）
            let mut arr = providers
                .get(PROVIDER_KEY)
                .and_then(|v| v.get("models"))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if !arr.iter().any(|x| x["id"].as_str() == Some(m.as_str())) {
                arr.push(json!({ "id": m, "model": m, "contextWindow": 200_000 }));
            }
            Value::Array(arr)
        }
        None => json!([]),
    };
    providers.insert(
        PROVIDER_KEY.into(),
        json!({
            "name": ctx.label,
            "baseUrl": format!("{}/v1", ctx.base_url.trim_end_matches('/')),
            "api": "openai-completions",
            "apiKey": ctx.api_key,
            "models": models,
        }),
    );
    let mut models_out = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| AppError::internal(format!("序列化失败：{e}")))?;
    models_out.push('\n');

    // settings.json：激活指针
    let s_path = settings_path()?;
    let mut s_root = parse_object(&s_path, &read_text_opt(&s_path)?)?;
    s_root.insert("defaultProvider".into(), json!(PROVIDER_KEY));
    if let Some(m) = &ctx.model {
        s_root.insert("defaultModel".into(), json!(m));
    }
    let mut settings_out = serde_json::to_string_pretty(&Value::Object(s_root))
        .map_err(|e| AppError::internal(format!("序列化失败：{e}")))?;
    settings_out.push('\n');

    Ok(vec![
        FileOp { path: m_path, content: models_out, secret: true },
        FileOp { path: s_path, content: settings_out, secret: false },
    ])
}

/// 当前生效配置：settings.json 的 defaultProvider/defaultModel → models.json 的 baseUrl/name
pub(crate) async fn current() -> Option<(String, Option<String>, Option<String>)> {
    use super::read_json_file;
    let s = read_json_file(&settings_path().ok()?).await?;
    let pid = s.get("defaultProvider")?.as_str()?.to_string();
    let model = s.get("defaultModel").and_then(|m| m.as_str()).map(str::to_string);
    let m = read_json_file(&models_path().ok()?).await?;
    let entry = m.get("providers")?.get(&pid)?;
    let base = entry.get("baseUrl")?.as_str()?.to_string();
    let label = entry.get("name").and_then(|n| n.as_str()).map(str::to_string);
    Some((base, label, model))
}
