use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::AppError;

/// WebKnorv 知识库（REST 检索适配器）单连接配置；仅用于旧版配置反序列化，
/// 加载时迁移为 kb_apis 中的一条
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KbConfig {
    pub base_url: String,
    /// 检索接口路径，默认 /api/search
    pub search_path: String,
    /// 钥匙串条目名（可空 = 匿名）
    pub token_ref: Option<String>,
}

/// 外接知识 API 连接：一个服务地址 + 凭证，可挂载多个知识库。
/// 协议对齐 agent-platform packages/knowledge：
/// weknora（腾讯 WeKnora v0.7+，X-API-Key）| dify（Knowledge API，Bearer）| external-api（Dify 外部知识库协议，Bearer）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KbApiConfig {
    pub id: String,
    pub name: String,
    pub provider: String,
    /// 服务基址（weknora 不带 /api/v1，dify 自动补 /v1；external-api 填完整检索端点）
    pub base_url: String,
    /// 相似度阈值（None = 默认 0.5；0 = 关闭过滤）
    pub score_threshold: Option<f64>,
    /// 钥匙串条目名（可空 = 匿名）
    pub token_ref: Option<String>,
}

/// 挂载在某个连接下的知识库
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KbEntry {
    /// 稳定唯一 id（选择器/会话引用用；按 api_id+key 幂等保留）
    pub id: String,
    pub api_id: String,
    /// 知识库标识（传给检索/列表接口）
    pub key: String,
    pub name: String,
    pub enabled: bool,
}

/// WebDAV 同步配置；密码存 secrets.db（条目 "webdav"），不进前端。
/// 同步范围 = config.json + workbench.db（不含密钥库 secrets.db 与笔记文件）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WebDavConfig {
    /// 服务地址，默认坚果云 https://dav.jianguoyun.com/dav/
    pub url: String,
    pub username: String,
    /// 远端目录名（自动创建），默认 ai-workbench-sync
    pub dir: String,
    pub last_upload_at: Option<i64>,
    pub last_download_at: Option<i64>,
    /// 到点自动上传备份（与手动上传共用 last_upload_at 做时间锚点）
    pub auto_sync: Option<bool>,
    /// 自动备份间隔（分钟，默认 1440 = 每天）
    pub auto_sync_minutes: Option<u32>,
}

/// 定时任务：schedule = "daily" | "weekly:1,3,5"（1=周一）| "interval:N"（N 分钟）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    /// webhook | notify | open_url（webdav_backup 为已下线的遗留值，仅兼容旧配置）
    pub kind: String,
    /// notify 的内容 / open_url、webhook 的地址
    pub param: String,
    pub schedule: String,
    /// daily/weekly 的触发时刻 "HH:MM"
    pub time: String,
    pub enabled: bool,
    pub last_run_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// 旧版单连接配置，仅迁移用，迁移后清空
    pub kb: Option<KbConfig>,
    pub kb_apis: Vec<KbApiConfig>,
    pub kb_entries: Vec<KbEntry>,
    pub webdav: Option<WebDavConfig>,
    /// MCP 服务器中央注册表（分发到各 CLI 的原生配置）
    pub mcps: Vec<crate::mcp::McpEntry>,
    /// 自动更新源（latest.json 地址；None = 未配置）
    pub updater_endpoint: Option<String>,
    /// 关闭窗口时最小化到托盘（默认开）
    pub close_to_tray: Option<bool>,
    /// 定时任务
    pub scheduled_tasks: Vec<ScheduledTask>,
    /// 笔记根目录（None = appdata/notes）
    pub notes_dir: Option<String>,
    /// 云效（阿里云 DevOps）接入配置
    pub yunxiao: Option<crate::yunxiao::YunxiaoConfig>,
    /// 语雀接入配置
    pub yuque: Option<crate::yuque::YuqueConfig>,
    /// 首次启动初始化向导已完成
    pub setup_done: Option<bool>,
    /// Agent 公共项目根目录（None = ~/AI工作台/agent）
    pub agent_base_dir: Option<String>,
}

