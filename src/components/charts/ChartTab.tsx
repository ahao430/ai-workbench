import { useMemo, type ReactNode } from 'react'
import { App, Button, Dropdown, Input, Popconfirm, Segmented, Space } from 'antd'
import { Check, Copy, Download, Eraser, FileCode2, Repeat } from 'lucide-react'
import { useState } from 'react'
import EChart from './EChart'
import AntvChart, { type AntvOption } from './AntvChart'
import { switchChartType } from './typeSwitch'
import { copyToClipboard, lsSet, PANE_CLASS, TEXTAREA_STYLE } from '../diagram/shared'

export type ChartLib = 'echarts' | 'antv'

/** 左侧三视图：配置（JSON 编辑）/ 图表（画布）/ 数据（数据看板） */
export type ChartView = 'config' | 'chart' | 'data'

/** 示例按图型分组展示（基础/统计/关系层级等），示例名在组内唯一即可 */
export interface SampleGroup {
  group: string
  items: Record<string, unknown>
}

/** 宽松 JSON 解析：尾逗号容错（模型输出常见），返回错误信息供面板展示 */
export function parseJsonConfig(text: string): { value: Record<string, unknown> | null; error: string | null } {
  const t = text.trim()
  if (!t) return { value: null, error: null }
  try {
    const v = JSON.parse(t)
    if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v, error: null }
    return { value: null, error: '配置必须是 JSON 对象（{ ... }）' }
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) }
  }
}

interface Props {
  lib: ChartLib
  /** JSON 配置文本（页面持有，AI 工具会整体替换） */
  text: string
  onText: (t: string) => void
  view: ChartView
  onView: (v: ChartView) => void
  samples: SampleGroup[]
  /** 数据看板内容（view=data 时展示；数据集两库共享） */
  data?: ReactNode
  /** 数据集行数摘要，展示在「数据」选项上 */
  dataCount?: number
}

/** 单个图表库面板：上方工具栏（配置/图表/数据切换 + 示例等），下方编辑器、画布或数据看板 */
export default function ChartTab({ lib, text, onText, view, onView, samples, data, dataCount }: Props) {
  const { message } = App.useApp()
  const [copied, setCopied] = useState(false)
  const { value, error } = useMemo(() => parseJsonConfig(text), [text])

  const copy = async () => {
    if (await copyToClipboard(text)) {
      setCopied(true)
      message.success('已复制')
      setTimeout(() => setCopied(false), 1500)
    } else message.error('复制失败')
  }

  const fmt = () => {
    const v = parseJsonConfig(text)
    if (!v.value) return void message.warning('当前配置不是合法 JSON，无法格式化')
    onText(JSON.stringify(v.value, null, 2))
  }

  const dl = () => {
    const blob = new Blob([text], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${lib}-option.json`
    a.click()
    URL.revokeObjectURL(a.href)
    lsSet(`aw-charts:opt-${lib}`, text)
  }

  // 示例与类型切换共用一份分组菜单
  const menuItems = samples.map((g) => ({
    key: g.group,
    type: 'group' as const,
    label: g.group,
    children: Object.keys(g.items).map((k) => ({ key: `${g.group}::${k}`, label: k })),
  }))

  // 类型切换：优先保留当前数据只换图型；当前配置为空或数据形态不兼容时回退该类型示例
  const switchTo = (group: string, name: string) => {
    const next = text.trim() ? switchChartType(lib, text, name) : null
    if (next) {
      onText(next)
    } else {
      const item = samples.find((g) => g.group === group)?.items[name]
      if (item) {
        onText(JSON.stringify(item, null, 2))
        if (text.trim()) message.info(`当前数据不适用「${name}」，已载入该类型示例`)
      }
    }
    onView('chart')
  }

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          size="small"
          value={view}
          onChange={(v) => onView(v as ChartView)}
          options={[
            { label: '配置', value: 'config' },
            { label: '图表', value: 'chart' },
            { label: dataCount != null ? `数据 ·${dataCount}` : '数据', value: 'data' },
          ]}
        />
        <Space size="small" wrap>
          <Dropdown
            trigger={['click']}
            menu={{
              items: menuItems,
              onClick: ({ key }) => {
                const [group, name] = String(key).split('::')
                const item = samples.find((g) => g.group === group)?.items[name]
                if (item) {
                  onText(JSON.stringify(item, null, 2))
                  onView('chart')
                }
              },
            }}
          >
            <Button size="small" icon={<FileCode2 size={13} />}>
              示例 ▾
            </Button>
          </Dropdown>
          <Dropdown
            trigger={['click']}
            menu={{
              items: menuItems,
              onClick: ({ key }) => {
                const [group, name] = String(key).split('::')
                switchTo(group, name)
              },
            }}
          >
            <Button size="small" icon={<Repeat size={13} />} title="保留当前数据，切换为其他图型">
              类型 ▾
            </Button>
          </Dropdown>
          <Button size="small" onClick={fmt}>
            格式化
          </Button>
          <Button size="small" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => void copy()}>
            复制
          </Button>
          <Button size="small" icon={<Download size={13} />} onClick={dl}>
            配置
          </Button>
          <Popconfirm title="清空配置？" onConfirm={() => onText('')}>
            <Button size="small" danger icon={<Eraser size={13} />}>
              清空
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {view === 'config' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-1">
          <div className="min-h-0 flex-1">
            <Input.TextArea
              value={text}
              onChange={(e) => onText(e.target.value)}
              style={TEXTAREA_STYLE}
              placeholder={lib === 'echarts' ? 'ECharts option JSON，或用右侧 AI 对话生成' : 'Ant Design Charts 配置 JSON（含 type 字段），或用右侧 AI 对话生成'}
            />
          </div>
          {error && (
            <div className="shrink-0 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </div>
          )}
        </div>
      ) : view === 'data' ? (
        <div className={`${PANE_CLASS} min-h-0 flex-1 overflow-hidden`}>{data}</div>
      ) : (
        <div className={`${PANE_CLASS} min-h-0 flex-1 overflow-auto`}>
          {error ? (
            <div className="m-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
              配置解析失败：{error}
            </div>
          ) : value ? (
            <div className="h-full min-h-[380px] w-full">
              {lib === 'echarts' ? <EChart option={value} /> : <AntvChart option={value as unknown as AntvOption} />}
            </div>
          ) : (
            <div className="grid h-full place-items-center text-xs text-gray-400">
              左侧编辑配置，或用右侧 AI 对话直接画图
            </div>
          )}
        </div>
      )}
    </div>
  )
}
