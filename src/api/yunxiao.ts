/** 云效（阿里云 DevOps）API：PAT 接入 + 项目/工作项/仓库/MR/流水线 */

import { call } from './ipc'

export interface YxConfig {
  orgId: string
  orgName: string
  userId: string
  userName: string
}

export interface YxUser {
  id: string
  name: string
  email: string
}

export interface YxOrg {
  id: string
  name: string
}

export interface YxVerifyResult {
  user: YxUser
  orgs: YxOrg[]
}

export interface YxProject {
  id: string
  name: string
  customCode: string
  description: string
  gmtCreate: number
  /** 我在该项目的角色（Rust 侧逐项目查成员表回填）；非成员无此字段 */
  myRole?: string
}

export interface YxNamed {
  identifier: string
  name: string
  displayName: string
}

export interface YxWorkitem {
  id: string
  serialNumber: string
  subject: string
  gmtCreate: number
  gmtModified: number
  status: YxNamed
  assignedTo: YxNamed
  creator: YxNamed
  space: YxNamed
  description?: string
  /** 描述格式（MD / 富文本标记） */
  formatType?: string
  /** 工作项类型（常规需求/线上问题/任务/缺陷等） */
  workitemType?: YxNamed
}

export interface YxWorkitemPage {
  items: YxWorkitem[]
  total: number
}

export interface YxRepo {
  id: number
  name: string
  nameWithNamespace: string
  description: string
  /** private / public */
  visibility: string
  webUrl: string
  sshUrlToRepo: string
  httpUrlToRepo: string
  lastActivityAt: string
}

/** 合并请求（state: UNDER_DEV/UNDER_REVIEW/TO_BE_MERGED/MERGED/CLOSED） */
export interface YxMr {
  localId: number
  title: string
  state: string
  sourceBranch: string
  targetBranch: string
  author: { id: number; name: string; username: string }
  webUrl: string
  detailUrl: string
  createdAt: string
  updatedAt: string
  projectId: number
  hasConflict: boolean
}

/** 实际工时报工记录（gmtStart/gmtEnd 为毫秒时间戳） */
export interface YxEffort {
  id: string
  workitemId: string
  subject: string
  actualTime: number
  workType: string
  description: string
  ownerName: string
  /** 所属项目空间名 */
  spaceName: string
  gmtStart: number
  gmtEnd: number
}

export interface YxApp {
  name: string
  description: string
  /** ISO 时间 */
  gmtCreate: string
  creatorId: string
}

export interface YxEnv {
  name: string
  descriptiveName: string
  state: string
}

/** 研发流程阶段（含绑定流水线与代码源信息） */
export interface YxStage {
  sn: string
  name: string
  envLabel: string
  pipelineId: number
  pipelineName: string
  /** codeup / customGitlab / …；codeup 才有分支下拉 */
  sourceType: string
  /** 代码源仓库名 */
  repoName: string
  /** Codeup 仓库 id（0 = 未携带/非 codeup） */
  repoId: number
  defaultBranch: string
}

export interface YxWorkflow {
  sn: string
  name: string
  stages: YxStage[]
}

/** 分支/标签条目（带指向提交摘要） */
export interface YxRefItem {
  name: string
  isDefault: boolean
  isProtected: boolean
  shortId: string
  title: string
  authorName: string
  committedDate: string
  webUrl: string
}

/** 仓库提交 */
export interface YxCommit {
  shortId: string
  title: string
  authorName: string
  authoredDate: string
  webUrl: string
  /** 父提交 id（图谱连线用） */
  parentIds: string[]
}

/** 流水线运行记录 */
export interface YxPipelineRun {
  pipelineRunId: number
  status: string
  startTime: number
  endTime: number
  triggerMode: number
}

/** 一次运行使用的环境变量（masked 值不下发） */
export interface YxRunParam {
  key: string
  value: string
  masked: boolean
}

export interface YxPipeline {
  pipelineId: number
  pipelineName: string
  createTime: number
}

export interface YxOverview {
  /** 我参与的项目空间（成员表判定，含角色） */
  myProjects: YxProject[]
  /** 我的工作项（仅进行中，按更新时间倒序，上限 20） */
  myWorkitems: YxWorkitem[]
  /** 我的报工记录（统计用；月历走 myEfforts()） */
  myEfforts: YxEffort[]
}

/** 创建个人访问令牌的官方入口（云效工作台 → 个人设置） */
export const YUNXIAO_PAT_URL = 'https://devops.aliyun.com/account/setting/tokens'
/** 云效工作台（浏览器打开） */
export const YUNXIAO_WORKBENCH_URL = 'https://devops.aliyun.com/workbench'

