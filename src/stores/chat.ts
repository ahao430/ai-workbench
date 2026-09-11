import { create } from 'zustand'
import { errText } from '../lib/err'
import {
  cancelChat,
  chatSend,
  listModels,
  toServiceRef,
  type ChatEvent,
  type ServiceSnapshot,
} from '../api/chat'
import { messageRepo, parseService, sessionRepo, type KbRefLite, type MessageRow, type SessionRow } from '../db/chats'
import { providerRepo, type Provider } from '../db/providers'
import { assistantRepo, type Assistant } from '../db/assistants'

export interface ChatMessage extends Pick<MessageRow, 'id' | 'role' | 'content' | 'reasoning' | 'images' | 'model' | 'kb_refs' | 'created_at'> {
  streaming?: boolean
  error?: string
}

/** 服务选项：已保存供应商 */
export interface ServiceOption {
  key: string
  snapshot: ServiceSnapshot
}

interface ChatState {
  ready: boolean
  blocked: string | null
  sessions: SessionRow[]
  currentId: string | null
  messages: Record<string, ChatMessage[]>
  providers: Provider[]
  assistants: Assistant[]
  models: Record<string, string[]>
  modelsLoading: Record<string, boolean>
  streamingTaskId: string | null
  /** 每会话的输入草稿（切菜单不丢） */
  drafts: Record<string, string>
  init: () => Promise<void>
  refreshServices: () => Promise<void>
  refreshAssistants: () => Promise<void>
  ensureModels: (opt: ServiceOption) => Promise<void>
  newSession: (opt: ServiceOption, model: string, assistantId?: string | null) => Promise<void>
  openSession: (id: string) => Promise<void>
  removeSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  resetContext: (id: string) => Promise<void>
  setAssistant: (id: string, assistantId: string | null) => Promise<void>
  setDraft: (id: string | null, text: string) => void
  /** 会话内切换供应商/模型（联动，保留历史） */
  setSessionService: (id: string, serviceJson: string, model: string) => void
  /** 会话级知识库开关与多选（entryIds 空 = 全部已启用条目） */
  setSessionKb: (id: string, enabled: boolean, entryIds: string[]) => void
  send: (text: string, wireContent?: string, kbRefs?: KbRefLite[]) => Promise<void>
  stop: () => Promise<void>
}

function uid(): string {
  return crypto.randomUUID()
}

