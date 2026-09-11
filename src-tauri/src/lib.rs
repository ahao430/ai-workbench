mod app_tasks;
mod agent;
mod cli;
mod error;
mod http;
mod image;
mod kb;
mod llm;
mod mcp;
mod notes;
mod quota;
mod secrets;
mod service;
mod skills;
mod store;
mod webdav;
mod tray;
mod updater;
mod yuque;
mod yunxiao;

use serde::Serialize;

/// 应用基础信息（设置页展示，兼作 IPC 链路验证）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

/// 通用文件导出：base64 内容写入 ~/Downloads/{filename}，并在文件管理器中显示。
/// 供语雀/笔记等 markdown 下载与 PDF 导出使用（webview 内 a[download] 不可靠）。
#[tauri::command]
fn export_save_file(app: tauri::AppHandle, filename: String, content_b64: String) -> Result<String, crate::error::AppError> {
    use tauri::Manager as _;
    use tauri_plugin_opener::OpenerExt as _;
    let bytes = crate::secrets::b64_decode(&content_b64)?;
    // 文件名安全化：去路径分隔符与空白
    let safe: String = filename
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '(' | ')' | '（' | '）') { c } else { '_' })
        .collect();
    let safe = safe.trim().trim_start_matches('.').to_string();
    if safe.is_empty() {
        return Err(crate::error::AppError::config("文件名不能为空"));
    }
    let dir = app
        .path()
        .home_dir()
        .map_err(|e| crate::error::AppError::internal(format!("无法定位用户目录：{e}")))?
        .join("Downloads");
    std::fs::create_dir_all(&dir).map_err(|e| crate::error::AppError::internal(format!("创建下载目录失败：{e}")))?;
    // 同名冲突自动加序号
    let stem = safe.trim_end_matches(".pdf").trim_end_matches(".md").to_string();
    let ext = if safe.ends_with(".pdf") { "pdf" } else if safe.ends_with(".md") { "md" } else { "txt" };
    let mut path = dir.join(&safe);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    std::fs::write(&path, &bytes).map_err(|e| crate::error::AppError::internal(format!("写入文件失败：{e}")))?;
    let shown = path.to_string_lossy().to_string();
    let _ = app.opener().reveal_item_in_dir(&shown);
    Ok(shown)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            use tauri::Manager as _;
            // 托盘面板失焦自动收起（点击面板外/点回主窗口都触发）
            if let tauri::WindowEvent::Focused(false) = event {
                crate::tray::on_panel_blur(window);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // close-to-tray 只属于主窗口；链接窗口等子窗口必须真正关闭销毁，
                // 否则被隐藏后仍"存活"，复用逻辑聚焦一个隐藏窗口 → 关闭后再也打不开
                if window.label() == "main" {
                    let cfg = store::load_config(window.app_handle());
                    if cfg.close_to_tray.unwrap_or(true) {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
            }
        })
        .setup(|app| {
            secrets::init(app.handle());
            // 托盘项由 quota refresher 按配置动态创建/维护
            tray::spawn_quota_refresher(app.handle().clone());
            // macOS 应用菜单（点应用名下拉）注入版本号 + 检测升级
            tray::setup_app_menu(app.handle())?;
            app.on_menu_event(|app, ev| {
                if ev.id.as_ref() == "app-check-update" {
                    tray::handle_check_update(app);
                }
            });
            tauri::async_runtime::spawn(app_tasks::scheduler_loop(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            export_save_file,
            app_tasks::settings_get_flags,
            app_tasks::settings_set_autostart,
            app_tasks::setup_get_done,
            app_tasks::setup_set_done,
            app_tasks::settings_set_close_to_tray,
            app_tasks::tasks_list,
            app_tasks::tasks_save,
            cli::cli_detect,
            cli::cli_resolve_credential,
            cli::cli_preview,
            cli::cli_apply,
            cli::cli_current_status,
            cli::cli_check_updates,
            cli::cli_upgrade_tool,
            cli::cli_models,
            cli::ccswitch_db_path,
            llm::llm_chat,
            llm::llm_cancel,
            llm::llm_complete,
            llm::llm_models,
            agent::agent_detect,
            agent::agent_base_dir,
            agent::agent_set_base_dir,
            agent::agent_create_dir,
            agent::agent_run,
            agent::agent_stop,
            agent::agent_stdin_write,
            image::image_generate,
            image::image_edit,
            image::image_save_export,
            image::draw_save_ref,
            secrets::secret_put,
            secrets::secret_remove,
            skills::skill_list,
            skills::skill_targets,
            skills::skill_install_git,
            skills::skill_install_local,
            skills::skill_remove,
            skills::skill_sync,
            skills::skill_detail,
            skills::skill_read_file,
            skills::skill_reveal,
            skills::skill_scan_local,
            skills::skill_import_from,
            skills::skill_sources,
            skills::skill_repo_browse,
            skills::skill_repo_install,
            mcp::mcp_list,
            mcp::mcp_save,
            mcp::mcp_remove,
            mcp::mcp_set_targets,
            mcp::mcp_scan_local,
            mcp::mcp_market_search,
            mcp::mcp_market_install,
            mcp::mcp_builtins,
            mcp::mcp_install_builtin,
            kb::kb_get_config,
            kb::kb_save_api,
            kb::kb_remove_api,
            kb::kb_set_entries,
            kb::kb_fetch_list,
            kb::kb_test_api,
            kb::kb_search,
            updater::updater_get_status,
            updater::updater_set_endpoint,
            updater::updater_check,
            updater::update_check_github,
            updater::updater_download_install,
            webdav::webdav_get_config,
            webdav::webdav_save_config,
            webdav::webdav_test,
            webdav::webdav_upload,
            webdav::webdav_restore,
            notes::note_get_dir,
            notes::note_tree,
            notes::note_create_group,
            notes::note_move,
            notes::note_set_dir,
            notes::note_reset_dir,
            notes::note_list,
            notes::note_read,
            notes::note_write,
            notes::note_create,
            notes::note_rename,
            notes::note_delete,
            quota::quota_check,
            yunxiao::yunxiao_status,
            yunxiao::yunxiao_verify,
            yunxiao::yunxiao_save,
            yunxiao::yunxiao_disconnect,
            yunxiao::yunxiao_projects,
            yunxiao::yunxiao_workitems,
            yunxiao::yunxiao_repos,
            yunxiao::yunxiao_merge_requests,
            yunxiao::yunxiao_pipelines,
            yunxiao::yunxiao_pipeline_get,
            yunxiao::yunxiao_pipeline_yaml,
            yunxiao::yunxiao_pipeline_count,
            yunxiao::yunxiao_apps,
            yunxiao::yunxiao_app_envs,
            yunxiao::yunxiao_app_workflows,
            yunxiao::yunxiao_app_stage_execute,
            yunxiao::yunxiao_codeup_repo_id,
            yunxiao::yunxiao_repo_refs,
            yunxiao::yunxiao_repo_branches,
            yunxiao::yunxiao_repo_tags,
            yunxiao::yunxiao_repo_commits,
            yunxiao::yunxiao_pipeline_runs,
            yunxiao::yunxiao_pipeline_run_params,
            yunxiao::yunxiao_webhook_run,
            yunxiao::yunxiao_app_webhook_get,
            yunxiao::yunxiao_app_webhook_save,
            yunxiao::yunxiao_pipeline_types,
            yunxiao::yunxiao_pipeline_run,
            yunxiao::yunxiao_overview,
            yunxiao::yunxiao_my_workitems,
            yunxiao::yunxiao_my_efforts,
            yuque::yuque_status,
            yuque::yuque_login,
            yuque::yuque_web_login_check,
            yuque::yuque_verify,
            yuque::yuque_spaces,
            yuque::yuque_spaces_stored,
            yuque::yuque_save,
            yuque::yuque_update_spaces,
            yuque::yuque_disconnect,
            yuque::yuque_remove,
            yuque::yuque_docs,
            yuque::yuque_doc,
            yuque::yuque_search,
            yuque::yuque_cache_image,
            tray::tray_refresh
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
