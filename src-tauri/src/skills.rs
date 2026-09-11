//! 技能（Skill）管理：安装（git/本地）、列表、删除、分发到各 CLI 的技能目录。
//!
//! 技能格式：目录 + SKILL.md（frontmatter: name/description），与 Claude Code 等
//! CLI 的技能目录约定兼容。分发：unix 优先 symlink，Windows/失败时递归复制；
//! 分发前先清理旧条目，保证幂等。

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::cli::fsutil::home_dir;
use crate::error::AppError;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// 目录名（唯一 id）
    pub name: String,
    pub description: String,
    /// SKILL.md frontmatter 里的原始 name（可能与目录名不同）
    pub display_name: String,
    /// 分发目标工具 id 列表（claude/codex/opencode/pi）
    pub targets: Vec<String>,
    pub installed_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTarget {
    pub id: String,
    pub label: String,
    pub dir: String,
    /// 目标技能目录是否存在（不代表是否已分发本技能）
    pub exists: bool,
}

pub(crate) fn skills_dir(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::internal(format!("无法获取数据目录：{e}")))?
        .join("skills"))
}

/// 内置分发目标（路径约定与各 CLI 对齐；pi/codex/opencode 沿用其 agent 目录下的 skills/）
fn builtin_targets() -> Vec<(&'static str, &'static str, fn(&std::path::Path) -> std::path::PathBuf)> {
    vec![
        ("claude", "Claude Code", |h| h.join(".claude").join("skills")),
        ("codex", "Codex", |h| h.join(".codex").join("skills")),
        ("opencode", "OpenCode", |h| h.join(".config").join("opencode").join("skills")),
        ("pi", "Pi", |h| h.join(".pi").join("agent").join("skills")),
    ]
}

// ===== SKILL.md 解析 =====

fn parse_frontmatter(text: &str) -> (String, String) {
    let mut name = String::new();
    let mut desc = String::new();
    let mut lines = text.trim_start().lines();
    if lines.next() == Some("---") {
        for line in lines.by_ref() {
            if line.trim() == "---" {
                break;
            }
            if let Some((k, v)) = line.split_once(':') {
                let v = v.trim();
                match k.trim() {
                    "name" => name = v.to_string(),
                    "description" => desc = v.to_string(),
                    _ => {}
                }
            }
        }
    }
    (name, desc)
}

fn read_skill_meta(dir: &std::path::Path) -> Result<Option<Skill>, AppError> {
    let md = dir.join("SKILL.md");
    if !md.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&md)
        .map_err(|e| AppError::internal(format!("读取 {} 失败：{e}", md.display())))?;
    let (name, desc) = parse_frontmatter(&text);
    let dir_name = dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let installed_at = std::fs::metadata(&md)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok(Some(Skill {
        targets: read_targets(&dir.join(".aw-targets")),
        display_name: if name.is_empty() { dir_name.clone() } else { name },
        name: dir_name,
        description: desc,
        installed_at,
    }))
}

