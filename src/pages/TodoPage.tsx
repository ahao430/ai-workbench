/**
 * 待办：左侧普通待办清单（不含时间，随记随清）+ 右侧日程（月历展示每天事项、
 * 选中日列表、已过期汇总）。带时间的事项进日程月历；不带时间的留清单。
 * 数据只存本机 sqlite。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { App as AntApp, Dropdown, Popconfirm, Segmented } from 'antd'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eraser,
  LayoutGrid,
  List,
  Plus,
  Trash2,
} from 'lucide-react'
import { todoRepo, type Todo } from '../db/todos'

const WK = ['一', '二', '三', '四', '五', '六', '日']

const keyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 月历网格：从包含当月 1 号的那周的周一开始，固定 6 行 42 格（高度稳定不跳版） */
function gridDays(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const start = new Date(first)
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7))
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

const fmtTime = (ts: number) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** 时刻为 00:00 视为"只定到天"，列表/月历不展示时间前缀 */
const isMidnight = (ts: number) => {
  const d = new Date(ts)
  return d.getHours() === 0 && d.getMinutes() === 0
}
const fmtShort = (ts: number) => {
  const d = new Date(ts)
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  return isMidnight(ts) ? md : `${md} ${fmtTime(ts)}`
}

/** 待办背景色调色板：创建时随机分配并落库（下标 1..N；0 = 不着色，旧数据兜底）。
 *  同一份数据浅/深主题各一档透明度，经 CSS 变量 + dark: 变体切换。 */
const PALETTE: { l: string; d: string }[] = [
  { l: 'rgba(251,191,36,0.24)', d: 'rgba(251,191,36,0.14)' }, // 琥珀
  { l: 'rgba(96,165,250,0.22)', d: 'rgba(96,165,250,0.16)' }, // 蓝
  { l: 'rgba(74,222,128,0.20)', d: 'rgba(74,222,128,0.14)' }, // 绿
  { l: 'rgba(244,114,182,0.20)', d: 'rgba(244,114,182,0.14)' }, // 粉
  { l: 'rgba(167,139,250,0.20)', d: 'rgba(167,139,250,0.16)' }, // 紫
  { l: 'rgba(251,146,60,0.20)', d: 'rgba(251,146,60,0.14)' }, // 橙
  { l: 'rgba(45,212,191,0.20)', d: 'rgba(45,212,191,0.14)' }, // 青
  { l: 'rgba(248,113,113,0.18)', d: 'rgba(248,113,113,0.14)' }, // 玫红
]
const rndColor = () => 1 + Math.floor(Math.random() * PALETTE.length)
const colorVars = (i: number): React.CSSProperties | undefined =>
  i
    ? ({
        '--todo-c': PALETTE[(i - 1) % PALETTE.length].l,
        '--todo-cd': PALETTE[(i - 1) % PALETTE.length].d,
      } as React.CSSProperties)
    : undefined
const colorCls = (i: number) => (i ? 'bg-[color:var(--todo-c)] dark:bg-[color:var(--todo-cd)]' : '')

