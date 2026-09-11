import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { App, Button, Checkbox, Empty, Input, Modal, Tag, Typography } from 'antd'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  BookOpen,
  BookText,
  Boxes,
  CalendarDays,
  ExternalLink,
  Gauge,
  RefreshCw,
  Settings2,
  Timer,
} from 'lucide-react'
import { useUiStore } from '../stores/ui'
import { yxApi, type YxApp, type YxConfig } from '../api/yunxiao'
import { yqApi, type YqConnStatus } from '../api/yuque'
import { kbApi, type KbState } from '../api/kb'
import { appApi, scheduleText, type ScheduledTask } from '../api/app'
import { assistantRepo, type Assistant } from '../db/assistants'
import { providerRepo, type Provider } from '../db/providers'
import { getDb } from '../db'
import { noteApi } from '../api/notes'
import { openLinkInApp } from '../lib/openLink'
import { type QuotaResult } from '../api/quota'
import { fetchProviderQuotas, useQuotaAutoRefresh } from '../hooks/useQuota'
import { QuotaSummary } from '../components/QuotaDisplay'
import { isTauri } from '../api/ipc'
import Reveal from '../components/home/Reveal'
import AuroraCanvas from '../components/home/AuroraCanvas'

const PILL_CLASS =
  'rounded-full border border-gray-200 px-4 py-1.5 text-sm text-gray-700 transition-colors ' +
  'hover:border-indigo-400 hover:text-indigo-600 dark:border-gray-700 dark:text-gray-300 ' +
  'dark:hover:border-indigo-500 dark:hover:text-indigo-400'

/** 看板卡片：渐变底 + 彩色图标章 + 悬浮阴影。
 *  底色比页面背景 #f6f6f9 深一档（indigo-100 基调），否则卡片和背景几乎融在一起 */
const HOME_CARD =
  'spot-card rounded-2xl border border-indigo-200/60 bg-gradient-to-br from-indigo-100/80 via-indigo-50 to-indigo-100/50 ' +
  'p-5 shadow-sm transition-shadow hover:shadow-md ' +
  'dark:border-indigo-900/50 dark:from-indigo-950/50 dark:via-[#1c1c26] dark:to-[#181820]'

const ICON_CHIP = 'flex h-7 w-7 items-center justify-center rounded-lg text-white shadow-sm'

// ===== 看板板块注册与用户自定义（勾选显示 + 上下排序） =====

type SectionId = 'ai' | 'yx' | 'yuque' | 'kb' | 'tasks' | 'links' | 'assistants'

/** 板块定义；full = 独占整行（其余两列网格里的半宽卡） */
const SECTIONS: { id: SectionId; title: string; full?: boolean }[] = [
  { id: 'ai', title: 'AI 服务状态', full: true },
  { id: 'yx', title: '云效 DevOps' },
  { id: 'yuque', title: '语雀' },
  { id: 'kb', title: '知识库' },
  { id: 'tasks', title: '定时任务' },
  { id: 'links', title: '常用入口', full: true },
  { id: 'assistants', title: '常用助手' },
]
const SECTION_TITLE: Record<SectionId, string> = Object.fromEntries(SECTIONS.map((s) => [s.id, s.title])) as Record<SectionId, string>

const LS_SECTIONS = 'aw-home:sections'

/** 读用户配置：order 含全部已知板块（新增板块自动追加到末尾且默认显示） */
function loadSectionCfg(): { order: SectionId[]; hidden: Set<SectionId> } {
  const known = new Set(SECTIONS.map((s) => s.id))
  let order: SectionId[] = []
  let hidden: SectionId[] = []
  try {
    const v = JSON.parse(localStorage.getItem(LS_SECTIONS) ?? 'null') as { order?: unknown; hidden?: unknown } | null
    if (v && Array.isArray(v.order)) order = v.order.filter((x): x is SectionId => typeof x === 'string' && known.has(x as SectionId))
    if (v && Array.isArray(v.hidden)) hidden = v.hidden.filter((x): x is SectionId => typeof x === 'string' && known.has(x as SectionId))
  } catch {
    /* 损坏则回默认 */
  }
  for (const s of SECTIONS) if (!order.includes(s.id)) order.push(s.id)
  return { order, hidden: new Set(hidden) }
}

