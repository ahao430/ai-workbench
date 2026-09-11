import { useEffect, useRef } from 'react'
import { quotaCheck, type QuotaResult } from '../api/quota'
import { isTauri } from '../api/ipc'
import type { Provider } from '../db/providers'

/** 并发拉取一组供应商的额度（只查配置了 quotaType 的）；单个失败不阻塞其他 */
export async function fetchProviderQuotas(
  list: Provider[],
): Promise<Record<string, QuotaResult>> {
  const out: Record<string, QuotaResult> = {}
  await Promise.all(
    list
      .filter((p) => p.quotaType)
      .map(async (p) => {
        try {
          out[p.id] = await quotaCheck({
            baseUrl: p.baseUrl,
            quotaType: p.quotaType,
            secretRef: p.secretRef,
            anthropicBaseUrl: p.anthropicBaseUrl || undefined,
            currency: p.currency || undefined,
          })
        } catch {
          out[p.id] = { ok: false, text: '查询失败', limits: [] }
        }
      }),
  )
  return out
}

/**
 * 按全局间隔（秒）周期调用 fn；不负责首次加载（由调用方的数据 effect 处理）。
 * intervalSec <= 0 表示关闭自动刷新。fn 身份变化不重置定时器。
 */
export function useQuotaAutoRefresh(intervalSec: number, fn: () => void) {
  const saved = useRef(fn)
  useEffect(() => {
    saved.current = fn
  })
  useEffect(() => {
    if (!isTauri || intervalSec < 5) return
    const t = setInterval(() => saved.current(), intervalSec * 1000)
    return () => clearInterval(t)
  }, [intervalSec])
}
