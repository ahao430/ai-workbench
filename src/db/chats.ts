import { getDb } from '../db'
import type { ServiceSnapshot } from '../api/chat'

export interface SessionRow {
  id: string
  title: string
  service_json: string
  model: string
  context_reset_id: string | null
  assistant_id: string | null
  /** 会话级知识库开关（旧库默认 0） */
  kb_enabled?: number
  /** 会话级知识库多选（JSON 数组，存 kb 条目 id；空 = 全部已启用条目） */
  kb_entry_ids?: string
  created_at: number
  updated_at: number
}

/** 解析会话的知识库多选；空数组 = 未选择（检索全部已启用条目） */
export function parseKbEntryIds(row: Pick<SessionRow, 'kb_entry_ids'>): string[] {
  try {
    const v = JSON.parse(row.kb_entry_ids ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export interface MessageRow {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning: string
  images: string
  model: string
  /** 知识库引用来源（JSON 数组，仅用户消息；空数组 = 无） */
  kb_refs?: string
  created_at: number
}

/** 用户消息携带的知识库引用来源（发送时检索到的 chunk 元信息） */
export interface KbRefLite {
  title?: string | null
  source?: string | null
  kbName?: string | null
  score?: number | null
  /** 知识库在服务商 Web 端的页面链接（weknora 可拼；旧数据无此字段） */
  url?: string | null
}

export function parseKbRefs(row: Pick<MessageRow, 'kb_refs'>): KbRefLite[] {
  try {
    const v = JSON.parse(row.kb_refs ?? '[]')
    return Array.isArray(v) ? (v as KbRefLite[]) : []
  } catch {
    return []
  }
}

export function parseService(row: Pick<SessionRow, 'service_json'>): ServiceSnapshot {
  return JSON.parse(row.service_json) as ServiceSnapshot
}

export const sessionRepo = {
  async list(): Promise<SessionRow[]> {
    const db = await getDb()
    return db.select<SessionRow[]>('SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT 200')
  },
  async create(s: { id: string; title: string; service: ServiceSnapshot; model: string; assistantId?: string | null }): Promise<SessionRow> {
    const db = await getDb()
    const now = Date.now()
    await db.execute(
      'INSERT INTO chat_sessions (id, title, service_json, model, context_reset_id, assistant_id, created_at, updated_at) VALUES ($1,$2,$3,$4,NULL,$5,$6,$6)',
      [s.id, s.title, JSON.stringify(s.service), s.model, s.assistantId ?? null, now],
    )
    return {
      id: s.id,
      title: s.title,
      service_json: JSON.stringify(s.service),
      model: s.model,
      context_reset_id: null,
      assistant_id: s.assistantId ?? null,
      created_at: now,
      updated_at: now,
    }
  },
  async rename(id: string, title: string): Promise<void> {
    const db = await getDb()
    await db.execute('UPDATE chat_sessions SET title = $1 WHERE id = $2', [title, id])
  },
  async touch(id: string): Promise<void> {
    const db = await getDb()
    await db.execute('UPDATE chat_sessions SET updated_at = $1 WHERE id = $2', [Date.now(), id])
  },
  async setContextReset(id: string, messageId: string | null): Promise<void> {
    const db = await getDb()
    await db.execute('UPDATE chat_sessions SET context_reset_id = $1 WHERE id = $2', [messageId, id])
  },
  async setAssistant(id: string, assistantId: string | null): Promise<void> {
    const db = await getDb()
    await db.execute('UPDATE chat_sessions SET assistant_id = $1 WHERE id = $2', [assistantId, id])
  },
  /** 会话内切换供应商+模型（二级联动，保留会话与历史） */
  async setService(id: string, service: ServiceSnapshot, model: string): Promise<void> {
    const db = await getDb()
    await db.execute('UPDATE chat_sessions SET service_json = $1, model = $2 WHERE id = $3', [
      JSON.stringify(service),
      model,
      id,
    ])
  },
  /** 会话级知识库开关与多选（entryIds 空 = 检索全部已启用条目） */
  async setKb(id: string, enabled: boolean, entryIds: string[]): Promise<void> {
    const db = await getDb()
    await db.execute('UPDATE chat_sessions SET kb_enabled = $1, kb_entry_ids = $2 WHERE id = $3', [
      enabled ? 1 : 0,
      JSON.stringify(entryIds),
      id,
    ])
  },
  async remove(id: string): Promise<void> {
    const db = await getDb()
    await db.execute('DELETE FROM messages_tmp WHERE session_id = $1', [id]).catch(() => {})
    await db.execute('DELETE FROM chat_messages WHERE session_id = $1', [id])
    await db.execute('DELETE FROM chat_sessions WHERE id = $1', [id])
  },
}

export const messageRepo = {
  async listBySession(sessionId: string): Promise<MessageRow[]> {
    const db = await getDb()
    return db.select<MessageRow[]>('SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC', [sessionId])
  },
  async add(m: Omit<MessageRow, 'created_at'>): Promise<MessageRow> {
    const db = await getDb()
    const created = Date.now()
    await db.execute(
      'INSERT INTO chat_messages (id, session_id, role, content, reasoning, images, model, kb_refs, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [m.id, m.session_id, m.role, m.content, m.reasoning, m.images, m.model, m.kb_refs ?? '[]', created],
    )
    return { ...m, created_at: created }
  },
  async updateContent(id: string, content: string, reasoning: string): Promise<void> {
    const db = await getDb()
    await db.execute('UPDATE chat_messages SET content = $1, reasoning = $2 WHERE id = $3', [content, reasoning, id])
  },
  async remove(id: string): Promise<void> {
    const db = await getDb()
    await db.execute('DELETE FROM chat_messages WHERE id = $1', [id])
  },
}
