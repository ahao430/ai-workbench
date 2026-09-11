import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { App, Badge, Button, Dropdown, Empty, Input, Modal, Popover, Select, Switch, Tooltip } from 'antd'
import { BookOpen, ChevronRight, ExternalLink, SlidersHorizontal, SquarePlus, SquareTerminal, SquareX } from 'lucide-react'
import { errText } from '../lib/err'
import { kbApi, type KbState } from '../api/kb'
import { parseKbEntryIds, parseKbRefs, type KbRefLite } from '../db/chats'
import type { ChatMessage } from '../stores/chat'
import { useServiceOptions } from '../hooks/useServiceOptions'
import { useChatStore } from '../stores/chat'
import { MdPreview } from '../components/common/MdPreview'
import { useUiStore } from '../stores/ui'
import { AssistantManageSection } from '../components/chat/AssistantManageSection'
import ProviderModelSelect from '../components/ProviderModelSelect'

/** 思考过程块：流式思考阶段自动展开，正式回答开始输出时自动收起；手动切换优先 */
function ThinkingBlock({
  reasoning,
  streaming,
  hasAnswer,
}: {
  reasoning: string
  streaming: boolean
  hasAnswer: boolean
}) {
  // manual=null 跟随默认（思考中→展开，其余→收起）；点击后锁定，直到答案开始时被强制收起
  const [manual, setManual] = useState<boolean | null>(null)
  const prevHasAnswer = useRef(hasAnswer)
  const thinkingNow = streaming && !hasAnswer

  useEffect(() => {
    if (!prevHasAnswer.current && hasAnswer) setManual(false)
    prevHasAnswer.current = hasAnswer
  }, [hasAnswer])

  const open = manual ?? thinkingNow
  return (
    <div className="mb-2">
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        onClick={() => setManual(!open)}
      >
        <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {thinkingNow ? '思考中…' : '思考过程'}
      </button>
      {open && (
        <div
          className={`mt-1 whitespace-pre-wrap text-xs text-gray-400 ${
            streaming ? '' : 'max-h-60 overflow-y-auto'
          }`}
        >
          {reasoning}
        </div>
      )}
    </div>
  )
}

