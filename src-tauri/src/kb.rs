//! 外接知识库：多连接多知识库 REST 检索适配器（协议对齐 agent-platform packages/knowledge）。
//! provider 三种：
//!   weknora      腾讯 WeKnora v0.7+：X-API-Key 头；GET /api/v1/knowledge-bases 列表；
//!                POST /api/v1/knowledge-search body {query, knowledge_base_ids:[id]} → {data:[...]}；
//!                端点无 top_k/阈值参数，远端返回全量命中，本地过滤+排序截断
//!   dify         Dify Knowledge API（Bearer）：GET /v1/datasets；POST /v1/datasets/{id}/retrieve，
//!                retrieval_model 必带 search_method/reranking_enable（缺则远端 500）
//!   external-api Dify 外部知识库 API 协议（Bearer）：POST endpoint
//!                {knowledge_id, query, retrieval_param:{top_k}} → {records:[...]}
//! 检索：所有已启用知识库并发查询 → 阈值过滤（默认 0.5，0 关闭）→ score 合并去重截断；
//! 单库失败不炸整次，全部失败才返回错误。命中存在但全被阈值过滤时也报错
//! （附最高分与调阈值的指引）——否则聊天侧只会"没有来源"，用户无从排查。

use std::collections::HashSet;

use futures_util::future::join_all;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::error::AppError;
use crate::http::http_client;
use crate::secrets;
use crate::store::{self, KbApiConfig, KbEntry};

const DEFAULT_SCORE_THRESHOLD: f64 = 0.5;

fn provider_of(s: &str) -> &'static str {
    match s {
        "dify" => "dify",
        "external-api" => "external-api",
        _ => "weknora",
    }
}

fn trim_base(endpoint: &str) -> &str {
    endpoint.trim().trim_end_matches('/')
}

