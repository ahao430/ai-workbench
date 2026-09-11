import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Card, Checkbox, Empty, Form, Input, Modal, Popconfirm, Select, Tag } from 'antd'
import { Import, Plus, RefreshCw, SquareTerminal } from 'lucide-react'
import { errText } from '../../lib/err'
import { call as ipcCall } from '../../api/ipc'
import { listModels, secretPut } from '../../api/chat'
import { providerRepo, type Provider } from '../../db/providers'
import { PROVIDER_PRESETS, inferCurrency } from '../../lib/providerPresets'
import { BrandAvatar } from '../../lib/brand'
import { type QuotaResult } from '../../api/quota'
import { fetchProviderQuotas, useQuotaAutoRefresh } from '../../hooks/useQuota'
import { useUiStore } from '../../stores/ui'
import { QuotaSummary } from '../QuotaDisplay'
import CliConfigModal from './CliConfigModal'
import CcImportModal from './CcImportModal'

interface FormValues {
  name: string
  baseUrl: string
  anthropicBaseUrl?: string
  apiKey?: string
  quotaType?: string
  currency?: 'USD' | 'CNY'
  showOnHome?: boolean
  showOnTray?: boolean
}

/** 第三方供应商管理：密钥存本机 sqlite（0600），模型列表缓存供聊天/画图复用 */
export default function ProvidersTab() {
  const { message } = App.useApp()
  const [items, setItems] = useState<Provider[]>([])
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [presetId, setPresetId] = useState<string>(PROVIDER_PRESETS[0].id)
  const [saving, setSaving] = useState(false)
  const [fetching, setFetching] = useState<string | null>(null)
  const [cliFor, setCliFor] = useState<Provider | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [quotas, setQuotas] = useState<Record<string, QuotaResult>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [refreshingOne, setRefreshingOne] = useState<string | null>(null)
  const quotaRefreshSec = useUiStore((s) => s.quotaRefreshSec)
  const [form] = Form.useForm<FormValues>()

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? PROVIDER_PRESETS[0]

  const quotaTargets = useMemo(() => items.filter((p) => p.quotaType), [items])

  const loadQuotas = useCallback(async () => {
    if (quotaTargets.length === 0) return
    setRefreshing(true)
    try {
      const r = await fetchProviderQuotas(quotaTargets)
      setQuotas((prev) => ({ ...prev, ...r }))
    } finally {
      setRefreshing(false)
    }
  }, [quotaTargets])

  /** 刷新单个供应商的额度 */
  const refreshOne = useCallback(async (p: Provider) => {
    if (!p.quotaType) return
    setRefreshingOne(p.id)
    try {
      const r = await fetchProviderQuotas([p])
      setQuotas((prev) => ({ ...prev, ...r }))
    } finally {
      setRefreshingOne(null)
    }
  }, [])

  useEffect(() => {
    void loadQuotas()
  }, [loadQuotas])

  useQuotaAutoRefresh(quotaRefreshSec, () => void loadQuotas())

  const load = async () => {
    setLoading(true)
    try {
      const list = await providerRepo.list()
      setItems(list)
      const m: Record<string, string[]> = {}
      for (const p of list) {
        m[p.id] = await providerRepo.models(p.id)
      }
      setModels(m)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const openNew = () => {
    setEditing(null)
    setPresetId(PROVIDER_PRESETS[0].id)
    form.resetFields()
    form.setFieldsValue({ name: PROVIDER_PRESETS[0].name, baseUrl: '', currency: PROVIDER_PRESETS[0].currency })
    setModalOpen(true)
  }

  const openEdit = (p: Provider) => {
    setEditing(p)
    form.setFieldsValue({
      name: p.name,
      baseUrl: p.baseUrl,
      anthropicBaseUrl: p.anthropicBaseUrl,
      apiKey: undefined,
      quotaType: p.quotaType || '',
      currency: (p.currency === 'USD' || p.currency === 'CNY' ? p.currency : inferCurrency(p)) as 'USD' | 'CNY',
      showOnHome: p.showOnHome === 1,
      showOnTray: p.showOnTray === 1,
    })
    setModalOpen(true)
  }

  const save = async (v: FormValues) => {
    setSaving(true)
    try {
      if (editing) {
        await providerRepo.update({
          id: editing.id,
          name: v.name.trim(),
          baseUrl: v.baseUrl.trim(),
          anthropicBaseUrl: v.anthropicBaseUrl?.trim() ?? '',
          quotaType: v.quotaType ?? editing.quotaType,
          currency: v.currency ?? 'USD',
          showOnHome: v.showOnHome ? 1 : 0,
          showOnTray: v.showOnTray ? 1 : 0,
        })
        if (v.apiKey?.trim()) {
          await secretPut(editing.secretRef, v.apiKey.trim())
        }
      } else {
        const id = crypto.randomUUID()
        const secretRef = `provider-${id}`
        await secretPut(secretRef, v.apiKey!.trim())
        await providerRepo.create({
          id,
          name: v.name.trim(),
          baseUrl: v.baseUrl.trim(),
          anthropicBaseUrl: v.anthropicBaseUrl?.trim(),
          secretRef,
          kind: preset.kind,
          currency: v.currency ?? preset.currency,
        })
      }
      message.success('已保存')
      // 供应商配置变了立刻刷新托盘菜单栏
      ipcCall<void>('tray_refresh').catch(() => {})
      setModalOpen(false)
      await load()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const fetchModels = async (p: Provider) => {
    setFetching(p.id)
    try {
      const ids = await listModels({
        kind: 'stored',
        baseUrl: p.baseUrl,
        secretRef: p.secretRef,
        label: p.name,
      })
      await providerRepo.setModels(p.id, ids)
      setModels((m) => ({ ...m, [p.id]: ids }))
      message.success(`获取到 ${ids.length} 个模型`)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setFetching(null)
    }
  }

  const remove = async (p: Provider) => {
    await providerRepo.remove(p.id)
    await load()
    message.success('已删除')
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="m-0 text-sm text-gray-500 dark:text-gray-400">
          OpenAI 兼容的第三方服务；密钥存本机 sqlite，不落明文。可在 Chat / 画图中选用。
        </p>
        <div className="flex gap-2">
          <Button
            size="small"
            icon={<RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />}
            onClick={() => void loadQuotas()}
            title={`每 ${quotaRefreshSec || '—'} 秒自动刷新，可在设置中调整`}
          />
          <Button size="small" icon={<Import size={13} />} onClick={() => setImportOpen(true)}>
            从 cc-switch 导入
          </Button>
          <Button type="primary" size="small" icon={<Plus size={14} />} onClick={openNew}>
            添加供应商
          </Button>
        </div>
      </div>

      {items.length === 0 && !loading && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有第三方供应商" />
      )}

      {items.map((p) => (
        <Card
          key={p.id}
          size="small"
          className="mb-3"
          title={
            <span className="flex items-center gap-2 text-sm">
              <BrandAvatar p={p} size={20} />
              {p.name}
            </span>
          }
          extra={
            <div className="flex gap-1.5">
              <Button
                size="small"
                icon={<RefreshCw size={13} />}
                loading={fetching === p.id}
                onClick={() => void fetchModels(p)}
              >
                获取模型
              </Button>
              <Button size="small" icon={<SquareTerminal size={13} />} onClick={() => setCliFor(p)}>
                CLI
              </Button>
              <Button size="small" onClick={() => openEdit(p)}>
                编辑
              </Button>
              <Popconfirm title={`删除「${p.name}」？密钥将一并清除。`} onConfirm={() => void remove(p)}>
                <Button size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            </div>
          }
        >
          <div className="flex items-center gap-1.5">
            <Tag
              color={p.kind === 'anthropic' ? 'orange' : 'geekblue'}
              style={{ marginInlineEnd: 0 }}
            >
              {p.kind === 'anthropic'
                ? '仅 Claude Code'
                : p.anthropicBaseUrl
                  ? 'OpenAI + Anthropic'
                  : 'OpenAI 兼容'}
            </Tag>
            <span className="truncate font-mono text-xs text-gray-400">
              {p.baseUrl}
              {p.anthropicBaseUrl ? ` · ${p.anthropicBaseUrl}` : ''}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {(models[p.id] ?? []).length === 0 ? (
              <span className="text-xs text-gray-400">尚未获取模型</span>
            ) : (
              (models[p.id] ?? []).slice(0, 8).map((m) => (
                <Tag key={m} style={{ marginInlineEnd: 0 }}>
                  {m}
                </Tag>
              ))
            )}
            {(models[p.id] ?? []).length > 8 && <Tag>+{(models[p.id] ?? []).length - 8}</Tag>}
          </div>
          {p.quotaType && (
            <div className="mt-2 flex items-start gap-1 border-t border-gray-100 pt-2 dark:border-gray-800">
              <QuotaSummary result={quotas[p.id]} />
              <Button
                type="text"
                size="small"
                className="shrink-0"
                icon={<RefreshCw size={12} className={refreshingOne === p.id ? 'animate-spin' : ''} />}
                onClick={() => void refreshOne(p)}
                title="刷新该供应商额度"
              />
            </div>
          )}
        </Card>
      ))}

      <Modal
        title={editing ? `编辑供应商 · ${editing.name}` : '添加供应商'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={async () => void (await form.validateFields().then(save))}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" className="pt-1">
          {!editing && (
            <Form.Item label="供应商类型" className="mb-2">
              <Select
                value={presetId}
                onChange={(id) => {
                  setPresetId(id)
                  const p = PROVIDER_PRESETS.find((x) => x.id === id)!
                  form.setFieldsValue({
                    name: p.name,
                    baseUrl: p.baseUrl,
                    anthropicBaseUrl: p.anthropicBaseUrl ?? '',
                    currency: p.currency,
                  })
                }}
                options={PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.name }))}
              />
              <div className="mt-1 text-xs text-gray-400">{preset.desc}</div>
            </Form.Item>
          )}
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如 DeepSeek / OpenRouter" />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label={preset.kind === 'anthropic' && !editing ? 'Anthropic 请求地址' : 'OpenAI 请求地址'}
            rules={[{ required: true, message: '请输入服务地址' }]}
            extra={
              editing
                ? `协议：${editing.kind === 'anthropic' ? 'Anthropic Messages' : 'OpenAI 兼容'}`
                : preset.readonly
                  ? '官方预设地址，不可修改'
                  : `协议：OpenAI 兼容${preset.keyUrl ? ` · API Key 获取：${preset.keyUrl}` : ''}`
            }
          >
            <Input disabled={editing ? false : preset.readonly} placeholder="https://…" />
          </Form.Item>
          {(editing ? editing.kind === 'openai' : preset.kind === 'openai') && (
            <Form.Item
              name="anthropicBaseUrl"
              label="Anthropic 请求地址（可选）"
              extra="填了之后一键配置 Claude Code 时使用此地址"
            >
              <Input placeholder="https://…（留空不启用）" autoComplete="off" />
            </Form.Item>
          )}
          <Form.Item
            name="apiKey"
            label={editing ? 'API Key（留空不修改）' : 'API Key'}
            rules={editing ? [] : [{ required: true, message: '请输入 API Key' }]}
          >
            <Input.Password placeholder="sk-..." autoComplete="off" />
          </Form.Item>

          <div className="mt-1 mb-2 text-xs font-medium text-gray-400">额度查询（看板 / 托盘展示）</div>
          <Form.Item name="currency" label="余额单位" className="mb-2" extra="智谱国内 / DeepSeek 平台余额为人民币；GPT / Claude 官方为美元；NewAPI 网关按实际口径选择">
            <Select
              className="w-32"
              options={[
                { value: 'CNY', label: '¥ 人民币' },
                { value: 'USD', label: '$ 美元' },
              ]}
            />
          </Form.Item>
          <Form.Item name="quotaType" label="查询方式" className="mb-2">
            <Select
              allowClear
              placeholder="不查询"
              options={[
                { value: 'deepseek', label: 'DeepSeek 官方余额（/user/balance）' },
                { value: 'zhipu-coding', label: '智谱 Coding Plan 额度（5h/月窗口 + 重置时间）' },
                { value: 'newapi', label: 'NewAPI 令牌额度（/api/usage/token）' },
              ]}
            />
          </Form.Item>
          <div className="mb-3 flex gap-4">
            <Form.Item name="showOnHome" valuePropName="checked" className="mb-0">
              <Checkbox>看板展示</Checkbox>
            </Form.Item>
            <Form.Item name="showOnTray" valuePropName="checked" className="mb-0">
              <Checkbox>
                系统菜单栏展示
                <span className="ml-1 text-xs font-normal text-gray-400">（仅影响菜单栏文字；点托盘弹窗始终展示全部启用供应商）</span>
              </Checkbox>
            </Form.Item>
          </div>
        </Form>
      </Modal>

      <CcImportModal open={importOpen} onClose={() => setImportOpen(false)} onImported={() => void load()} />

      {cliFor && (
        <CliConfigModal
          open
          tools={[]}
          seedProvider={cliFor}
          onCancel={() => setCliFor(null)}
        />
      )}
    </div>
  )
}
