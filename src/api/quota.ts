import { call } from './ipc'

export interface QuotaLimit {
  kind: 'TOKENS_LIMIT' | 'TIME_LIMIT' | string
  label: string
  percentage: number
  nextResetAt: number
}

export interface QuotaResult {
  ok: boolean
  text: string
  /** 订阅型额度的分项（智谱 Coding Plan 的 5 小时/月窗口） */
  limits: QuotaLimit[]
}

/** 查询供应商额度（quotaType: deepseek | newapi | zhipu-coding） */
export function quotaCheck(args: {
  baseUrl: string
  quotaType: string
  secretRef: string
  anthropicBaseUrl?: string
  /** 余额展示单位 USD | CNY（缺省按服务默认） */
  currency?: string
}): Promise<QuotaResult> {
  return call<QuotaResult>('quota_check', args)
}
