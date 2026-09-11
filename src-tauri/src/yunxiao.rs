//! 阿里云云效（Yunxiao）集成：个人访问令牌（PAT）接入 + 项目空间/工作项/Codeup 仓库/流水线。
//! 接口形态（与开源 yunxiao-cli 一致，已核对）：
//! - OpenAPI 基址 https://openapi-rdc.aliyuncs.com，请求头 x-yunxiao-token
//! - Codeup 基址 https://codeup.aliyuncs.com/api/v3（GitLab 风格），同一 PAT 鉴权
//! PAT 由用户在云效「个人设置 → 个人访问令牌」创建，存本地密钥库（secrets.db），
//! 组织/用户信息存 config.json（YunxiaoConfig）。

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

use crate::error::AppError;
use crate::http::http_client;
use crate::secrets;
use crate::store;

/// 密钥库条目名
const PAT_ACCOUNT: &str = "yunxiao-pat";
/// 云效 OpenAPI（Projex/Flow/Platform/Codeup 统一网关）
const OAPI_BASE: &str = "https://openapi-rdc.aliyuncs.com";

/// 云效接入配置（config.json；PAT 不在这里）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct YunxiaoConfig {
    pub org_id: String,
    pub org_name: String,
    /// PAT 属主（工作台“我的工作项”过滤用）
    pub user_id: String,
    pub user_name: String,
}

/// 云效接口对缺失字段常回传 null（而非省略键），`#[serde(default)]` 不接受 null，
/// 一个 null 字段会炸掉整页数组解析（曾导致工作项列表「响应解析失败」）。
fn null_to_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let v = Option::<T>::deserialize(d)?;
    Ok(v.unwrap_or_default())
}

