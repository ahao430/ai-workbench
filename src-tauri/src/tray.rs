//! 系统托盘（类 codex bar）：单个托盘项。文字整体栅格化为一张图——
//! [智谱 84% 4h40m · DS ¥7.3]，
//! macOS 用模板图（纯黑 + 透明度）渲染，系统栏自动跟随壁纸明暗显示黑/白
//! （主题猜测不可靠：菜单栏颜色取决于壁纸而非应用主题）；左键弹出富面板，右键快捷菜单。
//! 数据源：providers 表 show_on_tray=1 的供应商额度（复用 quota.rs）。
//! show_on_tray 只影响系统栏展示；弹窗面板展示全部启用中的供应商。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use ab_glyph::{point, FontVec, PxScale, PxScaleFont, ScaleFont};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};


const QUOTA_REFRESH: Duration = Duration::from_secs(300);
const MAIN_TRAY_ID: &str = "main-tray";
const PANEL_LABEL: &str = "tray-panel";
const PANEL_W: f64 = 360.0;
const PANEL_H: f64 = 500.0;

/// 位图 2x 尺寸（菜单栏 18pt 高、约 12.5pt 文字）
const IMG_H: u32 = 36;
const FONT_PX: f32 = 25.0;

/// 面板因失焦被隐藏的时刻：托盘点击若紧跟其后，视为“点托盘收起面板”，不再重新弹出
static BLUR_HIDE_AT: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
static TRAY_ALIVE: AtomicBool = AtomicBool::new(false);

/// 检测升级结果：Some(url) = 已发现新版本，「检测升级」再次点击时直接打开下载页
static UPDATE_URL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// 系统中文字体（PingFang 为 ttc 集合，取首个字形集；加载失败回退纯文本标题）
static FONT: LazyLock<Option<FontVec>> = LazyLock::new(|| {
    for path in [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ] {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(f) = FontVec::try_from_vec_and_index(bytes, 0) {
                return Some(f);
            }
        }
    }
    None
});

/// 托盘展示视图：纯文本（栅格化进模板图 / tooltip / 无字体回退标题）
struct TrayView {
    plain: String,
}

/// 立即刷新托盘（供应商/网关设置变更后由前端调用）
#[tauri::command]
pub async fn tray_refresh(app: AppHandle) {
    refresh_once(&app).await;
}

/// 单轮「聚合→画图标」。panic 隔离：单轮失败（如某个供应商接口炸了）
/// 只跳过本轮、沿用现有托盘文字，不拖垮常驻刷新循环。
pub async fn refresh_once(app: &AppHandle) {
    let a = app.clone();
    let _ = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(async move {
        let view = build_status(&a).await;
        apply_status(&a, view);
    }))
    .await;
}

pub fn spawn_quota_refresher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            refresh_once(&app).await;
            tokio::time::sleep(QUOTA_REFRESH).await;
        }
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ===== 托盘项维护 =====

fn apply_status(app: &AppHandle, view: TrayView) {
    if !TRAY_ALIVE.load(Ordering::Relaxed) && ensure_tray(app).is_ok() {
        TRAY_ALIVE.store(true, Ordering::Relaxed);
    }
    let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) else { return };
    let _ = tray.set_tooltip(Some(format!("AI 工作台 · {}", view.plain)));

    // 纯文字托盘图。macOS 画成模板图（纯黑 + 透明度），系统栏自动按壁纸明暗渲染黑/白；
    // 其他平台无模板机制，按系统主题近似选深/浅色。
    #[cfg(target_os = "macos")]
    let ink = [0u8, 0, 0, 255];
    #[cfg(not(target_os = "macos"))]
    let ink = {
        let theme_dark = app
            .get_webview_window("main")
            .and_then(|w| w.theme().ok())
            .is_some_and(|t| t == tauri::Theme::Dark);
        if theme_dark { [250, 250, 250, 255] } else { [26, 26, 26, 255] }
    };
    let runs = vec![(view.plain.clone(), ink)];
    match render_status_image(None, &runs) {
        Some(img) => {
            // 原子设置图标 + 模板标记（避免先 set_icon 再 set_template 的可见闪变）
            let _ = tray.set_icon_with_as_template(Some(img), cfg!(target_os = "macos"));
            let _ = tray.set_title(None::<&str>);
        }
        None => {
            let _ = tray.set_title(Some(format!(" {}", view.plain)));
        }
    }
}

