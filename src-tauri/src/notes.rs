//! Markdown 笔记：纯文件系统存储（.md 文件），根目录可设置（默认 appdata/notes）。
//! 文件名做路径安全校验；写入复用原子写；目录切换不迁移旧文件（原文件留在原地）。

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::cli::fsutil;
use crate::error::AppError;
use crate::store;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteItem {
    /// 文件名（不含 .md 后缀展示，但以含后缀文件名标识）
    pub name: String,
    /// 首个 # 标题或文件名
    pub title: String,
    /// 内容首行摘要
    pub excerpt: String,
    pub size: u64,
    pub updated_at: i64,
}

fn default_dir(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::internal(format!("无法获取数据目录：{e}")))?
        .join("notes"))
}

/// 当前笔记根目录（未设置时取默认并确保存在）
pub(crate) fn notes_dir(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    let configured = store::load_config(app).notes_dir;
    let dir = match configured {
        Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p),
        _ => default_dir(app)?,
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal(format!("创建笔记目录失败：{e}")))?;
    Ok(dir)
}

/// 单段名称校验（文件名或分组名）
fn validate_segment(seg: &str) -> Result<String, AppError> {
    let seg = seg.trim();
    if seg.is_empty() || seg.len() > 100 {
        return Err(AppError::config("名称不能为空且不超过 100 字符"));
    }
    if seg.starts_with('.') || seg.contains("..") {
        return Err(AppError::config("名称不能以点开头或包含 .."));
    }
    if seg
        .chars()
        .any(|c| matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|' | '/' | '\\'))
    {
        return Err(AppError::config("名称包含非法字符"));
    }
    Ok(seg.to_string())
}

/// 相对路径校验（如 "工作/周报.md"）；返回安全 PathBuf
pub(crate) fn validate_rel(rel: &str) -> Result<std::path::PathBuf, AppError> {
    let rel = rel.trim().trim_start_matches('/');
    let mut pb = std::path::PathBuf::new();
    for seg in rel.split('/') {
        if seg.is_empty() {
            continue;
        }
        pb.push(validate_segment(seg)?);
    }
    if pb.as_os_str().is_empty() {
        return Err(AppError::config("路径为空"));
    }
    Ok(pb)
}

fn validate_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    let name = name.strip_suffix(".md").unwrap_or(name);
    Ok(format!("{}.md", validate_segment(name)?))
}

fn md_path(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, AppError> {
    Ok(notes_dir(app)?.join(validate_rel(name)?))
}

fn to_item(path: &std::path::Path) -> Option<NoteItem> {
    let meta = std::fs::metadata(path).ok()?;
    let content = std::fs::read_to_string(path).ok()?;
    let name = path.file_name()?.to_string_lossy().to_string();
    let mut title = name.trim_end_matches(".md").to_string();
    let mut excerpt = String::new();
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(h) = t.strip_prefix("# ") {
            title = h.trim().to_string();
        } else {
            excerpt = t.chars().take(80).collect();
        }
        if !excerpt.is_empty() {
            break;
        }
    }
    Some(NoteItem {
        name,
        title,
        excerpt,
        size: meta.len(),
        updated_at: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    })
}

// ===== 命令 =====

#[tauri::command]
pub async fn note_get_dir(app: AppHandle) -> Result<String, AppError> {
    Ok(notes_dir(&app)?.display().to_string())
}

/// 设置笔记根目录（目录不存在会创建；配置持久化，不迁移旧文件）
#[tauri::command]
pub async fn note_set_dir(app: AppHandle, path: String) -> Result<String, AppError> {
    let p = path.trim();
    if p.is_empty() {
        return Err(AppError::config("目录不能为空"));
    }
    let dir = std::path::PathBuf::from(p);
    if dir.is_file() {
        return Err(AppError::config("该路径是一个文件"));
    }
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal(format!("创建目录失败：{e}")))?;
    let mut cfg = store::load_config(&app);
    cfg.notes_dir = Some(dir.display().to_string());
    store::save_config(&app, &cfg)?;
    Ok(dir.display().to_string())
}

#[tauri::command]
pub async fn note_reset_dir(app: AppHandle) -> Result<String, AppError> {
    let mut cfg = store::load_config(&app);
    cfg.notes_dir = None;
    store::save_config(&app, &cfg)?;
    Ok(notes_dir(&app)?.display().to_string())
}

