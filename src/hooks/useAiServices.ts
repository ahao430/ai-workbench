import { useEffect, useState } from 'react'
import { providerRepo, type Provider } from '../db/providers'
import { isTauri } from '../api/ipc'

/** 可用 AI 服务：已保存供应商（key 唯一：pv-<id>） */
export interface AiService {
  key: string
  label: string
  /** Rust ServiceRef 载荷（密钥不出后端） */
  spec: Record<string, unknown>
  /** 线上协议（聊天统一 OpenAI；anthropic 供应商仅 CLI 用，聊天/画图中排除） */
  apiFormat: 'openai' | 'anthropic'
}

let cache: AiService[] | null = null
let inflight: Promise<AiService[]> | null = null
const listeners = new Set<(list: AiService[]) => void>()

async function fetchAll(): Promise<AiService[]> {
  const out: AiService[] = []
  for (const p of await providerRepo.list().catch(() => [] as Provider[])) {
    out.push({
      key: `pv-${p.id}`,
      label: p.name,
      spec: {
        kind: 'stored',
        baseUrl: p.baseUrl,
        secretRef: p.secretRef,
        label: p.name,
        apiFormat: p.kind,
      },
      apiFormat: p.kind === 'anthropic' ? 'anthropic' : 'openai',
    })
  }
  return out
}

/** 清缓存（供应商增删改后调用，下次挂载重拉） */
export function invalidateAiServices() {
  cache = null
  inflight = null
}

/** 确保 services 已加载（命令式场景用）；组件请用 useAiServices */
export function ensureAiServices(): Promise<AiService[]> {
  if (cache) return Promise.resolve(cache)
  inflight ??= fetchAll().then((list) => {
    cache = list
    listeners.forEach((l) => l(list))
    return list
  })
  return inflight
}

/** 共享服务列表（模块级缓存，跨页面/弹窗复用一次拉取） */
export function useAiServices(): { services: AiService[]; loading: boolean } {
  const [services, setServices] = useState<AiService[]>(cache ?? [])
  const [loading, setLoading] = useState(isTauri && !cache)

  useEffect(() => {
    if (!isTauri) return
    if (!cache) {
      void ensureAiServices().finally(() => setLoading(false))
    }
    const upd = (list: AiService[]) => setServices(list)
    listeners.add(upd)
    return () => {
      listeners.delete(upd)
    }
  }, [])

  return { services, loading }
}
