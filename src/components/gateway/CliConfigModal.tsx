import { useEffect, useState } from 'react'
import { Alert, App, AutoComplete, Button, Card, Checkbox, Collapse, Input, Modal, Select, Tag } from 'antd'
import { RefreshCw } from 'lucide-react'
import { errText } from '../../lib/err'
import {
  cliApi,
  type CliApplyResult,
  type CliModelLists,
  type CliPlanEntry,
  type CliTool,
  type CliToolId,
} from '../../api/cli'
import type { Provider } from '../../db/providers'

interface Props {
  open: boolean
  tools: CliTool[]
  /** 从 CLI 行「配置」进入时固定该工具；为空时向导内单选 */
  tool?: CliToolId | null
  seedProvider?: Provider | null
  onCancel: () => void
}

const CONFIG_PATHS: Record<CliToolId, string> = {
  claude: '~/.claude/settings.json',
  codex: '~/.codex/config.toml',
  opencode: '~/.config/opencode/opencode.json',
  pi: '~/.pi/agent/',
}

type FamilyKey = 'fable' | 'opus' | 'sonnet' | 'haiku'
const FAMILY_KEYS: FamilyKey[] = ['fable', 'opus', 'sonnet', 'haiku']
const FAMILY_LABELS: Record<FamilyKey, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }
const EMPTY_FAMILIES: Record<FamilyKey, string> = { fable: '', opus: '', sonnet: '', haiku: '' }