fn read_targets(marker: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(marker)
        .map(|s| s.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

fn write_targets(marker: &std::path::Path, targets: &[String]) -> Result<(), AppError> {
    std::fs::write(marker, targets.join("\n"))
        .map_err(|e| AppError::internal(format!("写入分发记录失败：{e}")))
}

// ===== 命令 =====

#[tauri::command]
pub async fn skill_list(app: AppHandle) -> Result<Vec<Skill>, AppError> {
    let dir = skills_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| AppError::internal(format!("读取技能目录失败：{e}")))?
    {
        let entry = entry.map_err(|e| AppError::internal(format!("{e}")))?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(s) = read_skill_meta(&path)? {
                out.push(s);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub async fn skill_targets(_app: AppHandle) -> Result<Vec<SkillTarget>, AppError> {
    let home = home_dir()?;
    Ok(builtin_targets()
        .into_iter()
        .map(|(id, label, path)| {
            let dir = path(&home);
            SkillTarget {
                id: id.to_string(),
                label: label.to_string(),
                dir: dir.display().to_string(),
                exists: dir.is_dir(),
            }
        })
        .collect())
}

/// 从 git 仓库安装（浅克隆；仓库根或其子目录含 SKILL.md 时取前者，
/// 否则把仓库视为技能集合，逐个含 SKILL.md 的一级子目录安装）
#[tauri::command]
pub async fn skill_install_git(app: AppHandle, url: String) -> Result<Vec<String>, AppError> {
    let dir = skills_dir(&app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal(format!("创建技能目录失败：{e}")))?;
    let tmp = dir.join(format!(".clone-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let out = tokio::process::Command::new("git")
        .args(["clone", "--depth", "1", url.trim(), &tmp.display().to_string()])
        .output()
        .await
        .map_err(|e| AppError::config(format!("无法调用 git（{e}）；请确认已安装 git")))?
;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(AppError::api(format!("git clone 失败：{}", msg.trim())));
    }
    let names = import_from(&app, &tmp)?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(names)
}

/// 从本地目录安装
#[tauri::command]
pub async fn skill_install_local(app: AppHandle, path: String) -> Result<Vec<String>, AppError> {
    let src = std::path::PathBuf::from(path.trim());
    if !src.is_dir() {
        return Err(AppError::config("目录不存在"));
    }
    import_from(&app, &src)
}

#[tauri::command]
pub async fn skill_remove(app: AppHandle, name: String) -> Result<(), AppError> {
    // 先摘除分发
    for t in builtin_targets() {
        let home = home_dir()?;
        let link = (t.2)(&home).join(&name);
        if link.exists() || link.is_symlink() {
            let _ = if link.is_symlink() || link.is_file() {
                std::fs::remove_file(&link)
            } else {
                std::fs::remove_dir_all(&link)
            };
        }
    }
    let dir = skills_dir(&app)?.join(&name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| AppError::internal(format!("删除技能失败：{e}")))?;
    }
    Ok(())
}

/// 分发/更新分发目标（幂等；unix symlink，Windows/失败降级复制）
#[tauri::command]
pub async fn skill_sync(app: AppHandle, name: String, targets: Vec<String>) -> Result<(), AppError> {
    let src = skills_dir(&app)?.join(&name);
    if !src.is_dir() {
        return Err(AppError::config("技能不存在"));
    }
    let home = home_dir()?;
    for (id, _label, path) in builtin_targets() {
        let dest = path(&home).join(&name);
        if targets.iter().any(|t| t == id) {
            // 清旧
            if dest.is_symlink() || dest.is_file() {
                let _ = std::fs::remove_file(&dest);
            } else if dest.is_dir() {
                let _ = std::fs::remove_dir_all(&dest);
            }
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| AppError::internal(format!("创建目录失败：{e}")))?;
            }
            #[cfg(unix)]
            {
                if std::os::unix::fs::symlink(&src, &dest).is_err() {
                    copy_dir(&src, &dest)?;
                }
            }
            #[cfg(windows)]
            {
                copy_dir(&src, &dest)?;
            }
        } else if dest.is_symlink() || dest.exists() {
            if dest.is_symlink() || dest.is_file() {
                let _ = std::fs::remove_file(&dest);
            } else {
                let _ = std::fs::remove_dir_all(&dest);
            }
        }
    }
    write_targets(&src.join(".aw-targets"), &targets)
}

/// 把 src（单技能目录或技能集合目录）导入应用技能库，返回导入的技能名
pub(crate) fn import_from(app: &AppHandle, src: &std::path::Path) -> Result<Vec<String>, AppError> {
    let dest_root = skills_dir(app)?;
    std::fs::create_dir_all(&dest_root)
        .map_err(|e| AppError::internal(format!("创建技能目录失败：{e}")))?;

    if src.join("SKILL.md").is_file() {
        // 单技能
        let name = src
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".into());
        let dest = dest_root.join(&name);
        if dest.exists() {
            std::fs::remove_dir_all(&dest)
                .map_err(|e| AppError::internal(format!("清理旧技能失败：{e}")))?;
        }
        copy_dir(src, &dest)?;
        return Ok(vec![name]);
    }
    // 技能集合：逐个含 SKILL.md 的一级子目录
    let mut names = Vec::new();
    for entry in std::fs::read_dir(src)
        .map_err(|e| AppError::internal(format!("读取目录失败：{e}")))?
    {
        let entry = entry.map_err(|e| AppError::internal(format!("{e}")))?;
        let p = entry.path();
        if p.is_dir() && p.join("SKILL.md").is_file() {
            let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let dest = dest_root.join(&name);
            if dest.exists() {
                std::fs::remove_dir_all(&dest)
                    .map_err(|e| AppError::internal(format!("清理旧技能失败：{e}")))?;
            }
            copy_dir(&p, &dest)?;
            names.push(name);
        }
    }
    if names.is_empty() {
        return Err(AppError::config("未找到 SKILL.md（应为技能目录或技能集合仓库）"));
    }
    Ok(names)
}

fn copy_dir(src: &std::path::Path, dest: &std::path::Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dest)
        .map_err(|e| AppError::internal(format!("创建 {} 失败：{e}", dest.display())))?;
    for entry in std::fs::read_dir(src)
        .map_err(|e| AppError::internal(format!("读取 {} 失败：{e}", src.display())))?
    {
        let entry = entry.map_err(|e| AppError::internal(format!("{e}")))?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map_err(|e| AppError::internal(format!("复制 {} 失败：{e}", from.display())))?;
        }
    }
    Ok(())
}

