import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { Popover, Tooltip } from 'antd'
import {
  BarChart3,
  BookOpen,
  BookText,
  Bot,
  Boxes,
  ChevronDown,
  Coins,
  ExternalLink,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutGrid,
  ListTodo,
  MessageSquare,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Puzzle,
  Settings,
  Table2,
  Timer,
  Wand2,
  Workflow,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useUiStore } from '../../stores/ui'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

/** 折叠子菜单父节点：无路由，点击展开/收起；侧栏收起时以弹层展示子项 */
interface NavMenu {
  key: string
  label: string
  icon: LucideIcon
  children: NavItem[]
}

type NavEntry = NavItem | NavMenu

const ACTIVE_CLS = 'bg-indigo-500/10 font-medium text-indigo-600 dark:text-indigo-400'
const IDLE_CLS = 'text-gray-600 hover:bg-black/5 dark:text-gray-400 dark:hover:bg-white/5'

const WORK_MENU: NavMenu = {
  key: 'work',
  label: '办公',
  icon: LayoutGrid,
  children: [
    { to: '/notes', label: '笔记', icon: NotebookPen },
    { to: '/todo', label: '待办', icon: ListTodo },
  ],
}

/** 创作类工具聚合分组（排在办公前面） */
const TOOLS_MENU: NavMenu = {
  key: 'tools',
  label: '工具',
  icon: Wrench,
  children: [
    { to: '/draw', label: '画图', icon: ImageIcon },
    { to: '/retouch', label: '修图', icon: Wand2 },
    { to: '/diagram', label: '流程图', icon: Workflow },
    { to: '/charts', label: '图表', icon: BarChart3 },
    { to: '/sheet', label: '表格', icon: Table2 },
  ],
}

const NAV_GROUPS: { title?: string; items: NavEntry[] }[] = [
  { items: [{ to: '/', label: '看板', icon: LayoutDashboard }] },
  {
    title: '工作',
    items: [
      { to: '/chat', label: 'Chat', icon: MessageSquare },
      { to: '/agent', label: 'Agent', icon: Bot },
      TOOLS_MENU,
      WORK_MENU,
    ],
  },
  {
    title: '资源',
    items: [
      { to: '/skills', label: 'Skills', icon: Puzzle },
      { to: '/mcp', label: 'MCP', icon: Plug },
      { to: '/knowledge', label: '知识库', icon: BookOpen },
      { to: '/yuque', label: '语雀', icon: BookText },
    ],
  },
  {
    title: '服务管理',
    items: [
      { to: '/yunxiao', label: '云效', icon: Boxes },
      { to: '/ai-service', label: 'AI 服务', icon: Coins },
      { to: '/links', label: '链接', icon: ExternalLink },
      { to: '/tasks', label: '定时任务', icon: Timer },
    ],
  },
]

const SETTINGS_ITEM: NavItem = { to: '/settings', label: '设置', icon: Settings }

const ALL_MENUS: NavMenu[] = NAV_GROUPS.flatMap((g) => g.items.filter((e): e is NavMenu => 'children' in e))

/** 展开状态持久化：记住用户手动展开/收起过哪些分组 */
const OPEN_KEY = 'aw-sidebar:menus'

