import { useEffect, useRef, useState } from 'react'
import { App, Button, Empty, Input, Popconfirm, Select, Spin } from 'antd'
import { Check, Eraser, Send, Square } from 'lucide-react'
import { cancelChat, chatSend, toServiceRef, type ChatEvent } from '../../api/chat'
import { useServiceOptions } from '../../hooks/useServiceOptions'
import { useChatStore } from '../../stores/chat'
import { lsGet, lsSet } from './shared'

/** 各 tab 共用的 AI 画图配置（服务 + 模型），默认继承 Chat 页上次选择 */
const CFG_KEY = 'aw-diagram:chat-cfg'

export interface DiagramMsg {
  role: 'user' | 'assistant'
  content: string
  error?: string
  /** 该条助手消息的代码已应用到编辑器 */
  applied?: boolean
}

interface Props {
  /** 对话缓存 key（每 tab 独立） */
  storageKey: string
  systemPrompt: string
  /** 当前编辑器里的图源码（发给模型，支持在现有图上修改） */
  getContext: () => string
  /** 从回复中提取图代码；提取不到返回 null */
  extractCode: (text: string) => string | null
  /** 代码应用到编辑器 */
  onApply: (code: string) => void
}

/** 从回复里取图代码：优先最后一个围栏代码块；无围栏时按前缀识别整体即代码的回复 */
export function makeExtractor(prefixes: string[]) {
  return (text: string): string | null => {
    const fences = [...text.matchAll(/```[\w-]*[ \t]*\n([\s\S]*?)```/g)]
    if (fences.length) {
      const body = (fences[fences.length - 1][1] ?? '').trim()
      if (body) return body
    }
    const t = text.trim()
    return prefixes.some((p) => t.startsWith(p)) ? t : null
  }
}

/**
 * 流程图 AI 对话面板：右侧大块面板，描述需求 → 模型输出图代码 → 自动应用到左侧编辑器。
 * 对话按 tab 存本机 localStorage；服务/模型默认取 Chat 页上次选择，可切换。
 */
