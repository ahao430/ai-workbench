/** 语雀 API：多连接（团队 + 个人 + 自定义）接入，知识空间文档浏览/搜索/阅读 */

import { call } from './ipc'

export interface YqSpace {
  id: number
  namespace: string
  name: string
  description: string
  /** 归属展示名（团队名/个人名）——左侧子空间分组用 */
  ownerName: string
  /** group（团队子空间）| user（个人） */
  ownerKind: string
}

export interface YqUser {
  id: number
  login: string
  name: string
  avatarUrl: string
}

/** 单个语雀连接（团队 / 个人 / 自定义） */
export interface YqConnection {
  /** company / personal / custom:{domain} / main */
  id: string
  label: string
  base: string
  userName: string
  userLogin: string
  spaces: YqSpace[]
}

/** 状态返回：连接 + 凭证存在性 */
export interface YqConnStatus extends YqConnection {
  hasAuth: boolean
}

export interface YqRepo {
  id: number
  namespace: string
  name: string
  description: string
  public: number
  updatedAt: string
  /** 归属展示名（团队名/个人名）——子空间分组用 */
  ownerName: string
  /** group（团队）| user（个人） */
  ownerKind: string
}

export interface YqDoc {
  id: number
  slug: string
  title: string
  /** Doc | Sheet | Table | Board（非 Doc 无法在应用内渲染正文） */
  kind: string
  description: string
  updatedAt: string
  wordCount: number
}

/** Sheet（语雀表格）单页：只含有值的单元格（行号→列号→文本） */
export interface YqSheetTab {
  name: string
  cells: Record<string, Record<string, string>>
}

export interface YqDocDetail {
  id: number
  slug: string
  title: string
  body: string
  updatedAt: string
  /** 表格类型（kind=Sheet）的结构化单元格数据 */
  sheet?: YqSheetTab[]
}

export interface YqSearchItem {
  id: number
  kind: string
  title: string
  summary: string
  url: string
  repo: { id: number; namespace: string; name: string }
  doc: { id: number; slug: string }
  connId: string
  connLabel: string
}

/** 语雀域名（个人版；团队/企业空间用自定义域名接入） */
export const YUQUE_PERSONAL_BASE = 'www.yuque.com'
/** 语雀官网 Token 管理页（个人版需会员、团队版需管理员——一般走账号密码登录） */
export const YUQUE_TOKEN_URL = 'https://www.yuque.com/settings/tokens'

export const yqApi = {
  status: () => call<YqConnStatus[]>('yuque_status'),
  /** 账号密码登录（密码不落盘，换取长期会话 Cookie） */
  login: (base: string, account: string, password: string) =>
    call<{ user: YqUser; cookie: string }>('yuque_login', { base, account, password }),
  /** 应用内网页登录：检查登录窗口是否完成（hint=登录窗口标签，其 Cookie 优先验证） */
  webLoginCheck: (base: string, windowHint?: string) =>
    call<{ ready: boolean; cookie?: string; user?: YqUser; names: string[] }>('yuque_web_login_check', {
      base,
      windowHint,
    }),
  verify: (token: string, base?: string) => call<YqUser>('yuque_verify', { token, base }),
  spaces: (args: { base: string; token?: string; cookie?: string }) => call<YqRepo[]>('yuque_spaces', args),
  /** 用已保存凭证列出该连接的知识库（连接管理用） */
  spacesStored: (id: string) => call<YqRepo[]>('yuque_spaces_stored', { id }),
  save: (args: {
    id: string
    label: string
    base: string
    token?: string
    cookie?: string
    user: YqUser
    spaces: YqSpace[]
  }) => call<void>('yuque_save', args),
  updateSpaces: (id: string, spaces: YqSpace[]) => call<void>('yuque_update_spaces', { id, spaces }),
  remove: (id: string) => call<void>('yuque_remove', { id }),
  disconnectAll: () => call<void>('yuque_disconnect'),
  docs: (id: string, namespace: string) => call<YqDoc[]>('yuque_docs', { id, namespace }),
  doc: (id: string, namespace: string, slug: string, kind?: string) =>
    call<YqDocDetail>('yuque_doc', { id, namespace, slug, kind }),
  search: (q: string, namespace?: string) => call<YqSearchItem[]>('yuque_search', { q, namespace }),
  /** 文档图片代理下载（防盗链），返回本机缓存绝对路径；失败抛错由调用方兜底 */
  cacheImage: (connId: string, url: string) => call<string>('yuque_cache_image', { connId, url }),
}
