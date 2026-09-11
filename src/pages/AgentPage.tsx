import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App, Button, Cascader, Divider, Dropdown, Empty, Input, Modal, Popconfirm, Select, Switch, Tag, Tooltip } from 'antd'
import { Bot, FileCode2, FolderOpen, FolderSearch, MessageSquarePlus, Settings2, Shrink, SlidersHorizontal, SquareX, Terminal, Wrench } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { MdPreview } from '../components/common/MdPreview'
import { useUiStore } from '../stores/ui'
import { agentApi, type AgentEvent, type AgentMcp } from '../api/agent'
import { cliApi } from '../api/cli'
import { skillApi, type Skill, type SkillTarget } from '../api/skills'
import { mcpApi, type McpView } from '../api/mcp'
import { errText } from '../lib/err'

/** 项目 = 一个目录 + 若干会话；会话 = 某 CLI 的连续对话 */
interface AgentProject {
  id: string
  name: string
  dir: string
  createdAt: number
}
interface AgentSession {
  id: string
  projectId: string
  title: string
  /** CLI 会话 id（pi --session / claude --resume 续聊） */
  cliSessionId?: string
  /** 会话使用的 CLI（pi/claude/codex/opencode） */
  cli: string
  /** 旧版按会话选择的技能/MCP（已废弃：默认全量载入），仅为兼容旧数据保留 */
  skills?: string[]
  mcp?: string[]
  /** 会话级模型覆盖（空 = 该 CLI 全局默认，不影响其他会话） */
  model?: string
  /** 会话级供应商 key（'p:uuid'；空 = CLI 全局配置） */
  serviceKey?: string
  /** 权限模式 normal/edit/plan/dangerous（claude/codex 支持；pi/opencode 暂不支持） */
  mode?: string
  createdAt: number
  updatedAt: number
}
/** 会话内条目：用户消息 / 助手回复（流式追加）/ 工具调用 / 审批请求 / 错误 */
interface Item {
  kind: 'user' | 'assistant' | 'tool' | 'approval' | 'error' | 'stopped'
  text: string
  tool?: string
  /** codex item 对齐用 / claude control_request 的 request_id */
  ref?: string
  /** claude 审批：原始 input JSON（允许时回传 updatedInput） */
  input?: string
  /** 审批决定（已应答后展示） */
  choice?: 'allow' | 'deny'
  done?: boolean
}

/** 权限模式：普通（default/workspace-write）/ 编辑（acceptEdits）/ 计划（plan/read-only）/ 危险（跳过审批） */
const AGENT_MODES = [
  { value: 'normal', label: '默认' },
  { value: 'edit', label: '编辑' },
  { value: 'plan', label: '计划' },
  { value: 'dangerous', label: '危险' },
]
/** 支持权限模式的 CLI（其余 CLI 选择器置灰） */
const MODE_SUPPORTED: Record<string, boolean> = { claude: true, codex: true }
/** 支持会话级供应商切换的 CLI（pi 按 models.json 全局，仅可切模型） */
const PROVIDER_SUPPORTED: Record<string, boolean> = { claude: true, codex: true, opencode: true }

/** 供应商→模型 Cascader 的选项节点 */
type CascadeLeaf = { value: string; label: string }
type CascadeNode = { value: string; label: string; isLeaf?: boolean; children?: CascadeLeaf[] }

