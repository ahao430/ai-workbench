//! 语雀（Yuque）集成：支持**多连接并存**（个人 www.yuque.com + 自定义域名）。
//! 每个连接独立保存凭证与已选知识空间，凭证存本地密钥库（secrets.db，账号名
//! `yuque-session:{id}` / `yuque-token:{id}`），配置存 config.json。
//! 两种鉴权：① 账号密码登录（默认，官网网页登录 `/api/accounts/login`，密码 md5 摘要提交、
//! **密码不落盘**，只保存会话 Cookie）② 个人 Token（会员/管理员可选）。
//! 数据接口统一 `/api/v2/*`（网页会话 Cookie 同样可调用）。语雀限流 100 次/小时，全部按需请求。

use std::collections::HashMap;
use std::sync::OnceLock;

use md5::Digest as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::secrets;
use crate::store;

/// 密钥库条目前缀
const SESSION_PREFIX: &str = "yuque-session:";
const TOKEN_PREFIX: &str = "yuque-token:";
/// 旧版单连接密钥库条目（迁移后删除）
const LEGACY_SESSION: &str = "yuque-session";
const LEGACY_TOKEN: &str = "yuque-token";

/// 语雀接入配置（config.json；凭证不在这里）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct YuqueConfig {
    /// 多个并存的语雀连接（公司 / 个人 / 自定义）
    pub connections: Vec<YqConnection>,
    // ===== 旧版单连接字段（仅迁移读取，迁移后清空） =====
    pub base: String,
    pub user_name: String,
    pub user_login: String,
    pub spaces: Vec<YqSpace>,
}

/// 单个语雀连接
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct YqConnection {
    /// 稳定标识：company / personal / custom:{domain}
    pub id: String,
    /// 展示名：个人语雀 / 自定义域名
    pub label: String,
    /// 域名（www.yuque.com / 自定义）
    pub base: String,
    pub user_name: String,
    pub user_login: String,
    /// 选定作为 AI 知识源的知识空间
    pub spaces: Vec<YqSpace>,
}

/// 选定的知识空间（语雀 repo）
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct YqSpace {
    pub id: i64,
    pub namespace: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// 归属展示名（团队名/个人名）——左侧子空间分组用
    #[serde(default)]
    pub owner_name: String,
    /// group（团队子空间）| user（个人）
    #[serde(default)]
    pub owner_kind: String,
}

// ===== 响应模型 =====

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YqUser {
    pub id: i64,
    #[serde(default)]
    pub login: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar_url: String,
}

/// 知识库（repo）完整信息（选空间时列出）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YqRepo {
    pub id: i64,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// 1 公开 / 0 私有
    #[serde(default)]
    pub public: i32,
    #[serde(default)]
    pub updated_at: String,
    /// 归属展示名（团队名 / 个人名）——子空间分组用
    #[serde(default)]
    pub owner_name: String,
    /// group（团队子空间）| user（个人）
    #[serde(default)]
    pub owner_kind: String,
    #[serde(default)]
    pub user: Option<YqLoginRef>,
    #[serde(default)]
    pub group: Option<YqLoginRef>,
}

/// 文档摘要（列表项）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YqDoc {
    pub id: i64,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub title: String,
    /// Doc | Sheet | Table | Board。序列化键必须叫 kind（前端按 kind 读）；
    /// 反序列化兼容 v2 接口的 "type" 键（alias 只影响读取，rename 会连序列化一起改名，
    /// 之前因此把 kind 序列化成了 type，前端读到 undefined、表格分支从未生效）。
    #[serde(default, alias = "type")]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub word_count: i64,
}

/// 文档详情（Doc 的 body 为 Markdown 源文；Sheet 的 sheet 为结构化单元格）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YqDocDetail {
    pub id: i64,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub updated_at: String,
    /// Sheet（语雀表格）结构化数据：每页的单元格（行号→列号→文本）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<Vec<YqSheetTab>>,
}

/// 语雀表格单页（sheet）：只含有值的单元格
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YqSheetTab {
    #[serde(default)]
    pub name: String,
    /// 行号 → 列号 → 单元格文本
    #[serde(default)]
    pub cells: std::collections::BTreeMap<i64, std::collections::BTreeMap<i64, String>>,
}

/// 搜索结果项（type: doc/repo/user…；只返回 doc；connLabel/connId 为聚合时回填）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YqSearchItem {
    pub id: i64,
    #[serde(default, alias = "type")]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub repo: YqRepoRef,
    #[serde(default)]
    pub doc: YqDocRef,
    /// 回填：所属连接（跨连接搜索展示用）
    #[serde(default)]
    pub conn_id: String,
    #[serde(default)]
    pub conn_label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YqRepoRef {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YqDocRef {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub slug: String,
}

// ===== 底层请求（独立无 Cookie Jar 的客户端，避免污染全局网关会话） =====

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        // 语雀内部接口对非浏览器 UA 不友好（yuque-dl 等工具同样伪装 Chrome UA）
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("failed to build yuque client")
    })
}

/// 鉴权材料：会话 Cookie 或 Token
enum Auth {
    Cookie(String),
    Token(String),
}

impl Auth {
    fn apply(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self {
            Auth::Cookie(c) => rb.header("Cookie", c),
            Auth::Token(t) => rb.header("X-Auth-Token", t),
        }
    }
}