/** 知识库引用来源（渲染在回答气泡内）：显示 知识库 · 文章标题（文件名），有链接可点击跳转 */
function KbRefsBlock({ refs }: { refs: KbRefLite[] }) {
  const [open, setOpen] = useState(false)
  if (refs.length === 0) return null
  return (
    <div className="mt-1.5 border-t border-black/5 pt-1.5 dark:border-white/10">
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs text-gray-400 hover:text-indigo-500 dark:hover:text-indigo-400"
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        引用来源（{refs.length} 条）
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-0.5">
          {refs.map((r, i) => {
            // 标题疑似内容片段（过长）时优先展示文件名
            const title = r.title && r.title.length <= 60 ? r.title : ''
            const file = r.source && r.source !== title ? r.source : ''
            const doc = [title, file].filter(Boolean).join('（') + (title && file ? '）' : '')
            const label = [r.kbName, doc].filter(Boolean).join(' · ') || '（无来源信息）'
            const inner = (
              <>
                <span className="shrink-0 opacity-60">[{i + 1}]</span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {r.url && <ExternalLink size={11} className="shrink-0 opacity-60" />}
                {r.score != null && <span className="shrink-0 opacity-60">{(r.score * 100).toFixed(0)}%</span>}
              </>
            )
            return r.url ? (
              <a
                key={i}
                className="flex items-center gap-1.5 text-xs leading-5 text-gray-500 no-underline hover:text-indigo-500 dark:text-gray-400 dark:hover:text-indigo-400"
                title={r.url}
                onClick={(e) => {
                  e.preventDefault()
                  void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(r.url!))
                }}
                href={r.url}
              >
                {inner}
              </a>
            ) : (
              <div key={i} className="flex items-center gap-1.5 text-xs leading-5 text-gray-500 dark:text-gray-400">
                {inner}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 服务选项 = 已保存供应商 */
export default function ChatPage() {
  const ready = useChatStore((s) => s.ready)
  const blocked = useChatStore((s) => s.blocked)
  const init = useChatStore((s) => s.init)

  useEffect(() => {
    if (!ready) void init()
  }, [ready, init])

  if (blocked) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty description={`聊天数据不可用（${blocked}）。请在桌面应用内使用。`} />
      </div>
    )
  }
  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty description="加载中…" />
      </div>
    )
  }
  return <ChatView />
}

/** zustand v5 选择器必须返回稳定引用——空数组兜底用常量，避免无限重渲染 */
const EMPTY_MESSAGES: ChatMessage[] = []
function ChatView() {
  const { message } = App.useApp()
  const location = useLocation()
  const navigate = useNavigate()
  /** 聊天气泡内 markdown 主题跟随应用明暗（与笔记/语雀同一渲染器：mermaid/katex/代码复制） */
  const mdTheme = useUiStore((s) => (s.theme === 'dark' ? 'github-dark' : 'github'))
  const assistants = useChatStore((s) => s.assistants)
  const sessions = useChatStore((s) => s.sessions)
  const currentId = useChatStore((s) => s.currentId)
  const messagesMap = useChatStore((s) => s.messages)
  const messages = (currentId ? messagesMap[currentId] : undefined) ?? EMPTY_MESSAGES
  const streamingTaskId = useChatStore((s) => s.streamingTaskId)
  const { options } = useServiceOptions()

  const newSession = useChatStore((s) => s.newSession)
  const openSession = useChatStore((s) => s.openSession)
  const removeSession = useChatStore((s) => s.removeSession)
  const resetContext = useChatStore((s) => s.resetContext)
  const setAssistant = useChatStore((s) => s.setAssistant)
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const setSessionService = useChatStore((s) => s.setSessionService)
  const setSessionKb = useChatStore((s) => s.setSessionKb)

  const session = sessions.find((x) => x.id === currentId) ?? null
  const serviceKey = session
    ? session.service_json.includes('"gateway"')
      ? `gw-${(JSON.parse(session.service_json) as { tokenId?: number }).tokenId}`
      : `pv-${(JSON.parse(session.service_json) as { providerId?: string }).providerId}`
    : null
  // 会话级知识库：开关 + 多选（存会话行；entryIds 空 = 全部已启用条目）
  const kbEnabled = session?.kb_enabled === 1
  const kbEntryIds = useMemo(() => (session ? parseKbEntryIds(session) : []), [session])
  const [kbState, setKbState] = useState<KbState>({ apis: [], entries: [] })
  useEffect(() => {
    kbApi.getConfig().then(setKbState).catch(() => {})
  }, [])
  const [commonOpen, setCommonOpen] = useState(false)
  // 公共配置：新会话默认的供应商/模型（与顶栏会话级联动区分）
  const [chatDefault, setChatDefault] = useState(() => {
    try {
      return { serviceKey: null, model: null, ...(JSON.parse(localStorage.getItem('aw-chat-last') ?? '{}') as { serviceKey?: string; model?: string }) }
    } catch {
      return { serviceKey: null as string | null, model: null as string | null }
    }
  })
  const defaultSvc = options.find((o) => o.key === chatDefault.serviceKey)
  const defaultLabel = chatDefault.serviceKey
    ? `${defaultSvc?.snapshot.label ?? '已删除的服务'}${chatDefault.model ? ` · ${chatDefault.model}` : ''}`
    : '未选'
  const listRef = useRef<HTMLDivElement>(null)
  // 输入草稿存 store：切菜单再回来不丢（流式回复本身在 store，天然续传）
  const drafts = useChatStore((s) => s.drafts)
  const input = currentId ? (drafts[currentId] ?? '') : ''
  const setInput = (v: string) => useChatStore.getState().setDraft(currentId, v)

  // 首页入口：带助手/草稿文本新建会话（一次性消费 location.state）
  const pending = (location.state as { assistantId?: string; draftText?: string } | null) ?? {}
  useEffect(() => {
    const { assistantId, draftText } = pending
    if (!assistantId && !draftText) return
    navigate(location.pathname, { replace: true, state: null })
    if (!options[0]) {
      message.warning('请先在「AI 服务」页添加 AI 供应商，再使用助手开始对话')
      return
    }
    const fill = () => {
      const cid = useChatStore.getState().currentId
      if (draftText?.trim() && cid) useChatStore.getState().setDraft(cid, draftText)
    }
    if (assistantId) {
      void newSession(options[0], '', assistantId).then(fill)
      message.info('已用助手开启新会话')
    } else {
      fill()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 知识库多选选项：按连接分组 */
  const kbOptions = kbState.apis
    .map((api) => ({
      label: api.name,
      title: api.name,
      options: kbState.entries
        .filter((e) => e.apiId === api.id)
        .map((e) => ({ value: e.id, label: e.enabled ? e.name : `${e.name}（停用）` })),
    }))
    .filter((g) => g.options.length > 0)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])


  const doSend = async () => {
    if (!session) {
      if (options[0]) {
        await newSession(options[0], '')
      } else {
        message.warning('请先在「AI 服务」页添加 AI 供应商')
        return
      }
    }
    const text = input
    setInput('')
    // 知识库引用注入：检索结果拼进上行内容（界面仍显示原文）。
    // 从 store 取最新会话行（新建会话路径 render 期 session 还没更新）
    const stNow = useChatStore.getState()
    const cur = stNow.sessions.find((x) => x.id === stNow.currentId)
    let wire = text
    let refs: KbRefLite[] = []
    if (cur?.kb_enabled === 1 && text.trim()) {
      try {
        const { kbApi } = await import('../api/kb')
        const sel = parseKbEntryIds(cur)
        const chunks = await kbApi.search(text.trim(), 5, sel.length ? sel : undefined)
        if (chunks.length > 0) {
          refs = chunks.map((c) => ({ title: c.title, source: c.source, kbName: c.kbName, score: c.score, url: c.url }))
          wire =
            `${text.trim()}\n\n请优先根据以下参考资料回答，引用处标注 [n]；资料无关则忽略：\n` +
            chunks
              .map((c, i) => {
                const src = [c.title, c.source, c.kbName].filter(Boolean).join(' · ')
                return `[${i + 1}]${src ? `（来源：${src}）` : ''} ${c.content}`
              })
              .join('\n')
        }
      } catch (e) {
        message.warning(`知识库检索失败，已按原文发送：${errText(e)}`)
      }
    }
    await send(text, wire, refs)
  }

  return (
    <div className="flex h-full">
      {/* 会话列表 */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-black/5 dark:border-white/10">
        <div className="p-2">
          <Button block type="dashed" icon={<SquarePlus size={14} />} onClick={() => void doSendNew()}>
            新建会话
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {sessions.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有会话" />}
          {sessions.map((s) => {
            const asst = assistants.find((a) => a.id === s.assistant_id)
            return (
            <div
              key={s.id}
              className={`group mb-0.5 flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-sm ${
                s.id === currentId
                  ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                  : 'text-gray-600 hover:bg-black/5 dark:text-gray-400 dark:hover:bg-white/5'
              }`}
              onClick={() => void openSession(s.id)}
            >
              <span className="min-w-0 flex-1 truncate">
                {asst ? `${asst.emoji} ` : ''}
                {s.title}
              </span>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    {
                      key: 'reset',
                      label: '从这里开始新的上下文',
                      onClick: () => {
                        void resetContext(s.id)
                        message.success('已截断上下文，后续对话不再参考之前内容')
                      },
                    },
                    { type: 'divider' },
                    {
                      key: 'del',
                      danger: true,
                      label: '删除会话',
                      onClick: () => void removeSession(s.id),
                    },
                  ],
                }}
              >
                <button
                  className="hidden shrink-0 text-gray-400 hover:text-gray-600 group-hover:block dark:hover:text-gray-200"
                  onClick={(e) => e.stopPropagation()}
                >
                  ⋯
                </button>
              </Dropdown>
            </div>
            )
          })}
        </div>
      </aside>

      {/* 消息区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 公共配置入口：按钮 + 当前默认摘要，点击弹窗配置 */}
        <div className="flex items-center gap-2 border-b border-black/5 px-4 py-1.5 dark:border-white/10">
          <Button size="small" icon={<SlidersHorizontal size={13} />} onClick={() => setCommonOpen(true)}>
            公共配置
          </Button>
          <span className="truncate text-xs text-gray-400">新会话默认模型：{defaultLabel}</span>
          <div className="flex-1" />
        </div>

        {/* 会话级设置（选中会话后才显示） */}
        {session && (
          <div className="flex items-center gap-2 border-b border-black/5 px-4 py-2 dark:border-white/10">
            <Select
              size="small"
              style={{ minWidth: 140 }}
              placeholder="助手"
              value={session.assistant_id ?? 'none'}
              onChange={(v) => {
                void setAssistant(session.id, v === 'none' ? null : v)
                message.success(v === 'none' ? '已移除助手（下一条消息生效）' : '已切换助手（下一条消息生效）')
              }}
              options={[
                { value: 'none', label: '不使用助手' },
                ...assistants.map((a) => ({ value: a.id, label: `${a.emoji} ${a.name}` })),
              ]}
            />
            <ProviderModelSelect
              value={{ serviceKey, model: session.model || null }}
              onChange={({ serviceKey: k, model: m }) => {
                const opt = options.find((o) => o.key === k)
                if (!opt) return
                setSessionService(session.id, JSON.stringify(opt.snapshot), m ?? '')
                // 记住上次选择，作为新会话默认
                localStorage.setItem('aw-chat-last', JSON.stringify({ serviceKey: k, model: m ?? '' }))
              }}
              placeholder="选择模型"
              style={{ minWidth: 300 }}
            />
            <Popover
              trigger="click"
              placement="bottomLeft"
              content={
                <div className="flex w-80 flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-gray-500">本会话启用知识库检索</span>
                    <Switch
                      size="small"
                      checked={kbEnabled}
                      onChange={(v) => session && setSessionKb(session.id, v, kbEntryIds)}
                    />
                  </div>
                  {kbEnabled && (
                    <>
                      <Select
                        mode="multiple"
                        allowClear
                        size="small"
                        placeholder="全部已启用的知识库"
                        value={kbEntryIds}
                        onChange={(ids) => session && setSessionKb(session.id, true, ids)}
                        options={kbOptions}
                        maxTagCount="responsive"
                      />
                      <p className="m-0 text-[10px] leading-4 text-gray-400">
                        不选 = 检索全部已启用条目；选择后仅检索勾选的知识库（按「知识库」页的连接分组）。选项保存在本会话。
                      </p>
                    </>
                  )}
                  {kbState.entries.length === 0 && (
                    <p className="m-0 text-[10px] leading-4 text-gray-400">
                      还没有可用知识库，请先到「知识库」页添加连接并拉取知识库。
                    </p>
                  )}
                </div>
              }
            >
              <Badge count={kbEntryIds.length} size="small" offset={[-4, 4]}>
                <Tooltip
                  title={kbEnabled ? '知识库引用：开（点击配置检索范围）' : '知识库引用：关（点击开启）'}
                >
                  <Button size="small" type={kbEnabled ? 'primary' : 'text'} icon={<BookOpen size={14} />} />
                </Tooltip>
              </Badge>
            </Popover>
            <div className="flex-1" />
            <span className="text-xs text-gray-400">
              {session.context_reset_id ? '上下文已截断' : ''}
            </span>
          </div>
        )}

        <div ref={listRef} className="flex-1 overflow-y-auto px-6 py-4">
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center">
              <Empty description="发消息开始对话" />
            </div>
          )}
          {messages.map((m, i) => {
            // 引用块显示在回答上：取本次提问携带的检索引用（数据仍记录在用户消息）
            let kbRefs: KbRefLite[] = []
            if (m.role === 'assistant') {
              for (let j = i - 1; j >= 0; j--) {
                if (messages[j].role === 'user') {
                  kbRefs = parseKbRefs(messages[j])
                  break
                }
              }
            }
            return (
            <div key={m.id} className={`mb-4 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                  m.role === 'user'
                    ? 'bg-indigo-500 text-white'
                    : m.error
                      ? 'border border-red-200 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950/40'
                      : 'border border-black/5 bg-white text-gray-900 shadow-sm dark:border-white/10 dark:bg-[#1f1f27] dark:text-gray-100'
                }`}
              >
                {m.reasoning && (
                  <ThinkingBlock
                    reasoning={m.reasoning}
                    streaming={!!m.streaming}
                    hasAnswer={m.role === 'assistant' && !!m.content}
                  />
                )}
                {m.role === 'assistant' ? (
                  <>
                    <div className="chat-md">
                      <MdPreview text={m.content} theme={mdTheme} />
                    </div>
                    {m.streaming && !m.content && !m.error && (
                      <span className="inline-block h-4 w-2 animate-pulse rounded-sm bg-indigo-400" />
                    )}
                    {m.error && <span className="text-sm">{m.error}</span>}
                    {!m.error && <KbRefsBlock refs={kbRefs} />}
                  </>
                ) : (
                  <p className="m-0 whitespace-pre-wrap break-words">{m.content}</p>
                )}
              </div>
            </div>
            )
          })}
        </div>

        {/* 输入区 */}
        <div className="border-t border-black/5 p-3 dark:border-white/10">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={session ? '输入消息，Cmd+Enter 发送 / Enter 换行' : '先选择服务后开始对话'}
              autoSize={{ minRows: 1, maxRows: 6 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  if (!streamingTaskId) void doSend()
                }
              }}
              disabled={!!streamingTaskId}
            />
            {streamingTaskId ? (
              <Tooltip title="停止生成">
                <Button danger icon={<SquareX size={16} />} onClick={() => void stop()} />
              </Tooltip>
            ) : (
              <Button type="primary" icon={<SquareTerminal size={16} />} onClick={() => void doSend()} disabled={!input.trim()} />
            )}
          </div>
        </div>
      </div>
      {/* 公共配置弹窗：新会话默认模型 + 助手列表管理 */}
      <Modal
        title="公共配置"
        open={commonOpen}
        width={640}
        destroyOnHidden
        footer={<Button onClick={() => setCommonOpen(false)}>关闭</Button>}
        onCancel={() => setCommonOpen(false)}
      >
        <div className="flex flex-col gap-4 py-2">
          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-500">新会话默认模型</div>
            <ProviderModelSelect
              value={chatDefault}
              onChange={(v) => {
                setChatDefault(v)
                localStorage.setItem('aw-chat-last', JSON.stringify({ serviceKey: v.serviceKey, model: v.model ?? '' }))
              }}
              style={{ minWidth: 300 }}
            />
            <p className="m-0 mt-1.5 text-xs text-gray-400">
              新会话（含首页快速开始、助手入口）默认使用的供应商与模型；单个会话可在其设置行覆盖。
            </p>
          </div>
          <div className="border-t border-black/5 pt-3 dark:border-white/10">
            <div className="mb-1.5 text-xs font-medium text-gray-500">助手列表</div>
            <AssistantManageSection />
          </div>
        </div>
      </Modal>
    </div>
  )

  async function doSendNew() {
    const last = (() => {
      try {
        return JSON.parse(localStorage.getItem('aw-chat-last') ?? 'null') as { serviceKey?: string; model?: string } | null
      } catch {
        return null
      }
    })()
    const opt =
      (last?.serviceKey ? options.find((o) => o.key === last.serviceKey) : null) ??
      options.find((o) => !(o.snapshot.kind === 'provider' && o.snapshot.apiFormat === 'anthropic'))
    if (opt) {
      await newSession(opt, last?.model && opt.key === last.serviceKey ? last.model : '')
    } else {
      message.warning('请先在「AI 服务」页添加 AI 供应商')
    }
  }
}
