/** 图表类型切换：保留当前数据（类目 + 系列数值），只改换图型。
 *  数据形态不兼容的目标（K 线、桑基、词云等）返回 null，调用方回退到载入该类型示例。 */
import type { ChartLib } from './ChartTab'

interface NumSeries {
  name: string
  data: number[]
}

function parseObj(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** 雷达图 indicator.max 用的“好看”上限（向上取整到 1/2/5×10^n 量级） */
function niceMax(vals: number[]): number {
  const max = Math.max(10, ...vals)
  const mag = 10 ** Math.floor(Math.log10(max))
  return Math.ceil(max / mag) * mag
}

/* ---------------- ECharts ---------------- */

interface EcModel {
  title?: unknown
  cats: string[]
  series: NumSeries[]
}

/** 从 ECharts option 提取类目轴 + 数值系列（轴类图互转的公共数据底座） */
function ecModel(opt: Record<string, unknown>): EcModel | null {
  const axes = [opt.xAxis, opt.yAxis].flat().filter(Boolean) as Record<string, unknown>[]
  const catAxis = axes.find((a) => a.type === 'category' && Array.isArray(a.data))
  if (!catAxis) return null
  const cats = (catAxis.data as unknown[]).map((c) =>
    c && typeof c === 'object' ? String((c as Record<string, unknown>).value ?? '') : String(c ?? ''),
  )
  const raw = Array.isArray(opt.series) ? (opt.series as Record<string, unknown>[]) : []
  const series: NumSeries[] = []
  for (const s of raw) {
    const data = (Array.isArray(s.data) ? s.data : []).map((v) => Number(v)).filter((v) => Number.isFinite(v))
    if (data.length) series.push({ name: String(s.name ?? ''), data })
  }
  if (!cats.length || !series.length) return null
  return { title: opt.title, cats, series }
}

function ecBuild(name: string, m: EcModel): Record<string, unknown> | null {
  const { title, cats, series } = m
  const multi = series.length > 1
  const legend = multi ? { legend: { top: 30 } } : {}
  const catX = { type: 'category', data: cats }
  const valX = { type: 'value' }
  const mk = (t: string, extra: Record<string, unknown> = {}) =>
    series.map((s) => ({ name: s.name, type: t, data: s.data, ...extra }))

  switch (name) {
    case '折线图':
      return { title, tooltip: { trigger: 'axis' }, ...legend, xAxis: catX, yAxis: { type: 'value' }, series: mk('line', { smooth: true }) }
    case '面积图':
      return { title, tooltip: { trigger: 'axis' }, ...legend, xAxis: { type: 'category', boundaryGap: false, data: cats }, yAxis: { type: 'value' }, series: mk('line', { smooth: true, areaStyle: { opacity: 0.25 } }) }
    case '堆叠面积图':
      return { title, tooltip: { trigger: 'axis' }, ...legend, xAxis: { type: 'category', boundaryGap: false, data: cats }, yAxis: { type: 'value' }, series: mk('line', { smooth: true, stack: 'total', areaStyle: {}, emphasis: { focus: 'series' } }) }
    case '柱状图':
      return { title, tooltip: { trigger: 'axis' }, ...legend, xAxis: catX, yAxis: { type: 'value' }, series: mk('bar') }
    case '堆叠柱状图':
      return { title, tooltip: { trigger: 'axis' }, ...legend, xAxis: catX, yAxis: { type: 'value' }, series: mk('bar', { stack: 'total' }) }
    case '条形图':
      return { title, tooltip: { trigger: 'axis' }, ...legend, xAxis: valX, yAxis: catX, series: mk('bar') }
    case '堆叠条形图':
      return { title, tooltip: { trigger: 'axis' }, ...legend, xAxis: valX, yAxis: catX, series: mk('bar', { stack: 'total' }) }
    case '散点图':
      return { title, tooltip: { trigger: 'item' }, ...legend, xAxis: catX, yAxis: { type: 'value', scale: true }, series: mk('scatter', { symbolSize: 8 }) }
    case '双轴折柱图': {
      if (series.length < 2) return null
      return {
        title,
        tooltip: { trigger: 'axis' },
        legend: { top: 30 },
        xAxis: catX,
        yAxis: [{ type: 'value' }, { type: 'value', splitLine: { show: false } }],
        series: [
          { name: series[0].name, type: 'bar', data: series[0].data },
          ...series.slice(1).map((s) => ({ name: s.name, type: 'line', yAxisIndex: 1, smooth: true, data: s.data })),
        ],
      }
    }
    case '饼图':
    case '环形图': {
      // 饼/环形只取第一个系列：类目 → name，数值 → value
      const first = series[0]
      const data = cats.map((c, i) => ({ name: c, value: first.data[i] }))
      if (name === '饼图') {
        return { title, tooltip: { trigger: 'item' }, legend: { orient: 'vertical', left: 'left' }, series: [{ type: 'pie', radius: '62%', data }] }
      }
      return { title, tooltip: { trigger: 'item' }, legend: { bottom: 0 }, series: [{ type: 'pie', radius: ['42%', '68%'], label: { show: true, formatter: '{b}: {d}%' }, data }] }
    }
    case '漏斗图': {
      const first = series[0]
      const data = cats.map((c, i) => ({ name: c, value: first.data[i] })).sort((a, b) => b.value - a.value)
      return { title, tooltip: { trigger: 'item', formatter: '{b}: {c}' }, series: [{ type: 'funnel', left: '10%', top: 60, bottom: 20, width: '80%', sort: 'descending', label: { show: true, position: 'inside' }, data }] }
    }
    case '雷达图': {
      const all = series.flatMap((s) => s.data)
      return {
        title,
        ...(multi ? { legend: { bottom: 0 } } : {}),
        radar: { indicator: cats.map((c) => ({ name: c, max: niceMax(all) })) },
        series: [{ type: 'radar', data: series.map((s) => ({ value: s.data, name: s.name })) }],
      }
    }
    default:
      return null
  }
}

/* ---------------- AntV ---------------- */

interface AvModel {
  data: Record<string, unknown>[]
  x?: string
  y?: string
  color?: string
}

function avModel(opt: Record<string, unknown>): AvModel | null {
  if (!Array.isArray(opt.data)) return null
  const rows = (opt.data as unknown[]).filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r),
  )
  if (!rows.length) return null
  return {
    data: rows,
    x: typeof opt.xField === 'string' ? opt.xField : undefined,
    y: typeof opt.yField === 'string' ? opt.yField : undefined,
    color: typeof opt.colorField === 'string' ? opt.colorField : undefined,
  }
}

