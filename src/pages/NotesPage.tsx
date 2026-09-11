import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Dropdown, Empty, Input, Modal, Segmented, Tooltip, Tree } from 'antd'
import type { DataNode } from 'antd/es/tree'
import {
  Columns2,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  NotebookPen,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import { errText, fmtDateTime } from '../lib/err'
import { noteApi, type NoteNode } from '../api/notes'
import { isTauri } from '../api/ipc'
import { useAiServices } from '../hooks/useAiServices'
import NoteAiModal from '../components/notes/NoteAiModal'
import ProviderModelSelect from '../components/ProviderModelSelect'
import 'bytemd/dist/index.css'

type ViewMode = 'edit' | 'preview' | 'both'

export default function NotesPage() {
  const { message } = App.useApp()
  const [dir, setDir] = useState('')
  const [tree, setTree] = useState<NoteNode[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  // 右键菜单
  const [ctx, setCtx] = useState<{ x: number; y: number; node: NoteNode | null } | null>(null)
  // 新建目标（从右键菜单进入时带上分组）
  const [createKind, setCreateKind] = useState<'note' | 'group'>('note')
  const [createTarget, setCreateTarget] = useState('')
  const [current, setCurrent] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [view, setView] = useState<ViewMode>('both')
  const [saving, setSaving] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiModalKey, setAiModalKey] = useState(0)
  const [aiCfgOpen, setAiCfgOpen] = useState(false)
  const { services } = useAiServices()
  // AI 公共配置：默认供应商/模型（AI 优化共用；localStorage 持久化）
  const [aiCfg, setAiCfg] = useState(() => {
    try {
      return { serviceKey: null, model: null, ...(JSON.parse(localStorage.getItem('aw-notes-ai') ?? '{}') as { serviceKey?: string; model?: string }) }
    } catch {
      return { serviceKey: null as string | null, model: null as string | null }
    }
  })
  const aiSvc = services.find((s) => s.key === aiCfg.serviceKey) ?? null
  const aiCfgLabel = aiCfg.serviceKey
    ? `${aiSvc?.label ?? '已删除的服务'}${aiCfg.model ? ` · ${aiCfg.model}` : ''}`
    : '未选'
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [dirOpen, setDirOpen] = useState(false)
  const [dirInput, setDirInput] = useState('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [d, t] = await Promise.all([noteApi.getDir(), noteApi.tree()])
      setDir(d)
      setTree(t)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isTauri) void load()
  }, [load])

  const openNote = async (name: string) => {
    try {
      const text = await noteApi.read(name)
      setCurrent(name)
      setContent(text)
      setDirty(false)
    } catch (e) {
      message.error(errText(e))
    }
  }

  const save = useCallback(
    async (name: string, text: string) => {
      setSaving(true)
      try {
        await noteApi.write(name, text)
        setDirty(false)
      } catch (e) {
        message.error(errText(e))
      } finally {
        setSaving(false)
      }
    },
    [message],
  )

  const onContentChange = (text: string) => {
    setContent(text)
    setDirty(true)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (current) {
      saveTimer.current = setTimeout(() => void save(current, text), 800)
    }
  }

  // 离开页面/卸载时冲刷未保存内容（0.8s 自动保存窗口内切走不丢字）
  const latest = useRef({ current, content, dirty, save })
  latest.current = { current, content, dirty, save }
  useEffect(
    () => () => {
      const { current: c, content: text, dirty: d, save: s } = latest.current
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (c && d) void s(c, text)
    },
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (current && dirty) void save(current, content)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, dirty, content, save])

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      if (createKind === 'note') {
        const created = await noteApi.create(name, createTarget || undefined)
        setCreateOpen(false)
        setNewName('')
        await load()
        await openNote(created.name)
      } else {
        const path = createTarget ? `${createTarget}/${name}` : name
        await noteApi.createGroup(path)
        setCreateOpen(false)
        setNewName('')
        await load()
      }
      message.success('已创建')
    } catch (e) {
      message.error(errText(e))
    }
  }

  /** 重命名笔记或分组（同一父目录内） */
  const renameNode = (n: NoteNode) => {
    let value = n.key.split('/').pop()!.replace(/\.md$/, '')
    Modal.confirm({
      title: n.kind === 'note' ? '重命名笔记' : '重命名分组',
      content: (
        <Input
          defaultValue={value}
          autoFocus
          onChange={(e) => {
            value = e.target.value
          }}
        />
      ),
      onOk: async () => {
        const next = value.trim()
        if (!next) return
        try {
          await noteApi.rename(n.key, next)
          if (current) {
            const parent = current.split('/').slice(0, -1).join('/')
            if (current === n.key) setCurrent(parent ? `${parent}/${next}.md` : `${next}.md`)
          }
          await load()
        } catch (e) {
          message.error(errText(e))
        }
      },
    })
  }

  const removeNode = async (n: NoteNode) => {
    try {
      await noteApi.remove(n.key)
      if (current && (current === n.key || current.startsWith(`${n.key}/`))) {
        setCurrent(null)
        setContent('')
      }
      await load()
      message.success('已删除')
    } catch (e) {
      message.error(errText(e))
    }
  }

  /** 拖拽移动：拖到分组上=移入；拖到间隙=移入该节点所在分组 */
  const onDrop = async (info: {
    dragNode: { key: React.Key }
    node: { key: React.Key }
    dropToGap: boolean
  }) => {
    const from = String(info.dragNode.key)
    const dropKey = String(info.node.key)
    const dropNode = findNode(tree, dropKey)
    let toDir = ''
    if (!info.dropToGap && dropNode?.kind === 'group') toDir = dropKey
    else toDir = dropKey.split('/').slice(0, -1).join('/')
    if (from === toDir) return
    if (toDir.startsWith(`${from}/`)) {
      message.warning('不能移动到自身或其子分组内')
      return
    }
    const parentOfFrom = from.split('/').slice(0, -1).join('/')
    if (parentOfFrom === toDir) return
    try {
      await noteApi.move(from, toDir)
      if (current && (current === from || current.startsWith(`${from}/`))) {
        const rest = current.slice(from.length)
        setCurrent(toDir ? `${toDir}${rest}` : rest.replace(/^\//, ''))
        if (dirty && current) void save(current, content)
      }
      await load()
    } catch (e) {
      message.error(errText(e))
    }
  }

  /** 右键菜单项（node=null 表示根区域） */
  const ctxItems = ctx
    ? ctx.node
      ? ctx.node.kind === 'note'
        ? [
            { key: 'open', label: '打开' },
            { key: 'rename', label: '重命名' },
            { key: 'delete', label: '删除', danger: true },
          ]
        : [
            { key: 'newNote', label: '新建笔记' },
            { key: 'newGroup', label: '新建分组' },
            { type: 'divider' as const },
            { key: 'rename', label: '重命名' },
            { key: 'delete', label: '删除分组', danger: true },
          ]
      : [
          { key: 'newNote', label: '新建笔记' },
          { key: 'newGroup', label: '新建分组' },
        ]
    : []

  const onCtxClick = ({ key }: { key: string }) => {
    if (!ctx) return
    const node = ctx.node
    const dirOf = node?.kind === 'group' ? node.key : ''
    setCtx(null)
    switch (key) {
      case 'open':
        if (node?.kind === 'note') void openNote(node.key)
        break
      case 'newNote':
        setCreateKind('note')
        setCreateTarget(dirOf)
        setNewName('')
        setCreateOpen(true)
        break
      case 'newGroup':
        setCreateKind('group')
        setCreateTarget(dirOf)
        setNewName('')
        setCreateOpen(true)
        break
      case 'rename':
        if (node) renameNode(node)
        break
      case 'delete':
        if (node) {
          Modal.confirm({
            title: node.kind === 'group' ? `删除分组「${node.title}」及其全部内容？` : `删除笔记「${node.title}」？`,
            okText: '删除',
            okButtonProps: { danger: true },
            onOk: () => removeNode(node),
          })
        }
        break
    }
  }

  const changeDir = async () => {
    try {
      const d = await noteApi.setDir(dirInput.trim())
      setDir(d)
      setDirOpen(false)
      setCurrent(null)
      setContent('')
      await load()
      message.success('笔记目录已更新')
    } catch (e) {
      message.error(errText(e))
    }
  }

  const resetDir = async () => {
    try {
      const d = await noteApi.resetDir()
      setDir(d)
      setDirOpen(false)
      setCurrent(null)
      setContent('')
      await load()
      message.success('已恢复默认目录')
    } catch (e) {
      message.error(errText(e))
    }
  }

  /** 树 → antd DataNode（带图标；搜索时过滤保留命中子树） */
  const treeData: DataNode[] = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    const mapNode = (n: NoteNode): DataNode => ({
      key: n.key,
      title: (
        <span className="inline-flex max-w-[168px] items-center gap-1.5">
          <span className="truncate">{n.title}</span>
          {n.kind === 'note' && n.excerpt && (
            <span className="hidden truncate text-[10px] text-gray-400 group-hover:inline">
              {n.excerpt}
            </span>
          )}
        </span>
      ),
      icon: n.kind === 'group' ? <FolderOpen size={13} className="text-amber-500" /> : <FileText size={13} className="text-indigo-400" />,
      children: n.children.map(mapNode),
    })
    const filterNode = (n: NoteNode): NoteNode | null => {
      const hit = !k || n.title.toLowerCase().includes(k) || n.excerpt.toLowerCase().includes(k)
      const children = n.children.map(filterNode).filter((x): x is NoteNode => x !== null)
      if (!hit && children.length === 0) return null
      return { ...n, children }
    }
    return tree.map(filterNode).filter((x): x is NoteNode => x !== null).map(mapNode)
  }, [tree, keyword])

  const flattenNote = (nodes: NoteNode[]): NoteNode | null => {
    for (const n of nodes) {
      if (n.kind === 'note' && n.key === current) return n
      const hit = flattenNote(n.children)
      if (hit) return hit
    }
    return null
  }
  const currentNote = useMemo(() => flattenNote(tree), [tree, current])

  const findNode = (nodes: NoteNode[], key: string): NoteNode | null => {
    for (const n of nodes) {
      if (n.key === key) return n
      const hit = findNode(n.children, key)
      if (hit) return hit
    }
    return null
  }

  if (!isTauri) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty description="笔记功能需在桌面应用内使用" />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* 笔记列表 */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-black/5 dark:border-white/10">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center gap-1.5">
            <Button
              block
              type="dashed"
              icon={<FilePlus2 size={14} />}
              onClick={() => {
                setCreateKind('note')
                setCreateTarget('')
                setNewName('')
                setCreateOpen(true)
              }}
            >
              新建笔记
            </Button>
            <Tooltip title="新建分组">
              <Button
                size="small"
                icon={<FolderPlus size={13} />}
                onClick={() => {
                  setCreateKind('group')
                  setCreateTarget('')
                  setNewName('')
                  setCreateOpen(true)
                }}
              />
            </Tooltip>
            <Tooltip title="刷新">
              <Button size="small" icon={<RefreshCw size={13} />} onClick={() => void load()} loading={loading} />
            </Tooltip>
            <Tooltip title="笔记目录设置">
              <Button size="small" icon={<FolderOpen size={13} />} onClick={() => { setDirInput(dir); setDirOpen(true) }} />
            </Tooltip>
          </div>
          <Input.Search
            size="small"
            placeholder="搜索标题/内容摘要"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            allowClear
          />
          <div className="truncate text-[10px] text-gray-400" title={dir}>
            {dir}
          </div>
        </div>
        <div
          className="relative flex-1 overflow-y-auto px-2 pb-2"
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('.ant-tree')) return
            e.preventDefault()
            setCtx({ x: e.clientX, y: e.clientY, node: null })
          }}
          onClick={() => setCtx(null)}
        >
          {treeData.length === 0 && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有笔记——右键或顶部按钮新建" />
          )}
          <Tree
            showIcon
            blockNode
            draggable={{ icon: false }}
            treeData={treeData}
            selectedKeys={current ? [current] : []}
            defaultExpandAll
            onSelect={(keys) => {
              const k = String(keys[0] ?? '')
              if (k.endsWith('.md')) void openNote(k)
            }}
            onDrop={(info) => void onDrop(info as unknown as { dragNode: { key: React.Key }; node: { key: React.Key }; dropToGap: boolean })}
            onRightClick={({ event, node }) => {
              event.preventDefault()
              const key = String(node.key)
              const find = (nodes: NoteNode[]): NoteNode | null => {
                for (const n of nodes) {
                  if (n.key === key) return n
                  const hit = find(n.children)
                  if (hit) return hit
                }
                return null
              }
              setCtx({ x: event.clientX, y: event.clientY, node: find(tree) })
            }}
          />
          {ctx && (
            <div
              className="fixed z-50"
              style={{ left: ctx.x, top: ctx.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <Dropdown
                open
                menu={{ items: ctxItems, onClick: onCtxClick }}
                trigger={[]}
              >
                <span />
              </Dropdown>
            </div>
          )}
        </div>
      </aside>

      {/* 编辑区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* AI 公共配置入口：按钮 + 当前摘要，点击弹窗配置 */}
        <div className="flex items-center gap-2 border-b border-black/5 px-4 py-1.5 dark:border-white/10">
          <Button size="small" icon={<SlidersHorizontal size={13} />} onClick={() => setAiCfgOpen(true)}>
            AI 公共配置
          </Button>
          <span className="truncate text-xs text-gray-400">优化笔记默认：{aiCfgLabel}</span>
          <div className="flex-1" />
        </div>
        {current ? (
          <>
            <div className="flex items-center gap-2 border-b border-black/5 px-4 py-2 dark:border-white/10">
              <span className="truncate text-sm font-medium">{current.replace(/\.md$/, '')}</span>
              {dirty && <span className="text-xs text-amber-500">未保存</span>}
              <div className="flex-1" />
              <Segmented
                size="small"
                value={view}
                onChange={(v) => setView(v as ViewMode)}
                options={[
                  { label: '编辑', value: 'edit' },
                  { label: '预览', value: 'preview' },
                  { label: '双栏', value: 'both', icon: <Columns2 size={13} /> },
                ]}
              />
              <Tooltip title="AI 优化笔记（使用公共配置的供应商/模型）">
                <Button
                  size="small"
                  icon={<Sparkles size={14} />}
                  onClick={() => {
                    if (dirty && current) void save(current, content)
                    setAiModalKey((k) => k + 1)
                    setAiOpen(true)
                  }}
                />
              </Tooltip>
              <Tooltip title="保存（⌘S，编辑后 0.8s 自动保存）">
                <Button
                  size="small"
                  icon={<Save size={14} />}
                  loading={saving}
                  disabled={!dirty}
                  onClick={() => void save(current, content)}
                />
              </Tooltip>
            </div>
            {view === 'preview' ? (
              <div className="flex-1 overflow-y-auto px-8 py-4">
                <BytemdViewer value={content} />
              </div>
            ) : view === 'both' ? (
              <div className="flex min-h-0 flex-1">
                <div className="min-w-0 flex-1 overflow-hidden">
                  <BytemdEditor value={content} onChange={onContentChange} />
                </div>
                <div className="min-w-0 flex-1 overflow-y-auto border-l border-black/5 px-6 py-4 dark:border-white/10">
                  <BytemdViewer value={content} />
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-hidden">
                <BytemdEditor value={content} onChange={onContentChange} />
              </div>
            )}
            <div className="border-t border-black/5 px-4 py-1 text-right text-[10px] text-gray-400 dark:border-white/10">
              更新于 {currentNote?.updatedAt ? fmtDateTime(currentNote.updatedAt) : '—'}
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <Empty
              image={<NotebookPen size={44} strokeWidth={1.4} className="mx-auto text-indigo-300" />}
              description="选择或新建一篇笔记"
            />
          </div>
        )}
      </div>

      {/* 新建弹窗（笔记/分组） */}
      <Modal
        title={createKind === 'note' ? '新建笔记' : '新建分组'}
        open={createOpen}
        onOk={() => void create()}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        cancelText="取消"
      >
        <Input
          className="mt-2"
          autoFocus
          placeholder={createKind === 'note' ? '笔记名称' : '分组名称'}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={() => void create()}
        />
        {createTarget && (
          <p className="mb-0 mt-2 text-xs text-gray-400">将创建在分组「{createTarget}」下</p>
        )}
      </Modal>

      {/* 目录设置 */}
      <Modal
        title="笔记目录"
        open={dirOpen}
        onOk={() => void changeDir()}
        onCancel={() => setDirOpen(false)}
        okText="保存"
        cancelText="取消"
        footer={
          <div className="flex items-center justify-between">
            <Button size="small" type="text" onClick={() => void resetDir()}>
              恢复默认
            </Button>
            <div className="flex gap-2">
              <Button onClick={() => setDirOpen(false)}>取消</Button>
              <Button type="primary" onClick={() => void changeDir()}>
                保存
              </Button>
            </div>
          </div>
        }
      >
        <Input
          className="mt-2"
          placeholder="笔记根目录绝对路径"
          value={dirInput}
          onChange={(e) => setDirInput(e.target.value)}
        />
        <p className="mb-0 mt-2 text-xs text-gray-400">
          目录不存在会自动创建；切换目录不迁移已有文件（当前默认：应用数据目录 notes/ 子目录）。
        </p>
      </Modal>
      {/* AI 公共配置弹窗 */}
      <Modal
        title="AI 公共配置 · 优化笔记模型"
        open={aiCfgOpen}
        footer={<Button onClick={() => setAiCfgOpen(false)}>关闭</Button>}
        onCancel={() => setAiCfgOpen(false)}
      >
        <div className="flex flex-col gap-2 py-1">
          <ProviderModelSelect
            value={aiCfg}
            onChange={(v) => {
              setAiCfg(v)
              localStorage.setItem('aw-notes-ai', JSON.stringify({ serviceKey: v.serviceKey, model: v.model ?? '' }))
            }}
            style={{ minWidth: 300 }}
          />
          <p className="m-0 text-xs text-gray-400">AI 优化笔记默认使用的供应商与模型；修改立即生效。</p>
        </div>
      </Modal>
      {/* AI 优化 */}
      {current && (
        <NoteAiModal
          key={aiModalKey}
          open={aiOpen}
          content={content}
          onClose={() => setAiOpen(false)}
          onApply={(text) => {
            setContent(text)
            setDirty(true)
            if (current) void save(current, text)
          }}
        />
      )}
    </div>
  )
}

// ===== bytemd 封装（懒加载，工具栏内置） =====

let editorModule: Promise<typeof import('@bytemd/react')> | null = null
const loadEditor = () => (editorModule ??= import('@bytemd/react'))

function BytemdEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [Editor, setEditor] = useState<React.ComponentType<{ value: string; onChange: (v: string) => void }> | null>(null)
  useEffect(() => {
    let alive = true
    void loadEditor().then((m) => {
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
        className="h-full w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-6 text-gray-800 outline-none dark:text-gray-200"
      />
    )
  }
  return <Editor value={value} onChange={(v) => onChange(v ?? '')} />
}

function BytemdViewer({ value }: { value: string }) {
  const [Viewer, setViewer] = useState<React.ComponentType<{ value: string }> | null>(null)
  useEffect(() => {
    let alive = true
    void loadEditor().then((m) => {
      if (alive) setViewer(() => m.Viewer as unknown as typeof Viewer)
    })
    return () => {
      alive = false
    }
  }, [])
  if (!Viewer) return <div className="p-4 text-sm text-gray-400">加载中…</div>
  return <Viewer value={value} />
}
