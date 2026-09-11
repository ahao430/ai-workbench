import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, App as AntApp, Button, Card, Steps, Tooltip } from 'antd'
import { ArrowLeft, ArrowRight, Check, KeyRound, PartyPopper, Rocket } from 'lucide-react'
import { call } from '../api/ipc'
import { errText } from '../lib/err'
import { yxApi, type YxConfig } from '../api/yunxiao'
import { yqApi, type YqConnStatus } from '../api/yuque'
import { cliApi, type CliTool } from '../api/cli'
import { providerRepo } from '../db/providers'
import ProviderOnboarding from '../components/gateway/ProviderOnboarding'
import YunxiaoOnboarding from '../components/yunxiao/YunxiaoOnboarding'
import YuqueOnboarding from '../components/yuque/YuqueOnboarding'

/** 步骤完成态展示行；action 提供「重新配置」入口——已完成的步骤也要能改 */
function Done({
  title,
  desc,
  action,
}: {
  title: string
  desc?: ReactNode
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <Check size={24} />
      </span>
      <div className="text-base font-semibold">{title}</div>
      {desc && <div className="max-w-sm text-sm text-gray-500 dark:text-gray-400">{desc}</div>}
      {action && (
        <Button size="small" className="mt-1" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

const STEP_TITLES = ['AI 渠道', '云效', '语雀', 'AI 开发环境']

export default function SetupPage() {
  const { message } = AntApp.useApp()
  const navigate = useNavigate()
  const [step, setStep] = useState(-1) // -1 = 欢迎页
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  const [yx, setYx] = useState<YxConfig | null>(null)
  const [yq, setYq] = useState<YqConnStatus[]>([])
  const [tools, setTools] = useState<CliTool[]>([])
  const [finishing, setFinishing] = useState(false)
  // 已完成的步骤默认展示完成态；点「重新配置」后置 true 强制显示表单
  const [forceEdit, setForceEdit] = useState(false)

  // 切换步骤时自动退出编辑模式，回到完成态
  useEffect(() => {
    setForceEdit(false)
  }, [step])

  const loadAll = useCallback(() => {
    providerRepo
      .list()
      .then((list) => setProviders(list.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => setProviders([]))
    yxApi
      .status()
      .then(setYx)
      .catch(() => setYx(null))
    yqApi
      .status()
      .then(setYq)
      .catch(() => setYq([]))
    cliApi
      .detect()
      .then(setTools)
      .catch(() => setTools([]))
  }, [])

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 完成并进入工作台（标记 setup_done，含跳过场景） */
  const finish = async () => {
    setFinishing(true)
    try {
      await call<void>('setup_set_done', { done: true })
      navigate('/', { replace: true })
    } catch (e) {
      message.error(errText(e))
    } finally {
      setFinishing(false)
    }
  }

  const aiOk = providers.length > 0
  const yxOk = !!yx?.orgId
  const yqOk = yq.length > 0
  const stepDone = [aiOk, yxOk, yqOk, true]
  const connectedCount = [aiOk, yxOk, yqOk].filter(Boolean).length

  return (
    <div className="flex min-h-full flex-col items-center px-6 py-10">
      <div className="w-full max-w-2xl">
        {step === -1 ? (
          /* 欢迎页 */
          <div className="flex flex-col items-center gap-6 py-16 text-center">
            <img src="/hero/app-icon.png" alt="" className="h-20 w-20 rounded-2xl shadow-lg" />
            <div>
              <div className="text-2xl font-semibold">AI 工作台</div>
              <div className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                你的个人 AI 工作空间——连接 AI 渠道、知识库、Skills 和研发工具
              </div>
              <div className="mt-1 text-xs text-gray-400">配置一次，之后 Chat、项目开发和 AI 工具都可以直接使用</div>
            </div>
            <div className="flex items-center gap-3">
              <Button type="primary" size="large" icon={<Rocket size={16} />} onClick={() => setStep(0)}>
                开始配置
              </Button>
              <Button size="large" loading={finishing} onClick={() => void finish()}>
                直接进入
              </Button>
            </div>
            <div className="text-xs text-gray-400">{STEP_TITLES.join(' · ')}（均可跳过）</div>
          </div>
        ) : step <= 3 ? (
          <>
            <Steps
              size="small"
              current={step}
              className="mb-6"
              items={STEP_TITLES.map((t, i) => ({
                title: t,
                status: stepDone[i] && i !== step ? 'finish' : i === step ? 'process' : 'wait',
              }))}
            />
            <Card>
              {step === 0 &&
                (aiOk && !forceEdit ? (
                  <Done
                    title="AI 渠道已配置"
                    desc={`${providers.map((p) => p.name).join(' · ')} · Chat / 画图 / CLI 可直接使用`}
                    action={{ label: '再添加一个', onClick: () => setForceEdit(true) }}
                  />
                ) : (
                  <div>
                    <Alert
                      type="info"
                      showIcon
                      message="AI 渠道是必需项——配置后才能继续后续步骤"
                      className="mb-3"
                    />
                    <ProviderOnboarding onDone={loadAll} />
                  </div>
                ))}

              {step === 1 &&
                (yxOk && !forceEdit ? (
                  <Done
                    title="云效已连接"
                    desc={`组织：${yx?.orgName || yx?.orgId} · 项目、工作项、代码库、流水线与报工可查看`}
                    action={{ label: '更换令牌', onClick: () => setForceEdit(true) }}
                  />
                ) : (
                  <YunxiaoOnboarding
                    onDone={() => {
                      loadAll()
                      setForceEdit(false)
                    }}
                  />
                ))}

              {step === 2 &&
                (yqOk && !forceEdit ? (
                  <Done
                    title="语雀已连接"
                    desc={`${yq.map((c) => c.label).join(' + ')} · 共关联 ${yq.reduce((n, c) => n + c.spaces.length, 0)} 个知识空间`}
                    action={{ label: '重新配置', onClick: () => setForceEdit(true) }}
                  />
                ) : (
                  <YuqueOnboarding
                    onDone={() => {
                      loadAll()
                      setForceEdit(false)
                    }}
                  />
                ))}

              {step === 3 && (
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-500 text-sm font-bold text-white shadow-sm">
                      CLI
                    </span>
                    <span className="font-medium">AI 开发环境（可选）</span>
                  </div>
                  <p className="mb-3 text-xs text-gray-400">
                    让 AI 帮你写代码时需要配置编程 CLI；安装与「一键配置 AI 渠道」在「AI 服务 → CLI 配置」里随时可做。
                  </p>
                  <div className="mb-4 flex flex-col gap-1.5">
                    {tools.map((t) => (
                      <div key={t.id} className="flex items-center gap-2 text-sm">
                        <span className="w-28 shrink-0 font-medium">{t.name}</span>
                        {t.installed ? (
                          <>
                            <span className="text-emerald-600 dark:text-emerald-400">✓ 已安装</span>
                            <span className="text-xs text-gray-400">{t.version ?? ''}</span>
                          </>
                        ) : (
                          <span className="text-gray-400">未安装</span>
                        )}
                      </div>
                    ))}
                    {tools.length === 0 && <Alert type="info" showIcon message="未检测到任何 CLI 工具，可稍后在「AI 服务」中配置" />}
                  </div>
                  <Button type="primary" onClick={() => setStep(4)}>
                    下一步
                  </Button>
                </div>
              )}
            </Card>

            <div className="mt-4 flex items-center justify-between">
              <Button icon={<ArrowLeft size={14} />} onClick={() => setStep(step - 1)}>
                上一步
              </Button>
              <span className="text-xs text-gray-400">
                {step + 1} / {STEP_TITLES.length} · {connectedCount} 项服务已连接
              </span>
              {step === 0 && !aiOk ? (
                <Tooltip title="AI 渠道是必需项——配置后继续（可在欢迎页选择暂不配置）">
                  <Button disabled icon={<ArrowRight size={14} />} iconPosition="end">
                    配置 AI 渠道后继续
                  </Button>
                </Tooltip>
              ) : (
                <Button
                  type={stepDone[step] ? 'primary' : 'default'}
                  icon={<ArrowRight size={14} />}
                  iconPosition="end"
                  onClick={() => setStep(step + 1)}
                >
                  {stepDone[step] ? '下一步' : '跳过'}
                </Button>
              )}
            </div>
          </>
        ) : (
          /* 完成页 */
          <div className="flex flex-col items-center gap-6 py-12 text-center">
            <span className="grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-orange-500 to-rose-500 text-white shadow-lg">
              <PartyPopper size={30} />
            </span>
            <div>
              <div className="text-xl font-semibold">准备完成</div>
              <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">AI 工作台已经配置完成</div>
            </div>
            <div className="flex w-full max-w-sm flex-col gap-2 text-left text-sm">
              {[
                ['AI 渠道', aiOk ? providers.map((p) => p.name).join(' · ') : '稍后配置', aiOk],
                ['云效', yxOk ? (yx?.orgName ?? '已连接') : '稍后配置', yxOk],
                ['语雀', yqOk ? `${yq.map((c) => c.label).join(' + ')} · ${yq.reduce((n, c) => n + c.spaces.length, 0)} 个知识空间` : '稍后配置', yqOk],
                ['AI 开发环境', tools.some((t) => t.installed) ? '检测到 CLI 工具' : '稍后配置', tools.some((t) => t.installed)],
              ].map(([title, desc, ok]) => (
                <div
                  key={title as string}
                  className="flex items-center gap-2 rounded-xl border border-black/5 bg-white px-4 py-2.5 dark:border-white/10 dark:bg-white/5"
                >
                  <span className={ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}>
                    {ok ? <Check size={15} /> : <KeyRound size={15} className="rotate-135" />}
                  </span>
                  <span className="w-24 shrink-0 font-medium">{title as string}</span>
                  <span className="min-w-0 flex-1 truncate text-gray-500 dark:text-gray-400">{desc as string}</span>
                </div>
              ))}
            </div>
            <Button type="primary" size="large" loading={finishing} onClick={() => void finish()}>
              进入 AI 工作台
            </Button>
            <div className="text-xs text-gray-400">
              之后可在各页面随时调整连接（AI 服务 / 云效 / 语雀）
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
