import { invoke } from '@tauri-apps/api/core'

/** 是否运行在 Tauri 桌面环境（否则为浏览器预览） */
export const isTauri = !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

/** 所有 Rust command 调用的统一封装 */
export async function call<T>(cmd: string, args?: object): Promise<T> {
  return invoke<T>(cmd, args as Record<string, unknown> | undefined)
}

export interface AppInfo {
  version: string
  platform: string
  arch: string
}

export function getAppInfo(): Promise<AppInfo> {
  return call<AppInfo>('app_info')
}