/** CLI 定向配置：凭据（供应商）→ 模型（cc 四家族 + 1M）→ 配置内容（JSON/TOML 可编辑）→ 应用 */
export default function CliConfigModal({ open, tools, tool, seedProvider, onCancel }: Props) {
  const { message } = App.useApp()
  const [providers, setProviders] = useState<Provider[]>([])
  const [providerId, setProviderId] = useState<string | null>(null)
  const [toolSel, setToolSel] = useState<CliToolId>('claude')
  const [model, setModel] = useState('')
  const [familyModels, setFamilyModels] = useState<Record<FamilyKey, string>>({ ...EMPTY_FAMILIES })
  const [ctx1m, setCtx1m] = useState(false)
  const [rawContent, setRawContent] = useState<string | null>(null)
  const [rawDirty, setRawDirty] = useState(false)
  const [plans, setPlans] = useState<CliPlanEntry[] | null>(null)
  const [results, setResults] = useState<CliApplyResult[] | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelLists, setModelLists] = useState<CliModelLists | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [localTools, setLocalTools] = useState<CliTool[]>([])

  const effTools = tools.length > 0 ? tools : localTools
  const effTool: CliToolId = tool ?? toolSel
  const toolInfo = effTools.find((t) => t.id === effTool)
  const isClaude = effTool === 'claude'
  const hasEditor = isClaude || effTool === 'codex'
  /** 防抖依赖键：cc 用四家族+1M，其余用单模型 */
  const modelKey = isClaude ? JSON.stringify(familyModels) + String(ctx1m) : model

  // 从供应商卡片进入时未传工具列表 → 自行检测
  useEffect(() => {
    if (!open || tools.length > 0) return
    cliApi.detect().then(setLocalTools).catch(() => {})
  }, [open, tools.length])

  // 打开时初始化：凭据默认值、工具默认值、拉取令牌/供应商列表
  useEffect(() => {
    if (!open) return
    setPlans(null)
    setResults(null)
    setError(null)
    setModel('')
    setFamilyModels({ ...EMPTY_FAMILIES })
    setCtx1m(false)
    setRawContent(null)
    setRawDirty(false)
    if (tool) {
      setToolSel(tool)
    } else {
      const first = (tools.length > 0 ? tools : localTools).find(
        (t) => t.installed && t.configurable,
      )?.id as CliToolId | undefined
      setToolSel((cur) => (cur !== 'claude' || first ? (first ?? cur) : cur))
    }
    if (seedProvider) {
      setProviderId(seedProvider.id)
    }
    import('../../db/providers')
      .then(({ providerRepo }) => providerRepo.list())
      .then((list) => {
        setProviders(list)
        if (!seedProvider) {
          setProviderId((cur) => cur ?? list[0]?.id ?? null)
        }
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tool, seedProvider])

  const buildSpec = () => {
    const p = providers.find((x) => x.id === providerId)
    if (!p) throw new Error('请选择供应商')
    return {
      kind: 'stored' as const,
      baseUrl: p.baseUrl,
      secretRef: p.secretRef,
      label: p.name,
      apiFormat: p.kind,
      anthropicBaseUrl: p.anthropicBaseUrl || undefined,
    }
  }

  const canLoad = () => providerId != null

  /** 模型列表：cc 取 Anthropic 端口（空则回退主列表），其余取 OpenAI 端口 */
  const fetchModels = async () => {
    setFetchingModels(true)
    setModelsError(null)
    try {
      const spec = buildSpec()
      setModelLists(await cliApi.models(spec, spec.anthropicBaseUrl))
    } catch (e) {
      setModelLists(null)
      setModelsError(e instanceof Error ? e.message : errText(e))
    } finally {
      setFetchingModels(false)
    }
  }

  /** cc：四家族非空值（+1M 后缀）→ models 映射 */
  const buildFamilies = (): Record<string, string> | undefined => {
    const out: Record<string, string> = {}
    for (const k of FAMILY_KEYS) {
      const v = familyModels[k].trim()
      if (v) out[k] = ctx1m ? `${v}[1M]` : v
    }
    return Object.keys(out).length ? out : undefined
  }

  const buildTargets = () => [
    {
      tool: effTool,
      model: isClaude ? undefined : model || undefined,
      models: isClaude ? buildFamilies() : undefined,
      content: rawDirty && rawContent?.trim() ? rawContent : undefined,
    },
  ]

  const doPreview = async () => {
    setError(null)
    if (!canLoad()) return
    setPreviewing(true)
    try {
      const spec = buildSpec()
      const cred = await cliApi.resolveCredential(spec)
      const p = await cliApi.preview({
        baseUrl: cred.baseUrl,
        apiKey: cred.apiKey,
        label: cred.label,
        targets: buildTargets(),
        anthropicBaseUrl: cred.anthropicBaseUrl ?? undefined,
      })
      setPlans(p)
      setResults(null)
      if (!rawDirty && p[0]) setRawContent(p[0].after)
    } catch (e) {
      setError(e instanceof Error ? e.message : errText(e))
    } finally {
      setPreviewing(false)
    }
  }

  const doApply = async () => {
    if (!plans) return
    if (rawDirty && isClaude) {
      try {
        JSON.parse(rawContent ?? '')
      } catch {
        setError('JSON 语法错误，请检查配置内容')
        return
      }
    }
    setApplying(true)
    setError(null)
    try {
      const spec = buildSpec()
      const cred = await cliApi.resolveCredential(spec)
      const r = await cliApi.apply({
        baseUrl: cred.baseUrl,
        apiKey: cred.apiKey,
        label: cred.label,
        targets: buildTargets(),
        anthropicBaseUrl: cred.anthropicBaseUrl ?? undefined,
      })
      setResults(r)
      if (r.every((x) => x.ok)) message.success('配置完成，重启终端后生效')
    } catch (e) {
      setError(e instanceof Error ? e.message : errText(e))
    } finally {
      setApplying(false)
    }
  }

  const formatRaw = () => {
    if (!rawContent?.trim()) return
    if (isClaude) {
      try {
        setRawContent(JSON.stringify(JSON.parse(rawContent), null, 2))
        setRawDirty(true)
      } catch {
        message.error('JSON 解析失败，请检查语法')
      }
    } else {
      message.info('TOML 请保持原格式，应用前可用「预览变更」确认')
    }
  }

  // 凭据/工具/模型变化：清空未编辑的生成内容与预览
  useEffect(() => {
    if (!open) return
    setPlans(null)
    if (!rawDirty) setRawContent(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providerId, effTool, modelKey])

  // 自动加载：凭据就绪后拉模型列表 + 生成配置预览（编辑内容防抖后刷新 diff）
  useEffect(() => {
    if (!open || !canLoad()) return
    const t = setTimeout(() => {
      void fetchModels()
      void doPreview()
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providerId, effTool, modelKey, rawDirty, rawContent])

  const modelList = () =>
    modelLists ? (modelLists.anthropic.length ? modelLists.anthropic : modelLists.openai) : []

  /** cc 家族输入候选项：该家族匹配的模型优先，其余跟后（如 glm-5.2 可填入 Sonnet 槽） */
  const familyOptions = (fam: FamilyKey) => {
    const list = modelList()
    const hit = list.filter((m) => m.toLowerCase().includes(fam))
    const rest = list.filter((m) => !hit.includes(m))
    return [...hit, ...rest].map((m) => ({ value: m }))
  }

  const baseModelOptions = modelList().map((m) => ({ value: m }))

  return (
    <Modal
      title={`配置 ${toolInfo?.name ?? 'CLI 工具'}`}
      open={open}
      width={760}
      footer={null}
      onCancel={onCancel}
      destroyOnHidden
    >
      <div className="max-h-[70vh] overflow-y-auto pr-1">
        {error && <Alert type="error" showIcon message={error} className="mb-4" closable onClose={() => setError(null)} />}

        {results ? (
          <>
            <Alert
              type={results.every((r) => r.ok) ? 'success' : 'warning'}
              showIcon
              message={results.every((r) => r.ok) ? '配置完成，重启终端/IDE 后生效' : '部分配置未成功，请查看明细'}
              className="mb-4"
            />
            {results.map((r, i) => (
              <div key={i} className="mb-2 flex items-start gap-2 text-sm">
                <Tag color={r.ok ? 'green' : 'red'}>{r.tool}</Tag>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-gray-500" title={r.label}>
                    {r.label}
                  </span>
                  {r.message}
                </span>
              </div>
            ))}
            <Button className="mt-2" onClick={onCancel}>
              关闭
            </Button>
          </>
        ) : (
          <>
            <Card size="small" title="1 · 凭据来源" className="mb-3">
              {providers.length === 0 ? (
                <Alert type="info" showIcon message="暂无供应商，请先在「AI 服务 → 供应商与模型」卡片添加" />
              ) : (
                <Select
                  style={{ width: 320 }}
                  placeholder="选择供应商"
                  value={providerId ?? undefined}
                  onChange={(v) => setProviderId(v)}
                  options={providers.map((p) => ({
                    value: p.id,
                    label: `${p.name}（${
                      p.kind === 'anthropic'
                        ? 'Anthropic'
                        : p.anthropicBaseUrl
                          ? 'OpenAI + Anthropic'
                          : 'OpenAI'
                    }）`,
                  }))}
                />
              )}
            </Card>

            <Card size="small" title="2 · 目标工具与模型（模型可留空）" className="mb-3">
              {tool == null && (
                <Select
                  style={{ width: 220 }}
                  value={effTool}
                  onChange={(v) => setToolSel(v)}
                  className="mb-2"
                  options={effTools
                    .filter((t) => t.configurable)
                    .map((t) => ({
                      value: t.id,
                      label: `${t.name}${t.installed ? '' : '（未检测到）'}`,
                    }))}
                />
              )}
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {toolInfo && (
                  <>
                    {toolInfo.installed ? (
                      <Tag color="green" style={{ marginRight: 0 }}>
                        已安装 {toolInfo.version ? `· ${toolInfo.version}` : ''}
                      </Tag>
                    ) : (
                      <Tag style={{ marginRight: 0 }}>未检测到</Tag>
                    )}
                    <span className="font-mono text-xs text-gray-400">{CONFIG_PATHS[effTool]}</span>
                  </>
                )}
              </div>
              {isClaude ? (
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {FAMILY_KEYS.map((k) => (
                      <div key={k} className="flex items-center gap-2">
                        <span className="w-12 shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">
                          {FAMILY_LABELS[k]}
                        </span>
                        <AutoComplete
                          style={{ minWidth: 0 }}
                          className="min-w-0 flex-1"
                          size="small"
                          placeholder="模型（可留空）"
                          value={familyModels[k]}
                          onChange={(v) => setFamilyModels({ ...familyModels, [k]: v })}
                          options={familyOptions(k)}
                          filterOption={(input, opt) =>
                            String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <Checkbox checked={ctx1m} onChange={(e) => setCtx1m(e.target.checked)}>
                    1M 上下文（已填模型名追加 [1M]）
                  </Checkbox>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <AutoComplete
                    style={{ minWidth: 300 }}
                    placeholder="模型（可选，下拉选择或手动输入）"
                    value={model}
                    onChange={setModel}
                    options={baseModelOptions}
                    filterOption={(input, opt) =>
                      String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  size="small"
                  icon={<RefreshCw size={13} />}
                  loading={fetchingModels}
                  onClick={() => void fetchModels()}
                >
                  刷新模型列表
                </Button>
                <span className="text-xs text-gray-400">
                  {isClaude ? '列表来自该凭据的 Anthropic 端口，分别写入 ANTHROPIC_DEFAULT_*_MODEL' : '列表来自该凭据的 OpenAI 端口'}
                </span>
              </div>
              {modelsError && <Alert type="warning" showIcon message={modelsError} className="mt-2" />}
              {modelLists && isClaude && modelLists.anthropic.length === 0 && modelLists.anthropicError && (
                <p className="m-0 mt-2 text-xs text-amber-500">
                  Anthropic 端口未返回模型（{modelLists.anthropicError}），已回退 OpenAI 列表。
                </p>
              )}
            </Card>

            {hasEditor && (
              <Card
                size="small"
                title={`3 · 配置内容（${isClaude ? 'settings.json' : 'config.toml'}，可直接编辑）`}
                className="mb-3"
                extra={
                  isClaude ? (
                    <Button size="small" onClick={formatRaw}>
                      格式化
                    </Button>
                  ) : undefined
                }
              >
                <Input.TextArea
                  rows={12}
                  className="font-mono text-xs"
                  value={rawContent ?? ''}
                  onChange={(e) => {
                    setRawContent(e.target.value)
                    setRawDirty(true)
                  }}
                  placeholder="自动生成（按上方凭据与模型），也可直接粘贴完整配置；应用时整体替换目标文件（自动 .bak 备份）。"
                />
                <p className="m-0 mt-1 text-xs text-gray-400">
                  {isClaude
                    ? '整体替换 ~/.claude/settings.json；请保留所需的 env 模型环境变量。'
                    : '整体替换 ~/.codex/config.toml（auth.json 不受影响）；请保留 model_provider 等必需条目。'}
                </p>
              </Card>
            )}

            {plans && plans.length > 0 && (
              <Card size="small" title={`${hasEditor ? '4' : '3'} · 变更预览（应用前自动生成 .bak 备份）`} className="mb-3">
                {plans.map((p, i) => (
                  <div key={i} className="mb-2 flex items-center gap-2">
                    <Tag style={{ marginRight: 0 }}>{p.label}</Tag>
                    <span className="truncate font-mono text-xs" title={p.configPath}>
                      {p.configPath}
                    </span>
                    {p.changed ? <Tag color="orange">有变更</Tag> : <Tag color="default">无变更</Tag>}
                    {!p.exists && <Tag color="blue">新建</Tag>}
                  </div>
                ))}
                <Collapse
                  size="small"
                  items={plans.map((p, i) => ({
                    key: String(i),
                    label: <span className="font-mono text-xs">{p.configPath}</span>,
                    children: (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <div className="mb-1 text-xs text-gray-400">当前{p.exists ? '' : '（不存在）'}</div>
                          <pre className="max-h-64 overflow-auto rounded bg-gray-100 p-2 text-xs dark:bg-gray-800">
                            {p.before ?? '（空）'}
                          </pre>
                        </div>
                        <div>
                          <div className="mb-1 text-xs text-gray-400">写入后</div>
                          <pre className="max-h-64 overflow-auto rounded bg-indigo-50 p-2 text-xs dark:bg-indigo-950/40">
                            {p.after}
                          </pre>
                        </div>
                      </div>
                    ),
                  }))}
                />
              </Card>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button onClick={onCancel}>取消</Button>
              <Button onClick={() => void doPreview()} loading={previewing}>
                {plans ? '重新预览' : '预览变更'}
              </Button>
              {plans && plans.some((p) => p.changed) && (
                <Button type="primary" onClick={() => void doApply()} loading={applying}>
                  应用配置
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
