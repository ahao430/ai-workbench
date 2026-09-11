//! 通用设置（自启动 / 关闭最小化到托盘）与定时任务调度。
//!
//! 调度器每 30s 扫描一次配置中的任务：
//! - schedule = "daily"：每天 time("HH:MM") 触发
//! - schedule = "weekly:1,3,5"：指定周几的 time 触发（1=周一）
//! - schedule = "interval:N"：每 N 分钟触发
//! 动作：webhook（POST param 地址）/ notify（系统通知，param=内容）/ open_url（param=地址）
//! （webdav_backup 为已下线的遗留动作，仅兼容旧配置）；WebDAV 自动备份改由
//! webdav 配置里的 auto_sync 开关驱动，不走任务列表。
//! 触发后写回 last_run_at，避免重复触发。

use serde::Serialize;
use tauri::AppHandle;

use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;

use crate::error::AppError;
use crate::store::{load_config, now_nanos, save_config, ScheduledTask};

/// 自动备份失败后的最小重试间隔（秒）：断网时不因 last_upload_at 停滞而每 30s 重打
const AUTO_SYNC_RETRY_SECS: i64 = 600;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppFlags {
    pub autostart: bool,
    pub close_to_tray: bool,
}

fn close_to_tray_default(cfg: &crate::store::AppConfig) -> bool {
    cfg.close_to_tray.unwrap_or(true)
}

/// 首次启动初始化向导是否已完成（未完成时前端重定向到 /setup）
#[tauri::command]
pub async fn setup_get_done(app: AppHandle) -> Result<bool, AppError> {
    Ok(load_config(&app).setup_done.unwrap_or(false))
}

/// 标记向导完成（含用户主动跳过）
#[tauri::command]
pub async fn setup_set_done(app: AppHandle, done: bool) -> Result<(), AppError> {
    let mut cfg = load_config(&app);
    cfg.setup_done = Some(done);
    save_config(&app, &cfg)
}

#[tauri::command]
pub async fn settings_get_flags(app: AppHandle) -> Result<AppFlags, AppError> {
    let cfg = load_config(&app);
    let autostart = app
        .autolaunch()
        .is_enabled()
        .map_err(|e| AppError::internal(format!("读取自启动状态失败：{e}")))?;
    Ok(AppFlags {
        autostart,
        close_to_tray: close_to_tray_default(&cfg),
    })
}

#[tauri::command]
pub async fn settings_set_autostart(app: AppHandle, enabled: bool) -> Result<(), AppError> {
    let launcher = app.autolaunch();
    let r = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    r.map_err(|e| AppError::internal(format!("设置自启动失败：{e}")))
}

#[tauri::command]
pub async fn settings_set_close_to_tray(app: AppHandle, enabled: bool) -> Result<(), AppError> {
    let mut cfg = load_config(&app);
    cfg.close_to_tray = Some(enabled);
    save_config(&app, &cfg)
}

// ===== 定时任务 =====

#[tauri::command]
pub async fn tasks_list(app: AppHandle) -> Result<Vec<ScheduledTask>, AppError> {
    Ok(load_config(&app).scheduled_tasks)
}

/// 整表保存（前端编辑后提交全量列表）
#[tauri::command]
pub async fn tasks_save(app: AppHandle, tasks: Vec<ScheduledTask>) -> Result<(), AppError> {
    for t in &tasks {
        validate_task(t)?;
    }
    let mut cfg = load_config(&app);
    cfg.scheduled_tasks = tasks;
    save_config(&app, &cfg)
}

/// 单条任务的调度与动作校验（webdav_backup 是已下线的遗留值，仍放行以便编辑/删除）
fn validate_task(t: &ScheduledTask) -> Result<(), AppError> {
    let name = t.name.trim();
    if name.is_empty() || name.len() > 60 {
        return Err(AppError::config("任务名不能为空且不超过 60 字符"));
    }
    match t.schedule.as_str() {
        s if s.starts_with("weekly:") => {
            for d in s["weekly:".len()..].split(',') {
                let d = d.trim();
                if d.is_empty() {
                    continue;
                }
                d.parse::<u8>()
                    .ok()
                    .filter(|w| (1..=7).contains(w))
                    .ok_or_else(|| AppError::config("每周几需为 1-7"))?;
            }
            validate_time(&t.time)?;
        }
        "daily" => validate_time(&t.time)?,
        s if s.starts_with("interval:") => {
            let n: u32 = s["interval:".len()..]
                .trim()
                .parse()
                .map_err(|_| AppError::config("间隔分钟需为数字"))?;
            if !(1..=10080).contains(&n) {
                return Err(AppError::config("间隔需在 1-10080 分钟"));
            }
        }
        _ => return Err(AppError::config("调度类型无效")),
    }
    match t.kind.as_str() {
        "webdav_backup" => {}
        "notify" if !t.param.trim().is_empty() => {}
        "webhook" | "open_url" if t.param.trim().starts_with("http") => {}
        _ => return Err(AppError::config("任务参数无效（通知需内容，链接/Webhook 需 http 地址）")),
    }
    Ok(())
}

