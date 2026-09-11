//! 画图：images API 与 chat 式（对话生图）双路调用，产物落盘 app_data/images/YYYY/MM。
//!
//! call_mode：images = /v1/images/generations（dedicated 模型）；
//! chat = /v1/chat/completions 非流式，从回复中提取图片（gemini-image 等对话生图模型）。

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::http::long_client;
use crate::service::{self, ServiceRef};

/// 生图（返回落盘文件的绝对路径数组，前端经 asset 协议渲染）。
/// refs：参考图绝对路径（chat 模式作为多模态消息内容传入；images 模式部分网关支持 image 字段）。
#[tauri::command]
pub async fn image_generate(
    app: AppHandle,
    spec: ServiceRef,
    model: String,
    prompt: String,
    size: Option<String>,
    n: Option<i32>,
    call_mode: Option<String>,
    refs: Option<Vec<String>>,
) -> Result<Vec<String>, AppError> {
    let svc = service::resolve_service(&app, &spec).await?;
    let mode = call_mode.unwrap_or_else(|| "images".into());
    let n = n.unwrap_or(1).clamp(1, 4);
    let refs = refs.unwrap_or_default();
    let items = if mode == "chat" {
        via_chat(&svc, &model, &prompt, &refs).await?
    } else {
        via_images(&svc, &model, &prompt, size.as_deref(), n).await?
    };

    if items.is_empty() {
        return Err(AppError::api("上游未返回图片"));
    }
    let mut paths = Vec::new();
    for (i, bytes) in items.iter().enumerate() {
        paths.push(save_image(&app, bytes, i)?);
    }
    Ok(paths)
}

/// 图生图编辑：/v1/images/edits（multipart 上传原图 + 可选 mask，按提示词重绘）。
/// 仅 images 调用方式的模型支持（gpt-image 系列等）；chat 式生图模型请用「参考图」。
#[tauri::command]
pub async fn image_edit(
    app: AppHandle,
    spec: ServiceRef,
    model: String,
    prompt: String,
    image: String,
    size: Option<String>,
    n: Option<i32>,
    mask: Option<String>,
) -> Result<Vec<String>, AppError> {
    let svc = service::resolve_service(&app, &spec).await?;
    let n = n.unwrap_or(1).clamp(1, 4);
    let url = format!("{}/v1/images/edits", svc.base_url.trim_end_matches('/'));

    let mut form = reqwest::multipart::Form::new()
        .text("model", model)
        .text("prompt", prompt)
        .text("n", n.to_string());
    if let Some(s) = size.as_deref() {
        if !s.trim().is_empty() && s != "auto" {
            form = form.text("size", s.trim().to_string());
        }
    }
    for (field, path) in [("image", image.as_str())].into_iter().chain(
        mask.as_deref().map(|m| ("mask", m)).into_iter(),
    ) {
        let bytes = std::fs::read(path)
            .map_err(|e| AppError::config(format!("读取图片失败 {path}：{e}")))?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err(AppError::config("图片过大（>20MB）"));
        }
        let ext = path.rsplit('.').next().map(str::to_ascii_lowercase).unwrap_or_default();
        let mime = match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => "image/png",
        };
        let name = format!("{field}.{}", if ext.is_empty() { "png".to_string() } else { ext });
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(name)
            .mime_str(mime)
            .map_err(|e| AppError::internal(e.to_string()))?;
        form = form.part(field.to_string(), part);
    }

    let resp = long_client()
        .post(&url)
        .bearer_auth(&svc.api_key)
        .multipart(form)
        .send()
        .await?;
    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|_| AppError::api(format!("图生图响应解析失败（HTTP {status}），请检查模型是否支持 images/edits")))?;
    let items = parse_images_response(&v, status).await?;
    if items.is_empty() {
        return Err(AppError::api("上游未返回图片"));
    }
    let mut paths = Vec::new();
    for (i, bytes) in items.iter().enumerate() {
        paths.push(save_image(&app, bytes, i)?);
    }
    Ok(paths)
}