/// 创建右键菜单（update_text 为「检测升级」项的当前文案）
fn tray_menu(app: &AppHandle, update_text: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open", "打开 AI 工作台", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "立即刷新", true, None::<&str>)?;
    let version = MenuItem::with_id(
        app,
        "version",
        format!("AI工作台 v{}", env!("CARGO_PKG_VERSION")),
        false,
        None::<&str>,
    )?;
    let update = MenuItem::with_id(app, "check-update", update_text, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&open, &refresh, &sep1, &version, &update, &sep2, &quit_item])
}

/// 重建托盘菜单（检测升级结果通过菜单文字反馈；处理器在 builder 上注册，set_menu 不丢）
fn apply_tray_menu(app: &AppHandle, update_text: &str) {
    if let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) {
        if let Ok(m) = tray_menu(app, update_text) {
            let _ = tray.set_menu(Some(m));
        }
    }
}

/// 检测升级：已检出新版本时再次触发则打开发布页；否则查 GitHub Releases 并把结果写进菜单。
/// 托盘菜单与应用菜单共用；结果回写见 apply_tray_menu / app 菜单暂只托盘侧展示。
pub(crate) fn handle_check_update(app: &AppHandle) {
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        let pending = UPDATE_URL.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(url) = pending {
            use tauri_plugin_opener::OpenerExt as _;
            let _ = h.opener().open_url(url, None::<&str>);
            return;
        }
        apply_tray_menu(&h, "检查中…");
        match crate::updater::github_check(&h).await {
            Ok(info) if info.has_update => {
                *UPDATE_URL.lock().unwrap_or_else(|e| e.into_inner()) = Some(info.release_url.clone());
                apply_tray_menu(&h, &format!("新版本 v{} · 点击打开下载页", info.latest_version));
            }
            Ok(info) if info.latest_version.is_empty() => {
                apply_tray_menu(&h, "暂无发布版本");
            }
            Ok(_) => apply_tray_menu(&h, "已是最新版本"),
            Err(e) => {
                let brief: String = e.message.chars().take(60).collect();
                apply_tray_menu(&h, &format!("检查失败（{brief}）"));
            }
        }
    });
}

/// 创建托盘项（右键菜单 + 左键弹面板）
fn ensure_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app, "检测升级")?;

    TrayIconBuilder::with_id(MAIN_TRAY_ID)
        .tooltip("AI 工作台")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "open" => show_main(app),
            "refresh" => {
                let h = app.clone();
                tauri::async_runtime::spawn(async move {
                    let view = build_status(&h).await;
                    apply_status(&h, view);
                });
            }
            "check-update" => handle_check_update(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_panel(tray.app_handle(), &rect);
            }
        })
        .icon(app.default_window_icon().expect("missing icon").clone())
        .build(app)?;
    Ok(())
}

/// macOS 菜单栏「应用菜单」（点应用名弹出的下拉）注入版本号与检测升级。
/// 该菜单由 Tauri 默认生成（关于/服务/隐藏/退出），首个子菜单即应用菜单；
/// Windows/Linux 无此形态，跳过。
pub fn setup_app_menu(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{MenuItem, MenuItemKind};
        let menu = match app.menu() {
            Some(m) => m,
            None => {
                let m = tauri::menu::Menu::default(app)?;
                app.set_menu(m.clone())?;
                m
            }
        };
        let Ok(kinds) = menu.items() else { return Ok(()) };
        let Some(MenuItemKind::Submenu(sub)) = kinds.first() else {
            return Ok(());
        };
        let version = MenuItem::with_id(
            app,
            "app-version",
            format!("版本 v{}", env!("CARGO_PKG_VERSION")),
            false,
            None::<&str>,
        )?;
        let check = MenuItem::with_id(app, "app-check-update", "检测升级…", true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let _ = sub.prepend_items(&[&version, &check, &sep]);
        Ok(())
    }
}

