import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { App, Button, Empty, Input, Popconfirm, Select, Spin } from 'antd'
import { Check, Eraser, FileSpreadsheet, Send, Square, Palette } from 'lucide-react'
import {
  cancelChat,
  chatSend,
  toServiceRef,
  type ChatEvent,
  type ChatMessagePayload,
  type ChatToolCallEvent,
  type ChatToolDef,
} from '../../api/chat'
import { useServiceOptions } from '../../hooks/useServiceOptions'
import { useChatStore } from '../../stores/chat'
import { lsGet, lsSet } from '../diagram/shared'
import { datasetPrompt, parseDataFile, type Dataset } from './data'
import type { ChartLib } from './ChartTab'

/** 各 tab 共用的 AI 画图配置（服务 + 模型），默认继承 Chat 页上次选择 */
const CFG_KEY = 'aw-charts:chat-cfg'

/** 工具轮数上限：模型每次调 render_chart 后还会再总结，防异常模型无限循环 */
const MAX_ROUNDS = 5

const RENDER_CHART_TOOL: ChatToolDef = {
  type: 'function',
  function: {
    name: 'render_chart',
    description: '在左侧画布绘制或更新图表。绘图必须调用本工具，不要把图表配置 JSON 直接写在回复里。',
    parameters: {
      type: 'object',
      properties: {
        library: {
          type: 'string',
          enum: ['echarts', 'antv'],
          description: '图表库：echarts=ECharts（option 为其标准 option 对象，series 可为 line/bar/pie/scatter/radar/heatmap/funnel/gauge/candlestick/boxplot/sankey/sunburst/treemap 等）；antv=Ant Design Charts（option 须含 type 字段，如 line/area/column/bar/pie/scatter/dual-axes/histogram/box/radar/rose/heatmap/funnel/waterfall/bullet/radial-bar/gauge/liquid/sankey/treemap/sunburst/venn/word-cloud，其余为组件属性 data/xField/yField/angleField/colorField 等）',
        },
        option: { type: 'object', description: '完整图表配置对象' },
      },
      required: ['library', 'option'],
    },
  },
}

const SYSTEM_PROMPT = `你是数据可视化图表助手，通过 render_chart 工具在用户左侧的画布上绘图。规则：
1. 绘图必须调用 render_chart 工具，绝不把图表配置 JSON 直接输出到回复文本中。
2. library 选择：echarts 传标准 ECharts option（series 支持 line/bar/pie/scatter/radar/heatmap/funnel/gauge/candlestick/boxplot/sankey/sunburst/treemap 等）；antv 传 Ant Design Charts 配置且必须含 type 字段（line/area/column/bar/pie/scatter/dual-axes/histogram/box/radar/rose/heatmap/funnel/waterfall/bullet/radial-bar/gauge/liquid/sankey/treemap/sunburst/venn/word-cloud），其余字段为组件属性（data/xField/yField/angleField/colorField…）。
3. 存在【当前数据集】时，图表数据必须取自数据集：字段名与列名完全一致；小数据集全量引用，大样本按类目聚合（求和/计数/平均）后再画图并在说明中注明口径。没有数据集且用户未提供数据时才可使用示例数据。
4. 用户要求修改现有图时，基于「当前左侧配置」调整后传入完整 option；画新图时直接给完整 option。
5. 用户没指定图表库时默认 echarts。
6. 图型选择：趋势用折线/面积，对比用柱状/条形，占比用饼图/环形，多维对比用雷达，转化用漏斗，流向用桑基。
7. 多系列柱状图默认分组并列、不堆叠，并配 legend 图例（echarts 放多个不带 stack 的 bar series 并加 legend；antv 设 group: true 加 colorField）；只有用户明确要求「堆叠」时才堆叠（echarts 各 series 设相同 stack 值；antv 设 stack: true），堆叠面积图同理。
8. 工具调用后用一两句话说明图表内容即可，不要复述配置。`

