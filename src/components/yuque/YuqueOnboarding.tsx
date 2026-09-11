import { useEffect, useMemo, useState } from 'react'
import { Alert, App as AntApp, Button, Card, Form, Input, Radio, Steps } from 'antd'
import { ExternalLink, Info } from 'lucide-react'
import { openLinkInApp, linkWindowLabel } from '../../lib/openLink'
import YqSpacePicker from './YqSpacePicker'
import {
  YUQUE_PERSONAL_BASE,
  yqApi,
  type YqRepo,
  type YqUser,
} from '../../api/yuque'
import { errText } from '../../lib/err'

type Env = 'personal' | 'custom'
type AuthMode = 'web' | 'password' | 'token'

/** 未接入时的引导：选环境 → 网页登录（默认，支持微信/短信/滑块）/ 账号密码 / Token → 选择知识空间 */
export default function YuqueOnboarding({ onDone }: { onDone: () => void }) {
  const { message } = AntApp.useApp()
  const [env, setEnv] = useState<Env>('personal')
  const [customBase, setCustomBase] = useState('')
  const [mode, setMode] = useState<AuthMode>('web')
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [foundNames, setFoundNames] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [user, setUser] = useState<YqUser | null>(null)
  const [cookie, setCookie] = useState<string | null>(null)
  const [repos, setRepos] = useState<YqRepo[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const base = env === 'personal' ? YUQUE_PERSONAL_BASE : customBase.trim()
  /** 连接 id/展示名：个人=personal、自定义=custom:{domain} */
  const connId = env === 'personal' ? 'personal' : `custom:${base}`
  const connLabel = env === 'personal' ? '个人语雀' : base || '自定义'
  /** 登录窗口按连接区分：个人/自定义各自的窗口与登录态互不干扰 */
  const loginWinId = `yuque-login-${connId}`

  const pickedSpaces = useMemo(
    () =>
      repos
        .filter((r) => picked.has(r.namespace))
        .map((r) => ({
          id: r.id,
          namespace: r.namespace,
          name: r.name,
          description: r.description,
          ownerName: r.ownerName,
          ownerKind: r.ownerKind,
        })),
    [repos, picked],
  )

  const loadSpaces = async (args: { token?: string; cookie?: string }) => {
    const list = await yqApi.spaces({ base, ...args })
    setRepos(list)
    if (list.length > 0) setPicked(new Set([list[0].namespace]))
  }

  /** 打开应用内登录窗口并轮询会话 Cookie（用户在窗口里用微信/短信/密码+滑块登录） */
  const startWebLogin = () => {
    if (!base) {
      setError('请先填写语雀域名')
      return
    }
    setError(null)
    setFoundNames([])
    void openLinkInApp(
      { id: loginWinId, name: `语雀登录 · ${connLabel}`, url: `https://${base}/login` },
      (msg) => {
        setError(msg)
        setWaiting(false)
      },
    )
    setWaiting(true)
  }

  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const r = await yqApi.webLoginCheck(base, linkWindowLabel(loginWinId))
          setFoundNames(r.names ?? [])
          if (r.ready && r.cookie) {
            setWaiting(false)
            setUser(r.user ?? { id: 0, login: '', name: '', avatarUrl: '' })
            setCookie(r.cookie)
            setToken('')
            message.success('语雀登录成功')
            // 登录窗口用完即关（按连接区分的标签）
            import('@tauri-apps/api/webviewWindow')
              .then(({ WebviewWindow }) => WebviewWindow.getByLabel(linkWindowLabel(loginWinId)))
              .then((w) => w?.close())
              .catch(() => {})
            try {
              const list = await yqApi.spaces({ base, cookie: r.cookie })
              setRepos(list)
              if (list.length > 0) setPicked(new Set([list[0].namespace]))
            } catch (e2) {
              setError(`登录成功，但知识库列表获取失败：${errText(e2)}`)
            }
          }
        } catch {
          /* 登录窗口未完成前轮询继续 */
        }
      })()
    }, 1500)
    return () => clearInterval(timer)
  }, [waiting, base, message])

  const doPasswordLogin = async () => {
    if (!base) {
      setError('请填写语雀域名')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const r = await yqApi.login(base, account, password)
      setUser(r.user)
      setCookie(r.cookie)
      setToken('')
      message.success(r.user.name ? `登录成功：${r.user.name}` : '登录成功')
      await loadSpaces({ cookie: r.cookie })
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }

  const doTokenVerify = async () => {
    if (!base) {
      setError('请填写语雀域名')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const u = await yqApi.verify(token, base)
      setUser(u)
      setCookie(null)
      message.success(`验证通过：${u.name || u.login}`)
      await loadSpaces({ token: token.trim() })
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }

  const doSave = async () => {
    if (!user) return
    setSaving(true)
    setError(null)
    try {
      await yqApi.save({
        id: connId,
        label: connLabel,
        base,
        token: cookie ? undefined : token.trim() || undefined,
        cookie: cookie ?? undefined,
        user,
        spaces: pickedSpaces,
      })
      message.success(
        pickedSpaces.length
          ? `已接入${connLabel}，关联 ${pickedSpaces.length} 个知识空间`
          : `已接入${connLabel}（未选择知识空间）`,
      )
      onDone()
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-8 pt-10">
      <Card>
        <div className="mb-1 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-sm font-bold text-white shadow-sm">
            雀
          </span>
          <span className="font-medium">接入语雀</span>
        </div>
        <p className="mb-5 text-xs text-gray-400">
          连接后可浏览、搜索、阅读你的知识库文档；只勾选需要的知识空间。账号密码登录后只保存会话，密码不落盘。
        </p>

        <Steps
          size="small"
          direction="vertical"
          current={user ? 2 : 1}
          className="mb-5"
          items={[
            {
              title: '选择环境与登录方式',
              description: (
                <div className="pb-1">
                  <Radio.Group
                    value={env}
                    onChange={(e) => setEnv(e.target.value)}
                    className="mb-2"
                    options={[
                      { value: 'personal', label: '个人语雀（www）' },
                      { value: 'custom', label: '自定义' },
                    ]}
                  />
                  {env === 'custom' && (
                    <Input
                      size="small"
                      className="mb-2 w-64"
                      placeholder="语雀域名，如 xxx.yuque.com"
                      value={customBase}
                      onChange={(e) => setCustomBase(e.target.value)}
                    />
                  )}
                  <Radio.Group
                    value={mode}
                    onChange={(e) => {
                      setMode(e.target.value)
                      setWaiting(false)
                      setError(null)
                    }}
                    options={[
                      { value: 'web', label: '网页登录（推荐）' },
                      { value: 'password', label: '账号密码' },
                      { value: 'token', label: 'Token（会员/管理员）' },
                    ]}
                  />
                  {mode === 'web' && (
                    <div className="mt-1 text-[11px] text-gray-400">
                      在弹出的语雀登录页里任选微信扫码 / 手机验证码 / 密码登录（滑块由你手动完成），登录后这里自动继续。
                    </div>
                  )}
                  {mode === 'password' && (
                    <div className="mt-1 text-[11px] text-gray-400">
                      部分账号密码登录会触发滑块验证，建议改用「网页登录」。
                    </div>
                  )}
                  {mode === 'token' && (
                    <div className="mt-1 text-[11px] text-gray-400">
                      个人版创建 Token 需语雀会员；团队版需管理员授权。Token 在网页「设置 → Token」创建。
                    </div>
                  )}
                </div>
              ),
            },
            {
              title: mode === 'web' ? '网页登录' : mode === 'password' ? '登录语雀' : '粘贴并验证 Token',
              description: user ? (
                <span className="text-xs text-emerald-600 dark:text-emerald-400">✓ 已登录</span>
              ) : (
                <div className="pb-1 pt-1">
                  {mode === 'web' ? (
                    <div className="flex flex-col items-start gap-2">
                      <Button type="primary" icon={<ExternalLink size={13} />} loading={waiting} onClick={startWebLogin}>
                        {waiting ? '等待登录完成…（在弹出的窗口里操作）' : '打开语雀登录窗口'}
                      </Button>
                      {waiting && (
                        <span className="text-xs text-gray-400">
                          支持微信扫码 / 手机验证码 / 密码+滑块；登录成功后自动进入下一步
                          {foundNames.length > 0 && (
                            <span className="ml-1 font-mono" title="登录窗口当前携带的 Cookie（诊断用）">
                              （已检测到 Cookie：{foundNames.join(', ')}）
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  ) : mode === 'password' ? (
                    <Form onFinish={doPasswordLogin} layout="vertical" className="max-w-sm">
                      <Form.Item label="账号" rules={[{ required: true, message: '请输入账号' }]} style={{ marginBottom: 12 }}>
                        <Input
                          autoComplete="username"
                          placeholder="手机号 / 邮箱 / 登录名"
                          value={account}
                          onChange={(e) => setAccount(e.target.value)}
                        />
                      </Form.Item>
                      <Form.Item label="密码" rules={[{ required: true, message: '请输入密码' }]} style={{ marginBottom: 12 }}>
                        <Input.Password
                          autoComplete="current-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                      </Form.Item>
                      <Button type="primary" htmlType="submit" loading={loading}>
                        登录并连接
                      </Button>
                    </Form>
                  ) : (
                    <Input.Search
                      className="max-w-md"
                      placeholder="粘贴语雀 Token"
                      enterButton="验证"
                      value={token}
                      onChange={(e) => {
                        setToken(e.target.value)
                        setUser(null)
                        setRepos([])
                      }}
                      loading={loading}
                      onSearch={() => void doTokenVerify()}
                    />
                  )}
                </div>
              ),
            },
            {
              title: '选择知识空间',
              description: user ? (
                <div className="pb-1">
                  {repos.length === 0 ? (
                    <Alert type="warning" showIcon message="没有可访问的知识库" className="mb-3" />
                  ) : (
                    <div className="mb-3 max-h-72 overflow-y-auto">
                      <YqSpacePicker repos={repos} picked={picked} onChange={setPicked} />
                    </div>
                  )}
                  <Button type="primary" loading={saving} onClick={() => void doSave()}>
                    {pickedSpaces.length ? `接入并关联 ${pickedSpaces.length} 个空间` : '暂不关联空间，仅接入'}
                  </Button>
                </div>
              ) : (
                <span className="text-xs text-gray-400">登录成功后选择要关联的知识空间</span>
              ),
            },
          ]}
        />

        {user && (
          <Alert
            type="success"
            showIcon
            className="mb-4"
            message={`身份：${user.name || user.login || '已登录'} · ${base}`}
          />
        )}
        {error && (
          <Alert type="error" showIcon message={error} className="mt-4" closable onClose={() => setError(null)} />
        )}
      </Card>
      <div className="mt-3 flex items-center gap-1.5 text-xs text-gray-400">
        <Info size={13} />
        语雀接口限流 100 次/小时，本应用全部按需请求；后续可在语雀页调整关联空间或断开。
      </div>
    </div>
  )
}