// ===== 位图渲染（模板图：纯黑文字 + 透明背景，macOS 系统栏自动反色） =====

/// 把多段文字栅格化为一张 RGBA 图
fn render_status_image(
    lead: Option<(Vec<u8>, u32, u32)>,
    runs: &[(String, [u8; 4])],
) -> Option<tauri::image::Image<'static>> {
    let font: &FontVec = FONT.as_ref()?;
    let sf = PxScaleFont { font, scale: PxScale::from(FONT_PX) };

    // 品牌图标垂直居中缩放到画布高度
    let lead_w: u32 = lead.as_ref().map(|(_, w, _)| *w).unwrap_or(0);
    let mut width = lead_w;
    if width > 0 {
        width += 3; // 图标与文字间距
    }
    for (text, _) in runs {
        for ch in text.chars() {
            let g = sf.scaled_glyph(ch);
            width += sf.h_advance(g.id).ceil() as u32;
        }
    }
    if width == 0 {
        return None;
    }
    width += 4; // 右侧留白

    let mut buf = vec![0u8; (width * IMG_H) as usize * 4];

    // 画图标（等比缩放到 36px 高，垂直居中）
    if let Some((rgba, w, h)) = &lead {
        for y in 0..*h {
            for x in 0..*w {
                let (sx, sy) = ((x * IMG_H) / h, (y * IMG_H) / h);
                if sx < width && sy < IMG_H {
                    let src = ((y * w + x) * 4) as usize;
                    let dst = ((sy * width + sx) * 4) as usize;
                    if rgba[src + 3] > 0 {
                        buf[dst..dst + 4].copy_from_slice(&rgba[src..src + 4]);
                    }
                }
            }
        }
    }

    // 画文字：基线按 (ascent+H+descent)/2 垂直居中
    let ascent = sf.ascent();
    let descent = sf.descent();
    let baseline = (ascent + IMG_H as f32 - descent) / 2.0;
    let mut pen_x = lead_w as f32 + if lead_w > 0 { 3.0 } else { 0.0 };
    for (text, color) in runs {
        for ch in text.chars() {
            let g0 = sf.scaled_glyph(ch);
            let id = g0.id;
            let mut g = g0;
            g.position = point(pen_x, baseline);
            if let Some(og) = sf.outline_glyph(g) {
                let bb = og.px_bounds();
                og.draw(|x, y, cov| {
                    let gx = bb.min.x as i32 + x as i32;
                    let gy = bb.min.y as i32 + y as i32;
                    if gx < 0 || gy < 0 || gx >= width as i32 || gy >= IMG_H as i32 {
                        return;
                    }
                    if cov <= 0.0 {
                        return;
                    }
                    let dst = ((gy as u32 * width + gx as u32) * 4) as usize;
                    let a = (cov * color[3] as f32).clamp(0.0, 255.0) as u8;
                    // 覆盖式混合（背景透明，同段文字不重叠）
                    buf[dst] = color[0];
                    buf[dst + 1] = color[1];
                    buf[dst + 2] = color[2];
                    buf[dst + 3] = buf[dst + 3].max(a);
                });
            }
            pen_x += sf.h_advance(id);
        }
    }
    Some(tauri::image::Image::new_owned(buf, width, IMG_H))
}

// ===== 面板窗口 =====

