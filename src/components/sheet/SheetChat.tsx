import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { App, Button, Empty, Input, Popconfirm, Select, Spin } from 'antd'
import { Eraser, Send, Square, Table2 } from 'lucide-react'
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
import type { SheetData } from './model'

/** 本页 AI 配置（服务 + 模型），默认继承 Chat 页上次选择 */
const CFG_KEY = 'aw-sheet:chat-cfg'

/** 工具轮数上限：模型调 set_sheet 后还会再总结，防异常模型无限循环 */
const MAX_ROUNDS = 5

const SET_SHEET_TOOL: ChatToolDef = {
  type: 'function',
  function: {
    name: 'set_sheet',
    description:
      '设置 / 替换表格数据（完整工作簿，非增量）。传入 sheets 数组，每个 sheet 含 name 与 cells（行优先二维数组；字符串以 = 开头为公式，数字为数值，空字符串为空单元格）。',
    parameters: {
      type: 'object',
      properties: {
        sheets: {
          type: 'array',
          description: '工作表列表',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '工作表名（如 销售台账）' },
              cells: {
                type: 'array',
                description: '行优先二维数组；每行是一个单元格值数组，首行通常是表头',
                items: { type: 'array', items: { type: ['string', 'number'] } },
              },
            },
            required: ['name', 'cells'],
          },
        },
      },
      required: ['sheets'],
      additionalProperties: false,
    },
  },
}

const SYSTEM_PROMPT = `你是一个 AI 表格助手。用户用自然语言描述需求，你通过调用 set_sheet 工具生成 / 修改一个或多个工作表（台账 / 预算 / 排班 / 数据分析…），左侧表格立即渲染、可编辑且公式自动计算。

## 输出格式

只调用 set_sheet，参数是一个工作簿对象：

{
  "sheets": [
    {
      "name": "销售台账",
      "cells": [
        ["产品", "数量", "单价", "金额"],
        ["苹果", 10, 5, "=B2*C2"],
        ["香蕉", 20, 3, "=B3*C3"],
        ["合计", "=SUM(B2:B3)", "=SUM(C2:C3)", "=SUM(D2:D3)"]
      ]
    }
  ]
}

- cells 是行优先二维数组：cells[行][列]。列号 A、B、C… 对应 cells[r][0]、cells[r][1]…
- 单元格值三种：字符串（= 开头视为公式，如 =B2*C2、=SUM(B2:B3)）；数字（不要把数字写成字符串）；空字符串 ""（空单元格，不要留 null）
- 第一行通常是表头；表头与数据一起放进 cells。

## 公式

- 金额 / 合计 / 小计 / 百分比等派生值一律用公式，不要自己算好填数字
- 常用：=B2*C2（乘）、=SUM(B2:B5)（求和）、=AVERAGE(B2:B5)（均值）、=B2/B$5（占比，绝对引用）
- 跨行引用对齐：cells 索引 r 对应 Excel 第 r+1 行（A1 起算），列 c 对应第 c+1 列字母
- 公式里的单元格引用必须真实存在于你生成的 cells 里

## 布局与规模

- 一张表控制在 ~20 行 × ~12 列以内；更多就拆成多个 sheet 或聚合
- 多 sheet：sheets 数组放多项，每个有独立 name；name 简短（如 销售台账 / 汇总）
- 不要合并单元格、不要设样式；只产出数据（首行表头直接写文本即可）

## 调用规则

1. 每次只调用一次 set_sheet，传完整工作簿（不是增量）。
2. 用户说"改成…/加一列…/删一行…"时，上下文里已给出当前表格 JSON，在它基础上改完整体发回，保留用户未提及的部分；用户明确要全新表时才整体替换。
3. 先简短回一句你在做什么，再调工具；之后可再说一句确认。不要把 JSON 贴在聊天回复里。
4. 标签语言跟随用户语言（用户中文就全中文：表头、sheet 名都用中文）。`

/** 一次工具调用的执行记录（展示卡片 + 重放给模型的上下文） */
interface ToolExec {
  id: string
  name: string
  /** 原始参数 JSON（回传模型用） */
  args: string
  /** 摘要（卡片展示） */
  summary?: string
  ok: boolean
  /** 回传给模型的工具结果 */
  result: string
}

interface SheetMsg {
  role: 'user' | 'assistant'
  content: string
  error?: string
  calls?: ToolExec[]
}

interface Props {
  storageKey: string
  /** 当前表格数据（含手动编辑，发送时实时读取） */
  getData: () => SheetData | null
  /** 工具执行：把数据写入左侧表格 */
  onSet: (data: SheetData) => void
}

/** 宽松校验并归一 set_sheet 参数：sheets 必须是 [{name, cells 二维}]，值仅保留 string/number */
function parseSheetArgs(raw: unknown): SheetData | null {
  if (!raw || typeof raw !== 'object') return null
  const sheets = (raw as { sheets?: unknown }).sheets
  if (!Array.isArray(sheets) || !sheets.length) return null
  const out: SheetData['sheets'] = []
  for (const s of sheets) {
    if (!s || typeof s !== 'object') return null
    const name = (s as { name?: unknown }).name
    const cells = (s as { cells?: unknown }).cells
    if (typeof name !== 'string' || !name.trim() || !Array.isArray(cells)) return null
    const rows: (string | number)[][] = []
    for (const row of cells) {
      if (!Array.isArray(row)) return null
      rows.push(row.map((v) => (typeof v === 'number' ? v : v == null ? '' : String(v))))
    }
    out.push({ name: name.trim(), cells: rows })
  }
  return { sheets: out }
}

