import { useCallback, useEffect, useMemo, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  Alert,
  App as AntApp,
  Button,
  Collapse,
  Empty,
  Input,
  Popconfirm,
  Select,
  Spin,
  Tag,
  Tooltip,
} from 'antd'
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  Plus,
  RefreshCw,
  Search as SearchIcon,
  Settings2,
  Trash2,
} from 'lucide-react'
import YuqueOnboarding from '../components/yuque/YuqueOnboarding'
import YuqueConnManage from '../components/yuque/YuqueConnManage'
import SheetView from '../components/yuque/SheetView'
import { MdPreview, MD_THEMES, copyText, type MdTheme } from '../components/common/MdPreview'
import { downloadMarkdown, exportPdf } from '../lib/mdExport'
import {
  yqApi,
  type YqConnStatus,
  type YqDoc,
  type YqDocDetail,
  type YqSearchItem,
  type YqSpace,
} from '../api/yuque'
import { errText } from '../lib/err'
import { openLinkInApp } from '../lib/openLink'

/** 非 Doc 类型（表格/数据表/画板）展示名 */
const KIND_LABEL: Record<string, string> = { Sheet: '表格', Table: '数据表', Board: '画板' }
const kindLabel = (k?: string) => KIND_LABEL[k ?? ''] ?? '特殊类型'
const isPlainDoc = (k?: string) => !k || k === 'Doc'

const fmtDate = (s?: string) => {
  if (!s) return '-'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('zh-CN')
}

/** 空间归属（子空间）：团队在前、个人在后——与选择器一致 */
interface OwnerGroup {
  key: string
  kind: 'group' | 'user' | 'other'
  name: string
  spaces: YqSpace[]
}

function groupInfo(s: YqSpace): { kind: OwnerGroup['kind']; name: string } {
  const kind = s.ownerKind === 'group' ? 'group' : s.ownerKind === 'user' ? 'user' : 'other'
  const name =
    s.ownerName || (kind === 'user' ? '个人知识库' : kind === 'group' ? '团队空间' : '未分组')
  return { kind, name }
}

function ownerGroups(spaces: YqSpace[]): OwnerGroup[] {
  const map = new Map<string, OwnerGroup>()
  for (const s of spaces) {
    const { kind, name } = groupInfo(s)
    const key = `${kind}:${name}`
    if (!map.has(key)) map.set(key, { key, kind, name, spaces: [] })
    map.get(key)!.spaces.push(s)
  }
  const arr = [...map.values()]
  const rank = (k: OwnerGroup['kind']) => (k === 'group' ? 0 : k === 'user' ? 1 : 2)
  arr.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, 'zh-CN'))
  return arr
}

/** 子空间分组的展开 key（含连接 id，全局唯一） */
const ownerKey = (connId: string, s: YqSpace) => {
  const { kind, name } = groupInfo(s)
  return `${connId}/${kind}:${name}`
}

function ErrAlert({ e, onRetry }: { e: unknown; onRetry: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      message={errText(e)}
      className="my-3"
      action={
        <Button size="small" onClick={onRetry}>
          重试
        </Button>
      }
    />
  )
}

/** bytemd 编辑器（与笔记一致；懒加载） */
function BytemdEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [Editor, setEditor] = useState<React.ComponentType<{ value: string; onChange: (v: string) => void }> | null>(null)
  useEffect(() => {
    let alive = true
    void import('@bytemd/react').then((m) => {
      if (alive) setEditor(() => m.Editor as unknown as typeof Editor)
    })
    return () => {
      alive = false
    }
  }, [])
  if (!Editor) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="h-full min-h-72 w-full resize-none rounded-xl border border-black/5 bg-white p-4 font-mono text-[13px] leading-6 outline-none dark:border-white/10 dark:bg-white/5 dark:text-gray-200"
      />
    )
  }
  return <Editor value={value} onChange={(v) => onChange(v ?? '')} />
}

