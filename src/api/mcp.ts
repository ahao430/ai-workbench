import { call } from './ipc'

/** MCP 传输类型 */
export type McpKind = 'stdio' | 'http' | 'sse'

/** 单值 map（env / headers） */
export type KVMap = Record<string, string>

export interface McpEntry {
  id: string
  name: string
  kind: McpKind | string
  command?: string | null
  args: string[]
  env: KVMap
  url?: string | null
  headers: KVMap
  desc?: string | null
  homepage?: string | null
  tags: string[]
  /** builtin | custom | market | local */
  source: string
  /** cli id → 是否分发 */
  enabled: Record<string, boolean>
}

export interface McpView {
  entry: McpEntry & { id: string }
  /** cli id → 配置文件中实际在位 */
  actual: Record<string, boolean>
}

export interface LocalMcp {
  cli: string
  cliLabel: string
  name: string
  entry: McpEntry
}

export interface MarketServer {
  qualifiedName: string
  displayName: string
  description: string
  homepage?: string | null
  verified: boolean
  useCount?: number | null
  remote: boolean
}

export interface BuiltinMcp {
  key: string
  name: string
  kind: string
  desc: string
  category: string
  homepage: string
}

/** 分发目标（与后端 CLI_TARGETS 对齐） */
export const MCP_CLI_TARGETS: { id: string; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
]

export function emptyMcpEntry(): McpEntry {
  return {
    id: '',
    name: '',
    kind: 'stdio',
    command: 'npx',
    args: [],
    env: {},
    url: '',
    headers: {},
    desc: '',
    homepage: '',
    tags: [],
    source: 'custom',
    enabled: {},
  }
}

export const mcpApi = {
  list: () => call<McpView[]>('mcp_list'),
  save: (entry: McpEntry) => call<McpView>('mcp_save', { entry }),
  remove: (id: string) => call<void>('mcp_remove', { id }),
  setTargets: (id: string, targets: string[]) => call<void>('mcp_set_targets', { id, targets }),
  scanLocal: () => call<LocalMcp[]>('mcp_scan_local'),
  marketSearch: (query: string) => call<MarketServer[]>('mcp_market_search', { query }),
  marketInstall: (qualifiedName: string) => call<McpView>('mcp_market_install', { qualifiedName }),
  builtins: () => call<BuiltinMcp[]>('mcp_builtins'),
  installBuiltin: (key: string) => call<McpView>('mcp_install_builtin', { key }),
}
