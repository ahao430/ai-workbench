//! MCP 服务器管理：应用侧中央注册表 + 分发写入各 CLI 的原生配置文件。
//!
//! 分发目标（与各 CLI 的原生格式对齐）：
//! - Claude Code：`~/.claude.json` → `mcpServers`（stdio: command/args/env；http/sse: type/url/headers）
//! - Codex：`~/.codex/config.toml` → `[mcp_servers.<name>]`（stdio: command/args/env；http: url/http_headers）
//! - OpenCode：`~/.config/opencode/opencode.json` → `mcp`（stdio: type=local + command[]；http/sse: type=remote + url/headers）
//!
//! 数据模型参考 cc-switch：应用持有主列表与每个 CLI 的启用开关，同步写入 CLI 配置。
//! 支持本机扫描导入、内置精选一键安装（npm stdio）、Smithery 市场搜索安装（远程 http）。

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::cli::fsutil::home_dir;
use crate::error::AppError;
use crate::store::{load_config, now_nanos, save_config};

/// 分发目标（cli id → 显示名）
pub const CLI_TARGETS: &[(&str, &str)] = &[
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("opencode", "OpenCode"),
];

/// MCP 注册表条目（存 config.json）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct McpEntry {
    pub id: String,
    /// 写入 CLI 配置的服务名（唯一；字母数字与 - _）
    pub name: String,
    /// stdio | http | sse
    pub kind: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub desc: Option<String>,
    pub homepage: Option<String>,
    pub tags: Vec<String>,
    /// builtin | custom | market | local
    pub source: String,
    /// cli id → 是否分发
    pub enabled: BTreeMap<String, bool>,
    /// cli id → 该 CLI 配置中的同名服务是否由本应用写入（摘除时只动自己写的，保护本机已有配置）
    pub synced: BTreeMap<String, bool>,
}

/// 列表视图：注册表条目 + 各 CLI 配置文件中的实际在位状态
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpView {
    pub entry: McpEntry,
    /// cli id → 配置文件中实际存在该服务（与管理开关可能有出入，如被外部工具改动）
    pub actual: BTreeMap<String, bool>,
}

/// 本机扫描结果（某 CLI 配置里已有的 MCP，可导入注册表）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalMcp {
    pub cli: String,
    pub cli_label: String,
    pub name: String,
    /// 待导入的条目（id 为空、source=local、默认不分发）
    pub entry: McpEntry,
}

/// Smithery 市场搜索结果
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketServer {
    pub qualified_name: String,
    pub display_name: String,
    pub description: String,
    pub homepage: Option<String>,
    pub verified: bool,
    pub use_count: Option<i64>,
    pub remote: bool,
}

// ===== 各 CLI 配置文件路径 =====

fn claude_json(home: &std::path::Path) -> PathBuf {
    home.join(".claude.json")
}
fn codex_toml(home: &std::path::Path) -> PathBuf {
    home.join(".codex").join("config.toml")
}
fn opencode_json(home: &std::path::Path) -> PathBuf {
    home.join(".config").join("opencode").join("opencode.json")
}

fn read_json_object(path: &std::path::Path) -> Result<Map<String, Value>, AppError> {
    match std::fs::read_to_string(path) {
        Ok(s) if !s.trim().is_empty() => {
            let v: Value = serde_json::from_str(&s)
                .map_err(|e| AppError::internal(format!("解析 {} 失败：{e}", path.display())))?;
            match v {
                Value::Object(m) => Ok(m),
                _ => Err(AppError::internal(format!("{} 不是 JSON 对象", path.display()))),
            }
        }
        _ => Ok(Map::new()),
    }
}

fn write_json_object(path: &std::path::Path, m: &Map<String, Value>) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal(format!("创建目录失败：{e}")))?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(m.clone()))
        .map_err(|e| AppError::internal(format!("序列化失败：{e}")))?;
    std::fs::write(path, text)
        .map_err(|e| AppError::internal(format!("写入 {} 失败：{e}", path.display())))
}

// ===== 写入：条目 → 各 CLI 配置 =====

fn value_from_map(m: &BTreeMap<String, String>) -> Value {
    let mut o = Map::new();
    for (k, v) in m {
        o.insert(k.clone(), Value::String(v.clone()));
    }
    Value::Object(o)
}

fn string_array(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn string_map(v: Option<&Value>) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    if let Some(o) = v.and_then(Value::as_object) {
        for (k, val) in o {
            if let Some(s) = val.as_str() {
                m.insert(k.clone(), s.to_string());
            }
        }
    }
    m
}