/** 一次工具调用的执行记录（展示卡片 + 重放给模型的上下文） */
interface ToolExec {
  id: string
  name: string
  /** 原始参数 JSON（回传模型用） */
  args: string
  /** render_chart 参数摘要 */
  lib?: ChartLib
  ok: boolean
  /** 回传给模型的工具结果 */
  result: string
}

interface ChartMsg {
  role: 'user' | 'assistant'
  content: string
  error?: string
  calls?: ToolExec[]
}

interface Props {
  storageKey: string
  /** 当前两个库的配置文本（发给模型支持增量修改） */
  getContext: () => { echarts: string; antv: string }
  /** 工具执行：把配置应用到左侧画布 */
  onRender: (lib: ChartLib, option: Record<string, unknown>) => void
  /** 当前数据集（注入系统提示，模型据此生成配置） */
  getData: () => Dataset | null
  /** 对话区上传数据文件后回写数据集 */
  onDataset: (ds: Dataset) => void
}

/** 宽松库名归一：模型可能写 antd charts / ant-design-charts 等变体 */
function normLib(v: unknown): ChartLib | null {
  const s = String(v ?? '').toLowerCase()
  if (s.includes('ant') || s === 'antd' || s === 'charts') return 'antv'
  if (s.includes('echart')) return 'echarts'
  return null
}

