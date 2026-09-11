import { useEffect, useRef, useState } from 'react'
import { App, Button, Empty, Input, Popconfirm, Spin } from 'antd'
import { Eraser, Image as ImageIcon, Info, Send, Square, Wand2 } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  cancelChat,
  chatSend,
  drawSaveRef,
  editImage,
  generateImage,
  type ChatEvent,
  type ChatMessagePayload,
  type ChatToolCallEvent,
  type ChatToolDef,
} from '../../api/chat'
import { useAiServices } from '../../hooks/useAiServices'
import ProviderModelSelect from '../ProviderModelSelect'
import { capabilityRepo } from '../../db/providers'
import { resolveCapability } from '../../lib/capability'
import { errText } from '../../lib/err'
import { blobToVisionUrl, type PhotopeaBridge } from './photopea'

const CHAT_KEY = 'aw-retouch:chat'
const VISION_CFG_KEY = 'aw-retouch:vision-cfg'
const IMAGE_CFG_KEY = 'aw-retouch:image-cfg'

/** 单轮最多工具循环次数（防止模型反复调用不收尾） */
const MAX_TOOL_ROUNDS = 8

export interface RetouchMsg {
  role: 'user' | 'assistant' | 'tool'
  content: string
  error?: string
  /** asset 协议地址的缩略图（ai_generate_image 结果展示） */
  image?: string
  /** role=tool：工具执行卡片 */
  tool?: { name: string; args: string; state: 'running' | 'done' | 'error' }
}

/** Photopea 脚本环境速记 + 工具决策规则 */
const SYSTEM_PROMPT = `你是「修图助手」，运行在一个内嵌 Photopea（网页版 Photoshop）的桌面应用里，通过工具直接操作用户当前打开的文档。

photopea_script 执行 Photoshop JSX 风格脚本（Photopea 实现 Adobe 脚本接口的常用子集），速记（已实测可用）：
- 全局 app：app.activeDocument（当前文档）、app.documents.length（打开的文档数）
- 文档 doc：doc.width / doc.height / doc.layers（图层数组，刚打开文件后可能为 null，需容错）/ doc.activeLayer；doc.resizeImage(w,h) 改图像尺寸、doc.resizeCanvas(w,h) 改画布、doc.crop([左,上,右,下]) 裁剪、doc.rotateCanvas(90) 旋转画布、doc.flatten() 合并
- 图层 layer：layer.name / layer.visible / layer.opacity（0~1）/ layer.translate(dx,dy) / layer.rotate(角度) / layer.scale(sx,sy) / layer.remove()
- 滤镜与调整：layer.applyGaussianBlur(半径)、layer.applyUnsharpMask(数量,半径,阈值)、layer.adjustBrightnessContrast(亮度,对比度)、layer.adjustHueSaturation(色相,饱和度,明度)
- 新建图层：var lay = app.activeDocument.artLayers.add()；文字层：lay.kind = LayerKind.TEXT（必须用 LayerKind 枚举，写字符串会崩）；lay.textItem.contents = "文字"; lay.textItem.size = 48
- 所有需要回传的数据（结果/确认值）一律 app.echoToOE("...")
- 重要：脚本里未捕获的异常会导致整个脚本静默失效（连错误都不回传），必须整体包 try{...}catch(e){app.echoToOE("ERROR: "+e)}

工作规则：
1. 动手前先调用 get_doc_info 了解文档尺寸与图层结构。
2. 确定性效果（裁剪、缩放、旋转、调色、滤镜、文字、水印、图层整理、拼贴）优先用 photopea_script，速度快且可控。
3. 生成式修改（改画面内容、换背景、风格化、修掉物体、生成素材）用 ai_generate_image：mode="edit" 以当前文档为参考图按 prompt 重绘整图（prompt 必须详细描述目标画面并写明保留内容）；mode="create" 纯文生图新素材。edit 的 prompt 建议用英文并强调 "keep everything else unchanged"。
4. 脚本必须整体包在 try{...}catch(e){app.echoToOE("ERROR: "+e)} 中；方法名不存在会抛异常，读回显里的 ERROR 换等价写法重试（最多 3 次）。
5. 每步工具结果会回传给你确认；全部做完后用一两句话告诉用户做了什么，不要向用户输出大段脚本。`

