import { useEffect, useRef } from 'react'
import type * as echartsTypes from 'echarts'
import { useUiStore } from '../../stores/ui'

/**
 * ECharts 画布封装：echarts 整包懒加载（AI 生成的 option 类型不定，按需注册容易漏）；
 * 暗色跟随全局主题重建实例；容器尺寸变化自动 resize。
 */
export default function EChart({ option }: { option: Record<string, unknown> | null }) {
  const dark = useUiStore((s) => s.theme) === 'dark'
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echartsTypes.ECharts | null>(null)
  // init 异步竞态：图表就绪前 setOption 的最新配置先暂存
  const pendingRef = useRef<Record<string, unknown> | null>(option ?? null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let ro: ResizeObserver | null = null
    void import('echarts').then((echarts) => {
      if (disposed) return
      const chart = echarts.init(host, dark ? 'dark' : undefined)
      chartRef.current = chart
      const first = pendingRef.current
      if (first) chart.setOption({ backgroundColor: 'transparent', ...first })
      ro = new ResizeObserver(() => chart.resize())
      ro.observe(host)
    })
    return () => {
      disposed = true
      ro?.disconnect()
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [dark])

  useEffect(() => {
    pendingRef.current = option
    // dark 主题自带的背景色要盖掉，跟随容器
    if (option && chartRef.current) {
      chartRef.current.setOption({ backgroundColor: 'transparent', ...option }, { notMerge: true })
    }
  }, [option])

  return <div ref={hostRef} className="h-full w-full" />
}