/** 执行 render_chart：校验参数 → 应用到左侧 → 返回给模型的结果 JSON */
function execRender(
  call: ChatToolCallEvent,
  onRender: Props['onRender'],
): ToolExec {
  const base: ToolExec = { id: call.id, name: call.name, args: call.arguments, ok: false, result: '' }
  try {
    const args = JSON.parse(call.arguments || '{}') as { library?: unknown; option?: unknown }
    const lib = normLib(args.library)
    if (!lib) {
      base.result = JSON.stringify({ ok: false, error: 'library 必须是 echarts 或 antv' })
      return base
    }
    base.lib = lib
    if (!args.option || typeof args.option !== 'object' || Array.isArray(args.option)) {
      base.result = JSON.stringify({ ok: false, error: 'option 必须是完整配置对象' })
      return base
    }
    const opt = args.option as Record<string, unknown>
    if (lib === 'antv' && (typeof opt.type !== 'string' || !opt.type.trim())) {
      base.result = JSON.stringify({ ok: false, error: 'antv 配置必须包含 type 字段（如 line/column/pie）' })
      return base
    }
    onRender(lib, opt)
    base.ok = true
    base.result = JSON.stringify({ ok: true, library: lib, message: '图表已绘制到左侧画布' })
  } catch (e) {
    base.result = JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
  return base
}

/** 展示消息 → 模型载荷：assistant 的工具调用后跟 tool 结果消息（OpenAI 工具循环格式） */
function toWireMessages(msgs: ChartMsg[], system: string): ChatMessagePayload[] {
  const out: ChatMessagePayload[] = [{ role: 'system', content: system }]
  for (const m of msgs) {
    if (m.error || !m.content && !m.calls?.length) continue
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else {
      const calls = m.calls ?? []
      if (calls.length) {
        out.push({
          role: 'assistant',
          content: m.content,
          toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
        })
        for (const c of calls) out.push({ role: 'tool', toolCallId: c.id, content: c.result })
      } else if (m.content) {
        out.push({ role: 'assistant', content: m.content })
      }
    }
  }
  return out
}

/** 暴露给页面的命令入口（数据看板「根据数据更新配置」等一键触发） */
export interface ChartChatHandle {
  requestUpdate: (prompt: string) => void
}

/**
 * 图表页 AI 对话面板：与 DiagramChat（模型输出代码→前端提取）不同，
 * 这里走 function calling —— 模型调 render_chart 工具，工具在前端执行并把配置画到左侧。
 */
const ChartChat = forwardRef<ChartChatHandle, Props>(function ChartChat(
  { storageKey, getContext, onRender, getData, onDataset },
  ref,
) {
  const { message } = App.useApp()
  const dataFileRef = useRef<HTMLInputElement>(null)
  const [msgs, setMsgs] = useState<ChartMsg[]>(() => {
    try {
      const arr = JSON.parse(lsGet(storageKey) ?? '[]') as ChartMsg[]
      return Array.isArray(arr) ? arr.filter((m) => m && typeof m.content === 'string') : []
    } catch {
      return []
    }
  })
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const taskIdRef = useRef<string | null>(null)
  const stopRef = useRef(false)
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
    const t = setTimeout(() => lsSet(storageKey, JSON.stringify(msgs.filter((m) => !m.error).slice(-60))), 400)
    return () => clearTimeout(t)
  }, [msgs, storageKey])

  // 新消息滚动到底
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [msgs])

  const buildSystem = () => {
    const { echarts, antv } = getContext()
    const ctx = [
      echarts.trim() ? `- ECharts：${echarts.trim()}` : '- ECharts：（空）',
      antv.trim() ? `- AntV：${antv.trim()}` : '- AntV：（空）',
    ].join('\n')
    return (
      SYSTEM_PROMPT +
      datasetPrompt(getData()) +
      `\n\n当前左侧配置（用户要求修改时在此基础上调整）：\n${ctx}`
    )
  }

  // 对话区直接上传数据文件（与左侧数据看板同一套解析）
  const onDataFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const res = await parseDataFile(file)
      onDataset(res.dataset)
      message.success(`已导入 ${file.name}：${res.dataset.rows.length} 行 × ${res.dataset.columns.length} 列，可要求按数据画图`)
    } catch (e) {
      message.error(`${file.name} 解析失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (dataFileRef.current) dataFileRef.current.value = ''
    }
  }

  const setLast = (patch: Partial<ChartMsg>) =>
    setMsgs((prev) => prev.map((m, i) => (i === prev.length - 1 ? { ...m, ...patch } : m)))

  /** 一轮流式请求：返回 (文本, 工具调用)；流式增量实时上屏 */
  const streamOnce = async (
    payload: ChatMessagePayload[],
    taskId: string,
  ): Promise<{ content: string; calls: ChatToolCallEvent[] }> => {
    let content = ''
    let calls: ChatToolCallEvent[] = []
    let hadError = false
    await chatSend(
      { spec: toServiceRef(current.snapshot), taskId, model: model ?? '', messages: payload, tools: [RENDER_CHART_TOOL] },
      (e: ChatEvent) => {
        if (e.type === 'delta') {
          content += e.text
          setLast({ content })
        } else if (e.type === 'toolCalls') {
          calls = e.calls
        } else if (e.type === 'error') {
          hadError = true
          message.error(e.message)
        }
      },
    )
    if (hadError && !content && !calls.length) throw new Error('生成失败')
    return { content, calls }
  }

  const send = async (explicit?: string) => {
    const text = explicit ?? input.trim()
    if (!text || streaming) return
    if (!current) return void message.warning('暂无可用 AI 服务，请先在「AI 服务」配置网关令牌或供应商')
    let useModel = model
    if (!useModel) {
      await ensureModels(current)
      useModel = (modelsMap[current.key] ?? [])[0] ?? null
    }
    if (!useModel) return void message.warning('该服务暂无可用模型，请在顶部切换')

    stopRef.current = false
    if (!explicit) setInput('')
    setMsgs((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    setStreaming(true)
    const taskId = crypto.randomUUID()
    taskIdRef.current = taskId
    try {
      // 工具循环：模型调 render_chart → 前端执行画图 → 结果回传继续，直到无调用或达轮数上限
      let payload = [
        ...toWireMessages(
          msgs.filter((m) => !m.error && (m.content || m.calls?.length)).slice(-40),
          buildSystem(),
        ),
        { role: 'user' as const, content: text },
      ]
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const { content, calls } = await streamOnce(payload, taskId)
        if (stopRef.current) break
        if (!calls.length) break
        const execs = calls.map((c) =>
          c.name === 'render_chart' ? execRender(c, onRender) : {
            id: c.id,
            name: c.name,
            args: c.arguments,
            ok: false,
            result: JSON.stringify({ ok: false, error: `未知工具：${c.name}` }),
          },
        )
        setLast({ content, calls: execs })
        payload = [
          ...payload,
          { role: 'assistant' as const, content, toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) },
          ...execs.map((x) => ({ role: 'tool' as const, toolCallId: x.id, content: x.result })),
        ]
        // 还有下一轮：补一条空 assistant 消息接流式增量
        if (round < MAX_ROUNDS - 1) setMsgs((prev) => [...prev, { role: 'assistant', content: '' }])
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      setLast({ error: err })
    } finally {
      setStreaming(false)
      taskIdRef.current = null
      // 清掉循环收尾产生的空消息
      setMsgs((prev) => prev.filter((m, i) => m.content || m.calls?.length || m.error || i === prev.length - 1))
    }
  }

  const stop = () => {
    stopRef.current = true
    void cancelChat(taskIdRef.current ?? '')
  }

  // 不设依赖数组：每次渲染刷新句柄，保证一键触发时闭包拿到最新状态
  useImperativeHandle(ref, () => ({
    requestUpdate: (prompt: string) => {
      if (streaming) return void message.warning('正在生成，请稍候再更新')
      void send(prompt)
    },
  }))

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-sm font-semibold">AI 绘图</span>
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
        <Popconfirm title="清空对话？" description="AI 对话将被清空（不影响左侧已画的图）" onConfirm={() => setMsgs([])}>
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
                  描述你想画的图，AI 调用绘图工具直接画到左侧
                  <br />
                  例如：画一个本周各模型调用次数的柱状图 / 把饼图换成环形图
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
            <AssistantMsg key={i} msg={m} streaming={streaming && i === msgs.length - 1} />
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
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <input
              ref={dataFileRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.json"
              className="hidden"
              onChange={(e) => void onDataFile(e.target.files?.[0])}
            />
            <Button
              size="small"
              icon={<FileSpreadsheet size={12} />}
              disabled={streaming}
              onClick={() => dataFileRef.current?.click()}
            >
              数据
            </Button>
            <span className="truncate text-[11px] text-gray-400">
              可先上传/粘贴数据，AI 按数据画图且不输出配置文本
            </span>
          </div>
          {streaming ? (
            <Button size="small" danger icon={<Square size={12} />} onClick={stop}>
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
})

export default ChartChat

const LIB_LABEL: Record<ChartLib, string> = { echarts: 'ECharts', antv: 'AntV Charts' }

/** 助手消息：说明文字 + 工具调用卡片（不展示配置全文，避免对话变成配置输出） */
function AssistantMsg({ msg, streaming }: { msg: ChartMsg; streaming: boolean }) {
  if (msg.error) {
    return (
      <div className="max-w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-6 text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
        {msg.error}
      </div>
    )
  }
  return (
    <div className="flex max-w-full flex-col items-start gap-1.5">
      {msg.content.trim() ? (
        <p className="whitespace-pre-wrap text-xs leading-6 text-gray-700 dark:text-gray-300">{msg.content.trim()}</p>
      ) : !msg.calls?.length && streaming ? (
        <Spin size="small" />
      ) : null}
      {msg.calls?.map((c) => (
        <div
          key={c.id}
          className="flex items-center gap-1.5 rounded-lg border border-indigo-100 bg-white px-2.5 py-1.5 text-[11px] dark:border-indigo-900/50 dark:bg-gray-900"
        >
          <Palette size={12} className={c.ok ? 'shrink-0 text-emerald-500' : 'shrink-0 text-red-500'} />
          {c.ok ? (
            <span className="text-gray-600 dark:text-gray-300">
              已绘制 {c.lib ? LIB_LABEL[c.lib] : '图表'}，配置已应用到左侧画布
            </span>
          ) : (
            <span className="text-red-500">绘图失败：{c.result}</span>
          )}
          {c.ok && <Check size={12} className="text-emerald-500" />}
        </div>
      ))}
      {streaming && msg.content && <Spin size="small" />}
    </div>
  )
}
