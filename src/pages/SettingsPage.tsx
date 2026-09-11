import { useEffect, useState } from 'react'
import { App, Button, Card, Divider, Input, Popconfirm, Segmented, Select, Spin, Switch, Tag, Typography } from 'antd'
import { CloudUpload, CloudDownload, PlugZap } from 'lucide-react'
import { errText, fmtDateTime } from '../lib/err'
import { getAppInfo, isTauri, type AppInfo } from '../api/ipc'
import { updaterApi } from '../api/updater'
import { appApi, type AppFlags } from '../api/app'

import { webdavApi, type WebDavConfig } from '../api/webdav'
import { useUiStore } from '../stores/ui'

const REFRESH_OPTIONS = [
  { value: 0, label: '关闭' },
  { value: 15, label: '15 秒' },
  { value: 30, label: '30 秒（默认）' },
  { value: 60, label: '60 秒' },
  { value: 300, label: '5 分钟' },
]

const AGENT_CLI_LABEL: Record<string, string> = {
  pi: 'pi',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

/** WebDAV 同步卡片：默认坚果云；同步 config.json + 业务数据库（不含密钥与笔记文件） */
/** 通用：开机自启动 + 关闭最小化到托盘 */
function GeneralCard() {
  const { message } = App.useApp()
  const [flags, setFlags] = useState<AppFlags | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri) return
    appApi
      .flags()
      .then(setFlags)
      .catch(() => {})
  }, [])

  const setFlag = async (key: 'autostart' | 'closeToTray', value: boolean) => {
    setBusy(key)
    try {
      if (key === 'autostart') await appApi.setAutostart(value)
      else await appApi.setCloseToTray(value)
      setFlags((f) => (f ? { ...f, [key]: value } : f))
      message.success('已保存')
    } catch (e) {
      message.error(errText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card style={{ marginTop: 16 }} title={<span className="text-sm">通用</span>}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm">
            开机自动启动
            <span className="ml-2 text-xs text-gray-400">登录系统后自动运行工作台（托盘常驻）</span>
          </span>
          <Switch
            checked={flags?.autostart ?? false}
            loading={busy === 'autostart'}
            disabled={!isTauri}
            onChange={(v) => void setFlag('autostart', v)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm">
            关闭窗口时最小化到托盘
            <span className="ml-2 text-xs text-gray-400">点关闭不退出，托盘右键菜单可退出</span>
          </span>
          <Switch
            checked={flags?.closeToTray ?? true}
            loading={busy === 'closeToTray'}
            disabled={!isTauri}
            onChange={(v) => void setFlag('closeToTray', v)}
          />
        </div>
      </div>
    </Card>
  )
}

const AUTO_SYNC_OPTIONS = [
  { value: 60, label: '每小时' },
  { value: 360, label: '每 6 小时' },
  { value: 1440, label: '每天' },
  { value: 10080, label: '每周' },
]

function WebDavCard() {
  const { message } = App.useApp()
  const [cfg, setCfg] = useState<WebDavConfig>({
    url: 'https://dav.jianguoyun.com/dav/',
    username: '',
    dir: 'ai-workbench-app',
    autoSync: false,
    autoSyncMinutes: 1440,
  })
  const [password, setPassword] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    webdavApi
      .getState()
      .then((st) => {
        setHasPassword(st.hasPassword)
        if (st.config) setCfg(st.config)
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const st = await webdavApi.save({ ...cfg }, password.trim() ? password.trim() : undefined)
      setHasPassword(st.hasPassword)
      if (st.config) setCfg(st.config)
      setPassword('')
      message.success('已保存')
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const r = await webdavApi.test()
      if (r.ok) message.success(r.message)
      else message.warning(r.message)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setTesting(false)
    }
  }

  const upload = async () => {
    setUploading(true)
    try {
      const st = await webdavApi.upload()
      if (st.config) setCfg(st.config)
      message.success('已上传备份到 WebDAV')
    } catch (e) {
      message.error(errText(e))
    } finally {
      setUploading(false)
    }
  }

  const restore = async () => {
    setRestoring(true)
    try {
      await webdavApi.restore()
      message.success('恢复完成，应用即将重启…')
    } catch (e) {
      message.error(errText(e))
      setRestoring(false)
    }
  }

  const saved = !!cfg.username.trim() && (hasPassword || password.trim() !== '')

  return (
    <Card style={{ marginTop: 16 }} title={<span className="text-sm">WebDAV 同步</span>}>
      <p className="mb-3 mt-0 text-xs text-gray-400">
        把应用配置与数据（AI 服务、聊天/画图记录、供应商、知识库配置等）备份到 WebDAV。默认坚果云：
        地址 <code>https://dav.jianguoyun.com/dav/</code>，密码需在坚果云「账户信息 → 安全选项」里创建<strong>应用密码</strong>。
        密钥与笔记文件不参与同步。
      </p>
      <div className="flex flex-col gap-2">
        <Input
          placeholder="服务地址（默认坚果云 https://dav.jianguoyun.com/dav/）"
          value={cfg.url}
          onChange={(e) => setCfg({ ...cfg, url: e.target.value })}
        />
        <div className="flex gap-2">
          <Input
            placeholder="账号（坚果云为登录邮箱/手机号）"
            value={cfg.username}
            onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
          />
          <Input.Password
            placeholder={hasPassword && !password ? '应用密码（已设置，留空不修改）' : '应用密码'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            style={{ width: 240 }}
          />
        </div>
        <Input
          placeholder="远端目录名（默认 ai-workbench-app，自动创建）"
          value={cfg.dir}
          onChange={(e) => setCfg({ ...cfg, dir: e.target.value })}
        />
        <div className="flex items-center justify-between rounded-lg border border-black/5 px-3 py-2 dark:border-white/10">
          <span className="text-sm">
            自动备份
            <span className="ml-2 text-xs text-gray-400">按间隔自动上传备份（后台运行时生效），随上方「保存」一并生效</span>
          </span>
          <div className="flex items-center gap-2">
            <Select
              size="small"
              style={{ width: 110 }}
              value={cfg.autoSyncMinutes ?? 1440}
              disabled={!cfg.autoSync}
              onChange={(v) => setCfg({ ...cfg, autoSyncMinutes: v })}
              options={AUTO_SYNC_OPTIONS}
            />
            <Switch checked={!!cfg.autoSync} onChange={(v) => setCfg({ ...cfg, autoSync: v })} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="primary" size="small" loading={saving} onClick={() => void save()}>
            保存
          </Button>
          <Button size="small" icon={<PlugZap size={13} />} loading={testing} disabled={!saved} onClick={() => void test()}>
            测试连接
          </Button>
          <Button size="small" icon={<CloudUpload size={13} />} loading={uploading} disabled={!saved} onClick={() => void upload()}>
            上传备份
          </Button>
          <Popconfirm
            title="用云端备份覆盖本地数据？"
            description="本地的配置与数据（含聊天记录、供应商、知识库配置）会被云端版本替换，完成后应用自动重启。"
            okText="覆盖恢复"
            okButtonProps={{ danger: true }}
            onConfirm={() => void restore()}
          >
            <Button size="small" danger icon={<CloudDownload size={13} />} loading={restoring} disabled={!saved}>
              恢复到本地
            </Button>
          </Popconfirm>
          <div className="flex-1" />
          {loaded && (
            <Tag color={hasPassword ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>
              {hasPassword ? '密码已设置' : '未设置密码'}
            </Tag>
          )}
        </div>
        {(cfg.lastUploadAt || cfg.lastDownloadAt) && (
          <p className="mb-0 text-xs text-gray-400">
            {cfg.lastUploadAt ? `上次上传：${fmtDateTime(cfg.lastUploadAt)}` : ''}
            {cfg.lastUploadAt && cfg.lastDownloadAt ? '　' : ''}
            {cfg.lastDownloadAt ? `上次恢复：${fmtDateTime(cfg.lastDownloadAt)}` : ''}
          </p>
        )}
      </div>
    </Card>
  )
}

export default function SettingsPage() {
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const quotaRefreshSec = useUiStore((s) => s.quotaRefreshSec)
  const setQuotaRefreshSec = useUiStore((s) => s.setQuotaRefreshSec)
  const agentCli = useUiStore((s) => s.agentCli)
  const setAgentCli = useUiStore((s) => s.setAgentCli)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    if (isTauri) {
      getAppInfo()
        .then(setInfo)
        .catch(() => setInfo(null))
    }
  }, [])

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-10">
      <Typography.Title level={4}>设置</Typography.Title>

      <Card>
        <div className="flex items-center justify-between">
          <span className="text-sm">
            工作台初始化
            <span className="ml-2 text-xs text-gray-400">重新配置 AI 渠道、云效、语雀等服务</span>
          </span>
          <Button
            size="small"
            onClick={() => {
              window.location.hash = '#/setup'
            }}
          >
            重新运行向导
          </Button>
        </div>
        <Divider style={{ margin: '16px 0' }} />
        <div className="flex items-center justify-between">
          <span className="text-sm">外观</span>
          <Segmented
            value={theme}
            onChange={(v) => setTheme(v as typeof theme)}
            options={[
              { label: '亮色', value: 'light' },
              { label: '暗色', value: 'dark' },
            ]}
          />
        </div>
        <Divider style={{ margin: '16px 0' }} />
        <div className="flex items-center justify-between">
          <span className="text-sm">
            额度自动刷新
            <span className="ml-2 text-xs text-gray-400">看板与供应商卡片的余额/订阅额度</span>
          </span>
          <Select
            size="small"
            style={{ width: 130 }}
            value={quotaRefreshSec}
            onChange={setQuotaRefreshSec}
            options={REFRESH_OPTIONS}
          />
        </div>
        <Divider style={{ margin: '16px 0' }} />
        <div className="flex items-center justify-between">
          <span className="text-sm">
            Agent 默认 CLI
            <span className="ml-2 text-xs text-gray-400">Agent 新会话使用的编码工具，会话内不可更改</span>
          </span>
          <Select
            size="small"
            style={{ width: 150 }}
            value={agentCli}
            onChange={setAgentCli}
            options={['pi', 'claude', 'codex', 'opencode'].map((id) => ({
              value: id,
              label: AGENT_CLI_LABEL[id] ?? id,
            }))}
          />
        </div>
        <Divider style={{ margin: '16px 0' }} />
        <div className="flex items-center justify-between">
          <span className="text-sm">版本</span>
          {!isTauri ? (
            <span className="text-sm text-gray-500">浏览器预览模式</span>
          ) : info ? (
            <span className="text-sm text-gray-500">
              v{info.version} · {info.platform}/{info.arch}
            </span>
          ) : (
            <Spin size="small" />
          )}
        </div>
      </Card>

      <GeneralCard />

      <WebDavCard />

      <UpdaterCard />

    </div>
  )
}

/** 关于与更新：当前版本 + 更新源配置 + 检查/下载/安装（完成后自动重启） */
function UpdaterCard() {
  const { message } = App.useApp()
  const [status, setStatus] = useState<{ version: string; endpoint: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const [update, setUpdate] = useState<{ version: string; notes?: string | null; currentVersion: string } | null>(null)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<{ total: number; done: number } | null>(null)

  useEffect(() => {
    if (!isTauri) return
    updaterApi
      .getStatus()
      .then((s) => {
        setStatus(s)
      })
      .catch(() => {})
  }, [])

  const check = async () => {
    setChecking(true)
    setUpdate(null)
    setProgress(null)
    try {
      const r = await updaterApi.check()
      if (r) setUpdate(r)
      else message.success('当前已是最新版本')
    } catch (e) {
      message.error(errText(e))
    } finally {
      setChecking(false)
    }
  }

  const install = async () => {
    setInstalling(true)
    setProgress(null)
    let done = 0
    try {
      await updaterApi.downloadInstall((ev) => {
        if (ev.kind === 'started') setProgress({ total: ev.total, done: 0 })
        else if (ev.kind === 'progress') {
          done += ev.chunk
          setProgress((p) => ({ total: p?.total ?? 0, done }))
        } else if (ev.kind === 'finished') setProgress((p) => ({ total: p?.total ?? 0, done: p?.total ?? done }))
      })
      message.success('更新安装完成，应用即将重启')
    } catch (e) {
      message.error(errText(e))
      setInstalling(false)
    }
  }

  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null

  return (
    <Card style={{ marginTop: 16 }} title={<span className="text-sm">关于与更新</span>}>
      <div className="flex items-center justify-between">
        <span className="text-sm">当前版本</span>
        <span className="text-sm text-gray-500">
          {status ? `v${status.version}` : isTauri ? <Spin size="small" /> : '浏览器预览模式'}
        </span>
      </div>
      <Divider style={{ margin: '16px 0' }} />
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm shrink-0">更新源</span>
        <code className="flex-1 truncate text-xs text-gray-400" title={status?.endpoint}>
          {status?.endpoint ?? '—'}
        </code>
      </div>
      <p className="mb-0 mt-1 text-xs text-gray-400">
        更新源为本仓库 GitHub Releases，内置不可修改；更新包经私钥签名（构建时 TAURI_SIGNING_PRIVATE_KEY 注入），
        latest.json 由发布工作流自动生成。
      </p>
      <Divider style={{ margin: '16px 0' }} />
      <div className="flex items-center gap-3">
        <Button size="small" type="primary" loading={checking} disabled={!isTauri} onClick={() => void check()}>
          检查更新
        </Button>
        {update && (
          <>
            <span className="text-xs text-emerald-600">
              新版本 v{update.version}（当前 v{update.currentVersion}）
            </span>
            <Button size="small" loading={installing} disabled={!isTauri} onClick={() => void install()}>
              下载并安装
            </Button>
          </>
        )}
        {pct !== null && (
          <span className="text-xs text-gray-400">
            {installing ? `下载中 ${pct}%` : '下载完成，安装中…'}
          </span>
        )}
      </div>
      {update?.notes && (
        <div className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/5 p-2 text-xs text-gray-500 dark:bg-white/5">
          {update.notes}
        </div>
      )}
    </Card>
  )
}
