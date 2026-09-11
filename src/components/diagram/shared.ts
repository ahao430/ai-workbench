/** 流程图页共用小工具：本地持久化 / 下载 / 复制 / SVG→PNG / 防抖 */

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function lsSet(key: string, val: string): void {
  try {
    localStorage.setItem(key, val)
  } catch {
    /* 配额满 / 隐私模式等忽略 */
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

/** 复制到剪贴板（项目内 MdPreview/TokensTab 同款走 clipboard API），成功与否返回布尔 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 从 SVG 字符串解析原始尺寸：优先 viewBox，其次 width/height 属性（导出 PNG 定尺寸用） */
function svgSize(svg: string): { w: number; h: number } {
  const vb = svg.match(/viewBox="([\d.\s,eE+-]+)"/)
  if (vb) {
    const p = vb[1].split(/[\s,]+/).map(Number)
    if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] }
  }
  const w = svg.match(/\bwidth="([\d.]+)"/)
  const h = svg.match(/\bheight="([\d.]+)"/)
  if (w && h) return { w: Number(w[1]), h: Number(h[1]) }
  return { w: 800, h: 600 }
}

/** SVG 字符串 → PNG Blob（data URL 加载图片不污染 canvas，可安全 toBlob） */
export async function svgToPngBlob(svg: string, scale = 2): Promise<Blob> {
  const { w, h } = svgSize(svg)
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('SVG 加载失败（可能含外部资源）'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 不可用')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出 PNG 失败'))), 'image/png'),
  )
}

/** 简易防抖值：输入停顿后再触发渲染/编码，避免每次按键都渲染 */
import { useEffect, useState } from 'react'
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** 编辑器/预览两栏骨架：文本类 tab（Mermaid/PlantUML/SVG）共用 */
export const PANE_CLASS = 'flex min-w-0 flex-col rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'
export const TEXTAREA_STYLE: React.CSSProperties = {
  height: '100%',
  resize: 'none',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
}

/** 左工作区/右 AI 对话的分栏宽度（百分比，指右侧面板），五个 tab 共用一份记忆 */
const SPLIT_KEY = 'aw-diagram:split'
export function loadSplit(): number {
  const v = Number(lsGet(SPLIT_KEY))
  return v >= 20 && v <= 78 ? v : 42
}
/** antd Splitter 的 resize 事件给的是像素，这里换算回百分比存（面板 min/max 也按百分比设） */
export function saveSplit(sizes: number[]): void {
  const total = sizes[0] + sizes[1]
  if (total <= 0) return
  const pct = (sizes[1] / total) * 100
  if (pct >= 15 && pct <= 85) lsSet(SPLIT_KEY, String(Math.round(pct)))
}