/** 执行 set_sheet：校验参数 → 写入左侧表格 → 返回给模型的结果 JSON */
function execSetSheet(call: ChatToolCallEvent, onSet: Props['onSet']): ToolExec {
  const base: ToolExec = { id: call.id, name: call.name, args: call.arguments, ok: false, result: '' }
  try {
    const args = JSON.parse(call.arguments || '{}') as unknown
    const data = parseSheetArgs(args)
    if (!data) {
      base.result = JSON.stringify({ ok: false, error: 'sheets 必须是 [{name: string, cells: (string|number)[][]}] 且至少一张' })
      return base
    }
    onSet(data)
    base.ok = true
    base.summary = data.sheets.map((s) => `${s.name}（${s.cells.length}×${Math.max(0, ...s.cells.map((r) => r.length))}）`).join('、')
    base.result = JSON.stringify({ ok: true, message: '表格已写入左侧画布', sheets: data.sheets.map((s) => ({ name: s.name, rows: s.cells.length })) })
  } catch (e) {
    base.result = JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
  return base
}

/** 展示消息 → 模型载荷：assistant 的工具调用后跟 tool 结果消息（OpenAI 工具循环格式） */
function toWireMessages(msgs: SheetMsg[], system: string): ChatMessagePayload[] {
  const out: ChatMessagePayload[] = [{ role: 'system', content: system }]
  for (const m of msgs) {
    if (m.error || (!m.content && !m.calls?.length)) continue
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

/**
 * 表格页 AI 对话面板：走 function calling —— 模型调 set_sheet 工具，
 * 工具在前端执行并把工作簿写到左侧 Univer 表格，不在对话里输出表格 JSON。
 */
const SheetChat = forwardRef<unknown, Props>(function SheetChat({ storageKey, getData, onSet }, ref) {
  void ref
  const { message } = App.useApp()
  const [msgs, setMsgs] = useState<SheetMsg[]>(() => {
    try {
      const arr = JSON.parse(lsGet(storageKey) ?? '[]') as SheetMsg[]
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

  // 对话缓存（防抖 400ms）
  useEffect(() => {
    const t = setTimeout(() => lsSet(storageKey, JSON.stringify(msgs.filter((m) => !m.error).slice(-60))), 400)
    return () => clearTimeout(t)
  }, [msgs, storageKey])

  // 新消息滚动到底
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [msgs])

  const buildSystem = () => {
    const data = getData()
    const hasData = data && data.sheets.some((s) => s.cells.some((row) => row.some((c) => c !== '')))
    return (
      SYSTEM_PROMPT +
      (hasData
        ? `\n\n当前表格数据(JSON)：\n${JSON.stringify(data)}\n\n用户若要求增/删/改某个单元格或行列，请在此 JSON 基础上修改并保留其他现有内容；若用户要求做全新的表，则整体替换。`
        : '\n\n当前画布为空，请按用户需求生成新表。')
    )
  }

  const setLast = (patch: Partial<SheetMsg>) =>
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
      { spec: toServiceRef(current.snapshot), taskId, model: model ?? '', messages: payload, tools: [SET_SHEET_TOOL] },
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

    stopRef.current = false
    setInput('')
    setMsgs((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    setStreaming(true)
    const taskId = crypto.randomUUID()
    taskIdRef.current = taskId
    try {
      // 工具循环：模型调 set_sheet → 前端写表 → 结果回传继续，直到无调用或达轮数上限
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
          c.name === 'set_sheet' ? execSetSheet(c, onSet) : {
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

  useImperativeHandle(ref, () => ({}))

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-sm font-semibold">AI 表格</span>
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
        <Popconfirm title="清空对话？" description="AI 对话将被清空（不影响左侧表格）" onConfirm={() => setMsgs([])}>
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
                  描述你要的表格，AI 调用工具直接写进左侧（公式自动计算）
                  <br />
                  例如：做一个项目排期表 / 给销售台账加合计行
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
          placeholder="描述你要的表格，Enter 发送（Shift+Enter 换行）…"
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
          <span className="truncate text-[11px] text-gray-400">
            也可先在左侧导入 Excel/CSV/JSON，再让 AI 修改
          </span>
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

export default SheetChat

/** 助手消息：说明文字 + 工具调用卡片（不展示表格 JSON 全文，避免对话变成数据输出） */
function AssistantMsg({ msg, streaming }: { msg: SheetMsg; streaming: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-xs leading-6 text-gray-700 shadow-sm dark:bg-gray-800 dark:text-gray-200">
        {msg.content || (streaming ? <Spin size="small" /> : null)}
        {msg.error && <span className="text-red-500">（{msg.error}）</span>}
      </div>
      {msg.calls?.map((c) => (
        <div
          key={c.id}
          className={`flex max-w-[92%] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${
            c.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
              : 'border-red-200 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400'
          }`}
        >
          <Table2 size={13} className="shrink-0" />
          <span className="truncate">
            {c.ok ? `已写入表格：${c.summary ?? ''}` : `set_sheet 执行失败（${c.result}）`}
          </span>
        </div>
      ))}
    </div>
  )
}
