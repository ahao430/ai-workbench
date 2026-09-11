import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  App as AntApp,
  AutoComplete,
  Breadcrumb,
  Button,
  Calendar,
  Checkbox,
  Collapse,
  Drawer,
  Empty,
  Input,
  Modal,
  Pagination,
  Popconfirm,
  Segmented,
  Select,
  Spin,
  Switch,
  Table,
  Tooltip,
  Tabs,
  Tag,
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import {
  ClipboardCheck,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Folder,
  GitPullRequest,
  KeyRound,
  Play,
  Search,
  Star,
  Unplug,
} from 'lucide-react'
import YunxiaoOnboarding from '../components/yunxiao/YunxiaoOnboarding'
import {
  yxApi,
  type YxConfig,
  type YxEffort,
  type YxMr,
  type YxPipeline,
  type YxPipelineRun,
  type YxProject,
  type YxRepo,
  type YxRefItem,
  type YxCommit,
  type YxRunParam,
  type YxWorkitem,
  type YxApp,
  type YxWorkflow,
  type YxStage,
} from '../api/yunxiao'
import { errText } from '../lib/err'
import { MdPreview, copyText } from '../components/common/MdPreview'
import { openLinkInApp } from '../lib/openLink'

/** 毫秒时间戳 → 日期 */
const fmtMs = (ms?: number) => (ms ? new Date(ms).toLocaleDateString('zh-CN') : '-')
/** ISO 字符串 → 短日期时间（同年省年份） */
const fmtIso = (s?: string) => {
  if (!s) return '-'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return sameYear
    ? d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) +
        ' ' +
        d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN')
}

/** 工作项状态 → Tag 颜色（按常见状态名关键词） */
function statusColor(name?: string): string {
  const n = name ?? ''
  if (/完成|关闭|取消|拒绝|done|close|cancel|reject/i.test(n)) return 'default'
  if (/进行|开发|设计|评审|审核|progress|design|review/i.test(n)) return 'processing'
  if (/待|开始|open|ready/i.test(n)) return 'warning'
  return 'default'
}

/** 云效网页端链接（OpenAPI 不返回 URL，按网页端路由拼装；仓库/MR 用接口自带的地址） */
const yxProjectUrl = (orgId: string, projectId: string) =>
  `https://devops.aliyun.com/projex/project/${projectId}?orgId=${orgId}`
const yxWorkitemUrl = (orgId: string, projectId: string, workitemId: string) =>
  `${yxProjectUrl(orgId, projectId)}&workitemIdentifier=${workitemId}`

const CATEGORY_OPTIONS = [
  { value: 'Req,Task,Bug', label: '全部' },
  { value: 'Req', label: '需求' },
  { value: 'Task', label: '任务' },
  { value: 'Bug', label: '缺陷' },
]

const MR_STATE_OPTIONS = [
  { value: 'opened', label: '打开中' },
  { value: 'merged', label: '已合并' },
  { value: 'closed', label: '已关闭' },
  { value: 'all', label: '全部' },
]

function mrStateTag(state: string) {
  const S: Record<string, { text: string; color: string }> = {
    UNDER_DEV: { text: '开发中', color: 'processing' },
    UNDER_REVIEW: { text: '评审中', color: 'gold' },
    TO_BE_MERGED: { text: '待合并', color: 'warning' },
    MERGED: { text: '已合并', color: 'success' },
    CLOSED: { text: '已关闭', color: 'default' },
  }
  const s = S[state] ?? { text: state, color: 'default' }
  return <Tag color={s.color}>{s.text}</Tag>
}

/** 统一错误提示块（令牌失效时引导重新接入） */
function ErrAlert({ e, onRetry }: { e: unknown; onRetry: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      message={errText(e)}
      className="mb-4"
      action={
        <Button size="small" onClick={onRetry}>
          重试
        </Button>
      }
    />
  )
}

function CardBox({
  title,
  extra,
  children,
}: {
  title: ReactNode
  extra?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-black/5 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold">{title}</span>
        {extra}
      </div>
      {children}
    </div>
  )
}

// ===== 工作台 =====