/// 语雀响应统一 { data: T } 包装
#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

fn norm_base(base: &str) -> String {
    let b = base.trim().trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    if b.is_empty() {
        "www.yuque.com".to_string()
    } else {
        b.to_string()
    }
}

fn cookie_header_of(rsp: &reqwest::Response) -> String {
    let mut pairs: Vec<String> = Vec::new();
    for v in rsp.headers().get_all("set-cookie") {
        if let Ok(s) = v.to_str() {
            if let Some(kv) = s.split(';').next() {
                let kv = kv.trim();
                if kv.contains('=') && !kv.starts_with('=') {
                    pairs.push(kv.to_string());
                }
            }
        }
    }
    pairs.join("; ")
}

async fn err_of(rsp: reqwest::Response) -> AppError {
    let status = rsp.status();
    let code = status.as_u16();
    let body = rsp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .or_else(|| v.get("status"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| {
            let t: String = body.split_whitespace().take(20).collect::<Vec<_>>().join(" ");
            t.chars().take(160).collect()
        });
    match code {
        401 => AppError::unauthorized(format!("语雀会话已失效：{msg}")),
        403 => AppError::unauthorized(format!("语雀拒绝访问（权限不足）：{msg}")),
        429 => AppError::api("语雀接口限流（100 次/小时），请稍后再试"),
        _ => AppError::api(format!("语雀接口错误（{code}）：{msg}")),
    }
}

async fn get<T: serde::de::DeserializeOwned>(base: &str, path: &str, auth: &Auth) -> Result<T, AppError> {
    let rsp = auth
        .apply(
            client()
                .get(format!("https://{base}{path}"))
                .header("User-Agent", concat!("ai-workbench/", env!("CARGO_PKG_VERSION"))),
        )
        .send()
        .await?;
    if !rsp.status().is_success() {
        return Err(err_of(rsp).await);
    }
    let env: Envelope<T> = rsp
        .json()
        .await
        .map_err(|e| AppError::api(format!("语雀响应解析失败：{e}")))?;
    Ok(env.data)
}

// ===== 凭证与配置读取 =====

fn session_account(id: &str) -> String {
    format!("{SESSION_PREFIX}{id}")
}

fn token_account(id: &str) -> String {
    format!("{TOKEN_PREFIX}{id}")
}

fn auth_of(id: &str) -> Result<Option<Auth>, AppError> {
    if let Some(c) = secrets::get(&session_account(id))? {
        if !c.trim().is_empty() {
            return Ok(Some(Auth::Cookie(c)));
        }
    }
    if let Some(t) = secrets::get(&token_account(id))? {
        if !t.trim().is_empty() {
            return Ok(Some(Auth::Token(t)));
        }
    }
    Ok(None)
}

fn yuque_cfg(app: &AppHandle) -> YuqueConfig {
    store::load_config(app).yuque.unwrap_or_default()
}

fn conn_of(app: &AppHandle, id: &str) -> Result<YqConnection, AppError> {
    yuque_cfg(app)
        .connections
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::config("该语雀连接不存在——请重新添加"))
}

/// 旧版单连接（yuque-session / yuque-token + 扁平字段）迁移为 connections[0]
fn migrate_legacy(app: &AppHandle) {
    let mut cfg = store::load_config(app);
    let Some(y) = cfg.yuque.as_mut() else { return };
    if !y.connections.is_empty() {
        return;
    }
    let sess = secrets::get(LEGACY_SESSION).ok().flatten().filter(|s| !s.trim().is_empty());
    let tok = secrets::get(LEGACY_TOKEN).ok().flatten().filter(|s| !s.trim().is_empty());
    if sess.is_none() && tok.is_none() {
        return;
    }
    let legacy_base = y.base.clone();
    let label = "语雀".to_string();
    let conn = YqConnection {
        id: "main".into(),
        label,
        base: legacy_base,
        user_name: y.user_name.clone(),
        user_login: y.user_login.clone(),
        spaces: y.spaces.clone(),
    };
    if let Some(s) = sess {
        let _ = secrets::set(&session_account("main"), &s);
        let _ = secrets::delete(LEGACY_SESSION);
    }
    if let Some(t) = tok {
        let _ = secrets::set(&token_account("main"), &t);
        let _ = secrets::delete(LEGACY_TOKEN);
    }
    y.connections.push(conn);
    y.base = String::new();
    y.user_name = String::new();
    y.user_login = String::new();
    y.spaces = Vec::new();
    let _ = store::save_config(app, &cfg);
}

// ===== 命令 =====

/// 状态：连接列表（含各连接凭证存在性）
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct YqConnStatus {
    #[serde(flatten)]
    pub conn: YqConnection,
    pub has_auth: bool,
}

