import { call } from './ipc'

export interface WebDavConfig {
  /** 服务地址，默认坚果云 https://dav.jianguoyun.com/dav/ */
  url: string
  username: string
  /** 远端目录名（自动创建），默认 ai-workbench-app */
  dir: string
  lastUploadAt?: number | null
  lastDownloadAt?: number | null
  /** 到点自动上传备份（后台调度器按 autoSyncMinutes 检查） */
  autoSync?: boolean | null
  /** 自动备份间隔（分钟，默认 1440 = 每天） */
  autoSyncMinutes?: number | null
}

export interface WebDavState {
  config: WebDavConfig | null
  hasPassword: boolean
}

export interface WebDavTestResult {
  ok: boolean
  message: string
}

export const webdavApi = {
  getState: () => call<WebDavState>('webdav_get_config'),
  /** password 传 undefined = 不修改，空串 = 清除 */
  save: (config: WebDavConfig, password?: string) => call<WebDavState>('webdav_save_config', { config, password }),
  test: () => call<WebDavTestResult>('webdav_test'),
  upload: () => call<WebDavState>('webdav_upload'),
  /** 恢复成功后应用会自动重启 */
  restore: () => call<void>('webdav_restore'),
}