const PROJECTS_KEY = 'agent-projects'
const SESSIONS_KEY = 'agent-sessions'
const ITEMS_PREFIX = 'agent-items:'
const uid = () => `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
/** 公共默认项目（固定 id）：首页「新建任务」直接在它下面开会话 */
const DEFAULT_PID = 'default'

const CLI_LABEL: Record<string, string> = {
  pi: 'pi',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

/** 各 CLI 的内置命令（输入 / 唤起；整条透传给 CLI 处理，非交互模式不支持的会退化为普通提示词） */
const BUILTIN_COMMANDS: Record<string, { name: string; desc: string }[]> = {
  pi: [
    { name: 'compact', desc: '压缩上下文（总结旧消息释放窗口）' },
    { name: 'model', desc: '查看/切换模型' },
    { name: 'new', desc: '开始新会话' },
    { name: 'session', desc: '会话信息' },
    { name: 'tree', desc: '会话分支树' },
    { name: 'fork', desc: '从当前位置开分支' },
    { name: 'export', desc: '导出会话' },
    { name: 'copy', desc: '复制最后回复' },
    { name: 'settings', desc: '打开设置' },
    { name: 'login', desc: '登录供应商' },
    { name: 'logout', desc: '退出登录' },
  ],
  claude: [
    { name: 'compact', desc: '压缩上下文' },
    { name: 'clear', desc: '清空历史' },
    { name: 'context', desc: '上下文占用详情' },
    { name: 'cost', desc: '用量统计' },
    { name: 'model', desc: '切换模型' },
    { name: 'mcp', desc: 'MCP 服务器管理' },
    { name: 'memory', desc: '编辑记忆文件' },
    { name: 'init', desc: '生成项目 CLAUDE.md' },
    { name: 'review', desc: '代码审查' },
    { name: 'rewind', desc: '回退对话/代码' },
    { name: 'export', desc: '导出会话' },
    { name: 'status', desc: '状态一览' },
    { name: 'doctor', desc: '安装诊断' },
  ],
  codex: [
    { name: 'compact', desc: '压缩上下文' },
    { name: 'init', desc: '生成项目 AGENTS.md' },
    { name: 'model', desc: '切换模型' },
    { name: 'review', desc: '代码审查' },
    { name: 'diff', desc: '查看变更' },
    { name: 'status', desc: '状态一览' },
  ],
  opencode: [
    { name: 'compact', desc: '压缩上下文' },
    { name: 'init', desc: '生成项目说明' },
    { name: 'undo', desc: '撤销上一步' },
    { name: 'redo', desc: '重做' },
    { name: 'new', desc: '新会话' },
  ],
}

/** 会话用量统计（从 CLI 事件流的 usage 字段解析；单位 token） */
interface SessionUsage {
  /** 上下文规模 = 输入 + 缓存读 + 缓存写（最近一条 assistant 消息） */
  ctx: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** 上一条 usage 的签名：流式事件会重复携带同一份 usage，去重防输出重复累加 */
  sig?: string
}
const EMPTY_USAGE: SessionUsage = { ctx: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
const USAGE_PREFIX = 'agent-usage:'

/** 从 usage 对象提取统计（兼容 pi {input,cacheRead} / claude {input_tokens,cache_read_input_tokens} / codex 等命名） */
function extractUsage(v: unknown, depth = 0): SessionUsage | null {
  if (depth > 6 || typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  // codex token_count：info 同时带 total_token_usage（整次运行累计）与 last_token_usage（本条请求），
  // 累加口径用 last，取 total 会跨轮双计
  if (typeof o.last_token_usage === 'object' && o.last_token_usage !== null) {
    return extractUsage(o.last_token_usage, depth + 1)
  }
  const num = (...keys: string[]): number | null => {
    for (const k of keys) {
      const x = o[k]
      if (typeof x === 'number' && x >= 0) return x
    }
    return null
  }
  const input = num('input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
  const output = num('output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
  if (input != null || output != null) {
    const cacheRead = num('cacheRead', 'cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens', 'cachedInputTokens', 'cached_input_tokens') ?? 0
    const cacheWrite = num('cacheWrite', 'cacheWriteTokens', 'cache_write_tokens', 'cache_creation_input_tokens') ?? 0
    return { ctx: (input ?? 0) + cacheRead + cacheWrite, cacheRead, cacheWrite, output: output ?? 0 }
  }
  for (const x of Object.values(o)) {
    const r = extractUsage(x, depth + 1)
    if (r) return r
  }
  return null
}

function parseUsageLine(line: string): SessionUsage | null {
  const t = line.trim()
  if (!t.startsWith('{') || !t.includes('usage')) return null
  try {
    const v = JSON.parse(t) as { type?: unknown }
    // claude result 事件的 usage 是整次运行累计，与逐条 assistant 的相加会双计，跳过
    if (v.type === 'result') return null
    return extractUsage(v)
  } catch {
    return null
  }
}

/** 12.3k / 1.2M 格式 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** 上下文环形进度条（SVG，随百分比变色） */
function ContextRing({ pct }: { pct: number }) {
  const r = 9
  const circ = 2 * Math.PI * r
  const color = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#22c55e'
  return (
    <svg width="22" height="22" className="shrink-0">
      <circle cx="11" cy="11" r={r} fill="none" strokeWidth="2.5" className="text-gray-200 dark:text-gray-700" stroke="currentColor" />
      <circle
        cx="11" cy="11" r={r} fill="none" strokeWidth="2.5" stroke={color}
        strokeDasharray={circ} strokeDashoffset={circ - (pct / 100) * circ}
        transform="rotate(-90 11 11)" strokeLinecap="round"
      />
    </svg>
  )
}

/** 模型 → 上下文窗口大小（token）。1M 模型：GLM 5.x+、DeepSeek v4、GPT 4.1+/5/6、Claude 5.x；
 * 其余默认 200k。模型名带 [1M] 后缀的也视为 1M。 */
function contextWindow(model: string): number {
  const m = (model || '').toLowerCase()
  if (/\[1m\]/.test(m)) return 1_000_000
  if (/glm.*5/.test(m)) return 1_000_000
  if (/deepseek.*v?4/.test(m)) return 1_000_000
  if (/gpt-?4\.1/.test(m) || /gpt-?[56]/.test(m)) return 1_000_000
  if (/claude.*5/.test(m) || /claude.*fable/.test(m)) return 1_000_000
  return 200_000
}

const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') as T
  } catch {
    return fallback
  }
}
const saveItems = (sessionId: string, items: Item[]) => {
  try {
    localStorage.setItem(`${ITEMS_PREFIX}${sessionId}`, JSON.stringify(items.slice(-300)))
  } catch {
    /* 超配额忽略 */
  }
}

export default function AgentPage() {
  const { message } = App.useApp()
  const [projects, setProjects] = useState<AgentProject[]>(() => loadJson<AgentProject[]>(PROJECTS_KEY, []))
  const [sessions, setSessions] = useState<AgentSession[]>(() => loadJson<AgentSession[]>(SESSIONS_KEY, []))
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [itemsBy, setItemsBy] = useState<Record<string, Item[]>>({})
  const [input, setInput] = useState('')
  const [runningId, setRunningId] = useState<string | null>(null)
  // 公共项目目录 + 新建项目弹窗
  const [baseDir, setBaseDir] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [cfgOpen, setCfgOpen] = useState(false)
  const [projName, setProjName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState('')
  // 会话配置选项数据
  const [skills, setSkills] = useState<Skill[]>([])
  const [skillTargets, setSkillTargets] = useState<SkillTarget[]>([])
  const [mcps, setMcps] = useState<McpView[]>([])
  const [providers, setProviders] = useState<{ id: string; name: string; enabled: number; baseUrl: string; secretRef: string; kind: string; anthropicBaseUrl?: string | null }[]>([])
  const [svcModels, setSvcModels] = useState<Record<string, string[]>>({})
  // 各 CLI 的全局默认模型（cli_current_status 读取其配置文件），新会话用它回填
  const [cliDefaults, setCliDefaults] = useState<Record<string, string | undefined>>({})
  // 各会话用量统计（上下文/缓存命中/输出）
  const [usageBy, setUsageBy] = useState<Record<string, SessionUsage>>({})
  const mdTheme = useUiStore((s) => (s.theme === 'dark' ? 'github-dark' : 'github'))
  const agentCli = useUiStore((s) => s.agentCli)
  const agentSkillsOff = useUiStore((s) => s.agentSkillsOff)
  const agentMcpsOff = useUiStore((s) => s.agentMcpsOff)
  const setAgentCli = useUiStore((s) => s.setAgentCli)
  const setAgentSkillsOff = useUiStore((s) => s.setAgentSkillsOff)
  const setAgentMcpsOff = useUiStore((s) => s.setAgentMcpsOff)
  const location = useLocation()
  const listRef = useRef<HTMLDivElement>(null)
  // 自动吸底：流式输出时跟随滚动；用户上翻阅读历史时暂停，滚回底部或发新消息后恢复
  const stickBottom = useRef(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createRequested = useRef(false)
  // claude 流式：本条 assistant 是否已通过 stream_event 增量渲染（避免 assistant 消息再追加一次文本）
  const streamedText = useRef<Record<string, boolean>>({})

  const project = projects.find((p) => p.id === activeProjectId) ?? null
  const session = sessions.find((s) => s.id === activeSessionId) ?? null
  const items = (activeSessionId ? itemsBy[activeSessionId] : undefined) ?? []
  const usage = (activeSessionId ? usageBy[activeSessionId] : undefined) ?? EMPTY_USAGE

  // ===== 会话级供应商（启用中的供应商） =====

  /** serviceKey → ServiceRef 载荷（stored；密钥留在后端） */
  const specOf = (key: string): Record<string, unknown> | undefined => {
    if (!key) return undefined
    const p = providers.find((x) => x.id === key.slice(2))
    if (!p) return undefined
    return {
      kind: 'stored',
      baseUrl: p.baseUrl,
      secretRef: p.secretRef,
      label: p.name,
      apiFormat: p.kind,
      anthropicBaseUrl: p.anthropicBaseUrl || undefined,
    }
  }

  /** 拉取供应商的模型列表（缓存；claude 会话取 anthropic 端口，其余 openai）——Cascader 展开与当前值回显共用 */
  const ensureSvcModels = (key: string) => {
    if (!key || svcModels[key]) return
    const spec = specOf(key)
    if (!spec) return
    setSvcModels((p) => ({ ...p, [key]: [] }))
    cliApi
      .models(spec as never, (spec as { anthropicBaseUrl?: string }).anthropicBaseUrl)
      .then((r) => {
        const list =
          session?.cli === 'claude' && r.anthropic.length > 0 ? r.anthropic : r.openai
        setSvcModels((p) => ({ ...p, [key]: list }))
      })
      .catch(() => setSvcModels((p) => ({ ...p, [key]: [] })))
  }

  // 当前会话已选供应商的模型预载，保证 Cascader 回显出模型名而不是原始 key
  useEffect(() => {
    if (session?.serviceKey) ensureSvcModels(session.serviceKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.serviceKey])

  /** 供应商→模型 二级 Cascader 选项：「默认（CLI 全局）」分支 = 网关默认令牌模型；pi 无供应商通道，只保留默认分支的模型切换 */
  const svcCascadeOptions = useMemo(() => {
    const cli = session?.cli ?? ''
    const curKey = session?.serviceKey ?? ''
    const curModel = session?.model
    const leaf = (list: string[]) => list.map((m) => ({ value: m, label: m }))
    // 当前选中模型不在列表时补进去，避免 Cascader 回显成原始 value
    const nodeOf = (key: string, label: string): CascadeNode => {
      const cached = svcModels[key]
      const node: CascadeNode = { value: key, label, isLeaf: false }
      if (cached) {
        node.children = leaf([
          ...(curKey === key && curModel && !cached.includes(curModel) ? [curModel] : []),
          ...cached,
        ])
      }
      return node
    }
    const defList = curKey === '' && curModel ? [curModel] : []
    const opts: CascadeNode[] = [{ value: '', label: '默认（CLI 全局）', children: leaf(defList) }]
    if (PROVIDER_SUPPORTED[cli]) {
      for (const p of providers.filter((p) => p.enabled === 1)) opts.push(nodeOf(`p:${p.id}`, p.name))
    }
    return opts
  }, [providers, svcModels, session?.cli, session?.serviceKey, session?.model])

  useEffect(() => {
    skillApi.list().then(setSkills).catch(() => {})
    skillApi.targets().then(setSkillTargets).catch(() => {})
    mcpApi.list().then(setMcps).catch(() => {})
    agentApi.baseDir().then(setBaseDir).catch(() => {})
    cliApi
      .currentStatus()
      .then((list) => setCliDefaults(Object.fromEntries(list.map((c) => [c.tool, c.model ?? undefined]))))
      .catch(() => {})
    // 供应商选择数据
    import('../db/providers')
      .then(({ providerRepo }) => providerRepo.list())
      .then((list) => setProviders(list))
      .catch(() => {})
    // 首页「新建任务」：等公共目录就绪后直接在默认项目里开会话（见下方 effect）
    if ((location.state as { create?: boolean } | null)?.create) {
      createRequested.current = true
      window.history.replaceState({}, '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
  }, [projects])
  useEffect(() => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
  }, [sessions])
  useEffect(() => {
    if (!activeSessionId || items.length === 0) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const sid = activeSessionId
    saveTimer.current = setTimeout(() => saveItems(sid, itemsBy[sid] ?? []), 1200)
  }, [items, activeSessionId, itemsBy])

  // 切换会话直接跳到底部
  useEffect(() => {
    stickBottom.current = true
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [activeSessionId])
  // 新增/流式更新条目时吸底（用户上翻阅读历史时不动）
  useEffect(() => {
    if (stickBottom.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [items])

  // 公共默认项目目录：<baseDir>/默认
  const defaultDir = baseDir ? `${baseDir.replace(/\/+$/, '')}/默认` : ''
  const defaultProject = projects.find((p) => p.id === DEFAULT_PID) ?? null
  const otherProjects = projects.filter((p) => p.id !== DEFAULT_PID)

  // 自动 provision 默认项目（跟随公共目录；换目录时同步路径）
  useEffect(() => {
    if (!defaultDir) return
    if (defaultProject) {
      if (defaultProject.dir !== defaultDir) {
        setProjects((prev) => prev.map((p) => (p.id === DEFAULT_PID ? { ...p, dir: defaultDir } : p)))
      }
      return
    }
    setProjects((prev) =>
      prev.some((p) => p.id === DEFAULT_PID)
        ? prev
        : [{ id: DEFAULT_PID, name: '默认', dir: defaultDir, createdAt: 0 }, ...prev],
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultDir])

  // 未选中项目时：优先默认项目，并恢复其最近会话
  useEffect(() => {
    if (activeProjectId || projects.length === 0) return
    const first = defaultProject ?? [...projects].sort((a, b) => b.createdAt - a.createdAt)[0]
    setActiveProjectId(first.id)
    const last = [...sessions]
      .filter((s) => s.projectId === first.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (last) openSession(last.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, activeProjectId])

  // 首页「新建任务」：公共目录就绪后，直接在默认项目里开新会话并聚焦输入
  useEffect(() => {
    if (!createRequested.current || !defaultDir) return
    createRequested.current = false
    const def = defaultProject ?? { id: DEFAULT_PID, name: '默认', dir: defaultDir, createdAt: 0 }
    setActiveProjectId(def.id)
    createSessionIn(def)
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 200)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultDir, defaultProject])

  const openSession = (id: string) => {
    setActiveSessionId(id)
    setItemsBy((prev) => (prev[id] ? prev : { ...prev, [id]: loadJson<Item[]>(`${ITEMS_PREFIX}${id}`, []) }))
    setUsageBy((prev) => (prev[id] ? prev : { ...prev, [id]: loadJson<SessionUsage>(`${USAGE_PREFIX}${id}`, EMPTY_USAGE) }))
  }

  const openCreate = () => {
    setProjName('')
    setCreateErr('')
    setCreateOpen(true)
  }

  /** 落库项目并立即开一个会话（新建任务即达可输入状态） */
  const addProject = (dir: string, name?: string) => {
    const exist = projects.find((p) => p.dir === dir)
    if (exist) {
      setActiveProjectId(exist.id)
      setCreateOpen(false)
      return
    }
    const p: AgentProject = { id: uid(), name: name || dir.split('/').pop() || dir, dir, createdAt: Date.now() }
    const s: AgentSession = {
      id: uid(),
      projectId: p.id,
      title: '新会话',
      cli: agentCli,
      model: cliDefaults[agentCli],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    setProjects((prev) => [p, ...prev])
    setSessions((prev) => [...prev, s])
    setActiveProjectId(p.id)
    setActiveSessionId(s.id)
    setItemsBy((prev) => ({ ...prev, [s.id]: [] }))
    setCreateOpen(false)
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 150)
  }

  /** 在公共目录下创建项目子目录 */
  const submitCreate = async () => {
    const name = projName.trim()
    if (!name || creating) return
    setCreating(true)
    setCreateErr('')
    try {
      const dir = await agentApi.createDir(name)
      addProject(dir, name)
    } catch (e) {
      setCreateErr(errText(e))
    } finally {
      setCreating(false)
    }
  }

  /** 兜底：自选任意目录作为项目 */
  const pickCustomDir = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({ directory: true, title: '选择项目目录' })
    if (typeof picked !== 'string' || !picked) return
    addProject(picked)
  }

  /** 修改公共项目目录 */
  const changeBaseDir = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({ directory: true, title: '选择公共项目目录' })
    if (typeof picked !== 'string' || !picked) return
    try {
      setBaseDir(await agentApi.setBaseDir(picked))
    } catch {
      /* 保持原值 */
    }
  }

  const createModal = (
    <Modal
      title="新建项目"
      open={createOpen}
      onCancel={() => setCreateOpen(false)}
      onOk={() => void submitCreate()}
      okText="创建"
      confirmLoading={creating}
      okButtonProps={{ disabled: !projName.trim() }}
      destroyOnHidden
    >
      <Input
        value={projName}
        onChange={(e) => setProjName(e.target.value)}
        placeholder="项目名，如：周报自动化"
        onPressEnter={() => void submitCreate()}
        autoFocus
      />
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-gray-400">
        <span className="min-w-0 flex-1 truncate" title={baseDir ? `${baseDir}/${projName.trim()}` : ''}>
          将创建于 {baseDir || '…'}/{projName.trim() || '…'}
        </span>
        <Button type="link" size="small" icon={<FolderSearch size={13} />} onClick={() => void pickCustomDir()}>
          选择其他目录
        </Button>
      </div>
      {createErr && <div className="mt-1 text-xs text-rose-500">{createErr}</div>}
    </Modal>
  )

  /** Agent 公共配置：默认 CLI + 技能/MCP 全局开关（所有会话生效） */
  const cfgModal = (
    <Modal title="Agent 公共配置" open={cfgOpen} footer={null} onCancel={() => setCfgOpen(false)} width={440} destroyOnHidden>
      <div className="flex flex-col gap-4 py-1">
        <div className="flex items-center justify-between">
          <span className="text-sm">默认 CLI</span>
          <Select
            size="small"
            style={{ width: 160 }}
            value={agentCli}
            onChange={setAgentCli}
            options={['pi', 'claude', 'codex', 'opencode'].map((id) => ({
              value: id,
              label: CLI_LABEL[id] ?? id,
            }))}
          />
        </div>
        <Divider style={{ margin: 0 }} />
        <div>
          <div className="mb-2">
            <span className="text-sm">技能</span>
            <span className="ml-2 text-xs text-gray-400">默认载入开启项；输入 / 可单独唤起</span>
          </div>
          <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto">
            {skills.length === 0 && <span className="text-xs text-gray-400">暂无技能</span>}
            {skills.map((s) => (
              <div key={s.name} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-xs" title={s.description}>
                  {s.displayName || s.name}
                </span>
                <Switch
                  size="small"
                  checked={!agentSkillsOff.includes(s.name)}
                  onChange={(on) =>
                    setAgentSkillsOff(on ? agentSkillsOff.filter((n) => n !== s.name) : [...agentSkillsOff, s.name])
                  }
                />
              </div>
            ))}
          </div>
        </div>
        <Divider style={{ margin: 0 }} />
        <div>
          <div className="mb-2">
            <span className="text-sm">MCP</span>
            <span className="ml-2 text-xs text-gray-400">开启项注入 Claude Code 会话（--mcp-config）</span>
          </div>
          <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto">
            {mcps.length === 0 && <span className="text-xs text-gray-400">暂无 MCP 服务器</span>}
            {mcps.map((m) => (
              <div key={m.entry.name} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-xs" title={m.entry.desc ?? undefined}>
                  {m.entry.name}
                </span>
                <Switch
                  size="small"
                  checked={!agentMcpsOff.includes(m.entry.name)}
                  onChange={(on) =>
                    setAgentMcpsOff(on ? agentMcpsOff.filter((n) => n !== m.entry.name) : [...agentMcpsOff, m.entry.name])
                  }
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )

  const removeProject = (p: AgentProject) => {
    if (runningId && sessions.some((s) => s.projectId === p.id && s.id === runningId)) return
    sessions.filter((s) => s.projectId === p.id).forEach((s) => localStorage.removeItem(`${ITEMS_PREFIX}${s.id}`))
    setProjects((prev) => prev.filter((x) => x.id !== p.id))
    setSessions((prev) => prev.filter((x) => x.projectId !== p.id))
    if (activeProjectId === p.id) {
      setActiveProjectId(null)
      setActiveSessionId(null)
    }
  }

  /** 在指定项目里开新会话（CLI 用设置页的全局默认，模型回填该 CLI 的全局默认） */
  const createSessionIn = (proj: AgentProject) => {
    const s: AgentSession = {
      id: uid(),
      projectId: proj.id,
      title: '新会话',
      cli: agentCli,
      model: cliDefaults[agentCli],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    setSessions((prev) => [...prev, s])
    setActiveSessionId(s.id)
    setItemsBy((prev) => ({ ...prev, [s.id]: [] }))
  }

  const newSession = () => {
    if (!project) return
    createSessionIn(project)
  }

  const patchSession = (patch: Partial<AgentSession>) => {
    if (!session) return
    setSessions((prev) => prev.map((x) => (x.id === session.id ? { ...x, ...patch } : x)))
  }

  const removeSession = (s: AgentSession) => {
    if (s.id === runningId) return
    localStorage.removeItem(`${ITEMS_PREFIX}${s.id}`)
    setSessions((prev) => prev.filter((x) => x.id !== s.id))
    if (activeSessionId === s.id) setActiveSessionId(null)
  }

  // ===== 事件流解析（按 CLI 适配） =====

  const appendItem = (sid: string, item: Item) =>
    setItemsBy((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), item] }))

  const setCliSession = (sid: string, id: string) =>
    setSessions((prev) => prev.map((x) => (x.id === sid ? { ...x, cliSessionId: id } : x)))

  /** assistant 文本：mode=stream 追加到最后一个未完成气泡，mode=new 新开 */
  const appendAssistant = (sid: string, text: string, mode: 'stream' | 'new') =>
    setItemsBy((prev) => {
      const list = prev[sid] ?? []
      const last = list[list.length - 1]
      if (mode === 'stream' && last?.kind === 'assistant' && !last.done) {
        return { ...prev, [sid]: [...list.slice(0, -1), { ...last, text: last.text + text }] }
      }
      return { ...prev, [sid]: [...list, { kind: 'assistant', text, done: false }] }
    })

  const markToolDone = (sid: string, ref: string | undefined, toolName: string | undefined, failed = false) =>
    setItemsBy((prev) => {
      const list = prev[sid] ?? []
      for (let i = list.length - 1; i >= 0; i--) {
        const t = list[i]
        if (t.kind !== 'tool' || t.done) continue
        if (ref ? t.ref === ref : t.tool === (toolName ?? 'tool')) {
          const next = [...list]
          next[i] = { ...t, done: true, text: t.text + (failed ? ' · 失败' : '') }
          return { ...prev, [sid]: next }
        }
      }
      return prev
    })

  /** 单行 stdout → 条目。pi=JSON 事件流；claude=stream-json；codex=JSONL；opencode/未知=纯文本 */
  const applyLine = (sid: string, cli: string, raw: string) => {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(raw) as Record<string, unknown>
    } catch {
      if (raw.trim()) appendAssistant(sid, `${raw}\n`, cli === 'opencode' ? 'stream' : 'new')
      return
    }
    if (cli === 'pi') {
      switch (ev.type) {
        case 'session':
          if (typeof ev.id === 'string') setCliSession(sid, ev.id)
          return
        case 'message_update': {
          const ame = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined
          if (ame?.type === 'text_delta' && ame.delta) appendAssistant(sid, ame.delta, 'stream')
          return
        }
        case 'tool_execution_start':
          appendItem(sid, {
            kind: 'tool',
            tool: (ev.toolName as string) ?? 'tool',
            text: fmtArgs(ev.args),
            done: false,
          })
          return
        case 'tool_execution_end':
          markToolDone(sid, undefined, ev.toolName as string, ev.isError === true)
          return
        default:
          return
      }
    }
    if (cli === 'claude') {
      switch (ev.type) {
        case 'system':
          if (typeof ev.session_id === 'string') setCliSession(sid, ev.session_id)
          return
        case 'stream_event': {
          // 增量流式：text_delta 逐字追加到当前助手气泡
          const evt = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined
          if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            streamedText.current[sid] = true
            appendAssistant(sid, evt.delta.text, 'stream')
          }
          return
        }
        case 'control_request': {
          // claude 请求工具审批（can_use_tool）：展示卡片让用户允许/拒绝
          const req = ev.request as { subtype?: string; tool_name?: string; input?: unknown } | undefined
          if (req?.subtype === 'can_use_tool') {
            appendItem(sid, {
              kind: 'approval',
              tool: req.tool_name ?? 'tool',
              text: fmtArgs(req.input),
              input: req.input ? JSON.stringify(req.input) : '{}',
              ref: typeof ev.request_id === 'string' ? ev.request_id : undefined,
              done: false,
            })
          }
          return
        }
        case 'assistant': {
          const msg = ev.message as { content?: Array<Record<string, unknown>> } | undefined
          const streamed = !!streamedText.current[sid]
          for (const block of msg?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string') {
              // 已通过 stream_event 增量渲染过则不重复追加
              if (!streamed) appendAssistant(sid, block.text, 'new')
            } else if (block.type === 'tool_use') {
              appendItem(sid, {
                kind: 'tool',
                tool: (block.name as string) ?? 'tool',
                text: fmtArgs(block.input),
                done: true,
              })
            }
          }
          streamedText.current[sid] = false
          return
        }
        default:
          return
      }
    }
    if (cli === 'codex') {
      if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
        setCliSession(sid, ev.thread_id)
        return
      }
      if (ev.type === 'item.started' || ev.type === 'item.completed') {
        const item = ev.item as Record<string, unknown> | undefined
        const id = item?.id as string | undefined
        if (item?.type === 'agent_message') {
          if (ev.type === 'item.completed' && typeof item.text === 'string') {
            appendAssistant(sid, item.text, 'new')
          }
          return
        }
        if (ev.type === 'item.started') {
          appendItem(sid, {
            kind: 'tool',
            tool: String(item?.type ?? 'tool'),
            text: fmtArgs({ command: item?.command, path: item?.changes, name: item?.name }),
            ref: id,
            done: false,
          })
        } else {
          markToolDone(sid, id, undefined)
        }
        return
      }
      if (ev.type === 'error' && typeof ev.message === 'string') {
        appendItem(sid, { kind: 'error', text: ev.message })
      }
      return
    }
    // opencode 等：整行当文本
    appendAssistant(sid, `${raw}\n`, 'stream')
  }

  const onEvent = (sid: string, cli: string) => (e: AgentEvent) => {
    if (e.kind === 'error') {
      setRunningId(null)
      appendItem(sid, { kind: 'error', text: e.message })
      return
    }
    if (e.kind === 'done') {
      setRunningId(null)
      if (e.stopped) appendItem(sid, { kind: 'stopped', text: '已停止' })
      setItemsBy((prev) => ({
        ...prev,
        [sid]: (prev[sid] ?? []).map((x) => (x.done ? x : { ...x, done: true })),
      }))
      return
    }
    // usage 统计：事件流里带 usage 的行（pi message_update/end / claude assistant / codex token_count）。
    // 上下文/缓存取最新一轮（即当前上下文规模），输出按 usage 签名去重后跨轮累加
    //（流式事件会重复携带同一份 usage，不去重会重复累加输出）。
    const u = parseUsageLine(e.line)
    if (u) {
      setUsageBy((prev) => {
        const prevU = prev[sid] ?? EMPTY_USAGE
        const sig = `${u.ctx}/${u.output}/${u.cacheRead}/${u.cacheWrite}`
        // 完整 usage（带输入侧）才更新上下文规模并累加输出；流式增量 usage（claude
        // message_delta 只带 output_tokens，ctx=0）里 output 是累计增长值，再累加会双计，
        // 且不能让它把上一轮的上下文规模覆写没——否则回答过程中百分比会消失
        const full = u.ctx > 0
        const output = !full || sig === prevU.sig ? prevU.output : prevU.output + u.output
        const next: SessionUsage = { ...prevU, ...(full ? u : {}), output, sig }
        try {
          localStorage.setItem(`${USAGE_PREFIX}${sid}`, JSON.stringify(next))
        } catch {
          /* 超配额忽略 */
        }
        return { ...prev, [sid]: next }
      })
    }
    applyLine(sid, cli, e.line)
  }

  // ===== 发送 =====

  /** 技能名 → 目录绝对路径（优先所选 CLI 的分发目录，退化到任一在位目录） */
  const skillPath = (name: string, cli: string): string | null => {
    const skill = skills.find((s) => s.name === name)
    if (!skill) return null
    const target =
      skillTargets.find((t) => t.id === cli && t.exists) ??
      skillTargets.find((t) => t.exists && skill.targets.includes(t.id))
    return target ? `${target.dir.replace(/\/$/, '')}/${name}` : null
  }

  const send = async () => {
    const raw = input.trim()
    if (!raw || !project || !session || runningId) return

    // / 开头：技能（只载入该技能）或内置命令（整条透传给 CLI）；否则默认载入全部开启的技能
    let skillPaths: string[] = []
    let text = raw
    const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw)
    if (slash) {
      const skill = enabledSkills.find((s) => s.name === slash[1])
      const isBuiltin = (BUILTIN_COMMANDS[session.cli] ?? []).some((c) => c.name === slash[1])
      if (skill) {
        const p = skillPath(skill.name, session.cli)
        if (!p) {
          appendItem(session.id, { kind: 'error', text: `技能 ${skill.name} 未分发到任何 CLI 目录（技能页同步后可用）` })
          return
        }
        skillPaths = [p]
        text = (slash[2] ?? '').trim()
        if (!text) {
          appendItem(session.id, { kind: 'error', text: `请在 /${skill.name} 后输入任务内容` })
          return
        }
      } else if (isBuiltin) {
        // 内置命令原样透传（compact 等由 CLI 自己解释）
        text = raw
      } else {
        appendItem(session.id, { kind: 'error', text: `未知命令 /${slash[1]}——在输入框键入 / 可从菜单选择` })
        return
      }
    } else {
      skillPaths = enabledSkills
        .map((s) => skillPath(s.name, session.cli))
        .filter((p): p is string => !!p)
      if (enabledSkills.length > skillPaths.length) {
        appendItem(session.id, { kind: 'error', text: '部分技能未分发到任何 CLI 目录（技能页同步后可用），本轮已跳过' })
      }
    }

    setInput('')
    stickBottom.current = true // 发送后总是跟随到最新消息
    appendItem(session.id, { kind: 'user', text, done: true })
    if (session.title === '新会话') {
      patchSession({ title: text.split('\n')[0].slice(0, 20) })
    }
    setSessions((prev) => prev.map((x) => (x.id === session.id ? { ...x, updatedAt: Date.now() } : x)))
    setRunningId(session.id)

    // MCP 默认注入全局开启的服务器（目前仅 claude 支持 --mcp-config）
    const mcpEntries: AgentMcp[] =
      session.cli === 'claude'
        ? mcps
            .filter((m) => !agentMcpsOff.includes(m.entry.name))
            .map((m) => ({
              name: m.entry.name,
              kind: m.entry.kind,
              command: m.entry.command,
              args: m.entry.args ?? [],
              env: m.entry.env ?? {},
              url: m.entry.url,
              headers: m.entry.headers ?? {},
            }))
        : []
    try {
      await agentApi.run({
        key: session.id,
        cli: session.cli,
        dir: project.dir,
        prompt: text,
        sessionId: session.cliSessionId,
        skills: skillPaths,
        mcp: mcpEntries,
        model: session.model || cliDefaults[session.cli] || undefined,
        mode: session.mode || 'normal',
        service: session.serviceKey ? specOf(session.serviceKey) : undefined,
        onEvent: onEvent(session.id, session.cli),
      })
    } catch (e) {
      setRunningId(null)
      setInput(text) // 启动失败把输入还给用户，改完即可重发
      appendItem(session.id, { kind: 'error', text: errText(e) })
    }
  }

  const stop = async () => {
    if (!runningId) return
    try {
      await agentApi.stop(runningId)
    } catch {
      /* 进程已退出 */
    }
  }

  /** 压缩上下文：对当前 CLI 会话执行 /compact（会话结束后才可点） */
  const compact = async () => {
    if (!project || !session || runningId) return
    setRunningId(session.id)
    stickBottom.current = true
    appendItem(session.id, { kind: 'user', text: '/compact（压缩上下文）', done: true })
    try {
      await agentApi.run({
        key: session.id,
        cli: session.cli,
        dir: project.dir,
        prompt: '/compact',
        sessionId: session.cliSessionId,
        skills: [],
        mcp: [],
        model: session.model || cliDefaults[session.cli] || undefined,
        mode: 'normal',
        service: session.serviceKey ? specOf(session.serviceKey) : undefined,
        onEvent: onEvent(session.id, session.cli),
      })
    } catch (e) {
      setRunningId(null)
      appendItem(session.id, { kind: 'error', text: errText(e) })
    }
  }

  /** 应答 claude 工具审批：allow 回传 updatedInput，deny 带拒绝原因 */
  const respondApproval = async (item: Item, allow: boolean) => {
    if (!session || !item.ref) return
    const payload = {
      type: 'control_response',
      response_to: item.ref,
      payload: allow
        ? { subtype: 'success', result: { behavior: 'allow', updatedInput: JSON.parse(item.input ?? '{}') } }
        : { subtype: 'success', result: { behavior: 'deny', message: '用户拒绝了该操作' } },
    }
    setItemsBy((prev) => ({
      ...prev,
      [session.id]: (prev[session.id] ?? []).map((x) =>
        x.ref === item.ref && x.kind === 'approval' ? { ...x, done: true, choice: allow ? 'allow' : 'deny' } : x,
      ),
    }))
    try {
      await agentApi.respond(session.id, JSON.stringify(payload))
    } catch (e) {
      message.error(errText(e))
    }
  }

  const isRunning = !!runningId
  const activeRunning = session?.id === runningId

  // 输入形如 /xxx（尚无空格）时唤起菜单：技能 + 当前 CLI 内置命令，按名过滤
  const enabledSkills = useMemo(() => skills.filter((s) => !agentSkillsOff.includes(s.name)), [skills, agentSkillsOff])
  const slashQuery = /^\/(\S*)$/.exec(input)?.[1]
  const slashMatches = useMemo(() => {
    if (slashQuery == null) return { skills: [], cmds: [] }
    const q = slashQuery.toLowerCase()
    return {
      skills: enabledSkills.filter((s) => s.name.toLowerCase().includes(q)),
      cmds: (BUILTIN_COMMANDS[session?.cli ?? ''] ?? []).filter((c) => c.name.toLowerCase().includes(q)),
    }
  }, [slashQuery, enabledSkills, session?.cli])

  /** 侧栏单个项目行（选中时展开该项目自己的会话列表） */
  const renderProjectRow = (p: AgentProject) => {
    const n = sessions.filter((s) => s.projectId === p.id).length
    const projSessions = sessions
      .filter((s) => s.projectId === p.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return (
      <div key={p.id} className="mb-1">
        <div
          className={`group flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm ${
            p.id === activeProjectId
              ? 'bg-indigo-500/10 font-medium text-indigo-600 dark:text-indigo-400'
              : 'text-gray-600 hover:bg-black/5 dark:text-gray-400 dark:hover:bg-white/5'
          }`}
          onClick={() => {
            setActiveProjectId(p.id)
            setActiveSessionId(null)
          }}
          title={p.dir}
        >
          <FolderOpen size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          <span className="shrink-0 text-[10px] text-gray-400">{n}</span>
          {p.id !== DEFAULT_PID && (
            <Popconfirm
              title={`删除项目「${p.name}」及其会话？`}
              okText="删除"
              cancelText="取消"
              onConfirm={() => removeProject(p)}
            >
              <button
                className="hidden shrink-0 border-0 bg-transparent p-0 text-gray-400 hover:text-rose-500 group-hover:block"
                onClick={(e) => e.stopPropagation()}
              >
                ×
              </button>
            </Popconfirm>
          )}
        </div>
        {p.id === activeProjectId && (
          <div className="mb-1 ml-4 flex flex-col">
            <button
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-indigo-500 hover:bg-indigo-500/10 dark:text-indigo-400"
              onClick={newSession}
            >
              <MessageSquarePlus size={12} /> 新会话
            </button>
            {projSessions.map((s) => (
              <div
                key={s.id}
                className={`group/s flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] ${
                  s.id === activeSessionId
                    ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                    : 'text-gray-500 hover:bg-black/5 dark:text-gray-400 dark:hover:bg-white/5'
                }`}
                onClick={() => openSession(s.id)}
              >
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="shrink-0 text-[10px] text-gray-400">{CLI_LABEL[s.cli] ?? s.cli}</span>
                {s.id === runningId && (
                  <span className="shrink-0 animate-pulse text-[10px] text-emerald-500">运行中</span>
                )}
                <button
                  className="hidden shrink-0 border-0 bg-transparent p-0 text-xs text-gray-400 hover:text-rose-500 group-hover/s:block"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeSession(s)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ===== 无项目：引导创建 =====
  if (projects.length === 0) {
    return (
      <>
        {createModal}
        <div className="flex h-full flex-col items-center justify-center gap-5 p-10">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-500 text-white shadow-md">
            <Bot size={26} />
          </div>
          <div className="text-center">
            <h2 className="text-lg font-semibold">Agent</h2>
            <p className="mt-1 max-w-md text-sm text-gray-500 dark:text-gray-400">
              新建项目即在工作目录{baseDir ? `（${baseDir}）` : ''}下创建任务文件夹并开始会话；会话可选 CLI（pi / Claude Code / Codex / OpenCode），技能与 MCP 默认全量载入，输入 / 可唤起技能。
            </p>
          </div>
          <Button type="primary" size="large" icon={<FolderOpen size={16} />} onClick={openCreate}>
            新建项目
          </Button>
        </div>
      </>
    )
  }

  // ===== 主视图 =====
  return (
    <div className="flex h-full">
      {/* 左：项目 → 会话 */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-black/5 dark:border-white/10">
        <div className="flex items-center gap-1 p-2">
          <Button block type="dashed" icon={<FolderOpen size={14} />} onClick={openCreate} className="flex-1">
            新建项目
          </Button>
          <Tooltip title={`公共项目目录：${baseDir || '加载中…'}（点击修改）`}>
            <Button type="text" size="small" icon={<Settings2 size={14} />} onClick={() => void changeBaseDir()} />
          </Tooltip>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {defaultProject && (
            <>
              <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-gray-400">默认</div>
              {renderProjectRow(defaultProject)}
            </>
          )}
          {otherProjects.length > 0 && (
            <>
              <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-gray-400">项目</div>
              {otherProjects.map(renderProjectRow)}
            </>
          )}
        </div>
      </aside>

      {/* 右：会话 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {session && project ? (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-black/5 px-6 py-2 dark:border-white/10">
              <FolderOpen size={14} className="shrink-0 text-indigo-400" />
              <span className="truncate text-sm font-medium">{project.name}</span>
              <Tag bordered={false} className="shrink-0">{CLI_LABEL[session.cli] ?? session.cli}</Tag>
              <span className="min-w-0 flex-1 truncate text-xs text-gray-400" title={project.dir}>
                {project.dir}
              </span>
              <Tooltip title="Agent 公共配置（默认 CLI / 技能 / MCP）">
                <Button size="small" type="text" icon={<SlidersHorizontal size={13} />} onClick={() => setCfgOpen(true)} />
              </Tooltip>
              <Tooltip title="在 Finder 中显示项目目录">
                <Button
                  size="small"
                  type="text"
                  icon={<FolderSearch size={13} />}
                  onClick={() => {
                    void import('@tauri-apps/plugin-opener').then(({ revealItemInDir }) =>
                      revealItemInDir(project.dir),
                    ).catch(() => {})
                  }}
                />
              </Tooltip>
              {session.cliSessionId && <Tag bordered={false}>已接续 {CLI_LABEL[session.cli] ?? session.cli} 会话</Tag>}
              {activeRunning && (
                <Button size="small" danger icon={<SquareX size={12} />} onClick={() => void stop()}>
                  停止
                </Button>
              )}
            </div>
            <div
              ref={listRef}
              className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
              onScroll={(e) => {
                const el = e.currentTarget
                stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
              }}
            >
              {items.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-4">
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="向 agent 描述任务，或从下面开始" />
                  <div className="flex max-w-md flex-wrap justify-center gap-2">
                    {[
                      '总结这个项目的结构与职责划分',
                      '跑一遍测试并汇总失败原因',
                      '找出代码里的 TODO 和未完成的逻辑',
                      '解释入口文件的启动流程',
                    ].map((q) => (
                      <button
                        key={q}
                        className="rounded-full border border-black/10 px-3 py-1.5 text-xs text-gray-500 transition-colors hover:border-indigo-400 hover:text-indigo-500 dark:border-white/15 dark:text-gray-400 dark:hover:border-indigo-500/50"
                        onClick={() => setInput(q)}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="mx-auto flex max-w-3xl flex-col gap-3">
                  {items.map((it, i) => (
                    <div key={i} className={`flex ${it.kind === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {it.kind === 'user' ? (
                        <div className="max-w-[85%] rounded-2xl bg-indigo-500 px-4 py-2.5 text-sm text-white">
                          <p className="m-0 whitespace-pre-wrap break-words">{it.text}</p>
                        </div>
                      ) : it.kind === 'assistant' ? (
                        <div className="max-w-[92%] rounded-2xl border border-black/5 bg-white px-4 py-2.5 shadow-sm dark:border-white/10 dark:bg-[#1f1f27]">
                          <div className="chat-md">
                            <MdPreview text={it.text} theme={mdTheme} />
                          </div>
                        </div>
                      ) : it.kind === 'tool' ? (
                        <div className="flex max-w-[92%] items-center gap-2 rounded-lg border border-black/5 bg-black/[0.03] px-3 py-1.5 text-xs text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400">
                          {toolIcon(it.tool)}
                          <span className="shrink-0 font-medium">{it.tool}</span>
                          <span className="min-w-0 flex-1 truncate font-mono" title={it.text}>
                            {it.text}
                          </span>
                          {!it.done && <span className="shrink-0 animate-pulse">运行中…</span>}
                        </div>
                      ) : it.kind === 'approval' ? (
                        <div className="flex max-w-[92%] flex-col gap-1.5 rounded-lg border border-amber-300/60 bg-amber-50/80 px-3 py-2 text-xs dark:border-amber-500/30 dark:bg-amber-950/20">
                          <div className="flex items-center gap-2">
                            {toolIcon(it.tool)}
                            <span className="shrink-0 font-medium text-amber-700 dark:text-amber-300">
                              请求审批 · {it.tool}
                            </span>
                          </div>
                          <div className="min-w-0 truncate font-mono text-amber-700/80 dark:text-amber-300/70" title={it.text}>
                            {it.text || '（无参数）'}
                          </div>
                          {it.done ? (
                            <span className={`font-medium ${it.choice === 'allow' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>
                              {it.choice === 'allow' ? '已允许' : '已拒绝'}
                            </span>
                          ) : (
                            <div className="flex gap-2">
                              <Button size="small" type="primary" onClick={() => void respondApproval(it, true)}>
                                允许
                              </Button>
                              <Button size="small" danger onClick={() => void respondApproval(it, false)}>
                                拒绝
                              </Button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <Alert
                          type={it.kind === 'error' ? 'error' : 'info'}
                          showIcon
                          message={it.kind === 'error' ? it.text : '已停止'}
                          className="w-full max-w-[92%]"
                        />
                      )}
                    </div>
                  ))}
                  {activeRunning && items[items.length - 1]?.kind === 'user' && (
                    <div className="flex justify-start">
                      <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                        <Terminal size={12} /> {CLI_LABEL[session.cli] ?? session.cli} 处理中…
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* 输入区：会话配置（CLI 只读/模型/用量）+ 输入框（/ 唤起技能菜单） */}
            <div className="shrink-0 border-t border-black/5 p-3 dark:border-white/10">
              <div className="mx-auto flex max-w-3xl flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Tooltip title={`CLI 在设置页全局配置，会话内不可更改（当前 ${CLI_LABEL[session.cli] ?? session.cli}）`}>
                    <Tag bordered={false} className="m-0">{CLI_LABEL[session.cli] ?? session.cli}</Tag>
                  </Tooltip>
                  <Tooltip
                    title={
                      PROVIDER_SUPPORTED[session.cli]
                        ? '供应商 → 模型 二级联动，仅当前会话生效（不写 CLI 全局）；默认（CLI 全局）分支下也可单选模型覆盖'
                        : 'pi 按 models.json 全局配置，会话内仅可切换模型'
                    }
                  >
                    <Cascader
                      size="small"
                      className="min-w-56 max-w-96"
                      placeholder={`供应商 / 模型${cliDefaults[session.cli] ? `（默认 ${cliDefaults[session.cli]}）` : ''}`}
                      value={
                        session.serviceKey
                          ? session.model
                            ? [session.serviceKey, session.model]
                            : [session.serviceKey]
                          : session.model
                            ? ['', session.model]
                            : []
                      }
                      options={svcCascadeOptions}
                      loadData={(selected) => ensureSvcModels(String(selected[selected.length - 1]?.value ?? ''))}
                      onChange={(v) => {
                        const [k, m] = (v as string[] | null) ?? []
                        patchSession({ serviceKey: k || undefined, model: m || undefined })
                      }}
                      showSearch={{
                        filter: (q, path) =>
                          path.some((o) => String(o.label).toLowerCase().includes(q.toLowerCase())),
                      }}
                      changeOnSelect
                      allowClear
                      disabled={activeRunning}
                    />
                  </Tooltip>
                  <Tooltip title={MODE_SUPPORTED[session.cli] ? '权限模式：普通需审批危险操作 / 编辑自动接受文件改动 / 计划只读规划 / 危险跳过所有审批' : '该 CLI 暂不支持权限模式切换'}>
                    <Select
                      size="small"
                      className="w-20"
                      value={session.mode || 'normal'}
                      disabled={activeRunning || !MODE_SUPPORTED[session.cli]}
                      onChange={(v) => patchSession({ mode: v })}
                      options={AGENT_MODES}
                    />
                  </Tooltip>
                  {usage.ctx > 0 && (() => {
                    const win = contextWindow(session.model || cliDefaults[session.cli] || '')
                    const pct = win > 0 ? Math.min(100, Math.round((usage.ctx / win) * 100)) : 0
                    // 命中率 = 最近一轮缓存读 / 上下文规模（输入+缓存读+缓存写）
                    const hit = Math.round((usage.cacheRead / usage.ctx) * 100)
                    return (
                      <Tooltip
                        title={`最新一轮：上下文 ${fmtTokens(usage.ctx)}（缓存读 ${fmtTokens(usage.cacheRead)} · 缓存写 ${fmtTokens(usage.cacheWrite)}）｜本会话累计输出 ${fmtTokens(usage.output)}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <ContextRing pct={pct} />
                          <span className="text-[11px] tabular-nums text-gray-400">
                            上下文 {pct}% · 消耗 {fmtTokens(usage.output)} · 缓存 {hit}%
                          </span>
                        </div>
                      </Tooltip>
                    )
                  })()}
                  <span className="min-w-0 flex-1" />
                  <Tooltip title={activeRunning ? '会话进行中，结束后可压缩' : usage.ctx === 0 ? '当前会话还没有上下文' : '压缩上下文（执行 /compact）'}>
                    <Button
                      size="small"
                      icon={<Shrink size={13} />}
                      disabled={activeRunning || usage.ctx === 0}
                      onClick={() => void compact()}
                    >
                      压缩
                    </Button>
                  </Tooltip>
                </div>
                <div className="flex items-end gap-2">
                  <Dropdown
                    trigger={[]}
                    open={(slashMatches.skills.length > 0 || slashMatches.cmds.length > 0) && !isRunning}
                    menu={{
                      items: [
                        slashMatches.skills.length > 0 && {
                          type: 'group' as const,
                          label: '技能（只载入选中项）',
                          children: slashMatches.skills.slice(0, 8).map((s) => ({
                            key: `s:${s.name}`,
                            label: (
                              <div className="flex max-w-72 flex-col overflow-hidden">
                                <span className="truncate text-xs font-medium">/{s.name}</span>
                                {s.description && (
                                  <span className="truncate text-[11px] text-gray-400">{s.description}</span>
                                )}
                              </div>
                            ),
                            onClick: () => {
                              setInput(`/${s.name} `)
                              setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 30)
                            },
                          })),
                        },
                        slashMatches.cmds.length > 0 && {
                          type: 'group' as const,
                          label: `${CLI_LABEL[session?.cli ?? ''] ?? ''} 内置命令`,
                          children: slashMatches.cmds.slice(0, 8).map((c) => ({
                            key: `c:${c.name}`,
                            label: (
                              <div className="flex max-w-72 items-baseline gap-2 overflow-hidden">
                                <span className="shrink-0 text-xs font-medium">/{c.name}</span>
                                <span className="truncate text-[11px] text-gray-400">{c.desc}</span>
                              </div>
                            ),
                            onClick: () => {
                              setInput(`/${c.name} `)
                              setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 30)
                            },
                          })),
                        },
                      ].filter(Boolean) as never,
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <Input.TextArea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={`描述任务，Cmd+Enter 发送 / Enter 换行；键入 / 选择技能或命令`}
                        autoSize={{ minRows: 1, maxRows: 6 }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault()
                            void send()
                          }
                        }}
                        disabled={isRunning}
                      />
                    </div>
                  </Dropdown>
                  {activeRunning ? (
                    <Tooltip title="停止">
                      <Button danger icon={<SquareX size={16} />} onClick={() => void stop()} />
                    </Tooltip>
                  ) : (
                    <Button type="primary" icon={<Bot size={16} />} disabled={!input.trim()} onClick={() => void send()} />
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <Empty description={project ? '左侧「新会话」开始' : '选择或创建一个项目'} />
          </div>
        )}
      </div>
      {createModal}
      {cfgModal}
    </div>
  )
}

/** 工具行图标：命令类 Terminal、文件类 FileCode2、其余 Wrench */
function toolIcon(name?: string) {
  const n = (name ?? '').toLowerCase()
  if (/bash|shell|command|exec|terminal|run/.test(n)) return <Terminal size={12} className="shrink-0" />
  if (/edit|write|file|read|mcp_tool|apply/.test(n)) return <FileCode2 size={12} className="shrink-0" />
  return <Wrench size={12} className="shrink-0" />
}

/** 工具参数摘要：常用字段截断展示 */
function fmtArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  for (const k of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'name']) {
    if (typeof a[k] === 'string') {
      const s = a[k] as string
      return s.length > 80 ? `${s.slice(0, 80)}…` : s
    }
  }
  return JSON.stringify(a).slice(0, 80)
}