/// Claude Code：mcpServers
fn apply_claude(home: &std::path::Path, name: &str, e: Option<&McpEntry>) -> Result<(), AppError> {
    let path = claude_json(home);
    let mut root = read_json_object(&path)?;
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let obj = servers
        .as_object_mut()
        .ok_or_else(|| AppError::internal("~/.claude.json 的 mcpServers 不是对象"))?;
    match e {
        None => {
            obj.remove(name);
        }
        Some(e) => {
            let mut v = match e.kind.as_str() {
                "http" | "sse" => json!({
                    "type": e.kind,
                    "url": e.url.clone().unwrap_or_default(),
                }),
                _ => json!({ "command": e.command.clone().unwrap_or_default() }),
            };
            if e.kind == "http" || e.kind == "sse" {
                if !e.headers.is_empty() {
                    v["headers"] = value_from_map(&e.headers);
                }
            } else {
                if !e.args.is_empty() {
                    v["args"] = json!(e.args);
                }
                if !e.env.is_empty() {
                    v["env"] = value_from_map(&e.env);
                }
            }
            obj.insert(name.to_string(), v);
        }
    }
    write_json_object(&path, &root)
}

/// Codex：config.toml 的 [mcp_servers.<name>]（toml_edit 保留其余内容与注释）
fn apply_codex(home: &std::path::Path, name: &str, e: Option<&McpEntry>) -> Result<(), AppError> {
    let path = codex_toml(home);
    let mut doc: toml_edit::DocumentMut = match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => s
            .parse()
            .map_err(|err| AppError::internal(format!("解析 config.toml 失败：{err}")))?,
        _ => toml_edit::DocumentMut::new(),
    };
    if let Some(table) = doc.get_mut("mcp_servers").and_then(|i| i.as_table_mut()) {
        table.remove(name);
    }
    if let Some(e) = e {
        let mut t = toml_edit::Table::new();
        t.set_implicit(true);
        match e.kind.as_str() {
            "http" | "sse" => {
                t["url"] = toml_edit::value(e.url.clone().unwrap_or_default());
                if !e.headers.is_empty() {
                    let mut h = toml_edit::Table::new();
                    for (k, v) in &e.headers {
                        h[k] = toml_edit::value(v.clone());
                    }
                    t["http_headers"] = toml_edit::Item::Table(h);
                }
            }
            _ => {
                t["command"] = toml_edit::value(e.command.clone().unwrap_or_default());
                if !e.args.is_empty() {
                    let mut arr = toml_edit::Array::new();
                    for a in &e.args {
                        arr.push(a.clone());
                    }
                    t["args"] = toml_edit::value(arr);
                }
                if !e.env.is_empty() {
                    let mut ev = toml_edit::Table::new();
                    for (k, v) in &e.env {
                        ev[k] = toml_edit::value(v.clone());
                    }
                    t["env"] = toml_edit::Item::Table(ev);
                }
            }
        }
        let root = doc.as_table_mut();
        if !root.get("mcp_servers").map(|i| i.as_table().is_some()).unwrap_or(false) {
            let mut ms = toml_edit::Table::new();
            ms.set_implicit(true);
            root.insert("mcp_servers", toml_edit::Item::Table(ms));
        }
        doc["mcp_servers"][name] = toml_edit::Item::Table(t);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal(format!("创建目录失败：{e}")))?;
    }
    std::fs::write(&path, doc.to_string())
        .map_err(|e| AppError::internal(format!("写入 config.toml 失败：{e}")))
}

