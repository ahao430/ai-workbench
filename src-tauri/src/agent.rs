//! Agent 进程编排：在项目目录里非交互运行所选 CLI（pi / claude / codex / opencode），
//! stdout 逐行透传给前端解析（pi=JSON 事件流、claude=stream-json、codex=JSONL、opencode=纯文本）。
//! 会话连续：pi --session / claude --resume（id 从事件流取）；skills 传路径（pi --skill、
//! claude --add-dir）；MCP 仅 claude（--mcp-config 临时文件，进程结束即删）。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::AppError;

/// 推给前端的事件：pi stdout 的单行 JSON（透传，前端解析）或进程级错误/结束
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent {
    /// pi stdout 一行（JSON 事件流）
    Line { line: String },
    /// 进程结束（code=0 正常；stopped=true 表示被用户停止）
    Done { code: i32, stopped: bool },
    /// 进程启动失败或异常退出（带 stderr 摘要）
    Error { message: String },
}

/// 运行中的 agent 进程（key=前端会话 key）；stdin 保留用于审批应答（claude can_use_tool）
struct RunningProc {
    child: tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
}

static RUNNING: Mutex<Option<HashMap<String, RunningProc>>> = Mutex::new(None);

fn running_insert(key: &str, proc: RunningProc) -> Result<(), AppError> {
    let mut g = RUNNING.lock().map_err(|_| AppError::internal("agent 进程表锁 poisoned"))?;
    g.get_or_insert_with(HashMap::new).insert(key.to_string(), proc);
    Ok(())
}

/// 取出并移除运行中的进程（停止/等待退出用；None = 不在运行）
fn running_take(key: &str) -> Result<Option<RunningProc>, AppError> {
    let mut g = RUNNING.lock().map_err(|_| AppError::internal("agent 进程表锁 poisoned"))?;
    Ok(g.as_mut().and_then(|m| m.remove(key)))
}

fn running_has(key: &str) -> bool {
    RUNNING
        .lock()
        .map(|g| g.as_ref().is_some_and(|m| m.contains_key(key)))
        .unwrap_or(false)
}

/// 向运行中进程的 stdin 写一行（claude 审批应答 control_response 等）。
/// 取出 stdin 写完再放回：mutex 守卫不能跨 await（Send 约束）。
#[tauri::command]
pub async fn agent_stdin_write(key: String, line: String) -> Result<(), AppError> {
    use tokio::io::AsyncWriteExt as _;
    let mut stdin = {
        let mut g = RUNNING
            .lock()
            .map_err(|_| AppError::internal("agent 进程表锁 poisoned"))?;
        g.as_mut()
            .and_then(|m| m.get_mut(&key))
            .and_then(|p| p.stdin.take())
            .ok_or_else(|| AppError::config("会话不在运行中或没有标准输入"))?
    };
    let res = async {
        stdin.write_all(format!("{line}\n").as_bytes()).await?;
        stdin.flush().await
    }
    .await;
    if let Ok(mut g) = RUNNING.lock() {
        if let Some(p) = g.as_mut().and_then(|m| m.get_mut(&key)) {
            p.stdin = Some(stdin);
        }
    }
    res.map_err(|e| AppError::internal(format!("写入进程输入失败：{e}")))
}

/// 检测各 agent CLI 是否可用（PATH 扫描 + 版本）；id: pi | claude | codex | opencode
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTool {
    pub id: String,
    pub installed: bool,
    pub version: Option<String>,
}

// ===== 公共项目目录 =====

/// Agent 公共项目根目录：配置优先，默认 ~/AI工作台/agent；不存在则创建
fn base_dir(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    let configured = crate::store::load_config(app).agent_base_dir;
    let path = match configured {
        Some(d) if !d.trim().is_empty() => std::path::PathBuf::from(d),
        _ => {
            let home = crate::cli::fsutil::home_dir()?;
            home.join("AI工作台").join("agent")
        }
    };
    std::fs::create_dir_all(&path)
        .map_err(|e| AppError::internal(format!("创建目录 {} 失败：{e}", path.display())))?;
    Ok(path)
}

