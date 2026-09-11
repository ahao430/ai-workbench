import { call } from './ipc'

export interface AppFlags {
  autostart: boolean
  closeToTray: boolean
}

/** 定时任务：schedule = "daily" | "weekly:1,3" | "interval:N"（分钟） */
export interface ScheduledTask {
  id: string
  name: string
  /** webhook | notify | open_url（webdav_backup 为已下线的遗留值） */
  kind: string
  param: string
  schedule: string
  time: string
  enabled: boolean
  lastRunAt?: number | null
}

export const appApi = {
  flags: () => call<AppFlags>('settings_get_flags'),
  setAutostart: (enabled: boolean) => call<void>('settings_set_autostart', { enabled }),
  setCloseToTray: (enabled: boolean) => call<void>('settings_set_close_to_tray', { enabled }),
  tasks: () => call<ScheduledTask[]>('tasks_list'),
  saveTasks: (tasks: ScheduledTask[]) => call<void>('tasks_save', { tasks }),
}

/** 调度的可读描述 */
export function scheduleText(t: ScheduledTask): string {
  if (t.schedule === 'daily') return `每天 ${t.time}`
  if (t.schedule.startsWith('weekly:')) {
    const names = ['一', '二', '三', '四', '五', '六', '日']
    const days = t.schedule
      .slice('weekly:'.length)
      .split(',')
      .map((d) => names[Number(d.trim()) - 1] ?? '?')
      .join('、')
    return `每周${days} ${t.time}`
  }
  if (t.schedule.startsWith('interval:')) {
    const n = Number(t.schedule.slice('interval:'.length))
    return n % 60 === 0 ? `每 ${n / 60} 小时` : `每 ${n} 分钟`
  }
  return t.schedule
}

export const TASK_KINDS = [
  { value: 'notify', label: '系统通知提醒', hasParam: true, paramPlaceholder: '提醒内容，如：该写周报了' },
  { value: 'open_url', label: '打开链接', hasParam: true, paramPlaceholder: 'https://…（如写周报地址）' },
  { value: 'webhook', label: '调用 Webhook', hasParam: true, paramPlaceholder: 'https://…（到点 POST 任务信息）' },
]

/** 已下线的遗留动作：旧配置里可能出现，列表上仍显示可读名称，新建/切换不再提供 */
export const LEGACY_KIND_LABELS: Record<string, string> = {
  webdav_backup: 'WebDAV 备份（已下线）',
}
