import { call } from './ipc'

export type KbProvider = 'weknora' | 'dify' | 'external-api'

/** 一个外接知识 API 连接（协议对齐 agent-platform packages/knowledge） */
export interface KbApiConfig {
  id: string
  name: string
  /** weknora（X-API-Key）| dify（Knowledge API，Bearer）| external-api（Dify 外部知识库协议，Bearer） */
  provider: KbProvider | string
  /** 服务基址（weknora 不带 /api/v1，dify 自动补 /v1；external-api 填完整检索端点） */
  baseUrl: string
  /** 相似度阈值（null = 默认 0.5；0 = 关闭过滤） */
  scoreThreshold?: number | null
  tokenRef?: string | null
}

/** 挂载在某个连接下的知识库 */
export interface KbEntry {
  /** 稳定唯一 id（选择器/会话引用用） */
  id: string
  apiId: string
  key: string
  name: string
  enabled: boolean
}

export interface KbState {
  apis: KbApiConfig[]
  entries: KbEntry[]
}

/** 知识库列表接口返回的条目 */
export interface KbListed {
  key: string
  name?: string | null
  description?: string | null
  docCount?: number | null
}

export interface KbChunk {
  content: string
  title?: string | null
  source?: string | null
  score?: number | null
  apiName?: string | null
  kbName?: string | null
  /** 知识库在服务商 Web 端的页面链接（weknora 可拼；其余为空） */
  url?: string | null
}

export interface TestResult {
  ok: boolean
  message: string
}

export const kbApi = {
  getConfig: () => call<KbState>('kb_get_config'),
  /** 新增时 id 传空串；token 传 undefined = 不修改，空串 = 清除 */
  saveApi: (api: KbApiConfig, token?: string) => call<KbState>('kb_save_api', { api, token }),
  removeApi: (apiId: string) => call<KbState>('kb_remove_api', { apiId }),
  /** 覆盖式更新某连接挂载的知识库 */
  setEntries: (apiId: string, entries: Array<{ key: string; name: string; enabled: boolean }>) =>
    call<KbState>('kb_set_entries', { apiId, entries }),
  /** 从连接拉取远端知识库列表（external-api 无列表端点会报错，走手动添加） */
  fetchList: (apiId: string) => call<KbListed[]>('kb_fetch_list', { apiId }),
  testApi: (apiId: string) => call<TestResult>('kb_test_api', { apiId }),
  /** entryIds 非空 = 只检索这些知识库条目；空/缺省 = 全部已启用条目 */
  search: (query: string, topK?: number, entryIds?: string[]) =>
    call<KbChunk[]>('kb_search', { query, topK, entryIds }),
}