// ===== 响应模型（只取用得到的字段，其余忽略） =====

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxUser {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxOrg {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxProject {
    pub id: String,
    pub name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub custom_code: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub description: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub gmt_create: i64,
    /// 我在该项目的角色（逐项目查成员表回填；None = 非成员或未判定）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub my_role: Option<String>,
}

/// 项目成员（GET projects/{id}/members；一次返回全量——接口不认任何分页参数，带 query 即报"项目不存在"）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawMember {
    #[serde(default, deserialize_with = "null_to_default")]
    user_id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    role_name: String,
}

/// 查询我在指定项目中的角色；None = 非成员（查询失败也按非成员处理，不阻塞列表）
async fn my_role_in(token: &str, org_id: &str, project_id: &str, user_id: &str) -> Option<String> {
    if user_id.is_empty() {
        return None;
    }
    let path = format!("/oapi/v1/projex/organizations/{org_id}/projects/{project_id}/members");
    let members: Vec<RawMember> = oapi_get(&path, token).await.ok()?;
    members
        .into_iter()
        .find(|m| m.user_id == user_id)
        .map(|m| m.role_name)
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxWorkitem {
    pub id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub serial_number: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub subject: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub gmt_create: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    pub gmt_modified: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    pub status: YxNamed,
    #[serde(default, deserialize_with = "null_to_default")]
    pub assigned_to: YxNamed,
    #[serde(default, deserialize_with = "null_to_default")]
    pub creator: YxNamed,
    #[serde(default, deserialize_with = "null_to_default")]
    pub space: YxNamed,
    #[serde(default, deserialize_with = "null_to_default")]
    pub description: String,
    /// 描述格式（MD / 富文本），详情渲染用
    #[serde(default, deserialize_with = "null_to_default")]
    pub format_type: String,
    /// 工作项类型（常规需求/线上问题/任务/缺陷等自定义类型）
    #[serde(default, deserialize_with = "null_to_default")]
    pub workitem_type: YxNamed,
}

/// workitem.status / assignedTo / creator / space 等嵌套对象的公共形态。
/// workitems:search 返回的人员/状态对象的键是 `id`（creator.id/assignedTo.id），
/// 用 alias 兼容；序列化仍发 identifier，前端读法不变
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxNamed {
    #[serde(default, alias = "id", deserialize_with = "null_to_default")]
    pub identifier: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub display_name: String,
}

impl YxNamed {
    /// displayName 优先的展示名
    pub fn label(&self) -> String {
        if !self.display_name.is_empty() {
            self.display_name.clone()
        } else {
            self.name.clone()
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxRepo {
    pub id: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    pub name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub name_with_namespace: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub description: String,
    /// private / public
    #[serde(default, deserialize_with = "null_to_default")]
    pub visibility: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub web_url: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub ssh_url_to_repo: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub http_url_to_repo: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub last_activity_at: String,
}

/// 合并请求（Codeup changeRequests 新版接口；state 为 UNDER_DEV/UNDER_REVIEW/TO_BE_MERGED/MERGED/CLOSED）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxMr {
    pub local_id: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub source_branch: String,
    #[serde(default)]
    pub target_branch: String,
    #[serde(default)]
    pub author: YxUserLite,
    #[serde(default)]
    pub web_url: String,
    #[serde(default)]
    pub detail_url: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub project_id: i64,
    #[serde(default)]
    pub has_conflict: bool,
}

/// 实际工时报工记录（effortRecords；gmtStart/gmtEnd 为毫秒时间戳）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxEffort {
    pub id: String,
    pub workitem_id: String,
    /// 冗余工作项标题（聚合时回填，便于展示）
    #[serde(default)]
    pub subject: String,
    /// 工时（小时）
    #[serde(default)]
    pub actual_time: f64,
    #[serde(default)]
    pub work_type: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub owner_name: String,
    /// 冗余所属空间名（月历日详情显示归属）
    #[serde(default)]
    pub space_name: String,
    /// 工作开始时间（ms）
    #[serde(default)]
    pub gmt_start: i64,
    #[serde(default)]
    pub gmt_end: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxUserLite {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub username: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxPipeline {
    #[serde(default)]
    pub pipeline_id: i64,
    #[serde(default)]
    pub pipeline_name: String,
    #[serde(default)]
    pub create_time: i64,
}

// ===== 底层请求 =====

fn pat() -> Result<String, AppError> {
    secrets::get(PAT_ACCOUNT)?.ok_or_else(|| AppError::config("尚未接入云效——请先在云效页配置个人访问令牌"))
}

fn cfg(app: &AppHandle) -> Result<YunxiaoConfig, AppError> {
    store::load_config(app)
        .yunxiao
        .clone()
        .filter(|c| !c.org_id.is_empty())
        .ok_or_else(|| AppError::config("尚未选择云效组织——请先完成云效接入引导"))
}

/// 鉴权错误统一文案：401/403 多为令牌失效或权限不足
async fn oapi_get<T: serde::de::DeserializeOwned>(path: &str, token: &str) -> Result<T, AppError> {
    let rsp = http_client()
        .get(format!("{OAPI_BASE}{path}"))
        .header("x-yunxiao-token", token)
        .send()
        .await?;
    check(rsp).await?.json().await.map_err(|e| AppError::api(format!("响应解析失败：{e}")))
}

async fn oapi_post<T: serde::de::DeserializeOwned>(
    path: &str,
    token: &str,
    body: serde_json::Value,
) -> Result<T, AppError> {
    let rsp = http_client()
        .post(format!("{OAPI_BASE}{path}"))
        .header("x-yunxiao-token", token)
        .json(&body)
        .send()
        .await?;
    check(rsp).await?.json().await.map_err(|e| AppError::api(format!("响应解析失败：{e}")))
}

/// 非 2xx 时尽量取云效的 errorMessage 字段
async fn check(rsp: reqwest::Response) -> Result<reqwest::Response, AppError> {
    let status = rsp.status();
    if status.is_success() {
        return Ok(rsp);
    }
    let code = status.as_u16();
    let body = rsp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("errorMessage")
                .or_else(|| v.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    match code {
        401 | 403 => Err(AppError::unauthorized(format!("云效令牌无效或权限不足：{msg}"))),
        _ => Err(AppError::api(format!("云效接口错误（{code}）：{msg}"))),
    }
}

// ===== 命令 =====

/// 接入状态（不含令牌本身）
#[tauri::command]
pub async fn yunxiao_status(app: AppHandle) -> Result<YunxiaoConfig, AppError> {
    Ok(store::load_config(&app).yunxiao.unwrap_or_default())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YxVerifyResult {
    pub user: YxUser,
    pub orgs: Vec<YxOrg>,
}

/// 校验 PAT 并拉取账号信息与可选组织列表
#[tauri::command]
pub async fn yunxiao_verify(token: String) -> Result<YxVerifyResult, AppError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::config("请填写个人访问令牌"));
    }
    let user: YxUser = oapi_get("/oapi/v1/platform/user", &token).await?;
    let orgs: Vec<YxOrg> = oapi_get("/oapi/v1/platform/organizations", &token)
        .await
        .unwrap_or_default();
    Ok(YxVerifyResult { user, orgs })
}

/// 保存接入（PAT 入密钥库，组织/用户入 config.json）
#[tauri::command]
pub async fn yunxiao_save(
    app: AppHandle,
    token: String,
    org_id: String,
    org_name: String,
    user_id: String,
    user_name: String,
) -> Result<(), AppError> {
    let token = token.trim().to_string();
    if token.is_empty() || org_id.trim().is_empty() {
        return Err(AppError::config("令牌与组织均不能为空"));
    }
    secrets::set(PAT_ACCOUNT, &token)?;
    let mut cfg = store::load_config(&app);
    cfg.yunxiao = Some(YunxiaoConfig {
        org_id: org_id.trim().to_string(),
        org_name: org_name.trim().to_string(),
        user_id: user_id.trim().to_string(),
        user_name: user_name.trim().to_string(),
    });
    store::save_config(&app, &cfg)
}

/// 断开接入（删令牌 + 清配置）
#[tauri::command]
pub async fn yunxiao_disconnect(app: AppHandle) -> Result<(), AppError> {
    secrets::delete(PAT_ACCOUNT)?;
    let mut cfg = store::load_config(&app);
    cfg.yunxiao = None;
    store::save_config(&app, &cfg)
}

/// 项目空间列表（Projex projects:search）。翻页拉全量并并发查每个项目的成员表
/// 标注 myRole——搜索接口不支持按成员过滤（实测 member/mine 等字段被静默忽略），
/// 「我的项目」只能逐项目查成员判定；组织项目数通常个位到几十，成本可忽略
#[tauri::command]
pub async fn yunxiao_projects(app: AppHandle) -> Result<Vec<YxProject>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let path = format!("/oapi/v1/projex/organizations/{}/projects:search", c.org_id);
    let mut projects: Vec<YxProject> = Vec::new();
    for page in 1..=10u32 {
        let body = json!({ "page": page, "perPage": 50 });
        let batch: Vec<YxProject> = oapi_post(&path, &token, body).await?;
        let n = batch.len();
        projects.extend(batch);
        if n < 50 {
            break;
        }
    }
    if !c.user_id.is_empty() {
        let ids: Vec<String> = projects.iter().map(|p| p.id.clone()).collect();
        let futs = ids.into_iter().map(|pid| {
            let (token, org_id, user_id) = (token.clone(), c.org_id.clone(), c.user_id.clone());
            async move { my_role_in(&token, &org_id, &pid, &user_id).await }
        });
        let roles = futures_util::future::join_all(futs).await;
        for (p, role) in projects.iter_mut().zip(roles) {
            p.my_role = role;
        }
    }
    Ok(projects)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxWorkitemPage {
    pub items: Vec<YxWorkitem>,
    pub total: u64,
}

/// 工作项检索（按项目空间）。接口的 conditions 过滤是无文档的内部格式
/// （实测多种结构均 400 Invalid format），mine/keyword 改为客户端过滤：
/// 过滤模式下连拉至多 5 页（perPage=100，共 500 条）再筛，满足日常"只看我的/搜标题"。
#[tauri::command]
pub async fn yunxiao_workitems(
    app: AppHandle,
    project_id: String,
    category: Option<String>,
    keyword: Option<String>,
    mine: Option<bool>,
    page: Option<u32>,
) -> Result<YxWorkitemPage, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let kw = keyword
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);
    let want_mine = mine.unwrap_or(false) && !c.user_id.is_empty();
    let filtering = want_mine || kw.is_some();

    let path = format!("/oapi/v1/projex/organizations/{}/workitems:search", c.org_id);
    let base = json!({
        "spaceId": project_id,
        "category": category.clone().unwrap_or_else(|| "Req,Task,Bug".into()),
        "perPage": 20,
        "orderBy": "gmtModified",
        "sort": "desc",
    });
    // 返回原始响应：无过滤分支要先读 x-total 头（分页用），过滤分支直接解析数组
    let fetch_rsp = |p: u32, per_page: u32| {
        let mut body = base.clone();
        body["page"] = json!(p);
        body["perPage"] = json!(per_page);
        let token = token.clone();
        let path = path.clone();
        async move {
            let rsp = http_client()
                .post(format!("{OAPI_BASE}{path}"))
                .header("x-yunxiao-token", &token)
                .json(&body)
                .send()
                .await?;
            check(rsp).await
        }
    };

    if !filtering {
        let p = page.unwrap_or(1);
        let rsp = fetch_rsp(p, 20).await?;
        let total = rsp
            .headers()
            .get("x-total")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let items: Vec<YxWorkitem> =
            rsp.json().await.map_err(|e| AppError::api(format!("响应解析失败：{e}")))?;
        return Ok(YxWorkitemPage { total, items });
    }

    // 服务端 conditions 过滤一律 400（多格式实测均 Invalid format），mine/keyword
    // 只能客户端筛：perPage 顶到 100（上限），翻至多 5 页 = 500 条覆盖窗口
    let mut all = Vec::new();
    for p in 1..=5u32 {
        match fetch_rsp(p, 100).await {
            Ok(rsp) => {
                let list: Vec<YxWorkitem> = match rsp.json().await {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let full = list.len() >= 100;
                all.extend(list);
                if !full {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let items: Vec<YxWorkitem> = all
        .into_iter()
        .filter(|w| {
            // "只看我的" = 处理人是我 或 我创建的（列表接口无 participants，够覆盖常见诉求）
            (!want_mine
                || w.assigned_to.identifier == c.user_id
                || w.creator.identifier == c.user_id)
                && kw
                    .as_deref()
                    .map(|k| w.subject.to_lowercase().contains(k) || w.description.to_lowercase().contains(k))
                    .unwrap_or(true)
        })
        .collect();
    Ok(YxWorkitemPage { total: items.len() as u64, items })
}

/// Codeup 仓库列表。接口无视 pageSize（固定每页 20 条），x-total 头给总数，
/// 在 Rust 侧按 x-total 翻到底一次性返回全量（前端曾按 50 条/页判断提前断页丢仓库）
#[tauri::command]
pub async fn yunxiao_repos(app: AppHandle) -> Result<Vec<YxRepo>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let base = format!("/oapi/v1/codeup/organizations/{}/repositories", c.org_id);
    let mut out = Vec::new();
    let mut total: Option<u64> = None;
    for p in 1..=30u32 {
        let rsp = http_client()
            .get(format!("{OAPI_BASE}{base}?page={p}&pageSize=100"))
            .header("x-yunxiao-token", &token)
            .send()
            .await?;
        let rsp = check(rsp).await?;
        if total.is_none() {
            total = rsp
                .headers()
                .get("x-total")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse().ok());
        }
        let batch: Vec<YxRepo> = rsp
            .json()
            .await
            .map_err(|e| AppError::api(format!("响应解析失败：{e}")))?;
        let n = batch.len();
        out.extend(batch);
        if n == 0 || total.map(|t| out.len() as u64 >= t).unwrap_or(false) || n < 20 {
            break;
        }
    }
    Ok(out)
}

/// 合并请求列表（changeRequests 新版接口，按仓库过滤）；state: opened | merged | closed | all
#[tauri::command]
pub async fn yunxiao_merge_requests(
    app: AppHandle,
    repo_id: i64,
    state: Option<String>,
    page: Option<u32>,
) -> Result<Vec<YxMr>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let state = state.filter(|s| !s.is_empty() && s != "all").unwrap_or_default();
    let p = page.unwrap_or(1);
    let mut path = format!(
        "/oapi/v1/codeup/organizations/{}/changeRequests?projectIds={repo_id}&page={p}&perPage=20",
        c.org_id
    );
    if !state.is_empty() {
        path.push_str(&format!("&state={state}"));
    }
    oapi_get::<Vec<YxMr>>(&path, &token).await
}

/// 流水线列表（oapi 服务端分页：page 从 1 起、每页固定 10 条、name 按名过滤；
/// maxResults/nextToken 在该令牌版接口上不生效）
#[tauri::command]
pub async fn yunxiao_pipelines(
    app: AppHandle,
    page: i64,
    name: Option<String>,
) -> Result<Vec<YxPipeline>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let mut path = format!("/oapi/v1/flow/organizations/{}/pipelines?page={}", c.org_id, page.max(1));
    if let Some(n) = name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        path.push_str(&format!("&pipelineName={}", urlencode(n)));
    }
    oapi_get(&path, &token).await
}

/// 百分号编码（流水线名可含中文/空格/斜杠，全部编码）
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ===== 应用交付（AppStack） =====

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxApp {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// ISO 时间（2023-11-09T09:21:24.000+00:00）
    #[serde(default)]
    pub gmt_create: String,
    #[serde(default)]
    pub creator_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxEnv {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub descriptive_name: String,
    #[serde(default)]
    pub state: String,
}

/// 应用交付应用列表：keyset 分页翻到底一次性取全量（接口不支持关键字过滤，
/// 搜索/收藏筛选在前端做；封顶 50 页 = 1000 应用）
#[tauri::command]
pub async fn yunxiao_apps(app: AppHandle) -> Result<Vec<YxApp>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let mut out = Vec::new();
    let mut next = String::new();
    for _ in 0..50 {
        let mut path = format!(
            "/oapi/v1/appstack/organizations/{}/apps:search?pagination=keyset&perPage=20&orderBy=id&sort=asc",
            c.org_id
        );
        if !next.is_empty() {
            path.push_str(&format!("&nextToken={}", urlencode(&next)));
        }
        #[derive(Deserialize, Default)]
        #[serde(default, rename_all = "camelCase")]
        struct Raw {
            next_token: Option<String>,
            data: Vec<YxApp>,
        }
        let raw: Raw = oapi_get(&path, &token).await?;
        out.extend(raw.data);
        next = raw.next_token.unwrap_or_default();
        if next.is_empty() {
            break;
        }
    }
    Ok(out)
}

/// 应用环境列表（「运行」入口：选环境后跳网页部署页确认——公开 API 未开放直接触发部署）
#[tauri::command]
pub async fn yunxiao_app_envs(app: AppHandle, app_name: String) -> Result<Vec<YxEnv>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    // 响应是 { data: [...] } 包装，直接反序列化数组会失败（"运行"报错的根因）
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Raw {
        data: Vec<YxEnv>,
    }
    let raw: Raw = oapi_get(
        &format!(
            "/oapi/v1/appstack/organizations/{}/apps/{}/envs",
            c.org_id,
            urlencode(&app_name)
        ),
        &token,
    )
    .await?;
    Ok(raw.data)
}

// ===== 应用交付「运行」：研发流程阶段 / Webhook =====

/// 研发流程阶段（releaseWorkflows → releaseStages，嵌套深、字段杂，用 Value 防御性取值）
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxStage {
    pub sn: String,
    pub name: String,
    /// 环境标签（labels 中 envType 的 displayValue，如「测试环境」）
    pub env_label: String,
    /// 阶段绑定的部署流水线（0 = 未绑定）
    pub pipeline_id: i64,
    pub pipeline_name: String,
    /// 代码源类型（codeup / customGitlab / …；codeup 才能拉分支列表）
    pub source_type: String,
    /// 代码源仓库名（如 oss-management）
    pub repo_name: String,
    /// Codeup 仓库 id（sources[].data.projectId；0 = 未携带/非 codeup）
    pub repo_id: i64,
    /// 代码源默认分支
    pub default_branch: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxWorkflow {
    pub sn: String,
    pub name: String,
    pub stages: Vec<YxStage>,
}

/// 应用的研发流程列表（工作流 + 阶段 + 阶段绑定的流水线与 Webhook token）
#[tauri::command]
pub async fn yunxiao_app_workflows(app: AppHandle, app_name: String) -> Result<Vec<YxWorkflow>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let v: Vec<serde_json::Value> = oapi_get(
        &format!(
            "/oapi/v1/appstack/organizations/{}/apps/{}/releaseWorkflows",
            c.org_id,
            urlencode(&app_name)
        ),
        &token,
    )
    .await?;
    let mut out = Vec::new();
    for wf in v {
        let mut stages = Vec::new();
        if let Some(arr) = wf["releaseStages"].as_array() {
            for st in arr {
                // 阶段 → 绑定流水线：pipeline.pipeline.pipelineConfigVo.{pipelineId, sources}
                let pc = &st["pipeline"]["pipeline"];
                let cfg = &pc["pipelineConfigVo"];
                // sources 是 JSON 字符串（偶尔直接是数组），防御性归一
                let sources = match cfg.get("sources") {
                    Some(serde_json::Value::String(s)) => {
                        serde_json::from_str::<serde_json::Value>(s).unwrap_or(serde_json::Value::Null)
                    }
                    Some(v) => v.clone(),
                    None => serde_json::Value::Null,
                };
                let src = sources.as_array().and_then(|a| a.first()).cloned().unwrap_or(serde_json::Value::Null);
                let src_label = src["label"].as_str().unwrap_or_default();
                stages.push(YxStage {
                    sn: st["sn"].as_str().unwrap_or_default().to_string(),
                    name: st["name"].as_str().unwrap_or_default().to_string(),
                    env_label: st["labels"]
                        .as_array()
                        .and_then(|ls| {
                            ls.iter()
                                .find(|l| l["name"].as_str() == Some("envType"))
                                .and_then(|l| l["displayValue"].as_str())
                        })
                        .unwrap_or_default()
                        .to_string(),
                    pipeline_id: cfg["pipelineId"].as_i64().unwrap_or(0),
                    pipeline_name: pc["name"]
                        .as_str()
                        .or_else(|| cfg["name"].as_str())
                        .unwrap_or_default()
                        .to_string(),
                    source_type: src["type"].as_str().unwrap_or_default().to_string(),
                    repo_name: src["name"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| src_label.rsplit('/').next().unwrap_or_default().to_string()),
                    repo_id: src["data"]["projectId"].as_i64().unwrap_or(0),
                    default_branch: src["data"]["branch"].as_str().unwrap_or_default().to_string(),
                });
            }
        }
        out.push(YxWorkflow {
            sn: wf["sn"].as_str().unwrap_or_default().to_string(),
            name: wf["name"].as_str().unwrap_or_default().to_string(),
            stages,
        });
    }
    Ok(out)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxStageRunResult {
    pub pipeline_id: i64,
    pub pipeline_run_id: i64,
}

/// 执行研发流程阶段。body 结构按官方 MCP server schema：{ params: {流水线变量: 值} }，
/// 响应 { pipelineId, pipelineRunId }（社区实现里的 releaseWorkflowSn 等字段会被拒绝）
#[tauri::command]
pub async fn yunxiao_app_stage_execute(
    app: AppHandle,
    app_name: String,
    workflow_sn: String,
    stage_sn: String,
    params: Option<std::collections::HashMap<String, String>>,
) -> Result<YxStageRunResult, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let path = format!(
        "/oapi/v1/appstack/organizations/{}/apps/{}/releaseWorkflows/{}/releaseStages/{}:execute",
        c.org_id,
        urlencode(&app_name),
        urlencode(&workflow_sn),
        urlencode(&stage_sn)
    );
    let body = json!({ "params": params.unwrap_or_default() });
    let v: serde_json::Value = oapi_post(&path, &token, body).await?;
    Ok(YxStageRunResult {
        pipeline_id: v.get("pipelineId").and_then(|x| x.as_i64()).unwrap_or(0),
        pipeline_run_id: v.get("pipelineRunId").and_then(|x| x.as_i64()).unwrap_or(0),
    })
}

// ===== 阶段执行辅助：代码源分支 / 流水线运行记录 =====

/// 按 repoName 找 Codeup 仓库 id（执行弹窗的分支下拉用）。
/// 列表接口支持 search 过滤（实测精确命中），一次请求即可，无需全量翻页
#[tauri::command]
pub async fn yunxiao_codeup_repo_id(app: AppHandle, repo_name: String) -> Result<Option<i64>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let path = format!(
        "/oapi/v1/codeup/organizations/{}/repositories?page=1&pageSize=20&search={}",
        c.org_id,
        urlencode(&repo_name)
    );
    let batch: Vec<YxRepo> = oapi_get(&path, &token).await?;
    // search 是模糊匹配：优先名字完全一致的，否则取首条（label 末段与仓库名偶有出入）
    Ok(batch
        .iter()
        .find(|r| r.name == repo_name)
        .or_else(|| batch.first())
        .map(|r| r.id))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct YxRepoRef {
    pub name: String,
    /// branch | tag
    pub kind: String,
}

/// 仓库引用列表（分支 + 标签，执行弹窗「分支/标签」下拉用；
/// 接口固定每页 20 条，各自翻页取全，封顶 5 页）
#[tauri::command]
pub async fn yunxiao_repo_refs(app: AppHandle, repo_id: i64) -> Result<Vec<YxRepoRef>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let mut out: Vec<YxRepoRef> = Vec::new();
    for kind in ["branches", "tags"] {
        for p in 1..=5u32 {
            let path = format!(
                "/oapi/v1/codeup/organizations/{}/repositories/{repo_id}/{kind}?page={p}&pageSize=20",
                c.org_id
            );
            let v: Vec<serde_json::Value> = oapi_get(&path, &token).await?;
            let n = v.len();
            out.extend(
                v.iter()
                    .filter_map(|b| b["name"].as_str().map(str::to_string))
                    .filter(|s| !s.is_empty())
                    .map(|name| YxRepoRef {
                        name,
                        kind: kind.trim_end_matches('e').to_string(), // branches→branch, tags→tag
                    }),
            );
            if n < 20 {
                break;
            }
        }
    }
    Ok(out)
}