// ===== 本机扫描与导入 =====

/// 本机技能：出现在哪些位置（cli id 或 library）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkill {
    pub name: String,
    pub display_name: String,
    pub description: String,
    /// 位置：claude / codex / opencode / pi / library
    pub locations: Vec<String>,
    pub in_library: bool,
    pub installed_at: i64,
}

fn scan_dir_skills(
    dir: &std::path::Path,
    loc: &str,
    map: &mut std::collections::BTreeMap<String, LocalSkill>,
) -> Result<(), AppError> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let Some(meta) = read_skill_meta(&p)? else {
            continue;
        };
        let name = meta.name.clone();
        match map.get_mut(&name) {
            Some(ls) => {
                if !ls.locations.iter().any(|l| l == loc) {
                    ls.locations.push(loc.to_string());
                }
                ls.in_library = ls.in_library || loc == "library";
                // 描述为空时用别处的补齐
                if ls.description.is_empty() {
                    ls.description = meta.description.clone();
                }
            }
            None => {
                let mut locations = vec![loc.to_string()];
                locations.retain(|_| true);
                map.insert(
                    name.clone(),
                    LocalSkill {
                        name,
                        display_name: meta.display_name,
                        description: meta.description,
                        in_library: loc == "library",
                        installed_at: meta.installed_at,
                        locations,
                    },
                );
            }
        }
    }
    Ok(())
}

/// 扫描本机技能：应用技能库 + 各 CLI 的技能目录
#[tauri::command]
pub async fn skill_scan_local(app: AppHandle) -> Result<Vec<LocalSkill>, AppError> {
    let mut map = std::collections::BTreeMap::new();
    scan_dir_skills(&skills_dir(&app)?, "library", &mut map)?;
    let home = home_dir()?;
    for (id, _label, path) in builtin_targets() {
        scan_dir_skills(&path(&home), id, &mut map)?;
    }
    Ok(map.into_values().collect())
}

/// 从 CLI 技能目录导入一个技能到应用技能库（复制入库，不改动原目录）
#[tauri::command]
pub async fn skill_import_from(app: AppHandle, cli: String, name: String) -> Result<Vec<String>, AppError> {
    if cli == "library" {
        return Err(AppError::config("已在技能库中"));
    }
    let home = home_dir()?;
    let Some((_, _, path)) = builtin_targets().into_iter().find(|(id, _, _)| *id == cli) else {
        return Err(AppError::config("未知来源"));
    };
    let src = path(&home).join(name.trim());
    if !src.join("SKILL.md").is_file() {
        return Err(AppError::config("该目录下没有此技能"));
    }
    import_from(&app, &src)
}

