import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Drawer, Spin } from 'antd'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { openLinkInApp, linkWindowLabel } from '../../lib/openLink'
import YqSpacePicker from './YqSpacePicker'
import { yqApi, type YqConnStatus, type YqRepo } from '../../api/yuque'
import { errText } from '../../lib/err'

/** 单个连接的管理抽屉：刷新凭证（网页登录）+ 重新勾选知识空间 */
export default function YuqueConnManage({
  conn,
  onClose,
  onChanged,
}: {
  conn: YqConnStatus
  onClose: () => void
  onChanged: () => void
}) {
  const { message } = AntApp.useApp()
  const [repos, setRepos] = useState<YqRepo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(conn.spaces.map((s) => s.namespace)),
  )
  const [reloginWaiting, setReloginWaiting] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    yqApi
      .spacesStored(conn.id)
      .then((list) => {
        setRepos(list)
        // 保留已选；已选但列表中不存在的（如已退出成员）剔除
        const valid = new Set(list.map((r) => r.namespace))
        setPicked((prev) => new Set([...prev].filter((ns) => valid.has(ns))))
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false))
  }, [conn.id])

  useEffect(() => {
    load()
  }, [load])

  /** 网页登录刷新凭证：打开该连接专属登录窗口 + 轮询检测，成功后沿用当前空间选择 */
  const loginWinId = `yuque-login-${conn.id}`
  const startRelogin = () => {
    setError(null)
    void openLinkInApp(
      { id: loginWinId, name: `语雀登录 · ${conn.label}`, url: `https://${conn.base}/login` },
      (msg) => {
        setError(msg)
        setReloginWaiting(false)
      },
    )
    setReloginWaiting(true)
  }

  useEffect(() => {
    if (!reloginWaiting) return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const r = await yqApi.webLoginCheck(conn.base, linkWindowLabel(loginWinId))
          if (!r.ready || !r.cookie) return
          setReloginWaiting(false)
          await yqApi.save({
            id: conn.id,
            label: conn.label,
            base: conn.base,
            cookie: r.cookie,
            user: r.user ?? { id: 0, login: conn.userLogin, name: conn.userName, avatarUrl: '' },
            spaces: pickedSpaces(),
          })
          message.success(`${conn.label} 凭证已刷新`)
          import('@tauri-apps/api/webviewWindow')
            .then(({ WebviewWindow }) => WebviewWindow.getByLabel(linkWindowLabel(loginWinId)))
            .then((w) => w?.close())
            .catch(() => {})
          onChanged()
          load()
        } catch (e) {
          setError(errText(e))
          setReloginWaiting(false)
        }
      })()
    }, 1500)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloginWaiting, conn.id, conn.base])

  /** 当前勾选的空间列表 */
  const pickedSpaces = () =>
    repos
      .filter((r) => picked.has(r.namespace))
      .map((r) => ({
        id: r.id,
        namespace: r.namespace,
        name: r.name,
        description: r.description,
        ownerName: r.ownerName,
        ownerKind: r.ownerKind,
      }))

  const saveSpaces = async () => {
    setSaving(true)
    try {
      await yqApi.updateSpaces(conn.id, pickedSpaces())
      message.success('知识空间已更新')
      onChanged()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      title={
        <span>
          管理 · {conn.label}
          <span className="ml-2 text-xs font-normal text-gray-400">{conn.base}</span>
        </span>
      }
      width={560}
      open
      onClose={onClose}
      destroyOnClose
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-black/5 p-3 dark:border-white/10">
          <div className="mb-1 text-sm font-medium">刷新凭证</div>
          <div className="mb-2 text-xs text-gray-400">
            会话过期导致获取失败时，重新登录一次即可；在弹出的登录窗口任选微信/短信/密码完成。
          </div>
          <Button
            icon={<ExternalLink size={13} />}
            loading={reloginWaiting}
            onClick={startRelogin}
          >
            {reloginWaiting ? '等待登录完成…' : '打开登录窗口刷新凭证'}
          </Button>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">关联知识空间（{picked.size}）</span>
            <Button
              size="small"
              icon={<RefreshCw size={12} className={loading ? 'animate-spin' : ''} />}
              onClick={load}
            >
              刷新列表
            </Button>
          </div>
          {error && (
            <Alert
              type="error"
              showIcon
              message={error}
              className="mb-3"
              action={
                <Button size="small" onClick={startRelogin}>
                  重新登录
                </Button>
              }
              closable
              onClose={() => setError(null)}
            />
          )}
          {loading ? (
            <div className="grid h-32 place-items-center">
              <Spin />
            </div>
          ) : (
            <div className="mb-3 max-h-72 overflow-y-auto">
              <YqSpacePicker repos={repos} picked={picked} onChange={setPicked} />
            </div>
          )}
          <Button type="primary" loading={saving} disabled={loading} onClick={() => void saveSpaces()}>
            保存空间选择
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
