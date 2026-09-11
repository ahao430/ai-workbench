import { useEffect, useState, type ComponentType } from 'react'
import { Empty, Spin } from 'antd'
import { useUiStore } from '../../stores/ui'

/** antv 配置：type 指定图型，其余字段展开为组件属性（data/xField/yField…） */
export interface AntvOption {
  type: string
  [key: string]: unknown
}

type ChartsMod = typeof import('@ant-design/charts')

/**
 * 图型名 → 导出组件名：type 归一化（去连字符/空格转小写）后匹配。
 * 驼峰组件名（RadialBar/DualAxes/WordCloud/CirclePacking）显式列出。
 */
const TYPE_MAP: Record<string, string> = {
  line: 'Line',
  area: 'Area',
  column: 'Column',
  bar: 'Bar',
  pie: 'Pie',
  scatter: 'Scatter',
  histogram: 'Histogram',
  box: 'Box',
  violin: 'Violin',
  radar: 'Radar',
  rose: 'Rose',
  heatmap: 'Heatmap',
  funnel: 'Funnel',
  waterfall: 'Waterfall',
  bullet: 'Bullet',
  venn: 'Venn',
  gauge: 'Gauge',
  liquid: 'Liquid',
  sankey: 'Sankey',
  treemap: 'Treemap',
  sunburst: 'Sunburst',
  stock: 'Stock',
  mix: 'Mix',
  dualaxes: 'DualAxes',
  radialbar: 'RadialBar',
  wordcloud: 'WordCloud',
  circlepacking: 'CirclePacking',
  bidirectionalbar: 'BidirectionalBar',
}

/** @ant-design/charts 整包懒加载（页面/Tab 首次渲染才拉取） */
let modPromise: Promise<ChartsMod> | null = null
function loadCharts(): Promise<ChartsMod> {
  modPromise ??= import('@ant-design/charts')
  return modPromise
}

/** Ant Design Charts 画布封装：按 option.type 动态选组件，主题跟随全局明暗 */
export default function AntvChart({ option }: { option: AntvOption | null }) {
  const dark = useUiStore((s) => s.theme) === 'dark'
  const [mod, setMod] = useState<ChartsMod | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setErr(null)
    void loadCharts().then(setMod).catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  if (err) return <div className="grid h-full place-items-center text-xs" style={{ color: '#d4380d' }}>图表库加载失败：{err}</div>
  if (!mod) {
    return (
      <div className="grid h-full place-items-center">
        <Spin size="small" />
      </div>
    )
  }

  const raw = (option?.type ?? '').trim()
  const name = TYPE_MAP[raw.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? ''
  const Cmp = (mod as unknown as Record<string, unknown>)[name] as
    | ComponentType<Record<string, unknown>>
    | undefined
  if (!option || !Cmp) {
    return (
      <div className="grid h-full place-items-center">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span className="text-xs text-gray-400">
              {option ? `不支持的图型：${option.type || '(空)'}` : '暂无配置'}
            </span>
          }
        />
      </div>
    )
  }

  const { type: _t, ...props } = option
  return (
    <div className="h-full w-full overflow-hidden p-2">
      <Cmp theme={dark ? 'dark' : 'light'} autoFit {...props} />
    </div>
  )
}
