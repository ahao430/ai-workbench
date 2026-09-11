import type { ReactNode } from 'react'
import { Tag } from 'antd'

interface Props {
  icon: ReactNode
  title: string
  description: string
  milestone?: string
}

/** 模块占位页：图标 + 标题 + 说明 + 交付里程碑 */
export default function PagePlaceholder({ icon, title, description, milestone }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10">
      <div className="text-indigo-400 dark:text-indigo-500">{icon}</div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-md text-center text-sm leading-6 text-gray-500 dark:text-gray-400">
        {description}
      </p>
      {milestone && <Tag color="geekblue">{milestone}</Tag>}
    </div>
  )
}