export default function YuquePage() {
  const { message } = AntApp.useApp()
  const [conns, setConns] = useState<YqConnStatus[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [managing, setManaging] = useState<YqConnStatus | null>(null)
  /** 当前空间：连接 id + namespace */
  const [active, setActive] = useState<{ connId: string; ns: string } | null>(null)
  const [docs, setDocs] = useState<YqDoc[]>([])
  const [docsLoading, setDocsLoading] = useState(false)
  const [docsError, setDocsError] = useState<unknown>(null)
  const [searchQ, setSearchQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<YqSearchItem[] | null>(null)
  const [searchError, setSearchError] = useState<unknown>(null)
  // 阅读
  const [reading, setReading] = useState<{ connId: string; ns: string; doc: YqDoc } | null>(null)
  const [detail, setDetail] = useState<YqDocDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<unknown>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // 阅读主题（持久化）
  const [theme, setTheme] = useState<MdTheme>(
    () => (localStorage.getItem('yuque-md-theme') as MdTheme) || 'github',
  )
  /** 目录树展开的连接（默认全部展开；切空间时确保所在连接展开） */
  const [openKeys, setOpenKeys] = useState<string[]>([])
  /** 展开的子空间分组（连接/团队/个人）；默认收起，选中空间时自动展开所在分组 */
  const [openOwners, setOpenOwners] = useState<string[]>([])

  const reload = useCallback(() => {
    yqApi
      .status()
      .then((list) => {
        setConns(list)
        setOpenKeys((prev) => (prev.length ? prev : list.map((c) => c.id)))
        setActive((prev) => {
          if (prev && list.some((c) => c.id === prev.connId && c.spaces.some((s) => s.namespace === prev.ns)))
            return prev
          const first = list.find((c) => c.spaces.length > 0)
          return first ? { connId: first.id, ns: first.spaces[0].namespace } : null
        })
      })
      .catch(() => setConns([]))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const activeConn = conns?.find((c) => c.id === active?.connId)
  const activeSpace = activeConn?.spaces.find((s) => s.namespace === active?.ns)

  const loadDocs = useCallback(() => {
    if (!active) return
    setDocsLoading(true)
    setDocsError(null)
    yqApi
      .docs(active.connId, active.ns)
      .then(setDocs)
      .catch((e) => setDocsError(e))
      .finally(() => setDocsLoading(false))
  }, [active])

  useEffect(() => {
    if (conns) loadDocs()
  }, [conns, loadDocs])

  const doSearch = () => {
    if (!searchQ.trim()) return
    setSearching(true)
    setSearchError(null)
    yqApi
      .search(searchQ.trim())
      .then(setResults)
      .catch((e) => setSearchError(e))
      .finally(() => setSearching(false))
  }

  const read = (connId: string, ns: string, doc: YqDoc) => {
    setReading({ connId, ns, doc })
    setEditing(false)
    setDraft('')
    setDetail(null)
    setDetailError(null)
    // 画板/数据表无应用内正文，直接占位；表格(Sheet)解压取结构化单元格
    if (!isPlainDoc(doc.kind) && doc.kind !== 'Sheet') return
    setDetailLoading(true)
    yqApi
      .doc(connId, ns, doc.slug, doc.kind)
      .then(setDetail)
      .catch((e) => setDetailError(e))
      .finally(() => setDetailLoading(false))
  }

  const removeConn = async (id: string, label: string) => {
    try {
      await yqApi.remove(id)
      message.success(`已移除${label}`)
      reload()
    } catch (e) {
      message.error(errText(e))
    }
  }

  /** 在应用内网页窗口打开当前文档（表格/数据表/画板兜底） */
  const openDocWeb = () => {
    if (!reading) return
    const conn = conns?.find((c) => c.id === reading.connId)
    if (conn)
      void openLinkInApp(
        {
          id: `yx-doc-${reading.doc.id}`,
          name: reading.doc.title,
          url: `https://${conn.base}/${reading.ns}/${reading.doc.slug}`,
        },
        (m) => message.error(m),
      )
  }

  const applyTheme = (t: MdTheme) => {
    setTheme(t)
    localStorage.setItem('yuque-md-theme', t)
  }

  /** 选空间时确保其所在连接展开 */
  const pickSpace = (connId: string, ns: string) => {
    setActive({ connId, ns })
    setOpenKeys((prev) => (prev.includes(connId) ? prev : [...prev, connId]))
  }

  // 当前空间所在的子空间分组自动展开（初始默认选中、归属信息回填刷新后都生效）
  useEffect(() => {
    if (!active || !conns) return
    const conn = conns.find((c) => c.id === active.connId)
    const sp = conn?.spaces.find((s) => s.namespace === active.ns)
    if (!conn || !sp) return
    const key = ownerKey(conn.id, sp)
    setOpenOwners((prev) => (prev.includes(key) ? prev : [...prev, key]))
  }, [active, conns])

  const mdText = editing ? draft : detail?.body ?? ''

  // ===== 文档图片本地化预览 =====
  // 语雀图床（本域 / nlark CDN）有防盗链，WebView 直连 <img> 加载不出来；
  // 通过 Rust 带会话凭证下载到本机缓存后，用 asset 协议渲染。
  // 只影响应用内预览：复制 / 下载 / 导出仍用原始 body。
  const [imgMap, setImgMap] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!detail || !reading) return
    const urls = new Set<string>()
    for (const m of detail.body.matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g)) urls.add(m[1])
    for (const m of detail.body.matchAll(/<img[^>]+src="(https:\/\/[^"]+)"/g)) urls.add(m[1])
    for (const u of urls) {
      if (imgMap[u] !== undefined) continue
      setImgMap((prev) => ({ ...prev, [u]: '' })) // 先占位防重复请求；成功后回填路径
      yqApi
        .cacheImage(reading.connId, u)
        .then((p) => setImgMap((prev) => ({ ...prev, [u]: p })))
        .catch(() => {}) // 保持占位空串：渲染维持原 URL，失败不打扰阅读
    }
    // imgMap 刻意不进依赖：并发图片各自只发起一次请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, reading])
  const previewText = useMemo(() => {
    if (!mdText || Object.keys(imgMap).length === 0) return mdText
    // 整段匹配 m 原样返回（未命中缓存时不改动，避免打坏图片语法）
    return mdText
      .replace(/(!\[[^\]]*\]\()(https:\/\/[^)\s]+)(\))/g, (m, pre, u, tail) =>
        imgMap[u] ? `${pre}${convertFileSrc(imgMap[u])}${tail}` : m,
      )
      .replace(/(<img[^>]+src=")(https:\/\/[^"]+)(")/g, (m, pre, u, tail) =>
        imgMap[u] ? `${pre}${convertFileSrc(imgMap[u])}${tail}` : m,
      )
  }, [mdText, imgMap])

  if (conns === null) {
    return (
      <div className="grid h-full place-items-center">
        <Spin />
      </div>
    )
  }

  if (conns.length === 0 || adding) {
    return <YuqueOnboarding onDone={() => { setAdding(false); reload() }} />
  }

  const collapseKeys = openKeys

  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-8 pt-6">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 text-sm font-bold text-white shadow-sm">
          雀
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-base font-semibold">
            语雀
            {conns.map((c) => (
              <Tag key={c.id} bordered={false} color="green">
                {c.label}
              </Tag>
            ))}
          </div>
          <div className="text-xs text-gray-400">
            {conns.length} 个连接 · 共 {conns.reduce((n, c) => n + c.spaces.length, 0)} 个知识空间
          </div>
        </div>
        <Button size="small" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
          添加连接
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 gap-4 px-6 py-4">
        {/* 左：可折叠空间树（独立滚动） */}
        <aside className="flex w-60 shrink-0 flex-col overflow-y-auto rounded-2xl border border-black/5 bg-white p-2 shadow-sm dark:border-white/10 dark:bg-white/5">
          <div className="mb-1 flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-gray-500 dark:text-gray-400">
            <BookOpen size={13} />
            知识空间
          </div>
          <Collapse
            ghost
            size="small"
            activeKey={collapseKeys}
            onChange={(k) => setOpenKeys(Array.isArray(k) ? k : k ? [k] : [])}
            items={conns.map((c) => ({
              key: c.id,
              label: (
                <span className="group/con flex min-w-0 items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{c.label}</span>
                  <span className="text-[10px] text-gray-400">{c.spaces.length}</span>
                  <span className="hidden shrink-0 items-center gap-0.5 group-hover/con:flex">
                    <button
                      className="text-gray-400 hover:text-indigo-500"
                      title="管理：刷新凭证 / 重选空间"
                      onClick={(e) => {
                        e.stopPropagation()
                        setManaging(c)
                      }}
                    >
                      <Settings2 size={12} />
                    </button>
                    <Popconfirm
                      title={`移除「${c.label}」连接？`}
                      okText="移除"
                      cancelText="取消"
                      onConfirm={() => void removeConn(c.id, c.label)}
                    >
                      <button
                        className="text-gray-400 hover:text-rose-500"
                        title="移除此连接"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Trash2 size={12} />
                      </button>
                    </Popconfirm>
                  </span>
                </span>
              ),
              children:
                c.spaces.length === 0 ? (
                  <div className="px-2 py-1 text-[11px] text-gray-400">未关联空间</div>
                ) : (
                  <Collapse
                    ghost
                    size="small"
                    className="yuque-owner-tree"
                    activeKey={openOwners}
                    onChange={(k) => setOpenOwners(Array.isArray(k) ? k : k ? [k] : [])}
                    items={ownerGroups(c.spaces).map((g) => ({
                      key: `${c.id}/${g.key}`,
                      label: (
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-700 dark:text-gray-200">
                            {g.name}
                          </span>
                          {g.kind !== 'other' && (
                            <span className="shrink-0 rounded bg-black/5 px-1 text-[10px] leading-4 text-gray-400 dark:bg-white/10">
                              {g.kind === 'group' ? '团队' : '个人'}
                            </span>
                          )}
                          <span className="shrink-0 text-[10px] text-gray-400">{g.spaces.length}</span>
                        </span>
                      ),
                      children: (
                        <div className="flex flex-col gap-0.5">
                          {g.spaces.map((s) => (
                            <button
                              key={`${c.id}:${s.namespace}`}
                              className={`truncate rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                                active?.connId === c.id && active.ns === s.namespace
                                  ? 'bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-400'
                                  : 'text-gray-600 hover:bg-black/5 dark:text-gray-300 dark:hover:bg-white/5'
                              }`}
                              title={s.description || s.name}
                              onClick={() => pickSpace(c.id, s.namespace)}
                            >
                              {s.name}
                            </button>
                          ))}
                        </div>
                      ),
                    }))}
                  />
                ),
            }))}
          />
        </aside>

        {/* 右：文档列表 / 阅读（独立滚动） */}
        <section className="flex min-w-0 flex-1 flex-col">
          {reading ? (
            reading.doc.kind === 'Sheet' ? (
              /* 表格（Sheet）：解压原始数据，真实渲染单元格网格 */
              <div className="flex min-h-0 flex-1 flex-col gap-2">
                <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-black/5 bg-white px-3 py-2 shadow-sm dark:border-white/10 dark:bg-white/5">
                  <Button size="small" icon={<ArrowLeft size={13} />} onClick={() => setReading(null)}>
                    返回
                  </Button>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" title={reading.doc.title}>
                    {reading.doc.title}
                    <span className="ml-2 text-xs font-normal text-gray-400">
                      {fmtDate(reading.doc.updatedAt)}
                    </span>
                  </span>
                  <Button size="small" onClick={openDocWeb}>
                    在语雀网页打开
                  </Button>
                </div>
                {detailError ? (
                  <ErrAlert
                    e={detailError}
                    onRetry={() => reading && read(reading.connId, reading.ns, reading.doc)}
                  />
                ) : detailLoading ? (
                  <div className="grid flex-1 place-items-center">
                    <Spin />
                  </div>
                ) : detail?.sheet && detail.sheet.length > 0 ? (
                  <SheetView tabs={detail.sheet} title={reading.doc.title} />
                ) : (
                  <div className="grid flex-1 place-items-center rounded-xl border border-black/5 bg-white text-sm text-gray-400 shadow-sm dark:border-white/10 dark:bg-white/5">
                    该表格为空，或当前连接（Token 方式）不支持读取表格内容
                  </div>
                )}
              </div>
            ) : !isPlainDoc(reading.doc.kind) ? (
              /* 数据表/画板：语雀自研格式，应用内暂不渲染 */
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-black/5 bg-white p-8 text-center shadow-sm dark:border-white/10 dark:bg-white/5">
                <Tag color="geekblue" bordered={false}>
                  语雀{kindLabel(reading.doc.kind)}
                </Tag>
                <div className="text-base font-medium">{reading.doc.title}</div>
                <div className="max-w-md text-sm text-gray-500 dark:text-gray-400">
                  语雀{kindLabel(reading.doc.kind)}使用自研格式，应用内暂不支持渲染内容；请在语雀网页中查看。
                </div>
                <div className="flex gap-2">
                  <Button type="primary" onClick={openDocWeb}>
                    在语雀网页打开
                  </Button>
                  <Button onClick={() => setReading(null)}>返回列表</Button>
                </div>
              </div>
            ) : (
            <>
              {/* 阅读工具栏 */}
              <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-black/5 bg-white px-3 py-2 shadow-sm dark:border-white/10 dark:bg-white/5">
                <Button
                  size="small"
                  icon={<ArrowLeft size={13} />}
                  onClick={() => {
                    setReading(null)
                    setEditing(false)
                  }}
                >
                  返回
                </Button>
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={reading.doc.title}>
                  {reading.doc.title}
                  <span className="ml-2 text-xs font-normal text-gray-400">
                    {fmtDate(reading.doc.updatedAt)} · {reading.doc.wordCount} 字
                  </span>
                </span>
                <Select
                  size="small"
                  showSearch
                  className="w-36"
                  value={theme}
                  onChange={applyTheme}
                  optionFilterProp="label"
                  options={MD_THEMES.map((t) => ({ value: t.key, label: t.label }))}
                />
                <Tooltip title="复制 Markdown 源文">
                  <Button
                    size="small"
                    onClick={async () => {
                      if (await copyText(detail?.body ?? '')) message.success('已复制 Markdown')
                    }}
                  >
                    复制
                  </Button>
                </Tooltip>
                <Tooltip title="下载 .md 到下载目录">
                  <Button
                    size="small"
                    icon={<Download size={13} />}
                    onClick={() =>
                      void downloadMarkdown(reading.doc.title, detail?.body ?? '')
                        .then(() => message.success('已保存到「下载」目录'))
                        .catch((e) => message.error(errText(e)))
                    }
                  >
                    .md
                  </Button>
                </Tooltip>
                <Tooltip title="渲染为 PDF（含图表/公式）">
                  <Button
                    size="small"
                    icon={<FileText size={13} />}
                    onClick={() =>
                      void exportPdf({
                        text: detail?.body ?? '',
                        title: reading.doc.title,
                        theme,
                        onToast: (m, isErr) => (isErr ? message.error(m) : message.success(m)),
                      })
                    }
                  >
                    PDF
                  </Button>
                </Tooltip>
                <Button
                  size="small"
                  type={editing ? 'primary' : 'default'}
                  icon={editing ? <Eye size={13} /> : <Edit3 size={13} />}
                  onClick={() => {
                    if (!editing && detail) setDraft(detail.body)
                    setEditing(!editing)
                  }}
                >
                  {editing ? '预览' : '编辑'}
                </Button>
                <Button size="small" icon={<ExternalLink size={13} />} onClick={openDocWeb}>
                  在语雀网页打开
                </Button>
              </div>
              {/* 正文 */}
              <div className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-white px-6 py-5 shadow-sm dark:bg-[#1e1e24]">
                {detailError ? (
                  <ErrAlert e={detailError} onRetry={() => reading && read(reading.connId, reading.ns, reading.doc)} />
                ) : detailLoading ? (
                  <div className="grid h-40 place-items-center">
                    <Spin />
                  </div>
                ) : editing ? (
                  <div className="flex flex-col gap-2">
                    <Alert
                      type="info"
                      showIcon
                      message="编辑为本地草稿（未接入语雀写接口）——可复制或下载修改后的内容"
                    />
                    <BytemdEditor value={draft} onChange={setDraft} />
                  </div>
                ) : (
                  <MdPreview text={previewText || '_（空文档）_'} theme={theme} />
                )}
              </div>
            </>
            )
          ) : (
            <>
              <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
                <Input
                  className="w-60"
                  placeholder="搜索关联空间的文档（标题/摘要）"
                  prefix={<SearchIcon size={13} className="text-gray-400" />}
                  allowClear
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  onPressEnter={doSearch}
                />
                <Button loading={searching} onClick={doSearch}>
                  搜索
                </Button>
                <span className="ml-auto flex items-center gap-1 text-xs text-gray-400">
                  {activeConn?.label ?? ''} · {activeSpace?.name ?? ''}
                  {active && activeConn && activeSpace && (
                    <Tooltip title="在语雀网页打开知识库">
                      <Button
                        type="text"
                        size="small"
                        icon={<ExternalLink size={12} />}
                        onClick={() =>
                          void openLinkInApp(
                            {
                              id: `yx-book-${activeSpace.id}`,
                              name: activeSpace.name,
                              url: `https://${activeConn.base}/${activeSpace.namespace}`,
                            },
                            (m) => message.error(m),
                          )
                        }
                      />
                    </Tooltip>
                  )}
                  <Button
                    type="link"
                    size="small"
                    icon={<RefreshCw size={12} className={docsLoading ? 'animate-spin' : ''} />}
                    onClick={loadDocs}
                  >
                    刷新
                  </Button>
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-white p-4 shadow-sm dark:bg-white/5">
                {searchError ? <ErrAlert e={searchError} onRetry={doSearch} /> : null}
                {results !== null ? (
                  <>
                    <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
                      <span>搜索结果（{results.length}）</span>
                      <Button type="link" size="small" onClick={() => setResults(null)}>
                        返回文档列表
                      </Button>
                    </div>
                    {results.length === 0 ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的文档" />
                    ) : (
                      <div className="flex flex-col">
                        {results.map((r) => (
                          <button
                            key={`${r.connId}:${r.repo.namespace}:${r.doc.slug}`}
                            className="flex flex-col gap-0.5 border-b border-black/5 py-2 text-left last:border-0 hover:text-emerald-700 dark:border-white/10 dark:hover:text-emerald-400"
                            onClick={() =>
                              read(r.connId, r.repo.namespace, {
                                id: r.doc.id,
                                slug: r.doc.slug,
                                title: r.title,
                                kind: 'Doc',
                                description: '',
                                updatedAt: '',
                                wordCount: 0,
                              })
                            }
                          >
                            <div className="flex items-center gap-2">
                              <ChevronRight size={13} className="shrink-0 text-gray-300" />
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.title}</span>
                              <Tag bordered={false} className="shrink-0">
                                {r.connLabel}
                              </Tag>
                            </div>
                            <div className="flex items-center gap-2 pl-5 text-xs text-gray-400">
                              <span className="shrink-0">{r.repo.name}</span>
                              <span className="line-clamp-1 min-w-0 flex-1 truncate">{r.summary}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {docsError ? <ErrAlert e={docsError} onRetry={loadDocs} /> : null}
                    {!docsError && docsLoading && docs.length === 0 ? (
                      <div className="grid h-32 place-items-center">
                        <Spin />
                      </div>
                    ) : !docsError && docs.length === 0 ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={active ? '该空间没有文档' : '左侧选择一个知识空间'}
                      />
                    ) : (
                      !docsError && (
                        <div className="flex flex-col">
                          {docs.map((d) => (
                            <button
                              key={d.id}
                              className="flex items-center gap-2 border-b border-black/5 py-2 text-left last:border-0 hover:text-emerald-700 dark:border-white/10 dark:hover:text-emerald-400"
                              onClick={() => active && read(active.connId, active.ns, d)}
                            >
                              <FileText size={13} className="shrink-0 text-gray-400" />
                              <span className="min-w-0 flex-1 truncate text-sm">{d.title}</span>
                              {!isPlainDoc(d.kind) && (
                                <Tag color="geekblue" bordered={false} className="shrink-0">
                                  {kindLabel(d.kind)}
                                </Tag>
                              )}
                              <span className="shrink-0 text-xs text-gray-400">{d.wordCount} 字</span>
                              <span className="shrink-0 text-xs text-gray-400">{fmtDate(d.updatedAt)}</span>
                            </button>
                          ))}
                        </div>
                      )
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* 连接管理抽屉 */}
      {managing && (
        <YuqueConnManage conn={managing} onClose={() => setManaging(null)} onChanged={() => reload()} />
      )}
    </div>
  )
}