export const useChatStore = create<ChatState>((set, get) => ({
  ready: false,
  blocked: null,
  sessions: [],
  currentId: null,
  messages: {},
  providers: [],
  assistants: [],
  models: {},
  modelsLoading: {},
  streamingTaskId: null,
  drafts: {},

  init: async () => {
    try {
      await Promise.all([get().refreshServices(), get().refreshAssistants()])
      const sessions = await sessionRepo.list()
      set({ sessions, ready: true, blocked: null })
      if (sessions[0]) await get().openSession(sessions[0].id)
    } catch (e) {
      // 非 Tauri 环境（浏览器预览）下 db 不可用
      set({ blocked: errText(e), ready: true })
    }
  },

  refreshServices: async () => {
    const providers = await providerRepo.list()
    set({ providers })
  },

  refreshAssistants: async () => {
    const assistants = await assistantRepo.list()
    set({ assistants })
  },

  ensureModels: async (opt) => {
    const key = opt.key
    if (get().models[key] || get().modelsLoading[key]) return
    set((s) => ({ modelsLoading: { ...s.modelsLoading, [key]: true } }))
    try {
      const ids = await listModels(toServiceRef(opt.snapshot))
      set((s) => ({ models: { ...s.models, [key]: ids } }))
      // 供应商场景缓存到库，供画图页复用
      if (opt.snapshot.kind === 'provider' && opt.snapshot.providerId) {
        await providerRepo.setModels(opt.snapshot.providerId, ids).catch(() => {})
      }
    } catch {
      set((s) => ({ models: { ...s.models, [key]: [] } }))
    } finally {
      set((s) => ({ modelsLoading: { ...s.modelsLoading, [key]: false } }))
    }
  },

  newSession: async (opt, model, assistantId) => {
    const row = await sessionRepo.create({ id: uid(), title: '新会话', service: opt.snapshot, model, assistantId })
    set((s) => ({
      sessions: [row, ...s.sessions],
      currentId: row.id,
      messages: { ...s.messages, [row.id]: [] },
    }))
  },

  openSession: async (id) => {
    set({ currentId: id })
    if (get().messages[id]) return
    const rows = await messageRepo.listBySession(id)
    set((s) => ({ messages: { ...s.messages, [id]: rows.map((r) => ({ ...r, images: r.images })) } }))
  },

  removeSession: async (id) => {
    await sessionRepo.remove(id)
    set((s) => {
      const messages = { ...s.messages }
      delete messages[id]
      const sessions = s.sessions.filter((x) => x.id !== id)
      return { sessions, messages, currentId: s.currentId === id ? (sessions[0]?.id ?? null) : s.currentId }
    })
    const cur = get().currentId
    if (cur) await get().openSession(cur)
  },

  renameSession: async (id, title) => {
    await sessionRepo.rename(id, title)
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)) }))
  },

  resetContext: async (id) => {
    const msgs = get().messages[id] ?? []
    const last = msgs[msgs.length - 1]
    await sessionRepo.setContextReset(id, last?.id ?? null)
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, context_reset_id: last?.id ?? null } : x)) }))
  },

  setAssistant: async (id, assistantId) => {
    await sessionRepo.setAssistant(id, assistantId)
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, assistant_id: assistantId } : x)) }))
  },

  setDraft: (id, text) => {
    if (!id) return
    set((s) => ({ drafts: { ...s.drafts, [id]: text } }))
  },

  setSessionService: (id, serviceJson, model) => {
    void sessionRepo.setService(id, JSON.parse(serviceJson), model)
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, service_json: serviceJson, model } : x)),
    }))
  },

  /** 会话级知识库开关与多选（entryIds 空 = 全部已启用条目） */
  setSessionKb: (id, enabled, entryIds) => {
    void sessionRepo.setKb(id, enabled, entryIds)
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, kb_enabled: enabled ? 1 : 0, kb_entry_ids: JSON.stringify(entryIds) } : x,
      ),
    }))
  },

  /** 发送消息。wireContent 为实际上行内容（如知识库引用注入后的版本），缺省等于 text；
   *  kbRefs 为本次注入的知识库来源（存用户消息，界面展示「引用来源」） */
  send: async (text, wireContent, kbRefs) => {
    const id = get().currentId
    const session = get().sessions.find((x) => x.id === id)
    if (!id || !session || get().streamingTaskId) return
    const trimmed = text.trim()
    if (!trimmed) return

    const snapshot = parseService(session)
    const spec = toServiceRef(snapshot)
    // 模型兜底：新会话可能没选过模型，空 model 会被上游拒绝（DeepSeek 等直接 400）。
    // 顺序：会话已选 → 上次默认（aw-chat-last） → 该服务首个可用模型；都没有则明确报错。
    const serviceKey =
      `pv-${(snapshot as { providerId?: string }).providerId}`
    let model = session.model
    if (!model) {
      try {
        model = (JSON.parse(localStorage.getItem('aw-chat-last') ?? '{}') as { model?: string }).model ?? ''
      } catch {
        model = ''
      }
    }
    if (!model) {
      await get().ensureModels({ key: serviceKey, snapshot })
      model = get().models[serviceKey]?.[0] ?? ''
    }
    if (!model) {
      set((s) => ({
        messages: {
          ...s.messages,
          [id]: [...(s.messages[id] ?? []), { id: uid(), role: 'assistant', content: '', reasoning: '', images: '[]', model: '', kb_refs: '[]', created_at: Date.now(), streaming: false, error: '请先在会话设置行选择模型' } as ChatMessage],
        },
      }))
      return
    }
    if (model !== session.model) void get().setSessionService(id, session.service_json, model)

    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: trimmed,
      reasoning: '',
      images: '[]',
      model: '',
      kb_refs: kbRefs?.length ? JSON.stringify(kbRefs) : '[]',
      created_at: Date.now(),
    }
    const asstId = uid()
    const asstMsg: ChatMessage = {
      id: asstId,
      role: 'assistant',
      content: '',
      reasoning: '',
      images: '[]',
      model,
      created_at: Date.now() + 1,
      streaming: true,
    }
    set((s) => ({
      messages: { ...s.messages, [id]: [...(s.messages[id] ?? []), userMsg, asstMsg] },
    }))
    // 用户输入立即落库——即使流式失败也不丢
    await messageRepo.add({
      id: userMsg.id,
      session_id: id,
      role: 'user',
      content: trimmed,
      reasoning: '',
      images: '[]',
      model: '',
      kb_refs: userMsg.kb_refs,
    })
    if (session.title === '新会话') void get().renameSession(id, trimmed.slice(0, 24))

    // 组装上下文：尊重「从这里开始新的上下文」截断点
    const all = get().messages[id] ?? []
    const resetIdx = session.context_reset_id ? all.findIndex((m) => m.id === session.context_reset_id) : -1
    const history = (resetIdx >= 0 ? all.slice(resetIdx + 1) : all).filter((m) => !m.error && !m.streaming)
    const payload: { role: 'system' | 'user' | 'assistant'; content: string }[] = history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))
    // 助手 system prompt 注入（首条）
    const assistant = session.assistant_id
      ? get().assistants.find((a) => a.id === session.assistant_id)
      : undefined
    if (assistant?.systemPrompt) {
      payload.unshift({ role: 'system', content: assistant.systemPrompt })
    }
    // 末条 user 消息用上行内容（知识库注入后），历史仍按原样
    if (payload.length > 0 && wireContent && wireContent !== trimmed) {
      payload[payload.length - 1] = { role: 'user', content: wireContent }
    }

    const taskId = uid()
    set({ streamingTaskId: taskId })
    let content = ''
    let reasoning = ''

    try {
      await chatSend(
        { spec, taskId, model, messages: payload },
        (e: ChatEvent) => {
          if (e.type === 'delta') {
            content += e.text
          } else if (e.type === 'reasoning') {
            reasoning += e.text
          } else if (e.type === 'error') {
            set((s) => ({
              messages: {
                ...s.messages,
                [id]: (s.messages[id] ?? []).map((m) => (m.id === asstId ? { ...m, streaming: false, error: e.message } : m)),
              },
            }))
          }
          if (e.type === 'delta' || e.type === 'reasoning') {
            set((s) => ({
              messages: {
                ...s.messages,
                [id]: (s.messages[id] ?? []).map((m) => (m.id === asstId ? { ...m, content, reasoning } : m)),
              },
            }))
          }
        },
      )
      // assistant 落库（含取消：保留已生成部分）；用户消息已先行落库
      if (content || reasoning) {
        await messageRepo.add({
          id: asstId,
          session_id: id,
          role: 'assistant',
          content,
          reasoning,
          images: '[]',
          model: session.model,
        })
        await sessionRepo.touch(id)
      } else {
        await messageRepo.remove(asstId)
        set((s) => ({ messages: { ...s.messages, [id]: (s.messages[id] ?? []).filter((m) => m.id !== asstId) } }))
      }
    } catch (e) {
      set((s) => ({
        messages: {
          ...s.messages,
          [id]: (s.messages[id] ?? []).map((m) => (m.id === asstId ? { ...m, streaming: false, error: errText(e) } : m)),
        },
      }))
    } finally {
      set((s) => ({
        streamingTaskId: null,
        messages: {
          ...s.messages,
          [id]: (s.messages[id] ?? []).map((m) => (m.id === asstId ? { ...m, streaming: false } : m)),
        },
      }))
    }
  },

  stop: async () => {
    const t = get().streamingTaskId
    if (t) await cancelChat(t)
  },
}))
