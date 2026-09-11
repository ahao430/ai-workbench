/** 通用错误与时间格式化工具（原先挂在 api/gateway.ts，网关模块移除后独立成库） */

/** Rust AppError 序列化形态 */
export interface AppErrorShape {
  kind: 'config' | 'unauthorized' | 'api' | 'network' | 'internal'
  message: string
}

export function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message: unknown }).message
    if (typeof m === 'string' && m) return m
  }
  return typeof e === 'string' ? e : '未知错误'
}

/** 本地时区今日 0 点（秒级时间戳） */
export function todayStart(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

/** unix 秒 → 本地日期时间 */
export function fmtDateTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false })
}

/** unix 秒 → 本地日期 */
export function fmtDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString('zh-CN')
}