/// 读取公共项目目录（同时确保存在）
#[tauri::command]
pub async fn agent_base_dir(app: AppHandle) -> Result<String, AppError> {
    Ok(base_dir(&app)?.display().to_string())
}

/// 修改公共项目目录（目录不存在则创建）
#[tauri::command]
pub async fn agent_set_base_dir(app: AppHandle, dir: String) -> Result<String, AppError> {
    let d = dir.trim().to_string();
    let path = std::path::PathBuf::from(&d);
    if !path.is_absolute() {
        return Err(AppError::config("请选择绝对路径目录"));
    }
    std::fs::create_dir_all(&path)
        .map_err(|e| AppError::internal(format!("创建目录失败：{e}")))?;
    let mut cfg = crate::store::load_config(&app);
    cfg.agent_base_dir = Some(d);
    crate::store::save_config(&app, &cfg)?;
    Ok(path.display().to_string())
}

/// 在公共目录（或其子目录）下新建项目文件夹：名字做安全化，重名自动加序号
#[tauri::command]
pub async fn agent_create_dir(app: AppHandle, name: String, parent: Option<String>) -> Result<String, AppError> {
    // 名字安全化：保留常见字符，其余转下划线（避免路径分隔符/隐藏文件）
    let safe: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | ' ' | '.' | '(' | ')' | '（' | '）') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim().trim_matches('.').to_string();
    if safe.is_empty() {
        return Err(AppError::config("项目名不能为空"));
    }
    let base = match parent {
        Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p),
        _ => base_dir(&app)?,
    };
    let mut path = base.join(&safe);
    let mut n = 1;
    while path.exists() {
        path = base.join(format!("{safe}-{n}"));
        n += 1;
    }
    std::fs::create_dir_all(&path)
        .map_err(|e| AppError::internal(format!("创建目录失败：{e}")))?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn agent_detect() -> Result<Vec<AgentTool>, AppError> {
    // 四个 --version 并行探测（node CLI 冷启动数百毫秒，串行会卡 UI 首屏）
    let futs = ["pi", "claude", "codex", "opencode"].map(|id| async move {
        let version = match Command::new(id).arg("--version").output().await {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let s = if s.is_empty() {
                    String::from_utf8_lossy(&o.stderr).trim().to_string()
                } else {
                    s
                };
                s.split_whitespace().last().map(str::to_string)
            }
            _ => None,
        };
        AgentTool { id: id.to_string(), installed: version.is_some(), version }
    });
    Ok(futures_util::future::join_all(futs).await)
}

/// 选中的 MCP 服务器（从应用的 MCP 注册表传入；生成 claude --mcp-config 用）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentMcp {
    pub name: String,
    /// stdio | http | sse
    pub kind: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
    pub url: Option<String>,
    pub headers: std::collections::HashMap<String, String>,
}