export default function DiagramChat({ storageKey, systemPrompt, getContext, extractCode, onApply }: Props) {
  const { message } = App.useApp()
  const [msgs, setMsgs] = useState<DiagramMsg[]>(() => {
    try {
      const arr = JSON.parse(lsGet(storageKey) ?? '[]') as DiagramMsg[]
      return Array.isArray(arr) ? arr.filter((m) => m && typeof m.content === 'string') : []
    } catch {
      return []
    }
  })
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const taskIdRef = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const { options, loading } = useServiceOptions()
  const modelsMap = useChatStore((s) => s.models)
  const ensureModels = useChatStore((s) => s.ensureModels)

  // 服务/模型：本页记忆 → Chat 页上次选择 → 第一个可用服务
  const [cfg, setCfg] = useState<{ serviceKey: string | null; model: string | null }>(() => {
    for (const key of [CFG_KEY, 'aw-chat-last']) {
      try {
        const v = JSON.parse(localStorage.getItem(key) ?? 'null') as { serviceKey?: string; model?: string } | null
        if (v?.serviceKey) return { serviceKey: v.serviceKey, model: v.model ?? null }
      } catch {
        /* ignore */
      }
    }
    return { serviceKey: null, model: null }
  })

  const current = options.find((o) => o.key === cfg.serviceKey) ?? options[0]
  useEffect(() => {
    if (current) void ensureModels(current)
  }, [current, ensureModels])
  const models = current ? (modelsMap[current.key] ?? []) : []
  const model = cfg.model && models.includes(cfg.model) ? cfg.model : (models[0] ?? null)

  const setService = (key: string) => {
    setCfg({ serviceKey: key, model: null })
    lsSet(CFG_KEY, JSON.stringify({ serviceKey: key, model: null }))
  }
  const setModel = (m: string) => {
    setCfg((c) => ({ ...c, model: m }))
    lsSet(CFG_KEY, JSON.stringify({ serviceKey: current?.key ?? null, model: m }))
  }

  // 对话缓存（防抖 400ms，流式期间不高频写）
  useEffect(() => {
    const t = setTimeout(
      () => lsSet(storageKey, JSON.stringify(msgs.filter((m) => !m.error).slice(-50))),
      400,
    )
    return () => clearTimeout(t)
  }, [msgs, storageKey])

  // 新消息滚动到底
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [msgs])

  const applyCode = (code: string, idx?: number) => {
    onApply(code)
    if (idx != null) {
      setMsgs((prev) => prev.map((m, i) => (i === idx ? { ...m, applied: true } : m)))
    }
  }

  const send = async () => {
    const text = input.trim()
    if (!text || streaming) return
    if (!current) return void message.warning('暂无可用 AI 服务，请先在「AI 服务」配置网关令牌或供应商')
    let useModel = model
    if (!useModel) {
      await ensureModels(current)
      useModel = (modelsMap[current.key] ?? [])[0] ?? null
    }
    if (!useModel) return void message.warning('该服务暂无可用模型，请在顶部切换')

    setInput('')
    const history = msgs.filter((m) => !m.error && m.content)
    const ctx = getContext().trim()
    const sys =
      systemPrompt +
      (ctx
        ? `\n\n当前图源码（用户要求增/删/改时请在此基础上修改并保留未提及内容；用户要求画新图时整体替换）：\n\`\`\`\n${ctx}\n\`\`\``
        : '')
    const payload = [
      { role: 'system' as const, content: sys },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: text },
    ]

    setMsgs((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    setStreaming(true)
    const taskId = crypto.randomUUID()
    taskIdRef.current = taskId
    let content = ''
    let hadError = false
    try {
      await chatSend({ spec: toServiceRef(current.snapshot), taskId, model: useModel, messages: payload }, (e: ChatEvent) => {
        if (e.type === 'delta') {
          content += e.text
          setMsgs((prev) => prev.map((m, i) => (i === prev.length - 1 ? { ...m, content } : m)))
        } else if (e.type === 'error') {
          hadError = true
          message.error(e.message)
        }
      })
      if (hadError && !content) throw new Error('生成失败')
      // 完成后自动应用提取出的图代码
      const code = extractCode(content)
      setMsgs((prev) =>
        prev.map((m, i) => (i === prev.length - 1 ? { ...m, content, applied: !!code } : m)),
      )
      if (code) applyCode(code)
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      setMsgs((prev) => prev.map((m, i) => (i === prev.length - 1 ? { ...m, error: err } : m)))
    } finally {
      setStreaming(false)
      taskIdRef.current = null
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-sm font-semibold">AI 画图</span>
        <Select
          size="small"
          className="min-w-0 flex-1"
          placeholder="AI 服务"
          value={current?.key}
          onChange={setService}
          options={options.map((o) => ({ value: o.key, label: o.snapshot.label }))}
          loading={loading}
        />
        <Select
          size="small"
          className="w-40 shrink-0"
          placeholder="模型"
          value={model ?? undefined}
          onChange={setModel}
          options={models.map((m) => ({ value: m, label: m }))}
          showSearch
          optionFilterProp="label"
        />
        <Popconfirm
          title="清空对话？"
          description="当前 tab 的 AI 对话将被清空（不影响已画的图）"
          onConfirm={() => setMsgs([])}
        >
          <Button size="small" danger icon={<Eraser size={13} />} />
        </Popconfirm>
      </div>

      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/60"
      >
        {msgs.length === 0 && (
          <div className="grid h-full place-items-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span className="text-xs text-gray-400">
                  描述你想画的图，AI 生成后自动应用到左侧
                  <br />
                  例如：画一个用户下单的时序图 / 把开始节点改成绿色
                </span>
              }
            />
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-indigo-500 px-3 py-2 text-xs leading-6 text-white">
                {m.content}
              </div>
            </div>
          ) : (
            <AssistantMsg
              key={i}
              msg={m}
              streaming={streaming && i === msgs.length - 1}
              onApply={(code) => applyCode(code, i)}
            />
          ),
        )}
        {loading && msgs.length === 0 && (
          <div className="grid place-items-center text-xs text-gray-400">
            <Spin size="small" />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="描述你想画的图，Enter 发送（Shift+Enter 换行）…"
          autoSize={{ minRows: 3, maxRows: 12 }}
          disabled={streaming}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-gray-400">生成完成后自动应用到编辑器并切换预览</span>
          {streaming ? (
            <Button size="small" danger icon={<Square size={12} />} onClick={() => void cancelChat(taskIdRef.current ?? '')}>
              停止
            </Button>
          ) : (
            <Button size="small" type="primary" icon={<Send size={12} />} disabled={!input.trim()} onClick={() => void send()}>
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 助手消息：说明文字 + 代码块（含应用按钮）；流式中围栏未闭合也能按代码高亮展示 */
function AssistantMsg({ msg, streaming, onApply }: { msg: DiagramMsg; streaming: boolean; onApply: (code: string) => void }) {
  if (msg.error) {
    return (
      <div className="max-w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-6 text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
        {msg.error}
      </div>
    )
  }
  const parts: Array<{ kind: 'text' | 'code'; body: string }> = []
  const re = /```[\w-]*[ \t]*\n?([\s\S]*?)(?:```|$)/g
  let last = 0
  for (const m of msg.content.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > last) parts.push({ kind: 'text', body: msg.content.slice(last, idx) })
    parts.push({ kind: 'code', body: m[1] ?? '' })
    last = idx + m[0].length
  }
  if (last < msg.content.length) parts.push({ kind: 'text', body: msg.content.slice(last) })
  if (parts.length === 0) parts.push({ kind: 'text', body: msg.content })

  return (
    <div className="flex max-w-full flex-col items-start gap-1.5">
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          p.body.trim() ? (
            <p key={i} className="whitespace-pre-wrap text-xs leading-6 text-gray-700 dark:text-gray-300">
              {p.body.trim()}
            </p>
          ) : null
        ) : (
          <div key={i} className="flex max-w-full flex-col gap-1 rounded-lg border border-indigo-100 bg-white p-2 dark:border-indigo-900/50 dark:bg-gray-900">
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-gray-600 dark:text-gray-400">
              {p.body.trim() || (streaming ? '生成中…' : '')}
            </pre>
            <Button
              size="small"
              type="link"
              className="h-auto self-end p-0 text-xs"
              disabled={streaming || !p.body.trim()}
              icon={msg.applied ? <Check size={12} /> : undefined}
              onClick={() => onApply(p.body.trim())}
            >
              {msg.applied ? '已应用，再次应用' : '应用到编辑器'}
            </Button>
          </div>
        ),
      )}
      {streaming && <Spin size="small" />}
    </div>
  )
}
