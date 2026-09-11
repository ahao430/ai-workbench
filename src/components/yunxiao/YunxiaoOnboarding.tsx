import { useMemo, useState } from 'react'
import { Alert, Button, Card, Input, Radio, Steps, App as AntApp } from 'antd'
import { Info } from 'lucide-react'
import { openLinkInApp } from '../../lib/openLink'
import { YUNXIAO_PAT_URL, yxApi, type YxVerifyResult } from '../../api/yunxiao'
import { errText } from '../../lib/err'

/** 未接入时的引导：带 PAT 创建步骤指引导航，验证后选组织接入 */
export default function YunxiaoOnboarding({ onDone }: { onDone: () => void }) {
  const { message } = AntApp.useApp()
  const [token, setToken] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verified, setVerified] = useState<YxVerifyResult | null>(null)
  const [orgId, setOrgId] = useState('')

  const orgs = verified?.orgs ?? []
  const selectedOrg = useMemo(() => orgs.find((o) => o.id === orgId), [orgs, orgId])

  const doVerify = async () => {
    setVerifying(true)
    setError(null)
    try {
      const res = await yxApi.verify(token)
      setVerified(res)
      // 只有一个组织时自动选中；否则默认第一个
      setOrgId(res.orgs[0]?.id ?? '')
      message.success(`验证通过：${res.user.name || res.user.id}`)
    } catch (e) {
      setError(errText(e))
    } finally {
      setVerifying(false)
    }
  }

  const doSave = async () => {
    if (!verified || !selectedOrg) return
    setSaving(true)
    setError(null)
    try {
      await yxApi.save({
        token: token.trim(),
        orgId: selectedOrg.id,
        orgName: selectedOrg.name,
        userId: verified.user.id,
        userName: verified.user.name,
      })
      message.success(`已接入云效：${selectedOrg.name}`)
      onDone()
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const openPatPage = () => {
    void openLinkInApp(
      { id: 'yunxiao-pat', name: '云效 · 个人访问令牌', url: YUNXIAO_PAT_URL },
      (msg) => message.error(msg),
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-8 pt-10">
      <Card>
        <div className="mb-1 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-500 text-sm font-bold text-white shadow-sm">
            云
          </span>
          <span className="font-medium">接入云效 DevOps</span>
        </div>
        <p className="mb-5 text-xs text-gray-400">
          通过个人访问令牌（PAT）接入项目空间、代码库与流水线；令牌只存本机密钥库，不参与同步。
        </p>

        <Steps
          size="small"
          direction="vertical"
          current={verified ? 2 : token ? 1 : 0}
          className="mb-5"
          items={[
            {
              title: '创建个人访问令牌',
              description: (
                <div className="pb-1 text-xs text-gray-500 dark:text-gray-400">
                  登录云效 → 右上角头像 → 个人设置 → 个人访问令牌 → 新建。权限建议勾选
                  <b>项目管理</b>、<b>代码管理</b>、<b>流水线</b>（按需读写）。
                  <Button type="link" size="small" className="px-1" onClick={openPatPage}>
                    去创建 →
                  </Button>
                  <div className="text-[11px] text-amber-600 dark:text-amber-400">
                    令牌仅创建时完整显示一次，请立即复制。
                  </div>
                </div>
              ),
            },
            {
              title: '粘贴并验证令牌',
              description: (
                <div className="pb-1 pt-1">
                  <Input.Search
                    className="max-w-md"
                    placeholder="粘贴个人访问令牌（PAT）"
                    enterButton="验证"
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value)
                      setVerified(null)
                    }}
                    loading={verifying}
                    onSearch={() => void doVerify()}
                  />
                </div>
              ),
            },
            {
              title: '选择组织',
              description: verified ? (
                <div className="pb-1">
                  {orgs.length === 0 ? (
                    <Alert type="warning" showIcon message="该账号未加入任何云效组织" className="mb-3" />
                  ) : (
                    <Radio.Group
                      value={orgId}
                      onChange={(e) => setOrgId(e.target.value)}
                      className="flex flex-col gap-2"
                    >
                      {orgs.map((o) => (
                        <Radio key={o.id} value={o.id}>
                          {o.name}
                          <span className="ml-2 text-xs text-gray-400">{o.id}</span>
                        </Radio>
                      ))}
                    </Radio.Group>
                  )}
                  <Button
                    type="primary"
                    className="mt-3"
                    disabled={!selectedOrg}
                    loading={saving}
                    onClick={() => void doSave()}
                  >
                    接入云效
                  </Button>
                </div>
              ) : (
                <span className="text-xs text-gray-400">验证通过后选择要接入的组织</span>
              ),
            },
          ]}
        />

        {verified && (
          <Alert
            type="success"
            showIcon
            className="mb-4"
            message={`身份：${verified.user.name || verified.user.id}${verified.user.email ? `（${verified.user.email}）` : ''}`}
          />
        )}
        {error && (
          <Alert
            type="error"
            showIcon
            message={error}
            className="mt-4"
            closable
            onClose={() => setError(null)}
          />
        )}
      </Card>
      <div className="mt-3 flex items-center gap-1.5 text-xs text-gray-400">
        <Info size={13} />
        支持项目空间（Projex）、代码管理（Codeup）、流水线（Flow）三个模块的只读浏览与流水线触发。
      </div>
    </div>
  )
}