/** 一条待办：row=行式（日程区/清单列表态），card=磁贴式（清单卡片态） */
function TodoRow({
  t,
  prefix,
  layout = 'row',
  onToggle,
  onRemove,
}: {
  t: Todo
  prefix?: string
  layout?: 'row' | 'card'
  onToggle: (t: Todo) => void
  onRemove: (id: string) => void
}) {
  const check = (
    <button
      type="button"
      onClick={() => onToggle(t)}
      title={t.done ? '标记未完成' : '标记完成'}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
        t.done
          ? 'border-emerald-500 text-emerald-500'
          : 'border-gray-400 text-transparent hover:border-indigo-500 dark:border-gray-500'
      }`}
    >
      <Check size={11} strokeWidth={3} />
    </button>
  )
  const del = (
    <Popconfirm title="删除该待办？" onConfirm={() => onRemove(t.id)}>
      <button
        type="button"
        className="shrink-0 text-gray-300 opacity-0 transition-opacity hover:text-rose-500 group-hover:opacity-100"
      >
        <Trash2 size={14} />
      </button>
    </Popconfirm>
  )

  if (layout === 'card') {
    return (
      <div
        style={colorVars(t.color)}
        className={`group relative rounded-lg border border-black/5 p-3 pr-7 shadow-sm dark:border-white/10 ${
          t.color ? colorCls(t.color) : 'bg-white dark:bg-white/5'
        } ${t.done ? 'opacity-70' : 'hover:border-indigo-300/60 dark:hover:border-indigo-400/40'}`}
      >
        {check}
        <div className={`mt-1.5 break-words text-[13px] leading-snug ${t.done ? 'text-gray-400 line-through dark:text-gray-500' : ''}`}>
          {t.title}
        </div>
        {prefix && <div className="mt-1 text-[10px] text-gray-400">{prefix}</div>}
        <div className="absolute right-1.5 top-1.5">{del}</div>
      </div>
    )
  }
  return (
    <div
      style={colorVars(t.color)}
      className={`group flex items-start gap-2 rounded-lg px-2 py-1.5 ${colorCls(t.color)}`}
    >
      {check}
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[13px] ${t.done ? 'text-gray-400 line-through dark:text-gray-500' : ''}`}>
          {t.title}
        </div>
        {prefix && <div className="mt-0.5 text-[10px] text-gray-400">{prefix}</div>}
      </div>
      {del}
    </div>
  )
}

/** 快捷添加行：标题 + 可选时刻，回车或 + 提交 */
function QuickAdd({
  placeholder,
  withTime,
  tall,
  onAdd,
}: {
  placeholder: string
  withTime?: boolean
  tall?: boolean
  onAdd: (title: string, time: string) => void
}) {
  const [v, setV] = useState('')
  const [tm, setTm] = useState('')
  const submit = () => {
    const t = v.trim()
    if (!t) return
    onAdd(t, tm)
    setV('')
    setTm('')
  }
  const h = tall ? 'h-8 text-[13px]' : 'h-7 text-xs'
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder={placeholder}
        className={`min-w-0 flex-1 rounded-md border border-black/10 bg-transparent px-2 outline-none placeholder:text-gray-400 focus:border-indigo-400 dark:border-white/10 ${h}`}
      />
      {withTime && (
        <input
          type="time"
          value={tm}
          onChange={(e) => setTm(e.target.value)}
          className={`w-[70px] shrink-0 rounded-md border border-black/10 bg-transparent px-1 text-xs outline-none focus:border-indigo-400 [color-scheme:light] dark:border-white/10 dark:[color-scheme:dark]`}
        />
      )}
      <button
        type="button"
        onClick={submit}
        title="添加"
        className={`flex shrink-0 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-500 transition-colors hover:bg-indigo-500/20 ${tall ? 'h-8 w-8' : 'h-7 w-7'}`}
      >
        <Plus size={14} />
      </button>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-gray-400 dark:text-gray-500">{children}</div>
}

type ViewMode = 'list' | 'card'