fn validate_time(t: &str) -> Result<(), AppError> {
    let (h, m) = t
        .split_once(':')
        .ok_or_else(|| AppError::config("时间格式应为 HH:MM"))?;
    let h: u32 = h.trim().parse().map_err(|_| AppError::config("时间格式应为 HH:MM"))?;
    let m: u32 = m.trim().parse().map_err(|_| AppError::config("时间格式应为 HH:MM"))?;
    if h > 23 || m > 59 {
        return Err(AppError::config("时间超出范围"));
    }
    Ok(())
}

/// 调度判定与执行（lib.rs setup 启动的后台循环调用）
pub async fn scheduler_loop(app: AppHandle) {
    // 上次自动备份尝试时刻（秒）：失败也前移，避免断网期间每 30s 重打 WebDAV
    let mut last_auto_attempt: i64 = 0;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let _ = run_due_tasks(&app).await;
        last_auto_attempt = run_auto_sync(&app, last_auto_attempt).await;
    }
}

/// 到点判定：从未上传过视为到点；last_upload_ms（毫秒）距 now_ms 超过间隔（分钟）即到点
fn auto_sync_due(last_upload_ms: Option<i64>, interval_minutes: i64, now_ms: i64) -> bool {
    last_upload_ms
        .map(|l| now_ms - l >= interval_minutes * 60 * 1000)
        .unwrap_or(true)
}

/// WebDAV 自动备份：设置里开启后按间隔自动上传。与手动上传共用 last_upload_at
/// 锚点（手动传过就按手动时间顺延）。返回本次尝试时刻用于限流。
async fn run_auto_sync(app: &AppHandle, last_attempt: i64) -> i64 {
    let now = now_unix();
    if now - last_attempt < AUTO_SYNC_RETRY_SECS {
        return last_attempt;
    }
    let (enabled, interval_minutes, last_upload_ms) = {
        let cfg = load_config(app);
        match cfg.webdav {
            Some(w) => (w.auto_sync.unwrap_or(false), w.auto_sync_minutes.unwrap_or(1440) as i64, w.last_upload_at),
            None => return last_attempt,
        }
    };
    if !enabled {
        return last_attempt;
    }
    if !auto_sync_due(last_upload_ms, interval_minutes, now * 1000) {
        return last_attempt;
    }
    // 失败也按本次尝试计时（下轮 10 分钟后再试），错误不打断调度循环
    let _ = crate::webdav::webdav_upload(app.clone()).await;
    now
}

