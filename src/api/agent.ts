/** Agent API：项目目录内非交互运行所选 CLI（pi/claude/codex/opencode），
 * stdout 逐行透传，前端按 CLI 解析各自事件格式。 */

import { Channel, invoke } from '@tauri-apps/api/core'
import { call } from './ipc'

/** Rust → 前端事件（透传 stdout 单行，或进程级错误/结束） */
export type AgentEvent =
  | { kind: 'line'; line: string }
  | { kind: 'done'; code: number; stopped: boolean }
  | { kind: 'error'; message: string }

export interface AgentTool {
  id: string
  installed: boolean
  version: string | null
}

/** 传给 claude --mcp-config 的服务器（从应用 MCP 注册表选取） */
export interface AgentMcp {
  name: string
  kind: string
  command?: string | null
  args: string[]
  env: Record<string, string>
  url?: string | null
  headers: Record<string, string>
}

export const agentApi = {
  detect: () => call<AgentTool[]>('agent_detect'),
  /** 运行一条消息；sessionId 为 CLI 会话 id（续聊）；skills 为技能目录绝对路径 */
  run: (args: {
    key: string
    cli?: string
    dir: string
    prompt: string
    sessionId?: string
    skills?: string[]
    mcp?: AgentMcp[]
    /** 会话级模型覆盖（空 = 该 CLI 全局默认） */
    model?: string
    /** 权限模式 normal/edit/plan/dangerous（claude/codex 支持） */
    mode?: string
    /** 会话级供应商（ServiceRef：gateway 令牌或 stored 供应商）；空 = CLI 全局配置 */
    service?: Record<string, unknown>
    onEvent: (e: AgentEvent) => void
  }) => {
    const ch = new Channel<AgentEvent>()
    ch.onmessage = args.onEvent
    return invoke<void>('agent_run', {
      key: args.key,
      cli: args.cli ?? 'pi',
      dir: args.dir,
      prompt: args.prompt,
      sessionId: args.sessionId ?? null,
      skills: args.skills ?? [],
      mcp: args.mcp ?? [],
      model: args.model ?? null,
      mode: args.mode ?? null,
      service: args.service ?? null,
      onEvent: ch,
    })
  },
  stop: (key: string) => call<boolean>('agent_stop', { key }),
  /** 向运行中进程 stdin 写一行 JSON（claude 审批应答 control_response） */
  respond: (key: string, line: string) => call<void>('agent_stdin_write', { key, line }),
  /** 公共项目根目录（不存在则自动创建） */
  baseDir: () => call<string>('agent_base_dir'),
  /** 修改公共项目根目录 */
  setBaseDir: (dir: string) => call<string>('agent_set_base_dir', { dir }),
  /** 在公共目录下新建项目文件夹（重名自动加序号），返回完整路径 */
  createDir: (name: string, parent?: string) =>
    call<string>('agent_create_dir', { name, parent: parent ?? null }),
}
