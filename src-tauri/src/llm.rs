//! OpenAI 兼容流式聊天：SSE 解析（兼容 \r\n）、思考内容分离、任务级取消、模型列表。

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::http::http_client;
use crate::service::{self, ServiceRef};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// 多模态输入：data URL 图片列表（非空时 content 转 OpenAI 数组 parts，多模态模型可看图）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
    /// assistant 消息携带的工具调用（前端按 {id,name,arguments} 传入，发上游前转 OpenAI 形状）
    #[serde(default, alias = "toolCalls", skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ChatToolCall>>,
    /// role=tool 时对应的调用 id
    #[serde(default, alias = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// 前端工具调用载荷（跨 IPC 用扁平结构；上游 OpenAI 是 {id,type,function:{name,arguments}}）
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolCall {
    pub id: String,
    pub name: String,
    /// arguments 为 JSON 字符串（OpenAI 约定），原样透传
    pub arguments: String,
}

impl ChatMessage {
    /// 转上游请求体：普通消息只含 role/content，工具循环消息附 tool_calls / tool_call_id；
    /// 带 images 的消息 content 变为 [text, image_url...] 数组（OpenAI 多模态格式）。
    fn to_wire(&self) -> serde_json::Value {
        let mut m = json!({ "role": self.role });
        match self.images.as_ref().filter(|v| !v.is_empty()) {
            Some(imgs) => {
                let mut parts = vec![json!({ "type": "text", "text": self.content })];
                for url in imgs {
                    parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
                }
                m["content"] = json!(parts);
            }
            None => {
                m["content"] = json!(self.content);
            }
        }
        if let Some(calls) = &self.tool_calls {
            m["tool_calls"] = json!(calls
                .iter()
                .map(|c| json!({
                    "id": c.id, "type": "function",
                    "function": { "name": c.name, "arguments": c.arguments }
                }))
                .collect::<Vec<_>>());
        }
        if let Some(id) = &self.tool_call_id {
            m["tool_call_id"] = json!(id);
        }
        m
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatEvent {
    /// 正文增量
    Delta { text: String },
    /// 思考过程增量（delta.reasoning_content，部分模型提供）
    Reasoning { text: String },
    /// 一轮流式结束聚合出的工具调用（在 Done 之前推送，前端执行后带着结果继续对话）
    ToolCalls { calls: Vec<ChatToolCall> },
    Done,
    Error { message: String },
}

/// 流式 tool_calls 增量按 index 分片到达（id/name 首片、arguments 逐片拼接），按序号聚合
#[derive(Default, Clone, PartialEq, Debug)]
struct ToolCallAcc {
    id: String,
    name: String,
    arguments: String,
}

fn apply_tool_call_delta(delta: &serde_json::Value, acc: &mut Vec<ToolCallAcc>) {
    let Some(arr) = delta["tool_calls"].as_array() else { return };
    for tc in arr {
        let idx = tc["index"].as_u64().unwrap_or(0) as usize;
        while acc.len() <= idx {
            acc.push(ToolCallAcc::default());
        }
        let slot = &mut acc[idx];
        if let Some(id) = tc["id"].as_str().filter(|s| !s.is_empty()) {
            slot.id = id.to_string();
        }
        if let Some(n) = tc["function"]["name"].as_str().filter(|s| !s.is_empty()) {
            slot.name = n.to_string();
        }
        if let Some(a) = tc["function"]["arguments"].as_str() {
            slot.arguments.push_str(a);
        }
    }
}

/// 聚合结果转事件载荷：丢弃无名残片（取消/异常中断时的不完整调用）
fn finish_tool_calls(acc: Vec<ToolCallAcc>) -> Vec<ChatToolCall> {
    acc.into_iter()
        .filter(|a| !a.name.is_empty())
        .map(|a| ChatToolCall {
            id: a.id,
            name: a.name,
            arguments: a.arguments,
        })
        .collect()
}

fn cancels() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static C: std::sync::OnceLock<Mutex<HashMap<String, CancellationToken>>> =
        std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 流式对话。task_id 由前端生成（用于 llm_cancel），事件经 Channel 推送，
/// 结束时推 Done 或 Error。
#[tauri::command]
pub async fn llm_chat(
    app: AppHandle,
    spec: ServiceRef,
    task_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    max_tokens: Option<i64>,
    // OpenAI function calling 工具定义（原样透传，前端编排执行循环）
    tools: Option<serde_json::Value>,
    on_event: Channel<ChatEvent>,
) -> Result<(), AppError> {
    let svc = service::resolve_service(&app, &spec).await?;
    let token = CancellationToken::new();
    cancels()
        .lock()
        .map_err(|_| AppError::internal("取消表锁 poisoned"))?
        .insert(task_id.clone(), token.clone());

    let mut body = json!({ "model": model, "messages": messages.iter().map(|m| m.to_wire()).collect::<Vec<_>>(), "stream": true });
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = max_tokens {
        body["max_tokens"] = json!(m);
    }
    if let Some(t) = tools.filter(|t| t.as_array().is_some_and(|a| !a.is_empty())) {
        body["tools"] = t;
    }
    let key = svc.api_key;
    eprintln!("[llm_chat] base={} model={} msgs={}", svc.base_url, model, messages.len());

    // 聊天统一 OpenAI 格式（anthropic_base_url 仅用于 CLI 配置 Claude Code）
    let url = format!("{}/v1/chat/completions", svc.base_url.trim_end_matches('/'));
    let result = run_openai_stream(url, key, body, token, &on_event).await;

    match result {
        Ok(()) => {
            eprintln!("[llm_chat] done");
            let _ = on_event.send(ChatEvent::Done);
        }
        Err(e) => {
            eprintln!("[llm_chat] error: {}", e.message);
            let _ = on_event.send(ChatEvent::Error { message: e.message });
        }
    }
    if let Ok(mut m) = cancels().lock() {
        m.remove(&task_id);
    }
    Ok(())
}

#[tauri::command]
pub fn llm_cancel(task_id: String) -> bool {
    if let Ok(mut m) = cancels().lock() {
        if let Some(t) = m.remove(&task_id) {
            t.cancel();
            return true;
        }
    }
    false
}

/// 非流式补全（AI 优化提示词/笔记等一次性任务；统一 OpenAI 格式）
#[tauri::command]
pub async fn llm_complete(
    app: AppHandle,
    spec: ServiceRef,
    model: String,
    prompt: String,
    system: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<i64>,
) -> Result<String, AppError> {
    let svc = service::resolve_service(&app, &spec).await?;
    let mut messages = Vec::new();
    if let Some(s) = system.as_deref().filter(|s| !s.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": s }));
    }
    messages.push(json!({ "role": "user", "content": prompt }));
    let mut body = json!({ "model": model, "messages": messages, "stream": false });
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = max_tokens {
        body["max_tokens"] = json!(m);
    }
    let url = format!("{}/v1/chat/completions", svc.base_url.trim_end_matches('/'));
    let resp = http_client()
        .post(&url)
        .bearer_auth(&svc.api_key)
        .json(&body)
        .send()
        .await?;
    let status = resp.status();
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| AppError::api(format!("响应解析失败（HTTP {status}）")))?;
    if !status.is_success() {
        let msg = v["error"]["message"].as_str().unwrap_or("请求失败");
        return Err(AppError::api(format!("HTTP {status}：{msg}")));
    }
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::api("响应缺少 content"))
}