#[tauri::command]
pub async fn yuque_status(app: AppHandle) -> Result<Vec<YqConnStatus>, AppError> {
    migrate_legacy(&app);
    let mut full = store::load_config(&app);
    let mut changed = false;
    if let Some(y) = full.yuque.as_mut() {
        // 旧配置的空间没有归属信息（子空间分组用）：拉全量知识库回填并持久化，
        // 成功后不再触发；会话内每连接只尝试一次，避免反复打接口吃限流额度。
        static BACKFILLED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
            std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));
        for c in &mut y.connections {
            if c.spaces.is_empty() || c.spaces.iter().all(|s| !s.owner_name.is_empty()) {
                continue;
            }
            if !BACKFILLED.lock().unwrap().insert(c.id.clone()) {
                continue;
            }
            let Some(auth) = auth_of(&c.id).ok().flatten() else { continue };
            let Ok(repos) = list_repos(&c.base, &auth).await else { continue };
            for s in &mut c.spaces {
                if !s.owner_name.is_empty() {
                    continue;
                }
                if let Some(r) = repos.iter().find(|r| r.namespace == s.namespace) {
                    s.owner_name = r.owner_name.clone();
                    s.owner_kind = r.owner_kind.clone();
                    changed = true;
                }
            }
        }
    }
    if changed {
        let _ = store::save_config(&app, &full);
    }
    let mut list = Vec::new();
    for c in full.yuque.unwrap_or_default().connections {
        let has_auth = auth_of(&c.id)?.is_some();
        list.push(YqConnStatus { conn: c, has_auth });
    }
    Ok(list)
}

/// 账号密码登录：GET /login 取 csrf（ctoken）→ POST /api/accounts/login（密码 md5）
/// → 汇总会话 Cookie → GET /api/v2/user 确认身份。密码只进内存，不落盘。
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YqLoginResult {
    pub user: YqUser,
    /// 会话 Cookie（前端暂存，保存时回传）
    pub cookie: String,
}

#[tauri::command]
pub async fn yuque_login(base: String, account: String, password: String) -> Result<YqLoginResult, AppError> {
    let base = norm_base(&base);
    let account = account.trim().to_string();
    if account.is_empty() || password.is_empty() {
        return Err(AppError::config("请填写语雀账号与密码"));
    }
    // 1. 登录页拿初始 Cookie（含 ctoken，POST 需要）
    let login_page = client()
        .get(format!("https://{base}/login"))
        .header("User-Agent", concat!("ai-workbench/", env!("CARGO_PKG_VERSION")))
        .send()
        .await?;
    let init_cookie = cookie_header_of(&login_page);
    let ctoken = init_cookie
        .split("; ")
        .find_map(|kv| kv.strip_prefix("ctoken="))
        .map(|s| s.to_string())
        .unwrap_or_default();

    // 2. 提交登录（官网前端同款：密码 md5 十六进制）
    let digest = md5::Md5::digest(password.as_bytes());
    let body = serde_json::json!({ "login": account, "password": format!("{digest:x}") });
    let mut post = client()
        .post(format!("https://{base}/api/accounts/login"))
        .header("User-Agent", concat!("ai-workbench/", env!("CARGO_PKG_VERSION")))
        .json(&body);
    if !init_cookie.is_empty() {
        post = post.header("Cookie", &init_cookie);
    }
    if !ctoken.is_empty() {
        post = post.header("X-CSRF-Token", &ctoken);
    }
    let rsp = post.send().await?;
    if !rsp.status().is_success() {
        return Err(err_of(rsp).await);
    }
    // 3. 汇总会话 Cookie（登录前 + 登录后 Set-Cookie 合并，后者覆盖同名）
    let mut jar: HashMap<String, String> = HashMap::new();
    for kv in init_cookie.split("; ").filter(|s| s.contains('=')) {
        let mut it = kv.splitn(2, '=');
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
            jar.insert(k.to_string(), v.to_string());
        }
    }
    let session_cookie = cookie_header_of(&rsp);
    for kv in session_cookie.split("; ").filter(|s| s.contains('=')) {
        let mut it = kv.splitn(2, '=');
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
            jar.insert(k.to_string(), v.to_string());
        }
    }
    let cookie = jar
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ");
    if !jar.keys().any(|k| k.contains("session")) {
        return Err(AppError::unauthorized("登录未返回会话（账号密码错误或触发验证码），请重试或改用 Token"));
    }

    // 4. 会话确认身份（失败不阻断——个别域名可能限制）
    let user = get::<YqUser>(&base, "/api/v2/user", &Auth::Cookie(cookie.clone()))
        .await
        .unwrap_or_default();
    Ok(YqLoginResult { user, cookie })
}

/// 验证 Token（管理员/会员路径）
#[tauri::command]
pub async fn yuque_verify(base: Option<String>, token: String) -> Result<YqUser, AppError> {
    let base = norm_base(&base.unwrap_or_default());
    let t = token.trim();
    if t.is_empty() {
        return Err(AppError::config("请填写语雀 Token"));
    }
    get::<YqUser>(&base, "/api/v2/user", &Auth::Token(t.to_string())).await
}

/// 应用内网页登录：检查登录窗口是否已完成。遍历应用全部 webview 窗口
/// （含登录窗口自身）读取整个 Cookie 库（含 HttpOnly），按域名分层（主机级
/// 优先于父域）组装候选 Cookie，并**用目标域名实际调用一次接口验证**——
/// 避免公司/个人共享父域 Cookie 时把 A 域会话误存为 B 域凭证。
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YqWebLoginCheck {
    pub ready: bool,
    pub cookie: Option<String>,
    pub user: Option<YqUser>,
    /// 调试：该域名下发现的 Cookie 名（诊断登录窗口会话用）
    pub names: Vec<String>,
}