/// dify 基址自动补 /v1（endpoint 填 http://host 或 http://host/v1 均可）
fn dify_base(endpoint: &str) -> String {
    let t = trim_base(endpoint);
    if t.ends_with("/v1") { t.to_string() } else { format!("{t}/v1") }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KbChunk {
    pub content: String,
    pub title: Option<String>,
    pub source: Option<String>,
    pub score: Option<f64>,
    pub api_name: Option<String>,
    pub kb_name: Option<String>,
    /// 知识库条目在服务商 Web 端的页面链接（weknora 可拼；其余无则为空）
    pub url: Option<String>,
}

/// 知识库列表接口返回的条目
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KbListed {
    pub key: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub doc_count: Option<i64>,
}

/// token 永不回传前端，仅返回钥匙串条目名（存在即「已设置」）
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct KbState {
    pub apis: Vec<KbApiConfig>,
    pub entries: Vec<KbEntry>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
}

fn state_of(cfg: &store::AppConfig) -> KbState {
    KbState { apis: cfg.kb_apis.clone(), entries: cfg.kb_entries.clone() }
}

#[tauri::command]
pub async fn kb_get_config(app: AppHandle) -> Result<KbState, AppError> {
    Ok(state_of(&store::load_config(&app)))
}

#[tauri::command]
pub async fn kb_save_api(
    app: AppHandle,
    mut api: KbApiConfig,
    token: Option<String>,
) -> Result<KbState, AppError> {
    api.name = api.name.trim().to_string();
    if api.name.is_empty() {
        api.name = "知识库连接".into();
    }
    api.provider = provider_of(&api.provider).to_string();
    api.base_url = api.base_url.trim().to_string();
    if api.base_url.is_empty() {
        return Err(AppError::config("服务地址不能为空"));
    }
    // 阈值越界视为未配置（走默认 0.5）
    if let Some(t) = api.score_threshold {
        if !(0.0..=1.0).contains(&t) {
            api.score_threshold = None;
        }
    }
    if let Some(t) = token {
        let t = t.trim();
        if t.is_empty() {
            if let Some(r) = &api.token_ref {
                secrets::delete(r)?;
            }
            api.token_ref = None;
        } else {
            let r = api.token_ref.clone().unwrap_or_else(|| format!("kb-{}", store::now_nanos()));
            secrets::set(&r, t)?;
            api.token_ref = Some(r);
        }
    }
    let mut cfg = store::load_config(&app);
    if api.id.is_empty() {
        api.id = format!("kb-{}", store::now_nanos());
        cfg.kb_apis.push(api);
    } else {
        match cfg.kb_apis.iter_mut().find(|a| a.id == api.id) {
            Some(slot) => *slot = api,
            None => return Err(AppError::config("连接不存在，可能已被删除")),
        }
    }
    store::save_config(&app, &cfg)?;
    Ok(state_of(&cfg))
}

#[tauri::command]
pub async fn kb_remove_api(app: AppHandle, api_id: String) -> Result<KbState, AppError> {
    let mut cfg = store::load_config(&app);
    if let Some(pos) = cfg.kb_apis.iter().position(|a| a.id == api_id) {
        let api = cfg.kb_apis.remove(pos);
        if let Some(r) = &api.token_ref {
            let _ = secrets::delete(r);
        }
    }
    cfg.kb_entries.retain(|e| e.api_id != api_id);
    store::save_config(&app, &cfg)?;
    Ok(state_of(&cfg))
}

/// 覆盖式更新某连接挂载的知识库列表（相同 key 的条目保留原 id，会话里的引用不失效）
#[tauri::command]
pub async fn kb_set_entries(
    app: AppHandle,
    api_id: String,
    entries: Vec<KbEntry>,
) -> Result<KbState, AppError> {
    let mut cfg = store::load_config(&app);
    if !cfg.kb_apis.iter().any(|a| a.id == api_id) {
        return Err(AppError::config("连接不存在，可能已被删除"));
    }
    let mut cleaned: Vec<KbEntry> = Vec::new();
    for e in entries {
        let key = e.key.trim().to_string();
        if key.is_empty() || cleaned.iter().any(|c| c.key == key) {
            continue;
        }
        let name = if e.name.trim().is_empty() { key.clone() } else { e.name.trim().to_string() };
        let id = e.id.trim().to_string();
        let id = if id.is_empty() {
            cfg.kb_entries
                .iter()
                .find(|old| old.api_id == api_id && old.key == key)
                .map(|old| old.id.clone())
                .unwrap_or_else(|| format!("ke-{}", store::now_nanos()))
        } else {
            id
        };
        cleaned.push(KbEntry { id, api_id: api_id.clone(), key, name, enabled: e.enabled });
    }
    cfg.kb_entries.retain(|e| e.api_id != api_id);
    cfg.kb_entries.extend(cleaned);
    store::save_config(&app, &cfg)?;
    Ok(state_of(&cfg))
}

/// 从连接拉取远端知识库列表（external-api 协议无列表端点，走手动添加）
#[tauri::command]
pub async fn kb_fetch_list(app: AppHandle, api_id: String) -> Result<Vec<KbListed>, AppError> {
    let cfg = store::load_config(&app);
    let api = cfg
        .kb_apis
        .iter()
        .find(|a| a.id == api_id)
        .ok_or_else(|| AppError::config("连接不存在，可能已被删除"))?
        .clone();
    let provider = provider_of(&api.provider);
    let token = match &api.token_ref {
        Some(r) => secrets::get(r)?,
        None => None,
    };
    let (url, req) = match provider {
        "weknora" => (
            format!("{}/api/v1/knowledge-bases", trim_base(&api.base_url)),
            with_auth(http_client().get(format!("{}/api/v1/knowledge-bases", trim_base(&api.base_url))), provider, &token),
        ),
        "dify" => {
            let url = format!("{}/datasets?page=1&limit=100", dify_base(&api.base_url));
            (url.clone(), with_auth(http_client().get(url), provider, &token))
        }
        _ => return Err(AppError::config("该连接类型（Dify 外部知识 API）无列表端点，请手动添加知识库")),
    };
    let _ = url;
    let resp = req.send().await?;
    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|_| AppError::api(format!("知识库列表响应解析失败（HTTP {status}）")))?;
    if !status.is_success() {
        let msg = v["message"].as_str().unwrap_or("拉取失败");
        return Err(AppError::api(format!("HTTP {status}：{msg}")));
    }
    Ok(parse_listed(provider, &v))
}

