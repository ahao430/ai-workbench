import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Spin,
  Tabs,
  Tag,
  Tooltip,
} from 'antd'
import {
  BadgeCheck,
  Download,
  Globe,
  HardDrive,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { errText } from '../lib/err'
import {
  emptyMcpEntry,
  MCP_CLI_TARGETS,
  mcpApi,
  type BuiltinMcp,
  type KVMap,
  type LocalMcp,
  type MarketServer,
  type McpEntry,
  type McpView,
} from '../api/mcp'

const KIND_LABEL: Record<string, string> = { stdio: 'stdio', http: 'HTTP', sse: 'SSE' }
const SOURCE_LABEL: Record<string, string> = {
  builtin: '精选',
  custom: '自定义',
  market: '市场',
  local: '本机导入',
}

export default function McpPage() {
  const { message } = App.useApp()
  const [list, setList] = useState<McpView[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<McpEntry | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setList(await mcpApi.list())
    } catch (e) {
      message.error(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: McpEntry, targets: string[]) => {
    const enabled: Record<string, boolean> = {}
    for (const t of MCP_CLI_TARGETS) enabled[t.id] = targets.includes(t.id)
    try {
      await mcpApi.save({ ...e, enabled })
      message.success('已保存并同步分发')
      setEditing(null)
      await load()
    } catch (err) {
      message.error(errText(err))
      throw err
    }
  }

  const remove = async (v: McpView) => {
    try {
      await mcpApi.remove(v.entry.id)
      message.success('已删除（并从各 CLI 配置摘除）')
      await load()
    } catch (e) {
      message.error(errText(e))
    }
  }

  const toggleTarget = async (v: McpView, cli: string, on: boolean) => {
    const current = MCP_CLI_TARGETS.filter((t) => v.entry.enabled[t.id]).map((t) => t.id)
    const next = on ? [...new Set([...current, cli])] : current.filter((c) => c !== cli)
    try {
      await mcpApi.setTargets(v.entry.id, next)
      await load()
    } catch (e) {
      message.error(errText(e))
    }
  }

  const managedNames = useMemo(() => new Set(list.map((v) => v.entry.name)), [list])

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-10">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="m-0 flex items-center gap-2 text-lg font-semibold">
          <Plug size={18} className="text-indigo-400" />
          MCP 服务器
        </h2>
        <div className="flex gap-2">
          <Button size="small" icon={<RefreshCw size={13} />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button type="primary" size="small" icon={<Plus size={14} />} onClick={() => setEditing(emptyMcpEntry())}>
            添加 MCP
          </Button>
        </div>
      </div>
      <p className="mb-4 mt-1 text-xs text-gray-400">
        集中管理 MCP 服务器，勾选即写入 Claude Code / Codex / OpenCode 的原生配置；支持本机扫描导入、精选一键安装与市场搜索。
      </p>

      <Tabs
        defaultActiveKey="mine"
        items={[
          {
            key: 'mine',
            label: `我的 MCP（${list.length}）`,
            children: (
              <Spin spinning={loading}>
                {list.length === 0 ? (
                  <Empty
                    image={<Plug size={44} strokeWidth={1.4} className="mx-auto text-indigo-300" />}
                    description="还没有管理中的 MCP——从「精选」一键安装、扫描「本机」或手动添加"
                  />
                ) : (
                  <div className="flex flex-col gap-3">
                    {list.map((v) => (
                      <Card
                        key={v.entry.id}
                        size="small"
                        title={
                          <span className="flex items-center gap-2 text-sm">
                            <span className="font-medium">{v.entry.name}</span>
                            <Tag style={{ marginInlineEnd: 0 }}>{KIND_LABEL[v.entry.kind] ?? v.entry.kind}</Tag>
                            <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                              {SOURCE_LABEL[v.entry.source] ?? v.entry.source}
                            </Tag>
                          </span>
                        }
                        extra={
                          <span className="flex gap-1">
                            {v.entry.homepage && (
                              <Tooltip title="主页">
                                <Button size="small" type="text" icon={<Globe size={13} />} onClick={() => window.open(v.entry.homepage!, '_blank')} />
                              </Tooltip>
                            )}
                            <Button size="small" type="text" icon={<Pencil size={13} />} onClick={() => setEditing(v.entry)} />
                            <Popconfirm title={`删除「${v.entry.name}」？将同时从各 CLI 配置中摘除。`} onConfirm={() => void remove(v)}>
                              <Button size="small" type="text" danger icon={<Trash2 size={13} />} />
                            </Popconfirm>
                          </span>
                        }
                      >
                        <p className="m-0 mb-2 min-h-5 text-xs text-gray-500 dark:text-gray-400">{v.entry.desc || '（无描述）'}</p>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                          {MCP_CLI_TARGETS.map((t) => {
                            const on = !!v.entry.enabled[t.id]
                            const actual = !!v.actual?.[t.id]
                            return (
                              <span key={t.id} className="flex items-center gap-1.5">
                                <Checkbox checked={on} onChange={(e) => void toggleTarget(v, t.id, e.target.checked)}>
                                  <span className="text-xs">{t.label}</span>
                                </Checkbox>
                                {on && (
                                  <Tooltip title={actual ? '已写入该 CLI 配置' : '未检测到（可能被外部修改）'}>
                                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${actual ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                                  </Tooltip>
                                )}
                              </span>
                            )
                          })}
                          <span className="ml-auto hidden max-w-[45%] shrink truncate font-mono text-[11px] text-gray-400 sm:block" title={configSummary(v.entry)}>
                            {configSummary(v.entry)}
                          </span>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </Spin>
            ),
          },
          {
            key: 'builtin',
            label: '精选',
            children: <BuiltinPanel installedNames={managedNames} onInstalled={load} />,
          },
          {
            key: 'market',
            label: '市场',
            children: <MarketPanel installedNames={managedNames} onInstalled={load} />,
          },
          {
            key: 'local',
            label: '本机',
            children: <LocalPanel managedNames={managedNames} onImported={load} />,
          },
        ]}
      />

      {editing && (
        <McpForm
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={(e, targets) => save(e, targets)}
        />
      )}
    </div>
  )
}

function configSummary(e: McpEntry): string {
  if (e.kind === 'http' || e.kind === 'sse') {
    return e.url ?? ''
  }
  return [e.command ?? '', ...e.args].join(' ')
}

// ===== 精选 =====

function BuiltinPanel({ installedNames, onInstalled }: { installedNames: Set<string>; onInstalled: () => void }) {
  const { message } = App.useApp()
  const [items, setItems] = useState<BuiltinMcp[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    mcpApi
      .builtins()
      .then(setItems)
      .catch((e) => message.error(errText(e)))
  }, [])

  const install = async (b: BuiltinMcp) => {
    setBusy(b.key)
    try {
      await mcpApi.installBuiltin(b.key)
      message.success(`已安装「${b.name}」到管理列表`)
      onInstalled()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const categories = [...new Set(items.map((i) => i.category))]
  return (
    <div>
      <p className="mb-3 text-xs text-gray-400">常用 MCP 一键安装（npm stdio 方式，npx 自动拉取）；安装后在「我的 MCP」勾选分发目标。</p>
      {categories.map((cat) => (
        <div key={cat} className="mb-4">
          <div className="mb-2 text-xs font-medium text-gray-400">{cat}</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {items
              .filter((i) => i.category === cat)
              .map((b) => {
                const installed = installedNames.has(b.name)
                return (
                  <Card
                    key={b.key}
                    size="small"
                    title={
                      <span className="flex items-center gap-2 text-sm">
                        <Sparkles size={14} className="shrink-0 text-amber-400" />
                        {b.name}
                      </span>
                    }
                    extra={
                      <Button
                        size="small"
                        type={installed ? 'default' : 'primary'}
                        icon={<Download size={13} />}
                        loading={busy === b.key}
                        onClick={() => void install(b)}
                      >
                        {installed ? '更新' : '安装'}
                      </Button>
                    }
                  >
                    <p className="m-0 line-clamp-2 min-h-9 text-xs text-gray-500 dark:text-gray-400">{b.desc}</p>
                    <div className="mt-1.5 flex items-center gap-1">
                      <Tag style={{ marginInlineEnd: 0 }}>npm</Tag>
                      {installed && (
                        <Tag color="green" style={{ marginInlineEnd: 0 }}>
                          已入库
                        </Tag>
                      )}
                    </div>
                  </Card>
                )
              })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ===== 市场（Smithery） =====

function MarketPanel({ installedNames, onInstalled }: { installedNames: Set<string>; onInstalled: () => void }) {
  const { message } = App.useApp()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MarketServer[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)

  const search = useCallback(
    async (q: string) => {
      setLoading(true)
      try {
        setItems(await mcpApi.marketSearch(q))
        setSearched(true)
      } catch (e) {
        message.error(errText(e))
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void search('')
  }, [search])

  const install = async (s: MarketServer) => {
    setBusy(s.qualifiedName)
    try {
      await mcpApi.marketInstall(s.qualifiedName)
      message.success(`已安装「${s.displayName}」（远程 HTTP 方式）`)
      onInstalled()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Input
          placeholder="搜索 Smithery 市场（如 excel / browser / database）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPressEnter={() => void search(query)}
          prefix={<Search size={14} className="text-gray-400" />}
          allowClear
        />
        <Button type="primary" loading={loading} onClick={() => void search(query)}>
          搜索
        </Button>
      </div>
      <p className="mb-3 text-xs text-gray-400">
        Smithery 收录了数千个 MCP 服务器；远程型以 HTTP 端点安装（部分服务需要密钥，安装后在「我的 MCP」编辑补充）。
      </p>
      <Spin spinning={loading}>
        {searched && items.length === 0 && <Empty description="没有匹配的结果" />}
        <div className="flex flex-col gap-2">
          {items.map((s) => {
            const installed = installedNames.has(s.qualifiedName)
            return (
              <div
                key={s.qualifiedName}
                className="flex items-start justify-between gap-3 rounded-lg border border-black/5 px-3 py-2 dark:border-white/10"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="truncate font-medium">{s.displayName}</span>
                    {s.verified && <BadgeCheck size={14} className="shrink-0 text-sky-500" />}
                    <span className="shrink-0 truncate font-mono text-[11px] text-gray-400">{s.qualifiedName}</span>
                  </div>
                  <p className="m-0 mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{s.description}</p>
                  {typeof s.useCount === 'number' && (
                    <span className="text-[11px] text-gray-400">{s.useCount.toLocaleString()} 次使用</span>
                  )}
                </div>
                <Button
                  size="small"
                  icon={<Download size={13} />}
                  loading={busy === s.qualifiedName}
                  onClick={() => void install(s)}
                >
                  {installed ? '重新安装' : '安装'}
                </Button>
              </div>
            )
          })}
        </div>
      </Spin>
    </div>
  )
}

// ===== 本机扫描 =====

function LocalPanel({ managedNames, onImported }: { managedNames: Set<string>; onImported: () => void }) {
  const { message } = App.useApp()
  const [items, setItems] = useState<LocalMcp[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const scan = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await mcpApi.scanLocal())
    } catch (e) {
      message.error(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void scan()
  }, [scan])

  const importOne = async (l: LocalMcp) => {
    setBusy(`${l.cli}:${l.name}`)
    try {
      await mcpApi.save({ ...l.entry, desc: l.entry.desc ?? `${l.cliLabel} 中已有配置` })
      message.success(`已导入「${l.name}」，可在「我的 MCP」勾选分发`)
      onImported()
      await scan()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const groups = MCP_CLI_TARGETS.map((t) => ({ cli: t.id, label: t.label, items: items.filter((i) => i.cli === t.id) })).filter((g) => g.items.length > 0)

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="m-0 text-xs text-gray-400">读取 Claude Code / Codex / OpenCode 配置文件中已有的 MCP，导入后统一管理。</p>
        <Button size="small" icon={<HardDrive size={13} />} onClick={() => void scan()} loading={loading}>
          重新扫描
        </Button>
      </div>
      <Spin spinning={loading}>
        {groups.length === 0 && !loading && <Empty description="本机各 CLI 配置中没有 MCP 服务器" />}
        {groups.map((g) => (
          <div key={g.cli} className="mb-4">
            <div className="mb-2 text-xs font-medium text-gray-400">{g.label}</div>
            <div className="flex flex-col gap-2">
              {g.items.map((l) => {
                const managed = managedNames.has(l.name)
                return (
                  <div
                    key={`${l.cli}:${l.name}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-black/5 px-3 py-2 dark:border-white/10"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="truncate font-medium">{l.name}</span>
                        <Tag style={{ marginInlineEnd: 0 }}>{KIND_LABEL[l.entry.kind] ?? l.entry.kind}</Tag>
                      </div>
                      <span className="block truncate font-mono text-[11px] text-gray-400" title={configSummary(l.entry)}>
                        {configSummary(l.entry)}
                      </span>
                    </div>
                    {managed ? (
                      <Tag color="green" style={{ marginInlineEnd: 0 }}>
                        已管理
                      </Tag>
                    ) : (
                      <Button
                        size="small"
                        icon={<Download size={13} />}
                        loading={busy === `${l.cli}:${l.name}`}
                        onClick={() => void importOne(l)}
                      >
                        导入
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </Spin>
    </div>
  )
}

// ===== 添加 / 编辑表单 =====

function McpForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: McpEntry
  onCancel: () => void
  onSave: (e: McpEntry, targets: string[]) => Promise<void>
}) {
  const { message } = App.useApp()
  const [e, setE] = useState<McpEntry>({ ...initial })
  const [argsText, setArgsText] = useState((initial.args ?? []).join('\n'))
  const [targets, setTargets] = useState<string[]>(MCP_CLI_TARGETS.filter((t) => initial.enabled?.[t.id]).map((t) => t.id))
  const [saving, setSaving] = useState(false)

  const patch = (p: Partial<McpEntry>) => setE((x) => ({ ...x, ...p }))
  const isRemote = e.kind === 'http' || e.kind === 'sse'

  const submit = async () => {
    if (!e.name.trim()) {
      message.warning('请填写服务名（字母、数字、- 和 _）')
      return
    }
    const cleanKv = (m?: KVMap) =>
      Object.fromEntries(Object.entries(m ?? {}).filter(([k, v]) => k.trim() && v !== '')) as KVMap
    setSaving(true)
    try {
      await onSave(
        {
          ...e,
          name: e.name.trim(),
          command: isRemote ? null : e.command?.trim() || null,
          url: isRemote ? e.url?.trim() || null : null,
          args: isRemote ? [] : argsText.split('\n').map((s) => s.trim()).filter(Boolean),
          headers: isRemote ? cleanKv(e.headers) : {},
          env: isRemote ? {} : cleanKv(e.env),
        },
        targets,
      )
    } catch {
      /* 表单保持打开，错误已在 onSave 提示 */
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={initial.id ? `编辑 MCP · ${initial.name}` : '添加 MCP'}
      open
      onCancel={onCancel}
      onOk={() => void submit()}
      confirmLoading={saving}
      okText="保存并分发"
      cancelText="取消"
      width={560}
    >
      <div className="flex flex-col gap-3 pt-2">
        <div className="grid grid-cols-[1fr_auto] items-center gap-3">
          <div>
            <div className="mb-1 text-xs text-gray-500">服务名</div>
            <Input placeholder="如 web-search / excel-mcp-server" value={e.name} onChange={(ev) => patch({ name: ev.target.value })} />
          </div>
          <div>
            <div className="mb-1 text-xs text-gray-500">类型</div>
            <Segmented
              value={e.kind}
              onChange={(v) => patch({ kind: v as string })}
              options={[
                { label: 'stdio', value: 'stdio' },
                { label: 'HTTP', value: 'http' },
                { label: 'SSE', value: 'sse' },
              ]}
            />
          </div>
        </div>

        {isRemote ? (
          <>
            <div>
              <div className="mb-1 text-xs text-gray-500">URL</div>
              <Input placeholder="https://example.com/mcp" value={e.url ?? ''} onChange={(ev) => patch({ url: ev.target.value })} />
            </div>
            <div>
              <div className="mb-1 text-xs text-gray-500">请求头（如 Authorization）</div>
              <KvEditor value={e.headers ?? {}} onChange={(v) => patch({ headers: v })} />
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-[160px_1fr] gap-3">
              <div>
                <div className="mb-1 text-xs text-gray-500">启动命令</div>
                <Input placeholder="npx / uvx / node" value={e.command ?? ''} onChange={(ev) => patch({ command: ev.target.value })} />
              </div>
              <div>
                <div className="mb-1 text-xs text-gray-500">参数（每行一个）</div>
                <Input.TextArea
                  rows={3}
                  placeholder={'-y\n@scope/mcp-server'}
                  value={argsText}
                  onChange={(ev) => setArgsText(ev.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs text-gray-500">环境变量</div>
              <KvEditor value={e.env ?? {}} onChange={(v) => patch({ env: v })} />
            </div>
          </>
        )}

        <div>
          <div className="mb-1 text-xs text-gray-500">备注（可选）</div>
          <Input placeholder="显示在列表中的说明" value={e.desc ?? ''} onChange={(ev) => patch({ desc: ev.target.value })} />
        </div>

        <div>
          <div className="mb-1 text-xs text-gray-500">分发到（保存即写入对应 CLI 配置）</div>
          <div className="flex flex-wrap gap-x-4">
            {MCP_CLI_TARGETS.map((t) => (
              <Checkbox
                key={t.id}
                checked={targets.includes(t.id)}
                onChange={(ev) => setTargets((s) => (ev.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))}
              >
                {t.label}
              </Checkbox>
            ))}
          </div>
          <p className="mb-0 mt-1.5 text-[11px] text-gray-400">
            Claude Code → ~/.claude.json；Codex → ~/.codex/config.toml；OpenCode → ~/.config/opencode/opencode.json
          </p>
        </div>
      </div>
    </Modal>
  )
}

function KvEditor({ value, onChange }: { value: KVMap; onChange: (v: KVMap) => void }) {
  const rows = Object.entries(value ?? {})
  const set = (k: string, v: string) => {
    const next: KVMap = { ...value, [k]: v }
    onChange(next)
  }
  const remove = (k: string) => {
    const next: KVMap = { ...value }
    delete next[k]
    onChange(next)
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([k, v], i) => (
        <div key={`${i}-${k}`} className="flex items-center gap-1.5">
          <Input
            className="w-40 font-mono text-xs"
            placeholder="名称"
            value={k}
            onChange={(ev) => {
              const next: KVMap = {}
              rows.forEach(([rk, rv], ri) => {
                next[ri === i && rk === k ? ev.target.value : rk] = rv
              })
              onChange(next)
            }}
          />
          <Input className="flex-1 font-mono text-xs" placeholder="值" value={v} onChange={(ev) => set(k, ev.target.value)} />
          <Button size="small" type="text" danger icon={<Trash2 size={13} />} onClick={() => remove(k)} />
        </div>
      ))}
      <Button size="small" type="dashed" icon={<Plus size={12} />} className="self-start" onClick={() => set('', '')}>
        添加
      </Button>
    </div>
  )
}
