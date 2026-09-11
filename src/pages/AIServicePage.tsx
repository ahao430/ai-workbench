import { useState } from 'react'
import { Card, Typography } from 'antd'
import { Coins, SquareTerminal } from 'lucide-react'
import ProvidersTab from '../components/gateway/ProvidersTab'
import CliTab from '../components/gateway/CliTab'
import type { Provider } from '../db/providers'

export default function AIServicePage() {
  const [cliSeed, setCliSeed] = useState<Provider | null>(null)

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-8 py-8">
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        AI 服务
      </Typography.Title>

      {/* 卡片一：供应商与模型 */}
      <Card
        title={
          <span className="flex items-center gap-2 text-base">
            <Coins size={16} className="text-indigo-500" />
            供应商与模型
          </span>
        }
      >
        <ProvidersTab />
      </Card>

      {/* 卡片二：CLI 配置 */}
      <Card
        title={
          <span className="flex items-center gap-2 text-base">
            <SquareTerminal size={16} className="text-indigo-500" />
            CLI 配置
          </span>
        }
      >
        <CliTab seedProvider={cliSeed} onSeedConsumed={() => setCliSeed(null)} />
      </Card>
    </div>
  )
}
