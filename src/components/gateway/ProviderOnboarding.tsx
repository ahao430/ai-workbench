import { useEffect, useState } from 'react'
import { App, Form, Input, Modal, Select } from 'antd'
import { ExternalLink, Plus } from 'lucide-react'
import { errText } from '../../lib/err'
import { secretPut } from '../../api/chat'
import { providerRepo, type Provider } from '../../db/providers'
import { PROVIDER_PRESETS, type ProviderPreset } from '../../lib/providerPresets'

interface FormValues {
  name: string
  baseUrl: string
  anthropicBaseUrl?: string
  apiKey: string
}

/** 预设分组：官方订阅 / 三方中转站 */
const OFFICIAL = PROVIDER_PRESETS.filter((p) => p.readonly)
const CUSTOM = PROVIDER_PRESETS.filter((p) => !p.readonly)

function PresetCard({ p, active, onClick }: { p: ProviderPreset; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start gap-1 rounded-xl border px-3.5 py-3 text-left transition-all ${
        active
          ? 'border-indigo-400 bg-indigo-50/70 shadow-sm dark:border-indigo-500/60 dark:bg-indigo-950/40'
          : 'border-gray-200 hover:border-indigo-300 dark:border-gray-700 dark:hover:border-indigo-500/50'
      }`}
    >
      <span className="text-sm font-medium">{p.name}</span>
      <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{p.desc}</span>
      {p.keyUrl && (
        <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-indigo-500">
          <ExternalLink size={11} />
          获取 API Key
        </span>
      )}
    </button>
  )
}

/**
 * 引导式 AI 渠道配置：选择官方订阅或三方中转站预设 → 填 baseUrl + API Key →
 * 存入供应商表（密钥入系统钥匙串）。完成后可继续添加或交还给向导。
 */
export default function ProviderOnboarding({ onDone }: { onDone?: () => void }) {
  const { message } = App.useApp()
  const [providers, setProviders] = useState<Provider[]>([])
  const [presetId, setPresetId] = useState(CUSTOM[0]?.id ?? 'custom-openai')
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<FormValues>()

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? CUSTOM[0]

  const load = () => {
    providerRepo
      .list()
      .then(setProviders)
      .catch(() => {})
  }
  useEffect(load, [])

  const pick = (p: ProviderPreset) => {
    setPresetId(p.id)
    form.setFieldsValue({ name: p.name, baseUrl: p.baseUrl, anthropicBaseUrl: '', apiKey: '' })
    setModalOpen(true)
  }

  const save = async (v: FormValues) => {
    setSaving(true)
    try {
      const id = crypto.randomUUID()
      const secretRef = `provider-${id}`
      await secretPut(secretRef, v.apiKey.trim())
      await providerRepo.create({
        id,
        name: v.name.trim(),
        baseUrl: v.baseUrl.trim(),
        anthropicBaseUrl: v.anthropicBaseUrl?.trim() || undefined,
        secretRef,
        kind: preset.kind,
        currency: preset.currency,
      })
      message.success('AI 渠道已保存')
      setModalOpen(false)
      load()
      onDone?.()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-sm font-bold text-white shadow-sm">
          AI
        </span>
        <span className="font-medium">配置一个 AI 渠道</span>
      </div>
      <p className="mb-4 text-xs text-gray-400">
        官方订阅（智谱 / DeepSeek / OpenAI / Claude）或三方中转站（OpenAI 兼容）皆可；密钥存本机系统钥匙串，不落明文。
        配置后 Chat、画图与 CLI 一键接入即可使用。
      </p>

      <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">三方中转站（OpenAI 兼容）</div>
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {CUSTOM.map((p) => (
          <PresetCard key={p.id} p={p} active={false} onClick={() => pick(p)} />
        ))}
      </div>

      <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">官方订阅</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {OFFICIAL.map((p) => (
          <PresetCard key={p.id} p={p} active={false} onClick={() => pick(p)} />
        ))}
      </div>

      {providers.length > 0 && (
        <div className="mt-4 rounded-xl border border-emerald-200/70 bg-emerald-50/60 px-3.5 py-2.5 text-xs dark:border-emerald-900/60 dark:bg-emerald-950/30">
          <div className="mb-1 font-medium text-emerald-700 dark:text-emerald-400">已配置 {providers.length} 个渠道</div>
          <div className="flex flex-wrap gap-1.5">
            {providers.map((p) => (
              <span key={p.id} className="rounded-full bg-white px-2.5 py-0.5 text-gray-600 shadow-sm dark:bg-white/10 dark:text-gray-300">
                {p.name}
              </span>
            ))}
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-2.5 py-0.5 text-gray-500 hover:border-indigo-400 hover:text-indigo-500 dark:border-gray-600"
              onClick={() => pick(preset)}
            >
              <Plus size={11} /> 再加一个
            </button>
          </div>
        </div>
      )}

      <Modal
        title="添加 AI 渠道"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={async () => void (await form.validateFields().then(save))}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" className="pt-1">
          <Form.Item label="渠道类型" className="mb-2">
            <Select
              value={presetId}
              onChange={(id) => {
                const p = PROVIDER_PRESETS.find((x) => x.id === id)!
                setPresetId(id)
                form.setFieldsValue({ name: p.name, baseUrl: p.baseUrl, anthropicBaseUrl: '', apiKey: '' })
              }}
              options={[
                { label: '三方中转站', options: CUSTOM.map((p) => ({ value: p.id, label: p.name })) },
                { label: '官方订阅', options: OFFICIAL.map((p) => ({ value: p.id, label: p.name })) },
              ]}
            />
            <div className="mt-1 text-xs text-gray-400">{preset.desc}</div>
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如 智谱 / 某中转站" />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label={preset.kind === 'anthropic' ? 'Anthropic 请求地址' : 'OpenAI 请求地址'}
            rules={[{ required: true, message: '请输入服务地址' }]}
            extra={preset.readonly ? '官方预设地址，不可修改' : '服务商给的接口地址，通常以 /v1 结尾'}
          >
            <Input disabled={preset.readonly} placeholder="https://…" />
          </Form.Item>
          {preset.kind === 'openai' && (
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
            label="API Key"
            rules={[{ required: true, message: '请输入 API Key' }]}
            extra={preset.keyUrl ? `没有 Key？前往 ${preset.keyUrl} 创建` : undefined}
          >
            <Input.Password placeholder="sk-..." autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