/// 旧版单连接 → 多 API 结构迁移 + 条目 id 补齐；返回是否发生了变化
fn migrate_kb(cfg: &mut AppConfig) -> bool {
    let mut changed = false;
    if cfg.kb_apis.is_empty() {
        if let Some(old) = cfg.kb.take() {
            changed = true;
            if !old.base_url.trim().is_empty() {
                cfg.kb_apis.push(KbApiConfig {
                    id: format!("kb-{}", now_nanos()),
                    name: "默认连接".into(),
                    provider: "weknora".into(),
                    base_url: old.base_url,
                    score_threshold: None,
                    token_ref: old.token_ref,
                });
            }
        }
    }
    // 早期版本条目没有 id：补齐（空 id 或重复 id 都重新生成）
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for e in cfg.kb_entries.iter_mut() {
        if e.id.trim().is_empty() || seen.contains(&e.id) {
            e.id = format!("ke-{}", now_nanos());
            changed = true;
        }
        seen.insert(e.id.clone());
    }
    changed
}

pub(crate) fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// 应用级配置持久化：app_config_dir/config.json（小体量、Rust 侧专属；
/// 聊天/供应商等业务数据后续走 sqlite）
fn config_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("config.json"))
        .map_err(|e| AppError::internal(format!("无法获取配置目录：{e}")))
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    let Ok(path) = config_path(app) else {
        return AppConfig::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return AppConfig::default();
    };
    let mut cfg: AppConfig = serde_json::from_str(&text).unwrap_or_default();
    if migrate_kb(&mut cfg) {
        let _ = save_config(app, &cfg);
    }
    cfg
}

pub fn save_config(app: &AppHandle, cfg: &AppConfig) -> Result<(), AppError> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| AppError::internal(format!("创建配置目录失败：{e}")))?;
    }
    let text =
        serde_json::to_string_pretty(cfg).map_err(|e| AppError::internal(format!("配置序列化失败：{e}")))?;
    fs::write(&path, text).map_err(|e| AppError::internal(format!("配置写入失败：{e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_kb_config_migrates_to_api_list() {
        let mut cfg = AppConfig {
            kb: Some(KbConfig {
                base_url: "https://wk.example.com".into(),
                search_path: "".into(),
                token_ref: Some("kb-1".into()),
            }),
            ..Default::default()
        };
        assert!(migrate_kb(&mut cfg));
        assert!(cfg.kb.is_none());
        assert_eq!(cfg.kb_apis.len(), 1);
        let api = &cfg.kb_apis[0];
        assert_eq!(api.base_url, "https://wk.example.com");
        assert_eq!(api.provider, "weknora");
        assert_eq!(api.score_threshold, None);
        assert_eq!(api.token_ref.as_deref(), Some("kb-1"));
        // 空旧配置迁移为空列表（断开状态）
        let mut cfg2 = AppConfig { kb: Some(KbConfig::default()), ..Default::default() };
        assert!(migrate_kb(&mut cfg2));
        assert!(cfg2.kb_apis.is_empty());
        // 已是多 API 结构则不动
        let mut cfg3 = AppConfig { kb_apis: vec![KbApiConfig::default()], ..Default::default() };
        assert!(!migrate_kb(&mut cfg3));
    }

    /// 跨 IPC 字段命名锁定：前端读 camelCase（教训：YqDoc 曾因 rename 发出 snake 键）
    #[test]
    fn webdav_and_task_fields_serialize_camel_case() {
        let w = WebDavConfig { auto_sync: Some(true), auto_sync_minutes: Some(60), ..Default::default() };
        let json = serde_json::to_value(&w).unwrap();
        assert!(json.get("autoSync").is_some());
        assert!(json.get("autoSyncMinutes").is_some());
        let back: WebDavConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.auto_sync, Some(true));
        assert_eq!(back.auto_sync_minutes, Some(60));

        let t = ScheduledTask { kind: "webhook".into(), param: "https://a.b".into(), ..Default::default() };
        let json = serde_json::to_value(&t).unwrap();
        assert!(json.get("lastRunAt").is_some());
        // 旧配置无新字段（webdav_backup 遗留值）也能反序列化
        let legacy: ScheduledTask =
            serde_json::from_str(r#"{"id":"1","name":"n","kind":"webdav_backup","param":"","schedule":"daily","time":"09:00","enabled":true}"#)
                .unwrap();
        assert_eq!(legacy.kind, "webdav_backup");
    }
}