async fn via_images(
    svc: &service::ResolvedService,
    model: &str,
    prompt: &str,
    size: Option<&str>,
    n: i32,
) -> Result<Vec<Vec<u8>>, AppError> {
    let url = format!("{}/v1/images/generations", svc.base_url.trim_end_matches('/'));
    let mut body = json!({ "model": model, "prompt": prompt, "n": n });
    if let Some(s) = size {
        if !s.trim().is_empty() && s != "auto" {
            body["size"] = json!(s.trim());
        }
    }
    let resp = long_client()
        .post(&url)
        .bearer_auth(&svc.api_key)
        .json(&body)
        .send()
        .await?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(|_| {
        AppError::api(format!("画图响应解析失败（HTTP {status}），请检查模型是否支持 images API"))
    })?;
    parse_images_response(&v, status).await
}

/// images 接口通用响应解析：data[].b64_json 或 data[].url（下载）
async fn parse_images_response(v: &Value, status: reqwest::StatusCode) -> Result<Vec<Vec<u8>>, AppError> {
    if !status.is_success() {
        let msg = v["error"]["message"].as_str().unwrap_or("画图请求失败");
        return Err(AppError::api(format!("HTTP {status}：{msg}")));
    }
    let arr = v["data"]
        .as_array()
        .ok_or_else(|| AppError::api("画图响应缺少 data 数组"))?;
    let mut out = Vec::new();
    let mut pending_urls = Vec::new();
    for item in arr {
        if let Some(b64) = item["b64_json"].as_str() {
            out.push(crate::secrets::b64_decode(b64)?);
        } else if let Some(u) = item["url"].as_str() {
            pending_urls.push(u.to_string());
        }
    }
    for u in pending_urls {
        if let Some(bytes) = fetch_or_decode(u).await? {
            out.push(bytes);
        }
    }
    Ok(out)
}

async fn via_chat(
    svc: &service::ResolvedService,
    model: &str,
    prompt: &str,
    refs: &[String],
) -> Result<Vec<Vec<u8>>, AppError> {
    let url = format!("{}/v1/chat/completions", svc.base_url.trim_end_matches('/'));
    // 多模态消息：文本 + 参考图（data url）
    let mut content = vec![json!({ "type": "text", "text": prompt })];
    for r in refs {
        let (mime, b64) = read_image_data_url(r)?;
        content.push(json!({ "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{b64}") } }));
    }
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": content }],
    });
    let resp = long_client()
        .post(&url)
        .bearer_auth(&svc.api_key)
        .json(&body)
        .send()
        .await?;
    let status = resp.status();
    let v: Value =
        resp.json().await.map_err(|_| AppError::api(format!("画图响应解析失败（HTTP {status}）")))?;
    if !status.is_success() {
        let msg = v["error"]["message"].as_str().unwrap_or("画图请求失败");
        return Err(AppError::api(format!("HTTP {status}：{msg}")));
    }
    let msg = &v["choices"][0]["message"];
    // 1) OpenRouter 风格：message.images[]
    let mut urls = Vec::new();
    if let Some(arr) = msg["images"].as_array() {
        for im in arr {
            if let Some(u) = im["image_url"]["url"].as_str() {
                urls.push(u.to_string());
            }
        }
    }
    // 2) content 中的 data url / markdown 图片
    if let Some(text) = msg["content"].as_str() {
        for cap in extract_urls(text) {
            urls.push(cap);
        }
    }
    let mut out = Vec::new();
    for u in urls {
        if let Some(bytes) = fetch_or_decode(u).await? {
            out.push(bytes);
        }
    }
    Ok(out)
}

/// 从文本提取 data:image 或 markdown/裸 http 图片链接
fn extract_urls(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(pos) = text.find("data:image") {
        let rest = &text[pos..];
        let end = rest.find('"').or_else(|| rest.find(')')).unwrap_or(rest.len());
        if rest[..end].contains("base64,") {
            out.push(rest[..end].to_string());
        }
    }
    for part in text.split("![") {
        if let Some(p) = part.find("](") {
            let rest = &part[p + 2..];
            if let Some(e) = rest.find(')') {
                let u = rest[..e].trim();
                if u.starts_with("http") {
                    out.push(u.to_string());
                }
            }
        }
    }
    out
}

/// 读参考图文件 → (mime, base64)；不可读/超限时跳过（调用方拿不到该图但流程不中断）
fn read_image_data_url(path: &str) -> Result<(String, String), AppError> {
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::config(format!("读取参考图失败 {path}：{e}")))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(AppError::config(format!("参考图过大（>10MB）：{path}")));
    }
    let mime = match path.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/png",
    }
    .to_string();
    let b64 = crate::secrets::b64_encode(&bytes);
    Ok((mime, b64))
}