/// 按 CLI 组装命令行。skills 为绝对路径（前端从技能分发目录解析）；
/// mcp 仅 claude 支持（--mcp-config 临时文件）；model 为会话级覆盖。
/// mode 为权限模式：normal / edit / plan / dangerous——claude 映射 permission-mode
/// （plan/edit/default）或 --dangerously-skip-permissions；codex 映射 --sandbox。
/// svc 为会话级供应商（None = 用 CLI 全局配置）：claude 走 --settings 临时文件、
/// codex 走 -c 覆写 + 密钥环境变量、opencode 走 OPENCODE_CONFIG 临时配置；
/// pi 无会话级通道（models.json 全局），前端对 pi 置灰供应商选择。
/// 返回 (Command, 需在进程结束后清理的临时文件列表)。
fn build_command(
    cli: &str,
    dir: &std::path::Path,
    prompt: &str,
    session_id: Option<&str>,
    skills: &[String],
    mcp: &[AgentMcp],
    model: Option<&str>,
    mode: Option<&str>,
    svc: Option<&crate::service::ResolvedService>,
) -> Result<(Command, Vec<std::path::PathBuf>), AppError> {
    let mode = mode.unwrap_or("normal");
    let mut cmd = Command::new(cli);
    let mut temp_files: Vec<std::path::PathBuf> = Vec::new();
    let pid = std::process::id();
    match cli {
        "claude" => {
            // prompt 必须紧跟 -p 且在 --mcp-config 之前：该参数可多值，
            // 会把其后连续的位置参数都吞成配置文件路径（实测报 MCP config file not found）
            cmd.arg("-p").arg(prompt);
            if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
                cmd.arg("--resume").arg(sid);
            }
            if let Some(m) = model {
                cmd.arg("--model").arg(m);
            }
            // 权限模式：dangerous 跳过所有审批；plan 只读规划；edit 自动接受编辑；
            // normal（default）危险工具经 can_use_tool 请求前端审批
            match mode {
                "dangerous" => {
                    cmd.arg("--dangerously-skip-permissions");
                }
                "plan" => {
                    cmd.arg("--permission-mode").arg("plan");
                }
                "edit" => {
                    cmd.arg("--permission-mode").arg("acceptEdits");
                }
                _ => {
                    cmd.arg("--permission-mode").arg("default");
                }
            }
            cmd.arg("--output-format").arg("stream-json")
                .arg("--verbose")
                // 增量流式事件（stream_event/text_delta），前端逐字渲染
                .arg("--include-partial-messages");
            // 会话级供应商：--settings 临时文件覆盖 env（优先级高于用户 settings.json）
            if let Some(svc) = svc {
                let base = svc.anthropic_base_url.as_deref().unwrap_or(&svc.base_url);
                let path = std::env::temp_dir().join(format!("agent-settings-{pid}.json"));
                let cfg = serde_json::json!({
                    "env": {
                        "ANTHROPIC_BASE_URL": base,
                        "ANTHROPIC_AUTH_TOKEN": svc.api_key,
                    }
                });
                std::fs::write(&path, cfg.to_string())
                    .map_err(|e| AppError::internal(format!("写会话供应商临时配置失败：{e}")))?;
                cmd.arg("--settings").arg(&path);
                temp_files.push(path);
            }
            // claude 的技能走分发目录自动发现（~/.claude/skills），无逐次注入参数；
            // --add-dir 是工作目录扩展不是技能，不传
            if !mcp.is_empty() {
                let path = std::env::temp_dir().join(format!("agent-mcp-{pid}.json"));
                let mut servers = serde_json::Map::new();
                for m in mcp {
                    let v = if m.kind == "http" || m.kind == "sse" {
                        serde_json::json!({
                            "type": if m.kind == "sse" { "sse" } else { "http" },
                            "url": m.url.clone().unwrap_or_default(),
                            "headers": m.headers,
                        })
                    } else {
                        serde_json::json!({
                            "command": m.command.clone().unwrap_or_default(),
                            "args": m.args,
                            "env": m.env,
                        })
                    };
                    servers.insert(m.name.clone(), v);
                }
                let cfg = serde_json::json!({ "mcpServers": servers });
                std::fs::write(&path, cfg.to_string())
                    .map_err(|e| AppError::internal(format!("写 MCP 临时配置失败：{e}")))?;
                cmd.arg("--mcp-config").arg(&path);
                temp_files.push(path);
            }
        }
        "codex" => {
            // codex exec --json 输出 JSONL；有会话 id 时 exec resume 续聊。
            // sandbox 映射：plan 只读 / edit|normal 工作区可写 / dangerous 免沙箱免审批
            let sandbox: &[&str] = match mode {
                "plan" => &["--sandbox", "read-only"],
                "dangerous" => &["--dangerously-bypass-approvals-and-sandbox"],
                _ => &["--sandbox", "workspace-write"],
            };
            // 会话级供应商：-c 覆写临时 provider（env_key 指向的环境变量持密钥），不动 config.toml
            let session_provider: Vec<String> = match svc {
                Some(svc) => {
                    let env_key = "GYWB_SESSION_KEY";
                    cmd.env(env_key, &svc.api_key);
                    let base = format!("{}/v1", svc.base_url.trim_end_matches('/'));
                    vec![
                        "model_provider=aw_session".into(),
                        format!("model_providers.aw_session.name={}", svc.label),
                        format!("model_providers.aw_session.base_url={base}"),
                        "model_providers.aw_session.wire_api=responses".into(),
                        format!("model_providers.aw_session.env_key={env_key}"),
                    ]
                }
                None => vec![],
            };
            if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
                cmd.arg("exec").arg("resume").arg("--json");
                for kv in &session_provider {
                    cmd.arg("-c").arg(kv);
                }
                if let Some(m) = model {
                    cmd.arg("--model").arg(m);
                }
                cmd.args(sandbox);
                cmd.arg(sid).arg(prompt);
            } else {
                cmd.arg("exec").arg("--json");
                for kv in &session_provider {
                    cmd.arg("-c").arg(kv);
                }
                if let Some(m) = model {
                    cmd.arg("--model").arg(m);
                }
                cmd.args(sandbox);
                cmd.arg(prompt);
            }
        }
        "opencode" => {
            // opencode run 纯文本输出
            cmd.arg("run");
            // 会话级供应商：OPENCODE_CONFIG 指向临时配置（不动 ~/.config/opencode）
            if let Some(svc) = svc {
                let path = std::env::temp_dir().join(format!("agent-opencode-{pid}.json"));
                let cfg = serde_json::json!({
                    "provider": {
                        "aw_session": {
                            "npm": "@ai-sdk/openai-compatible",
                            "options": {
                                "baseURL": format!("{}/v1", svc.base_url.trim_end_matches('/')),
                                "apiKey": svc.api_key,
                            },
                        },
                    },
                });
                std::fs::write(&path, cfg.to_string())
                    .map_err(|e| AppError::internal(format!("写会话供应商临时配置失败：{e}")))?;
                cmd.env("OPENCODE_CONFIG", &path);
                temp_files.push(path);
            }
            // --model 要求 provider/model 格式；会话供应商时用 aw_session 前缀
            if let Some(m) = model {
                let prefix = if svc.is_some() { "aw_session" } else { "ai-workbench" };
                let m = if m.contains('/') { m.to_string() } else { format!("{prefix}/{m}") };
                cmd.arg("--model").arg(m);
            }
            cmd.arg(prompt);
        }
        _ => {
            // pi：--mode json 事件流 + --session 续聊 + --skill 透传
            cmd.arg("--mode").arg("json").arg("-p");
            if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
                cmd.arg("--session").arg(sid);
            }
            for s in skills {
                cmd.arg("--skill").arg(s);
            }
            if let Some(m) = model {
                cmd.arg("--model").arg(m);
            }
            cmd.arg(prompt);
        }
    }
    cmd.current_dir(dir)
        // stdin 保留管道：claude 非 dangerous 模式的审批走 stdin 应答
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    Ok((cmd, temp_files))
}