/// 左键托盘：已显示则收起，否则在菜单栏正下方弹出
fn toggle_panel(app: &AppHandle, rect: &tauri::Rect) {
    if recently_hidden_by_blur() {
        return;
    }
    let Some(win) = ensure_panel(app) else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    // 托盘事件坐标为物理像素（macOS 上 = 全局逻辑点 × 托盘所在屏的 scale）
    let win_scale = win.scale_factor().unwrap_or(2.0);
    let (px, py) = match &rect.position {
        tauri::Position::Physical(v) => (v.x as f64, v.y as f64),
        tauri::Position::Logical(v) => (v.x * win_scale, v.y * win_scale),
    };
    let (sw, sh) = match &rect.size {
        tauri::Size::Physical(v) => (v.width as f64, v.height as f64),
        tauri::Size::Logical(v) => (v.width * win_scale, v.height * win_scale),
    };
    let mon = tray_monitor(app, px, py).or_else(|| app.primary_monitor().ok().flatten());

    #[cfg(target_os = "macos")]
    //
    // macOS 多屏下 tao 的 monitor position/size 是「全局点 × 各屏 scale」拼的混合空间，
    // 屏间 scale 不同时物理坐标不可比；set_position(Physical) 又按窗口当前所在屏的
    // （旧）scale 换算——窗口还挂在另一块屏时位置会漂移，迁移后下一次才正确。
    // 因此全程用全局逻辑点：rect ÷ 所在屏 scale 还原为点，set_position(Logical) 直达
    // setFrameOrigin，不受窗口旧 scale 影响。
    {
        let scale = mon.as_ref().map(|m| m.scale_factor()).unwrap_or(2.0);
        let (mx, mw) = mon
            .as_ref()
            .map(|m| (m.position().x as f64 / scale, m.size().width as f64 / scale))
            .unwrap_or((0.0, 1512.0));
        let x = ((px + sw / 2.0) / scale - PANEL_W / 2.0)
            .clamp(mx + 8.0, (mx + mw - PANEL_W - 8.0).max(mx + 8.0));
        let y = (py + sh) / scale + 6.0;
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let scale = mon.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
        let (mx, mw) = mon
            .as_ref()
            .map(|m| (m.position().x as f64, m.size().width as f64))
            .unwrap_or((0.0, 1920.0));
        let x = (px + sw / 2.0 - PANEL_W * scale / 2.0).clamp(
            mx + 8.0 * scale,
            (mx + mw - (PANEL_W + 8.0) * scale).max(mx + 8.0 * scale),
        );
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x as i32,
            (py + sh + 6.0 * scale) as i32,
        )));
    }
    let _ = win.show();
    let _ = win.set_focus();
    // 打开面板顺手刷新托盘文字（面板自身数据由前端 focus 监听拉取）
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        refresh_once(&h).await;
    });
}

/// 托盘图标所在显示器。点击瞬间鼠标就在图标上：cursor_position（全局点 × 主屏 scale）
/// 还原为全局点后交给 monitor_from_point（CG 点空间）命中，无混合缩放歧义；
/// 失败再退回物理坐标框命中（真实屏必含该点）。
fn tray_monitor(app: &AppHandle, px: f64, py: f64) -> Option<tauri::Monitor> {
    if let Ok(cur) = app.cursor_position() {
        let s = app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(2.0);
        if let Ok(m) = app.monitor_from_point(cur.x / s, cur.y / s) {
            if m.is_some() {
                return m;
            }
        }
    }
    app.available_monitors().ok().and_then(|mons| {
        mons.into_iter().find(|m| {
            let (x, y, w, h) = (
                m.position().x as f64,
                m.position().y as f64,
                m.size().width as f64,
                m.size().height as f64,
            );
            px >= x && px < x + w && py >= y && py < y + h
        })
    })
}

fn ensure_panel(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(PANEL_LABEL) {
        return Some(w);
    }
    WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("#/tray-panel".into()))
        .title("用量面板")
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .inner_size(PANEL_W, PANEL_H)
        .visible(false)
        .build()
        .ok()
}

/// 面板失焦自动收起（由 lib.rs 的全局窗口事件转发）
pub fn on_panel_blur(window: &tauri::Window) {
    if window.label() != PANEL_LABEL {
        return;
    }
    let _ = window.hide();
    *BLUR_HIDE_AT.lock().expect("blur hide lock") = Some(Instant::now());
}

fn recently_hidden_by_blur() -> bool {
    BLUR_HIDE_AT
        .lock()
        .expect("blur hide lock")
        .is_some_and(|t| t.elapsed() < Duration::from_millis(400))
}

// ===== 数据聚合 =====