// ===== 仓库详情（代码库页的分支 / 提交 / 标签） =====

/// 分支/标签条目（带其指向提交的摘要；标签可能无 commit 字段，全默认）
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxRefItem {
    pub name: String,
    pub is_default: bool,
    pub is_protected: bool,
    pub short_id: String,
    pub title: String,
    pub author_name: String,
    pub committed_date: String,
    pub web_url: String,
}

fn ref_item(v: &serde_json::Value) -> YxRefItem {
    YxRefItem {
        name: v["name"].as_str().unwrap_or_default().to_string(),
        is_default: v["defaultBranch"].as_bool().unwrap_or(false),
        is_protected: v["protected"].as_bool().unwrap_or(false),
        short_id: v["commit"]["shortId"].as_str().unwrap_or_default().to_string(),
        title: v["commit"]["title"].as_str().unwrap_or_default().to_string(),
        author_name: v["commit"]["authorName"].as_str().unwrap_or_default().to_string(),
        committed_date: v["commit"]["committedDate"].as_str().unwrap_or_default().to_string(),
        web_url: v["webUrl"]
            .as_str()
            .or_else(|| v["commit"]["webUrl"].as_str())
            .unwrap_or_default()
            .to_string(),
    }
}

/// 仓库分支：全量翻页（接口按字母排序、每页 20，默认分支常在后面几页，单页会漏；
/// 排序与分页交给前端，封顶 10 页 = 200 条）
#[tauri::command]
pub async fn yunxiao_repo_branches(app: AppHandle, repo_id: i64) -> Result<Vec<YxRefItem>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let mut out = Vec::new();
    for p in 1..=10u32 {
        let path = format!(
            "/oapi/v1/codeup/organizations/{}/repositories/{repo_id}/branches?page={p}&pageSize=20",
            c.org_id
        );
        let v: Vec<serde_json::Value> = oapi_get(&path, &token).await?;
        let n = v.len();
        out.extend(v.iter().map(ref_item));
        if n < 20 {
            break;
        }
    }
    Ok(out)
}

