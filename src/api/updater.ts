import { Channel } from '@tauri-apps/api/core'
import { call } from './ipc'

export interface UpdaterStatus {
  version: string
  endpoint: string
}

export interface UpdateInfo {
  version: string
  notes?: string | null
  currentVersion: string
}

/** GitHub Releases 简版检查（托盘弹窗/菜单共用，不依赖签名更新源） */
export interface GithubUpdateInfo {
  currentVersion: string
  /** 无任何发布时为空串 */
  latestVersion: string
  hasUpdate: boolean
  releaseUrl: string
  notes?: string | null
}

export type UpdaterProgress =
  | { kind: 'started'; total: number }
  | { kind: 'progress'; chunk: number }
  | { kind: 'finished' }

export const updaterApi = {
  getStatus: () => call<UpdaterStatus>('updater_get_status'),
  setEndpoint: (endpoint: string) => call<void>('updater_set_endpoint', { endpoint }),
  check: () => call<UpdateInfo | null>('updater_check'),
  githubCheck: () => call<GithubUpdateInfo>('update_check_github'),
  /** 下载并安装，完成后应用自动重启 */
  downloadInstall: (onProgress: (e: UpdaterProgress) => void): Promise<void> => {
    const ch = new Channel<UpdaterProgress>()
    ch.onmessage = onProgress
    return call<void>('updater_download_install', { onProgress: ch })
  },
}
