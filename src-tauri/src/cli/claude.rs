//! Claude Code：`~/.claude/settings.json` 的 env 块合并写入（保留用户其他设置）。
//! 格式经 cc-switch（MIT）验证：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN，
//! 可选模型映射 ANTHROPIC_MODEL 与三个 DEFAULT_*_MODEL。

use serde_json::{json, Map, Value};

use super::fsutil::{home_dir, read_text_opt};
use super::{ConfigCtx, FileOp};
use crate::error::AppError;

pub const ID: &str = "claude";

pub fn config_path() -> Result<std::path::PathBuf, AppError> {
    Ok(home_dir()?.join(".claude").join("settings.json"))
}

pub fn ops(ctx: &ConfigCtx) -> Result<Vec<FileOp>, AppError> {    let path = config_path()?;
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

    let env = root
        .entry("env")
        .or_insert_with(|| Value::Object(Map::new()));
    let env = env
        .as_object_mut()
        .ok_or_else(|| AppError::config("settings.json 的 env 字段不是对象"))?;

    // Claude Code 会自行拼接 /v1/messages；地址优先用供应商/网关的 Anthropic 专用端点
    let base = ctx.anthropic_base_url.clone().unwrap_or_else(|| ctx.base_url.clone());
    env.insert("ANTHROPIC_BASE_URL".into(), json!(base));
    env.insert("ANTHROPIC_AUTH_TOKEN".into(), json!(ctx.api_key));
    if let Some(m) = &ctx.model {
        env.insert("ANTHROPIC_MODEL".into(), json!(m));
    }
    // 按家族映射（向导的 fable/opus/sonnet/haiku 四输入）；未填家族回退主模型
    let family = |key: &str| -> Option<&str> {
        ctx.models
            .as_ref()
            .and_then(|m| m.get(key))
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .or(ctx.model.as_deref())
    };
    for (env_key, fam_key) in [
        ("ANTHROPIC_DEFAULT_FABLE_MODEL", "fable"),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", "opus"),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", "sonnet"),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", "haiku"),
    ] {
        if let Some(v) = family(fam_key) {
            env.insert(env_key.into(), json!(v));
        }
    }

    // serde_json 默认 BTreeMap → 键有序，输出确定
    let mut out = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| AppError::internal(format!("序列化失败：{e}")))?;
    out.push('\n');
    Ok(vec![FileOp { path, content: out, secret: true }])
}

/// 当前生效配置：env.ANTHROPIC_BASE_URL + 模型（ANTHROPIC_MODEL 优先，退回 DEFAULT_SONNET）
pub(crate) async fn current() -> Option<(String, Option<String>, Option<String>)> {
    use super::read_json_file;
    let v = read_json_file(&config_path().ok()?).await?;
    let env = v.get("env")?;
    let base = env.get("ANTHROPIC_BASE_URL")?.as_str()?.to_string();
    let model = env
        .get("ANTHROPIC_MODEL")
        .and_then(|m| m.as_str())
        .or_else(|| env.get("ANTHROPIC_DEFAULT_SONNET_MODEL").and_then(|m| m.as_str()))
        .map(str::to_string);
    Some((base, None, model))
}