#[tauri::command]
pub async fn yuque_web_login_check(
    app: AppHandle,
    base: String,
    window_hint: Option<String>,
) -> Result<YqWebLoginCheck, AppError> {
    use tauri::Manager as _;
    let base = norm_base(&base);
    // 域名分层：xxx.yuque.com → 主机层 xxx.yuque.com，父域层 yuque.com
    let suffix: String = {
        let parts: Vec<&str> = base.split('.').collect();
        parts[parts.len().saturating_sub(2)..].join(".")
    };
    let mut names: Vec<String> = Vec::new();
    // 逐窗口收集分层 Cookie（不同窗口可能各持不同版本的同名会话，不能跨窗合并）
    struct WinCookies {
        host: Vec<(String, String)>,
        parent: Vec<(String, String)>,
    }
    let mut wins: Vec<(String, WinCookies)> = Vec::new();
    for (label, win) in app.webview_windows() {
        let Ok(all) = win.cookies() else { continue };
        let mut c = WinCookies { host: Vec::new(), parent: Vec::new() };
        for ck in all {
            let domain = ck.domain().unwrap_or("").trim_start_matches('.');
            let pair = (ck.name().to_string(), ck.value().to_string());
            if domain == base {
                c.host.push(pair);
            } else if domain == suffix {
                c.parent.push(pair);
            } else {
                continue;
            }
            if !names.contains(&ck.name().to_string()) {
                names.push(ck.name().to_string());
            }
        }
        if !c.host.is_empty() || !c.parent.is_empty() {
            wins.push((label, c));
        }
    }
    // 登录窗口（调用方传入）的 Cookie 优先验证
    if let Some(h) = window_hint.as_deref() {
        wins.sort_by_key(|(l, _)| if l == h { 0 } else { 1 });
    }
    let build = |first: &[(String, String)], second: &[(String, String)]| -> String {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        first
            .iter()
            .chain(second)
            .filter(|(k, _)| seen.insert(k))
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    };
    // 每个窗口两组候选（主机+父域合并、仅主机层），全局去重后逐个验证
    let mut seen_headers: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut candidates: Vec<String> = Vec::new();
    for (_l, c) in &wins {
        for hdr in [build(&c.host, &c.parent), build(&c.host, &[])] {
            if !hdr.is_empty() && seen_headers.insert(hdr.clone()) {
                candidates.push(hdr);
            }
        }
    }
    // 已验证失败的 Cookie 串不再重复验证（轮询限流保护；登录成功后串会变化）
    static FAILED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    for header in candidates {
        if !header.contains("session") {
            continue; // 无会话 Cookie 不浪费限流额度去验证
        }
        if FAILED.lock().unwrap().contains(&header) {
            continue; // 该 Cookie 串已验证失败，等登录变化后的新串
        }
        let auth = Auth::Cookie(header.clone());
        // 实际调用一次内部接口验证该 Cookie 在目标域名有效
        let ok = get::<Vec<RawMineBook>>(&base, "/api/mine/books?limit=1&offset=0", &auth)
            .await
            .is_ok();
        if ok {
            let user = get::<YqUser>(&base, "/api/v2/user", &auth).await.ok();
            return Ok(YqWebLoginCheck { ready: true, cookie: Some(header), user, names });
        }
        FAILED.lock().unwrap().insert(header);
        return Ok(YqWebLoginCheck { names, ..Default::default() });
    }
    Ok(YqWebLoginCheck { names, ..Default::default() })
}

/// /api/mine/books 原始条目（网页端「我的知识库」——含团队知识库；
/// namespace 可能缺省，需从 user/group login + slug 拼出）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawMineBook {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    namespace: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    public: i32,
    #[serde(default)]
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    user: Option<YqLoginRef>,
    #[serde(default)]
    group: Option<YqLoginRef>,
}

#[derive(Deserialize, Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct YqLoginRef {
    #[serde(default)]
    pub login: String,
    #[serde(default)]
    pub name: String,
    /// Group | User（mine/books 中团队归属放在 user.type=Group）
    #[serde(default, rename = "type")]
    pub kind: String,
}

/// 归属（团队优先于个人）：返回 (kind, 展示名, login)
fn owner_of(user: &Option<YqLoginRef>, group: &Option<YqLoginRef>) -> (&'static str, String, String) {
    if let Some(g) = group {
        if !g.login.is_empty() || !g.name.is_empty() {
            return (
                "group",
                if g.name.is_empty() { g.login.clone() } else { g.name.clone() },
                g.login.clone(),
            )
        }
    }
    if let Some(u) = user {
        let kind = if u.kind == "Group" { "group" } else { "user" };
        return (kind, if u.name.is_empty() { u.login.clone() } else { u.name.clone() }, u.login.clone())
    }
    ("", String::new(), String::new())
}

/// 内部接口 /api/docs 的条目（网页会话拉文档列表）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawIntDoc {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    title: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    word_count: i64,
    #[serde(default)]
    updated_at: String,
}

/// 内部接口 /api/docs/{slug} 详情（sourcecode 为 Markdown 源文）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawIntDocDetail {
    #[serde(default)]
    title: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    sourcecode: String,
    #[serde(default)]
    updated_at: String,
}

/// 内部接口 /api/docs/{slug}?mode=original（content 为 lake 原始格式；
/// Sheet 的 content 是 JSON，其 sheet 字段为 zlib 压缩字节串）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawIntDocOriginal {
    #[serde(default)]
    title: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    updated_at: String,
}