const TOOLS: ChatToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'photopea_script',
      description:
        '在 Photopea 中执行一段 Photoshop JSX 风格脚本，做确定性编辑（裁剪/缩放/旋转/调色/滤镜/图层/文字等）。脚本需自包 try/catch 并用 app.echoToOE 回传结果。',
      parameters: {
        type: 'object',
        properties: { script: { type: 'string', description: '完整 JS 脚本' } },
        required: ['script'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ai_generate_image',
      description:
        '调用画图模型生成图片并自动插入 Photopea（作为当前文档新图层）。适合生成式修改：改内容/换背景/风格化/去杂物/生成素材。mode=edit：以当前文档整图为参考图重绘（保持未提及内容）；mode=create：纯文生图。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画图提示词，描述完整目标画面' },
          mode: { type: 'string', enum: ['edit', 'create'], description: 'edit=基于当前图重绘，create=纯生成' },
        },
        required: ['prompt', 'mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_doc_info',
      description: '获取当前 Photopea 文档信息：尺寸、图层数、各图层名称与可见性。没有打开文档时返回 ok:false。',
      parameters: { type: 'object', properties: {} },
    },
  },
]

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return typeof v === 'object' && v ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…(截断)` : s
}

/** 修图对话面板：左侧 Photopea 编辑器的 AI 助手。每轮先拍当前文档快照发给多模态模型，
 *  模型经工具循环直接执行脚本/调画图模型改图；配置（多模态/画图模型）存本机 localStorage。 */
export default function RetouchChat({ bridge }: { bridge: PhotopeaBridge }) {
  const { message } = App.useApp()
  const { services } = useAiServices()

  const [msgs, setMsgs] = useState<RetouchMsg[]>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(CHAT_KEY) ?? '[]') as RetouchMsg[]
      return Array.isArray(arr) ? arr.filter((m) => m && typeof m.content === 'string') : []
    } catch {
      return []
    }
  })
  const msgsRef = useRef<RetouchMsg[]>(msgs)
  const sync = () => setMsgs([...msgsRef.current])

  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const stopRef = useRef(false)
  const taskIdRef = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  /** 服务选择：本页记忆 → Chat 页上次选择 → 第一个可用服务 */
  const loadCfg = (key: string): { serviceKey: string | null; model: string | null } => {
    for (const k of [key, 'aw-chat-last']) {
      try {
        const v = JSON.parse(localStorage.getItem(k) ?? 'null') as { serviceKey?: string; model?: string } | null
        if (v?.serviceKey) return { serviceKey: v.serviceKey, model: v.model ?? null }
      } catch {
        /* ignore */
      }
    }
    return { serviceKey: null, model: null }
  }
  const [visionCfg, setVisionCfg] = useState(() => loadCfg(VISION_CFG_KEY))
  const [imageCfg, setImageCfg] = useState(() => loadCfg(IMAGE_CFG_KEY))

  // Cascader 选出的服务 key → 服务对象（.spec 即 Rust ServiceRef 载荷）
  const visionSvc = services.find((s) => s.key === visionCfg.serviceKey) ?? null
  const imageSvc = services.find((s) => s.key === imageCfg.serviceKey) ?? null
  const visionModel = visionCfg.model
  const imageModel = imageCfg.model

  /** 画图模型调用方式（create 模式用；edit 模式固定 chat 参考图重绘或 images/edits） */
  const [imageCallMode, setImageCallMode] = useState<'images' | 'chat'>('chat')
  useEffect(() => {
    if (!imageCfg.serviceKey || !imageModel) return
    let alive = true
    void resolveCapability(imageCfg.serviceKey, imageModel, capabilityRepo.get).then((cap) => {
      if (alive) setImageCallMode(cap.isImage ? cap.callMode : 'chat')
    })
    return () => {
      alive = false
    }
  }, [imageCfg.serviceKey, imageModel])

  const setVision = (v: { serviceKey: string | null; model: string | null }) => {
    setVisionCfg(v)
    localStorage.setItem(VISION_CFG_KEY, JSON.stringify(v))
  }
  const setImage = (v: { serviceKey: string | null; model: string | null }) => {
    setImageCfg(v)
    localStorage.setItem(IMAGE_CFG_KEY, JSON.stringify(v))
  }

  // 对话缓存（防抖 400ms；运行中的工具卡片不落盘）
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const saved = msgsRef.current
          .filter((m) => m.role !== 'tool' || m.tool?.state !== 'running')
          .slice(-60)
          .map((m) => ({
            ...m,
            content: truncate(m.content, 2000),
            tool: m.tool ? { ...m.tool, args: truncate(m.tool.args, 2000) } : undefined,
            image: m.image?.startsWith('http') ? m.image : undefined,
          }))
        localStorage.setItem(CHAT_KEY, JSON.stringify(saved))
      } catch {
        /* ignore */
      }
    }, 400)
    return () => clearTimeout(t)
  }, [msgs])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [msgs])

  const patchLast = (patch: Partial<RetouchMsg>) => {
    const arr = msgsRef.current
    if (arr.length) arr[arr.length - 1] = { ...arr[arr.length - 1], ...patch }
    sync()
  }

  /** 执行一次工具调用，返回给模型的文字结果；UI 卡片即时更新 */
  const execTool = async (call: ChatToolCallEvent): Promise<string> => {
    const args = safeParseArgs(call.arguments)
    if (call.name === 'photopea_script') {
      const script = String(args.script ?? '')
      msgsRef.current.push({ role: 'tool', content: '', tool: { name: 'photopea_script', args: script, state: 'running' } })
      sync()
      try {
        const r = await bridge.runScript(script)
        const out = r.texts.filter(Boolean).join('\n').trim() || '(脚本已执行，无回显)'
        patchLast({ content: truncate(out, 1200), tool: { name: 'photopea_script', args: script, state: 'done' } })
        return `script output:\n${truncate(out, 4000)}`
      } catch (e) {
        const err = errText(e)
        patchLast({ content: err, tool: { name: 'photopea_script', args: script, state: 'error' } })
        return `ERROR: ${err}`
      }
    }
    if (call.name === 'get_doc_info') {
      msgsRef.current.push({ role: 'tool', content: '', tool: { name: 'get_doc_info', args: '', state: 'running' } })
      sync()
      try {
        const info = await bridge.docInfo()
        const text = info ? JSON.stringify(info) : 'no document'
        patchLast({ content: truncate(text, 1200), tool: { name: 'get_doc_info', args: '', state: 'done' } })
        return text
      } catch (e) {
        const err = errText(e)
        patchLast({ content: err, tool: { name: 'get_doc_info', args: '', state: 'error' } })
        return `ERROR: ${err}`
      }
    }
    if (call.name === 'ai_generate_image') {
      const prompt = String(args.prompt ?? '')
      const mode = args.mode === 'edit' ? 'edit' : 'create'
      if (!imageSvc || !imageModel) {
        return 'ERROR: 未选择画图模型，请在顶部「画图模型」级联选择后再试'
      }
      msgsRef.current.push({
        role: 'tool',
        content: '生成中…',
        tool: { name: 'ai_generate_image', args: `mode=${mode} prompt=${prompt}`, state: 'running' },
      })
      sync()
      try {
        let refPath: string | null = null
        if (mode === 'edit') {
          const blob = await bridge.exportBlob('jpg:0.9')
          if (!blob) throw new Error('当前没有打开的文档，edit 模式需要参考图；请让用户先打开图片或改用 create 模式')
          refPath = await drawSaveRef(await blobToDataUrl(blob))
        }
        const spec = imageSvc.spec
        const paths =
          mode === 'edit' && imageCallMode === 'images'
            ? await editImage({ spec, model: imageModel, prompt, image: refPath! })
            : await generateImage({ spec, model: imageModel, prompt, n: 1, callMode: mode === 'edit' ? 'chat' : imageCallMode, refs: refPath ? [refPath] : [] })
        const path = paths[0]
        const generated = await fetch(convertFileSrc(path)).then((r) => {
          if (!r.ok) throw new Error(`读取生成图失败（HTTP ${r.status}）`)
          return r.blob()
        })
        const where = await bridge.insertImage(await blobToDataUrl(generated))
        const text = `已生成并${where === 'layer' ? '作为新图层插入当前文档' : '作为新文档打开'}`
        patchLast({
          content: text,
          image: convertFileSrc(path),
          tool: { name: 'ai_generate_image', args: `mode=${mode} prompt=${prompt}`, state: 'done' },
        })
        return text
      } catch (e) {
        const err = errText(e)
        patchLast({ content: err, tool: { name: 'ai_generate_image', args: `mode=${mode} prompt=${prompt}`, state: 'error' } })
        return `ERROR: ${err}`
      }
    }
    return `ERROR: 未知工具 ${call.name}`
  }

  /** 一轮流式请求：增量更新最后一条 assistant 消息，返回正文与工具调用 */
  const streamRound = async (payload: ChatMessagePayload[]): Promise<{ content: string; calls: ChatToolCallEvent[] }> => {
    if (!visionSvc || !visionModel) throw new Error('未选择多模态模型')
    const taskId = crypto.randomUUID()
    taskIdRef.current = taskId
    let content = ''
    let calls: ChatToolCallEvent[] = []
    let hadError = false
    await chatSend(
      { spec: visionSvc.spec, taskId, model: visionModel, messages: payload, tools: TOOLS },
      (e: ChatEvent) => {
        if (e.type === 'delta') {
          content += e.text
          patchLast({ content, error: undefined })
        } else if (e.type === 'toolCalls') {
          calls = e.calls
        } else if (e.type === 'error') {
          hadError = true
          message.error(e.message)
          patchLast({ error: e.message })
        }
      },
    )
    if (hadError && !content && !calls.length) throw new Error('生成失败')
    return { content, calls }
  }

  const send = async () => {
    const text = input.trim()
    if (!text || streaming) return
    if (!visionSvc) return void message.warning('暂无可用 AI 服务，请先在「AI 服务」配置网关令牌或供应商')
    if (!visionModel) return void message.warning('请先选择多模态模型（需支持看图）')

    setInput('')
    // 每轮先拍当前文档快照（失败=无文档，纯文字也允许发送）
    let snap: string | null = null
    try {
      const b = await bridge.exportBlob('jpg:0.85', 30000)
      if (b) snap = await blobToVisionUrl(b)
    } catch {
      /* Photopea 未就绪/无文档 */
    }

    const history = msgsRef.current
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && !m.error)
      .map((m) => ({ role: m.role, content: m.content }))
    const payload: ChatMessagePayload[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: text, images: snap ? [snap] : undefined },
    ]

    msgsRef.current = [...msgsRef.current, { role: 'user', content: text }]
    setStreaming(true)
    stopRef.current = false
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        msgsRef.current = [...msgsRef.current, { role: 'assistant', content: '' }]
        sync()
        const { content, calls } = await streamRound(payload)
        if (!calls.length) break
        if (stopRef.current) break
        payload.push({ role: 'assistant', content, toolCalls: calls })
        for (const call of calls) {
          const result = await execTool(call)
          payload.push({ role: 'tool', content: result, toolCallId: call.id })
          if (stopRef.current) break
        }
        if (stopRef.current) break
      }
    } catch (e) {
      patchLast({ error: errText(e) })
    } finally {
      setStreaming(false)
      taskIdRef.current = null
    }
  }

  const stop = () => {
    stopRef.current = true
    if (taskIdRef.current) void cancelChat(taskIdRef.current)
  }

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">多模态模型</span>
          <ProviderModelSelect
            style={{ flex: 1, minWidth: 0 }}
            value={{ serviceKey: visionCfg.serviceKey, model: visionCfg.model }}
            onChange={setVision}
            placeholder="服务 / 模型（需支持看图）"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">画图模型</span>
          <ProviderModelSelect
            filter="image"
            style={{ flex: 1, minWidth: 0 }}
            value={{ serviceKey: imageCfg.serviceKey, model: imageCfg.model }}
            onChange={setImage}
            placeholder="服务 / 画图模型（仅画图模型）"
          />
          <Popconfirm title="清空对话？" description="修图对话记录将被清空（不影响已打开的图片）" onConfirm={() => {
            msgsRef.current = []
            sync()
          }}>
            <Button size="small" danger icon={<Eraser size={13} />} />
          </Popconfirm>
        </div>
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
                  打开图片后描述想要的修改，AI 直接在 Photopea 里改
                  <br />
                  例如：把背景换成夕阳下的海滩 / 加居中水印"GY" / 调亮并裁成 1:1
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
          ) : m.role === 'tool' && m.tool ? (
            <ToolCard key={i} msg={m} />
          ) : (
            <div key={i} className="flex max-w-full flex-col items-start gap-1.5">
              {m.content && (
                <p className="whitespace-pre-wrap text-xs leading-6 text-gray-700 dark:text-gray-300">{m.content}</p>
              )}
              {m.image && (
                <img
                  src={m.image}
                  alt="生成结果"
                  className="max-h-44 max-w-full cursor-pointer rounded-lg border border-gray-200 dark:border-gray-700"
                  onClick={() => window.open(m.image, '_blank')}
                />
              )}
              {m.error && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
                  {m.error}
                </p>
              )}
              {streaming && i === msgs.length - 1 && !m.content && !m.error && <Spin size="small" />}
            </div>
          ),
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="描述想要的修改，Enter 发送（Shift+Enter 换行）…"
          autoSize={{ minRows: 3, maxRows: 10 }}
          disabled={streaming}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-gray-400">发送时会截取当前文档快照给多模态模型</span>
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
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('读取图片失败'))
    r.readAsDataURL(blob)
  })
}

/** 工具执行卡片：名称 + 状态 + 参数（脚本可展开）+ 结果/缩略图 */
function ToolCard({ msg }: { msg: RetouchMsg }) {
  const t = msg.tool!
  const Icon = t.name === 'photopea_script' ? Wand2 : t.name === 'ai_generate_image' ? ImageIcon : Info
  const label =
    t.name === 'photopea_script' ? 'Photopea 脚本' : t.name === 'ai_generate_image' ? 'AI 生成图片' : '读取文档信息'
  const stateCls =
    t.state === 'running'
      ? 'border-indigo-200 bg-indigo-50/60 dark:border-indigo-900/50 dark:bg-indigo-950/30'
      : t.state === 'error'
        ? 'border-red-200 bg-red-50/60 dark:border-red-900/50 dark:bg-red-950/30'
        : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'
  return (
    <div className={`flex max-w-full flex-col gap-1 rounded-lg border px-2.5 py-2 text-xs ${stateCls}`}>
      <div className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
        <Icon size={12} className="shrink-0" />
        <span className="font-medium">{label}</span>
        {t.state === 'running' && <Spin size="small" />}
        {t.state === 'error' && <span className="text-red-500">失败</span>}
      </div>
      {t.args && t.name === 'photopea_script' && (
        <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-gray-500 dark:text-gray-400">
          {t.args}
        </pre>
      )}
      {t.args && t.name !== 'photopea_script' && (
        <p className="whitespace-pre-wrap break-all text-[11px] leading-5 text-gray-500 dark:text-gray-400">{t.args}</p>
      )}
      {msg.content && t.state !== 'running' && (
        <p className="whitespace-pre-wrap break-all text-[11px] leading-5 text-gray-600 dark:text-gray-400">
          {t.state === 'error' ? msg.content : truncate(msg.content, 600)}
        </p>
      )}
      {msg.image && (
        <img src={msg.image} alt="生成结果" className="max-h-36 max-w-full rounded-md border border-gray-200 dark:border-gray-700" />
      )}
    </div>
  )
}
