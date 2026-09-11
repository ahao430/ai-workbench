import { Progress } from 'antd'
import type { QuotaLimit, QuotaResult } from '../api/quota'

/** 已用百分比配色：≥90 红（告急）/ ≥70 琥珀（预警）/ 其余靛蓝 */
export function barColor(pct: number): string {
  if (pct >= 90) return '#ef4444'
  if (pct >= 70) return '#f59e0b'
  return '#818cf8'
}

/** 剩余百分比配色：≤10 红（告急）/ ≤30 琥珀（预警）/ 其余绿（充足） */
export function remColor(remaining: number): string {
  if (remaining <= 10) return '#ef4444'
  if (remaining <= 30) return '#f59e0b'
  return '#22c55e'
}

function remTextClass(remaining: number): string {
  if (remaining <= 10) return 'text-red-500'
  if (remaining <= 30) return 'text-amber-500'
  return 'text-green-600 dark:text-green-500'
}

/** 重置时间：24h 内只显示时刻，跨天显示日期+时刻 */
export function formatReset(ts: number): string {
  const d = new Date(ts)
  const opts: Intl.DateTimeFormatOptions =
    Date.now() - d.getTime() > 86_400_000 || d.getTime() - Date.now() > 86_400_000
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' }
  return `${d.toLocaleString('zh-CN', opts)} 重置`
}

/** 订阅型额度进度条组（智谱 Coding Plan 的 5h/月窗口等）：展示剩余百分比，标签行 + 通栏进度条 */
export function QuotaLimits({ limits }: { limits: QuotaLimit[] }) {
  if (!limits.length) return null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {limits.map((l, i) => {
        const remaining = Math.max(0, Math.min(100, 100 - Math.round(l.percentage)))
        return (
          <div key={i} className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400" title={l.kind}>
                {l.label}
              </span>
              <span className="flex min-w-0 items-baseline gap-1.5 text-xs">
                {l.nextResetAt > 0 && (
                  <span className="truncate text-gray-400">{formatReset(l.nextResetAt)}</span>
                )}
                <span className={`shrink-0 font-medium ${remTextClass(remaining)}`}>
                  剩余 {remaining}%
                </span>
              </span>
            </div>
            <Progress
              percent={remaining}
              size="small"
              showInfo={false}
              strokeColor={remColor(remaining)}
              style={{ marginBottom: 0 }}
            />
          </div>
        )
      })}
    </div>
  )
}

/** 文本型额度（余额/令牌用量等）：ok=false 时红色提示 */
export function QuotaText({ result }: { result?: QuotaResult }) {
  if (!result) {
    return <span className="text-xs text-gray-400">查询中…</span>
  }
  return (
    <span className={result.ok ? 'text-xs text-indigo-500 dark:text-indigo-400' : 'text-xs text-red-400'}>
      {result.text}
    </span>
  )
}

/** 文本 + 进度条组合（供应商卡片/首页行共用）；有分项进度条时不再重复文本摘要 */
export function QuotaSummary({ result }: { result?: QuotaResult }) {
  const hasLimits = !!result?.limits.length
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {!hasLimits && <QuotaText result={result} />}
      {result?.limits && result.limits.length > 0 && <QuotaLimits limits={result.limits} />}
    </div>
  )
}