function OverviewTab({ goTab }: { goTab: (key: string) => void }) {
  const { message } = AntApp.useApp()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [data, setData] = useState<{ myWorkitems: YxWorkitem[]; myEfforts: YxEffort[] } | null>(null)
  // 收藏看板：流水线按收藏 id 逐条拉，应用取列表后按收藏过滤
  const [favFlows, setFavFlows] = useState<YxPipeline[] | null>(null)
  const [favApps, setFavApps] = useState<YxApp[] | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    yxApi
      .overview()
      .then((d) => setData({ myWorkitems: d.myWorkitems, myEfforts: d.myEfforts }))
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const ids = [...loadFavs()]
    if (!ids.length) {
      setFavFlows([])
    } else {
      Promise.all(ids.map((id) => yxApi.pipelineGet(id).catch(() => null))).then((list) =>
        setFavFlows(list.filter((x): x is YxPipeline => x != null)),
      )
    }
    yxApi
      .apps()
      .then((list) => {
        const favs = loadAppFavs()
        setFavApps(list.filter((a) => favs.has(a.name)))
      })
      .catch(() => setFavApps([]))
  }, [])

  const openFlow = (p: YxPipeline) =>
    void openLinkInApp(
      {
        id: `yx-flow-${p.pipelineId}`,
        name: p.pipelineName,
        url: `https://flow.aliyun.com/pipelines/${p.pipelineId}/history`,
      },
      (m) => message.error(m),
    )
  const openApp = (a: YxApp) => void openAppDeep(a, (m) => message.error(m))

  // 今日 / 本周 / 本月报工工时（gmtStart 为毫秒时间戳）
  const { todayH, weekH, monthH, monthDays } = useMemo(() => {
    const now = new Date()
    const dayStart = new Date(now)
    dayStart.setHours(0, 0, 0, 0)
    const monday = new Date(dayStart)
    monday.setDate(dayStart.getDate() - ((now.getDay() + 6) % 7))
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    let t = 0
    let w = 0
    let m = 0
    const days = new Set<string>()
    for (const e of data?.myEfforts ?? []) {
      if (e.gmtStart >= dayStart.getTime()) t += e.actualTime
      if (e.gmtStart >= monday.getTime()) w += e.actualTime
      if (e.gmtStart >= monthStart.getTime()) {
        m += e.actualTime
        days.add(new Date(e.gmtStart).toDateString())
      }
    }
    const r = (x: number) => Math.round(x * 10) / 10
    return { todayH: r(t), weekH: r(w), monthH: r(m), monthDays: days.size }
  }, [data])

  return (
    <div className="flex flex-col gap-5">
      {error ? <ErrAlert e={error} onRetry={load} /> : null}
      {loading && !data ? (
        <div className="grid h-40 place-items-center">
          <Spin />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <CardBox
            title="我的工作项（进行中）"
            extra={
              <Button type="link" size="small" onClick={() => goTab('projects')}>
                全部我的项目 →
              </Button>
            }
          >
            {!data || data.myWorkitems.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无进行中的工作项" />
            ) : (
              <div className="flex max-h-[28rem] flex-col overflow-y-auto">
                {data.myWorkitems.slice(0, 15).map((w) => (
                  <div
                    key={w.id}
                    className="flex items-center gap-2 border-b border-black/5 py-2 last:border-0 dark:border-white/10"
                  >
                    <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
                      {w.serialNumber || w.id.slice(0, 8)}
                    </span>
                    {w.workitemType?.name && (
                      <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
                        {w.workitemType.name}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm" title={w.subject}>
                      {w.subject}
                    </span>
                    <Tag color={statusColor(w.status?.displayName || w.status?.name)}>
                      {w.status?.displayName || w.status?.name || '-'}
                    </Tag>
                    <span className="w-20 shrink-0 truncate text-right text-xs text-gray-400" title={w.space?.name}>
                      {w.space?.name}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardBox>

          <CardBox
            title="我的报工"
            extra={
              <Button type="link" size="small" onClick={() => goTab('efforts')}>
                报工月历 →
              </Button>
            }
          >
            <div className="grid grid-cols-2 gap-3 py-2">
              {[
                ['今日', `${todayH}h`],
                ['本周', `${weekH}h`],
                ['本月', `${monthH}h`],
                ['本月报工天数', `${monthDays} 天`],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-xl border border-black/5 bg-black/[0.02] px-4 py-3 dark:border-white/10 dark:bg-white/5"
                >
                  <div className="text-xs text-gray-400">{label}</div>
                  <div className="mt-1 text-xl font-semibold text-orange-500">{value}</div>
                </div>
              ))}
            </div>
          </CardBox>

          <CardBox
            title={`收藏的流水线（${favFlows?.length ?? 0}）`}
            extra={
              <Button type="link" size="small" onClick={() => goTab('flow')}>
                去收藏
              </Button>
            }
          >
            {favFlows == null ? (
              <div className="grid h-24 place-items-center">
                <Spin />
              </div>
            ) : favFlows.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="在「流水线」列表点 ⭐ 收藏后显示在这里" />
            ) : (
              <div className="flex max-h-96 flex-col overflow-y-auto">
                {favFlows.map((p) => (
                  <button
                    key={p.pipelineId}
                    className="flex items-center gap-2 border-b border-black/5 py-2 text-left last:border-0 hover:text-indigo-600 dark:border-white/10 dark:hover:text-indigo-400"
                    onClick={() => openFlow(p)}
                  >
                    <Play size={12} className="shrink-0 text-gray-400" />
                    <span className="min-w-0 flex-1 truncate text-sm">{p.pipelineName}</span>
                    <span className="shrink-0 text-xs text-gray-400">{fmtMs(p.createTime)}</span>
                  </button>
                ))}
              </div>
            )}
          </CardBox>

          <CardBox
            title={`收藏的应用交付（${favApps?.length ?? 0}）`}
            extra={
              <Button type="link" size="small" onClick={() => goTab('appstack')}>
                去收藏
              </Button>
            }
          >
            {favApps == null ? (
              <div className="grid h-24 place-items-center">
                <Spin />
              </div>
            ) : favApps.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="在「应用交付」列表点 ⭐ 收藏后显示在这里" />
            ) : (
              <div className="flex max-h-96 flex-col overflow-y-auto">
                {favApps.map((a) => (
                  <button
                    key={a.name}
                    className="flex items-center gap-2 border-b border-black/5 py-2 text-left last:border-0 hover:text-indigo-600 dark:border-white/10 dark:hover:text-indigo-400"
                    onClick={() => openApp(a)}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-400">{a.description || '-'}</span>
                  </button>
                ))}
              </div>
            )}
          </CardBox>
        </div>
      )}
    </div>
  )
}

// ===== 报工月历 =====

/** gmtStart（ms）→ 本地日期键 YYYY-MM-DD */
function dayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** ms → HH:mm */
const fmtHm = (ms?: number) =>
  ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '-'

function EffortsTab() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [efforts, setEfforts] = useState<YxEffort[]>([])
  const [sel, setSel] = useState<Dayjs>(() => dayjs())
  /** 面板月份（月统计跟随切换），初始与选中同月 */
  const [panel, setPanel] = useState<Dayjs>(() => dayjs())

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    yxApi
      .myEfforts()
      .then(setEfforts)
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** 按日分组 */
  const byDay = useMemo(() => {
    const m = new Map<string, YxEffort[]>()
    for (const e of efforts) {
      const k = dayKey(e.gmtStart)
      const arr = m.get(k)
      if (arr) arr.push(e)
      else m.set(k, [e])
    }
    return m
  }, [efforts])

  /** 面板月份合计 */
  const monthStat = useMemo(() => {
    let h = 0
    let days = 0
    const prefix = panel.format('YYYY-MM')
    for (const [k, list] of byDay) {
      if (k.startsWith(prefix)) {
        h += list.reduce((n, e) => n + e.actualTime, 0)
        days += 1
      }
    }
    return { hours: Math.round(h * 10) / 10, days }
  }, [byDay, panel])

  const selKey = sel.format('YYYY-MM-DD')
  const selList = byDay.get(selKey) ?? []
  const selTotal = Math.round(selList.reduce((n, e) => n + e.actualTime, 0) * 10) / 10

  if (error) {
    return (
      <div>
        <ErrAlert e={error} onRetry={load} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          报工月历
          <span className="ml-3 text-xs font-normal text-gray-400">
            {panel.format('YYYY年M月')} 合计 <span className="font-medium text-orange-500">{monthStat.hours}h</span> · 报工{' '}
            {monthStat.days} 天
          </span>
        </span>
        <Button size="small" onClick={load} loading={loading}>
          刷新
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-2xl border border-black/5 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-white/5">
          <Calendar
            fullscreen
            value={sel}
            onSelect={(d) => setSel(d)}
            onPanelChange={(d) => setPanel(d)}
            cellRender={(current, info) => {
              // 全屏月历里 antd 自渲补零日期（-date-value 槽），cellRender 返回内容
              // 放在其下方的 -date-content 槽——这里绝不能再渲染 originNode
              // （rc-picker 的另一套日期节点），否则一个格子出现两个日期数字
              const badge = (h: number) => (
                <div className="text-right">
                  <span
                    className={`inline-block rounded px-1.5 text-[11px] font-medium ${
                      h >= 8
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
                    }`}
                  >
                    {h}h
                  </span>
                </div>
              )
              if (info.type === 'date') {
                const list = byDay.get(current.format('YYYY-MM-DD'))
                if (!list?.length) return null
                const h = Math.round(list.reduce((n, e) => n + e.actualTime, 0) * 10) / 10
                return badge(h)
              }
              if (info.type === 'month') {
                // 年视图月格子显示当月合计
                const prefix = current.format('YYYY-MM')
                let h = 0
                for (const [k, list] of byDay) {
                  if (k.startsWith(prefix)) h += list.reduce((n, e) => n + e.actualTime, 0)
                }
                h = Math.round(h * 10) / 10
                return h > 0 ? badge(h) : null
              }
              return info.originNode
            }}
          />
        </div>
        <div className="rounded-2xl border border-black/5 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">{sel.format('M月D日 dddd')}</span>
            {selList.length > 0 && (
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                合计 {selTotal}h
              </Tag>
            )}
          </div>
          {loading && efforts.length === 0 ? (
            <div className="grid h-24 place-items-center">
              <Spin />
            </div>
          ) : selList.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当日无报工" />
          ) : (
            <div className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto">
              {selList.map((e) => (
                <div
                  key={e.id}
                  className="rounded-xl border border-black/5 bg-black/[0.02] px-3 py-2 dark:border-white/10 dark:bg-white/5"
                  title={e.description || e.subject}
                >
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 font-mono text-[11px] text-gray-400">
                      {fmtHm(e.gmtStart)}–{fmtHm(e.gmtEnd)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{e.subject}</span>
                    <span className="shrink-0 font-medium text-orange-500">{e.actualTime}h</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-gray-400">
                    {e.spaceName && <span className="truncate">{e.spaceName}</span>}
                    {e.workType && <Tag bordered={false} style={{ marginInlineEnd: 0 }}>{e.workType}</Tag>}
                  </div>
                  {e.description && (
                    <div className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{e.description}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="text-xs text-gray-400">
        数据来自我名下工作项的报工记录（最近 80 项聚合）；如缺失请先在云效确认对应工作项处理人是你。
      </div>
    </div>
  )
}

// ===== 项目空间 =====

function WorkitemList({ project, orgId }: { project: YxProject; orgId: string }) {
  const { message } = AntApp.useApp()
  const [category, setCategory] = useState('Req,Task,Bug')
  // 默认只看我的：从项目空间点进来一般找自己的条目
  const [mine, setMine] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [items, setItems] = useState<YxWorkitem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  /** 详情抽屉（描述 / 状态 / 语雀 PRD 链接直接用列表返回的数据） */
  const [detail, setDetail] = useState<YxWorkitem | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    yxApi
      .workitems({ projectId: project.id, category, keyword: keyword || undefined, mine, page })
      .then((r) => {
        setItems(r.items)
        setTotal(r.total)
      })
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }, [project.id, category, keyword, mine, page])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={category} options={CATEGORY_OPTIONS} onChange={(v) => { setCategory(v); setPage(1) }} className="w-24" />
        <span className="text-xs text-gray-400">只看我的</span>
        <Switch size="small" checked={mine} onChange={(v) => { setMine(v); setPage(1) }} />
        <Input.Search
          size="small"
          allowClear
          placeholder="搜索标题"
          className="w-48"
          onSearch={(v) => { setKeyword(v); setPage(1) }}
        />
      </div>
      {error ? <ErrAlert e={error} onRetry={load} /> : null}
      {loading ? (
        <div className="grid h-32 place-items-center">
          <Spin />
        </div>
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的工作项" />
      ) : (
        <div className="flex flex-col">
          {items.map((w) => (
            <div
              key={w.id}
              className="flex cursor-pointer flex-col gap-1 border-b border-black/5 py-2.5 last:border-0 hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.03]"
              onClick={() => setDetail(w)}
            >
              <div className="flex items-center gap-2">
                <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
                  {w.serialNumber || w.id.slice(0, 8)}
                </span>
                {w.workitemType?.name && (
                  <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
                    {w.workitemType.name}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{w.subject}</span>
                <Tag color={statusColor(w.status?.displayName || w.status?.name)}>
                  {w.status?.displayName || w.status?.name || '-'}
                </Tag>
                <button
                  className="shrink-0 border-0 bg-transparent p-0 text-gray-400 hover:text-indigo-500"
                  title="在云效网页打开"
                  onClick={(e) => {
                    e.stopPropagation()
                    void openLinkInApp(
                      {
                        id: `yx-wi-${w.id.slice(0, 12)}`,
                        name: w.subject,
                        url: yxWorkitemUrl(orgId, project.id, w.id),
                      },
                      (m) => message.error(m),
                    )
                  }}
                >
                  <ExternalLink size={13} />
                </button>
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-400">
                <span>处理人：{w.assignedTo?.name || '-'}</span>
                <span>创建：{fmtMs(w.gmtCreate)}</span>
                <span>更新：{fmtMs(w.gmtModified)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {total > 20 && (
        <Pagination
          size="small"
          current={page}
          pageSize={20}
          total={total}
          showSizeChanger={false}
          onChange={setPage}
        />
      )}

      <Drawer
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-xs text-gray-400">{detail?.serialNumber}</span>
            <span className="min-w-0 flex-1 truncate">{detail?.subject}</span>
          </span>
        }
        width={640}
        open={!!detail}
        onClose={() => setDetail(null)}
        destroyOnClose
      >
        {detail && <WorkitemDetail w={detail} orgId={orgId} projectId={project.id} />}
      </Drawer>
    </div>
  )
}

/** 工作项详情：状态 / 处理人 / 描述渲染 / 描述中提取语雀 PRD 链接直达 */
function WorkitemDetail({ w, orgId, projectId }: { w: YxWorkitem; orgId: string; projectId: string }) {
  const { message } = AntApp.useApp()
  const yuqueLinks = useMemo(
    () =>
    Array.from<string>(new Set((w.description ?? '').match(/https?:\/\/[^\s)"'<>]*yuque\.com[^\s)"'<>]*/g) ?? [])),
    [w.description],
  )
  const openYq = (u: string) =>
    void openLinkInApp({ id: `yq-doc-${u.slice(-24).replace(/[^a-zA-Z0-9]/g, '')}`, name: '语雀文档', url: u }, (m) =>
      message.error(m),
    )
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <Tag color={statusColor(w.status?.displayName || w.status?.name)} style={{ marginInlineEnd: 0 }}>
          {w.status?.displayName || w.status?.name || '-'}
        </Tag>
        <span>处理人：{w.assignedTo?.name || '-'}</span>
        <span>创建：{fmtMs(w.gmtCreate)}</span>
        <span>更新：{fmtMs(w.gmtModified)}</span>
        <Button
          size="small"
          type="text"
          icon={<ExternalLink size={12} />}
          onClick={() =>
            void openLinkInApp(
              { id: `yx-wi-${w.id.slice(0, 12)}`, name: w.subject, url: yxWorkitemUrl(orgId, projectId, w.id) },
              (m) => message.error(m),
            )
          }
        >
          网页
        </Button>
      </div>

      {yuqueLinks.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-emerald-200/60 bg-emerald-50/60 px-3 py-2 dark:border-emerald-500/30 dark:bg-emerald-950/20">
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">描述中的语雀文档（PRD）</div>
          {yuqueLinks.map((u) => (
            <button
              key={u}
              className="truncate text-left text-xs text-emerald-600 hover:underline dark:text-emerald-400"
              title={u}
              onClick={() => openYq(u)}
            >
              {u}
            </button>
          ))}
        </div>
      )}

      <div>
        <div className="mb-1.5 text-xs font-medium text-gray-400">描述</div>
        {w.description ? (
          <MdPreview text={w.description} theme="github" />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无描述" />
        )}
      </div>
    </div>
  )
}

function ProjectsTab({ orgId }: { orgId: string }) {
  const { message } = AntApp.useApp()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  /** 项目空间（含 myRole 成员标注） */
  const [projects, setProjects] = useState<YxProject[]>([])
  /** 我的工作项（跨空间聚合）——用户语境的"我的项目" */
  const [myItems, setMyItems] = useState<YxWorkitem[]>([])
  // 默认看我的项目；若我没有工作项则回退到项目空间
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  /** 项目空间抽屉 / 我的工作项详情抽屉 */
  const [spaceDrawer, setSpaceDrawer] = useState<YxProject | null>(null)
  const [wiDrawer, setWiDrawer] = useState<YxWorkitem | null>(null)

  const openProject = (p: YxProject) =>
    void openLinkInApp(
      { id: `yx-proj-${p.id.slice(0, 12)}`, name: p.name, url: yxProjectUrl(orgId, p.id) },
      (m) => message.error(m),
    )

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    Promise.all([yxApi.projects(), yxApi.myWorkitems()])
      .then(([list, items]) => {
        setProjects(list)
        setMyItems(items)
        if (items.length === 0) setScope('all')
      })
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div>
      {error ? <ErrAlert e={error} onRetry={load} /> : null}
      <div className="mb-3 flex items-center justify-between">
        <Segmented
          value={scope}
          onChange={(v) => setScope(v as 'mine' | 'all')}
          options={[
            { label: `我的项目（${myItems.length}）`, value: 'mine' },
            { label: `项目空间（${projects.length}）`, value: 'all' },
          ]}
        />
        <span className="text-xs text-gray-400">
          {scope === 'mine' ? '我处理/创建的工作项（跨空间）' : '组织全部项目空间，附我在该空间的角色'}
        </span>
      </div>

      {scope === 'mine' ? (
        <Table
          rowKey="id"
          size="middle"
          loading={loading && myItems.length === 0}
          dataSource={myItems}
          pagination={myItems.length > 50 ? { pageSize: 50 } : false}
          onRow={(r) => ({ onClick: () => setWiDrawer(r), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: '编号',
              dataIndex: 'serialNumber',
              width: 120,
              render: (v: string, r: YxWorkitem) => (
                <span className="font-mono text-xs text-gray-500">{v || r.id.slice(0, 8)}</span>
              ),
            },
            {
              title: '标题',
              dataIndex: 'subject',
              ellipsis: true,
              render: (v: string) => (
                <span className="font-medium text-indigo-500 hover:underline dark:text-indigo-400">{v}</span>
              ),
            },
            {
              title: '类型',
              dataIndex: ['workitemType', 'name'],
              width: 90,
              render: (v: string) => v || <span className="text-gray-400">-</span>,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (_: unknown, r: YxWorkitem) => (
                <Tag color={statusColor(r.status?.displayName || r.status?.name)}>
                  {r.status?.displayName || r.status?.name || '-'}
                </Tag>
              ),
            },
            {
              title: '空间',
              dataIndex: ['space', 'name'],
              width: 130,
              ellipsis: true,
              render: (v: string) => <span className="text-xs text-gray-500">{v || '-'}</span>,
            },
            {
              title: '处理人',
              dataIndex: ['assignedTo', 'name'],
              width: 90,
              ellipsis: true,
              render: (v: string) => v || '-',
            },
            { title: '更新', dataIndex: 'gmtModified', width: 100, render: (v: number) => fmtMs(v) },
          ]}
        />
      ) : (
        <Table
          rowKey="id"
          size="middle"
          loading={loading && projects.length === 0}
          dataSource={projects}
          pagination={projects.length > 50 ? { pageSize: 50 } : false}
          onRow={(r) => ({ onClick: () => setSpaceDrawer(r), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: '编号',
              dataIndex: 'customCode',
              width: 130,
              render: (v: string) => <span className="font-mono text-xs text-gray-500">{v || '-'}</span>,
            },
            {
              title: '项目空间',
              dataIndex: 'name',
              ellipsis: true,
              render: (v: string) => (
                <span className="font-medium text-indigo-500 hover:underline dark:text-indigo-400">{v}</span>
              ),
            },
            {
              title: '我的角色',
              dataIndex: 'myRole',
              width: 100,
              render: (v: string | undefined) =>
                v ? (
                  <Tag color="geekblue">{v}</Tag>
                ) : (
                  <span className="text-xs text-gray-300 dark:text-gray-600">-</span>
                ),
            },
            {
              title: '描述',
              dataIndex: 'description',
              ellipsis: true,
              render: (v: string) => v || <span className="text-gray-400">-</span>,
            },
            {
              title: '创建时间',
              dataIndex: 'gmtCreate',
              width: 110,
              render: (v: number) => fmtMs(v),
            },
            {
              title: '操作',
              key: 'actions',
              width: 90,
              render: (_, r: YxProject) => (
                <div onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="small"
                    icon={<ExternalLink size={12} />}
                    title="在云效网页打开项目"
                    onClick={() => openProject(r)}
                  >
                    网页
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      {/* 项目空间 → 工作项抽屉（默认只看我的） */}
      <Drawer
        title={
          <span>
            {spaceDrawer?.name}
            {spaceDrawer?.customCode && (
              <span className="ml-2 font-mono text-xs text-gray-400">{spaceDrawer.customCode}</span>
            )}
            {spaceDrawer && (
              <Button
                type="text"
                size="small"
                className="ml-1"
                icon={<ExternalLink size={13} />}
                title="在云效网页打开项目"
                onClick={() => openProject(spaceDrawer)}
              />
            )}
          </span>
        }
        width={860}
        open={!!spaceDrawer}
        onClose={() => setSpaceDrawer(null)}
        destroyOnClose
      >
        {spaceDrawer && <WorkitemList project={spaceDrawer} orgId={orgId} />}
      </Drawer>

      {/* 我的工作项详情抽屉 */}
      <Drawer
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-xs text-gray-400">{wiDrawer?.serialNumber}</span>
            <span className="min-w-0 flex-1 truncate">{wiDrawer?.subject}</span>
          </span>
        }
        width={640}
        open={!!wiDrawer}
        onClose={() => setWiDrawer(null)}
        destroyOnClose
      >
        {wiDrawer && <WorkitemDetail w={wiDrawer} orgId={orgId} projectId={wiDrawer.space?.identifier ?? ''} />}
      </Drawer>
    </div>
  )
}

// ===== 代码库 =====


/** 提交行（提交/对比复用） */
function CommitRow({ c, onOpen }: { c: YxCommit; onOpen: (c: YxCommit) => void }) {
  return (
    <div key={c.shortId + c.authoredDate} className="flex flex-col gap-0.5 border-b border-black/5 py-2 last:border-0 dark:border-white/10">
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-xs text-indigo-500 dark:text-indigo-400">{c.shortId}</span>
        <span className="min-w-0 flex-1 truncate text-sm" title={c.title}>
          {c.title || '-'}
        </span>
        {c.webUrl && (
          <button className="shrink-0 text-xs text-gray-400 hover:text-indigo-500" onClick={() => onOpen(c)}>
            网页
          </button>
        )}
      </div>
      <div className="text-xs text-gray-400">
        {c.authorName || '-'} · {fmtIso(c.authoredDate)}
      </div>
    </div>
  )
}

/** 仓库详情抽屉内容：提交 / 分支 / 标签 / 对比 / 图谱 */
function RepoDetail({ repo }: { repo: YxRepo }) {
  const { message } = AntApp.useApp()
  const [tab, setTab] = useState('commits')

  // 分支/标签：Rust 侧全量翻页取齐（接口按字母序、默认分支常在后页）
  const [branches, setBranches] = useState<YxRefItem[] | null>(null)
  const [bError, setBError] = useState<unknown>(null)
  const [bPage, setBPage] = useState(1)
  const [tags, setTags] = useState<YxRefItem[] | null>(null)
  const [tPage, setTPage] = useState(1)

  const [refName, setRefName] = useState('')
  const [commits, setCommits] = useState<YxCommit[]>([])
  const [cPage, setCPage] = useState(1)
  const [cLoading, setCLoading] = useState(false)
  const [cError, setCError] = useState<unknown>(null)

  // 对比：to 领先 from 的提交
  const [cmpFrom, setCmpFrom] = useState('')
  const [cmpTo, setCmpTo] = useState('')
  const [cmpLoading, setCmpLoading] = useState(false)
  const [cmpError, setCmpError] = useState<unknown>(null)
  const [cmpResult, setCmpResult] = useState<YxCommit[] | null>(null)

  // 图谱：最近若干提交的 DAG
  const [gRef, setGRef] = useState('')
  const [gLoading, setGLoading] = useState(false)
  const [gError, setGError] = useState<unknown>(null)
  const [gCommits, setGCommits] = useState<YxCommit[] | null>(null)

  const loadRefs = useCallback(() => {
    yxApi
      .repoBranchList(repo.id)
      .then(setBranches)
      .catch((e) => setBError(e))
    yxApi
      .repoTagList(repo.id)
      .then(setTags)
      .catch(() => setTags([]))
  }, [repo.id])

  useEffect(() => {
    loadRefs()
  }, [loadRefs])

  /** 默认分支置顶，其余按名称排序 */
  const sortedBranches = useMemo(() => {
    const list = branches ?? []
    return [...list].sort(
      (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
    )
  }, [branches])
  const branchNames = useMemo(() => sortedBranches.map((b) => b.name), [sortedBranches])
  const defaultBranch = useMemo(
    () => sortedBranches.find((b) => b.isDefault)?.name ?? 'master',
    [sortedBranches],
  )
  const cmpOptions = useMemo(
    () => [
      ...sortedBranches.map((b) => ({ value: b.name, label: b.name })),
      ...(tags ?? []).map((t) => ({ value: t.name, label: `${t.name}（标签）` })),
    ],
    [sortedBranches, tags],
  )

  // 各选择器的默认值等分支加载后落位
  useEffect(() => {
    if (!branches || branches.length === 0) return
    setRefName((p) => p || defaultBranch)
    setCmpFrom((p) => p || defaultBranch)
    setCmpTo((p) => p || sortedBranches.find((b) => !b.isDefault)?.name || defaultBranch)
    setGRef((p) => p || defaultBranch)
  }, [branches, defaultBranch, sortedBranches])

  const loadCommits = useCallback(() => {
    setCLoading(true)
    setCError(null)
    yxApi
      .repoCommits(repo.id, refName || defaultBranch, cPage)
      .then(setCommits)
      .catch((e) => setCError(e))
      .finally(() => setCLoading(false))
  }, [repo.id, refName, defaultBranch, cPage])

  const loadGraph = useCallback(() => {
    setGLoading(true)
    setGError(null)
    const fetchAll = async () => {
      const out: YxCommit[] = []
      for (let p = 1; p <= 5; p++) {
        const batch = await yxApi.repoCommits(repo.id, gRef || defaultBranch, p)
        out.push(...batch)
        if (batch.length < 20) break
      }
      return out
    }
    fetchAll()
      .then((list) => setGCommits(list.slice(0, 100)))
      .catch((e) => setGError(e))
      .finally(() => setGLoading(false))
  }, [repo.id, gRef, defaultBranch])

  useEffect(() => {
    if (tab === 'commits') loadCommits()
    else if (tab === 'graph') loadGraph()
  }, [tab, loadCommits, loadGraph])

  const runCompare = async () => {
    if (!cmpFrom || !cmpTo) {
      message.warning('请选择对比的两个分支/标签')
      return
    }
    setCmpLoading(true)
    setCmpError(null)
    setCmpResult(null)
    try {
      const fetchHist = async (ref: string) => {
        const out: YxCommit[] = []
        for (let p = 1; p <= 5; p++) {
          const batch = await yxApi.repoCommits(repo.id, ref, p)
          out.push(...batch)
          if (batch.length < 20) break
        }
        return out
      }
      const [toHist, fromHist] = await Promise.all([fetchHist(cmpTo), fetchHist(cmpFrom)])
      const fromSet = new Set(fromHist.map((c) => c.shortId))
      setCmpResult(toHist.filter((c) => !fromSet.has(c.shortId)))
    } catch (e) {
      setCmpError(e)
    } finally {
      setCmpLoading(false)
    }
  }

  const openUrl = (url: string, id: string, name: string) =>
    void openLinkInApp({ id, name, url }, (m) => message.error(m))

  /** 图谱布局：链上（上一条的父是本条）沿用 lane，分叉/合并开新 lane */
  const graph = useMemo(() => {
    if (!gCommits || gCommits.length === 0) return null
    const ROW = 28
    const list = gCommits
    const lanes: number[] = []
    const idxOf = new Map<string, number>()
    list.forEach((c, i) => idxOf.set(c.shortId, i))
    let nextLane = 0
    list.forEach((c, i) => {
      if (i > 0 && c.parentIds.some((p) => p.startsWith(list[i - 1].shortId))) {
        lanes[i] = lanes[i - 1]
      } else {
        lanes[i] = nextLane++
      }
    })
    const PALETTE = ['#6366f1', ' #10b981', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#84cc16']
    const lanesW = Math.min(nextLane, 12) * 22 + 14
    const W = lanesW + 620
    const H = list.length * ROW + 10
    const cx = (l: number) => l * 22 + 16
    const cy = (i: number) => i * ROW + 18

    const nodes: ReactNode[] = []
    const edges: ReactNode[] = []
    list.forEach((c, i) => {
      const color = PALETTE[lanes[i] % PALETTE.length].trim()
      if (c.parentIds.length === 0) {
        edges.push(
          <line key={`t${i}`} x1={cx(lanes[i])} y1={cy(i)} x2={cx(lanes[i])} y2={H} stroke={color} strokeWidth="1.5" opacity="0.45" />,
        )
      }
      c.parentIds.forEach((p, pi) => {
        const pj = idxOf.get(p.slice(0, 8))
        if (pj === undefined || pj <= i) return
        const pl = lanes[pj]
        edges.push(
          pl === lanes[i] ? (
            <line key={`e${i}-${pi}`} x1={cx(lanes[i])} y1={cy(i)} x2={cx(pl)} y2={cy(pj)} stroke={color} strokeWidth="1.5" opacity="0.75" />
          ) : (
            <path
              key={`e${i}-${pi}`}
              d={`M ${cx(lanes[i])} ${cy(i)} C ${cx(lanes[i])} ${cy(i) + 16}, ${cx(pl)} ${cy(pj) - 16}, ${cx(pl)} ${cy(pj)}`}
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              opacity="0.55"
            />
          ),
        )
      })
    })
    list.forEach((c, i) => {
      const color = PALETTE[lanes[i] % PALETTE.length].trim()
      nodes.push(<circle key={`n${i}`} cx={cx(lanes[i])} cy={cy(i)} r="4" fill={color} />)
      const title = (c.title || '-').slice(0, 44)
      nodes.push(
        <text key={`x${i}`} x={lanesW + 8} y={cy(i) - 1} fontSize="12" className="fill-gray-700 dark:fill-gray-200">
          <tspan fontFamily="monospace" className="fill-indigo-500">{c.shortId}</tspan>
          <tspan dx="8">{title}</tspan>
        </text>,
      )
      nodes.push(
        <text key={`a${i}`} x={lanesW + 8} y={cy(i) + 11} fontSize="10" className="fill-gray-400">
          {`${(c.authorName || '-').slice(0, 16)} · ${fmtIso(c.authoredDate)}`}
        </text>,
      )
    })
    return { svg: <svg width={W} height={H}>{edges}{nodes}</svg>, count: list.length }
  }, [gCommits])

  const refRow = (r: YxRefItem) => (
    <div key={r.name} className="flex flex-col gap-0.5 border-b border-black/5 py-2.5 last:border-0 dark:border-white/10">
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs text-gray-600 dark:bg-white/10 dark:text-gray-300">
          {r.name}
        </span>
        {r.isDefault && (
          <Tag color="blue" bordered={false}>
            默认
          </Tag>
        )}
        {r.isProtected && (
          <Tag color="purple" bordered={false}>
            保护
          </Tag>
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-gray-600 dark:text-gray-300" title={r.title}>
          {r.title || '-'}
        </span>
      </div>
      {r.shortId && (
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span className="font-mono">{r.shortId}</span>
          <span>{r.authorName || '-'}</span>
          <span>{fmtIso(r.committedDate)}</span>
          {r.webUrl && (
            <button
              className="text-indigo-500 hover:underline"
              onClick={() => openUrl(r.webUrl, `yx-commit-${r.shortId}`, `${r.name} · ${r.shortId}`)}
            >
              网页
            </button>
          )}
        </div>
      )}
    </div>
  )

  /** 客户端分页切片（分支/标签已全量拉取） */
  const paged = <T,>(list: T[], page: number) => list.slice((page - 1) * 20, page * 20)

  return (
    <div className="flex flex-col gap-3">
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'commits', label: '提交' },
          { key: 'branches', label: `分支${branches ? `（${branches.length}）` : ''}` },
          { key: 'tags', label: `标签${tags ? `（${tags.length}）` : ''}` },
          { key: 'compare', label: '对比' },
          { key: 'graph', label: '图谱' },
        ]}
      />

      {tab === 'commits' && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">分支</span>
            <Select
              size="small"
              className="w-48"
              showSearch
              value={refName || undefined}
              placeholder={branches ? '选择分支' : '分支加载中…'}
              options={branchNames.map((b) => ({ value: b, label: b }))}
              onChange={(v) => {
                setRefName(v)
                setCPage(1)
              }}
              optionFilterProp="label"
            />
          </div>
          {cError ? <ErrAlert e={cError} onRetry={loadCommits} /> : null}
          {cLoading ? (
            <div className="grid h-24 place-items-center">
              <Spin />
            </div>
          ) : commits.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有提交记录" />
          ) : (
            <div className="flex flex-col">
              {commits.map((c) => (
                <CommitRow key={c.shortId + c.authoredDate} c={c} onOpen={(x) => openUrl(x.webUrl, `yx-commit-${x.shortId}`, x.title || x.shortId)} />
              ))}
            </div>
          )}
          {commits.length === 20 && (
            <Pagination size="small" current={cPage} pageSize={20} total={-1} showSizeChanger={false} onChange={setCPage} />
          )}
        </>
      )}

      {tab === 'branches' && (
        <>
          {bError ? <ErrAlert e={bError} onRetry={loadRefs} /> : null}
          {branches === null ? (
            <div className="grid h-24 place-items-center">
              <Spin />
            </div>
          ) : branches.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有分支（或令牌无该仓库权限）" />
          ) : (
            <>
              <div className="flex flex-col">{paged(sortedBranches, bPage).map(refRow)}</div>
              {sortedBranches.length > 20 && (
                <Pagination
                  size="small"
                  current={bPage}
                  pageSize={20}
                  total={sortedBranches.length}
                  showSizeChanger={false}
                  onChange={setBPage}
                />
              )}
            </>
          )}
        </>
      )}

      {tab === 'tags' && (
        <>
          {tags === null ? (
            <div className="grid h-24 place-items-center">
              <Spin />
            </div>
          ) : tags.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有标签" />
          ) : (
            <>
              <div className="flex flex-col">{paged(tags, tPage).map(refRow)}</div>
              {tags.length > 20 && (
                <Pagination size="small" current={tPage} pageSize={20} total={tags.length} showSizeChanger={false} onChange={setTPage} />
              )}
            </>
          )}
        </>
      )}

      {tab === 'compare' && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              size="small"
              className="w-44"
              showSearch
              placeholder="基准（from）"
              value={cmpFrom || undefined}
              options={cmpOptions}
              onChange={setCmpFrom}
              optionFilterProp="label"
            />
            <span className="text-xs text-gray-400">→</span>
            <Select
              size="small"
              className="w-44"
              showSearch
              placeholder="目标（to）"
              value={cmpTo || undefined}
              options={cmpOptions}
              onChange={setCmpTo}
              optionFilterProp="label"
            />
            <Button size="small" type="primary" ghost loading={cmpLoading} onClick={() => void runCompare()}>
              对比
            </Button>
          </div>
          <div className="text-xs text-gray-400">
            展示「目标」领先「基准」的提交（各自取最近 100 条历史对比；完整文件差异请在云效网页查看）
          </div>
          {cmpError ? <ErrAlert e={cmpError} onRetry={() => void runCompare()} /> : null}
          {cmpResult !== null &&
            (cmpResult.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有领先提交（已同步或在取数范围外）" />
            ) : (
              <div className="flex flex-col">
                {cmpResult.map((c) => (
                  <CommitRow key={c.shortId + c.authoredDate} c={c} onOpen={(x) => openUrl(x.webUrl, `yx-commit-${x.shortId}`, x.title || x.shortId)} />
                ))}
              </div>
            ))}
        </>
      )}

      {tab === 'graph' && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">分支</span>
            <Select
              size="small"
              className="w-48"
              showSearch
              value={gRef || undefined}
              placeholder={branches ? '选择分支' : '分支加载中…'}
              options={branchNames.map((b) => ({ value: b, label: b }))}
              onChange={setGRef}
              optionFilterProp="label"
            />
            <Button size="small" onClick={loadGraph} loading={gLoading}>
              刷新
            </Button>
          </div>
          {gError ? <ErrAlert e={gError} onRetry={loadGraph} /> : null}
          {gLoading ? (
            <div className="grid h-24 place-items-center">
              <Spin />
            </div>
          ) : graph ? (
            <>
              <div className="text-xs text-gray-400">最近 {graph.count} 条提交的拓扑（合并/分叉曲线展示）</div>
              <div className="overflow-auto rounded-lg border border-black/5 dark:border-white/10">
                {graph.svg}
              </div>
            </>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有提交" />
          )}
        </>
      )}
    </div>
  )
}

function MrList({ repo }: { repo: YxRepo }) {
  const { message } = AntApp.useApp()
  const [state, setState] = useState('opened')
  const [items, setItems] = useState<YxMr[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    yxApi
      .mergeRequests({ repoId: repo.id, state, page })
      .then(setItems)
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }, [repo.id, state, page])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Select value={state} options={MR_STATE_OPTIONS} onChange={(v) => { setState(v); setPage(1) }} className="w-28" />
        <Button
          size="small"
          onClick={() => void openLinkInApp({ id: `yx-repo-${repo.id}`, name: repo.name, url: repo.webUrl }, (m) => message.error(m))}
        >
          在云效打开仓库
        </Button>
      </div>
      {error ? <ErrAlert e={error} onRetry={load} /> : null}
      {loading ? (
        <div className="grid h-32 place-items-center">
          <Spin />
        </div>
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的合并请求" />
      ) : (
        <div className="flex flex-col">
          {items.map((mr) => (
            <button
              key={mr.localId}
              className="flex flex-col gap-1 border-b border-black/5 py-2.5 text-left last:border-0 hover:text-indigo-600 dark:border-white/10 dark:hover:text-indigo-400"
              onClick={() => void openLinkInApp({ id: `yx-mr-${mr.projectId}-${mr.localId}`, name: mr.title, url: mr.detailUrl || mr.webUrl }, (m) => message.error(m))}
            >
              <div className="flex items-center gap-2">
                <GitPullRequest size={13} className="shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {mr.title} <span className="font-mono text-xs text-gray-400">!{mr.localId}</span>
                </span>
                {mrStateTag(mr.state)}
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-400">
                <span className="font-mono">
                  {mr.sourceBranch} → {mr.targetBranch}
                </span>
                <span>{mr.author?.name || mr.author?.username || '-'}</span>
                {mr.hasConflict && <Tag color="red">冲突</Tag>}
                <span>{fmtIso(mr.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
      {items.length === 20 && (
        <Pagination size="small" current={page} pageSize={20} total={-1} showSizeChanger={false} onChange={setPage} />
      )}
    </div>
  )
}

/** 仓库分组树节点（按 nameWithNamespace 的组段层层分组，首段组织 id 不展示） */
type RepoNode = { groups: Map<string, RepoNode>; repos: YxRepo[] }

function buildRepoTree(repos: YxRepo[]): RepoNode {
  const root: RepoNode = { groups: new Map(), repos: [] }
  for (const r of repos) {
    const segs = (r.nameWithNamespace || r.name)
      .split(' / ')
      .map((s) => s.trim())
      .filter(Boolean)
    // 末段是仓库名，中间段是组；仅一段时直接挂在根下
    const groupSegs = segs.length >= 2 ? segs.slice(1, -1) : []
    let node = root
    for (const g of groupSegs) {
      let child = node.groups.get(g)
      if (!child) {
        child = { groups: new Map(), repos: [] }
        node.groups.set(g, child)
      }
      node = child
    }
    node.repos.push(r)
  }
  return root
}

function countRepos(n: RepoNode): number {
  return n.repos.length + [...n.groups.values()].reduce((s, g) => s + countRepos(g), 0)
}

function ReposTab() {
  const { message } = AntApp.useApp()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [repos, setRepos] = useState<YxRepo[]>([])
  const [drawer, setDrawer] = useState<YxRepo | null>(null)
  /** 仓库详情（分支/提交/标签） */
  const [detail, setDetail] = useState<YxRepo | null>(null)
  /** 当前分组路径（面包屑同步，点击组卡片进入、点面包屑返回） */
  const [path, setPath] = useState<string[]>([])

  // 全量仓库由 Rust 侧按 x-total 翻页取齐（接口固定每页 20 条），前端一次拿全
  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    yxApi
      .repos()
      .then(setRepos)
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const tree = useMemo(() => buildRepoTree(repos), [repos])
  const node = useMemo(() => {
    let n = tree
    for (const seg of path) {
      const next = n.groups.get(seg)
      if (!next) break
      n = next
    }
    return n
  }, [tree, path])

  const groups = useMemo(
    () =>
      [...node.groups.entries()]
        .map(([name, g]) => ({ name, count: countRepos(g) }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    [node],
  )

  const copy = (text: string, tip: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => message.success(`已复制${tip}`))
      .catch(() => message.error('复制失败'))
  }

  return (
    <div>
      {error ? <ErrAlert e={error} onRetry={load} /> : null}
      <Breadcrumb
        className="mb-3"
        items={[
          {
            title: (
              <button
                className={`rounded px-1.5 py-0.5 text-sm ${path.length === 0 ? 'font-semibold text-indigo-500 dark:text-indigo-400' : 'hover:bg-black/5 dark:hover:bg-white/10'}`}
                onClick={() => setPath([])}
              >
                代码库{repos.length > 0 && <span className="ml-1 text-xs text-gray-400">{repos.length}</span>}
              </button>
            ),
          },
          ...path.map((seg, i) => ({
            title: (
              <button
                className={`rounded px-1.5 py-0.5 text-sm ${i === path.length - 1 ? 'font-semibold text-indigo-500 dark:text-indigo-400' : 'hover:bg-black/5 dark:hover:bg-white/10'}`}
                onClick={() => setPath(path.slice(0, i + 1))}
              >
                {seg}
              </button>
            ),
          })),
        ]}
      />
      {groups.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
          {groups.map(({ name, count }) => (
            <button
              key={name}
              onClick={() => setPath([...path, name])}
              className="flex items-center gap-2 rounded-xl border border-black/5 bg-white px-3 py-2.5 text-left shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/50 dark:border-white/10 dark:bg-white/5 dark:hover:border-indigo-500/40 dark:hover:bg-indigo-500/10"
            >
              <Folder size={16} className="shrink-0 text-amber-400" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>
                {name}
              </span>
              <span className="shrink-0 text-xs text-gray-400">{count}</span>
              <ChevronRight size={13} className="shrink-0 text-gray-300 dark:text-gray-600" />
            </button>
          ))}
        </div>
      )}
      {loading && repos.length === 0 ? (
        <div className="grid h-32 place-items-center">
          <Spin />
        </div>
      ) : !loading && groups.length === 0 && node.repos.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这里没有仓库" />
      ) : (
        <Table
          rowKey="id"
          size="middle"
          dataSource={node.repos}
          pagination={node.repos.length > 50 ? { pageSize: 50 } : false}
          columns={[
            {
              title: '仓库',
              dataIndex: 'name',
              ellipsis: true,
              render: (v: string, r: YxRepo) => (
                <span className="font-medium" title={r.nameWithNamespace || v}>
                  {v}
                </span>
              ),
            },
            {
              title: '描述',
              dataIndex: 'description',
              ellipsis: true,
              render: (v: string) => v || <span className="text-gray-400">-</span>,
            },
            {
              title: '可见性',
              dataIndex: 'visibility',
              width: 90,
              render: (v: string) =>
                v === 'public' || v === '10' ? <Tag color="green">公开</Tag> : <Tag>私有</Tag>,
            },
            { title: '最近活动', dataIndex: 'lastActivityAt', width: 130, render: (v: string) => fmtIso(v) },
            {
              title: '操作',
              key: 'actions',
              width: 280,
              render: (_, r: YxRepo) => (
                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button size="small" type="primary" ghost onClick={() => setDetail(r)}>
                    详情
                  </Button>
                  <Button
                    size="small"
                    icon={<ExternalLink size={12} />}
                    title="在云效网页打开仓库"
                    onClick={() =>
                      void openLinkInApp({ id: `yx-repo-${r.id}`, name: r.name, url: r.webUrl }, (m) =>
                        message.error(m),
                      )
                    }
                  >
                    网页
                  </Button>
                  <Button size="small" onClick={() => copy(r.httpUrlToRepo, ' HTTPS 地址')}>
                    复制
                  </Button>
                  <Button
                    size="small"
                    onClick={() => copy(r.sshUrlToRepo || r.httpUrlToRepo, ' SSH 地址')}
                    title="复制 SSH 克隆地址"
                  >
                    SSH
                  </Button>
                  <Button size="small" icon={<GitPullRequest size={12} />} onClick={() => setDrawer(r)}>
                    MR
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
      <Drawer
        title={`合并请求 · ${drawer?.name ?? ''}`}
        width={860}
        open={!!drawer}
        onClose={() => setDrawer(null)}
        destroyOnClose
      >
        {drawer && <MrList repo={drawer} />}
      </Drawer>
      <Drawer
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">仓库 · </span>
            <span className="min-w-0 flex-1 truncate">{detail?.nameWithNamespace || detail?.name}</span>
          </span>
        }
        width={720}
        open={!!detail}
        onClose={() => setDetail(null)}
        destroyOnClose
      >
        {detail && <RepoDetail repo={detail} />}
      </Drawer>
    </div>
  )
}

// ===== 流水线 =====

/** 收藏的流水线 id（本机 localStorage，跨会话保留） */
const FAV_KEY = 'yunxiao-flow-favs'

function loadFavs(): Set<number> {
  try {
    const arr = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]') as number[]
    return new Set(Array.isArray(arr) ? arr.filter((n) => typeof n === 'number') : [])
  } catch {
    return new Set()
  }
}

/** 流水线类型缓存（id → 是否 YAML 型；列表接口不返回 type，单条查后本地持久） */
const TYPES_KEY = 'yunxiao-flow-types'

function loadTypes(): Record<number, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(TYPES_KEY) ?? '{}') as Record<string, boolean>
    const out: Record<number, boolean> = {}
    for (const [k, b] of Object.entries(v)) {
      if (typeof b === 'boolean' && /^\d+$/.test(k)) out[Number(k)] = b
    }
    return out
  } catch {
    return {}
  }
}

function FlowTab() {
  const { message } = AntApp.useApp()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [running, setRunning] = useState<number | null>(null)
  // 服务端分页（每页固定 10 条）+ 名称搜索（服务端 pipelineName 过滤）
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<YxPipeline[]>([])
  const [hasNext, setHasNext] = useState(false)
  /** 服务端探测出的精确总数；探测期间 null，用当前页估算兜底 */
  const [total, setTotal] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [kw, setKw] = useState('')
  const [favOnly, setFavOnly] = useState(false)
  const [favs, setFavs] = useState<Set<number>>(loadFavs)
  const [favItems, setFavItems] = useState<YxPipeline[] | null>(null)
  /** id → 是否 YAML 型；本会话已查过的 id 不再重复请求 */
  const [types, setTypes] = useState<Record<number, boolean>>(loadTypes)
  const triedTypes = useRef<Set<number>>(new Set())

  const toggleFav = (id: number) =>
    setFavs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify([...next]))
      } catch {
        /* 超配额忽略 */
      }
      return next
    })

  // 搜索防抖：停顿 400ms 才生效，并回到第 1 页
  useEffect(() => {
    const t = setTimeout(() => setKw(query.trim()), 400)
    return () => clearTimeout(t)
  }, [query])
  useEffect(() => {
    setPage(1)
  }, [kw])

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    yxApi
      .pipelines(page, kw || undefined)
      .then((list) => {
        setItems(list)
        setHasNext(list.length >= 10)
      })
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }, [page, kw])

  // 关键词变化时探测精确总数（探测期间分页条用估算值，算好后自动校正）
  useEffect(() => {
    setTotal(null)
    yxApi
      .pipelineCount(kw || undefined)
      .then(setTotal)
      .catch(() => {})
  }, [kw])

  useEffect(() => {
    load()
  }, [load])

  // 收藏视图：逐个拉取收藏的流水线（收藏数量小，开销可控）
  useEffect(() => {
    if (!favOnly) return
    setFavItems(null)
    Promise.all([...favs].map((id) => yxApi.pipelineGet(id).catch(() => null))).then((list) =>
      setFavItems(list.filter((x): x is YxPipeline => x != null)),
    )
  }, [favOnly, favs])

  const run = (p: YxPipeline) => {
    Modal.confirm({
      title: '触发流水线运行',
      content: `确定立即运行「${p.pipelineName}」？`,
      okText: '运行',
      onOk: async () => {
        setRunning(p.pipelineId)
        try {
          const r = await yxApi.pipelineRun(p.pipelineId)
          message.success(r.runId ? `已触发运行（${r.runId}）` : '已触发运行')
        } catch (e) {
          message.error(errText(e))
        } finally {
          setRunning(null)
        }
      },
    })
  }

  const open = (p: YxPipeline) =>
    void openLinkInApp(
      { id: `yx-flow-${p.pipelineId}`, name: p.pipelineName, url: `https://flow.aliyun.com/pipelines/${p.pipelineId}/history` },
      (m) => message.error(m),
    )

  // YAML 查看：单条查询才带 type/pipelineConfig（公开 API 无保存接口，应用内只读）
  const [yamlFor, setYamlFor] = useState<{ name: string; isYaml: boolean; yaml: string } | null>(null)
  const [yamlLoading, setYamlLoading] = useState<number | null>(null)
  const viewYaml = (p: YxPipeline) => {
    setYamlLoading(p.pipelineId)
    yxApi
      .pipelineYaml(p.pipelineId)
      .then((r) => setYamlFor({ name: p.pipelineName, ...r }))
      .catch((e) => message.error(errText(e)))
      .finally(() => setYamlLoading(null))
  }

  // 收藏视图数据优先；总数估算：满页时多报一页让"下一页"可点，翻到空页自然收敛
  const shown = favOnly ? (favItems ?? []) : items
  const totalShown = favOnly
    ? favItems?.length ?? 0
    : (total ?? (hasNext ? page * 10 : (page - 1) * 10 + items.length))

  // 当前视图里类型未知的流水线批量单查（列表接口不返回 type，YAML 按钮按此显隐）
  const shownIds = shown.map((p) => p.pipelineId)
  const idsKey = shownIds.join(',')
  useEffect(() => {
    const missing = [...new Set(shownIds.filter((id) => !(id in types) && !triedTypes.current.has(id)))]
    if (missing.length === 0) return
    missing.forEach((id) => triedTypes.current.add(id))
    yxApi
      .pipelineTypes(missing)
      .then((list) =>
        setTypes((prev) => {
          const next = { ...prev }
          for (const t of list) next[t.id] = t.isYaml
          try {
            localStorage.setItem(TYPES_KEY, JSON.stringify(next))
          } catch {
            /* 超配额忽略 */
          }
          return next
        }),
      )
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          className="w-64"
          size="small"
          allowClear
          placeholder="搜索流水线名称…"
          prefix={<Search size={13} className="text-gray-400" />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Segmented
          size="small"
          value={favOnly ? 'fav' : 'all'}
          onChange={(v) => setFavOnly(v === 'fav')}
          options={[
            { value: 'all', label: '全部' },
            { value: 'fav', label: `我的收藏（${favs.size}）` },
          ]}
        />
      </div>
      {error ? <ErrAlert e={error} onRetry={load} /> : null}
      <Table
        rowKey="pipelineId"
        size="middle"
        loading={loading && shown.length === 0}
        dataSource={shown}
        pagination={
          favOnly
            ? false
            : {
                current: page,
                pageSize: 10,
                total: totalShown,
                onChange: (p) => setPage(p),
                showSizeChanger: false,
                showTotal: (n) => `共 ${n} 条`,
              }
        }
        columns={[
          {
            title: '',
            key: 'fav',
            width: 40,
            render: (_, p: YxPipeline) => (
              <button
                type="button"
                title={favs.has(p.pipelineId) ? '取消收藏' : '收藏'}
                onClick={() => toggleFav(p.pipelineId)}
                className={`transition-colors ${favs.has(p.pipelineId) ? 'text-amber-400' : 'text-gray-300 hover:text-amber-400 dark:text-gray-600'}`}
              >
                <Star size={15} fill={favs.has(p.pipelineId) ? 'currentColor' : 'none'} />
              </button>
            ),
          },
          { title: '流水线', dataIndex: 'pipelineName', ellipsis: true },
          { title: '创建时间', dataIndex: 'createTime', width: 110, render: (v: number) => fmtMs(v) },
          {
            title: '操作',
            key: 'actions',
            width: 230,
            render: (_, p: YxPipeline) => (
              <div className="flex gap-1">
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<Play size={12} />}
                  loading={running === p.pipelineId}
                  onClick={() => run(p)}
                >
                  运行
                </Button>
                <Button size="small" onClick={() => open(p)}>
                  打开
                </Button>
                {types[p.pipelineId] ? (
                  <Tooltip title="查看 YAML 配置">
                    <Button size="small" loading={yamlLoading === p.pipelineId} onClick={() => viewYaml(p)}>
                      YAML
                    </Button>
                  </Tooltip>
                ) : null}
              </div>
            ),
          },
        ]}
      />
      <Modal
        title={yamlFor ? `YAML · ${yamlFor.name}` : ''}
        open={!!yamlFor}
        onCancel={() => setYamlFor(null)}
        width={760}
        footer={
          yamlFor?.isYaml ? (
            <Button onClick={() => void copyText(yamlFor.yaml).then((ok) => ok && message.success('已复制 YAML'))}>
              复制
            </Button>
          ) : null
        }
        destroyOnHidden
      >
        {!yamlFor ? null : yamlFor.isYaml ? (
          <pre className="m-0 max-h-[60vh] overflow-auto rounded-lg bg-black/[0.04] p-3 font-mono text-xs leading-5 dark:bg-white/5">
            {yamlFor.yaml || '（空配置）'}
          </pre>
        ) : (
          <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            这是普通（经典模板）流水线，没有 YAML 配置；请在云效网页中查看和编辑。
          </div>
        )}
      </Modal>
    </div>
  )
}

// ===== 应用交付（AppStack） =====

/** 收藏的应用名（本机 localStorage，跨会话保留） */
const APP_FAV_KEY = 'yunxiao-appstack-favs'

function loadAppFavs(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(APP_FAV_KEY) ?? '[]') as string[]
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** 研发流程直达 URL（app/{name}/workflow/{wf}/stage/{st}/current）按应用缓存，避免每次重查 */
const wfUrlCache = new Map<string, string>()

/** 打开应用：直达研发流程页（取第一个有阶段的工作流），无研发流程时回落应用概览 */
async function openAppDeep(a: YxApp, onError: (m: string) => void) {
  const base = `https://devops.aliyun.com/appstack/app/${encodeURIComponent(a.name)}`
  let deep = wfUrlCache.get(a.name)
  if (!deep) {
    try {
      const wfs = await yxApi.appWorkflows(a.name)
      const wf = wfs.find((w) => w.stages.length > 0)
      if (wf) {
        deep = `${base}/workflow/${wf.sn}/stage/${wf.stages[0].sn}/current`
        wfUrlCache.set(a.name, deep)
      }
    } catch {
      /* 查询失败回落概览页 */
    }
  }
  void openLinkInApp({ id: `yx-app-${a.name}`, name: a.name, url: deep ?? base }, onError)
}

/** 「执行阶段」配置记忆：分支/变量值/备注按应用+阶段存最近一次执行的值 */
const STAGE_PARAMS_KEY = 'yunxiao-stage-params'
interface StageExecMemory {
  branch: string
  branchKey: string
  values: Record<string, string>
  remark: string
}

function loadStageMemory(appName: string, stageSn: string): StageExecMemory | null {
  try {
    const all = JSON.parse(localStorage.getItem(STAGE_PARAMS_KEY) ?? '{}') as Record<string, StageExecMemory>
    const m = all[`${appName}/${stageSn}`]
    return m && typeof m === 'object' && typeof m.values === 'object' && m.values !== null ? m : null
  } catch {
    return null
  }
}

function saveStageMemory(appName: string, stageSn: string, m: StageExecMemory) {
  try {
    const all = JSON.parse(localStorage.getItem(STAGE_PARAMS_KEY) ?? '{}') as Record<string, StageExecMemory>
    all[`${appName}/${stageSn}`] = m
    localStorage.setItem(STAGE_PARAMS_KEY, JSON.stringify(all))
  } catch {
    /* 超配额忽略 */
  }
}

/** 流水线运行状态 → Tag */
function runStatusTag(s: string) {
  const S: Record<string, { text: string; color: string }> = {
    SUCCESS: { text: '成功', color: 'success' },
    FAILED: { text: '失败', color: 'error' },
    RUNNING: { text: '运行中', color: 'processing' },
    WAITING: { text: '等待中', color: 'warning' },
    CANCELED: { text: '已取消', color: 'default' },
  }
  const v = S[s] ?? { text: s || '-', color: 'default' }
  return <Tag color={v.color}>{v.text}</Tag>
}

function AppStackTab() {
  const { message } = AntApp.useApp()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  // 全量拉取（约 200+ 个应用，keyset 翻页在 Rust 侧完成），搜索/收藏为客户端过滤
  const [apps, setApps] = useState<YxApp[]>([])
  const [query, setQuery] = useState('')
  const [kw, setKw] = useState('')
  const [favOnly, setFavOnly] = useState(false)
  const [favs, setFavs] = useState<Set<string>>(loadAppFavs)
  // 「运行」弹窗：目标应用 + 研发流程阶段；历史/执行为弹窗内子视图
  const [runFor, setRunFor] = useState<YxApp | null>(null)
  const [wfs, setWfs] = useState<YxWorkflow[] | null>(null)
  const [wfsLoading, setWfsLoading] = useState(false)

  // 「历史」子视图：阶段运行记录 + 按需展开的环境变量
  const [historyFor, setHistoryFor] = useState<YxStage | null>(null)
  const [runs, setRuns] = useState<YxPipelineRun[] | null>(null)
  const [runsLoading, setRunsLoading] = useState(false)
  const [paramsOf, setParamsOf] = useState<Record<number, YxRunParam[]>>({})
  const [paramsLoading, setParamsLoading] = useState<number | null>(null)

  // 「执行」表单：分支下拉 + 最近一次运行的变量模板 + 备注 + 上次配置
  const [execCtx, setExecCtx] = useState<{ app: YxApp; wf: YxWorkflow; st: YxStage } | null>(null)
  const [branch, setBranch] = useState('')
  const [branchKey, setBranchKey] = useState('')
  const [branches, setBranches] = useState<{ name: string; kind: 'branch' | 'tag' }[]>([])
  /** 分支列表已尝试加载（区分「加载中」与「无权限/空」） */
  const [refsLoaded, setRefsLoaded] = useState(false)
  const [varRows, setVarRows] = useState<YxRunParam[]>([])
  const [varsLoading, setVarsLoading] = useState(false)
  const [remark, setRemark] = useState('')
  const [useLast, setUseLast] = useState(true)
  const [hasMemory, setHasMemory] = useState(false)
  const [executing, setExecuting] = useState(false)
  const memoryRef = useRef<StageExecMemory | null>(null)
  const templateRef = useRef<StageExecMemory | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setKw(query.trim().toLowerCase()), 400)
    return () => clearTimeout(t)
  }, [query])

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    yxApi
      .apps()
      .then(setApps)
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const toggleFav = (name: string) =>
    setFavs((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      try {
        localStorage.setItem(APP_FAV_KEY, JSON.stringify([...next]))
      } catch {
        /* 超配额忽略 */
      }
      return next
    })

  const shown = apps.filter(
    (a) =>
      (!favOnly || favs.has(a.name)) &&
      (!kw || a.name.toLowerCase().includes(kw) || a.description.toLowerCase().includes(kw)),
  )

  const openApp = (a: YxApp) => void openAppDeep(a, (m) => message.error(m))

  const closeRun = () => {
    setRunFor(null)
    setHistoryFor(null)
    setExecCtx(null)
  }

  const openRun = (a: YxApp) => {
    setRunFor(a)
    setHistoryFor(null)
    setExecCtx(null)
    setWfs(null)
    setWfsLoading(true)
    yxApi
      .appWorkflows(a.name)
      .then(setWfs)
      .catch(() => setWfs([]))
      .finally(() => setWfsLoading(false))
  }

  // ===== 历史运行记录 =====

  const openHistory = (st: YxStage) => {
    setHistoryFor(st)
    setRuns(null)
    setParamsOf({})
    setRunsLoading(true)
    yxApi
      .pipelineRuns(st.pipelineId)
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setRunsLoading(false))
  }

  const toggleParams = (runId: number) => {
    if (paramsOf[runId]) {
      setParamsOf(Object.fromEntries(Object.entries(paramsOf).filter(([k]) => Number(k) !== runId)))
      return
    }
    if (!historyFor) return
    setParamsLoading(runId)
    yxApi
      .pipelineRunParams(historyFor.pipelineId, runId)
      .then((ps) => setParamsOf({ ...paramsOf, [runId]: ps }))
      .catch((e) => message.error(errText(e)))
      .finally(() => setParamsLoading(null))
  }

  // ===== 执行表单 =====

  /** 把一份配置（上次记忆 / 最近运行模板）套到表单字段上 */
  const applyConfig = (cfg: StageExecMemory, rows?: YxRunParam[]) => {
    setBranch(cfg.branch)
    setBranchKey(cfg.branchKey)
    setRemark(cfg.remark)
    const merge = (r: YxRunParam): YxRunParam => ({ ...r, value: cfg.values[r.key] ?? r.value })
    if (rows) setVarRows(rows.map(merge))
    else setVarRows((prev) => prev.map(merge))
  }

  const openExec = (a: YxApp, wf: YxWorkflow, st: YxStage) => {
    setExecCtx({ app: a, wf, st })
    setBranch(st.defaultBranch || 'master')
    setBranchKey((st.repoName || '').replace(/[.-]/g, '_'))
    setBranches([])
    setRefsLoaded(false)
    setVarRows([])
    setVarsLoading(true)
    const mem = loadStageMemory(a.name, st.sn)
    memoryRef.current = mem
    setHasMemory(!!mem)
    setUseLast(!!mem)
    templateRef.current = null
    // 变量模板：该阶段流水线最近一次运行的 globalParams（app 为空时按代码源仓库名预填）
    yxApi
      .pipelineRuns(st.pipelineId, 1)
      .then((list) => {
        const last = list[0]
        if (!last) return null
        return yxApi.pipelineRunParams(st.pipelineId, last.pipelineRunId).then((params) => {
          const rows = params.map((p) =>
            p.key === 'app' && !p.value && st.repoName ? { ...p, value: st.repoName } : p,
          )
          templateRef.current = {
            branch: st.defaultBranch || 'master',
            branchKey: (st.repoName || '').replace(/[.-]/g, '_'),
            values: Object.fromEntries(rows.filter((p) => !p.masked).map((p) => [p.key, p.value])),
            remark: '',
          }
          applyConfig(mem ?? templateRef.current!, rows)
          return null
        })
      })
      .catch(() => {})
      .finally(() => setVarsLoading(false))
    // 分支/标签下拉：source 自带 projectId 直取（按名搜索会漏掉 PAT 无权限的仓库），
    // 未携带时按仓库名查兜底；无权限的仓库会失败/为空，输入框仍可手填
    if (st.sourceType === 'codeup') {
      const refs = st.repoId
        ? Promise.resolve(yxApi.repoRefs(st.repoId))
        : st.repoName
          ? yxApi.codeupRepoId(st.repoName).then((id) => (id ? yxApi.repoRefs(id) : []))
          : Promise.resolve([])
      refs
        .then((list) => {
          setBranches(list)
          setRefsLoaded(true)
        })
        .catch(() => {
          setBranches([])
          setRefsLoaded(true)
        })
    } else {
      setBranches([])
      setRefsLoaded(true)
    }
  }

  const toggleUseLast = (v: boolean) => {
    setUseLast(v)
    const cfg = v ? memoryRef.current : templateRef.current
    if (cfg) applyConfig(cfg)
  }

  const doExecute = async () => {
    if (!execCtx) return
    const { app, wf, st } = execCtx
    const values: Record<string, string> = {}
    for (const r of varRows) {
      if (!r.masked) values[r.key] = r.value
    }
    const params: Record<string, string> = {}
    if (branch.trim() && branchKey.trim()) params[branchKey.trim()] = branch.trim()
    for (const [k, v] of Object.entries(values)) {
      if (v.trim()) params[k] = v.trim()
    }
    if (remark.trim()) params.FLOW_INST_RUNNING_COMMENT = remark.trim()
    setExecuting(true)
    try {
      const r = await yxApi.stageExecute(app.name, wf.sn, st.sn, params)
      saveStageMemory(app.name, st.sn, {
        branch: branch.trim(),
        branchKey: branchKey.trim(),
        values,
        remark: remark.trim(),
      })
      message.success(r.pipelineRunId ? `已触发（流水线运行 #${r.pipelineRunId}）` : '已触发执行')
      setExecCtx(null)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setExecuting(false)
    }
  }

  const fmt = (iso: string) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
  }
  const fmtRun = (ms: number) =>
    ms ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '-'

  const usableWfs = (wfs ?? []).filter((w) => w.stages.length > 0)
  /** 折叠区参数：app / release 之外的变量（dockerfile_path、harbor_* 等） */
  const otherRows = varRows.filter((r) => r.key !== 'app' && r.key !== 'release')

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          className="w-64"
          size="small"
          allowClear
          placeholder="搜索应用名 / 描述…"
          prefix={<Search size={13} className="text-gray-400" />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Segmented
          size="small"
          value={favOnly ? 'fav' : 'all'}
          onChange={(v) => setFavOnly(v === 'fav')}
          options={[
            { value: 'all', label: `全部（${apps.length}）` },
            { value: 'fav', label: `我的收藏（${favs.size}）` },
          ]}
        />
        <Button
          size="small"
          icon={<ExternalLink size={12} />}
          onClick={() =>
            void openLinkInApp(
              { id: 'yx-appstack', name: '应用交付', url: 'https://devops.aliyun.com/appstack/apps' },
              (m) => message.error(m),
            )
          }
        >
          在云效打开
        </Button>
      </div>
      {error ? <ErrAlert e={error} onRetry={load} /> : null}
      <Table
        rowKey="name"
        size="middle"
        loading={loading && apps.length === 0}
        dataSource={shown}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (n) => `共 ${n} 条`, hideOnSinglePage: true }}
        columns={[
          {
            title: '',
            key: 'fav',
            width: 40,
            render: (_, a: YxApp) => (
              <button
                type="button"
                title={favs.has(a.name) ? '取消收藏' : '收藏'}
                onClick={() => toggleFav(a.name)}
                className={`transition-colors ${favs.has(a.name) ? 'text-amber-400' : 'text-gray-300 hover:text-amber-400 dark:text-gray-600'}`}
              >
                <Star size={15} fill={favs.has(a.name) ? 'currentColor' : 'none'} />
              </button>
            ),
          },
          { title: '应用', dataIndex: 'name', ellipsis: true, render: (v: string) => <span className="font-medium">{v}</span> },
          { title: '描述', dataIndex: 'description', ellipsis: true, render: (v: string) => v || <span className="text-gray-400">-</span> },
          { title: '创建时间', dataIndex: 'gmtCreate', width: 165, render: (v: string) => <span className="text-xs text-gray-500 dark:text-gray-400">{fmt(v)}</span> },
          {
            title: '操作',
            key: 'actions',
            width: 160,
            render: (_, a: YxApp) => (
              <div className="flex gap-1">
                <Button size="small" type="primary" ghost icon={<Play size={12} />} onClick={() => openRun(a)}>
                  运行
                </Button>
                <Button size="small" onClick={() => openApp(a)}>
                  打开
                </Button>
              </div>
            ),
          },
        ]}
      />

      {/* 运行弹窗：阶段列表 / 历史记录 两个子视图 */}
      <Modal
        title={runFor ? `运行 · ${runFor.name}` : ''}
        open={!!runFor}
        onCancel={closeRun}
        footer={null}
        width={640}
        destroyOnHidden
      >
        {historyFor ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                运行记录 · {historyFor.name}
                <span className="ml-2 font-mono text-xs text-gray-400">#{historyFor.pipelineId}</span>
              </span>
              <span className="flex-1" />
              <Button
                size="small"
                icon={<ExternalLink size={12} />}
                onClick={() =>
                  void openLinkInApp(
                    {
                      id: `yx-flow-${historyFor.pipelineId}`,
                      name: historyFor.pipelineName || `流水线 ${historyFor.pipelineId}`,
                      url: `https://flow.aliyun.com/pipelines/${historyFor.pipelineId}/history`,
                    },
                    (m) => message.error(m),
                  )
                }
              >
                网页历史
              </Button>
              <Button size="small" onClick={() => setHistoryFor(null)}>
                返回
              </Button>
            </div>
            {runsLoading ? (
              <div className="grid h-24 place-items-center">
                <Spin />
              </div>
            ) : (runs ?? []).length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行记录" />
            ) : (
              runs!.map((r) => (
                <div key={r.pipelineRunId} className="rounded-lg border border-black/5 px-3 py-2 dark:border-white/10">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="shrink-0 font-mono text-xs text-gray-500">#{r.pipelineRunId}</span>
                    {runStatusTag(r.status)}
                    <span className="text-xs text-gray-400">
                      {fmtRun(r.startTime)}
                      {r.endTime ? ` → ${new Date(r.endTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}` : ''}
                    </span>
                    {r.triggerMode === 1 && <Tag bordered={false}>手动</Tag>}
                    <span className="flex-1" />
                    <Button
                      size="small"
                      type="link"
                      loading={paramsLoading === r.pipelineRunId}
                      onClick={() => toggleParams(r.pipelineRunId)}
                    >
                      {paramsOf[r.pipelineRunId] ? '收起变量' : '查看变量'}
                    </Button>
                  </div>
                  {paramsOf[r.pipelineRunId] ? (
                    <div className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 border-t border-black/5 pt-1.5 dark:border-white/10 sm:grid-cols-2">
                      {paramsOf[r.pipelineRunId].map((p) => (
                        <div key={p.key} className="flex gap-2 text-xs">
                          <span className="w-28 shrink-0 truncate font-mono text-gray-500" title={p.key}>
                            {p.key}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono" title={p.value}>
                            {p.masked ? '******（脱敏）' : p.value || '-'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : (
          <>
            <Alert
              type="info"
              showIcon
              className="!mb-3 !mt-1 !py-1.5"
              message={
                <span className="text-xs">选择研发流程阶段执行部署；可先看该阶段的历史运行与使用的变量。</span>
              }
            />
            {wfsLoading ? (
              <div className="grid h-24 place-items-center">
                <Spin />
              </div>
            ) : usableWfs.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该应用没有配置研发流程" />
            ) : (
              <div className="flex flex-col gap-3">
                {usableWfs.map((wf) => (
                  <div key={wf.sn}>
                    <div className="mb-1 text-xs font-medium text-gray-400">研发流程 · {wf.name}</div>
                    <div className="flex flex-col gap-1.5">
                      {wf.stages.map((st) => (
                        <div
                          key={st.sn}
                          className="flex flex-wrap items-center gap-2 rounded-lg border border-black/5 px-3 py-2 dark:border-white/10"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{st.name}</span>
                          {st.envLabel && <Tag bordered={false}>{st.envLabel}</Tag>}
                          {st.repoName && (
                            <span className="shrink-0 max-w-40 truncate font-mono text-[11px] text-gray-400" title={st.pipelineName}>
                              {st.repoName}
                            </span>
                          )}
                          <Tooltip title={st.pipelineId > 0 ? '查看该阶段的运行记录与变量' : '该阶段未绑定流水线'}>
                            <Button size="small" disabled={st.pipelineId === 0} onClick={() => openHistory(st)}>
                              历史
                            </Button>
                          </Tooltip>
                          <Tooltip title={st.pipelineId > 0 ? '研发流程执行接口触发' : '该阶段未绑定流水线'}>
                            <Button
                              size="small"
                              type="primary"
                              ghost
                              disabled={st.pipelineId === 0}
                              onClick={() => runFor && openExec(runFor, wf, st)}
                            >
                              执行
                            </Button>
                          </Tooltip>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Modal>

      {/* 执行表单：分支 + 最近一次运行的变量 + 备注 + 上次配置 */}
      <Modal
        title={execCtx ? `执行 · ${execCtx.app.name} · ${execCtx.st.name}` : ''}
        open={!!execCtx}
        onCancel={() => setExecCtx(null)}
        onOk={() => void doExecute()}
        confirmLoading={executing}
        okText="执行"
        cancelText="取消"
        width={580}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          className="!mb-3 !mt-1 !py-1.5"
          message={
            <span className="text-xs">
              变量取自该阶段流水线最近一次运行的配置，值可修改；分支以「变量名 =
              分支」随参数一并提交。
            </span>
          }
        />
        {/* 分支：Codeup 代码源给出分支下拉；无源 / 外部 GitLab 源为纯输入 */}
        <div className="mb-3">
          <div className="mb-1 text-xs font-medium text-gray-400">
            {execCtx?.st.sourceType === 'codeup' ? '分支 / 标签' : '分支'}
            {execCtx?.st.repoName ? `（代码源 ${execCtx.st.repoName}）` : ''}
          </div>
          <div className="flex items-center gap-2">
            <AutoComplete
              size="small"
              className="w-44"
              suffixIcon={<ChevronDown size={14} className="text-gray-400" />}
              value={branch}
              options={branches.map((b) => ({
                value: b.name,
                label: b.kind === 'tag' ? `${b.name}（标签）` : b.name,
              }))}
              onChange={(v) => setBranch(v)}
              placeholder={
                execCtx?.st.sourceType === 'codeup'
                  ? branches.length
                    ? '下拉选择或输入分支'
                    : '分支列表加载中…'
                  : '输入分支（该阶段无 Codeup 代码源）'
              }
              filterOption={(input, opt) =>
                String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
            <span className="shrink-0 text-xs text-gray-400">提交变量名</span>
            <Input
              size="small"
              className="w-40"
              value={branchKey}
              onChange={(e) => setBranchKey(e.target.value)}
            />
          </div>
          {execCtx?.st.sourceType === 'codeup' && refsLoaded && branches.length === 0 && (
            <div className="mt-1 text-[11px] text-amber-500">
              未读到分支列表（令牌可能无该仓库权限，或仓库只有默认分支），可直接输入分支名
            </div>
          )}
        </div>
        {varsLoading ? (
          <div className="mb-3 grid h-16 place-items-center">
            <Spin />
          </div>
        ) : (
          <>
            {varRows.length === 0 && (
              <div className="mb-3 text-xs text-gray-400">
                该流水线还没有运行记录或未定义变量，将按默认配置执行
              </div>
            )}
            {(['app', 'release'] as const).map((key) => {
              const row = varRows.find((r) => r.key === key)
              if (!row || row.masked) return null
              const label = key === 'app' ? 'app（子应用 / 系统名）' : 'release（镜像版本号）'
              const placeholder = key === 'app' ? '如 oss-management' : '如 1.0.0'
              return (
                <div key={key} className="mb-3">
                  <div className="mb-1 text-xs font-medium text-gray-400">{label}</div>
                  <Input
                    size="small"
                    value={row.value}
                    placeholder={placeholder}
                    onChange={(e) =>
                      setVarRows(varRows.map((x) => (x.key === key ? { ...x, value: e.target.value } : x)))
                    }
                  />
                </div>
              )
            })}
          </>
        )}
        <div className="mb-3">
          <div className="mb-1 text-xs font-medium text-gray-400">备注（运行记录中显示）</div>
          <Input
            size="small"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="如：修复 xx 问题"
          />
        </div>
        <Checkbox checked={useLast} disabled={!hasMemory} onChange={(e) => toggleUseLast(e.target.checked)}>
          使用上一次配置{hasMemory ? '' : '（暂无历史配置）'}
        </Checkbox>
        {!varsLoading && otherRows.length > 0 && (
          <Collapse
            ghost
            size="small"
            className="mt-1 [&_.ant-collapse-content-box]:!px-0 [&_.ant-collapse-content-box]:!pb-0"
            items={[
              {
                key: 'more',
                label: <span className="text-xs text-gray-500">更多参数（{otherRows.length}）</span>,
                children: (
                  <div className="flex flex-col gap-1.5">
                    {otherRows.map((r) => (
                      <div key={r.key} className="flex items-center gap-2">
                        <span className="w-36 shrink-0 truncate font-mono text-xs text-gray-500" title={r.key}>
                          {r.key}
                        </span>
                        <Input
                          size="small"
                          disabled={r.masked}
                          value={r.masked ? '******（脱敏，不提交）' : r.value}
                          onChange={(e) =>
                            setVarRows(varRows.map((x) => (x.key === r.key ? { ...x, value: e.target.value } : x)))
                          }
                          placeholder={r.masked ? '' : '值'}
                        />
                      </div>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        )}
      </Modal>
    </div>
  )
}

// ===== 页面 =====

export default function YunxiaoPage() {
  const { message } = AntApp.useApp()
  const [cfg, setCfg] = useState<YxConfig | null>(null)
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState('overview')

  const reload = useCallback(() => {
    yxApi
      .status()
      .then(setCfg)
      .catch(() => setCfg(null))
      .finally(() => setReady(true))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const disconnect = async () => {
    try {
      await yxApi.disconnect()
      message.success('已断开云效接入')
      reload()
    } catch (e) {
      message.error(errText(e))
    }
  }

  if (!ready) {
    return (
      <div className="grid h-full place-items-center">
        <Spin />
      </div>
    )
  }

  if (!cfg?.orgId) {
    return <YunxiaoOnboarding onDone={reload} />
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-8 pt-8">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-orange-500 to-rose-500 text-sm font-bold text-white shadow-sm">
          云
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-base font-semibold">
            云效 DevOps
            <Tag bordered={false} color="orange">
              {cfg.orgName || cfg.orgId}
            </Tag>
          </div>
          <div className="flex items-center gap-1 text-xs text-gray-400">
            <ClipboardCheck size={12} />
            {cfg.userName || '已接入'} · 个人访问令牌（PAT）
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Popconfirm title="断开后需重新粘贴令牌接入" okText="断开" cancelText="取消" onConfirm={() => void disconnect()}>
            <Button danger ghost icon={<Unplug size={13} />} size="small">
              断开
            </Button>
          </Popconfirm>
        </div>
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'overview', label: '工作台', children: <OverviewTab goTab={setTab} /> },
          { key: 'efforts', label: '报工月历', children: <EffortsTab /> },
          { key: 'projects', label: '业务空间', children: <ProjectsTab orgId={cfg.orgId} /> },
          { key: 'repos', label: '代码仓库', children: <ReposTab /> },
          { key: 'flow', label: '流水线', children: <FlowTab /> },
          { key: 'appstack', label: '应用交付', children: <AppStackTab /> },
        ]}
      />
      <div className="pb-2 text-xs text-gray-400">
        <KeyRound size={12} className="mr-1 inline" />
        令牌在云效「个人设置 → 个人访问令牌」管理；权限变更或令牌过期后请重新接入。
      </div>
    </div>
  )
}