// ===== 精选源（git 仓库浏览 / 选择安装） =====

/// 内置精选技能源
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    pub url: String,
    pub label: String,
    pub desc: String,
}

const SKILL_SOURCES: &[(&str, &str, &str)] = &[
    (
        "https://github.com/anthropics/skills.git",
        "Anthropic 官方技能",
        "文档技能：docx / pptx / xlsx / pdf 等",
    ),
    (
        "https://github.com/obra/superpowers.git",
        "Superpowers",
        "热门技能市场（28 万+ star）：头脑风暴 / TDD / 系统化调试 / 计划执行等开发方法论",
    ),
    (
        "https://github.com/ComposioHQ/awesome-claude-skills.git",
        "Awesome Claude Skills",
        "社区精选技能合集",
    ),
    (
        "https://github.com/K-Dense-AI/scientific-agent-skills.git",
        "Scientific Agent Skills",
        "科研技能库（4 万+ star）：163 个技能覆盖生物 / 化学 / 医药 / 数据分析，对接 100+ 科研数据库",
    ),
    (
        "https://github.com/JimLiu/baoyu-skills.git",
        "宝玉技能集",
        "中文向热门技能（2 万+ star）：翻译润色 / 写作 / 提示词优化等",
    ),
    (
        "https://github.com/Jeffallan/claude-skills.git",
        "JeffAllan 全栈技能",
        "全栈开发技能（1 万+ star）：Next.js / TypeScript / 测试等 67 个技能",
    ),
    (
        "https://github.com/cexll/myclaude.git",
        "myclaude",
        "社区技能合集（中文向）",
    ),
];

#[tauri::command]
pub async fn skill_sources() -> Result<Vec<SkillSource>, AppError> {
    Ok(SKILL_SOURCES
        .iter()
        .map(|(url, label, desc)| SkillSource {
            url: url.to_string(),
            label: label.to_string(),
            desc: desc.to_string(),
        })
        .collect())
}

/// 仓库里的技能条目
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoSkill {
    pub name: String,
    pub display_name: String,
    pub description: String,
}

async fn shallow_clone(app: &AppHandle, url: &str) -> Result<std::path::PathBuf, AppError> {
    let base = skills_dir(app)?;
    std::fs::create_dir_all(&base)
        .map_err(|e| AppError::internal(format!("创建技能目录失败：{e}")))?;
    let tmp = base.join(format!(".clone-{}-{}", std::process::id(), crate::store::now_nanos()));
    let _ = std::fs::remove_dir_all(&tmp);
    let out = tokio::process::Command::new("git")
        .args(["clone", "--depth", "1", url.trim(), &tmp.display().to_string()])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| AppError::config(format!("无法调用 git（{e}）；请确认已安装 git")))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(AppError::api(format!("git clone 失败：{}", msg.trim())));
    }
    Ok(tmp)
}

/// 收集仓库中所有含 SKILL.md 的技能目录（深度 ≤3，跳过隐藏目录；
/// 仓库根即单个技能时返回根；子目录命中后不再下探）
fn collect_skill_dirs(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    fn walk(dir: &std::path::Path, depth: u32, out: &mut Vec<std::path::PathBuf>) {
        if depth == 0 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut dirs: Vec<_> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for p in dirs {
            let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            if p.join("SKILL.md").is_file() {
                out.push(p);
            } else {
                walk(&p, depth - 1, out);
            }
        }
    }
    let mut out = Vec::new();
    if root.join("SKILL.md").is_file() {
        out.push(root.to_path_buf());
        return out;
    }
    walk(root, 3, &mut out);
    out
}

