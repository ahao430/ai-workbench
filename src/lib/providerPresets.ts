/** 供应商预设与常用服务常量 */

export type ProviderKind = 'openai' | 'anthropic'

/** 余额展示单位：USD($) / CNY(¥) */
export type CurrencyUnit = 'USD' | 'CNY'

export interface ProviderPreset {
  id: string
  name: string
  kind: ProviderKind
  /** 预设服务地址；custom 类留空由用户填 */
  baseUrl: string
  /** 地址是否需要用户填写 */
  needsBaseUrl: boolean
  /** 官方预设地址锁定不可修改 */
  readonly: boolean
  desc: string
  /** 可选：Anthropic 格式请求地址（自定义类由用户填写） */
  anthropicBaseUrl?: string
  /** API Key 获取页面（可选） */
  keyUrl?: string
  /** 余额默认展示单位（智谱国内/DeepSeek 为 ¥；GPT/Claude 官方为 $；网关类自选） */
  currency: CurrencyUnit
}

/** 第三方供应商预设（新增供应商时选择，自动填充名称/地址/协议） */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'custom-openai',
    name: '自定义（OpenAI 格式）',
    kind: 'openai',
    baseUrl: '',
    needsBaseUrl: true,
    readonly: false,
    currency: 'USD',
    desc: '任意 OpenAI 兼容服务（/v1/chat/completions）；可另填 Anthropic 地址供 Claude Code 使用',
  },
  {
    id: 'custom-newapi',
    name: '自定义（NewAPI / OneAPI 网关）',
    kind: 'openai',
    baseUrl: '',
    needsBaseUrl: true,
    readonly: false,
    currency: 'USD',
    desc: 'NewAPI 类聚合网关（OpenAI 兼容）；另配 Anthropic 分域地址可一并提供',
  },
  {
    id: 'zhipu',
    name: '智谱 AI（官方）',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    needsBaseUrl: false,
    readonly: true,
    currency: 'CNY',
    desc: 'GLM 系列模型',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek（官方）',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com',
    needsBaseUrl: false,
    readonly: true,
    currency: 'CNY',
    desc: 'DeepSeek-V3 / R1 系列（聊天走 OpenAI 端口）',
    anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    name: 'GPT（OpenAI 官方）',
    kind: 'openai',
    baseUrl: 'https://api.openai.com',
    needsBaseUrl: false,
    readonly: true,
    currency: 'USD',
    desc: 'GPT-4o / o 系列等',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'claude',
    name: 'Claude（Anthropic 官方）',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    needsBaseUrl: false,
    readonly: true,
    currency: 'USD',
    desc: 'Claude 系列模型（Anthropic Messages 协议）',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
]

/** 未显式存过单位时的推断：智谱国内 / DeepSeek 平台余额为人民币，其余（含网关）按美元 */
export function inferCurrency(p: { name: string; baseUrl?: string }): CurrencyUnit {
  const s = `${p.name} ${p.baseUrl ?? ''}`.toLowerCase()
  if (s.includes('bigmodel') || s.includes('zhipu') || s.includes('智谱')) return 'CNY'
  if (s.includes('deepseek')) return 'CNY'
  return 'USD'
}
