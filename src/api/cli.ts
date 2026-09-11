import { call } from './ipc'

export type CliToolId = 'claude' | 'codex' | 'opencode' | 'pi'

export interface CliTool {
  id: CliToolId | string
  name: string
  installed: boolean
  path?: string | null
  version?: string | null
  configPaths: string[]
  /** 是否支持向导写入供应商配置（oh-my-pi 为 Pi 扩展，仅安装管理） */
  configurable: boolean
}

export interface ResolvedCredential {
  baseUrl: string
  apiKey: string
  label: string
  /** 可选 Anthropic 格式端点（Claude Code 用） */
  anthropicBaseUrl?: string | null
}

export type CredentialSpec =
  | { kind: 'gateway'; tokenId: number; label?: string }
  | {
      kind: 'stored'
      baseUrl: string
      secretRef: string
      label?: string
      apiFormat?: string
      anthropicBaseUrl?: string
    }
  | { kind: 'custom'; baseUrl: string; apiKey: string; label?: string; anthropicBaseUrl?: string }

export interface TargetSpec {
  tool: CliToolId
  model?: string
  /** 按家族的模型映射（Claude：fable/opus/sonnet/haiku → ANTHROPIC_DEFAULT_*_MODEL） */
  models?: Record<string, string>
  /** 用户直接编辑的完整配置文件内容（整体替换，跳过模板生成） */
  content?: string
}

export interface CliPlanEntry {
  tool: string
  label: string
  configPath: string
  exists: boolean
  changed: boolean
  before?: string | null
  after: string
}

export interface CliApplyResult {
  tool: string
  label: string
  ok: boolean
  message: string
}

export interface CliTaskArgs {
  baseUrl: string
  apiKey: string
  label: string
  targets: TargetSpec[]
  /** 可选 Anthropic 格式端点（Claude Code 优先使用） */
  anthropicBaseUrl?: string
}

export interface CliCurrent {
  tool: string
  toolName: string
  configured: boolean
  baseUrl?: string | null
  providerLabel?: string | null
  model?: string | null
}

export interface CliUpdateInfo {
  id: CliToolId
  name: string
  installed: boolean
  /** 本地 --version 原始输出 */
  version?: string | null
  /** 提取的 semver */
  current?: string | null
  /** npm registry 最新版 */
  latest?: string | null
  updateAvailable: boolean
  npmPackage: string
  error?: string | null
}

export interface CliModelLists {
  /** 主列表：OpenAI 端口（anthropic 协议供应商则为其自身端点） */
  openai: string[]
  /** Anthropic 端点列表（无 Anthropic 地址时为空） */
  anthropic: string[]
  openaiError?: string | null
  anthropicError?: string | null
}

export const cliApi = {
  detect: () => call<CliTool[]>('cli_detect'),
  resolveCredential: (spec: CredentialSpec) =>
    call<ResolvedCredential>('cli_resolve_credential', { spec }),
  preview: (args: CliTaskArgs) => call<CliPlanEntry[]>('cli_preview', args),
  apply: (args: CliTaskArgs) => call<CliApplyResult[]>('cli_apply', args),
  currentStatus: () => call<CliCurrent[]>('cli_current_status'),
  checkUpdates: () => call<CliUpdateInfo[]>('cli_check_updates'),
  /** 升级（未安装时即安装）：npm 全局包走 npm -g，oh-my-pi 走 pi install */
  upgrade: (id: string) => call<CliApplyResult>('cli_upgrade_tool', { id }),
  /** CLI 向导用：一次取 OpenAI / Anthropic 两个端口的模型列表（密钥解析在后端） */
  models: (spec: CredentialSpec, anthropicBaseUrl?: string) =>
    call<CliModelLists>('cli_models', { spec, anthropicBaseUrl }),
}