export default function TodoPage() {
  const { modal } = AntApp.useApp()
  const [todos, setTodos] = useState<Todo[]>([])
  const [anchor, setAnchor] = useState(() => new Date()) // 月历锚点月份
  const [selKey, setSelKey] = useState(() => keyOf(new Date()))
  // 清单布局偏好（卡片/列表）记在本地，跨会话保留
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem('todo-view') === 'card' ? 'card' : 'list'))
  useEffect(() => {
    try {
      localStorage.setItem('todo-view', view)
    } catch {
      /* 超配额忽略 */
    }
  }, [view])

  const todayKey = keyOf(new Date())
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime()

  const reload = useCallback(() => {
    todoRepo
      .list()
      .then(setTodos)
      .catch(() => {})
  }, [])
  useEffect(() => {
    reload()
  }, [reload])

  /** 月历按天分组（未安排的不进月历） */
  const byDay = useMemo(() => {
    const m = new Map<string, Todo[]>()
    for (const t of todos) {
      if (t.dueAt == null) continue
      const k = keyOf(new Date(t.dueAt))
      const arr = m.get(k) ?? []
      arr.push(t)
      m.set(k, arr)
    }
    return m
  }, [todos])

  // 完成不即时移除：勾选只加删除线并沉底，等手动删除或批量清空
  const selTodos = useMemo(() => byDay.get(selKey) ?? [], [byDay, selKey])
  const overdue = useMemo(
    () => todos.filter((t) => !t.done && t.dueAt != null && t.dueAt < todayStart),
    [todos, todayStart],
  )
  const unscheduled = useMemo(() => todos.filter((t) => t.dueAt == null), [todos])

  const addAt = async (title: string, dayKey: string, time: string) => {
    await todoRepo.create(title, new Date(`${dayKey}T${time || '00:00'}:00`).getTime(), rndColor())
    reload()
  }
  const toggle = async (t: Todo) => {
    await todoRepo.setDone(t.id, !t.done)
    reload()
  }
  const remove = async (id: string) => {
    await todoRepo.remove(id)
    reload()
  }
  const shiftMonth = (delta: number) =>
    setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + delta, 1))
  const goToday = () => {
    setAnchor(new Date())
    setSelKey(keyOf(new Date()))
  }

  const selDate = new Date(`${selKey}T00:00:00`)
  const selLabel = `${selDate.getMonth() + 1}月${selDate.getDate()}日 周${WK[(selDate.getDay() + 6) % 7]}`

  const chipCls = (t: Todo) =>
    t.done
      ? 'text-gray-400 line-through dark:text-gray-500'
      : t.dueAt != null && t.dueAt < todayStart
        ? 'text-rose-500'
        : 'text-gray-600 dark:text-gray-300'

  return (
    <div className="mx-auto w-full max-w-7xl px-8 py-10">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="m-0 text-lg font-semibold">待办</h2>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* 左：普通待办清单（不含时间），支持 列表/卡片 两种布局 */}
        <div>
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-sm font-medium">
              待办清单
              <span className="ml-2 text-[11px] font-normal text-gray-400">
                {unscheduled.filter((t) => !t.done).length} 项未完成
              </span>
            </span>
            <div className="flex items-center gap-1.5">
              <Segmented
                size="small"
                value={view}
                onChange={(v) => setView(v as ViewMode)}
                options={[
                  { value: 'list', label: '列表', icon: <List size={13} /> },
                  { value: 'card', label: '卡片', icon: <LayoutGrid size={13} /> },
                ]}
              />
              <Dropdown
                menu={{
                  items: [
                    { key: 'done', label: '清空已完成' },
                    { key: 'all', label: '清空全部', danger: true },
                  ],
                  onClick: ({ key }) => {
                    const all = key === 'all'
                    modal.confirm({
                      title: all ? '清空全部待办？' : '清空已完成的待办？',
                      content: all
                        ? '清单与日程中的所有待办都会删除，不可恢复。'
                        : '已完成的事项将从清单与日程中移除。',
                      okText: '清空',
                      okButtonProps: { danger: true },
                      cancelText: '取消',
                      onOk: () => todoRepo.clear(!all).then(reload),
                    })
                  },
                }}
              >
                <button
                  type="button"
                  className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-300"
                >
                  <Eraser size={12} />
                  清空
                  <ChevronDown size={11} />
                </button>
              </Dropdown>
            </div>
          </div>

          {view === 'list' ? (
            <div className="rounded-xl bg-white p-2 shadow-sm dark:bg-white/5">
              <QuickAdd
                tall
                placeholder="添加待办，回车保存…"
                onAdd={(title) => void todoRepo.create(title, null, rndColor()).then(reload)}
              />
              {unscheduled.length === 0 && (
                <div className="px-2 py-10 text-center text-xs text-gray-400">
                  清单空空的，从上方输入第一条待办吧
                </div>
              )}
              {unscheduled.map((t) => (
                <TodoRow key={t.id} t={t} onToggle={toggle} onRemove={remove} />
              ))}
            </div>
          ) : (
            <div>
              <QuickAdd
                tall
                placeholder="添加待办，回车保存…"
                onAdd={(title) => void todoRepo.create(title, null, rndColor()).then(reload)}
              />
              {unscheduled.length === 0 ? (
                <div className="rounded-xl border border-dashed border-black/10 py-10 text-center text-xs text-gray-400 dark:border-white/10">
                  清单空空的，从上方输入第一条待办吧
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-2">
                  {unscheduled.map((t) => (
                    <TodoRow key={t.id} t={t} layout="card" onToggle={toggle} onRemove={remove} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 右：日程（月历 + 选中日 + 已过期） */}
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => shiftMonth(-1)}
                className="rounded-md p-1 text-gray-500 hover:bg-black/5 dark:text-gray-400 dark:hover:bg-white/10"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="w-28 text-center text-sm font-medium tabular-nums">
                {anchor.getFullYear()} 年 {anchor.getMonth() + 1} 月
              </span>
              <button
                type="button"
                onClick={() => shiftMonth(1)}
                className="rounded-md p-1 text-gray-500 hover:bg-black/5 dark:text-gray-400 dark:hover:bg-white/10"
              >
                <ChevronRight size={16} />
              </button>
              <button
                type="button"
                onClick={goToday}
                className="rounded-md border border-black/10 px-2 py-0.5 text-xs text-gray-500 hover:bg-black/5 dark:border-white/10 dark:text-gray-400 dark:hover:bg-white/10"
              >
                今天
              </button>
            </div>

            <div className="grid grid-cols-7 rounded-t-xl bg-black/[0.03] dark:bg-white/5">
              {WK.map((w) => (
                <div key={w} className="py-1.5 text-center text-[11px] text-gray-400">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 overflow-hidden rounded-b-xl border-l border-t border-black/5 bg-white shadow-sm dark:border-white/10 dark:bg-white/5">
              {gridDays(anchor).map((d) => {
                const k = keyOf(d)
                const inMonth = d.getMonth() === anchor.getMonth()
                const list = byDay.get(k) ?? []
                return (
                  <button
                    type="button"
                    key={k}
                    onClick={() => setSelKey(k)}
                    className={`flex min-h-[80px] flex-col items-stretch gap-0.5 border-b border-r border-black/5 p-1.5 text-left transition-colors dark:border-white/10 ${
                      k === selKey ? 'bg-indigo-500/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'
                    } ${inMonth ? '' : 'opacity-40'}`}
                  >
                    <span
                      className={`mb-0.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] tabular-nums ${
                        k === todayKey
                          ? 'bg-indigo-500 font-semibold text-white'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {d.getDate()}
                    </span>
                    {list.slice(0, 3).map((t) => (
                      <span
                        key={t.id}
                        style={colorVars(t.color)}
                        className={`flex items-baseline gap-1 truncate rounded px-1 text-[10px] leading-4 ${colorCls(t.color)} ${chipCls(t)}`}
                      >
                        {t.dueAt != null && !isMidnight(t.dueAt) && (
                          <span className="font-medium tabular-nums">{fmtTime(t.dueAt)}</span>
                        )}
                        <span className="truncate">{t.title}</span>
                      </span>
                    ))}
                    {list.length > 3 && (
                      <span className="px-1 text-[10px] leading-4 text-gray-400">+{list.length - 3} 项</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="rounded-xl bg-white p-2 shadow-sm dark:bg-white/5">
            <SectionTitle>
              {selLabel}
              {selTodos.length > 0 && ` · ${selTodos.length} 项`}
            </SectionTitle>
            {selTodos.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-gray-400">当天暂无事项</div>
            )}
            {selTodos.map((t) => (
              <TodoRow key={t.id} t={t} onToggle={toggle} onRemove={remove} />
            ))}
            <QuickAdd placeholder={`添加到 ${selLabel}…`} withTime onAdd={(title, time) => void addAt(title, selKey, time)} />
          </div>

          {overdue.length > 0 && (
            <div className="rounded-xl bg-white p-2 shadow-sm dark:bg-white/5">
              <SectionTitle>已过期 · {overdue.length} 项</SectionTitle>
              {overdue.map((t) => (
                <TodoRow key={t.id} t={t} prefix={fmtShort(t.dueAt!)} onToggle={toggle} onRemove={remove} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