/// 聚合托盘文本：智谱剩余百分比（取最紧张窗口 = 100 - 最高已用）+ 重置倒计时，
/// 其余（DS ¥7.3 等）。show_on_tray=1 的供应商才进系统栏。
async fn build_status(app: &AppHandle) -> TrayView {
    let mut parts: Vec<String> = Vec::new();

    for (name, base_url, anthropic, quota_type, secret_ref, currency) in tray_providers(app) {
        if crate::secrets::get(&secret_ref).ok().flatten().is_none() {
            continue;
        }
        let check = crate::quota::quota_check(
            base_url.clone(),
            quota_type.clone(),
            secret_ref.clone(),
            anthropic.clone(),
            currency.clone(),
        )
        .await;
        if quota_type == "zhipu-coding" {
            // 头条取 5 小时窗（TOKENS_LIMIT，与 AI 服务页口径一致）；API 返回已用百分比
            let title = match check {
                Ok(r) if !r.limits.is_empty() => {
                    let hl = r
                        .limits
                        .iter()
                        .find(|l| l.kind == "TOKENS_LIMIT")
                        .unwrap_or(&r.limits[0]);
                    let remaining = (100 - hl.percentage).clamp(0, 100);
                    let reset_secs = (hl.next_reset_at / 1000 - now_unix()).max(0);
                    if hl.next_reset_at > 0 {
                        let (h, m) = (reset_secs / 3600, (reset_secs % 3600) / 60);
                        if h > 0 {
                            format!("智谱 {remaining}% {h}h{m}m")
                        } else {
                            format!("智谱 {remaining}% {m}m")
                        }
                    } else {
                        format!("智谱 {remaining}%")
                    }
                }
                _ => "智谱 --%".to_string(),
            };
            parts.insert(0, title);
        } else {
            let mut title = format!("{} --", short_name(&name));
            if let Ok(r) = check {
                title = format!("{} {}", short_name(&name), short_quota(&r.text));
            }
            parts.push(title);
        }
    }

    let plain = if parts.is_empty() {
        "AI 工作台".to_string()
    } else {
        parts.join(" · ")
    };
    TrayView { plain }
}

/// show_on_tray=1 的供应商：name/base_url/anthropic/quota_type/secret_ref/currency
fn tray_providers(app: &AppHandle) -> Vec<(String, String, Option<String>, String, String, Option<String>)> {
    use rusqlite::Connection;
    let db = match app.path().app_data_dir() {
        Ok(d) => d.join("workbench.db"),
        Err(_) => return vec![],
    };
    let Ok(conn) = Connection::open(&db) else { return vec![] };
    // 前端迁移未跑到时兜底建列（已存在则忽略报错）
    let _ = conn.execute("ALTER TABLE providers ADD COLUMN currency TEXT NOT NULL DEFAULT ''", []);
    let mut out = Vec::new();
    if let Ok(mut st) = conn.prepare(
        "SELECT name, base_url, anthropic_base_url, quota_type, secret_ref, currency FROM providers WHERE show_on_tray = 1 AND quota_type != ''",
    ) {
        if let Ok(mapped) = st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        }) {
            for r in mapped.flatten() {
                out.push(r);
            }
        }
    }
    out
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 标题用短名：DeepSeek → DS；其余保留（智谱单独走 pct 段）
fn short_name(name: &str) -> String {
    if name.to_lowercase().contains("deepseek") {
        "DS".into()
    } else {
        name.to_string()
    }
}

/// 标题用短数值："余额 ¥7.33" → "¥7.3"
fn short_quota(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().skip_while(|c| c.is_whitespace());
    while let Some(c) = chars.next() {
        if c == '¥' || c == '$' {
            out.push(c);
            for d in chars.by_ref() {
                if d.is_ascii_digit() || d == '.' {
                    out.push(d);
                } else {
                    break;
                }
            }
            if let Some(dot) = out.rfind('.') {
                let frac = out.len() - dot - 1;
                if frac > 1 {
                    out.truncate(dot + 2);
                }
            }
            return out;
        }
    }
    if out.is_empty() { text.chars().take(8).collect() } else { out }
}

#[cfg(test)]
mod tests {
    use super::{short_name, short_quota};

    #[test]
    fn shorts() {
        assert_eq!(short_name("DeepSeek 官方"), "DS");
        assert_eq!(short_quota("余额 ¥7.33"), "¥7.3");
        assert_eq!(short_quota("$9.87 / $10.00"), "$9.8");
    }
}