function pathMatches(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`)
}

function loadOpenKeys(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function SidebarMenu({
  menu,
  open,
  onToggle,
  collapsed,
}: {
  menu: NavMenu
  open: boolean
  onToggle: (key: string) => void
  collapsed: boolean
}) {
  const location = useLocation()
  const [popOpen, setPopOpen] = useState(false)
  const Icon = menu.icon
  // 子项激活时父行保持高亮，收起状态下也能看出所在分组
  const childActive = menu.children.some((c) => pathMatches(location.pathname, c.to))

  const head = (
    <button
      aria-label={menu.label}
      onClick={() => (collapsed ? setPopOpen(!popOpen) : onToggle(menu.key))}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${childActive ? ACTIVE_CLS : IDLE_CLS}`}
    >
      <Icon size={18} strokeWidth={2} className="shrink-0" />
      {!collapsed && <span className="truncate">{menu.label}</span>}
      {!collapsed && (
        <ChevronDown size={14} className={`ml-auto shrink-0 text-gray-400 transition-transform ${open ? '' : '-rotate-90'}`} />
      )}
    </button>
  )

  if (collapsed) {
    return (
      <Popover
        open={popOpen}
        onOpenChange={setPopOpen}
        placement="rightTop"
        trigger="click"
        content={
          <div className="flex w-32 flex-col gap-0.5">
            {menu.children.map(({ to, label, icon: ChildIcon }) => (
              <NavLink
                key={to}
                to={to}
                onClick={() => setPopOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors ${isActive ? ACTIVE_CLS : IDLE_CLS}`
                }
              >
                <ChildIcon size={16} strokeWidth={2} className="shrink-0" />
                <span className="truncate">{label}</span>
              </NavLink>
            ))}
          </div>
        }
      >
        {head}
      </Popover>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      {head}
      {open && (
        <div className="ml-[22px] flex flex-col gap-1 border-l border-black/10 pl-2 dark:border-white/10">
          {menu.children.map(({ to, label, icon: ChildIcon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${isActive ? ACTIVE_CLS : IDLE_CLS}`
              }
            >
              <ChildIcon size={16} strokeWidth={2} className="shrink-0" />
              <span className="truncate">{label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const location = useLocation()
  const [openKeys, setOpenKeys] = useState<string[]>(loadOpenKeys)

  // 路由进入某分组子页时自动展开该分组（只加不减，不覆盖用户的手动收起）
  useEffect(() => {
    const hit = ALL_MENUS.find((m) => m.children.some((c) => pathMatches(location.pathname, c.to)))?.key
    if (hit) setOpenKeys((ks) => (ks.includes(hit) ? ks : [...ks, hit]))
  }, [location.pathname])

  const toggleMenu = (key: string) =>
    setOpenKeys((ks) => {
      const next = ks.includes(key) ? ks.filter((k) => k !== key) : [...ks, key]
      localStorage.setItem(OPEN_KEY, JSON.stringify(next))
      return next
    })

  const renderLink = ({ to, label, icon: Icon }: NavItem) => {
    const link = (
      <NavLink
        to={to}
        end={to === '/'}
        className={({ isActive }) => `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${isActive ? ACTIVE_CLS : IDLE_CLS}`}
      >
        <Icon size={18} strokeWidth={2} className="shrink-0" />
        {!collapsed && <span className="truncate">{label}</span>}
      </NavLink>
    )
    return collapsed ? (
      <Tooltip key={to} title={label} placement="right">
        {link}
      </Tooltip>
    ) : (
      <div key={to}>{link}</div>
    )
  }

  const renderEntry = (entry: NavEntry) =>
    'children' in entry ? (
      <SidebarMenu key={entry.key} menu={entry} open={openKeys.includes(entry.key)} onToggle={toggleMenu} collapsed={collapsed} />
    ) : (
      renderLink(entry)
    )

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-black/5 bg-white transition-[width] dark:border-white/10 dark:bg-[#1b1b22] ${
        collapsed ? 'w-14' : 'w-48'
      }`}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-4">
        <img src="/hero/app-icon.png" alt="" className="h-7 w-7 shrink-0 rounded-[7px] shadow-sm" draggable={false} />
        {!collapsed && <span className="text-[15px] font-semibold">AI 工作台</span>}
      </div>

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.title ?? `group-${gi}`} className="flex flex-col gap-1">
            {!collapsed && group.title && (
              <div className="px-3 pb-0.5 pt-1 text-xs text-gray-400 dark:text-gray-500">
                {group.title}
              </div>
            )}
            {group.items.map(renderEntry)}
          </div>
        ))}
      </nav>

      <div className="flex flex-col gap-1 border-t border-black/5 px-2 py-2 dark:border-white/10">
        {renderLink(SETTINGS_ITEM)}
        <button
          onClick={toggleSidebar}
          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-indigo-500/90 transition-colors hover:bg-indigo-500/10 dark:text-indigo-400/90 dark:hover:bg-indigo-400/10"
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          {!collapsed && <span>收起侧栏</span>}
        </button>
      </div>
    </aside>
  )
}