/// 仓库标签：全量翻页（同上）
#[tauri::command]
pub async fn yunxiao_repo_tags(app: AppHandle, repo_id: i64) -> Result<Vec<YxRefItem>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let mut out = Vec::new();
    for p in 1..=10u32 {
        let path = format!(
            "/oapi/v1/codeup/organizations/{}/repositories/{repo_id}/tags?page={p}&pageSize=20",
            c.org_id
        );
        let v: Vec<serde_json::Value> = oapi_get(&path, &token).await?;
        let n = v.len();
        out.extend(v.iter().map(ref_item));
        if n < 20 {
            break;
        }
    }
    Ok(out)
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxCommit {
    pub short_id: String,
    pub title: String,
    pub author_name: String,
    pub authored_date: String,
    pub web_url: String,
    /// 父提交 id（图谱连线用）
    pub parent_ids: Vec<String>,
}

/// 仓库提交（按分支；单页 20 条）
#[tauri::command]
pub async fn yunxiao_repo_commits(
    app: AppHandle,
    repo_id: i64,
    ref_name: Option<String>,
    page: Option<u32>,
) -> Result<Vec<YxCommit>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let ref_name = ref_name.filter(|s| !s.is_empty()).unwrap_or_else(|| "master".into());
    let path = format!(
        "/oapi/v1/codeup/organizations/{}/repositories/{repo_id}/commits?refName={}&page={}&pageSize=20",
        c.org_id,
        urlencode(&ref_name),
        page.unwrap_or(1)
    );
    let v: Vec<serde_json::Value> = oapi_get(&path, &token).await?;
    Ok(v.iter()
        .map(|x| YxCommit {
            short_id: x["shortId"].as_str().unwrap_or_default().to_string(),
            title: x["title"].as_str().unwrap_or_default().trim().to_string(),
            author_name: x["authorName"].as_str().unwrap_or_default().to_string(),
            authored_date: x["authoredDate"].as_str().unwrap_or_default().to_string(),
            web_url: x["webUrl"].as_str().unwrap_or_default().to_string(),
            parent_ids: x["parentIds"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|p| p.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect())
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxPipelineRun {
    pub pipeline_run_id: i64,
    /// SUCCESS / FAILED / RUNNING / …
    pub status: String,
    pub start_time: i64,
    pub end_time: i64,
    pub trigger_mode: i64,
}

/// 流水线运行记录（阶段的历史运行；每页固定 10 条）
#[tauri::command]
pub async fn yunxiao_pipeline_runs(
    app: AppHandle,
    pipeline_id: i64,
    page: Option<u32>,
) -> Result<Vec<YxPipelineRun>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let p = page.unwrap_or(1);
    let v: Vec<serde_json::Value> = oapi_get(
        &format!(
            "/oapi/v1/flow/organizations/{}/pipelines/{pipeline_id}/runs?page={p}&pageSize=10",
            c.org_id
        ),
        &token,
    )
    .await?;
    Ok(v.iter()
        .map(|r| YxPipelineRun {
            pipeline_run_id: r["pipelineRunId"].as_i64().unwrap_or(0),
            status: r["status"].as_str().unwrap_or_default().to_string(),
            start_time: r["startTime"].as_i64().unwrap_or(0),
            end_time: r["endTime"].as_i64().unwrap_or(0),
            trigger_mode: r["triggerMode"].as_i64().unwrap_or(0),
        })
        .collect())
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxRunParam {
    pub key: String,
    pub value: String,
    pub masked: bool,
}

/// 一次运行使用的环境变量（run 详情的 globalParams；脱敏变量不下发明文，
/// 执行表单也以此为模板，masked 行不可编辑、不随执行提交，避免覆盖密钥）
#[tauri::command]
pub async fn yunxiao_pipeline_run_params(
    app: AppHandle,
    pipeline_id: i64,
    run_id: i64,
) -> Result<Vec<YxRunParam>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let v: serde_json::Value = oapi_get(
        &format!(
            "/oapi/v1/flow/organizations/{}/pipelines/{pipeline_id}/runs/{run_id}",
            c.org_id
        ),
        &token,
    )
    .await?;
    Ok(v["globalParams"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|p| {
                    let masked = p["masked"].as_bool().unwrap_or(false);
                    YxRunParam {
                        key: p["key"].as_str().unwrap_or_default().to_string(),
                        value: if masked {
                            String::new()
                        } else {
                            p["value"].as_str().unwrap_or_default().to_string()
                        },
                        masked,
                    }
                })
                .filter(|p| !p.key.is_empty())
                .collect()
        })
        .unwrap_or_default())
}