export const yxApi = {
  status: () => call<YxConfig>('yunxiao_status'),
  verify: (token: string) => call<YxVerifyResult>('yunxiao_verify', { token }),
  save: (args: { token: string; orgId: string; orgName: string; userId: string; userName: string }) =>
    call<void>('yunxiao_save', args),
  disconnect: () => call<void>('yunxiao_disconnect'),
  projects: () => call<YxProject[]>('yunxiao_projects'),
  workitems: (args: {
    projectId: string
    category?: string
    keyword?: string
    mine?: boolean
    page?: number
  }) => call<YxWorkitemPage>('yunxiao_workitems', args),
  repos: () => call<YxRepo[]>('yunxiao_repos'),
  mergeRequests: (args: { repoId: number; state?: string; page?: number }) =>
    call<YxMr[]>('yunxiao_merge_requests', args),
  pipelines: (page: number, name?: string) => call<YxPipeline[]>('yunxiao_pipelines', { page, name: name || undefined }),
  /** 单条流水线（收藏视图按 id 逐个拉取） */
  pipelineGet: (id: number) => call<YxPipeline>('yunxiao_pipeline_get', { pipelineId: id }),
  /** 流水线 YAML（isYaml=false 为普通流水线；公开 API 无保存接口，应用内只读） */
  pipelineYaml: (id: number) => call<{ isYaml: boolean; yaml: string }>('yunxiao_pipeline_yaml', { pipelineId: id }),
  /** 流水线总数（服务端二分探测，name 过滤与列表一致） */
  pipelineCount: (name?: string) => call<number>('yunxiao_pipeline_count', { name: name || undefined }),
  /** 应用交付（AppStack）应用列表，nextToken 键集翻页 */
  apps: () => call<YxApp[]>('yunxiao_apps'),
  appEnvs: (appName: string) => call<YxEnv[]>('yunxiao_app_envs', { appName }),
  /** 应用研发流程（工作流 + 阶段 + 阶段流水线的 Webhook token） */
  appWorkflows: (appName: string) => call<YxWorkflow[]>('yunxiao_app_workflows', { appName }),
  /** 执行研发流程阶段（params 为流水线变量，响应带 pipelineRunId） */
  stageExecute: (appName: string, workflowSn: string, stageSn: string, params?: Record<string, string>) =>
    call<{ pipelineId: number; pipelineRunId: number }>('yunxiao_app_stage_execute', {
      appName,
      workflowSn,
      stageSn,
      params,
    }),
  /** 触发云效 Webhook（仅限 flow.aliyun.com / devops.aliyun.com） */
  webhookRun: (url: string) => call<void>('yunxiao_webhook_run', { url }),
  /** 应用自定义 Webhook（存本机 secrets.db） */
  appWebhookGet: (appName: string) => call<string>('yunxiao_app_webhook_get', { appName }),
  appWebhookSave: (appName: string, url: string) =>
    call<void>('yunxiao_app_webhook_save', { appName, url }),
/** 按仓库名找 Codeup 仓库 id（分支下拉用） */
  codeupRepoId: (repoName: string) => call<number | null>('yunxiao_codeup_repo_id', { repoName }),
  /** 仓库引用列表（分支 + 标签） */
  repoRefs: (repoId: number) => call<{ name: string; kind: 'branch' | 'tag' }[]>('yunxiao_repo_refs', { repoId }),
  /** 仓库分支 / 标签（带指向提交摘要，详情抽屉用） */
  repoBranchList: (repoId: number) => call<YxRefItem[]>('yunxiao_repo_branches', { repoId }),
  repoTagList: (repoId: number) => call<YxRefItem[]>('yunxiao_repo_tags', { repoId }),
  /** 仓库提交（按分支） */
  repoCommits: (repoId: number, refName: string, page = 1) =>
    call<YxCommit[]>('yunxiao_repo_commits', { repoId, refName, page }),
  /** 流水线运行记录（阶段的历史运行） */
  pipelineRuns: (pipelineId: number, page = 1) =>
    call<YxPipelineRun[]>('yunxiao_pipeline_runs', { pipelineId, page }),
  /** 一次运行的环境变量（masked 项值为空） */
  pipelineRunParams: (pipelineId: number, runId: number) =>
    call<YxRunParam[]>('yunxiao_pipeline_run_params', { pipelineId, runId }),
  /** 批量判流水线类型（列表接口不返回 type，单条并发查） */
  pipelineTypes: (ids: number[]) =>
    call<{ id: number; isYaml: boolean }[]>('yunxiao_pipeline_types', { ids }),
  pipelineRun: (pipelineId: number) => call<{ runId: string }>('yunxiao_pipeline_run', { pipelineId }),
  overview: () => call<YxOverview>('yunxiao_overview'),
  /** 我的工作项全量（跨我参与的空间聚合，业务空间「我的项目」视图） */
  myWorkitems: () => call<YxWorkitem[]>('yunxiao_my_workitems'),
  /** 我的报工全量（报工月历） */
  myEfforts: () => call<YxEffort[]>('yunxiao_my_efforts'),
}