/// 导出文件写入用户经系统保存对话框选择的路径。载荷用 data URL（base64 字符串）：
/// 大 PNG/PSD 走数组的 JSON 序列化会很慢，字符串一次传完。
#[tauri::command]
pub fn image_save_export(path: String, data_url: String) -> Result<(), AppError> {
    let b64 = data_url
        .strip_prefix("data:")
        .and_then(|s| s.split_once(";base64,"))
        .map(|(_, b)| b)
        .ok_or_else(|| AppError::config("导出数据格式错误（应为 data:…;base64,…）"))?;
    let bytes = crate::secrets::b64_decode(b64)?;
    // PSD 工程可能到几十 MB，放到 256MB 兜底
    if bytes.len() > 256 * 1024 * 1024 {
        return Err(AppError::config("导出数据过大（>256MB）"));
    }
    std::fs::write(&path, bytes).map_err(|e| AppError::internal(format!("写入文件失败：{e}")))?;
    Ok(())
}

/// 参考图落盘 app_data/images/refs/<ts>_<i>.<ext>，返回绝对路径（画图页添加参考图用）
#[tauri::command]
pub fn draw_save_ref(app: AppHandle, data_url: String) -> Result<String, AppError> {    let (mime, b64) = data_url
        .strip_prefix("data:")
        .and_then(|s| s.split_once(";base64,"))
        .ok_or_else(|| AppError::config("参考图格式错误（应为 data:image/…;base64,…）"))?;
    let bytes = crate::secrets::b64_decode(b64)?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(AppError::config("参考图过大（>10MB）"));
    }
    let ext = mime.strip_prefix("image/").unwrap_or("png");
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::internal(format!("无法获取数据目录：{e}")))?
        .join("images")
        .join("refs");
    std::fs::create_dir_all(&dir).map_err(|e| AppError::internal(format!("创建目录失败：{e}")))?;
    let tag: String = crate::secrets::b64_encode(&bytes).chars().take(6).collect();
    let path = dir.join(format!("{secs}_{tag}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| AppError::internal(format!("写入参考图失败：{e}")))?;
    Ok(path.display().to_string())
}

async fn fetch_or_decode(u: String) -> Result<Option<Vec<u8>>, AppError> {
    if let Some(b64) = u.strip_prefix("data:image") {
        let b64 = b64.split("base64,").last().unwrap_or("");
        let bytes = crate::secrets::b64_decode(b64)?;
        return Ok(Some(bytes));
    }
    let resp = long_client().get(&u).send().await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    Ok(Some(resp.bytes().await.map(|b| b.to_vec())?))
}

/// 落盘 app_data/images/YYYY/MM/<ts>_<i>.png，返回绝对路径
fn save_image(app: &AppHandle, bytes: &[u8], i: usize) -> Result<String, AppError> {
    use std::io::Write;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m) = ym(secs);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::internal(format!("无法获取数据目录：{e}")))?
        .join("images")
        .join(format!("{y:04}"))
        .join(format!("{m:02}"));
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal(format!("创建图片目录失败：{e}")))?;
    let path = dir.join(format!("{}_{}.png", secs * 1000, i));
    let mut f =
        std::fs::File::create(&path).map_err(|e| AppError::internal(format!("创建图片文件失败：{e}")))?;
    f.write_all(bytes).map_err(|e| AppError::internal(format!("写入图片失败：{e}")))?;
    Ok(path.display().to_string())
}

/// unix 秒 → (年, 月)。Howard Hinnant civil_from_days 算法
fn ym(secs: u64) -> (i32, u32) {
    let z = (secs / 86400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ym_matches_known_dates() {
        assert_eq!(ym(0), (1970, 1));
        // 2026-09-05 00:00:00 UTC = 1788624000
        assert_eq!(ym(1_788_624_000), (2026, 9));
    }

    #[test]
    fn extract_urls_finds_markdown_and_data() {
        let t = "图如下：![img](https://x.com/a.png) 完毕";
        assert_eq!(extract_urls(t), vec!["https://x.com/a.png".to_string()]);
        assert!(extract_urls("前缀 data:image/png;base64,AAAA\" 后缀").len() == 1);
        assert!(extract_urls("无图").is_empty());
    }
}
