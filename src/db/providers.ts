import { call } from '../api/ipc'
import { getDb } from '../db'
import type { ProviderKind } from '../lib/providerPresets'

export interface Provider {
  id: string
  name: string
  baseUrl: string
  /** 可选 Anthropic 格式请求地址（Claude Code 等使用） */
  anthropicBaseUrl: string
  secretRef: string
  enabled: number
  createdAt: number
  /** openai（默认）| anthropic */
  kind: ProviderKind
  /** 额度查询方式：''=不查询 | deepseek | newapi */
  quotaType: string
  showOnHome: number
  showOnTray: number
  /** 余额展示单位：''=按预设推断 | USD | CNY */
  currency: string
}

function rowToProvider(r: Record<string, unknown>): Provider {
  return {
    id: r.id as string,
    name: r.name as string,
    baseUrl: r.base_url as string,
    anthropicBaseUrl: (r.anthropic_base_url as string) || '',
    secretRef: r.secret_ref as string,
    enabled: (r.enabled as number) || 1,
    createdAt: r.created_at as number,
    kind: ((r.kind as string) === 'anthropic' ? 'anthropic' : 'openai') as ProviderKind,
    quotaType: (r.quota_type as string) || '',
    showOnHome: (r.show_on_home as number) || 0,
    showOnTray: (r.show_on_tray as number) || 0,
    currency: (r.currency as string) || '',
  }
}

export const providerRepo = {
  async list(): Promise<Provider[]> {
    const db = await getDb()
    const rows = await db.select<Record<string, unknown>[]>('SELECT * FROM providers ORDER BY created_at DESC')
    return rows.map(rowToProvider)
  },
  async create(p: {
    id: string
    name: string
    baseUrl: string
    anthropicBaseUrl?: string
    secretRef: string
    kind: ProviderKind
    currency?: string
  }): Promise<void> {
    const db = await getDb()
    await db.execute(
      'INSERT INTO providers (id, name, base_url, anthropic_base_url, secret_ref, enabled, created_at, kind, currency) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8)',
      [p.id, p.name, p.baseUrl, p.anthropicBaseUrl ?? '', p.secretRef, Date.now(), p.kind, p.currency ?? ''],
    )
  },
  async update(p: Pick<Provider, 'id' | 'name' | 'baseUrl' | 'anthropicBaseUrl'> & Partial<Pick<Provider, 'quotaType' | 'showOnHome' | 'showOnTray' | 'currency'>>): Promise<void> {
    const db = await getDb()
    await db.execute('UPDATE providers SET name = $1, base_url = $2, anthropic_base_url = $3, currency = $4 WHERE id = $5', [
      p.name,
      p.baseUrl,
      p.anthropicBaseUrl ?? '',
      p.currency ?? '',
      p.id,
    ])
    if (p.quotaType !== undefined) {
      await db.execute('UPDATE providers SET quota_type = $1, show_on_home = $2, show_on_tray = $3 WHERE id = $4', [
        p.quotaType,
        p.showOnHome ?? 0,
        p.showOnTray ?? 0,
        p.id,
      ])
    }
  },
  async remove(id: string): Promise<void> {
    const db = await getDb()
    const rows = await db.select<{ secret_ref: string }[]>('SELECT secret_ref FROM providers WHERE id = $1', [id])
    if (rows[0]) await call<void>('secret_remove', { account: rows[0].secret_ref }).catch(() => {})
    await db.execute('DELETE FROM providers WHERE id = $1', [id])
    await db.execute('DELETE FROM provider_models WHERE provider_id = $1', [id])
    await db.execute('DELETE FROM model_capabilities WHERE provider_id = $1', [id])
  },
  async setModels(providerId: string, modelIds: string[]): Promise<void> {
    const db = await getDb()
    await db.execute('DELETE FROM provider_models WHERE provider_id = $1', [providerId])
    const now = Date.now()
    for (const m of modelIds) {
      await db.execute('INSERT OR REPLACE INTO provider_models (provider_id, model_id, fetched_at) VALUES ($1,$2,$3)', [
        providerId,
        m,
        now,
      ])
    }
  },
  async models(providerId: string): Promise<string[]> {
    const db = await getDb()
    const rows = await db.select<{ model_id: string }[]>('SELECT model_id FROM provider_models WHERE provider_id = $1', [providerId])
    return rows.map((r) => r.model_id)
  },
}

export type ImageCallMode = 'images' | 'chat'

/** 用户对模型能力的覆盖（三态：null = 自动跟随正则） */
export interface CapabilityOverride {
  imageCallMode: ImageCallMode | null
  imageEnabled: boolean | null
}

