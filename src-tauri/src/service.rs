//! 服务引用：统一描述「调用哪个 AI 服务」，并解析为 base_url + api_key。
//!
//! 两种形态：用户当场输入的自定义服务、已保存供应商（密钥存系统钥匙串按引用取）。

use serde::Deserialize;
use tauri::AppHandle;

use crate::error::AppError;
use crate::secrets;

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ServiceRef {
    /// 用户当场输入的自定义服务（密钥本来就在前端会话中）
    #[serde(rename_all = "camelCase")]
    Custom {
        base_url: String,
        api_key: String,
        label: Option<String>,
        /// 可选的 Anthropic 格式请求地址（供 Claude Code 等 CLI 使用）
        #[serde(default)]
        anthropic_base_url: Option<String>,
    },
    /// 已保存的供应商（密钥存系统钥匙串，按引用取）
    #[serde(rename_all = "camelCase")]
    Stored {
        base_url: String,
        secret_ref: String,
        label: Option<String>,
        /// 线上协议：openai（默认）| anthropic
        #[serde(default)]
        api_format: String,
        /// 可选的 Anthropic 格式请求地址（供 Claude Code 等 CLI 使用）
        #[serde(default)]
        anthropic_base_url: Option<String>,
    },
}

#[derive(Clone, Debug)]
pub struct ResolvedService {
    pub base_url: String,
    pub api_key: String,
    pub label: String,
    /// openai（默认）| anthropic
    pub api_format: String,
    /// 可选 Anthropic 端点（CLI 配置 Claude Code 时优先使用）
    pub anthropic_base_url: Option<String>,
}

/// 地址规范化：补协议、去尾斜杠（供各模块复用）
pub(crate) fn norm_base(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    if !s.starts_with("http://") && !s.starts_with("https://") {
        s = format!("https://{s}");
    }
    s
}

pub async fn resolve_service(_app: &AppHandle, r: &ServiceRef) -> Result<ResolvedService, AppError> {
    match r {
        ServiceRef::Custom { base_url, api_key, label, anthropic_base_url } => {
            let base = norm_base(base_url);
            if base.is_empty() || api_key.trim().is_empty() {
                return Err(AppError::config("请填写完整的服务地址与密钥"));
            }
            Ok(ResolvedService {
                base_url: base,
                api_key: api_key.trim().to_string(),
                label: label.clone().unwrap_or_else(|| "自定义服务".into()),
                api_format: "openai".into(),
                anthropic_base_url: anthropic_base_url
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(norm_base),
            })
        }
        ServiceRef::Stored { base_url, secret_ref, label, api_format, anthropic_base_url } => {
            let key = secrets::get(secret_ref)?
                .ok_or_else(|| AppError::config("该供应商的密钥已丢失，请重新编辑保存"))?;
            Ok(ResolvedService {
                base_url: norm_base(base_url),
                api_key: key,
                label: label.clone().unwrap_or_else(|| "供应商".into()),
                api_format: if api_format == "anthropic" { "anthropic".into() } else { "openai".into() },
                anthropic_base_url: anthropic_base_url
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(norm_base),
            })
        }
    }
}