/** 按类目聚合求和：饼/玫瑰/漏斗/玉玦等占比类目标的数据形态 */
function avAgg(m: AvModel): { name: string; value: number }[] | null {
  if (!m.x || !m.y) return null
  const sum = new Map<string, number>()
  for (const r of m.data) {
    const v = Number(r[m.y])
    if (!Number.isFinite(v)) continue
    const k = String(r[m.x] ?? '')
    sum.set(k, (sum.get(k) ?? 0) + v)
  }
  return sum.size ? [...sum.entries()].map(([name, value]) => ({ name, value })) : null
}

function avBuild(name: string, m: AvModel): Record<string, unknown> | null {
  if (name === '饼图' || name === '玫瑰图' || name === '漏斗图' || name === '玉玦图') {
    const agg = avAgg(m)
    if (!agg) return null
    if (name === '饼图') return { type: 'pie', data: agg, angleField: 'value', colorField: 'name' }
    if (name === '玫瑰图') return { type: 'rose', data: agg, xField: 'name', yField: 'value', colorField: 'name', innerRadius: 0.2 }
    if (name === '漏斗图') return { type: 'funnel', data: [...agg].sort((a, b) => b.value - a.value), xField: 'name', yField: 'value' }
    return { type: 'radial-bar', data: [...agg].sort((a, b) => a.value - b.value), xField: 'name', yField: 'value', innerRadius: 0.2 }
  }
  if (!m.x || !m.y) return null
  const color = m.color ? { colorField: m.color } : {}
  const grouped = m.color ? { group: true } : {}
  switch (name) {
    case '折线图':
      return { type: 'line', data: m.data, xField: m.x, yField: m.y, ...color, point: { size: 4 } }
    case '面积图':
      return { type: 'area', data: m.data, xField: m.x, yField: m.y, ...color, style: { fillOpacity: 0.4 } }
    case '堆叠面积图':
      return { type: 'area', data: m.data, xField: m.x, yField: m.y, ...color, stack: true, style: { fillOpacity: 0.5 } }
    case '柱状图':
      return { type: 'column', data: m.data, xField: m.x, yField: m.y, ...color, ...grouped }
    case '堆叠柱状图':
      return { type: 'column', data: m.data, xField: m.x, yField: m.y, ...color, stack: true }
    case '条形图':
      return { type: 'bar', data: m.data, xField: m.x, yField: m.y, ...color, ...grouped }
    case '堆叠条形图':
      return { type: 'bar', data: m.data, xField: m.x, yField: m.y, ...color, stack: true }
    case '散点图':
      return { type: 'scatter', data: m.data, xField: m.x, yField: m.y, ...color }
    case '雷达图':
      return { type: 'radar', data: m.data, xField: m.x, yField: m.y, ...color, style: { lineWidth: 2 } }
    case '直方图': {
      const values = m.data.map((r) => Number(r[m.y as string])).filter((v) => Number.isFinite(v))
      if (values.length < 2) return null
      return { type: 'histogram', data: values.map((value) => ({ value })), binField: 'value', binNumber: 8 }
    }
    default:
      return null
  }
}

/** 入口：把当前配置切换为 name 图型；返回新配置文本，无法转换时返回 null */
export function switchChartType(lib: ChartLib, text: string, name: string): string | null {
  const opt = parseObj(text)
  if (!opt) return null
  if (lib === 'echarts') {
    const m = ecModel(opt)
    const next = m && ecBuild(name, m)
    return next ? JSON.stringify(next, null, 2) : null
  }
  const m = avModel(opt)
  const next = m && avBuild(name, m)
  return next ? JSON.stringify(next, null, 2) : null
}