export const capabilityRepo = {
  async get(providerKey: string, modelId: string): Promise<CapabilityOverride | null> {
    const db = await getDb()
    const rows = await db.select<{ image_call_mode: string | null; image_enabled: number | null }[]>(
      'SELECT image_call_mode, image_enabled FROM model_capabilities WHERE provider_id = $1 AND model_id = $2',
      [providerKey, modelId],
    )
    const r = rows[0]
    if (!r) return null
    return {
      imageCallMode: (r.image_call_mode as ImageCallMode | null) ?? null,
      imageEnabled: r.image_enabled === null ? null : r.image_enabled === 1,
    }
  },
  async setImage(providerKey: string, modelId: string, mode: ImageCallMode | null, enabled: boolean | null): Promise<void> {
    const db = await getDb()
    await db.execute(
      `INSERT INTO model_capabilities (provider_id, model_id, image_call_mode, image_enabled)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider_id, model_id) DO UPDATE SET image_call_mode = $3, image_enabled = $4`,
      [providerKey, modelId, mode, enabled === null ? null : enabled ? 1 : 0],
    )
  },
}

export interface Draw {
  id: string
  sessionId: string
  providerKey: string
  model: string
  prompt: string
  size: string
  /** 参考图路径数组 JSON */
  refs: string
  images: string
  createdAt: number
}

export const drawRepo = {
  async add(d: Omit<Draw, 'createdAt'>): Promise<void> {
    const db = await getDb()
    await db.execute(
      'INSERT INTO draws (id, session_id, provider_key, model, prompt, size, refs, images, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        d.id,
        d.sessionId,
        d.providerKey,
        d.model,
        d.prompt,
        d.size,
        d.refs,
        d.images,
        Date.now(),
      ],
    )
  },
  async list(limit = 60): Promise<Draw[]> {
    const db = await getDb()
    return db.select<Draw[]>('SELECT * FROM draws ORDER BY created_at DESC LIMIT $1', [limit])
  },
  async listBySession(sessionId: string): Promise<Draw[]> {
    const db = await getDb()
    return db.select<Draw[]>(
      'SELECT * FROM draws WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId],
    )
  },
}

export interface DrawSession {
  id: string
  title: string
  providerKey: string
  model: string
  /** 提示词模板（生成时前置拼接） */
  template: string
  kbEnabled: number
  kb_entry_ids?: string
  webEnabled: number
  createdAt: number
  updatedAt: number
}

export const drawSessionRepo = {
  async list(): Promise<DrawSession[]> {
    const db = await getDb()
    return db.select<DrawSession[]>('SELECT * FROM draw_sessions ORDER BY updated_at DESC')
  },
  async get(id: string): Promise<DrawSession | null> {
    const db = await getDb()
    const r = await db.select<DrawSession[]>('SELECT * FROM draw_sessions WHERE id = $1', [id])
    return r[0] ?? null
  },
  async create(title = '新画图会话'): Promise<DrawSession> {
    const db = await getDb()
    const s: DrawSession = {
      id: crypto.randomUUID(),
      title,
      providerKey: '',
      model: '',
      template: '',
      kbEnabled: 0,
      kb_entry_ids: '[]',
      webEnabled: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await db.execute(
      'INSERT INTO draw_sessions (id, title, provider_key, model, template, kb_enabled, kb_entry_ids, web_enabled, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [s.id, s.title, s.providerKey, s.model, s.template, s.kbEnabled, s.kb_entry_ids, s.webEnabled, s.createdAt, s.updatedAt],
    )
    return s
  },
  async update(id: string, patch: Partial<Omit<DrawSession, 'id' | 'createdAt'>>): Promise<void> {
    const cur = await drawSessionRepo.get(id)
    if (!cur) return
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    const db = await getDb()
    await db.execute(
      'UPDATE draw_sessions SET title=$2, provider_key=$3, model=$4, template=$5, kb_enabled=$6, kb_entry_ids=$7, web_enabled=$8, updated_at=$9 WHERE id=$1',
      [id, next.title, next.providerKey, next.model, next.template, next.kbEnabled, next.kb_entry_ids ?? '[]', next.webEnabled, next.updatedAt],
    )
  },
  async touch(id: string): Promise<void> {
    const db = await getDb()
    await db.execute('UPDATE draw_sessions SET updated_at=$2 WHERE id=$1', [id, Date.now()])
  },
  async remove(id: string): Promise<void> {
    const db = await getDb()
    await db.execute('DELETE FROM draws WHERE session_id = $1', [id])
    await db.execute('DELETE FROM draw_sessions WHERE id = $1', [id])
  },
}
