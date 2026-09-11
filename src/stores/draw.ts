import { create } from 'zustand'
import { drawRepo, drawSessionRepo, type Draw, type DrawSession } from '../db/providers'

/** 会话级草稿：提示词 + 参考图（生成前的临时状态，跨页面导航保留） */
interface Draft {
  prompt: string
  refs: string[]
}

interface DrawState {
  ready: boolean
  sessions: DrawSession[]
  currentId: string | null
  history: Record<string, Draw[]>
  drafts: Record<string, Draft>
  size: string
  count: number
  generating: boolean
  init: () => Promise<void>
  openSession: (id: string) => Promise<void>
  newSession: () => Promise<DrawSession | null>
  removeSession: (id: string) => Promise<void>
  patchSession: (id: string, patch: Partial<Omit<DrawSession, 'id' | 'createdAt'>>) => Promise<void>
  /** 会话级知识库：开关 + 检索范围（entryIds 空 = 全部已启用条目） */
  setSessionKb: (id: string, enabled: boolean, entryIds: string[]) => Promise<void>
  setDraft: (id: string, patch: Partial<Draft>) => void
  setParam: (patch: Partial<Pick<DrawState, 'size' | 'count'>>) => void
  setGenerating: (v: boolean) => void
  /** 生成完成：写库 + 刷新会话历史 */
  recordDraw: (d: Omit<Draw, 'createdAt'>) => Promise<void>
  refreshHistory: (id: string) => Promise<void>
}

/** 画图会话全局状态：切换菜单不丢（正在生成、草稿、参考图都保留） */
export const useDrawStore = create<DrawState>((set, get) => ({
  ready: false,
  sessions: [],
  currentId: null,
  history: {},
  drafts: {},
  size: '1024x1024',
  count: 1,
  generating: false,

  init: async () => {
    if (get().ready) return
    try {
      const sessions = await drawSessionRepo.list()
      set({ sessions, ready: true })
      if (get().currentId) return
      if (sessions[0]) await get().openSession(sessions[0].id)
      else await get().newSession()
    } catch {
      set({ ready: true })
    }
  },

  openSession: async (id) => {
    set({ currentId: id })
    if (!get().history[id]) await get().refreshHistory(id)
  },

  newSession: async () => {
    const s = await drawSessionRepo.create()
    set((st) => ({
      sessions: [s, ...st.sessions],
      currentId: s.id,
      history: { ...st.history, [s.id]: [] },
    }))
    return s
  },

  removeSession: async (id) => {
    await drawSessionRepo.remove(id)
    set((st) => {
      const history = { ...st.history }
      delete history[id]
      const drafts = { ...st.drafts }
      delete drafts[id]
      const sessions = st.sessions.filter((x) => x.id !== id)
      return { sessions, history, drafts, currentId: st.currentId === id ? (sessions[0]?.id ?? null) : st.currentId }
    })
  },

  patchSession: async (id, patch) => {
    await drawSessionRepo.update(id, patch)
    set((st) => ({
      sessions: st.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }))
  },

  setSessionKb: async (id, enabled, entryIds) => {
    await drawSessionRepo.update(id, {
      kbEnabled: enabled ? 1 : 0,
      kb_entry_ids: JSON.stringify(entryIds),
    })
    set((st) => ({
      sessions: st.sessions.map((x) =>
        x.id === id
          ? { ...x, kbEnabled: enabled ? 1 : 0, kb_entry_ids: JSON.stringify(entryIds) }
          : x,
      ),
    }))
  },

  setDraft: (id, patch) => {
    set((st) => {
      const base = st.drafts[id] ?? { prompt: '', refs: [] }
      return { drafts: { ...st.drafts, [id]: { prompt: base.prompt, refs: base.refs, ...patch } } }
    })
  },

  setParam: (patch) => set(patch),

  setGenerating: (generating) => set({ generating }),

  recordDraw: async (d) => {
    await drawRepo.add(d)
    await drawSessionRepo.touch(d.sessionId)
    await get().refreshHistory(d.sessionId)
    set((st) => ({
      sessions: st.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    }))
  },

  refreshHistory: async (id) => {
    const rows = await drawRepo.listBySession(id).catch(() => [] as Draw[])
    set((st) => ({ history: { ...st.history, [id]: rows } }))
  },
}))