#[tauri::command]
pub async fn note_list(app: AppHandle) -> Result<Vec<NoteItem>, AppError> {
    let dir = notes_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| AppError::internal(format!("读取笔记目录失败：{e}")))?
    {
        let Ok(entry) = entry else { continue };
        let p = entry.path();
        if p.is_file() && p.extension().map(|e| e == "md").unwrap_or(false) {
            if let Some(item) = to_item(&p) {
                out.push(item);
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub async fn note_read(app: AppHandle, name: String) -> Result<String, AppError> {
    let p = md_path(&app, &name)?;
    fsutil::read_text_opt(&p)?.ok_or_else(|| AppError::config("笔记不存在"))
}

#[tauri::command]
pub async fn note_write(app: AppHandle, name: String, content: String) -> Result<(), AppError> {
    let p = md_path(&app, &name)?;
    fsutil::atomic_write(&p, &content, false)
}

/// 新建笔记（group 为相对分组路径，空 = 根目录）；重名报错
#[tauri::command]
pub async fn note_create(app: AppHandle, name: String, group: Option<String>) -> Result<NoteItem, AppError> {
    let file = validate_name(&name)?;
    let rel = match group.as_deref().map(str::trim).filter(|g| !g.is_empty()) {
        Some(g) => validate_rel(g)?.join(&file),
        None => std::path::PathBuf::from(&file),
    };
    let p = notes_dir(&app)?.join(&rel);
    if p.exists() {
        return Err(AppError::config("同名笔记已存在"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::internal(format!("创建目录失败：{e}")))?;
    }
    let title = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    fsutil::atomic_write(&p, &format!("# {title}\n\n"), false)?;
    to_item(&p).ok_or_else(|| AppError::internal("笔记创建后读取失败"))
}

/// 新建分组（嵌套路径自动创建）
#[tauri::command]
pub async fn note_create_group(app: AppHandle, path: String) -> Result<(), AppError> {
    let rel = validate_rel(&path)?;
    if rel.extension().map(|e| e == "md").unwrap_or(false) {
        return Err(AppError::config("分组名不能以 .md 结尾"));
    }
    let p = notes_dir(&app)?.join(rel);
    if p.is_file() {
        return Err(AppError::config("同名笔记文件已存在"));
    }
    std::fs::create_dir_all(&p).map_err(|e| AppError::internal(format!("创建分组失败：{e}")))
}

/// 移动笔记/分组到目标分组（to_dir 空 = 根目录）；用于拖拽
#[tauri::command]
pub async fn note_move(app: AppHandle, from: String, to_dir: String) -> Result<(), AppError> {
    let root = notes_dir(&app)?;
    let from_rel = validate_rel(&from)?;
    let src = root.join(&from_rel);
    if !src.exists() {
        return Err(AppError::config("源不存在"));
    }
    let dest_dir = match to_dir.trim() {
        "" => root.clone(),
        d => root.join(validate_rel(d)?),
    };
    if src.is_dir() && dest_dir.starts_with(&src) {
        return Err(AppError::config("不能移动到自身或其子分组内"));
    }
    let Some(name) = from_rel.file_name().map(|s| s.to_os_string()) else {
        return Err(AppError::config("路径无效"));
    };
    let dest = dest_dir.join(name);
    if dest.exists() {
        return Err(AppError::config("目标位置已存在同名项"));
    }
    std::fs::rename(&src, &dest).map_err(|e| AppError::internal(format!("移动失败：{e}")))
}

#[tauri::command]
pub async fn note_rename(app: AppHandle, name: String, new_name: String) -> Result<(), AppError> {
    let from = md_path(&app, &name)?;
    if !from.exists() {
        return Err(AppError::config("笔记不存在"));
    }
    let seg = validate_segment(&new_name)?;
    let to = match from.parent() {
        Some(p) => p.join(if from.is_file() && !seg.ends_with(".md") {
            format!("{seg}.md")
        } else {
            seg
        }),
        None => return Err(AppError::config("路径无效")),
    };
    if to.exists() {
        return Err(AppError::config("目标名称已存在"));
    }
    std::fs::rename(&from, &to)
        .map_err(|e| AppError::internal(format!("重命名失败：{e}")))
}

#[tauri::command]
pub async fn note_delete(app: AppHandle, name: String) -> Result<(), AppError> {
    let p = md_path(&app, &name)?;
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| AppError::internal(format!("删除分组失败：{e}")))?;
    } else if p.exists() {
        std::fs::remove_file(&p).map_err(|e| AppError::internal(format!("删除失败：{e}")))?;
    }
    Ok(())
}

// ===== 目录树 =====

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteNode {
    /// 相对路径：分组如 "工作"，笔记如 "工作/周报.md"
    pub key: String,
    /// group | note
    pub kind: String,
    pub title: String,
    pub excerpt: String,
    pub size: u64,
    pub updated_at: i64,
    pub children: Vec<NoteNode>,
}

fn rel_key(root: &std::path::Path, p: &std::path::Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn walk_tree(dir: &std::path::Path, root: &std::path::Path, depth: u32) -> Vec<NoteNode> {
    if depth == 0 {
        return vec![];
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut groups: Vec<NoteNode> = Vec::new();
    let mut notes: Vec<NoteNode> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        let Some(name) = p.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let key = rel_key(root, &p);
        if p.is_dir() {
            let children = walk_tree(&p, root, depth - 1);
            groups.push(NoteNode {
                key,
                kind: "group".into(),
                title: name,
                excerpt: String::new(),
                size: 0,
                updated_at: std::fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0),
                children,
            });
        } else if p.extension().map(|e| e == "md").unwrap_or(false) {
            if let Some(item) = to_item(&p) {
                notes.push(NoteNode {
                    key,
                    kind: "note".into(),
                    title: item.title,
                    excerpt: item.excerpt,
                    size: item.size,
                    updated_at: item.updated_at,
                    children: vec![],
                });
            }
        }
    }
    groups.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    groups.extend(notes);
    groups
}

/// 目录树（分组在前、笔记按更新时间倒序）
#[tauri::command]
pub async fn note_tree(app: AppHandle) -> Result<Vec<NoteNode>, AppError> {
    let dir = notes_dir(&app)?;
    Ok(walk_tree(&dir, &dir, 10))
}

#[cfg(test)]
mod tests {
    use super::{validate_name, validate_rel, walk_tree, NoteNode};

    #[test]
    fn rel_path_validation() {
        assert_eq!(validate_rel("a/b/c.md").unwrap().to_string_lossy(), "a/b/c.md");
        assert_eq!(validate_rel("/a//b/").unwrap().to_string_lossy(), "a/b");
        assert!(validate_rel("..").is_err());
        assert!(validate_rel("a/../b").is_err());
        assert!(validate_rel(".hidden/x.md").is_err());
        assert!(validate_rel("a/b:c.md").is_err());
    }

    #[test]
    fn walk_tree_builds_groups_first() {
        let dir = std::env::temp_dir().join(format!("gy-notes-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("工作/子组")).unwrap();
        std::fs::write(dir.join("工作/周报.md"), "# 周报\n内容摘要").unwrap();
        std::fs::write(dir.join("工作/子组/plan.md"), "# plan").unwrap();
        std::fs::write(dir.join("readme.md"), "# readme\nroot note").unwrap();
        std::fs::write(dir.join(".hidden.md"), "x").unwrap();
        let tree = walk_tree(&dir, &dir, 10);
        assert_eq!(tree.len(), 2, "分组在前、隐藏文件跳过");
        assert_eq!(tree[0].kind, "group");
        assert_eq!(tree[0].key, "工作");
        assert_eq!(tree[0].children.len(), 2, "子组+笔记");
        assert_eq!(tree[0].children[0].key, "工作/子组");
        assert_eq!(tree[1].kind, "note");
        assert_eq!(tree[1].key, "readme.md");
        assert_eq!(tree[1].title, "readme");
        let _ : Vec<NoteNode> = tree;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn name_validation() {
        assert_eq!(validate_name(" hello ").unwrap(), "hello.md");
        assert_eq!(validate_name("a.md").unwrap(), "a.md");
        assert_eq!(validate_name("周报 2026-09").unwrap(), "周报 2026-09.md");
        assert!(validate_name("../evil").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name(".hidden").is_err());
        assert!(validate_name("").is_err());
        assert!(validate_name("a:b").is_err());
    }
}