/// OpenAI 兼容模型列表：GET /v1/models（Bearer）
pub(crate) async fn fetch_models_openai(base_url: &str, api_key: &str) -> Result<Vec<String>, AppError> {
    let base = base_url.trim_end_matches('/');
    let resp = http_client()
        .get(format!("{base}/v1/models"))
        .bearer_auth(api_key)
        .send()
        .await?;
    parse_models(resp).await
}

/// Anthropic 协议模型列表：GET /v1/models（x-api-key + anthropic-version）
pub(crate) async fn fetch_models_anthropic(base_url: &str, api_key: &str) -> Result<Vec<String>, AppError> {
    let base = base_url.trim_end_matches('/');
    let resp = http_client()
        .get(format!("{base}/v1/models"))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await?;
    parse_models(resp).await
}

pub(crate) async fn parse_models(resp: reqwest::Response) -> Result<Vec<String>, AppError> {
    if !resp.status().is_success() {
        return Err(AppError::network(format!("上游返回 HTTP {}", resp.status())));
    }
    let v: serde_json::Value =
        resp.json().await.map_err(|_| AppError::api("模型列表响应解析失败"))?;
    Ok(v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

/// 模型列表：OpenAI 兼容 GET /v1/models（Bearer）；anthropic 供应商走其端点（x-api-key）。
#[tauri::command]
pub async fn llm_models(app: AppHandle, spec: ServiceRef) -> Result<Vec<String>, AppError> {
    let svc = service::resolve_service(&app, &spec).await?;
    if svc.api_format == "anthropic" {
        fetch_models_anthropic(&svc.base_url, &svc.api_key).await
    } else {
        fetch_models_openai(&svc.base_url, &svc.api_key).await
    }
}

/// 在字节流中找下一个 SSE 事件边界（\n\n 或 \r\n\r\n），返回 (内容终点, 整体长度)
fn find_event_end(buf: &str) -> Option<(usize, usize)> {
    let a = buf.find("\n\n");
    let b = buf.find("\r\n\r\n");
    match (a, b) {
        (Some(x), Some(y)) if y + 4 <= x + 2 => Some((y, y + 4)),
        (Some(x), _) => Some((x, x + 2)),
        (None, Some(y)) => Some((y, y + 4)),
        (None, None) => None,
    }
}

async fn run_openai_stream(
    url: String,
    key: String,
    body: serde_json::Value,
    token: CancellationToken,
    on_event: &Channel<ChatEvent>,
) -> Result<(), AppError> {
    let resp = http_client()
        .post(&url)
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let hint = if text.len() > 300 { &text[..300] } else { &text[..] };
        return Err(AppError::api(format!("上游返回 HTTP {status}：{hint}")));
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut tool_acc: Vec<ToolCallAcc> = Vec::new();
    // 正常收尾（[DONE] 或流自然结束）时把聚合出的工具调用推给前端；用户取消走 cancelled 分支不推
    fn finish_stream(tool_acc: Vec<ToolCallAcc>, on_event: &Channel<ChatEvent>) {
        let calls = finish_tool_calls(tool_acc);
        if !calls.is_empty() {
            let _ = on_event.send(ChatEvent::ToolCalls { calls });
        }
    }
    loop {
        tokio::select! {
            _ = token.cancelled() => {
                // 用户取消：停止读取（drop response 关闭连接），不再推送事件
                return Ok(());
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some((end, skip)) = find_event_end(&buf) {
                            let raw = buf[..end].to_string();
                            buf.drain(..skip);
                            for line in raw.lines() {
                                let Some(data) = line.trim().strip_prefix("data:") else { continue };
                                let data = data.trim();
                                if data == "[DONE]" {
                                    finish_stream(tool_acc, on_event);
                                    return Ok(());
                                }
                                if data.is_empty() {
                                    continue;
                                }
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                                    let delta = &v["choices"][0]["delta"];
                                    if let Some(t) = delta["reasoning_content"].as_str() {
                                        if !t.is_empty() {
                                            let _ = on_event.send(ChatEvent::Reasoning { text: t.into() });
                                        }
                                    }
                                    if let Some(t) = delta["content"].as_str() {
                                        if !t.is_empty() {
                                            let _ = on_event.send(ChatEvent::Delta { text: t.into() });
                                        }
                                    }
                                    apply_tool_call_delta(delta, &mut tool_acc);
                                }
                            }
                        }
                    }
                    Some(Err(e)) => return Err(e.into()),
                    None => {
                        finish_stream(tool_acc, on_event);
                        return Ok(());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_boundary_handles_lf_and_crlf() {
        assert_eq!(find_event_end("data: a\n\ndata: b"), Some((7, 9)));
        assert_eq!(find_event_end("data: a\r\n\r\ndata: b"), Some((7, 11)));
        assert_eq!(find_event_end("data: a\n"), None);
    }

    #[test]
    fn tool_call_delta_accumulates_by_index() {
        let mut acc = Vec::new();
        // OpenAI 流式：首片带 id/name，arguments 按片拼接；index 区分并发调用
        apply_tool_call_delta(
            &serde_json::json!({ "tool_calls": [{ "index": 0, "id": "call_1", "function": { "name": "render_chart", "arguments": "{\"li" } }] }),
            &mut acc,
        );
        apply_tool_call_delta(
            &serde_json::json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "brary\":\"echarts\"}" } }] }),
            &mut acc,
        );
        apply_tool_call_delta(
            &serde_json::json!({ "tool_calls": [{ "index": 1, "id": "call_2", "function": { "name": "other", "arguments": "{}" } }] }),
            &mut acc,
        );
        let calls = finish_tool_calls(acc);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "render_chart");
        assert_eq!(calls[0].arguments, "{\"library\":\"echarts\"}");
        assert_eq!(calls[1].id, "call_2");
    }

    #[test]
    fn tool_call_fragment_without_name_is_dropped() {
        let mut acc = Vec::new();
        apply_tool_call_delta(
            &serde_json::json!({ "tool_calls": [{ "index": 0, "id": "call_x", "function": { "arguments": "{}" } }] }),
            &mut acc,
        );
        assert!(finish_tool_calls(acc).is_empty());
    }

    #[test]
    fn chat_message_wire_shape_for_tool_rounds() {
        // 普通消息：仅 role/content
        let plain = ChatMessage {
            role: "user".into(),
            content: "hi".into(),
            images: None,
            tool_calls: None,
            tool_call_id: None,
        };
        assert_eq!(plain.to_wire(), json!({ "role": "user", "content": "hi" }));

        // 前端 camelCase 载荷（图表页工具循环回传）能解析并转成上游 OpenAI 形状
        let assistant: ChatMessage = serde_json::from_value(json!({
            "role": "assistant", "content": "",
            "toolCalls": [{ "id": "call_1", "name": "render_chart", "arguments": "{\"a\":1}" }]
        }))
        .unwrap();
        assert_eq!(
            assistant.to_wire()["tool_calls"],
            json!([{ "id": "call_1", "type": "function", "function": { "name": "render_chart", "arguments": "{\"a\":1}" } }])
        );

        let toolmsg: ChatMessage = serde_json::from_value(json!({
            "role": "tool", "content": "{\"ok\":true}", "toolCallId": "call_1"
        }))
        .unwrap();
        assert_eq!(toolmsg.to_wire(), json!({ "role": "tool", "content": "{\"ok\":true}", "tool_call_id": "call_1" }));
    }

    #[test]
    fn chat_message_with_images_becomes_multimodal_parts() {
        // 带 images 的消息：content 变 [text, image_url...]（OpenAI 多模态格式），修图页快照走这条路
        let m = ChatMessage {
            role: "user".into(),
            content: "把背景换成海滩".into(),
            images: Some(vec!["data:image/jpeg;base64,AAAA".into()]),
            tool_calls: None,
            tool_call_id: None,
        };
        assert_eq!(
            m.to_wire()["content"],
            json!([
                { "type": "text", "text": "把背景换成海滩" },
                { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,AAAA" } }
            ])
        );

        // images 为空数组时保持纯文本形状（不给上游发空 parts）
        let empty = ChatMessage {
            role: "user".into(),
            content: "hi".into(),
            images: Some(vec![]),
            tool_calls: None,
            tool_call_id: None,
        };
        assert_eq!(empty.to_wire()["content"], json!("hi"));
    }

}