fn parse_listed(provider: &str, v: &Value) -> Vec<KbListed> {
    let arr = v["data"].as_array().or_else(|| v.as_array()).cloned().unwrap_or_default();
    arr.iter()
        .filter_map(|c| {
            let key = ["id", "key", "uuid"]
                .iter()
                .find_map(|f| c[f].as_str().map(str::to_string).or_else(|| c[f].as_i64().map(|n| n.to_string())))?;
            let name = c["name"].as_str().or_else(|| c["title"].as_str()).map(str::to_string);
            let description =
                c["description"].as_str().or_else(|| c["desc"].as_str()).map(str::to_string);
            let doc_count = if provider == "dify" {
                c["document_count"].as_i64()
            } else {
                c["knowledge_count"].as_i64()
            };
            Some(KbListed { key, name, description, doc_count })
        })
        .collect()
}

/// 测试连接连通性（不落库）
#[tauri::command]
pub async fn kb_test_api(app: AppHandle, api_id: String) -> Result<TestResult, AppError> {
    let cfg = store::load_config(&app);
    let api = cfg
        .kb_apis
        .iter()
        .find(|a| a.id == api_id)
        .ok_or_else(|| AppError::config("连接不存在，可能已被删除"))?
        .clone();
    let provider = provider_of(&api.provider);
    let token = match &api.token_ref {
        Some(r) => secrets::get(r)?,
        None => None,
    };
    let send = |req: reqwest::RequestBuilder| async move { req.send().await };
    let res = match provider {
        "weknora" => {
            send(with_auth(
                http_client().get(format!("{}/api/v1/knowledge-bases", trim_base(&api.base_url))),
                provider,
                &token,
            ))
            .await
        }
        "dify" => {
            send(with_auth(
                http_client().get(format!("{}/datasets?page=1&limit=1", dify_base(&api.base_url))),
                provider,
                &token,
            ))
            .await
        }
        _ => {
            send(with_auth(
                http_client().post(trim_base(&api.base_url)).json(&json!({
                    "knowledge_id": "connection-test",
                    "query": "ping",
                    "retrieval_param": { "top_k": 1 }
                })),
                provider,
                &token,
            ))
            .await
        }
    };
    let resp = res.map_err(|e| AppError::network(format!("请求失败：{e}")))?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v["message"].as_str().unwrap_or("");
        return Ok(TestResult {
            ok: false,
            message: format!("HTTP {status}：{}", if msg.is_empty() { "鉴权或地址有误" } else { msg }),
        });
    }
    match provider {
        "weknora" | "dify" => {
            let n = v["data"].as_array().map(|a| a.len()).unwrap_or(0);
            if n == 0 && v["data"].as_array().is_none() {
                Ok(TestResult { ok: false, message: "响应形状异常（缺 data 数组）".into() })
            } else {
                Ok(TestResult { ok: true, message: format!("连接正常（远端共 {n} 个知识库）") })
            }
        }
        _ => {
            if v["records"].as_array().is_some() {
                Ok(TestResult { ok: true, message: "连接正常".into() })
            } else {
                Ok(TestResult { ok: false, message: "响应不是 { records: [...] } 形状".into() })
            }
        }
    }
}

fn with_auth(req: reqwest::RequestBuilder, provider: &str, token: &Option<String>) -> reqwest::RequestBuilder {
    match token {
        Some(t) if !t.is_empty() => {
            if provider == "weknora" {
                req.header("x-api-key", t.as_str())
            } else {
                req.bearer_auth(t.as_str())
            }
        }
        _ => req,
    }
}

struct SearchTask {
    provider: &'static str,
    url: String,
    body: Value,
    token_ref: Option<String>,
    api_name: String,
    kb_name: String,
    threshold: f64,
    /// 服务商 Web 端根地址（weknora 拼知识库页面链接用）
    base: String,
}

/// 单个知识库条目的检索结果（含阈值过滤前的统计，供空结果时组装提示）
struct TaskOutcome {
    chunks: Vec<KbChunk>,
    raw_hits: usize,
    max_score: f64,
    threshold: f64,
}

