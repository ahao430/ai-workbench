import { useMemo, useState } from 'react'
import { App, AutoComplete, Button, Card, Input, Modal, Popconfirm, Switch, Tag } from 'antd'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Building2, ExternalLink, Home, Pencil, Plus, Trash2 } from 'lucide-react'
import { isTauri } from '../api/ipc'
import { normalizeUrl, openLinkInApp } from '../lib/openLink'

interface CompanyLink {
  id: string
  name: string
  group: string
  url: string
  desc?: string
  /** 在看板「常用入口」展示 */
  home?: boolean
}

/** 内置种子链接（通用版为空，全部由用户自行添加） */
const DEFAULT_LINKS: CompanyLink[] = []

const LIST_KEY = 'aw-links-list'
/** 用户显式删除过的内置预设 id：版本升级补齐新预设时不复活 */
const DELETED_KEY = 'aw-links-deleted'
const legacyUrlKey = (id: string) => `aw-link-url-${id}`

function loadLinks(): CompanyLink[] {
  let links: CompanyLink[] | null = null
  try {
    const raw = localStorage.getItem(LIST_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as CompanyLink[]
      if (Array.isArray(parsed)) links = parsed
    }
  } catch {
    /* 数据损坏则重新播种 */
  }
  if (!links) {
    const seeded = DEFAULT_LINKS.map((l) => ({
      ...l,
      // 旧版按链接存的地址优先，没有则用内置默认地址（否则新装用户拿到一排空地址）
      url: localStorage.getItem(legacyUrlKey(l.id))?.trim() || l.url,
    }))
    localStorage.setItem(LIST_KEY, JSON.stringify(seeded))
    DEFAULT_LINKS.forEach((l) => localStorage.removeItem(legacyUrlKey(l.id)))
    return seeded
  }
  // 版本升级补齐：往存量列表追加用户还没见过（且没删过）的内置预设；
  // 预设地址为空时回填内置默认值（用户已填的非空地址不动）
  let deleted: string[] = []
  try {
    const d = JSON.parse(localStorage.getItem(DELETED_KEY) ?? '[]') as unknown
    if (Array.isArray(d)) deleted = d.filter((x): x is string => typeof x === 'string')
  } catch {
    /* ignore */
  }
  const byId = new Map(DEFAULT_LINKS.map((l) => [l.id, l]))
  let changed = false
  links = links.map((l) => {
    const d = byId.get(l.id)
    if (d && !l.url && d.url) {
      changed = true
      return { ...l, url: d.url }
    }
    return l
  })
  const known = new Set(links.map((l) => l.id))
  const missing = DEFAULT_LINKS.filter((l) => !known.has(l.id) && !deleted.includes(l.id))
  if (missing.length || changed) {
    links = [...links, ...missing]
    localStorage.setItem(LIST_KEY, JSON.stringify(links))
  }
  return links
}

