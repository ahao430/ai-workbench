//! 供应商额度查询：DeepSeek 官方余额、NewAPI 类令牌额度。
//! 查询方式由 providers.quota_type 配置（''=不查询）。

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::http::http_client;
use crate::secrets;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaResult {
    pub ok: bool,
    /// 一行摘要（首页/托盘直接显示），如「余额 ¥120.50」「剩余 $3.20 / $10.00」
    pub text: String,
    /// 订阅型额度的分项（5 小时/周/MCP 窗口），首页可展开显示重置时间
    pub limits: Vec<QuotaLimit>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(default)]
struct DeepseekBalance {
    is_available: bool,
    balance_infos: Vec<DeepseekBalanceInfo>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(default)]
struct DeepseekBalanceInfo {
    currency: String,
    total_balance: String,
}

#[derive(Deserialize, Debug, Default)]
#[serde(default)]
struct NewApiTokenUsage {
    total_granted: f64,
    total_used: f64,
    total_available: f64,
    unlimited_quota: bool,
}

/// NewAPI 响应外层包裹：{ success, data: NewApiTokenUsage }
#[derive(Deserialize, Default)]
#[serde(default)]
struct NewApiEnvelope {
    success: bool,
    data: NewApiTokenUsage,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuotaLimit {
    /// tokens | time（原始 type）
    pub kind: String,
    /// 展示名（5 小时额度 / 工具）
    pub label: String,
    pub percentage: i64,
    /// 重置时间（unix 毫秒），无则为 0
    pub next_reset_at: i64,
}

#[tauri::command]
pub async fn quota_check(
    base_url: String,
    quota_type: String,
    secret_ref: String,
    anthropic_base_url: Option<String>,
    currency: Option<String>,
) -> Result<QuotaResult, AppError> {
    let key = secrets::get(&secret_ref)?
        .ok_or_else(|| AppError::config("密钥缺失，请重新编辑保存供应商"))?;
    let cny = currency.as_deref() == Some("CNY");
    match quota_type.as_str() {
        "deepseek" => {
            let text = deepseek_balance(&key, cny).await?;
            Ok(QuotaResult { ok: true, text, limits: vec![] })
        }
        "newapi" => {
            let text = newapi_token_usage(&base_url, &key, cny).await?;
            Ok(QuotaResult { ok: true, text, limits: vec![] })
        }
        "zhipu-coding" => {
            let limits = zhipu_coding_limits(anthropic_base_url.as_deref().unwrap_or(&base_url), &key).await?;
            let summary = limits
                .iter()
                .map(|l| format!("{} {}%", l.label, l.percentage))
                .collect::<Vec<_>>()
                .join("；");
            Ok(QuotaResult { ok: true, text: summary, limits })
        }
        _ => Err(AppError::config("未配置额度查询方式")),
    }
}

/// DeepSeek 官方余额：GET /user/balance（cny=用户选择 ¥，缺省跟随平台货币）
async fn deepseek_balance(key: &str, cny: bool) -> Result<String, AppError> {
    let resp = http_client()
        .get("https://api.deepseek.com/user/balance")
        .bearer_auth(key)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::api(format!("查询失败（HTTP {}）", resp.status())));
    }
    let b: DeepseekBalance = resp.json().await.map_err(|_| AppError::api("响应解析失败"))?;
    let info = b
        .balance_infos
        .first()
        .ok_or_else(|| AppError::api("无余额信息"))?;
    let symbol = if cny { "¥" } else if info.currency == "CNY" { "¥" } else { "$" };
    Ok(format!("余额 {}{}", symbol, info.total_balance))
}

