import { Wrench } from 'lucide-react'
import PagePlaceholder from '../components/PagePlaceholder'

/** 工具中心：规划中，内容待定 */
export default function ToolsPage() {
  return (
    <PagePlaceholder
      icon={<Wrench size={44} strokeWidth={1.4} />}
      title="工具"
      description="工具中心规划中——聚合本地工具与辅助能力，内容待定。"
    />
  )
}