/// 检索结果为空时的用户提示；None = 确实无相关内容，保持静默（聊天侧正常作答不打扰）。
/// 命中存在但全被阈值滤掉必须显式报出来，否则用户只看到"没有引用来源"无从排查。
fn empty_result_message(errors: &[String], raw_hits: usize, max_score: f64, min_threshold: f64) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if !errors.is_empty() {
        parts.push(errors.join("；"));
    }
    if raw_hits > 0 {
        parts.push(format!(
            "知识库命中 {raw_hits} 条但相似度最高 {max_score:.2}，均低于阈值 {min_threshold:.2}；可在「知识库」页编辑该连接，调低相似度阈值（0 为关闭过滤）"
        ));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("；"))
    }
}

#[tauri::command]
pub async fn kb_search(
    app: AppHandle,
    query: String,
    top_k: Option<i32>,
    entry_ids: Option<Vec<String>>,
) -> Result<Vec<KbChunk>, AppError> {
    let cfg = store::load_config(&app);
    if cfg.kb_apis.is_empty() {
        return Err(AppError::config("尚未配置知识库"));
    }
    let top_k = top_k.unwrap_or(5).clamp(1, 20);
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(vec![]);
    }
    // 检索范围：显式选择了条目 = 按选择（忽略 enabled 开关）；未选 = 全部已启用条目
    let picked: Option<std::collections::HashSet<&str>> = entry_ids.as_ref().map(|ids| {
        ids.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect()
    });

    let mut tasks: Vec<SearchTask> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for api in &cfg.kb_apis {
        let provider = provider_of(&api.provider);
        let threshold = api.score_threshold.unwrap_or(DEFAULT_SCORE_THRESHOLD);
        let entries: Vec<&KbEntry> = cfg
            .kb_entries
            .iter()
            .filter(|e| {
                if e.api_id != api.id {
                    return false;
                }
                match &picked {
                    Some(p) => p.contains(e.id.as_str()),
                    None => e.enabled,
                }
            })
            .collect();
        if entries.is_empty() {
            skipped.push(format!("{}：未挂载知识库", api.name));
            continue;
        }
        for e in entries {
            let (url, body) = match provider {
                "weknora" => (
                    format!("{}/api/v1/knowledge-search", trim_base(&api.base_url)),
                    json!({ "query": query, "knowledge_base_ids": [e.key] }),
                ),
                "dify" => (
                    format!("{}/datasets/{}/retrieve", dify_base(&api.base_url), e.key),
                    json!({
                        "query": query,
                        "retrieval_model": {
                            "search_method": "hybrid_search",
                            "reranking_enable": false,
                            "top_k": top_k,
                            "score_threshold_enabled": threshold > 0.0,
                            "score_threshold": threshold,
                        }
                    }),
                ),
                _ => (
                    trim_base(&api.base_url).to_string(),
                    json!({ "knowledge_id": e.key, "query": query, "retrieval_param": { "top_k": top_k } }),
                ),
            };
            tasks.push(SearchTask {
                provider,
                url,
                body,
                token_ref: api.token_ref.clone(),
                api_name: api.name.clone(),
                kb_name: e.name.clone(),
                threshold,
                base: trim_base(&api.base_url).to_string(),
            });
        }
    }
    if tasks.is_empty() {
        return Err(AppError::config(format!(
            "没有可检索的知识库（{}）",
            skipped.join("；")
        )));
    }

    let futures = tasks.into_iter().map(|t| async move {
        let mut req = http_client().post(&t.url).json(&t.body);
        if let Some(r) = &t.token_ref {
            if let Some(tok) = secrets::get(r)? {
                req = if t.provider == "weknora" {
                    req.header("x-api-key", tok.as_str())
                } else {
                    req.bearer_auth(tok.as_str())
                };
            }
        }
        let resp = req.send().await?;
        let status = resp.status();
        let v: Value = resp
            .json()
            .await
            .map_err(|_| AppError::api(format!("知识库响应解析失败（HTTP {status}）")))?;
        if !status.is_success() {
            let msg = v["message"].as_str().unwrap_or("检索失败");
            return Err(AppError::api(format!("HTTP {status}：{msg}")));
        }
        let parsed = match t.provider {
            "weknora" => wk_parse(&v),
            "dify" => dify_parse(&v),
            _ => ext_parse(&v),
        };
        // 过滤前的命中数与最高分先记下：全被阈值滤掉时要给用户可行动的提示
        let raw_hits = parsed.len();
        let max_score = parsed.iter().filter_map(|c| c.score).fold(0.0_f64, f64::max);
        let chunks = parsed
            .into_iter()
            // 阈值统一本地兜底（WeKnora 端点不支持阈值参数；其余后端传了再滤一遍，幂等）
            .filter(|c| t.threshold <= 0.0 || c.score.unwrap_or(0.0) >= t.threshold)
            .map(|c| KbChunk {
                content: c.content,
                title: c.title,
                source: c.source,
                score: c.score,
                api_name: Some(t.api_name.clone()),
                kb_name: Some(t.kb_name.clone()),
                // weknora Web 端的知识库详情页（文章在该页内）
                url: c.kb_id.as_ref().map(|k| format!("{}/platform/knowledge-bases/{k}", t.base)),
            })
            .collect::<Vec<_>>();
        Ok(TaskOutcome { chunks, raw_hits, max_score, threshold: t.threshold })
    });
    let results = join_all(futures).await;

    let mut chunks: Vec<KbChunk> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut raw_hits = 0usize;
    let mut max_score = 0.0_f64;
    let mut min_threshold = f64::INFINITY;
    for r in results {
        match r {
            Ok(o) => {
                raw_hits += o.raw_hits;
                max_score = max_score.max(o.max_score);
                min_threshold = min_threshold.min(o.threshold);
                chunks.extend(o.chunks);
            }
            Err(e) => errors.push(e.to_string()),
        }
    }
    if chunks.is_empty() {
        if let Some(msg) = empty_result_message(&errors, raw_hits, max_score, min_threshold) {
            return Err(AppError::api(msg));
        }
    }
    chunks.sort_by(|a, b| {
        b.score
            .unwrap_or(0.0)
            .partial_cmp(&a.score.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut seen = HashSet::new();
    chunks.retain(|c| seen.insert(c.content.clone()));
    chunks.truncate(top_k as usize);
    Ok(chunks)
}

struct ParsedChunk {
    content: String,
    score: Option<f64>,
    title: Option<String>,
    source: Option<String>,
    /// 所属知识库 id（weknora 返回；用于拼 Web 端链接）
    kb_id: Option<String>,
}

/// 顶层或 {data:[...]} 里的数组
fn top_arr<'a>(v: &'a Value, keys: &[&str]) -> &'a [Value] {
    for k in keys {
        if let Some(a) = v[k].as_array() {
            return a;
        }
    }
    if let Some(a) = v.as_array() {
        return a;
    }
    &[]
}