/// lakesheet 正文解析：content 为 JSON `{"format":"lakesheet",...,"sheet":"<压缩串>"}`，
/// sheet 字段是 zlib 压缩字节按 latin-1 塞进 JSON 字符串（每字符一字节），解压后为
/// sheet 页数组 [{name, rowCount, data: {行: {列: {v: 值}}}}]，转成紧凑单元格网格。
fn parse_lakesheet(content: &str) -> Result<Vec<YqSheetTab>, AppError> {
    let v: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| AppError::api(format!("表格文档解析失败：{e}")))?;
    let packed = v
        .get("sheet")
        .and_then(|s| s.as_str())
        .unwrap_or_default();
    if packed.is_empty() {
        return Ok(Vec::new()); // 空表格
    }
    let bytes: Vec<u8> = packed.chars().map(|c| c as u8).collect();
    let mut raw = Vec::new();
    use std::io::Read as _;
    flate2::read::ZlibDecoder::new(&bytes[..])
        .read_to_end(&mut raw)
        .map_err(|e| AppError::api(format!("表格数据解压失败：{e}")))?;
    let text = String::from_utf8(raw).map_err(|e| AppError::api(format!("表格数据解码失败：{e}")))?;
    let tabs: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| AppError::api(format!("表格数据解析失败：{e}")))?;
    let arr = tabs.as_array().ok_or_else(|| AppError::api("表格数据格式异常"))?;
    let mut out = Vec::new();
    for tab in arr {
        let name = tab
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("Sheet")
            .to_string();
        let mut cells = std::collections::BTreeMap::new();
        if let Some(data) = tab.get("data").and_then(|d| d.as_object()) {
            for (r, row) in data {
                let Ok(ri) = r.parse::<i64>() else { continue };
                let Some(rowm) = row.as_object() else { continue };
                let mut row_cells = std::collections::BTreeMap::new();
                for (c, cell) in rowm {
                    let Ok(ci) = c.parse::<i64>() else { continue };
                    let s = match cell.get("v") {
                        Some(serde_json::Value::String(s)) => s.clone(),
                        Some(serde_json::Value::Number(n)) => n.to_string(),
                        Some(serde_json::Value::Bool(b)) => b.to_string(),
                        _ => continue,
                    };
                    if !s.is_empty() {
                        row_cells.insert(ci, s);
                    }
                }
                if !row_cells.is_empty() {
                    cells.insert(ri, row_cells);
                }
            }
        }
        out.push(YqSheetTab { name, cells });
    }
    Ok(out)
}

/// 内部接口 /api/mine/books 分页拉取全部知识库（Book 类型）。
/// v2 的 /user/repos 只列个人自建库，团队知识库必须走这里。
async fn mine_books(base: &str, auth: &Auth) -> Result<Vec<YqRepo>, AppError> {
    let mut out: Vec<YqRepo> = Vec::new();
    let mut offset: i32 = 0;
    loop {
        let page: Vec<RawMineBook> =
            get(base, &format!("/api/mine/books?limit=50&offset={offset}"), auth).await?;
        let n = page.len();
        for b in page {
            if !b.kind.is_empty() && b.kind != "Book" {
                continue; // Resource 等其他类型不是知识库
            }
            let (kind, owner_name, owner_login) = owner_of(&b.user, &b.group);
            let ns = if !b.namespace.is_empty() {
                b.namespace
            } else {
                if owner_login.is_empty() || b.slug.is_empty() {
                    continue;
                }
                format!("{owner_login}/{}", b.slug)
            };
            out.push(YqRepo {
                id: b.id,
                namespace: ns,
                name: b.name,
                description: b.description,
                public: b.public,
                updated_at: String::new(),
                owner_name,
                owner_kind: kind.to_string(),
                user: b.user,
                group: b.group,
            });
        }
        if n < 50 || out.len() > 400 {
            break;
        }
        offset += 50;
    }
    Ok(out)
}