/// 触发云效 Webhook（流水线 Webhook 无需鉴权；token 只在内存转发，不落日志）。
/// 域名白名单防该命令被用作任意 URL 请求代理。
#[tauri::command]
pub async fn yunxiao_webhook_run(url: String) -> Result<(), AppError> {
    let url = url.trim();
    let allowed = url.starts_with("https://flow.aliyun.com/webhook/")
        || url.starts_with("https://devops.aliyun.com/");
    if !allowed {
        return Err(AppError::config("仅支持云效 Webhook 地址（flow.aliyun.com / devops.aliyun.com）"));
    }
    let rsp = http_client()
        .post(url)
        .json(&json!({}))
        .send()
        .await
        .map_err(|e| AppError::network(format!("Webhook 请求失败：{e}")))?;
    let status = rsp.status();
    if !status.is_success() {
        let body = rsp.text().await.unwrap_or_default();
        let msg: String = body.chars().take(200).collect();
        return Err(AppError::api(format!(
            "Webhook 触发失败（{}）：{msg}",
            status.as_u16()
        )));
    }
    Ok(())
}

/// 应用自定义 Webhook（本机 secrets.db；webhook 地址含触发 token，不入 config.json）。
/// 读取范围限定本条目，不开放通用密钥读取。
const APP_WEBHOOK_PREFIX: &str = "yunxiao-appstack-webhook:";