/// 智谱 Coding Plan 订阅额度：GET {anthropic域}/api/monitor/usage/quota/limit
/// 鉴权为裸 token（Authorization: <token>，无 Bearer 前缀）——与官方插件一致。
/// limits 带周期字段：unit 3=小时 4=天 5=周 6=月；TOKENS_LIMIT(unit3×5)=5 小时窗，
/// TIME_LIMIT(unit5×1)=工具额度（search/web-reader 等调用计入）。展示顺序固定：
/// 5 小时额度在前、工具在后（托盘弹窗与 AI 服务页共用），label 分别为「5 小时额度」「工具」。
async fn zhipu_coding_limits(anthropic_base_url: &str, key: &str) -> Result<Vec<QuotaLimit>, AppError> {
    #[derive(Deserialize, Debug, Default)]
    #[serde(default)]
    struct RawLimit {
        #[serde(rename = "type")]
        kind: String,
        unit: i64,
        number: i64,
        percentage: i64,
        #[serde(rename = "nextResetTime")]
        next_reset_time: i64,
    }
    #[derive(Deserialize, Debug, Default)]
    #[serde(default)]
    struct RawResp {
        data: Option<RawData>,
    }
    #[derive(Deserialize, Debug, Default)]
    #[serde(default)]
    struct RawData {
        limits: Vec<RawLimit>,
    }

    fn window_label(unit: i64, number: i64) -> String {
        match unit {
            3 => format!("{number} 小时"),
            4 => format!("{number} 天"),
            5 if number == 1 => "周".into(),
            5 => format!("{number} 周"),
            6 => "月".into(),
            _ => format!("{number}×u{unit}"),
        }
    }

    let domain = anthropic_base_url
        .trim_end_matches('/')
        .split("/api/")
        .next()
        .unwrap_or(anthropic_base_url)
        .to_string();
    let url = format!("{domain}/api/monitor/usage/quota/limit");
    let resp = http_client().get(&url).header("Authorization", key).send().await?;
    if !resp.status().is_success() {
        return Err(AppError::api(format!("查询失败（HTTP {}）", resp.status())));
    }
    let r: RawResp = resp.json().await.map_err(|_| AppError::api("响应解析失败"))?;
    let mut limits: Vec<QuotaLimit> = r
        .data
        .map(|d| d.limits)
        .unwrap_or_default()
        .into_iter()
        .map(|l| {
            let window = window_label(l.unit, l.number);
            let label = match l.kind.as_str() {
                // 5 小时窗（提示/Token 额度）
                "TOKENS_LIMIT" => format!("{window}额度"),
                // 工具调用额度（search-prime / web-reader / zread 计入），文案就叫「工具」
                "TIME_LIMIT" => "工具".into(),
                other => format!("{other} {window}"),
            };
            QuotaLimit {
                kind: l.kind.clone(),
                label,
                percentage: l.percentage,
                next_reset_at: l.next_reset_time,
            }
        })
        .collect();
    // 固定展示顺序：5 小时额度在前、工具在后（API 返回顺序不保证）
    limits.sort_by_key(|l| match l.kind.as_str() {
        "TOKENS_LIMIT" => 0,
        "TIME_LIMIT" => 1,
        _ => 2,
    });
    Ok(limits)
}

/// NewAPI 类令牌额度：GET {base}/api/usage/token（cny=按网关人民币口径展示，缺省 $）
async fn newapi_token_usage(base_url: &str, key: &str, cny: bool) -> Result<String, AppError> {
    let url = format!("{}/api/usage/token", base_url.trim_end_matches('/'));
    let resp = http_client().get(&url).bearer_auth(key).send().await?;
    if !resp.status().is_success() {
        return Err(AppError::api(format!("查询失败（HTTP {}）", resp.status())));
    }
    // NewAPI 返回 { success, data: { total_granted, ... } }；兼容无包裹的扁平结构
    let v: serde_json::Value = resp.json().await.map_err(|_| AppError::api("响应解析失败"))?;
    let u: NewApiTokenUsage = if v.get("data").is_some() {
        serde_json::from_value(v["data"].clone()).unwrap_or_default()
    } else {
        serde_json::from_value(v).unwrap_or_default()
    };
    if u.unlimited_quota {
        return Ok("额度无限".into());
    }
    let unit = 500_000.0;
    let sym = if cny { "¥" } else { "$" };
    Ok(format!(
        "剩余 {sym}{:.2} / {sym}{:.2}",
        u.total_available / unit,
        u.total_granted / unit
    ))
}