async fn run_due_tasks(app: &AppHandle) -> Result<(), AppError> {
    let now = now_unix();
    let due: Vec<ScheduledTask> = {
        let cfg = load_config(app);
        cfg.scheduled_tasks
            .iter()
            .filter(|t| t.enabled && is_due(t, now))
            .cloned()
            .collect()
    };
    for mut t in due {
        match execute(app, &t).await {
            Ok(()) => {
                t.last_run_at = Some(now);
            }
            Err(_) => {
                // 失败也记录时间，避免每 30s 重试轰炸
                t.last_run_at = Some(now);
            }
        }
        let mut cfg = load_config(app);
        if let Some(slot) = cfg.scheduled_tasks.iter_mut().find(|x| x.id == t.id) {
            slot.last_run_at = t.last_run_at;
        }
        save_config(app, &cfg)?;
    }
    Ok(())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 是否到达触发时间
fn is_due(t: &ScheduledTask, now: i64) -> bool {
    use time::OffsetDateTime;
    let Ok(local) = OffsetDateTime::now_local() else { return false };
    if let Some(rest) = t.schedule.strip_prefix("interval:") {
        let Ok(minutes) = rest.trim().parse::<i64>() else { return false };
        return t.last_run_at.map(|l| now - l >= minutes * 60).unwrap_or(true);
    }
    let Some((h, m)) = parse_hm(&t.time) else { return false };
    let today_at = local
        .replace_time(time::Time::from_hms(h, m, 0).unwrap_or(time::Time::MIDNIGHT))
        .unix_timestamp();
    if now < today_at {
        return false;
    }
    if let Some(l) = t.last_run_at {
        if l >= today_at {
            return false;
        }
    }
    if let Some(spec) = t.schedule.strip_prefix("weekly:") {
        // time crate: weekday().number_from_monday() 1..=7
        let today = local.weekday().number_from_monday();
        return spec.split(',').filter_map(|d| d.trim().parse::<u8>().ok()).any(|d| d == today);
    }
    t.schedule == "daily"
}

fn parse_hm(t: &str) -> Option<(u8, u8)> {
    let (h, m) = t.split_once(':')?;
    Some((h.trim().parse().ok()?, m.trim().parse().ok()?))
}

async fn execute(app: &AppHandle, t: &ScheduledTask) -> Result<(), AppError> {
    match t.kind.as_str() {
        // 遗留动作：仅旧配置可能出现，明确报一次而不是静默跳过
        "webdav_backup" => Err(AppError::config("WebDAV 备份动作已下线，请编辑该任务改用其他动作")),
        "notify" => {
            app.notification()
                .builder()
                .title(format!("定时任务 · {}", t.name))
                .body(t.param.trim())
                .show()
                .map_err(|e| AppError::internal(format!("通知失败：{e}")))
        }
        "webhook" => {
            // POST 当前任务信息（JSON）；http_client 自带 30s 超时，不会挂死调度循环
            let body = serde_json::json!({
                "event": "scheduled_task",
                "taskId": t.id,
                "task": t.name.trim(),
            });
            let resp = crate::http::http_client()
                .post(t.param.trim())
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .map_err(|e| AppError::network(format!("Webhook 请求失败：{e}")))?;
            let status = resp.status();
            if !status.is_success() {
                return Err(AppError::api(format!("Webhook 返回 HTTP {status}")));
            }
            Ok(())
        }
        "open_url" => {
            #[cfg(desktop)]
            {
                tauri_plugin_opener::open_url(t.param.trim(), None::<&str>)
                    .map_err(|e| AppError::internal(format!("打开链接失败：{e}")))
            }
            #[cfg(not(desktop))]
            {
                Ok(())
            }
        }
        _ => Err(AppError::config("未知任务类型")),
    }
}

/// 供测试：生成一个默认任务 id
#[allow(dead_code)]
pub fn new_task_id() -> String {
    format!("task-{}", now_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(kind: &str, param: &str) -> ScheduledTask {
        ScheduledTask {
            id: "t1".into(),
            name: "测试任务".into(),
            kind: kind.into(),
            param: param.into(),
            schedule: "daily".into(),
            time: "09:00".into(),
            enabled: true,
            last_run_at: None,
        }
    }

    #[test]
    fn validate_task_kinds() {
        assert!(validate_task(&task("notify", "该写周报了")).is_ok());
        assert!(validate_task(&task("notify", "  ")).is_err());
        assert!(validate_task(&task("open_url", "https://a.b/c")).is_ok());
        assert!(validate_task(&task("open_url", "ftp://x")).is_err());
        assert!(validate_task(&task("webhook", "https://hooks.example/xyz")).is_ok());
        assert!(validate_task(&task("webhook", "notaurl")).is_err());
        assert!(validate_task(&task("unknown", "x")).is_err());
        // 遗留动作仍放行（用户可编辑/删除旧任务），执行时提示已下线
        assert!(validate_task(&task("webdav_backup", "")).is_ok());
    }

    #[test]
    fn auto_sync_due_checks_interval_in_millis() {
        let hour_ago = |secs: i64| Some((1_799_000_000 - secs) * 1000);
        let now_ms = 1_799_000_000_000;
        // 从未上传过：到点
        assert!(auto_sync_due(None, 1440, now_ms));
        // 刚传过 10 分钟，间隔 1 小时：未到
        assert!(!auto_sync_due(hour_ago(600), 60, now_ms));
        // 传过 2 小时，间隔 1 小时：到点
        assert!(auto_sync_due(hour_ago(7200), 60, now_ms));
        // 恰好等于间隔：到点
        assert!(auto_sync_due(hour_ago(3600), 60, now_ms));
    }
}