/// OpenCode：opencode.json 的 mcp
fn apply_opencode(home: &std::path::Path, name: &str, e: Option<&McpEntry>) -> Result<(), AppError> {
    let path = opencode_json(home);
    let mut root = read_json_object(&path)?;
    let servers = root
        .entry("mcp".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let obj = servers
        .as_object_mut()
        .ok_or_else(|| AppError::internal("opencode.json 的 mcp 不是对象"))?;
    match e {
        None => {
            obj.remove(name);
        }
        Some(e) => {
            let mut v = match e.kind.as_str() {
                "http" | "sse" => json!({
                    "type": "remote",
                    "url": e.url.clone().unwrap_or_default(),
                    "enabled": true,
                }),
                _ => {
                    let mut arr = vec![e.command.clone().unwrap_or_default()];
                    arr.extend(e.args.iter().cloned());
                    json!({ "type": "local", "command": arr, "enabled": true })
                }
            };
            if e.kind == "http" || e.kind == "sse" {
                if !e.headers.is_empty() {
                    v["headers"] = value_from_map(&e.headers);
                }
            } else if !e.env.is_empty() {
                v["env"] = value_from_map(&e.env);
            }
            obj.insert(name.to_string(), v);
        }
    }
    write_json_object(&path, &root)
}

/// 按条目的 enabled 分发/摘除到各 CLI；只摘除本应用曾写入过的（synced），新导入/未分发的条目不影响本机已有配置。
/// 成功后把结果写回 e.synced。
fn sync_entry_at(home: &std::path::Path, e: &mut McpEntry) -> Result<(), AppError> {
    let mut first_err: Option<AppError> = None;
    for (cli, _) in CLI_TARGETS {
        let desired = e.enabled.get(*cli).copied().unwrap_or(false);
        let wrote_before = e.synced.get(*cli).copied().unwrap_or(false);
        let r = match (*cli, desired) {
            ("claude", true) => apply_claude(home, &e.name, Some(e)),
            ("codex", true) => apply_codex(home, &e.name, Some(e)),
            (_, true) => apply_opencode(home, &e.name, Some(e)),
            (cli, false) if wrote_before => match cli {
                "claude" => apply_claude(home, &e.name, None),
                "codex" => apply_codex(home, &e.name, None),
                _ => apply_opencode(home, &e.name, None),
            },
            (_, false) => Ok(()),
        };
        match r {
            Ok(()) => {
                e.synced.insert(cli.to_string(), desired);
            }
            Err(err) => {
                first_err.get_or_insert(err);
            }
        }
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn sync_entry(e: &mut McpEntry) -> Result<(), AppError> {
    sync_entry_at(&home_dir()?, e)
}

/// 摘除本应用写入过该名字的所有 CLI 配置（删除条目/更名时用）
fn strip_where_synced(e: &McpEntry) -> Result<(), AppError> {
    strip_where_synced_at(&home_dir()?, e)
}

fn strip_where_synced_at(home: &std::path::Path, e: &McpEntry) -> Result<(), AppError> {
    for (cli, _) in CLI_TARGETS {
        if e.synced.get(*cli).copied().unwrap_or(false) {
            match *cli {
                "claude" => apply_claude(home, &e.name, None)?,
                "codex" => apply_codex(home, &e.name, None)?,
                _ => apply_opencode(home, &e.name, None)?,
            }
        }
    }
    Ok(())
}

// ===== 读取：扫描各 CLI 已有配置 =====

fn scan_claude(home: &std::path::Path) -> Result<Vec<McpEntry>, AppError> {
    let path = claude_json(home);
    if !path.exists() {
        return Ok(vec![]);
    }
    let root = read_json_object(&path)?;
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for (name, v) in servers {
        let kind = match v["type"].as_str() {
            Some("http") => "http",
            Some("sse") => "sse",
            _ => "stdio",
        }
        .to_string();
        out.push(McpEntry {
            id: String::new(),
            name: name.clone(),
            kind,
            command: v["command"].as_str().map(str::to_string),
            args: string_array(v.get("args")),
            env: string_map(v.get("env")),
            url: v["url"].as_str().map(str::to_string),
            headers: string_map(v.get("headers")),
            ..Default::default()
        });
    }
    Ok(out)
}

fn scan_codex(home: &std::path::Path) -> Result<Vec<McpEntry>, AppError> {
    let path = codex_toml(home);
    let Ok(s) = std::fs::read_to_string(&path) else {
        return Ok(vec![]);
    };
    let doc: toml_edit::DocumentMut = s
        .parse()
        .map_err(|e| AppError::internal(format!("解析 config.toml 失败：{e}")))?;
    let Some(table) = doc.get("mcp_servers").and_then(|i| i.as_table()) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for (name, item) in table.iter() {
        let Some(t) = item.as_table() else { continue };
        let url = t.get("url").and_then(|i| i.as_str()).map(str::to_string);
        let command = t.get("command").and_then(|i| i.as_str()).map(str::to_string);
        let kind = if url.is_some() { "http" } else { "stdio" }.to_string();
        let args = t
            .get("args")
            .and_then(|i| i.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let mut env = BTreeMap::new();
        if let Some(ev) = t.get("env").and_then(|i| i.as_table()) {
            for (k, v) in ev.iter() {
                if let Some(s) = v.as_str() {
                    env.insert(k.to_string(), s.to_string());
                }
            }
        }
        let mut headers = BTreeMap::new();
        if let Some(h) = t.get("http_headers").and_then(|i| i.as_table()) {
            for (k, v) in h.iter() {
                if let Some(s) = v.as_str() {
                    headers.insert(k.to_string(), s.to_string());
                }
            }
        }
        out.push(McpEntry {
            id: String::new(),
            name: name.to_string(),
            kind,
            command,
            args,
            env,
            url,
            headers,
            ..Default::default()
        });
    }
    Ok(out)
}

fn scan_opencode(home: &std::path::Path) -> Result<Vec<McpEntry>, AppError> {
    let path = opencode_json(home);
    if !path.exists() {
        return Ok(vec![]);
    }
    let root = read_json_object(&path)?;
    let Some(servers) = root.get("mcp").and_then(Value::as_object) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for (name, v) in servers {
        let ty = v["type"].as_str().unwrap_or("local");
        let url = v["url"].as_str().map(str::to_string);
        let (kind, command, args) = if ty == "remote" || url.is_some() {
            ("http".to_string(), None, vec![])
        } else {
            let arr = string_array(v.get("command"));
            let cmd = arr.first().cloned().unwrap_or_default();
            ("stdio".to_string(), if cmd.is_empty() { None } else { Some(cmd) }, arr[1..].to_vec())
        };
        out.push(McpEntry {
            id: String::new(),
            name: name.clone(),
            kind,
            command,
            args,
            env: string_map(v.get("env")),
            url,
            headers: string_map(v.get("headers")),
            ..Default::default()
        });
    }
    Ok(out)
}

fn scan_all() -> Result<Vec<LocalMcp>, AppError> {
    let home = home_dir()?;
    let mut out = Vec::new();
    for (cli, label) in CLI_TARGETS {
        let list = match *cli {
            "claude" => scan_claude(&home)?,
            "codex" => scan_codex(&home)?,
            _ => scan_opencode(&home)?,
        };
        for mut e in list {
            e.source = "local".into();
            out.push(LocalMcp {
                cli: cli.to_string(),
                cli_label: label.to_string(),
                name: e.name.clone(),
                entry: e,
            });
        }
    }
    Ok(out)
}

/// 各 CLI 配置中现有的服务名集合（claude/codex/opencode → names）
fn scan_names() -> Result<BTreeMap<String, Vec<String>>, AppError> {
    let home = home_dir()?;
    let mut m = BTreeMap::new();
    for (cli, _) in CLI_TARGETS {
        let list = match *cli {
            "claude" => scan_claude(&home)?,
            "codex" => scan_codex(&home)?,
            _ => scan_opencode(&home)?,
        };
        m.insert(cli.to_string(), list.into_iter().map(|e| e.name).collect());
    }
    Ok(m)
}

// ===== 校验 =====

fn validate_name(name: &str) -> Result<(), AppError> {
    let n = name.trim();
    if n.is_empty() {
        return Err(AppError::config("服务名不能为空"));
    }
    if !n
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::config("服务名仅支持字母、数字、- 和 _"));
    }
    Ok(())
}

fn validate_entry(e: &McpEntry) -> Result<(), AppError> {
    validate_name(&e.name)?;
    match e.kind.as_str() {
        "http" | "sse" => {
            let url = e.url.as_deref().map(str::trim).filter(|s| !s.is_empty());
            if url.is_none() {
                return Err(AppError::config("http/sse 类型需要填写 URL"));
            }
        }
        _ => {
            let cmd = e.command.as_deref().map(str::trim).filter(|s| !s.is_empty());
            if cmd.is_none() {
                return Err(AppError::config("stdio 类型需要填写启动命令"));
            }
        }
    }
    Ok(())
}

// ===== 命令 =====

#[tauri::command]
pub async fn mcp_list(app: AppHandle) -> Result<Vec<McpView>, AppError> {
    let cfg = load_config(&app);
    let names = scan_names()?;
    Ok(cfg
        .mcps
        .iter()
        .map(|e| {
            let mut actual = BTreeMap::new();
            for (cli, _) in CLI_TARGETS {
                actual.insert(
                    cli.to_string(),
                    names.get(*cli).map(|v| v.contains(&e.name)).unwrap_or(false),
                );
            }
            McpView {
                entry: e.clone(),
                actual,
            }
        })
        .collect())
}

/// 新建（id 为空）或更新（按 id）注册表条目，并按 enabled 同步各 CLI
#[tauri::command]
pub async fn mcp_save(app: AppHandle, entry: McpEntry) -> Result<McpView, AppError> {
    let mut e = entry;
    e.name = e.name.trim().to_string();
    validate_entry(&e)?;
    let mut cfg = load_config(&app);
    if let Some(other) = cfg
        .mcps
        .iter()
        .find(|x| x.name == e.name && x.id != e.id)
    {
        return Err(AppError::config(format!("已存在同名服务「{}」", other.name)));
    }
    if e.id.trim().is_empty() {
        e.id = format!("mcp-{}", now_nanos());
    } else {
        let old = cfg.mcps.iter().find(|x| x.id == e.id).cloned();
        if let Some(ref o) = old {
            if o.name != e.name {
                // 更名：只摘除我们写入过的旧名
                strip_where_synced(o)?;
            }
            // 沿用旧的 synced 状态（前端表单不维护该字段）
            e.synced = o.synced.clone();
        }
        cfg.mcps.retain(|x| x.id != e.id);
    }
    // 同步前确保 enabled 只含已知 CLI
    e.enabled.retain(|k, _| CLI_TARGETS.iter().any(|(c, _)| c == k));
    sync_entry(&mut e)?;
    cfg.mcps.push(e.clone());
    save_config(&app, &cfg)?;
    Ok(McpView {
        entry: e,
        actual: Default::default(),
    })
}

/// 删除注册表条目，并从我们写入过的 CLI 配置中摘除
#[tauri::command]
pub async fn mcp_remove(app: AppHandle, id: String) -> Result<(), AppError> {
    let mut cfg = load_config(&app);
    let Some(e) = cfg.mcps.iter().find(|x| x.id == id) else {
        return Ok(());
    };
    strip_where_synced(e)?;
    cfg.mcps.retain(|x| x.id != id);
    save_config(&app, &cfg)
}

/// 设置分发目标（同步写入/摘除）
#[tauri::command]
pub async fn mcp_set_targets(app: AppHandle, id: String, targets: Vec<String>) -> Result<(), AppError> {
    let mut cfg = load_config(&app);
    let Some(e) = cfg.mcps.iter_mut().find(|x| x.id == id) else {
        return Err(AppError::config("条目不存在"));
    };
    let mut enabled = BTreeMap::new();
    for (cli, _) in CLI_TARGETS {
        enabled.insert(cli.to_string(), targets.iter().any(|t| t == cli));
    }
    e.enabled = enabled;
    let mut e = e.clone();
    sync_entry(&mut e)?;
    // 写回同步结果（synced）
    if let Some(slot) = cfg.mcps.iter_mut().find(|x| x.id == id) {
        slot.synced = e.synced.clone();
    }
    save_config(&app, &cfg)
}

#[tauri::command]
pub async fn mcp_scan_local() -> Result<Vec<LocalMcp>, AppError> {
    scan_all()
}

// ===== Smithery 市场 =====

#[tauri::command]
pub async fn mcp_market_search(query: String) -> Result<Vec<MarketServer>, AppError> {
    let q = query.trim().to_string();
    let mut req = crate::http::http_client()
        .get("https://registry.smithery.ai/servers")
        .query(&[("pageSize", "24")]);
    if !q.is_empty() {
        req = req.query(&[("q", q.as_str())]);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::network(format!("访问 Smithery 失败：{e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::network(format!(
            "Smithery 返回 HTTP {}",
            resp.status()
        )));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|_| AppError::api("Smithery 响应解析失败"))?;
    let mut out = Vec::new();
    if let Some(arr) = v["servers"].as_array() {
        for s in arr {
            let Some(qname) = s["qualifiedName"].as_str() else { continue };
            out.push(MarketServer {
                qualified_name: qname.to_string(),
                display_name: s["displayName"].as_str().unwrap_or(qname).to_string(),
                description: s["description"].as_str().unwrap_or("").to_string(),
                homepage: s["homepage"].as_str().map(str::to_string),
                verified: s["verified"].as_bool().unwrap_or(false),
                use_count: s["useCount"].as_i64(),
                remote: s["remote"].as_bool().unwrap_or(false),
            });
        }
    }
    Ok(out)
}

/// 从 Smithery 安装：取详情里的 connections[0]（http deploymentUrl）入库为远程服务
#[tauri::command]
pub async fn mcp_market_install(app: AppHandle, qualified_name: String) -> Result<McpView, AppError> {
    let qname = qualified_name.trim().to_string();
    let base = reqwest::Url::parse("https://registry.smithery.ai/")
        .map_err(|e| AppError::internal(e.to_string()))?;
    let url = base
        .join(&format!("servers/{qname}"))
        .map_err(|e| AppError::internal(e.to_string()))?;
    let resp = crate::http::http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::network(format!("访问 Smithery 失败：{e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::network(format!(
            "Smithery 返回 HTTP {}",
            resp.status()
        )));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|_| AppError::api("Smithery 响应解析失败"))?;
    let mut endpoint: Option<String> = None;
    if let Some(conns) = v["connections"].as_array() {
        for c in conns {
            if c["type"].as_str() == Some("http") || c["type"].as_str() == Some("sse") {
                if let Some(u) = c["deploymentUrl"].as_str() {
                    endpoint = Some(u.to_string());
                    break;
                }
            }
        }
    }
    let Some(url) = endpoint else {
        return Err(AppError::api(
            "该服务器没有可用的远程端点；可在本机扫描或手动添加 stdio 配置",
        ));
    };
    let name = sanitize_name(qname.as_str());
    let e = McpEntry {
        name,
        kind: "http".into(),
        url: Some(url),
        desc: v["description"].as_str().map(str::to_string),
        homepage: v["homepage"].as_str().map(str::to_string).or_else(|| {
            Some(format!("https://smithery.ai/servers/{qname}"))
        }),
        source: "market".into(),
        ..Default::default()
    };
    let mut e = e;
    // 与已有条目同名时自动加后缀
    let cfg = load_config(&app);
    let mut candidate = e.name.clone();
    let mut i = 1;
    while cfg.mcps.iter().any(|x| x.name == candidate) {
        candidate = format!("{}-{}", e.name, i);
        i += 1;
    }
    e.name = candidate;
    drop(cfg);
    mcp_save(app, e).await
}

