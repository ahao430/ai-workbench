import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isTauri } from '../api/ipc'

/** 缺省协议的地址按 https 补全 */
export function normalizeUrl(u: string): string {
  const t = u.trim()
  if (!t) return ''
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) ? t : `https://${t}`
}

/** Tauri 窗口标签仅允许字母数字与 - / : _；导出供调用方在关闭时复算同一标签 */
export function linkWindowLabel(id: string) {
  return `link-${id.replace(/[^a-zA-Z0-9-/:_]/g, '')}`
}

function windowLabel(id: string) {
  return linkWindowLabel(id)
}

/** 本会话内已打开的链接窗口与各自地址；仅作事件挂载与地址记录，
 * 不作为"窗口还在"的依据（实例可能是已死代理，见 openLinkInApp） */
const openWindows = new Map<string, WebviewWindow>()

const openedUrls = new Map<string, string>()
const linkLocks = new Map<string, Promise<void>>()

/** 同一链接的打开操作串行执行，避免连点产生重复窗口 */
function lockLabel<T>(label: string, job: () => Promise<T>): Promise<T> {
  const prev = linkLocks.get(label) ?? Promise.resolve()
  const run = prev.then(job, job)
  linkLocks.set(label, run.then(
    () => undefined,
    () => undefined,
  ))
  return run
}

/** 当前存活的 webview 窗口标签（原生侧真实状态）。destroyed 事件在 v2 不保证送达
 *  JS 监听器，Map 里的实例可能是已死代理——一切复用判断以此为准 */
async function liveLabels(): Promise<Set<string> | null> {
  try {
    const all = await WebviewWindow.getAll()
    return new Set(all.map((w) => w.label))
  } catch {
    return null
  }
}

/** IPC 探测加超时：对濒死窗口的 invoke 可能永不返回，不加超时会把串行锁卡死，
 *  之后同链接的所有打开操作永远排队（"关闭后再也打不开"的元凶之一） */
function withTimeout<T>(p: Promise<T>, ms = 800): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

/** 在应用内 webview 窗口打开链接；同链接窗口已存在且地址未变则恢复/聚焦（地址变更则关旧重建） */
export function openLinkInApp(
  l: { id: string; name: string; url: string },
  onError?: (msg: string) => void,
): Promise<string | null> {
  const label = windowLabel(l.id)
  return lockLabel(label, async () => {
    const u = normalizeUrl(l.url)
    if (!u) return '该链接未配置地址'
    if (!isTauri) {
      window.open(u, '_blank')
      return null
    }

    // 原生存活状态优先：已死则清掉本地记录直接新建；活着才取实例（getByLabel 为准，
    // Map 实例仅当枚举失败时的兜底）
    const live = await liveLabels()
    let existing: WebviewWindow | null = null
    if (live === null) {
      existing = openWindows.get(label) ?? (await WebviewWindow.getByLabel(label))
    } else if (live.has(label)) {
      existing = (await WebviewWindow.getByLabel(label)) ?? openWindows.get(label) ?? null
    } else {
      openWindows.delete(label)
      openedUrls.delete(label)
    }

    // 地址变了：关旧窗重建（close 也可能不返回，超时后照常新建）
    if (existing && openedUrls.get(label) !== u) {
      void withTimeout(existing.close(), 600)
      await new Promise((r) => setTimeout(r, 150))
      openWindows.delete(label)
      openedUrls.delete(label)
      existing = null
    }

    if (existing) {
      // 复用：逐项探测，任一在超时内返回即视为窗口有效；全超时/报错则新建
      let alive = false
      try {
        const min = await withTimeout(existing.isMinimized(), 800)
        if (min !== null) {
          alive = true
          if (min) await withTimeout(existing.unminimize(), 600)
        }
      } catch {
        /* 单项失败不判死 */
      }
      try {
        if ((await withTimeout(existing.setTitle(l.name), 600)) !== null) alive = true
      } catch {
        /* 同上 */
      }
      try {
        // 复用前显式 show：窗口可能因历史原因处于隐藏态，setFocus 不会唤起隐藏窗口
        if ((await withTimeout(existing.show(), 600)) !== null) alive = true
      } catch {
        /* 同上 */
      }
      try {
        if ((await withTimeout(existing.setFocus(), 600)) !== null) alive = true
      } catch {
        /* 同上 */
      }
      if (alive) {
        openWindows.set(label, existing)
        return null
      }
      openWindows.delete(label)
      openedUrls.delete(label)
    }

    const create = () => {
      const win = new WebviewWindow(label, {
        url: u,
        title: l.name,
        width: 1180,
        height: 800,
        center: true,
      })
      openWindows.set(label, win)
      openedUrls.set(label, u)
      const forget = () => {
        if (openWindows.get(label) === win) {
          openWindows.delete(label)
          openedUrls.delete(label)
        }
      }
      win.once('tauri://destroyed', forget)
      win.once('tauri://error', async (e) => {
        forget()
        const p = e.payload as unknown as { message?: string }
        const msg = p?.message ?? String(e.payload)
        // 标签冲突（旧窗口拆除未完成）：清理后自动重试一次
        if (/already exists/i.test(msg) && !retried) {
          retried = true
          try {
            const stale = await WebviewWindow.getByLabel(label)
            void withTimeout(stale?.close() ?? Promise.resolve(), 600)
            await new Promise((r) => setTimeout(r, 400))
          } catch {
            /* ignore */
          }
          create()
          return
        }
        onError?.(`打开失败：${msg}`)
      })
    }
    let retried = false
    create()
    return null
  })
}