#[tauri::command]
pub async fn yunxiao_app_webhook_get(app_name: String) -> Result<String, AppError> {
    Ok(crate::secrets::get(&format!("{APP_WEBHOOK_PREFIX}{app_name}"))?.unwrap_or_default())
}

#[tauri::command]
pub async fn yunxiao_app_webhook_save(app_name: String, url: String) -> Result<(), AppError> {
    let key = format!("{APP_WEBHOOK_PREFIX}{app_name}");
    let url = url.trim();
    if url.is_empty() {
        crate::secrets::delete(&key)
    } else {
        crate::secrets::set(&key, url)
    }
}

/// 拉一页（None = 出错或空，探测时都按边界处理）
async fn flow_page(base: &str, name_q: &str, token: &str, page: i64) -> Option<Vec<YxPipeline>> {
    oapi_get::<Vec<YxPipeline>>(&format!("{base}?page={page}{name_q}"), token)
        .await
        .ok()
        .filter(|l| !l.is_empty())
}

/// 流水线总数：接口不返回 totalCount，用「指数上界 + 二分收缩」探测最后一页
/// （88 条 ≈ 8 次请求；名称过滤与列表接口一致）
#[tauri::command]
pub async fn yunxiao_pipeline_count(app: AppHandle, name: Option<String>) -> Result<i64, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let base = format!("/oapi/v1/flow/organizations/{}/pipelines", c.org_id);
    let name_q = name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|n| format!("&pipelineName={}", urlencode(n)))
        .unwrap_or_default();

    let first = flow_page(&base, &name_q, &token, 1).await;
    let Some(first) = first else {
        return Ok(0);
    };
    let (mut last_page, mut last_len) = (1i64, first.len() as i64);

    // 指数探测上界：2,4,8… 直到空页；超过 1024 页（万条级）按满页估并放弃精确
    let mut p = 2i64;
    let mut hi;
    loop {
        match flow_page(&base, &name_q, &token, p).await {
            Some(l) => {
                last_page = p;
                last_len = l.len() as i64;
                if p >= 1024 {
                    return Ok(p * 10);
                }
                p *= 2;
            }
            None => {
                hi = p;
                break;
            }
        }
    }
    // 二分收缩到真正的最后一页
    while hi - last_page > 1 {
        let mid = (hi + last_page) / 2;
        match flow_page(&base, &name_q, &token, mid).await {
            Some(l) => {
                last_page = mid;
                last_len = l.len() as i64;
            }
            None => hi = mid,
        }
    }
    Ok((last_page - 1) * 10 + last_len)
}

/// 单条流水线（收藏视图用；单查接口字段名是 id/name，归一化为列表结构）
#[tauri::command]
pub async fn yunxiao_pipeline_get(app: AppHandle, pipeline_id: i64) -> Result<YxPipeline, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawPipeline {
        id: i64,
        name: String,
        #[serde(default)]
        create_time: i64,
    }
    let d: RawPipeline = oapi_get(
        &format!("/oapi/v1/flow/organizations/{}/pipelines/{pipeline_id}", c.org_id),
        &token,
    )
    .await?;
    Ok(YxPipeline {
        pipeline_id: d.id,
        pipeline_name: d.name,
        create_time: d.create_time,
    })
}