fn sanitize_name(raw: &str) -> String {
    let mut s: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    while s.starts_with('-') {
        s.remove(0);
    }
    if s.is_empty() {
        s = format!("mcp-{}", now_nanos());
    }
    s
}

// ===== 内置精选 =====

struct BuiltinDef {
    key: &'static str,
    name: &'static str,
    desc: &'static str,
    category: &'static str,
    homepage: &'static str,
    /// stdio 启动参数（command + args）；None = http 型（用 url）
    command: Option<&'static str>,
    args: &'static [&'static str],
    url: Option<&'static str>,
}

const BUILTINS: &[BuiltinDef] = &[
    BuiltinDef {
        key: "excel",
        name: "excel-mcp-server",
        desc: "Excel 工作簿读写：单元格/区域/公式/格式、数据检索与批注管理",
        category: "办公",
        homepage: "https://www.npmjs.com/package/@negokaz/excel-mcp-server",
        command: Some("npx"),
        args: &["-y", "@negokaz/excel-mcp-server"],
        url: None,
    },
    BuiltinDef {
        key: "ppt",
        name: "ppt-generator",
        desc: "PPT 生成：从 AI 大纲与模板生成 PowerPoint 文件",
        category: "办公",
        homepage: "https://www.npmjs.com/package/@8btc/ppt-generator-mcp",
        command: Some("npx"),
        args: &["-y", "@8btc/ppt-generator-mcp"],
        url: None,
    },
    BuiltinDef {
        key: "docx",
        name: "docx-mcp-server",
        desc: "Word 文档编辑：读取/编辑/格式/批注/高亮与修订追踪",
        category: "办公",
        homepage: "https://www.npmjs.com/package/docx-mcp-server",
        command: Some("npx"),
        args: &["-y", "docx-mcp-server"],
        url: None,
    },
    BuiltinDef {
        key: "drawio",
        name: "drawio",
        desc: "draw.io 画图：创建与编辑流程图、架构图并导出",
        category: "画图",
        homepage: "https://www.npmjs.com/package/@next-ai-drawio/mcp-server",
        command: Some("npx"),
        args: &["-y", "@next-ai-drawio/mcp-server"],
        url: None,
    },
    BuiltinDef {
        key: "excalidraw",
        name: "excalidraw",
        desc: "Excalidraw 画图：手绘风白板图表创建与编辑",
        category: "画图",
        homepage: "https://www.npmjs.com/package/@cuylabs/mcp-excalidraw",
        command: Some("npx"),
        args: &["-y", "@cuylabs/mcp-excalidraw"],
        url: None,
    },
    BuiltinDef {
        key: "diagram",
        name: "diagram-generator",
        desc: "多格式图表生成：drawio / mermaid / excalidraw 一站式",
        category: "画图",
        homepage: "https://www.npmjs.com/package/mcp-diagram-generator",
        command: Some("npx"),
        args: &["-y", "mcp-diagram-generator"],
        url: None,
    },
    BuiltinDef {
        key: "playwright",
        name: "playwright",
        desc: "浏览器自动化：页面操作、截图、表单与端到端测试",
        category: "开发",
        homepage: "https://www.npmjs.com/package/@playwright/mcp",
        command: Some("npx"),
        args: &["-y", "@playwright/mcp"],
        url: None,
    },
    BuiltinDef {
        key: "filesystem",
        name: "filesystem",
        desc: "文件系统访问：读写/搜索/目录管理（默认开放用户主目录）",
        category: "开发",
        homepage: "https://github.com/modelcontextprotocol/servers",
        command: Some("npx"),
        args: &["-y", "@modelcontextprotocol/server-filesystem", "{home}"],
        url: None,
    },
    BuiltinDef {
        key: "context7",
        name: "context7",
        desc: "最新文档检索：获取库/框架的最新用法文档，避免过时 API",
        category: "开发",
        homepage: "https://www.npmjs.com/package/@upstash/context7-mcp",
        command: Some("npx"),
        args: &["-y", "@upstash/context7-mcp"],
        url: None,
    },
    BuiltinDef {
        key: "sequential-thinking",
        name: "sequential-thinking",
        desc: "结构化推理：分步思考与修正的思维链工具",
        category: "思考",
        homepage: "https://github.com/modelcontextprotocol/servers",
        command: Some("npx"),
        args: &["-y", "@modelcontextprotocol/server-sequential-thinking"],
        url: None,
    },
    BuiltinDef {
        key: "memory",
        name: "memory",
        desc: "知识图谱记忆：跨会话实体/关系记忆存储",
        category: "思考",
        homepage: "https://github.com/modelcontextprotocol/servers",
        command: Some("npx"),
        args: &["-y", "@modelcontextprotocol/server-memory"],
        url: None,
    },
];