/// 在项目目录运行一条 agent CLI 消息。session_id 为 CLI 的会话 id（续聊；
/// pi --session / claude --resume；codex、opencode 每轮独立）。
/// stdout 逐行透传给前端（各 CLI 的事件格式由前端解析）。
#[tauri::command]
pub async fn agent_run(
    _app: AppHandle,
    key: String,
    cli: Option<String>,
    dir: String,
    prompt: String,
    session_id: Option<String>,
    skills: Option<Vec<String>>,
    mcp: Option<Vec<AgentMcp>>,
    model: Option<String>,
    mode: Option<String>,
    service: Option<crate::service::ServiceRef>,
    on_event: Channel<AgentEvent>,
) -> Result<(), AppError> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(AppError::config("请输入任务内容"));
    }
    let cli = cli.unwrap_or_else(|| "pi".to_string());
    let dir = std::path::PathBuf::from(&dir);
    // 目录不存在时自动创建（默认项目的「默认」目录随首次任务落地）
    if !dir.is_dir() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::config(format!("创建项目目录 {} 失败：{e}", dir.display())))?;
    }
    if running_has(&key) {
        return Err(AppError::config("该会话已有任务在运行，请先停止"));
    }
    // 会话级供应商解析（密钥只在后端，注入到子进程环境/临时配置）
    let svc = match &service {
        Some(spec) => Some(crate::service::resolve_service(&_app, spec).await?),
        None => None,
    };

    let (mut cmd, temp_files) = build_command(
        &cli,
        &dir,
        &prompt,
        session_id.as_deref(),
        skills.as_deref().unwrap_or(&[]),
        mcp.as_deref().unwrap_or(&[]),
        model.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        mode.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        svc.as_ref(),
    )?;
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::config(format!("启动 {cli} 失败（未安装或不在 PATH）：{e}")))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let stdin = child.stdin.take();
    running_insert(&key, RunningProc { child, stdin })?;

    // stdout：逐行透传（各 CLI 的事件流每行一个 JSON 或纯文本）
    let ch_out = on_event.clone();
    let mut read_stdout = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if ch_out.send(AgentEvent::Line { line }).is_err() {
                break; // 前端已不可达（窗口关闭），停止转发
            }
        }
    });

    // stderr：采集摘要（pi 报错如缺 API key 走这里）；读到 EOF（进程退出）为止
    let mut stderr_buf: Vec<u8> = Vec::new();
    use tokio::io::AsyncReadExt as _;
    let _ = stderr.read_to_end(&mut stderr_buf).await;
    // stdout 转发收尾后再发 Done，保证事件顺序（行全部到达前端之后才结束）
    let _ = (&mut read_stdout).await;

    // 等 child：正常路径——从表里 take 出来 wait；被停止路径——表里已没有
    let (code, stopped) = match running_take(&key) {
        Ok(Some(mut p)) => match p.child.wait().await {
            Ok(s) => (s.code().unwrap_or(-1), false),
            Err(e) => return Err(AppError::internal(format!("等待进程退出失败：{e}"))),
        },
        Ok(None) => (-1, true), // agent_stop 已取走并 kill
        Err(e) => return Err(e),
    };
    for f in &temp_files {
        let _ = std::fs::remove_file(f);
    }
    if stopped {
        let _ = on_event.send(AgentEvent::Done { code: -1, stopped: true });
        return Ok(());
    }
    if code != 0 {
        let msg = String::from_utf8_lossy(&stderr_buf).trim().to_string();
        // 缺密钥等错误正文在 stderr；截断保护
        let msg: String = msg.chars().take(600).collect();
        let _ = on_event.send(AgentEvent::Error {
            message: if msg.is_empty() { format!("{cli} 退出码 {code}") } else { msg },
        });
        return Ok(());
    }
    let _ = on_event.send(AgentEvent::Done { code, stopped: false });
    Ok(())
}

/// 停止会话当前运行的 agent 进程（kill_on_drop + 显式 kill）
#[tauri::command]
pub async fn agent_stop(key: String) -> Result<bool, AppError> {
    // 取出进程后 Drop 即 kill（kill_on_drop）；跨 await 显式 kill 一次更稳
    if let Some(mut p) = RUNNING
        .lock()
        .map_err(|_| AppError::internal("agent 进程表锁 poisoned"))?
        .as_mut()
        .and_then(|m| m.remove(&key))
    {
        let _ = p.child.start_kill();
        Ok(true)
    } else {
        Ok(false)
    }
}
