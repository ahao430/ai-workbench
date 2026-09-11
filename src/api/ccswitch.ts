import { call } from './ipc'
import type { ProviderKind } from '../lib/providerPresets'

/** cc-switch 数据库路径（未安装返回 null） */
export function ccswitchDbPath(): Promise<string | null> {
  return call<string | null>('ccswitch_db_path')
}

export interface CcEntry {
  appType: 'claude' | 'codex' | 'gemini'
  name: string
  baseUrl: string
  apiKey: string
  model?: string
  isCurrent: boolean
}

export interface CcImportItem {
  /** 组键（归一化 host） */
  key: string
  name: string
  kind: ProviderKind
  baseUrl: string
  anthropicBaseUrl?: string
  apiKey: string
  model?: string
  sources: string[]
  isCurrent: boolean
  exists?: boolean
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** 域名归一：去 "-anthropic" 段（xxx-anthropic.your-host.cn ≡ xxx.your-host.cn） */
function normalizeHost(url: string): string {
  return hostOf(url).replaceAll('-anthropic', '')
}

/** 官方服务的 Anthropic 端口 → OpenAI 端口映射（这类服务双协议，导入为双地址） */
const OFFICIAL_ANTHROPIC_PORTS: Record<string, string> = {
  'api.deepseek.com/anthropic': 'https://api.deepseek.com',
  'open.bigmodel.cn/api/anthropic': 'https://open.bigmodel.cn/api/paas/v4',
}

/** 若地址是已知官方 Anthropic 端口，返回对应 OpenAI 端口（转双地址用） */
function officialOpenAiPort(anthropicUrl: string): string | undefined {
  const norm = anthropicUrl.replace(/\/+$/, '')
  return OFFICIAL_ANTHROPIC_PORTS[norm.replace(/^https?:\/\//, '')]
}

function parseTomlField(toml: string, key: string): string | undefined {
  const re = new RegExp(key + '\\s*=\\s*"([^"\\n]+)"')
  const m = re.exec(toml)
  return m?.[1]
}

/** 解析 cc-switch providers 表行 → 标准条目（无法解析返回 null） */
export function parseCcRow(
  appType: string,
  name: string,
  settingsConfig: string,
  isCurrent: boolean,
): CcEntry | null {
  if (appType !== 'claude' && appType !== 'codex') return null
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(settingsConfig) as Record<string, unknown>
  } catch {
    return null
  }
  if (appType === 'claude') {
    const env = (cfg.env ?? {}) as Record<string, string>
    const baseUrl = env.ANTHROPIC_BASE_URL
    const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY
    if (!baseUrl || !apiKey) return null
    return {
      appType: 'claude',
      name,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey,
      model: env.ANTHROPIC_MODEL || undefined,
      isCurrent,
    }
  }
  // codex：auth.OPENAI_API_KEY 或 TOML 内 experimental_bearer_token；base_url 在 TOML
  const auth = (cfg.auth ?? {}) as Record<string, string>
  const toml = (cfg.config as string) ?? ''
  const baseUrl = parseTomlField(toml, 'base_url')
  let apiKey = auth.OPENAI_API_KEY || ''
  if (!apiKey) apiKey = parseTomlField(toml, 'experimental_bearer_token') ?? ''
  if (!baseUrl || !apiKey) return null
  return {
    appType: 'codex',
    name,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model: parseTomlField(toml, 'model'),
    isCurrent,
  }
}

/** claude/codex 条目按归一化域名合并：双地址合一，只有 anthropic 时 kind=anthropic */
export function mergeCcEntries(entries: CcEntry[]): CcImportItem[] {
  const groups = new Map<string, CcEntry[]>()
  for (const e of entries) {
    const key = normalizeHost(e.baseUrl)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }
  const items: CcImportItem[] = []
  for (const [key, list] of groups) {
    const claude = list.find((e) => e.appType === 'claude')
    const codex = list.find((e) => e.appType === 'codex')
    const base = codex ?? claude!
    // 仅 claude 条目但命中官方双协议端口 → 转官方双地址（OpenAI 主 + Anthropic 辅）
    const officialOpenAi = !codex && claude ? officialOpenAiPort(claude.baseUrl) : undefined
    if (officialOpenAi) {
      items.push({
        key,
        name: claude!.name,
        kind: 'openai',
        baseUrl: officialOpenAi,
        anthropicBaseUrl: claude!.baseUrl,
        apiKey: claude!.apiKey,
        model: claude!.model,
        sources: list.map((e) => e.appType),
        isCurrent: list.some((e) => e.isCurrent),
      })
      continue
    }
    items.push({
      key,
      name: base.name,
      kind: codex ? 'openai' : 'anthropic',
      baseUrl: base.baseUrl,
      anthropicBaseUrl: claude && codex ? claude.baseUrl : undefined,
      apiKey: base.apiKey,
      model: base.model,
      sources: list.map((e) => e.appType),
      isCurrent: list.some((e) => e.isCurrent),
    })
  }
  return items.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name))
}
