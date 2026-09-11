import { useEffect, useMemo } from 'react'
import { useChatStore, type ServiceOption } from '../stores/chat'

/** 服务选项 = 已保存供应商（Chat 页与流程图 AI 画图共用） */
export function useServiceOptions(): { options: ServiceOption[]; loading: boolean } {
  const providers = useChatStore((s) => s.providers)
  const refreshServices = useChatStore((s) => s.refreshServices)

  // store 未初始化（没进过 Chat 页）时补拉供应商列表
  useEffect(() => {
    void refreshServices().catch(() => {})
  }, [refreshServices])

  return {
    loading: false,
    options: useMemo(
      () => [
        ...providers.map((p) => ({
          key: `pv-${p.id}`,
          snapshot: {
            kind: 'provider' as const,
            providerId: p.id,
            baseUrl: p.baseUrl,
            secretRef: p.secretRef,
            label: p.name,
            apiFormat: p.kind,
            anthropicBaseUrl: p.anthropicBaseUrl || undefined,
          },
        })),
      ],
      [providers],
    ),
  }
}
