/**
 * 托盘用量面板（点击菜单栏 Z 图标弹出，失焦自动收起）。
 * codex bar 风格：分组卡片 + 进度条 + 键值统计；数据源与主窗口一致
 * （供应商额度 quota_check）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { RefreshCw, ExternalLink } from 'lucide-react'
import { getCurrentWindow, Window } from '@tauri-apps/api/window'
import { openUrl } from '@tauri-apps/plugin-opener'
import { errText } from '../lib/err'
import { call, isTauri } from '../api/ipc'
import { cliApi, type CliCurrent, type CliTool, type CliToolId } from '../api/cli'
import { updaterApi } from '../api/updater'
import { providerRepo, type Provider } from '../db/providers'
import { fetchProviderQuotas } from '../hooks/useQuota'
import { BrandAvatar } from '../lib/brand'
import zhipuPng from '../assets/brands/zhipu.png'
import type { QuotaResult } from '../api/quota'

/** 重置时间：1 小时内 "in Nm"，一天内 "in XhYm"，更远给日期时间 */
function resetText(ms: number): string {
  if (!ms) return '不限'
  const sec = Math.floor(ms / 1000) - Math.floor(Date.now() / 1000)
  if (sec <= 0) return '即将重置'
  if (sec < 3600) return `in ${Math.max(1, Math.round(sec / 60))}m`
  if (sec < 86400) {
    const h = Math.floor(sec / 3600)
    const m = Math.round((sec % 3600) / 60)
    return `in ${h}h${m}m`
  }
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 数值文字颜色（与 AI 服务页一致）：剩余 ≤10 红、≤30 琥珀、其余绿 */
function pctText(pct: number): string {
  if (pct <= 10) return 'text-rose-500'
  if (pct <= 30) return 'text-amber-500'
  return 'text-emerald-500'
}

function barColor(pct: number): string {
  if (pct <= 10) return 'bg-rose-500'
  if (pct <= 30) return 'bg-amber-500'
  return 'bg-emerald-500'
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-gray-400 dark:text-gray-500">
      {children}
    </div>
  )
}

/** 面板里展示当前配置的 CLI（omp 复用 pi 的配置，故 applyTool 指向 pi） */
const TOOL_ROWS: { id: string; name: string; applyTool: CliToolId }[] = [
  { id: 'claude', name: 'Claude Code', applyTool: 'claude' },
  { id: 'codex', name: 'Codex', applyTool: 'codex' },
  { id: 'opencode', name: 'OpenCode', applyTool: 'opencode' },
  { id: 'pi', name: 'Pi', applyTool: 'pi' },
  { id: 'oh-my-pi', name: 'Oh My Pi', applyTool: 'pi' },
]

