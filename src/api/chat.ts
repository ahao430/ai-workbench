import { call } from '../api/ipc'

export type ServiceKind = 'gateway' | 'provider'

/** 会话绑定的服务快照：调用 Rust 时还原为 ServiceRef（密钥不经过前端） */
export interface ServiceSnapshot {
  kind: ServiceKind
  /** gateway：网关令牌 id */
  tokenId?: number
  /** provider：providers 表 id */
  providerId?: string
  baseUrl?: string
  secretRef?: string
  label: string
  /** 线上协议：openai（默认）| anthropic */
  apiFormat?: 'openai' | 'anthropic'
  /** 可选 Anthropic 格式请求地址（CLI 配置 Claude Code 用） */
  anthropicBaseUrl?: string
}

/** 还原为 Rust ServiceRef 载荷（kind: stored 供后端 sqlite 取密钥） */
export function toServiceRef(s: ServiceSnapshot): Record<string, unknown> {
  switch (s.kind) {
    case 'gateway':
      return { kind: 'gateway', tokenId: s.tokenId, label: s.label }
    case 'provider':
      return {
        kind: 'stored',
        baseUrl: s.baseUrl,
        secretRef: s.secretRef,
        label: s.label,
        apiFormat: s.apiFormat ?? 'openai',
        anthropicBaseUrl: s.anthropicBaseUrl,
      }
  }
}

/** CLI 配置任务参数 */
export interface CliTaskArgs {
  baseUrl: string
  apiKey: string
  label: string
  targets: Array<{ tool: string; model?: string }>
  /** 可选 Anthropic 格式端点（Claude Code 优先使用） */
  anthropicBaseUrl?: string
}

export interface ChatMessagePayload {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** 多模态输入：data URL 图片（Rust 侧转 OpenAI content parts，需模型支持看图） */
  images?: string[]
  /** assistant 消息携带的工具调用（工具循环回传；Rust 侧转 OpenAI 形状） */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  /** role=tool 时对应的调用 id */
  toolCallId?: string
}

/** 模型发起的一次工具调用（流式聚合后推送） */
export interface ChatToolCallEvent {
  id: string
  name: string
  /** JSON 字符串参数 */
  arguments: string
}

/** OpenAI function calling 工具定义 */
export interface ChatToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    /** JSON Schema */
    parameters: Record<string, unknown>
  }
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCalls'; calls: ChatToolCallEvent[] }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface ChatArgs {
  spec: Record<string, unknown>
  taskId: string
  model: string
  messages: ChatMessagePayload[]
  temperature?: number
  maxTokens?: number
  /** 提供后模型可发起函数调用，经 toolCalls 事件返回 */
  tools?: ChatToolDef[]
}

/** 发起流式对话；通过 onEvent 接收增量。取消用 cancelChat(taskId) */
export async function chatSend(args: ChatArgs, onEvent: (e: ChatEvent) => void): Promise<void> {
  const { Channel } = await import('@tauri-apps/api/core')
  const ch = new Channel<ChatEvent>()
  ch.onmessage = onEvent
  await call<void>('llm_chat', { ...args, onEvent: ch })
}

export function cancelChat(taskId: string): Promise<boolean> {
  return call<boolean>('llm_cancel', { taskId })
}

/** 拉取服务模型列表（/v1/models） */
export function listModels(spec: Record<string, unknown>): Promise<string[]> {
  return call<string[]>('llm_models', { spec })
}

/** 生图：返回落盘绝对路径数组；refs = 参考图绝对路径（chat 模式多模态传入） */
export function generateImage(args: {
  spec: Record<string, unknown>
  model: string
  prompt: string
  size?: string
  n?: number
  callMode?: 'images' | 'chat'
  refs?: string[]
}): Promise<string[]> {
  return call<string[]>('image_generate', args)
}

export interface PromptCase {
  title: string
  author: string
  imageUrl: string
  prompt: string
}

/** GPT-Image 社区提示词模板（awesome-gpt4o-images 仓库） */
export function fetchPromptCases(): Promise<PromptCase[]> {
  return call<PromptCase[]>('image_prompt_repo')
}

/** 图生图编辑：原图 + 提示词重绘（/v1/images/edits，需模型支持） */
export function editImage(args: {
  spec: Record<string, unknown>
  model: string
  prompt: string
  image: string
  size?: string
  n?: number
  mask?: string
}): Promise<string[]> {
  return call<string[]>('image_edit', args)
}

/** 参考图落盘（data URL → 绝对路径），画图页添加参考图用 */
export function drawSaveRef(dataUrl: string): Promise<string> {
  return call<string>('draw_save_ref', { dataUrl })
}

/** 非流式补全（AI 优化提示词/笔记等一次性任务） */
export function llmComplete(args: {
  spec: Record<string, unknown>
  model: string
  prompt: string
  system?: string
  temperature?: number
  maxTokens?: number
}): Promise<string> {
  return call<string>('llm_complete', args)
}

/** 密钥写入/删除本机 sqlite secrets.db（供应商密钥；不提供读取命令） */
export function secretPut(account: string, value: string): Promise<void> {
  return call<void>('secret_put', { args: { account, value } })
}
export function secretRemove(account: string): Promise<void> {
  return call<void>('secret_remove', { account })
}