export default function HomePage() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const quotaRefreshSec = useUiStore((s) => s.quotaRefreshSec)
  const [assistants, setAssistants] = useState<Assistant[]>([])
  const [q, setQ] = useState('')
  const [providers, setProviders] = useState<Provider[]>([])
  const [quotas, setQuotas] = useState<Record<string, QuotaResult>>({})
  const [refreshing, setRefreshing] = useState(false)
  // 云效接入状态（快捷入口卡片展示）
  const [yx, setYx] = useState<YxConfig | null>(null)
  // 云效收藏的应用交付（localStorage 收藏名 + 应用列表过滤，直达研发流程页）
  const [favApps, setFavApps] = useState<YxApp[]>([])
  const wfUrlCache = useRef(new Map<string, string>())
  // 今日统计：对话消息数 / 画图数 / 笔记改动数
  const [todayStats, setTodayStats] = useState<{ chat: number; draw: number; note: number } | null>(null)
  // 首页常用入口（链接页勾选 home 的）
  const [homeLinks, setHomeLinks] = useState<{ id: string; name: string; group: string; url: string }[]>([])
  // 看板板块自定义：勾选显示 + 排序（弹窗里是草稿，保存才落 localStorage）
  const [sectionCfg, setSectionCfg] = useState(loadSectionCfg)
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfgDraft, setCfgDraft] = useState<{ order: SectionId[]; hidden: Set<SectionId> }>({ order: [], hidden: new Set() })
  // 新板块数据：语雀连接 / 知识库 / 定时任务
  const [yqConns, setYqConns] = useState<YqConnStatus[]>([])
  const [kbState, setKbState] = useState<KbState | null>(null)
  const [tasks, setTasks] = useState<ScheduledTask[]>([])

  const loadHomeLinks = useCallback(() => {
    try {
      const raw = localStorage.getItem('aw-links-list')
      const list = raw ? (JSON.parse(raw) as { id: string; name: string; group: string; url: string; home?: boolean }[]) : []
      setHomeLinks(list.filter((l) => l.home && l.url))
    } catch {
      /* ignore */
    }
  }, [])

  const loadTodayStats = useCallback(async () => {
    if (!isTauri) return
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    try {
      const db = await getDb()
      const [chat, draw] = await Promise.all([
        db.select<{ c: number }[]>('SELECT COUNT(*) AS c FROM chat_messages WHERE created_at >= ?', [start.getTime()]),
        db.select<{ c: number }[]>('SELECT COUNT(*) AS c FROM draws WHERE created_at >= ?', [start.getTime()]),
      ])
      const notes = await noteApi
        .tree()
        .then((nodes) => {
          let c = 0
          const walk = (list: typeof nodes) => {
            for (const n of list) {
              if (n.kind === 'note' && n.updatedAt * 1000 >= start.getTime()) c++
              walk(n.children)
            }
          }
          walk(nodes)
          return c
        })
        .catch(() => 0)
      setTodayStats({ chat: chat[0]?.c ?? 0, draw: draw[0]?.c ?? 0, note: notes })
    } catch {
      /* 统计失败不打扰首页 */
    }
  }, [])

  /** 云效收藏的应用交付：与云效页共用 localStorage 收藏（yunxiao-appstack-favs） */
  const loadFavApps = useCallback(() => {
    if (!isTauri) return
    let favs: Set<string>
    try {
      const arr = JSON.parse(localStorage.getItem('yunxiao-appstack-favs') ?? '[]') as string[]
      favs = new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [])
    } catch {
      favs = new Set()
    }
    if (!favs.size) {
      setFavApps([])
      return
    }
    yxApi
      .apps()
      .then((list) => setFavApps(list.filter((a) => favs.has(a.name))))
      .catch(() => {})
  }, [])

  /** 打开收藏应用：直达研发流程页（无研发流程时回落应用概览），URL 按应用缓存 */
  const openFavApp = async (a: YxApp) => {
    const base = `https://devops.aliyun.com/appstack/app/${encodeURIComponent(a.name)}`
    let deep = wfUrlCache.current.get(a.name)
    if (!deep) {
      try {
        const wfs = await yxApi.appWorkflows(a.name)
        const wf = wfs.find((w) => w.stages.length > 0)
        if (wf) {
          deep = `${base}/workflow/${wf.sn}/stage/${wf.stages[0].sn}/current`
          wfUrlCache.current.set(a.name, deep)
        }
      } catch {
        /* 查询失败回落概览页 */
      }
    }
    void openLinkInApp({ id: `yx-app-${a.name}`, name: a.name, url: deep ?? base }, (m) => message?.error(m))
  }

  useEffect(() => {
    if (!isTauri) return
    loadHomeLinks()
    void loadTodayStats()
    loadFavApps()
    assistantRepo
      .list()
      .then((a) => setAssistants(a.slice(0, 6)))
      .catch(() => {})
    yxApi
      .status()
      .then(setYx)
      .catch(() => {})
    providerRepo
      .list()
      .then(setProviders)
      .catch(() => {})
    yqApi
      .status()
      .then(setYqConns)
      .catch(() => {})
    kbApi
      .getConfig()
      .then(setKbState)
      .catch(() => {})
    appApi
      .tasks()
      .then(setTasks)
      .catch(() => {})
    // 从其他页面回到首页时刷新统计、链接与收藏
    const onFocus = () => {
      loadHomeLinks()
      void loadTodayStats()
      loadFavApps()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const homeProviders = providers.filter((p) => p.showOnHome === 1 && p.quotaType)

  const loadQuotas = useCallback(async () => {
    if (!isTauri) return
    setRefreshing(true)
    try {
      // 一键/自动刷新覆盖全部配置了额度查询的供应商（首页只展示勾选的部分）
      const all = providers.filter((p) => p.quotaType)
      const r = await fetchProviderQuotas(all)
      if (Object.keys(r).length) setQuotas((prev) => ({ ...prev, ...r }))
    } finally {
      setRefreshing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.map((p) => `${p.id}:${p.quotaType}`).join(',')])

  /** 一键刷新：全部供应商额度 */
  const refreshAll = useCallback(async () => {
    await loadQuotas()
  }, [loadQuotas])

  useEffect(() => {
    void loadQuotas()
  }, [loadQuotas])

  useQuotaAutoRefresh(quotaRefreshSec, () => void loadQuotas())

  /** 时段问候 */
  const greeting = () => {
    const h = new Date().getHours()
    if (h < 6) return '夜深了'
    if (h < 11) return '早上好'
    if (h < 13) return '中午好'
    if (h < 18) return '下午好'
    return '晚上好'
  }

  // 智能推荐：按关键词把输入匹配到助手（名称/描述包含 + 意图词表），最多 3 个
  const suggest = useMemo(() => {
    const text = q.trim().toLowerCase()
    if (!text || assistants.length === 0) return []
    const INTENT: Record<string, string[]> = {
      'builtin-writer': ['写', '文案', '润色', '报告', '邮件', '总结', 'write'],
      'builtin-excel': ['excel', '表格', '数据', '统计', '透视', 'formula'],
      'builtin-ppt': ['ppt', '演示', '幻灯', '汇报', 'slides'],
      'builtin-fe': ['前端', '页面', '组件', 'react', 'vue', 'css', 'bug'],
      'builtin-weekly': ['周报', '月报', '日报', '汇报总结'],
      'builtin-translate': ['翻译', 'translate', 'english', '英文', '日语'],
    }
    const score = (a: Assistant) => {
      const name = a.name.toLowerCase()
      const desc = a.description.toLowerCase()
      let sc = 0
      if (name.includes(text) || text.includes(name)) sc += 10
      if (desc.includes(text) || text.includes(desc)) sc += 6
      for (const [id, words] of Object.entries(INTENT)) {
        if (a.id === id && words.some((w) => text.includes(w))) sc += 8
      }
      for (const ch of text) {
        if (name.includes(ch)) sc += 1
      }
      return sc
    }
    return assistants
      .map((a) => ({ a, sc: score(a) }))
      .filter((x) => x.sc >= 6)
      .sort((x, y) => y.sc - x.sc)
      .slice(0, 3)
      .map((x) => x.a)
  }, [q, assistants])

  const openAssistant = (a: Assistant, draftText?: string) => {
    navigate('/chat', { state: { assistantId: a.id, draftText } })
  }

  // ===== 看板板块：配置操作与渲染 =====

  const saveCfg = () => {
    localStorage.setItem(
      LS_SECTIONS,
      JSON.stringify({ order: cfgDraft.order, hidden: [...cfgDraft.hidden] }),
    )
    setSectionCfg({ order: cfgDraft.order, hidden: new Set(cfgDraft.hidden) })
    setCfgOpen(false)
  }

  const moveCfgDraft = (id: SectionId, dir: -1 | 1) =>
    setCfgDraft((d) => {
      const i = d.order.indexOf(id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= d.order.length) return d
      const order = [...d.order]
      ;[order[i], order[j]] = [order[j], order[i]]
      return { ...d, order }
    })

  /** 卡片头：彩色图标章 + 标题 + 右侧操作 */
  const cardHead = (chip: ReactNode, title: string, extra?: ReactNode) => (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        {chip}
        <span className="text-sm font-semibold">{title}</span>
      </div>
      {extra}
    </div>
  )

  /** 图标章：渐变底 + 白色图标 */
  const chip = (Icon: typeof Gauge, gradient: string) => (
    <span className={`${ICON_CHIP} bg-gradient-to-br ${gradient}`}>
      <Icon size={15} />
    </span>
  )

  const yqAuthed = yqConns.filter((c) => c.hasAuth)

  /** Spotlight 高光：委托到看板容器一次监听，坐标写入鼠标所在的 spot-card（CSS 变量） */
  const onSpotlight = (e: React.MouseEvent) => {
    const card = (e.target as HTMLElement).closest?.('.spot-card') as HTMLElement | null
    if (!card) return
    const r = card.getBoundingClientRect()
    card.style.setProperty('--mx', `${e.clientX - r.left}px`)
    card.style.setProperty('--my', `${e.clientY - r.top}px`)
  }

  /** 按注册表 id 渲染板块卡片 */
  const renderSection = (id: SectionId): ReactNode => {
    switch (id) {
      case 'ai':
        return (
          <div className={HOME_CARD}>
            {cardHead(
              chip(Gauge, 'from-indigo-500 to-violet-500'),
              'AI 服务状态',
              <div className="flex items-center gap-1">
                <Button
                  size="small"
                  icon={<RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />}
                  onClick={() => void refreshAll()}
                  title="一键刷新：全部供应商额度（自动刷新间隔可在设置中调整）"
                />
                <Button type="link" size="small" onClick={() => navigate('/ai-service')}>
                  {homeProviders.length ? '管理' : '去配置'} <ArrowRight size={14} />
                </Button>
              </div>,
            )}
            {homeProviders.length > 0 ? (
              // 多供应商时横向卡片排布，一屏看全
              <div className="grid grid-cols-1 gap-2.5 py-1 sm:grid-cols-2 xl:grid-cols-3">
                {homeProviders.map((p) => (
                  <div
                    key={p.id}
                    className="rounded-xl border border-black/5 bg-white/70 p-3 dark:border-white/10 dark:bg-white/5"
                  >
                    <div className="mb-1.5 truncate text-xs font-medium text-gray-600 dark:text-gray-300">{p.name}</div>
                    <QuotaSummary result={quotas[p.id]} />
                  </div>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="配置 AI 供应商并开启额度查询后显示" />
            )}
          </div>
        )
      case 'yx':
        return (
          <div className={HOME_CARD}>
            {cardHead(
              chip(Boxes, 'from-orange-500 to-rose-500'),
              '云效 DevOps',
              <Button type="link" size="small" onClick={() => navigate('/yunxiao')}>
                {yx?.orgId ? '进入' : '去配置'} <ArrowRight size={14} />
              </Button>,
            )}
            {yx?.orgId ? (
              <div className="flex flex-col gap-1.5 py-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 dark:text-gray-400">组织</span>
                  <span className="font-medium text-gray-700 dark:text-gray-200">{yx.orgName || yx.orgId}</span>
                  <span className="text-gray-400">{yx.userName}</span>
                </div>
                {favApps.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-gray-500 dark:text-gray-400">收藏交付</span>
                    {favApps.map((a) => (
                      <button
                        key={a.name}
                        className="max-w-40 truncate rounded-full border border-black/5 bg-white px-2.5 py-0.5 text-[11px] text-gray-700 shadow-sm transition-colors hover:border-indigo-300 hover:text-indigo-600 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:border-indigo-500/40 dark:hover:text-indigo-300"
                        title={a.description || a.name}
                        onClick={() => void openFavApp(a)}
                      >
                        {a.name}
                      </button>
                    ))}
                  </div>
                )}
                <div className="text-gray-400">业务空间 · 代码仓库 · 流水线 · 应用交付</div>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="配置个人访问令牌，接入项目、代码库与流水线" />
            )}
          </div>
        )
      case 'yuque':
        return (
          <div className={HOME_CARD}>
            {cardHead(
              chip(BookText, 'from-emerald-500 to-teal-500'),
              '语雀',
              <Button type="link" size="small" onClick={() => navigate('/yuque')}>
                {yqAuthed.length ? '进入' : '去配置'} <ArrowRight size={14} />
              </Button>,
            )}
            {yqAuthed.length > 0 ? (
              <div className="flex flex-col gap-1.5 py-1 text-xs">
                {yqAuthed.map((c) => (
                  <div key={c.id} className="flex items-center gap-2">
                    <span className="w-14 shrink-0 font-medium text-gray-600 dark:text-gray-300">{c.label}</span>
                    <span className="truncate text-gray-400" title={c.base}>
                      {c.userName || c.userLogin || c.base}
                    </span>
                    <span className="ml-auto shrink-0 text-gray-400">{c.spaces.length} 空间</span>
                  </div>
                ))}
                <div className="text-gray-400">团队文档 · 表格 · 全文搜索</div>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="接入语雀账号，浏览与搜索知识空间文档" />
            )}
          </div>
        )
      case 'kb':
        return (
          <div className={HOME_CARD}>
            {cardHead(
              chip(BookOpen, 'from-cyan-500 to-blue-500'),
              '知识库',
              <Button type="link" size="small" onClick={() => navigate('/knowledge')}>
                {kbState && kbState.apis.length > 0 ? '进入' : '去配置'} <ArrowRight size={14} />
              </Button>,
            )}
            {kbState && kbState.apis.length > 0 ? (
              <div className="flex flex-col gap-1.5 py-1 text-xs">
                {kbState.apis.map((a) => {
                  const n = kbState.entries.filter((e) => e.apiId === a.id && e.enabled).length
                  return (
                    <div key={a.id} className="flex items-center gap-2">
                      <span className="max-w-40 truncate font-medium text-gray-600 dark:text-gray-300">{a.name}</span>
                      <span className="text-gray-400">{n} 个库已挂载</span>
                    </div>
                  )
                })}
                <div className="text-gray-400">聊天引用检索 · 手动搜索</div>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="接入 WeKnora / Dify 知识库，聊天时自动引用" />
            )}
          </div>
        )
      case 'tasks':
        return (
          <div className={HOME_CARD}>
            {cardHead(
              chip(Timer, 'from-amber-500 to-orange-500'),
              '定时任务',
              <Button type="link" size="small" onClick={() => navigate('/tasks')}>
                {tasks.length ? '管理' : '去创建'} <ArrowRight size={14} />
              </Button>,
            )}
            {tasks.length > 0 ? (
              <div className="flex flex-col gap-1.5 py-1">
                {tasks.slice(0, 4).map((t) => (
                  <div key={t.id} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-medium text-gray-600 dark:text-gray-300" title={t.name}>
                      {t.name}
                    </span>
                    <Tag style={{ marginInlineEnd: 0 }}>{scheduleText(t)}</Tag>
                    {!t.enabled && (
                      <Tag color="default" style={{ marginInlineEnd: 0 }}>
                        停用
                      </Tag>
                    )}
                  </div>
                ))}
                {tasks.length > 4 && <div className="text-[11px] text-gray-400">等 {tasks.length} 个任务</div>}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="创建到点提醒、打开链接与 Webhook 任务" />
            )}
          </div>
        )
      case 'links':
        return (
          <div className={HOME_CARD}>
            {cardHead(
              chip(ExternalLink, 'from-sky-500 to-indigo-500'),
              '常用入口',
              <Button type="link" size="small" onClick={() => navigate('/links')}>
                管理链接 <ArrowRight size={14} />
              </Button>,
            )}
            {homeLinks.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {homeLinks.map((l) => (
                  <button
                    key={l.id}
                    className="group flex min-w-0 items-center gap-2 rounded-xl border border-black/5 bg-white px-3 py-2.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md dark:border-white/10 dark:bg-white/5 dark:hover:border-indigo-500/40"
                    title={l.url}
                    onClick={() => void openLinkInApp(l, (msg) => message?.error(msg))}
                  >
                    <ExternalLink size={14} className="shrink-0 text-indigo-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{l.name}</span>
                      {l.group && <span className="block truncate text-[10px] text-gray-400">{l.group}</span>}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="在「链接」页勾选「在看板展示」后出现在这里" />
            )}
          </div>
        )
      case 'assistants':
        return (
          <div className={HOME_CARD}>
            {cardHead(
              chip(Bot, 'from-violet-500 to-pink-500'),
              '常用助手',
              <Button type="link" size="small" onClick={() => navigate('/chat')}>
                管理助手 <ArrowRight size={14} />
              </Button>,
            )}
            <div className="flex flex-wrap gap-2 py-1">
              {assistants.length === 0 && (
                <button className={PILL_CLASS} onClick={() => navigate('/chat')}>
                  打开 Chat
                </button>
              )}
              {assistants.map((a) => (
                <button key={a.id} className={PILL_CLASS} title={a.description} onClick={() => openAssistant(a)}>
                  {a.emoji} {a.name}
                </button>
              ))}
            </div>
          </div>
        )
    }
  }

  return (
    <div className="flex w-full flex-col">
      {/* hero：极光背景铺满视口宽、贴顶无留白；内容自限宽与下方板块对齐 */}
      <section className="relative overflow-hidden">
        <AuroraCanvas className="absolute inset-0 h-full w-full" />
        <div className="absolute inset-0 bg-gradient-to-r from-white/85 via-white/55 to-white/20 dark:from-[#141418]/90 dark:via-[#141418]/70 dark:to-transparent" />
        <div className="hero-in relative mx-auto flex w-full max-w-5xl flex-col items-center gap-5 px-8 pb-12 pt-14 text-center">
          <Button
            size="small"
            type="text"
            className="absolute right-6 top-5 z-10"
            icon={<Settings2 size={15} />}
            title="自定义看板板块"
            onClick={() => {
              setCfgDraft({ order: [...sectionCfg.order], hidden: new Set(sectionCfg.hidden) })
              setCfgOpen(true)
            }}
          />
          <img src="/hero/app-icon.png" alt="AI 工作台" draggable={false} className="h-16 w-16 rounded-2xl shadow-lg" />
          <div className="flex flex-col items-center gap-1">
            <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <CalendarDays size={13} />
              {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
            </div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              {greeting()}，今天想用 AI 做什么？
            </Typography.Title>
          </div>
          <Input.Search
            size="large"
            placeholder="告诉 AI 你想完成什么……"
            enterButton="开始"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onSearch={(v) => navigate('/chat', { state: { draftText: v } })}
            className="w-full max-w-xl"
          />
          {/* 快捷入口：Agent 任务直达（进入 Agent 页并弹新建项目） */}
          <div className="flex items-center gap-2">
            <button
              className={`${PILL_CLASS} inline-flex items-center gap-1.5`}
              onClick={() => navigate('/agent', { state: { create: true } })}
            >
              <Bot size={14} />
              新建任务
            </button>
          </div>
          {todayStats && (todayStats.chat > 0 || todayStats.draw > 0 || todayStats.note > 0) && (
            <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span>今天</span>
              {todayStats.chat > 0 && (
                <button
                  className="rounded-full border border-indigo-100 bg-white/70 px-2.5 py-0.5 transition-colors hover:border-indigo-300 dark:border-indigo-900/60 dark:bg-white/5"
                  onClick={() => navigate('/chat')}
                >
                  {todayStats.chat} 条对话
                </button>
              )}
              {todayStats.draw > 0 && (
                <button
                  className="rounded-full border border-indigo-100 bg-white/70 px-2.5 py-0.5 transition-colors hover:border-indigo-300 dark:border-indigo-900/60 dark:bg-white/5"
                  onClick={() => navigate('/draw')}
                >
                  {todayStats.draw} 张图片
                </button>
              )}
              {todayStats.note > 0 && (
                <button
                  className="rounded-full border border-indigo-100 bg-white/70 px-2.5 py-0.5 transition-colors hover:border-indigo-300 dark:border-indigo-900/60 dark:bg-white/5"
                  onClick={() => navigate('/notes')}
                >
                  {todayStats.note} 篇笔记更新
                </button>
              )}
            </div>
          )}
          {suggest.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="text-xs text-gray-400">为你推荐</span>
              {suggest.map((a) => (
                <button
                  key={a.id}
                  className="flex items-center gap-1 rounded-full border border-indigo-200 bg-white/80 px-3 py-1 text-xs text-indigo-600 transition-colors hover:border-indigo-400 dark:border-indigo-500/30 dark:bg-white/5 dark:text-indigo-300"
                  title={a.description}
                  onClick={() => openAssistant(a, q)}
                >
                  {a.emoji} {a.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="mx-auto flex w-full max-w-5xl flex-col px-8 pb-10 pt-10">
        <div
          className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2"
          onMouseMove={onSpotlight}
        >
          {sectionCfg.order
            .filter((id) => !sectionCfg.hidden.has(id))
            .map((id, i) => (
              <Reveal
                key={id}
                className={SECTIONS.find((s) => s.id === id)?.full ? 'sm:col-span-2' : undefined}
                delay={(i % 2) * 70}
              >
                {renderSection(id)}
              </Reveal>
            ))}
        </div>
      </div>

      <Modal
        title="自定义看板板块"
        open={cfgOpen}
        onOk={saveCfg}
        onCancel={() => setCfgOpen(false)}
        okText="保存"
        cancelText="取消"
        width={420}
      >
        <p className="m-0 mb-2 text-xs text-gray-400">勾选要展示的板块；箭头调整上下顺序。</p>
        <div className="flex flex-col gap-1">
          {cfgDraft.order.map((id, i) => (
            <div
              key={id}
              className="flex items-center gap-2 rounded-lg border border-black/5 px-2.5 py-1.5 dark:border-white/10"
            >
              <Checkbox
                checked={!cfgDraft.hidden.has(id)}
                onChange={(e) =>
                  setCfgDraft((d) => {
                    const hidden = new Set(d.hidden)
                    if (e.target.checked) hidden.delete(id)
                    else hidden.add(id)
                    return { ...d, hidden }
                  })
                }
              >
                <span className="text-sm">{SECTION_TITLE[id]}</span>
              </Checkbox>
              <div className="ml-auto flex items-center">
                <Button
                  size="small"
                  type="text"
                  icon={<ArrowUp size={13} />}
                  disabled={i === 0}
                  onClick={() => moveCfgDraft(id, -1)}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<ArrowDown size={13} />}
                  disabled={i === cfgDraft.order.length - 1}
                  onClick={() => moveCfgDraft(id, 1)}
                />
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}
