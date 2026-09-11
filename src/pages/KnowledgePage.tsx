import { useEffect, useState } from 'react'
import { Alert, App, Button, Checkbox, Empty, Input, Modal, Popconfirm, Select, Tag, Tooltip } from 'antd'
import { BookOpen, ChevronDown, Database, Library, Pencil, PlugZap, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { errText } from '../lib/err'
import { kbApi, type KbApiConfig, type KbChunk, type KbEntry, type KbListed, type KbState } from '../api/kb'

const PROVIDERS: Record<string, { label: string; baseUrlPh: string; tokenPh: string; hint: string }> = {
  weknora: {
    label: 'WeKnora',
    baseUrlPh: '服务基址，如 https://your-weknora.example.com（不带 /api/v1）',
    tokenPh: 'API Key（X-API-Key 头）',
    hint: '腾讯 WeKnora v0.7+：拉取走 /api/v1/knowledge-bases，检索走 /api/v1/knowledge-search；令牌以 X-API-Key 头传递。',
  },
  dify: {
    label: 'Dify',
    baseUrlPh: 'Dify 服务地址，如 https://dify.example.com（自动补 /v1）',
    tokenPh: '知识库 API Key（Bearer）',
    hint: 'Dify 知识库 Service API：拉取 /v1/datasets，检索 /v1/datasets/{id}/retrieve；令牌需在 Dify「知识库 → Service API」创建（不是 App Key）。',
  },
  'external-api': {
    label: 'Dify 外部知识 API',
    baseUrlPh: '完整检索端点 URL，如 https://rag.company.com/retrieve',
    tokenPh: 'Bearer Token',
    hint: 'Dify 外部知识库 API 协议：地址即检索端点（返回 {records:[...]}）；无列表端点，知识库需手动添加。',
  },
}

interface ApiForm {
  name: string
  provider: string
  baseUrl: string
  scoreThreshold: string
  token: string
}

const EMPTY_FORM: ApiForm = { name: '', provider: 'weknora', baseUrl: '', scoreThreshold: '', token: '' }

interface EntryRow {
  key: string
  name: string
  enabled: boolean
  docCount?: number | null
  fromApi?: boolean
}

/** 检索结果条目：文件 + 相关度 + 两行摘要，点击展开全文 */
function KbResultItem({ chunk, index }: { chunk: KbChunk; index: number }) {
  const [open, setOpen] = useState(false)
  const srcLine = [chunk.title, chunk.source].filter(Boolean).join(' · ')
  return (
    <div
      className="cursor-pointer rounded-lg border border-black/5 px-3 py-2 hover:border-indigo-300 dark:border-white/10 dark:hover:border-indigo-500"
      onClick={() => setOpen(!open)}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-xs text-gray-400">[{index + 1}]</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-700 dark:text-gray-200">
          {srcLine || chunk.kbName || '（未命名）'}
        </span>
        {chunk.kbName && <Tag color="blue" style={{ marginInlineEnd: 0 }}>{chunk.kbName}</Tag>}
        {chunk.score != null && (
          <span className="shrink-0 text-xs text-gray-400">相关度 {(chunk.score * 100).toFixed(0)}%</span>
        )}
        <ChevronDown size={13} className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </div>
      <p
        className={`m-0 mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400 ${open ? 'whitespace-pre-wrap' : ''}`}
        style={
          open
            ? undefined
            : {
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
      >
        {chunk.content}
      </p>
    </div>
  )
}

export default function KnowledgePage() {
  const { message } = App.useApp()
  const [state, setState] = useState<KbState>({ apis: [], entries: [] })
  const [editOpen, setEditOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ApiForm>(EMPTY_FORM)
  const [clearToken, setClearToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [manageApi, setManageApi] = useState<KbApiConfig | null>(null)
  const [rows, setRows] = useState<EntryRow[]>([])
  const [pulling, setPulling] = useState(false)
  const [pullErr, setPullErr] = useState<string | null>(null)
  const [manualKey, setManualKey] = useState('')
  const [manualName, setManualName] = useState('')
  const [query, setQuery] = useState('')
  const [filterIds, setFilterIds] = useState<string[]>([])
  const [results, setResults] = useState<KbChunk[] | null>(null)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    kbApi.getConfig().then(setState).catch(() => {})
  }, [])

  const entriesOf = (apiId: string) => state.entries.filter((e) => e.apiId === apiId)

  const openEdit = (api?: KbApiConfig) => {
    setEditingId(api?.id ?? null)
    setClearToken(false)
    setForm(
      api
        ? {
            name: api.name,
            provider: api.provider || 'weknora',
            baseUrl: api.baseUrl,
            scoreThreshold: api.scoreThreshold != null ? String(api.scoreThreshold) : '',
            token: '',
          }
        : EMPTY_FORM,
    )
    setEditOpen(true)
  }

  const saveEdit = async () => {
    if (!form.baseUrl.trim()) {
      message.warning('请填写服务地址')
      return
    }
    setSaving(true)
    try {
      const th = form.scoreThreshold.trim()
      const thNum = th === '' ? null : Number.parseFloat(th)
      const st = await kbApi.saveApi(
        {
          id: editingId ?? '',
          name: form.name.trim() || '知识库连接',
          provider: form.provider,
          baseUrl: form.baseUrl.trim(),
          scoreThreshold: thNum != null && Number.isFinite(thNum) ? thNum : null,
          tokenRef: state.apis.find((a) => a.id === editingId)?.tokenRef ?? null,
        },
        clearToken ? '' : form.token.trim() ? form.token.trim() : undefined,
      )
      setState(st)
      setEditOpen(false)
      message.success('已保存')
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const testApi = async (api: KbApiConfig) => {
    setTesting(api.id)
    try {
      const r = await kbApi.testApi(api.id)
      if (r.ok) message.success(r.message)
      else message.warning(r.message)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setTesting(null)
    }
  }

  const removeApi = async (api: KbApiConfig) => {
    try {
      setState(await kbApi.removeApi(api.id))
      message.success(`已删除 ${api.name}`)
    } catch (e) {
      message.error(errText(e))
    }
  }

  const pullList = async (api: KbApiConfig, current: EntryRow[]) => {
    setPulling(true)
    setPullErr(null)
    try {
      const listed: KbListed[] = await kbApi.fetchList(api.id)
      setRows((prev) => {
        const base = prev.length && prev !== current ? prev : current
        const known = new Set(base.map((r) => r.key))
        const merged = [...base]
        for (const l of listed) {
          if (!known.has(l.key)) merged.push({ key: l.key, name: l.name || l.key, enabled: false, docCount: l.docCount ?? null, fromApi: true })
        }
        return merged
      })
      if (listed.length === 0) setPullErr('连接返回了空的知识库列表，可手动添加')
    } catch (e) {
      setPullErr(`${errText(e)}；也可以直接手动添加知识库`)
    } finally {
      setPulling(false)
    }
  }

  const openManage = async (api: KbApiConfig) => {
    const current: EntryRow[] = entriesOf(api.id).map((e) => ({ key: e.key, name: e.name, enabled: e.enabled }))
    setRows(current)
    setManualKey('')
    setManualName('')
    setPullErr(null)
    setManageApi(api)
    if (api.provider !== 'external-api') void pullList(api, current)
  }

  const addManual = () => {
    const key = manualKey.trim()
    if (!key) return
    if (rows.some((r) => r.key === key)) {
      message.warning('该知识库已在列表中')
      return
    }
    setRows([...rows, { key, name: manualName.trim() || key, enabled: false }])
    setManualKey('')
    setManualName('')
  }

  const saveManage = async () => {
    if (!manageApi) return
    try {
      setState(
        await kbApi.setEntries(
          manageApi.id,
          rows.map(({ key, name, enabled }) => ({ key, name, enabled })),
        ),
      )
      setManageApi(null)
      message.success('知识库列表已更新')
    } catch (e) {
      message.error(errText(e))
    }
  }

  const toggleEntry = async (api: KbApiConfig, entry: KbEntry) => {
    const next = entriesOf(api.id).map((e) => (e.key === entry.key ? { ...e, enabled: !e.enabled } : e))
    try {
      setState(await kbApi.setEntries(api.id, next))
    } catch (e) {
      message.error(errText(e))
    }
  }

  const removeEntry = async (api: KbApiConfig, entry: KbEntry) => {
    try {
      setState(await kbApi.setEntries(api.id, entriesOf(api.id).filter((e) => e.key !== entry.key)))
    } catch (e) {
      message.error(errText(e))
    }
  }

  const doSearch = async () => {
    if (!query.trim()) return
    setSearching(true)
    try {
      setResults(await kbApi.search(query.trim(), 8, filterIds.length ? filterIds : undefined))
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSearching(false)
    }
  }

  /** 检索范围选项：按连接分组列出全部知识库条目 */
  const filterOptions = state.apis
    .map((api) => ({
      label: api.name,
      title: api.name,
      options: entriesOf(api.id).map((e) => ({ value: e.id, label: e.enabled ? e.name : `${e.name}（停用）` })),
    }))
    .filter((g) => g.options.length > 0)

  const pm = PROVIDERS[form.provider] ?? PROVIDERS.weknora

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-6 lg:h-full lg:flex-row">
      {/* 左：连接与挂载的知识库列表（窄屏在上方整宽，宽屏固定列内滚） */}
      <aside className="flex w-full shrink-0 flex-col lg:min-h-0 lg:w-80 lg:border-r lg:border-black/5 lg:pr-4 dark:lg:border-white/10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="m-0 text-lg font-semibold">知识库（外接）</h2>
          <Button type="primary" size="small" icon={<Plus size={13} />} onClick={() => openEdit()}>
            添加连接
          </Button>
        </div>
        <div className="flex flex-col gap-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
          {state.apis.length === 0 ? (
            <Empty
              image={<BookOpen size={44} strokeWidth={1.4} className="mx-auto text-indigo-300" />}
              description="添加外接知识库连接（WeKnora / Dify / 外部知识 API），每个连接可挂载多个知识库"
            />
          ) : (
            state.apis.map((api) => {
              const entries = entriesOf(api.id)
              const on = entries.filter((e) => e.enabled).length
              const prov = PROVIDERS[api.provider || 'weknora'] ?? PROVIDERS.weknora
              return (
                <div
                  key={api.id}
                  className="rounded-lg border border-black/5 bg-white p-2.5 shadow-sm dark:border-white/10 dark:bg-white/5"
                >
                  <div className="flex items-center gap-1">
                    <Database size={14} className="shrink-0 text-indigo-500" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium" title={api.name}>
                      {api.name}
                    </span>
                    <Tooltip title="拉取 / 管理挂载的知识库">
                      <Button size="small" type="text" icon={<Library size={13} />} onClick={() => void openManage(api)} />
                    </Tooltip>
                    <Tooltip title="测试连接">
                      <Button
                        size="small"
                        type="text"
                        icon={<PlugZap size={13} />}
                        loading={testing === api.id}
                        onClick={() => void testApi(api)}
                      />
                    </Tooltip>
                    <Tooltip title="编辑连接">
                      <Button size="small" type="text" icon={<Pencil size={13} />} onClick={() => openEdit(api)} />
                    </Tooltip>
                    <Popconfirm title={`删除 ${api.name}？其挂载的知识库一并移除。`} onConfirm={() => void removeApi(api)}>
                      <Button size="small" type="text" danger icon={<Trash2 size={13} />} />
                    </Popconfirm>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                      {prov.label}
                    </Tag>
                    <Tag color={api.tokenRef ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>
                      {api.tokenRef ? '凭证已设置' : '匿名'}
                    </Tag>
                    <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                      {on}/{entries.length} 启用
                    </Tag>
                  </div>
                  <p
                    className="m-0 mt-1.5 truncate font-mono text-[10px] text-gray-400"
                    title={`${api.baseUrl}${api.scoreThreshold != null && api.scoreThreshold > 0 ? `（阈值 ≥ ${api.scoreThreshold}）` : ''}`}
                  >
                    {api.baseUrl}
                    {api.scoreThreshold != null && api.scoreThreshold > 0 && (
                      <span className="ml-1">≥ {api.scoreThreshold}</span>
                    )}
                  </p>
                  {entries.length === 0 ? (
                    <p className="m-0 mt-2 text-xs text-gray-400">
                      未挂载知识库，不参与检索；点右上 <Library size={11} className="inline align-[-2px]" /> 拉取并启用。
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {entries.map((e) => (
                        <Tag
                          key={e.key}
                          color={e.enabled ? 'green' : 'default'}
                          className="cursor-pointer"
                          closable
                          onClose={(ev) => {
                            ev.preventDefault()
                            void removeEntry(api, e)
                          }}
                          onClick={() => void toggleEntry(api, e)}
                        >
                          {e.name}
                        </Tag>
                      ))}
                      <span className="text-[10px] text-gray-400">点击启/停用</span>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* 右：检索（范围 + 关键词 + 结果，宽屏结果区独立内滚） */}
      <section className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
        {state.apis.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="先在左侧添加连接并启用知识库，即可在此检索；聊天/画图中开启知识库后自动引用检索结果"
            />
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="shrink-0 text-xs text-gray-400">检索范围</span>
              <Select
                mode="multiple"
                allowClear
                placeholder="全部知识库（按各连接的启用项）"
                value={filterIds}
                onChange={setFilterIds}
                options={filterOptions}
                maxTagCount="responsive"
                className="min-w-0 flex-1"
                size="small"
              />
            </div>
            <div className="mb-3 flex items-center gap-2">
              <Input
                placeholder="搜索已启用的知识库…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onPressEnter={() => void doSearch()}
                prefix={<Search size={15} className="text-gray-400" />}
                allowClear
              />
              <Button type="primary" loading={searching} onClick={() => void doSearch()} disabled={!query.trim()}>
                检索
              </Button>
            </div>
            <div className="flex flex-col gap-1.5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
              {results === null ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入关键词开始检索" />
              ) : results.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有相关内容" />
              ) : (
                results.map((c, i) => <KbResultItem key={i} chunk={c} index={i} />)
              )}
            </div>
          </>
        )}
      </section>

      {/* 连接编辑弹窗 */}
      <Modal
        title={editingId ? '编辑连接' : '添加连接'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => void saveEdit()}
        confirmLoading={saving}
        okText="保存"
        destroyOnHidden
      >
        <div className="flex flex-col gap-3 pt-1">
          <Select
            value={form.provider}
            onChange={(v) => setForm({ ...form, provider: v })}
            options={Object.entries(PROVIDERS).map(([value, p]) => ({ value, label: p.label }))}
          />
          <Alert type="info" showIcon className="!py-1.5" message={<span className="text-xs">{pm.hint}</span>} />
          <Input
            placeholder="名称，例如：产品知识库"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            placeholder={pm.baseUrlPh}
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          />
          <Input
            placeholder="相似度阈值（默认 0.5，0 = 关闭过滤）"
            value={form.scoreThreshold}
            onChange={(e) => setForm({ ...form, scoreThreshold: e.target.value })}
          />
          <div>
            <Input.Password
              placeholder={
                state.apis.find((a) => a.id === editingId)?.tokenRef && !clearToken
                  ? `凭证（已设置，留空不修改）${form.provider === 'weknora' ? '：X-API-Key' : '：Bearer'}`
                  : pm.tokenPh
              }
              value={form.token}
              disabled={clearToken}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              autoComplete="off"
            />
            {state.apis.find((a) => a.id === editingId)?.tokenRef && (
              <div className="mt-1">
                {clearToken ? (
                  <Button type="link" size="small" className="!px-0" onClick={() => setClearToken(false)}>
                    保留已存凭证
                  </Button>
                ) : (
                  <Button type="link" size="small" danger className="!px-0" onClick={() => setClearToken(true)}>
                    清除已存凭证
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* 知识库管理弹窗 */}
      <Modal
        title={manageApi ? `知识库 · ${manageApi.name}` : ''}
        open={!!manageApi}
        onCancel={() => setManageApi(null)}
        width={520}
        footer={
          <span className="flex items-center gap-2">
            <Tooltip
              title={
                manageApi?.provider === 'external-api' ? '该协议无列表端点，请手动添加' : '重新拉取知识库列表'
              }
            >
              <Button
                size="small"
                icon={<RefreshCw size={13} />}
                loading={pulling}
                disabled={manageApi?.provider === 'external-api'}
                onClick={() => manageApi && void pullList(manageApi, rows)}
              />
            </Tooltip>
            <div className="flex-1" />
            <Button onClick={() => setManageApi(null)}>取消</Button>
            <Button type="primary" onClick={() => void saveManage()}>
              保存
            </Button>
          </span>
        }
        destroyOnHidden
      >
        {pullErr && <Alert type="warning" showIcon className="mb-3" message={pullErr} />}
        <p className="mb-2 mt-0 text-xs text-gray-400">
          勾选要参与检索的知识库（保存后生效）{manageApi?.provider === 'external-api' ? '；该协议无列表端点，请在下方手动添加' : '；列表来自连接拉取，也可手动添加'}。
        </p>
        <div className="mb-3 flex max-h-72 flex-col gap-1 overflow-y-auto">
          {rows.length === 0 && !pulling && (
            <p className="m-0 py-6 text-center text-xs text-gray-400">暂无知识库，等待拉取或手动添加</p>
          )}
          {rows.map((r) => (
            <div
              key={r.key}
              className="flex items-center gap-2 rounded-md border border-black/5 px-2.5 py-1.5 dark:border-white/10"
            >
              <Checkbox
                checked={r.enabled}
                onChange={(e) =>
                  setRows(rows.map((x) => (x.key === r.key ? { ...x, enabled: e.target.checked } : x)))
                }
              />
              <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
              {r.docCount != null && <Tag style={{ marginInlineEnd: 0 }}>{r.docCount} 文档</Tag>}
              {r.fromApi && <Tag style={{ marginInlineEnd: 0 }}>拉取</Tag>}
              <span className="truncate font-mono text-xs text-gray-400">{r.key}</span>
              <Button
                size="small"
                type="text"
                danger
                icon={<Trash2 size={12} />}
                onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
              />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="知识库标识"
            value={manualKey}
            onChange={(e) => setManualKey(e.target.value)}
            onPressEnter={addManual}
            style={{ width: 170 }}
          />
          <Input
            placeholder="名称（可选）"
            value={manualName}
            onChange={(e) => setManualName(e.target.value)}
            onPressEnter={addManual}
            style={{ width: 150 }}
          />
          <Button size="small" icon={<Plus size={13} />} onClick={addManual}>
            手动添加
          </Button>
        </div>
      </Modal>
    </div>
  )
}