fn wk_parse(v: &Value) -> Vec<ParsedChunk> {
    top_arr(v, &["data"])
        .iter()
        .filter_map(|c| {
            let content =
                c["content"].as_str().or_else(|| c["text"].as_str()).or_else(|| c["chunk"].as_str())?;
            Some(ParsedChunk {
                content: content.to_string(),
                score: c["score"].as_f64(),
                title: c["knowledge_title"].as_str().map(str::to_string),
                source: c["knowledge_filename"].as_str().map(str::to_string),
                kb_id: c["knowledge_base_id"].as_str().map(str::to_string),
            })
        })
        .collect()
}

fn dify_parse(v: &Value) -> Vec<ParsedChunk> {
    top_arr(v, &["records"])
        .iter()
        .filter_map(|c| {
            let content = c["segment"]["content"].as_str().or_else(|| c["content"].as_str())?;
            let doc = c["document"]["name"].as_str();
            Some(ParsedChunk {
                content: content.to_string(),
                score: c["score"].as_f64(),
                title: doc.map(str::to_string),
                source: doc.map(str::to_string),
                kb_id: None,
            })
        })
        .collect()
}

fn ext_parse(v: &Value) -> Vec<ParsedChunk> {
    top_arr(v, &["records"])
        .iter()
        .filter_map(|c| {
            let content =
                c["content"].as_str().or_else(|| c["text"].as_str()).or_else(|| c["chunk"].as_str())?;
            Some(ParsedChunk {
                content: content.to_string(),
                score: c["score"].as_f64(),
                title: c["title"].as_str().map(str::to_string),
                source: c["document"].as_str().map(str::to_string),
                kb_id: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weknora_shapes() {
        let v = json!({
            "success": true,
            "data": [
                { "id": "c1", "content": "段落一", "score": 0.87, "knowledge_title": "产品手册",
                  "knowledge_filename": "manual.pdf", "knowledge_id": "k1",
                  "knowledge_base_id": "kb-uuid", "chunk_index": 3 }
            ]
        });
        let cs = wk_parse(&v);
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].content, "段落一");
        assert_eq!(cs[0].score, Some(0.87));
        assert_eq!(cs[0].title.as_deref(), Some("产品手册"));
        assert_eq!(cs[0].source.as_deref(), Some("manual.pdf"));
        assert_eq!(cs[0].kb_id.as_deref(), Some("kb-uuid"), "用于拼 Web 端知识库链接");

        let list = json!({ "data": [
            { "id": "kb-uuid", "name": "制度库", "description": "公司制度", "knowledge_count": 12, "chunk_count": 300 }
        ]});
        let l = parse_listed("weknora", &list);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].key, "kb-uuid");
        assert_eq!(l[0].doc_count, Some(12));
    }

    #[test]
    fn dify_shapes() {
        let v = json!({
            "records": [
                { "segment": { "id": "s1", "content": "Dify 段落", "position": 2 },
                  "score": 0.91, "document": { "id": "d1", "name": "报告.docx" } }
            ]
        });
        let cs = dify_parse(&v);
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].content, "Dify 段落");
        assert_eq!(cs[0].source.as_deref(), Some("报告.docx"));

        let list = json!({ "data": [ { "id": "ds-id", "name": "数据集", "document_count": 5 } ]});
        let l = parse_listed("dify", &list);
        assert_eq!(l[0].key, "ds-id");
        assert_eq!(l[0].doc_count, Some(5));
    }

    #[test]
    fn external_api_shapes() {
        let v = json!({ "records": [ { "id": "r1", "content": "外部记录", "score": 0.6,
            "title": "T", "document": "f.md" } ]});
        let cs = ext_parse(&v);
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].content, "外部记录");
        assert_eq!(cs[0].source.as_deref(), Some("f.md"));
    }

    #[test]
    fn provider_and_base_normalization() {
        assert_eq!(provider_of("weknora"), "weknora");
        assert_eq!(provider_of("dify"), "dify");
        assert_eq!(provider_of("external-api"), "external-api");
        assert_eq!(provider_of(""), "weknora");
        assert_eq!(provider_of("whatever"), "weknora");
        assert_eq!(dify_base("https://dify.example.com"), "https://dify.example.com/v1");
        assert_eq!(dify_base("https://dify.example.com/v1/"), "https://dify.example.com/v1");
        assert_eq!(dify_base("https://dify.example.com/api/v1"), "https://dify.example.com/api/v1");
    }

    #[test]
    fn empty_search_result_messages() {
        // 命中被阈值滤光：给出最高分与调阈值指引（双V 知识库排查到的实际场景）
        let msg = empty_result_message(&[], 8, 0.403, 0.5).unwrap();
        assert!(msg.contains("命中 8 条"));
        assert!(msg.contains("0.40"));
        assert!(msg.contains("调低相似度阈值"));
        // 部分库失败 + 其余被滤掉：两类信息都要在
        let msg = empty_result_message(&["HTTP 500：knowledge base not found".into()], 3, 0.3, 0.5).unwrap();
        assert!(msg.starts_with("HTTP 500"));
        assert!(msg.contains("低于阈值"));
        // 确实无相关内容：静默（聊天侧正常作答）
        assert!(empty_result_message(&[], 0, 0.0, 0.5).is_none());
        // 全部失败但无命中：只报错误
        let msg = empty_result_message(&["HTTP 401：认证失败".into()], 0, 0.0, 0.5).unwrap();
        assert_eq!(msg, "HTTP 401：认证失败");
    }
}