/// 内置精选列表（category 分组交给前端）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinMcp {
    pub key: String,
    pub name: String,
    pub kind: String,
    pub desc: String,
    pub category: String,
    pub homepage: String,
}

#[tauri::command]
pub async fn mcp_builtins() -> Result<Vec<BuiltinMcp>, AppError> {
    Ok(BUILTINS
        .iter()
        .map(|b| BuiltinMcp {
            key: b.key.into(),
            name: b.name.into(),
            kind: if b.command.is_some() { "stdio".into() } else { "http".into() },
            desc: b.desc.into(),
            category: b.category.into(),
            homepage: b.homepage.into(),
        })
        .collect())
}

/// 一键安装内置精选（{home} 占位符展开为用户主目录），入库后不分发，由用户勾选
#[tauri::command]
pub async fn mcp_install_builtin(app: AppHandle, key: String) -> Result<McpView, AppError> {
    let Some(b) = BUILTINS.iter().find(|b| b.key == key) else {
        return Err(AppError::config("未知的内置 MCP"));
    };
    let home = home_dir()?;
    let home_str = home.display().to_string();
    let args: Vec<String> = b
        .args
        .iter()
        .map(|a| a.replace("{home}", &home_str))
        .collect();
    let mut e = McpEntry {
        name: b.name.into(),
        kind: if b.command.is_some() { "stdio".into() } else { "http".into() },
        command: b.command.map(str::to_string),
        args,
        url: b.url.map(str::to_string),
        desc: Some(b.desc.into()),
        homepage: Some(b.homepage.into()),
        tags: vec![b.category.into()],
        source: "builtin".into(),
        ..Default::default()
    };
    // 已有同名 → 视为更新（沿用其分发开关）
    let cfg = load_config(&app);
    if let Some(old) = cfg.mcps.iter().find(|x| x.name == e.name) {
        e.id = old.id.clone();
        e.enabled = old.enabled.clone();
    }
    drop(cfg);
    mcp_save(app, e).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gy-mcp-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn stdio_entry(name: &str) -> McpEntry {
        McpEntry {
            id: "mcp-x".into(),
            name: name.into(),
            kind: "stdio".into(),
            command: Some("npx".into()),
            args: vec!["-y".into(), "pkg".into()],
            ..Default::default()
        }
    }

    #[test]
    fn claude_apply_and_scan_roundtrip() {
        let home = make_home("claude");
        let e = stdio_entry("demo");
        apply_claude(&home, "demo", Some(&e)).unwrap();
        let text = std::fs::read_to_string(claude_json(&home)).unwrap();
        assert!(text.contains("\"mcpServers\""));
        let scanned = scan_claude(&home).unwrap();
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].name, "demo");
        assert_eq!(scanned[0].kind, "stdio");
        assert_eq!(scanned[0].command.as_deref(), Some("npx"));

        // 写入其他顶层字段后更新，应保留原字段
        let mut root = read_json_object(&claude_json(&home)).unwrap();
        root.insert("firstRun".into(), serde_json::json!(false));
        write_json_object(&claude_json(&home), &root).unwrap();
        let e2 = McpEntry { name: "demo".into(), url: Some("https://x/mcp".into()), kind: "http".into(), ..Default::default() };
        apply_claude(&home, "demo", Some(&e2)).unwrap();
        let root = read_json_object(&claude_json(&home)).unwrap();
        assert_eq!(root.get("firstRun"), Some(&serde_json::json!(false)));

        apply_claude(&home, "demo", None).unwrap();
        assert!(scan_claude(&home).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn codex_apply_preserves_other_config() {
        let home = make_home("codex");
        let path = codex_toml(&home);
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(&path, "# 注释保留\nmodel = \"gpt\"\n\n[mcp_servers.old]\ncommand = \"a\"\n").unwrap();
        let e = stdio_entry("demo");
        apply_codex(&home, "demo", Some(&e)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("# 注释保留"));
        assert!(text.contains("model = \"gpt\""));
        assert!(text.contains("[mcp_servers.demo]"));
        assert!(text.contains("command = \"npx\""));
        let scanned = scan_codex(&home).unwrap();
        assert!(scanned.iter().any(|x| x.name == "demo" && x.command.as_deref() == Some("npx")));
        assert!(scanned.iter().any(|x| x.name == "old"));

        // http 型带 headers
        let h = McpEntry {
            name: "remote".into(),
            kind: "http".into(),
            url: Some("https://x/mcp".into()),
            headers: BTreeMap::from([("Authorization".into(), "Bearer t".into())]),
            ..Default::default()
        };
        apply_codex(&home, "remote", Some(&h)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[mcp_servers.remote.http_headers]"));

        apply_codex(&home, "demo", None).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("[mcp_servers.demo]"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_apply_and_scan_roundtrip() {
        let home = make_home("oc");
        let e = stdio_entry("demo");
        apply_opencode(&home, "demo", Some(&e)).unwrap();
        let root = read_json_object(&opencode_json(&home)).unwrap();
        let mcp = root.get("mcp").unwrap();
        assert_eq!(mcp["demo"]["type"], "local");
        assert_eq!(mcp["demo"]["command"][0], "npx");

        let scanned = scan_opencode(&home).unwrap();
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].command.as_deref(), Some("npx"));
        assert_eq!(scanned[0].args, vec!["-y".to_string(), "pkg".to_string()]);

        apply_opencode(&home, "demo", None).unwrap();
        assert!(scan_opencode(&home).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn name_validation() {
        assert!(validate_name("web-search_1").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("智谱搜索").is_err());
        assert!(validate_name("a b").is_err());
    }

    #[test]
    fn sync_entry_never_strips_unmanaged_config() {
        let home = make_home("sync");
        // 本机已有同名服务（外部配置）
        let existing = stdio_entry("context7");
        apply_claude(&home, "context7", Some(&existing)).unwrap();

        // 导入/新建条目（enabled/synced 均空）→ 不得摘除本机已有配置
        let mut e = McpEntry { name: "context7".into(), ..Default::default() };
        sync_entry_at(&home, &mut e).unwrap();
        assert!(!scan_claude(&home).unwrap().is_empty(), "导入未分发时不应摘除本机已有配置");
        assert!(e.synced.values().all(|v| !*v));

        // 勾选 claude → 写入并记录 synced；再取消 → 摘除
        e.enabled.insert("claude".into(), true);
        sync_entry_at(&home, &mut e).unwrap();
        assert_eq!(e.synced.get("claude"), Some(&true));
        assert!(scan_claude(&home).unwrap().iter().any(|x| x.name == "context7"));

        e.enabled.insert("claude".into(), false);
        sync_entry_at(&home, &mut e).unwrap();
        assert_eq!(e.synced.get("claude"), Some(&false));
        assert!(scan_claude(&home).unwrap().is_empty());

        // 我们从未写过的 CLI（opencode）取消时不报错也不动文件
        assert!(!opencode_json(&home).exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn sanitize_market_name() {
        assert_eq!(sanitize_name("@scope/name"), "scope-name");
        assert!(sanitize_name("///").starts_with("mcp-"));
    }
}