export default function TrayPanelPage() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [quotas, setQuotas] = useState<Record<string, QuotaResult>>({})
  const [loading, setLoading] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number>(0)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<{ checking: boolean; text?: string; url?: string; version?: string }>({ checking: false })
  const [cliTools, setCliTools] = useState<Record<string, CliTool>>({})
  const [currents, setCurrents] = useState<Record<string, CliCurrent>>({})

  const load = useCallback(async () => {
    if (!isTauri) return
    setLoading(true)
    // 面板刷新的同时更新系统栏托盘文字（两条数据链路同源，保持一致）
    void call('tray_refresh').catch(() => {})
    void updaterApi
      .getStatus()
      .then((s) => setVersion(s.version))
      .catch(() => {})
    cliApi
      .detect()
      .then((list) => setCliTools(Object.fromEntries(list.map((t) => [t.id, t]))))
      .catch(() => {})
    cliApi
      .currentStatus()
      .then((list) => setCurrents(Object.fromEntries(list.map((c) => [c.tool, c]))))
      .catch(() => {})
    try {
      const list = await providerRepo.list().catch(() => [] as Provider[])
      if (list.length) setProviders(list)
      const targets = list.filter((p) => p.enabled === 1 && p.quotaType)
      if (targets.length) {
        const r = await fetchProviderQuotas(targets)
        setQuotas((prev) => ({ ...prev, ...r }))
      }
      setUpdatedAt(Date.now())
    } finally {
      setLoading(false)
    }
  }, [])

  const checkUpdate = async () => {
    setUpdate({ checking: true })
    try {
      const r = await updaterApi.githubCheck()
      if (r.hasUpdate) {
        setUpdate({ checking: false, text: `新版本 v${r.latestVersion} 可用`, url: r.releaseUrl, version: r.latestVersion })
      } else if (!r.latestVersion) {
        setUpdate({ checking: false, text: '暂无发布版本' })
      } else {
        setUpdate({ checking: false, text: `已是最新版本（v${r.currentVersion}）` })
      }
    } catch (e) {
      setUpdate({ checking: false, text: errText(e) })
    }
  }

  // ===== CLI 当前配置展示（切换请到主窗口 CLI 向导 / Agent 会话设置） =====

  useEffect(() => {
    void load()
    // 面板每次被托盘唤起时窗口获得焦点，届时拉一次最新数据
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  // 面板展示全部启用中的供应商（与 show_on_tray 无关，该开关只影响系统菜单栏）
  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled === 1), [providers])
  const zhipu = useMemo(
    () => enabledProviders.find((p) => p.quotaType === 'zhipu-coding'),
    [enabledProviders],
  )
  const zhipuLimits = zhipu ? quotas[zhipu.id]?.limits ?? [] : []
  const others = enabledProviders.filter((p) => p.quotaType !== 'zhipu-coding')
  const updatedLabel = updatedAt
    ? new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '--:--:--'

  const openMain = async () => {
    try {
      const main = await Window.getByLabel('main')
      if (main) {
        await main.show()
        await main.unminimize()
        await main.setFocus()
      }
      await getCurrentWindow().hide()
    } catch {
      /* 非 tauri 环境忽略 */
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#f5f5f7]/90 text-[13px] text-gray-900 shadow-xl backdrop-blur-2xl dark:bg-[#232329]/90 dark:text-gray-100">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-black/5 px-4 py-2.5 dark:border-white/10">
        <div className="flex items-center gap-1.5 font-semibold">
          <span className="flex h-4 w-4 items-center justify-center rounded bg-indigo-500 text-[10px] font-bold text-white">
            Z
          </span>
          AI 用量
        </div>
        <div className="flex items-center gap-2 text-[11px] text-gray-400">
          <span>{updatedLabel}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            立即刷新
          </button>
        </div>
      </div>

      {/* 分组明细 */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3.5">
        {zhipu && (
          <section>
            <SectionTitle>
              <img src={zhipuPng} width={16} height={16} className="rounded-sm" alt="智谱" />
              智谱 GLM
            </SectionTitle>
            {zhipuLimits.length === 0 ? (
              <div className="rounded-xl bg-white px-3 py-2.5 text-xs text-gray-400 shadow-sm dark:bg-white/5">
                {loading ? '查询中…' : '暂无额度数据'}
              </div>
            ) : (
              zhipuLimits.map((l) => {
                // API 返回已用百分比；展示用剩余
                const remaining = 100 - l.percentage
                return (
                  <div key={l.label} className="py-1 first:pt-0 last:pb-0">
                    <div className="flex items-baseline justify-between">
                      <span>{l.label}</span>
                      <span className="tabular-nums">
                        <b className={`text-[14px] ${pctText(remaining)}`}>{remaining}%</b>{' '}
                        <span className="text-[11px] text-gray-400">· {resetText(l.nextResetAt)}</span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                      <div
                        className={`h-full rounded-full transition-all ${barColor(remaining)}`}
                        style={{ width: `${Math.min(100, Math.max(2, remaining))}%` }}
                      />
                    </div>
                  </div>
                )
              })
            )}
          </section>
        )}

        {others.length > 0 && (
          <section>
            <SectionTitle>其他供应商</SectionTitle>
            <div className="space-y-2">
              {others.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-xl bg-white px-3 py-2.5 shadow-sm dark:bg-white/5"
                >
                  <span className="flex items-center gap-2">
                    <BrandAvatar p={p} size={18} />
                    {p.name}
                  </span>
                  <span className="font-semibold tabular-nums">
                    {p.quotaType ? (quotas[p.id]?.text ?? '—') : <span className="font-normal text-gray-400">未配置额度查询</span>}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <SectionTitle>CLI 工具 · 供应商 / 模型</SectionTitle>
          <div className="rounded-xl bg-white px-3 shadow-sm dark:bg-white/5">
            {TOOL_ROWS.map((row) => {
              const tool = cliTools[row.id]
              const cur = currents[row.applyTool]
              // 右侧：当前供应商 · 模型（omp 复用 pi 的配置展示）
              const label = cur?.configured
                ? [cur.providerLabel, cur.model].filter(Boolean).join(' · ') || '已配置'
                : '未配置'
              return (
                <div
                  key={row.id}
                  className="flex items-center justify-between gap-2 border-b border-black/5 py-1.5 last:border-b-0 dark:border-white/10"
                >
                  <span className="shrink-0 text-xs font-medium">
                    {row.name}
                    {!tool?.installed && <span className="ml-1 text-[10px] font-normal text-gray-400">未安装</span>}
                  </span>
                  <span
                    className={`min-w-0 truncate text-[11px] ${cur?.configured ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400'}`}
                    title={label}
                  >
                    {label}
                  </span>
                </div>
              )
            })}
          </div>
        </section>

        {!zhipu && others.length === 0 && (
          <div className="py-10 text-center text-xs text-gray-400">
            {loading ? '加载中…' : '在「AI 服务」中配置供应商额度查询后展示'}
          </div>
        )}
      </div>

      {/* 底部操作 */}
      <div className="border-t border-black/5 px-4 py-2.5 dark:border-white/10">
        <div className="mb-2 flex items-center justify-between text-[11px] text-gray-400">
          <span>AI工作台 v{version || '…'}</span>
          {update.url ? (
            <button
              type="button"
              onClick={() => void openUrl(update.url!)}
              className="font-medium text-indigo-500 hover:underline"
            >
              v{update.version} · 去下载
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void checkUpdate()}
              disabled={update.checking}
              className="rounded px-1.5 py-0.5 hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
            >
              {update.checking ? '检查中…' : '检测升级'}
            </button>
          )}
        </div>
        {update.text && !update.url && (
          <div className="mb-2 truncate text-[11px] text-gray-400" title={update.text}>
            {update.text}
          </div>
        )}
        <button
          type="button"
          onClick={() => void openMain()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-500 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-600"
        >
          <ExternalLink size={13} />
          打开 AI 工作台
        </button>
      </div>
    </div>
  )
}
