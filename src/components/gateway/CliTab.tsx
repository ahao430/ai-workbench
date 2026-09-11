import { useEffect, useState } from 'react'
import { App, Button, Card, Tag } from 'antd'
import { ArrowUpCircle, RefreshCw, TerminalSquare } from 'lucide-react'
import { errText } from '../../lib/err'
import { cliApi, type CliCurrent, type CliTool, type CliToolId, type CliUpdateInfo } from '../../api/cli'
import type { Provider } from '../../db/providers'
import CliConfigModal from './CliConfigModal'

interface Props {
  /** 从供应商卡片「CLI」进入时预选该供应商 */
  seedProvider?: Provider | null
  onSeedConsumed: () => void
}

/** CLI 配置：检测/升级本机 AI 编码工具 + 一键把供应商凭据写入其配置 */
export default function CliTab({ seedProvider, onSeedConsumed }: Props) {
  const { message } = App.useApp()
  const [tools, setTools] = useState<CliTool[]>([])
  const [currents, setCurrents] = useState<CliCurrent[]>([])
  const [updates, setUpdates] = useState<CliUpdateInfo[]>([])
  const [checking, setChecking] = useState(false)
  const [upgrading, setUpgrading] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  /** 行内「配置」进入时定向到该工具；为空表示向导内自选 */
  const [modalTool, setModalTool] = useState<CliToolId | null>(null)

  const detect = async () => {
    setLoading(true)
    try {
      const [t, c] = await Promise.all([cliApi.detect(), cliApi.currentStatus()])
      setTools(t)
      setCurrents(c)
      setError(null)
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }

  const checkUpdates = async () => {
    setChecking(true)
    try {
      setUpdates(await cliApi.checkUpdates())
    } catch {
      // 检查更新失败不打断主流程（列表行内会显示错误）
    } finally {
      setChecking(false)
    }
  }

  const refresh = async () => {
    await detect()
    void checkUpdates()
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (seedProvider) {
      setModalOpen(true)
      onSeedConsumed()
    }
  }, [seedProvider, onSeedConsumed])

  const doUpgrade = async (id: string) => {
    setUpgrading(id)
    try {
      const r = await cliApi.upgrade(id)
      if (r.ok) message.success(`${r.label}：${r.message}`)
      else message.error(r.message)
      await refresh()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setUpgrading(null)
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-3 flex items-center justify-between">
        <p className="m-0 text-sm text-gray-500 dark:text-gray-400">
          检测本机 AI 编码 CLI（安装与版本，支持 npm 升级），一键把供应商凭据写入其配置。
        </p>
        <div className="flex shrink-0 gap-2">
          <Button size="small" icon={<RefreshCw size={13} />} onClick={() => void refresh()} loading={loading || checking}>
            重新检测
          </Button>
          <Button
            type="primary"
            size="small"
            icon={<TerminalSquare size={14} />}
            onClick={() => {
              setModalTool(null)
              setModalOpen(true)
            }}
          >
            配置向导
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <Card size="small">
        {tools.map((t) => {
          const cur = currents.find((c) => c.tool === t.id)
          const u = updates.find((x) => x.id === t.id)
          return (
          <div key={t.id} className="flex items-center justify-between border-b border-gray-100 py-2.5 last:border-0 dark:border-gray-800">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="w-28 shrink-0 text-sm font-medium">{t.name}</span>
              {t.installed ? (
                <Tag color="green" style={{ marginRight: 0 }}>
                  已安装{u?.current ? ` · v${u.current}` : t.version ? ` · ${t.version}` : ''}
                </Tag>
              ) : (
                <Tag style={{ marginRight: 0 }}>未检测到</Tag>
              )}
              {!t.installed && (
                <Button
                  size="small"
                  icon={<ArrowUpCircle size={13} />}
                  loading={upgrading === t.id}
                  onClick={() => void doUpgrade(t.id)}
                >
                  安装
                </Button>
              )}
              {u?.updateAvailable && t.installed && (
                <>
                  <Tag color="orange" style={{ marginRight: 0 }}>
                    可升级 → v{u.latest}
                  </Tag>
                  <Button
                    size="small"
                    icon={<ArrowUpCircle size={13} />}
                    loading={upgrading === t.id}
                    onClick={() => void doUpgrade(t.id)}
                  >
                    升级
                  </Button>
                </>
              )}
              {!u?.updateAvailable && u?.latest && t.installed && (
                <span className="shrink-0 text-xs text-gray-400">npm 最新 v{u.latest}</span>
              )}
              {u?.error && (
                <span className="shrink-0 text-xs text-gray-400" title={`检查更新失败：${u.error}`}>
                  版本检查失败
                </span>
              )}
              {cur?.configured ? (
                <span className="truncate text-xs text-indigo-500" title={cur.baseUrl ?? ''}>
                  {cur.providerLabel || cur.baseUrl}
                  {cur.model ? ` · ${cur.model}` : ''}
                </span>
              ) : (
                <span className="text-xs text-gray-400">未配置</span>
              )}
            </div>
            {t.configurable ? (
              <Button
                size="small"
                onClick={() => {
                  setModalTool(t.id as CliToolId)
                  setModalOpen(true)
                }}
              >
                配置
              </Button>
            ) : (
              <span className="pr-1 text-xs text-gray-400" title="Pi 扩展包，经 Pi 安装管理，无需配置供应商">
                Pi 扩展
              </span>
            )}
          </div>
          )
        })}
        {tools.length === 0 && !loading && <p className="py-4 text-center text-sm text-gray-400">检测中…</p>}
      </Card>

      <p className="mt-2 text-xs text-gray-400">
        未检测到不代表未安装——从 Dock/Finder 启动的应用 PATH 与终端不同；也可直接写入配置。
        升级通过 npm 全局安装（npm install -g 包名@latest），需本机可用 npm。
        写入前自动生成 .bak 备份，Codex 不会触碰 auth.json。
      </p>

      <CliConfigModal
        open={modalOpen}
        tools={tools}
        tool={modalTool}
        seedProvider={seedProvider ?? null}
        onCancel={() => setModalOpen(false)}
      />
    </div>
  )
}