/// 单条流水线详情（type=PIPELINEASCODE 即 YAML 型；pipelineConfig.flow 为 YAML 文本。
/// 公开 API 无保存接口（PUT 探测 404），应用内只读查看）
async fn pipeline_detail(token: &str, org_id: &str, pipeline_id: i64) -> Result<serde_json::Value, AppError> {
    oapi_get(
        &format!("/oapi/v1/flow/organizations/{org_id}/pipelines/{pipeline_id}"),
        token,
    )
    .await
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxPipelineYaml {
    pub is_yaml: bool,
    pub yaml: String,
}

#[tauri::command]
pub async fn yunxiao_pipeline_yaml(
    app: AppHandle,
    pipeline_id: i64,
) -> Result<YxPipelineYaml, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let d = pipeline_detail(&token, &c.org_id, pipeline_id).await?;
    let yaml = d
        .get("pipelineConfig")
        .and_then(|v| v.get("flow"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(YxPipelineYaml {
        is_yaml: d.get("type").and_then(|v| v.as_str()) == Some("PIPELINEASCODE"),
        yaml,
    })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct YxPipelineType {
    pub id: i64,
    pub is_yaml: bool,
}

/// 批量判型（列表接口不返回 type，前端按页批量单查并缓存；并发拉取）
#[tauri::command]
pub async fn yunxiao_pipeline_types(app: AppHandle, ids: Vec<i64>) -> Result<Vec<YxPipelineType>, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let futs = ids.into_iter().map(|id| {
        let token = token.clone();
        let org = c.org_id.clone();
        async move {
            let d = pipeline_detail(&token, &org, id).await?;
            Ok(YxPipelineType {
                id,
                is_yaml: d.get("type").and_then(|v| v.as_str()) == Some("PIPELINEASCODE"),
            })
        }
    });
    Ok(futures_util::future::join_all(futs)
        .await
        .into_iter()
        .filter_map(|r: Result<YxPipelineType, AppError>| r.ok())
        .collect())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxRunResult {
    pub run_id: String,
}

/// 触发流水线运行
#[tauri::command]
pub async fn yunxiao_pipeline_run(app: AppHandle, pipeline_id: i64) -> Result<YxRunResult, AppError> {
    let (token, c) = (pat()?, cfg(&app)?);
    let path = format!("/oapi/v1/flow/organizations/{}/pipelines/{pipeline_id}/runs", c.org_id);
    let rsp = http_client()
        .post(format!("{OAPI_BASE}{path}"))
        .header("x-yunxiao-token", &token)
        .json(&json!({}))
        .send()
        .await?;
    let rsp = check(rsp).await?;
    // 返回结构可能是 { runId } / { id } / 数字等，宽松取值
    let v: serde_json::Value = rsp.json().await.unwrap_or(serde_json::Value::Null);
    let run_id = v
        .get("runId")
        .or_else(|| v.get("id"))
        .and_then(|x| {
            x.as_str()
                .map(|s| s.to_string())
                .or_else(|| x.as_i64().map(|n| n.to_string()))
        })
        .unwrap_or_default();
    Ok(YxRunResult { run_id })
}

// ===== 工作台聚合 =====

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YxOverview {
    /// 我参与的项目（按项目成员表判定，含角色）
    pub my_projects: Vec<YxProject>,
    /// 我的工作项（进行中优先展示，按更新时间倒序，上限 20）
    pub my_workitems: Vec<YxWorkitem>,
    /// 我的报工记录（工作台统计卡用；月历走 yunxiao_my_efforts）
    pub my_efforts: Vec<YxEffort>,
}

/// effortRecords 原始结构（owner 为对象，映射为 ownerName；字段可能为 null）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawEffort {
    #[serde(default, deserialize_with = "null_to_default")]
    id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    actual_time: f64,
    #[serde(default, deserialize_with = "null_to_default")]
    work_type: String,
    #[serde(default, deserialize_with = "null_to_default")]
    description: String,
    #[serde(default, deserialize_with = "null_to_default")]
    owner: YxNamed,
    #[serde(default, deserialize_with = "null_to_default")]
    gmt_start: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    gmt_end: i64,
}

/// 拉取多个工作项的实际工时（只留 owner_id 属主的记录）并回填标题/空间名。
/// effortRecords 是逐工作项接口，月历要覆盖整月记录，改为 8 并发拉取（上限 80 项）。
/// 参数取所有权：引用跨 await 会与 tauri 命令宏产生 HRTB 冲突
async fn fetch_efforts(
    token: String,
    org_id: String,
    owner_id: String,
    items: Vec<YxWorkitem>,
) -> Vec<YxEffort> {
    use futures_util::StreamExt;
    let pairs = futures_util::stream::iter(items.into_iter().take(80))
        .map(|w| {
            let (wid, subject, space) = (w.id, w.subject, w.space.name);
            let token = token.clone();
            let path = format!("/oapi/v1/projex/organizations/{org_id}/workitems/{wid}/effortRecords");
            async move {
                // 单项失败（如无权限/已删除）跳过，不影响整体
                let list: Vec<RawEffort> = oapi_get(&path, &token).await.unwrap_or_default();
                (wid, subject, space, list)
            }
        })
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await;
    let mut out = Vec::new();
    for (wid, subject, space, list) in pairs {
        for r in list {
            // effortRecords 返回工作项上所有人的报工，聚合只取自己的
            if !owner_id.is_empty() && r.owner.identifier != owner_id {
                continue;
            }
            out.push(YxEffort {
                id: r.id,
                workitem_id: wid.clone(),
                subject: subject.clone(),
                actual_time: r.actual_time,
                work_type: r.work_type,
                description: r.description,
                owner_name: r.owner.label(),
                space_name: space.clone(),
                gmt_start: r.gmt_start,
                gmt_end: r.gmt_end,
            });
        }
    }
    // 最近报的在前
    out.sort_by(|a, b| b.gmt_start.cmp(&a.gmt_start));
    out
}

/// 终态判断：工作台/进行中视图要排除已完成与已关闭类；状态名中英文都兼容
fn is_terminal_status(w: &YxWorkitem) -> bool {
    let s = if w.status.display_name.is_empty() {
        &w.status.name
    } else {
        &w.status.display_name
    };
    let t = s.trim();
    matches!(t, "已完成" | "已关闭" | "已拒绝" | "已取消" | "已废弃")
        || matches!(
            t.to_ascii_lowercase().as_str(),
            "done" | "closed" | "rejected" | "canceled" | "cancelled"
        )
}

/// 跨项目空间聚合"我的工作项"（mine 过滤在 yunxiao_workitems 内做客户端筛选），
/// 按更新时间倒序、截断 cap。取所有权避免引用跨 await 与命令宏的 HRTB 冲突
async fn aggregate_my_workitems(
    app: AppHandle,
    mine_projects: Vec<YxProject>,
    cap: usize,
) -> Vec<YxWorkitem> {
    let futs = mine_projects.into_iter().map(|p| {
        let app = app.clone();
        async move { yunxiao_workitems(app, p.id, None, None, Some(true), Some(1)).await.ok() }
    });
    let results = futures_util::future::join_all(futs).await;
    let mut all: Vec<YxWorkitem> = Vec::new();
    for r in results {
        if let Some(page) = r {
            all.extend(page.items);
        }
    }
    all.sort_by(|a, b| b.gmt_modified.cmp(&a.gmt_modified));
    all.truncate(cap);
    all
}

/// 工作台：我的项目（成员表判定）→ 我的工作项（只留进行中）→ 报工统计
#[tauri::command]
pub async fn yunxiao_overview(app: AppHandle) -> Result<YxOverview, AppError> {
    let c = cfg(&app)?;
    let projects = yunxiao_projects(app.clone()).await?;
    let my_projects: Vec<YxProject> = projects
        .into_iter()
        .filter(|p| p.my_role.is_some())
        .collect();

    let all_my = aggregate_my_workitems(app.clone(), my_projects.clone(), 200).await;
    // 工作台只看进行中（排除已完成/已关闭等终态）
    let mut my: Vec<YxWorkitem> = all_my.iter().filter(|w| !is_terminal_status(w)).cloned().collect();
    my.truncate(20);

    let token = pat()?;
    let my_efforts = fetch_efforts(token, c.org_id.clone(), c.user_id.clone(), all_my).await;
    Ok(YxOverview {
        my_projects,
        my_workitems: my,
        my_efforts,
    })
}

/// 我的工作项全量（业务空间「我的项目」视图；跨我参与的空间聚合，上限 200）
#[tauri::command]
pub async fn yunxiao_my_workitems(app: AppHandle) -> Result<Vec<YxWorkitem>, AppError> {
    let projects = yunxiao_projects(app.clone()).await?;
    let mine: Vec<YxProject> = projects
        .into_iter()
        .filter(|p| p.my_role.is_some())
        .collect();
    Ok(aggregate_my_workitems(app, mine, 200).await)
}

/// 我的报工全量（报工月历；跨空间聚合我的工作项后逐项取工时）
#[tauri::command]
pub async fn yunxiao_my_efforts(app: AppHandle) -> Result<Vec<YxEffort>, AppError> {
    let c = cfg(&app)?;
    let projects = yunxiao_projects(app.clone()).await?;
    let mine: Vec<YxProject> = projects
        .into_iter()
        .filter(|p| p.my_role.is_some())
        .collect();
    let items = aggregate_my_workitems(app, mine, 200).await;
    let token = pat()?;
    Ok(fetch_efforts(token, c.org_id, c.user_id, items).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_label_prefers_display() {
        let mut n = YxNamed { identifier: "s1".into(), name: "进行中".into(), display_name: "设计中".into() };
        assert_eq!(n.label(), "设计中");
        n.display_name = String::new();
        assert_eq!(n.label(), "进行中");
    }

    /// 云效列表里 null 字段很常见（如无描述的任务）；整页数组不能因单个 null 解析失败。
    /// 人员/类型对象线上真实键是 id（assignedTo.id/workitemType.id），靠 alias 映射进 identifier
    #[test]
    fn workitem_tolerates_null_fields() {
        let raw = r#"[{
            "id": "w1",
            "serialNumber": null,
            "subject": "修登录",
            "gmtCreate": 1700000000000,
            "gmtModified": null,
            "status": null,
            "assignedTo": {"id": "u1", "name": "张三", "displayName": null},
            "creator": null,
            "space": null,
            "description": null,
            "formatType": null,
            "workitemType": {"id": "t1", "name": "常规需求"}
        }]"#;
        let list: Vec<YxWorkitem> = serde_json::from_str(raw).expect("null 字段不应导致解析失败");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].subject, "修登录");
        assert_eq!(list[0].description, "");
        assert_eq!(list[0].gmt_modified, 0);
        // 关键契约：assignedTo.id 反序列化进 identifier——"只看我的"过滤依赖它匹配 user_id
        assert_eq!(list[0].assigned_to.identifier, "u1");
        assert_eq!(list[0].assigned_to.display_name, "");
        assert_eq!(list[0].workitem_type.name, "常规需求");
        // 序列化到前端仍发 identifier 键（前端 YxNamed 读 identifier）
        let out = serde_json::to_value(&list[0]).unwrap();
        assert_eq!(out["assignedTo"]["identifier"], "u1");
        assert_eq!(out["workitemType"]["name"], "常规需求");
    }

    /// 成员接口字段可能为 null（如未设置角色）；不能因单个 null 导致整页解析失败
    #[test]
    fn member_tolerates_null_fields() {
        let raw = r#"[{
            "userName": "张三",
            "userAvatar": "https://tcs-devops.aliyuncs.com/thumbnail/xx/w/100/h/100",
            "roleName": "开发",
            "userId": "u1",
            "roleId": "project.admin"
        },{
            "userName": null,
            "userAvatar": null,
            "roleName": null,
            "userId": "u2",
            "roleId": null
        }]"#;
        let list: Vec<RawMember> = serde_json::from_str(raw).expect("null 字段不应导致解析失败");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].user_id, "u1");
        assert_eq!(list[0].role_name, "开发");
        assert_eq!(list[1].user_id, "u2");
        assert_eq!(list[1].role_name, "");
    }

    /// projects:search 响应不含 myRole；序列化到前端时 None 不发字段、Some 发 camelCase 键
    #[test]
    fn project_my_role_serde_roundtrip() {
        let raw = r#"[{"id":"p1","name":"示例引擎","customCode":null,"description":null,"gmtCreate":1700000000000}]"#;
        let list: Vec<YxProject> = serde_json::from_str(raw).unwrap();
        assert!(list[0].my_role.is_none());

        let mine = YxProject { my_role: Some("开发".into()), ..list[0].clone() };
        let out = serde_json::to_value(&mine).unwrap();
        assert_eq!(out["myRole"], "开发");
        assert!(serde_json::to_value(&list[0]).unwrap().get("myRole").is_none());
    }

    /// 工作台"进行中"过滤：终态（中英文）排除、其余保留
    #[test]
    fn terminal_status_filter() {
        let mk = |name: &str| YxWorkitem {
            status: YxNamed { name: name.into(), ..Default::default() },
            ..Default::default()
        };
        for done in ["已完成", "已关闭", "已拒绝", "已取消", "已废弃", "Done", "CLOSED"] {
            assert!(is_terminal_status(&mk(done)), "{done} 应为终态");
        }
        for active in ["进行中", "测试中", "设计中", "待处理", ""] {
            assert!(!is_terminal_status(&mk(active)), "{active} 不应判终态");
        }
        // displayName 优先于 name
        let w = YxWorkitem {
            status: YxNamed { name: "已完成".into(), display_name: "测试中".into(), ..Default::default() },
            ..Default::default()
        };
        assert!(!is_terminal_status(&w));
    }

    /// effortRecords 的 owner 对象线上键也是 id（实测 {"name":"王昊","id":"..."}），
    /// YxNamed alias 兼容 id/identifier 两种键——报工属主过滤依赖它
    #[test]
    fn effort_owner_id_key() {
        let raw = r#"[{
            "id": "e1",
            "actualTime": 8,
            "workType": "研发",
            "description": "开发",
            "owner": {"name": "王昊", "id": "u1"},
            "gmtStart": 1700000000000,
            "gmtEnd": 1700003600000
        }]"#;
        let list: Vec<RawEffort> = serde_json::from_str(raw).unwrap();
        assert_eq!(list[0].owner.identifier, "u1");
        assert_eq!(list[0].owner.label(), "王昊");
    }
}