/// 浏览 git 技能仓库：列出其中包含 SKILL.md 的技能（根目录或任意层级子目录，深度 ≤3）
#[tauri::command]
pub async fn skill_repo_browse(app: AppHandle, url: String) -> Result<Vec<RepoSkill>, AppError> {
    let tmp = shallow_clone(&app, &url).await?;
    let out = collect_skill_dirs(&tmp)
        .iter()
        .filter_map(|p| match read_skill_meta(p) {
            Ok(Some(meta)) => Some(RepoSkill {
                name: meta.name,
                display_name: meta.display_name,
                description: meta.description,
            }),
            _ => None,
        })
        .collect::<Vec<_>>();
    let _ = std::fs::remove_dir_all(&tmp);
    if out.is_empty() {
        return Err(AppError::config("仓库中未找到技能（目录 + SKILL.md）"));
    }
    Ok(out)
}

/// 从 git 技能仓库安装选中的技能
#[tauri::command]
pub async fn skill_repo_install(app: AppHandle, url: String, names: Vec<String>) -> Result<Vec<String>, AppError> {
    if names.is_empty() {
        return Err(AppError::config("请选择要安装的技能"));
    }
    let tmp = shallow_clone(&app, &url).await?;
    let dirs = collect_skill_dirs(&tmp);
    let mut installed = Vec::new();
    let mut errors = Vec::new();
    for n in &names {
        let target = dirs.iter().find(|p| {
            p.file_name().map(|s| s.to_string_lossy() == n.trim()).unwrap_or(false)
        });
        match target {
            Some(p) => match import_from(&app, p) {
                Ok(mut ns) => installed.append(&mut ns),
                Err(e) => errors.push(format!("{n}：{}", e.message)),
            },
            None => errors.push(format!("{n}：仓库中不存在")),
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    if installed.is_empty() {
        return Err(AppError::api(format!("安装失败：{}", errors.join("；"))));
    }
    if !errors.is_empty() {
        return Err(AppError::api(format!(
            "已安装 {}，失败：{}",
            installed.join("、"),
            errors.join("；")
        )));
    }
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_skill_dirs_finds_nested_skills() {
        let dir = std::env::temp_dir().join(format!("gy-skills-collect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // anthropics/skills 形态：skills/<name>/SKILL.md（二级）
        std::fs::create_dir_all(dir.join("skills/pptx")).unwrap();
        std::fs::write(dir.join("skills/pptx/SKILL.md"), "---\nname: pptx\ndescription: PPT\n---").unwrap();
        std::fs::create_dir_all(dir.join("skills/docx")).unwrap();
        std::fs::write(dir.join("skills/docx/SKILL.md"), "---\nname: docx\ndescription: DOCX\n---").unwrap();
        // 隐藏目录忽略
        std::fs::create_dir_all(dir.join(".git/x")).unwrap();
        std::fs::write(dir.join(".git/x/SKILL.md"), "---\nname: hidden\n---").unwrap();
        // 普通仓库形态：根下一级
        std::fs::create_dir_all(dir.join("plain")).unwrap();
        std::fs::write(dir.join("plain/SKILL.md"), "---\nname: plain\n---").unwrap();
        let found = collect_skill_dirs(&dir);
        let names: Vec<String> = found.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert!(names.contains(&"pptx".to_string()), "应找到二级目录技能：{names:?}");
        assert!(names.contains(&"plain".to_string()), "应找到一级目录技能：{names:?}");
        assert!(!names.contains(&"x".to_string()), "应跳过隐藏目录：{names:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn frontmatter_parses_name_and_description() {
        let (n, d) = parse_frontmatter("---\nname: ppt\ndescription: 制作 PPT\n---\n# 正文");
        assert_eq!(n, "ppt");
        assert_eq!(d, "制作 PPT");
        let (n, d) = parse_frontmatter("# 无 frontmatter");
        assert_eq!((n, d), (String::new(), String::new()));
    }
}

// ===== 技能详情 / 打开目录 =====

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileEntry {
    /// 相对技能根的路径
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub name: String,
    pub display_name: String,
    pub description: String,
    /// 技能目录绝对路径
    pub dir: String,
    /// library 或 cli id
    pub loc: String,
    pub files: Vec<SkillFileEntry>,
    pub skill_md: Option<String>,
    pub readme_md: Option<String>,
}

/// 解析位置：library 或 cli id → 技能目录
fn skill_dir_for(app: &AppHandle, loc: &str, name: &str) -> Result<std::path::PathBuf, AppError> {
    let dir = if loc == "library" {
        skills_dir(app)?.join(name.trim())
    } else {
        let home = home_dir()?;
        let (_, _, path) = builtin_targets()
            .into_iter()
            .find(|(id, _, _)| *id == loc)
            .ok_or_else(|| AppError::config("未知来源位置"))?;
        path(&home).join(name.trim())
    };
    if !dir.is_dir() {
        return Err(AppError::config("技能目录不存在"));
    }
    Ok(dir)
}

/// 收集技能目录内文件（相对路径；跳过隐藏；深度 ≤6）
fn collect_files(root: &std::path::Path) -> Vec<SkillFileEntry> {
    fn walk(dir: &std::path::Path, prefix: &str, depth: u32, out: &mut Vec<SkillFileEntry>) {
        if depth == 0 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut items: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        items.sort();
        for p in items {
            let Some(name) = p.file_name().map(|s| s.to_string_lossy().to_string()) else { continue };
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if p.is_dir() {
                out.push(SkillFileEntry { path: rel.clone(), is_dir: true, size: 0 });
                walk(&p, &rel, depth - 1, out);
            } else {
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                out.push(SkillFileEntry { path: rel, is_dir: false, size });
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", 6, &mut out);
    out
}

/// 技能详情：元信息 + 文件列表 + SKILL.md / README.md 内容
#[tauri::command]
pub async fn skill_detail(app: AppHandle, loc: String, name: String) -> Result<SkillDetail, AppError> {
    let dir = skill_dir_for(&app, &loc, &name)?;
    let meta = read_skill_meta(&dir)?.ok_or_else(|| AppError::config("目录中没有 SKILL.md"))?;
    let read_opt = |f: &str| -> Option<String> {
        std::fs::read_to_string(dir.join(f)).ok().filter(|s| s.len() <= 512 * 1024)
    };
    Ok(SkillDetail {
        name: meta.name,
        display_name: meta.display_name,
        description: meta.description,
        dir: dir.display().to_string(),
        loc,
        files: collect_files(&dir),
        skill_md: read_opt("SKILL.md"),
        readme_md: read_opt("README.md"),
    })
}

/// 读取技能内文本文件（限制在技能目录内）
#[tauri::command]
pub async fn skill_read_file(app: AppHandle, loc: String, name: String, path: String) -> Result<String, AppError> {
    let dir = skill_dir_for(&app, &loc, &name)?;
    let rel = crate::notes::validate_rel(&path)?;
    let p = dir.join(&rel);
    if !p.starts_with(&dir) || !p.is_file() {
        return Err(AppError::config("文件不存在"));
    }
    std::fs::read_to_string(&p)
        .map_err(|e| AppError::internal(format!("读取失败：{e}")))
        .and_then(|s| {
            if s.len() > 512 * 1024 {
                Err(AppError::config("文件过大（>512KB），不支持预览"))
            } else {
                Ok(s)
            }
        })
}

/// 在访达/资源管理器中打开技能所在目录
#[tauri::command]
pub async fn skill_reveal(app: AppHandle, loc: String, name: String) -> Result<String, AppError> {
    let dir = skill_dir_for(&app, &loc, &name)?;
    #[cfg(desktop)]
    {
        match tauri_plugin_opener::reveal_item_in_dir(&dir) {
            Ok(()) => {}
            Err(_) => {
                tauri_plugin_opener::open_path(dir.clone(), None::<&str>)
                    .map_err(|e| AppError::internal(format!("打开目录失败：{e}")))?;
            }
        }
    }
    Ok(dir.display().to_string())
}