function genId() {
  return `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 链接：常用系统统一入口；点击卡片在应用内窗口（webview）打开，可编辑/新增/删除 */
export default function LinksPage() {
  const { message } = App.useApp()
  const [links, setLinks] = useState<CompanyLink[]>(loadLinks)
  const [editing, setEditing] = useState<CompanyLink | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [name, setName] = useState('')
  const [group, setGroup] = useState('')
  const [url, setUrl] = useState('')
  const [desc, setDesc] = useState('')

  const persist = (next: CompanyLink[]) => {
    setLinks(next)
    localStorage.setItem(LIST_KEY, JSON.stringify(next))
  }

  const openEdit = (l: CompanyLink | null) => {
    setEditing(l ?? { id: '', name: '', group: '常用', url: '', desc: '' })
    setIsNew(!l)
    setName(l?.name ?? '')
    setGroup(l?.group ?? '常用')
    setUrl(l?.url ?? '')
    setDesc(l?.desc ?? '')
  }

  const save = () => {
    if (!editing) return
    if (!name.trim()) {
      message.warning('请填写链接名称')
      return
    }
    const item: CompanyLink = {
      id: isNew ? genId() : editing.id,
      name: name.trim(),
      group: group.trim() || '常用',
      url: normalizeUrl(url),
      desc: desc.trim() || undefined,
      home: editing.home,
    }
    persist(isNew ? [...links, item] : links.map((l) => (l.id === editing.id ? item : l)))
    setEditing(null)
    message.success(isNew ? '已添加' : '已保存')
  }

  const remove = () => {
    if (!editing || isNew) return
    // 内置预设被删时记下 id，下次升级补齐新预设时不复活它
    if (DEFAULT_LINKS.some((l) => l.id === editing.id)) {
      try {
        const d = JSON.parse(localStorage.getItem(DELETED_KEY) ?? '[]') as unknown
        const deleted = Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : []
        if (!deleted.includes(editing.id)) localStorage.setItem(DELETED_KEY, JSON.stringify([...deleted, editing.id]))
      } catch {
        /* ignore */
      }
    }
    persist(links.filter((l) => l.id !== editing.id))
    setEditing(null)
    message.success('已删除')
  }

  /** 应用内窗口打开（公共实现）；未配置地址时引导编辑 */
  const openInApp = (l: CompanyLink) => {
    if (!normalizeUrl(l.url)) {
      message.info('请先为该链接配置访问地址')
      openEdit(l)
      return
    }
    void openLinkInApp(l, (msg) => message.error(msg))
  }

  const openExternal = async (l: CompanyLink) => {
    const u = normalizeUrl(l.url)
    if (!u) {
      message.info('请先为该链接配置访问地址')
      openEdit(l)
      return
    }
    if (isTauri) await openUrl(u)
    else window.open(u, '_blank')
  }

  const groups = useMemo(() => [...new Set(links.map((l) => l.group))], [links])

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-10">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-lg font-semibold">链接</h2>
        <Button type="primary" size="small" icon={<Plus size={14} />} onClick={() => openEdit(null)}>
          新增链接
        </Button>
      </div>
      <p className="mb-4 mt-1 text-xs text-gray-400">
        常用系统统一入口；点击卡片在应用内窗口打开，卡片右上角可在浏览器打开或编辑。
      </p>

      {groups.map((g) => (
        <div key={g} className="mb-5">
          <div className="mb-2 text-xs font-medium text-gray-400">{g}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {links
              .filter((l) => l.group === g)
              .map((l) => (
                <Card
                  key={l.id}
                  size="small"
                  hoverable
                  className="cursor-pointer"
                  onClick={() => void openInApp(l)}
                  title={
                    <span className="flex items-center gap-2 text-sm">
                      <Building2 size={15} className="shrink-0 text-indigo-400" />
                      <span className="truncate">{l.name}</span>
                    </span>
                  }
                  extra={
                    <span className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="small"
                        type="text"
                        icon={<Home size={13} className={l.home ? 'text-indigo-500' : 'text-gray-300 dark:text-gray-600'} />}
                        title={l.home ? '已在看板展示（点击取消）' : '在看板展示'}
                        onClick={() => persist(links.map((x) => (x.id === l.id ? { ...x, home: !l.home } : x)))}
                      />
                      <Button
                        size="small"
                        type="text"
                        icon={<ExternalLink size={13} />}
                        title="在浏览器打开"
                        onClick={() => void openExternal(l)}
                      />
                      <Button
                        size="small"
                        type="text"
                        icon={<Pencil size={13} />}
                        title="编辑"
                        onClick={() => openEdit(l)}
                      />
                    </span>
                  }
                >
                  <div className="flex min-h-5 items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-gray-400">{l.url || '未配置地址'}</span>
                    {l.desc && <Tag style={{ marginInlineEnd: 0 }}>{l.desc}</Tag>}
                  </div>
                </Card>
              ))}
          </div>
        </div>
      ))}

      {links.length === 0 && (
        <div className="mt-10 text-center text-sm text-gray-400">还没有链接，点击右上角「新增链接」添加。</div>
      )}

      <Modal
        title={isNew ? '新增链接' : `编辑链接${editing?.name ? ` · ${editing.name}` : ''}`}
        open={!!editing}
        onOk={save}
        onCancel={() => setEditing(null)}
        okText={isNew ? '添加' : '保存'}
        cancelText="取消"
      >
        <div className="flex flex-col gap-3 pt-2">
          <div>
            <div className="mb-1 text-xs text-gray-500">名称</div>
            <Input placeholder="如：控制台 · 生产" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1 text-xs text-gray-500">分组</div>
              <AutoComplete
                className="w-full"
                options={groups.map((g) => ({ value: g }))}
                value={group}
                onChange={(v) => setGroup(v)}
                placeholder="如：开发 / AI / 协作"
              />
            </div>
            <div>
              <div className="mb-1 text-xs text-gray-500">备注（可选）</div>
              <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="显示在卡片上" />
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs text-gray-500">地址</div>
            <Input
              placeholder="https://…（缺省协议按 https 补全）"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              prefix={<ExternalLink size={14} className="text-gray-400" />}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-black/5 px-3 py-2 dark:border-white/10">
            <span className="text-xs text-gray-500">
              在看板「常用入口」展示
              <span className="ml-1 text-[11px] text-gray-400">适合钉住语雀需求库、周报地址等高频页面</span>
            </span>
            <Switch
              checked={!!editing?.home}
              onChange={(v) => setEditing((prev) => (prev ? { ...prev, home: v } : prev))}
            />
          </div>
          {!isNew && (
            <div className="flex justify-end border-t border-black/5 pt-2 dark:border-white/10">
              <Popconfirm
                title="删除该链接？"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={remove}
              >
                <Button danger size="small" icon={<Trash2 size={13} />}>
                  删除链接
                </Button>
              </Popconfirm>
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}