/// 列出知识库（内部 mine/books 优先 + v2 兜底），供带凭证与存量凭证两种入口复用
async fn list_repos(base: &str, auth: &Auth) -> Result<Vec<YqRepo>, AppError> {
    let mut out: Vec<YqRepo> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut first_err: Option<AppError> = None;
    // ① 网页会话：mine/books（团队 + 个人全部）
    if matches!(auth, Auth::Cookie(_)) {
        match mine_books(base, auth).await {
            Ok(list) => {
                for r in list {
                    if seen.insert(r.namespace.clone()) {
                        out.push(r);
                    }
                }
            }
            Err(e) => first_err = Some(e),
        }
    }
    // ② 兜底/补充：v2 个人知识库
    if out.is_empty() {
        match get::<Vec<YqRepo>>(base, "/api/v2/user/repos?offset=0&limit=100", auth).await {
            Ok(list) => {
                for mut r in list {
                    if r.owner_name.is_empty() {
                        let (kind, name, _) = owner_of(&r.user, &r.group);
                        r.owner_kind = kind.to_string();
                        r.owner_name = name;
                    }
                    if seen.insert(r.namespace.clone()) {
                        out.push(r);
                    }
                }
            }
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
    }
    if out.is_empty() {
        if let Some(e) = first_err {
            return Err(e);
        }
    }
    Ok(out)
}

/// 列出我的知识库（选空间用；凭证二选一：会话 Cookie 或 Token）
#[tauri::command]
pub async fn yuque_spaces(
    base: String,
    token: Option<String>,
    cookie: Option<String>,
) -> Result<Vec<YqRepo>, AppError> {
    let base = norm_base(&base);
    let auth = match (cookie.as_deref().map(str::trim), token.as_deref().map(str::trim)) {
        (Some(c), _) if !c.is_empty() => Auth::Cookie(c.to_string()),
        (_, Some(t)) if !t.is_empty() => Auth::Token(t.to_string()),
        _ => return Err(AppError::config("缺少凭证（会话或 Token）")),
    };
    list_repos(&base, &auth).await
}

/// 用已保存的凭证列出该连接的知识库（连接管理「重新选择空间」用）
#[tauri::command]
pub async fn yuque_spaces_stored(app: AppHandle, id: String) -> Result<Vec<YqRepo>, AppError> {
    let c = conn_of(&app, &id)?;
    let auth = auth_of(&id)?.ok_or_else(|| AppError::config("该连接凭证已失效，请重新登录"))?;
    list_repos(&c.base, &auth).await
}

/// 保存/更新一个连接（按 id upsert；凭证二选一入密钥库，另一条会被清掉）
#[tauri::command]
pub async fn yuque_save(
    app: AppHandle,
    id: String,
    label: String,
    base: String,
    token: Option<String>,
    cookie: Option<String>,
    user: YqUser,
    spaces: Vec<YqSpace>,
) -> Result<(), AppError> {
    let id = id.trim().to_string();
    let base = norm_base(&base);
    if id.is_empty() {
        return Err(AppError::config("连接 id 不能为空"));
    }
    let tok = token.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let ck = cookie.as_deref().map(str::trim).filter(|s| !s.is_empty());
    match (tok, ck) {
        (Some(t), _) => {
            secrets::set(&token_account(&id), t)?;
            secrets::delete(&session_account(&id))?;
        }
        (None, Some(c)) => {
            secrets::set(&session_account(&id), c)?;
            secrets::delete(&token_account(&id))?;
        }
        (None, None) => return Err(AppError::config("缺少凭证（会话或 Token）")),
    }
    migrate_legacy(&app);
    let mut cfg = store::load_config(&app);
    let y = cfg.yuque.get_or_insert_with(YuqueConfig::default);
    let conn = YqConnection {
        id,
        label: label.trim().to_string(),
        base,
        user_name: user.name,
        user_login: user.login,
        spaces,
    };
    match y.connections.iter_mut().find(|c| c.id == conn.id) {
        Some(c) => *c = conn,
        None => y.connections.push(conn),
    }
    store::save_config(&app, &cfg)
}

/// 只更新某连接的空间选择
#[tauri::command]
pub async fn yuque_update_spaces(app: AppHandle, id: String, spaces: Vec<YqSpace>) -> Result<(), AppError> {
    let mut cfg = store::load_config(&app);
    if let Some(c) = cfg
        .yuque
        .as_mut()
        .and_then(|y| y.connections.iter_mut().find(|c| c.id == id))
    {
        c.spaces = spaces;
    } else {
        return Err(AppError::config("该语雀连接不存在"));
    }
    store::save_config(&app, &cfg)
}

/// 移除单个连接（连同其凭证）
#[tauri::command]
pub async fn yuque_remove(app: AppHandle, id: String) -> Result<(), AppError> {
    secrets::delete(&session_account(&id))?;
    secrets::delete(&token_account(&id))?;
    let mut cfg = store::load_config(&app);
    if let Some(y) = cfg.yuque.as_mut() {
        y.connections.retain(|c| c.id != id);
    }
    store::save_config(&app, &cfg)
}

/// 断开全部语雀连接
#[tauri::command]
pub async fn yuque_disconnect(app: AppHandle) -> Result<(), AppError> {
    let ids: Vec<String> = yuque_cfg(&app).connections.into_iter().map(|c| c.id).collect();
    for id in ids {
        let _ = secrets::delete(&session_account(&id));
        let _ = secrets::delete(&token_account(&id));
    }
    let _ = secrets::delete(LEGACY_SESSION);
    let _ = secrets::delete(LEGACY_TOKEN);
    let mut cfg = store::load_config(&app);
    cfg.yuque = None;
    store::save_config(&app, &cfg)
}

/// 某连接下某空间的文档列表。
/// 会话走内部 /api/docs?book_id=（v2 不认网页会话）；Token 走 v2 repos/{ns}/docs。
#[tauri::command]
pub async fn yuque_docs(app: AppHandle, id: String, namespace: String) -> Result<Vec<YqDoc>, AppError> {
    let c = conn_of(&app, &id)?;
    let auth = auth_of(&id)?.ok_or_else(|| AppError::config("该连接凭证已失效，请重新登录"))?;
    match &auth {
        Auth::Cookie(_) => {
            let bid = c
                .spaces
                .iter()
                .find(|s| s.namespace == namespace)
                .map(|s| s.id)
                .ok_or_else(|| AppError::config("该空间不在已关联列表中——请重新选择空间"))?;
            let mut out: Vec<YqDoc> = Vec::new();
            let mut offset: i32 = 0;
            loop {
                let page: Vec<RawIntDoc> = get(
                    &c.base,
                    &format!("/api/docs?book_id={bid}&offset={offset}&limit=100"),
                    &auth,
                )
                .await?;
                let n = page.len();
                out.extend(page.into_iter().map(|d| YqDoc {
                    id: d.id,
                    slug: d.slug,
                    title: d.title,
                    kind: d.kind,
                    description: d.description,
                    updated_at: d.updated_at,
                    word_count: d.word_count,
                }));
                if n < 100 || out.len() >= 300 {
                    break;
                }
                offset += 100;
            }
            Ok(out)
        }
        Auth::Token(_) => {
            let ns = urlencode(&namespace);
            get::<Vec<YqDoc>>(&c.base, &format!("/api/v2/repos/{ns}/docs?offset=0&limit=100"), &auth).await
        }
    }
}

/// 文档详情。Doc：Markdown 源文（会话 sourcecode / Token v2 raw=1）；
/// Sheet：mode=original 取 lake 原始 content，解压出单元格网格（仅会话路径支持）。
#[tauri::command]
pub async fn yuque_doc(
    app: AppHandle,
    id: String,
    namespace: String,
    slug: String,
    kind: Option<String>,
) -> Result<YqDocDetail, AppError> {
    let c = conn_of(&app, &id)?;
    let auth = auth_of(&id)?.ok_or_else(|| AppError::config("该连接凭证已失效，请重新登录"))?;
    match &auth {
        Auth::Cookie(_) => {
            let bid = c
                .spaces
                .iter()
                .find(|s| s.namespace == namespace)
                .map(|s| s.id)
                .ok_or_else(|| AppError::config("该空间不在已关联列表中——请重新选择空间"))?;
            let sg = urlencode(&slug);
            if kind.as_deref() == Some("Sheet") {
                let d: RawIntDocOriginal = get(
                    &c.base,
                    &format!("/api/docs/{sg}?book_id={bid}&merge_dynamic_data=false&mode=original"),
                    &auth,
                )
                .await?;
                let sheet = parse_lakesheet(&d.content)?;
                return Ok(YqDocDetail {
                    id: 0,
                    slug: d.slug,
                    title: d.title,
                    body: String::new(),
                    updated_at: d.updated_at,
                    sheet: Some(sheet),
                });
            }
            let d: RawIntDocDetail = get(
                &c.base,
                &format!("/api/docs/{sg}?book_id={bid}&merge_dynamic_data=false&mode=markdown"),
                &auth,
            )
            .await?;
            Ok(YqDocDetail {
                id: 0,
                slug: d.slug,
                title: d.title,
                body: d.sourcecode,
                updated_at: d.updated_at,
                sheet: None,
            })
        }
        Auth::Token(_) => {
            let ns = urlencode(&namespace);
            let sg = urlencode(&slug);
            get::<YqDocDetail>(&c.base, &format!("/api/v2/repos/{ns}/docs/{sg}?raw=1"), &auth).await
        }
    }
}

/// 搜索。
/// Token 连接走 v2 全文搜索；会话连接（v2 不可用）在已关联空间本地过滤标题/摘要
/// （逐空间拉文档列表，每连接最多 12 个空间，注意限流）。
#[tauri::command]
pub async fn yuque_search(
    app: AppHandle,
    q: String,
    namespace: Option<String>,
) -> Result<Vec<YqSearchItem>, AppError> {
    let conns = yuque_cfg(&app).connections;
    let q = q.trim();
    if q.is_empty() || conns.is_empty() {
        return Ok(Vec::new());
    }
    let q_lower = q.to_lowercase();
    let ns_filter = namespace.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mut out: Vec<YqSearchItem> = Vec::new();
    let mut first_err: Option<AppError> = None;
    for c in &conns {
        let Some(auth) = auth_of(&c.id)? else { continue };
        match &auth {
            Auth::Token(_) => {
                let path = format!("/api/v2/search?q={}&offset=0&limit=20", urlencode(q));
                match get::<Vec<YqSearchItem>>(&c.base, &path, &auth).await {
                    Ok(items) => out.extend(items.into_iter().filter(|i| {
                        i.kind == "doc"
                            && match ns_filter {
                                Some(ns) => i.repo.namespace == ns,
                                None => true,
                            }
                    }).map(|mut i| {
                        i.conn_id = c.id.clone();
                        i.conn_label = c.label.clone();
                        i
                    })),
                    Err(e) => {
                        if first_err.is_none() {
                            first_err = Some(e)
                        }
                    }
                }
            }
            Auth::Cookie(_) => {
                for s in c.spaces.iter().take(12) {
                    if let Some(ns) = ns_filter {
                        if s.namespace != ns {
                            continue
                        }
                    }
                    let page: Vec<RawIntDoc> = match get(
                        &c.base,
                        &format!("/api/docs?book_id={}&offset=0&limit=100", s.id),
                        &auth,
                    )
                    .await
                    {
                        Ok(p) => p,
                        Err(e) => {
                            if first_err.is_none() {
                                first_err = Some(e)
                            }
                            continue
                        }
                    };
                    for d in page {
                        if !d.kind.is_empty() && d.kind != "Doc" {
                            continue // Sheet/Table/Board 无正文，不进搜索结果
                        }
                        let hit = d.title.to_lowercase().contains(&q_lower)
                            || d.description.to_lowercase().contains(&q_lower);
                        if !hit {
                            continue
                        }
                        out.push(YqSearchItem {
                            id: d.id,
                            kind: "doc".into(),
                            title: d.title,
                            summary: d.description,
                            url: format!("https://{}/{}/{}", c.base, s.namespace, d.slug),
                            repo: YqRepoRef { id: s.id, namespace: s.namespace.clone(), name: s.name.clone() },
                            doc: YqDocRef { id: d.id, slug: d.slug },
                            conn_id: c.id.clone(),
                            conn_label: c.label.clone(),
                        });
                    }
                    if out.len() >= 40 {
                        break
                    }
                }
            }
        }
        if out.len() >= 40 {
            break
        }
    }
    if out.is_empty() {
        if let Some(e) = first_err {
            return Err(e);
        }
    }
    Ok(out)
}

/// 简单百分号编码（namespace 形如 user/repo-slug，斜杠不编码）
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ===== 文档图片代理（语雀 CDN 防盗链，WebView 直连加载不出） =====

/// URL 的稳定缓存键（SipHash 十六进制，够散且无外部依赖）
fn cache_key(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// 下载语雀文档里的图片到本机缓存（app_data/images/yuque/），返回绝对路径供
/// convertFileSrc 渲染。安全边界：仅接受连接本域与 *.nlark.com 的 https 地址；
/// 会话 Cookie 只随本域请求发送，绝不外泄给第三方 CDN。命中缓存不重复下载。
#[tauri::command]
pub async fn yuque_cache_image(app: AppHandle, conn_id: String, url: String) -> Result<String, AppError> {
    let conn = conn_of(&app, &conn_id)?;
    let base_host = norm_base(&conn.base);

    // 手工解析，避免为校验一个 URL 引入 url crate：scheme://host/...
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| AppError::api("仅允许 https 图片地址"))?;
    let host = rest.split('/').next().unwrap_or_default();
    let host = host.split('@').next_back().unwrap_or(host); // 去掉 user@ 形式
    let host = host.split(':').next().unwrap_or(host); // 去掉端口
    let same_site = host == base_host || host.ends_with(&format!(".{base_host}"));
    let nlark = host == "nlark.com" || host.ends_with(".nlark.com");
    if host.is_empty() || (!same_site && !nlark) {
        return Err(AppError::api(format!("非语雀图片地址：{host}")));
    }

    let ext = rest
        .split(['?', '#'])
        .next()
        .and_then(|p| p.rsplit('.').next())
        .filter(|e: &&str| {
            let n = e.len();
            (2..=5).contains(&n) && e.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or("png")
        .to_string();

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::api(format!("数据目录不可用：{e}")))?
        .join("images")
        .join("yuque");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::api(format!("缓存目录创建失败：{e}")))?;
    let path = dir.join(format!("{}.{}", cache_key(&url), ext));
    if path.exists() {
        return Ok(path.to_string_lossy().into_owned());
    }

    let auth = auth_of(&conn_id)?
        .ok_or_else(|| AppError::unauthorized("语雀未登录，请先在语雀页重新连接"))?;
    let mut req = client().get(&url);
    if same_site {
        req = auth.apply(req);
    }
    let rsp = req.send().await?;
    if !rsp.status().is_success() {
        return Err(AppError::api(format!("图片下载失败（{}）", rsp.status())));
    }
    let bytes = rsp.bytes().await?;
    if bytes.is_empty() {
        return Err(AppError::api("图片下载为空"));
    }
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| AppError::api(format!("图片缓存写入失败：{e}")))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// YqDoc.kind 序列化键必须是 kind（前端按 kind 读）；反序列化兼容 v2 的 "type"。
    /// 曾因 rename="type" 把序列化键也改成了 type，前端读到 undefined，表格分支从未生效。
    #[test]
    fn yq_doc_kind_key() {
        let d = YqDoc { kind: "Sheet".into(), ..Default::default() };
        let j = serde_json::to_value(&d).unwrap();
        assert_eq!(j["kind"], "Sheet");
        assert!(j.get("type").is_none());
        let v: YqDoc = serde_json::from_str(r#"{"id":1,"type":"Sheet"}"#).unwrap();
        assert_eq!(v.kind, "Sheet");
    }

    /// lakesheet：zlib 压缩字节按 latin-1 塞进 JSON 字符串 → parse_lakesheet 还原单元格网格
    #[test]
    fn lakesheet_roundtrip() {
        use std::io::Write as _;
        let inner = r#"[{"name":"Sheet1","rowCount":3,"data":{"0":{"0":{"v":"标题"},"2":{"v":12}},"2":{"1":{"v":true}}}}]"#;
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(inner.as_bytes()).unwrap();
        let packed: String = enc.finish().unwrap().into_iter().map(|b| b as char).collect();
        let content = serde_json::json!({ "format": "lakesheet", "sheet": packed }).to_string();
        let tabs = parse_lakesheet(&content).unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].name, "Sheet1");
        assert_eq!(
            tabs[0].cells.get(&0).and_then(|r| r.get(&0)).map(String::as_str),
            Some("标题")
        );
        assert_eq!(
            tabs[0].cells.get(&0).and_then(|r| r.get(&2)).map(String::as_str),
            Some("12")
        );
        assert_eq!(
            tabs[0].cells.get(&2).and_then(|r| r.get(&1)).map(String::as_str),
            Some("true")
        );
        // 空 sheet 字段（空表格）→ 空结果不报错
        assert!(parse_lakesheet(r#"{"format":"lakesheet","sheet":""}"#).unwrap().is_empty());
    }
}
