/**
 * Markdown 文档导出：下载 .md / 导出 PDF。
 * 文件保存走 Rust export_save_file（写入 ~/Downloads 并在 Finder 显示）——
 * webview 内 a[download] 在 WKWebView 不可靠。
 * PDF 参考 agent-platform export.tsx：离屏渲染 MdPreview → html-to-image canvas
 * → jsPDF 按 A4 切页（base64 回传 Rust 落盘）。
 */

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MdPreview, themeMeta, type MdTheme } from '../components/common/MdPreview'
import { call } from '../api/ipc'
import { errText } from '../lib/err'
import { loadExcelWorkbook } from './exceljsLoad'

/** 文件名时间戳：YYYYMMDD-HHmm */
function ts(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** Uint8Array → base64（分块避免栈溢出） */
function toB64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(s)
}

async function saveBytes(filename: string, bytes: Uint8Array): Promise<string> {
  return call<string>('export_save_file', { filename, contentB64: toB64(bytes) })
}

/** 下载 Markdown 文件到 ~/Downloads */
export async function downloadMarkdown(name: string, text: string): Promise<void> {
  const file = `${name}-${ts()}.md`
  await saveBytes(file, new TextEncoder().encode(text))
}

/** 语雀表格导出：sheets 为各页单元格（行号→列号→文本，0 基），exceljs 生成 .xlsx。
 *  数字形态的文本还原为数值（前导零/超长 ID 保持文本防失真）。 */
export async function exportExcel(
  name: string,
  sheets: { name: string; cells: Record<string, Record<string, string>> }[],
): Promise<string> {
  const Workbook = await loadExcelWorkbook()
  const wb = new Workbook()
  const used = new Set<string>()
  const safeName = (n: string, i: number) => {
    let s = (n || `Sheet${i + 1}`).replace(/[*?:\\/[\]]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`
    while (used.has(s)) s = `${s.slice(0, 28)}-${used.size}`.slice(0, 31)
    used.add(s)
    return s
  }
  const numeric = (v: string): string | number => {
    // 前导零（007）、超长数字（>15 位，Excel 数值仅 ~15 位有效精度）保持文本防失真
    if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v) || v.replace(/[^0-9]/g, '').length > 15) return v
    return Number(v)
  }
  sheets.forEach((tab, i) => {
    const ws = wb.addWorksheet(safeName(tab.name, i))
    for (const [r, row] of Object.entries(tab.cells)) {
      for (const [c, v] of Object.entries(row)) {
        if (v) ws.getCell(Number(r) + 1, Number(c) + 1).value = numeric(v)
      }
    }
  })
  const buf = await wb.xlsx.writeBuffer()
  return saveBytes(`${name.slice(0, 60).trim() || 'sheet'}-${ts()}.xlsx`, new Uint8Array(buf as ArrayBuffer))
}

/** 导出 PDF（离屏渲染 + A4 切页）；onDone 收到保存路径 */
export async function exportPdf(opts: {
  text: string
  title: string
  theme?: MdTheme
  onToast?: (msg: string, isError?: boolean) => void
}): Promise<void> {
  const theme = opts.theme ?? 'github'
  const meta = themeMeta(theme)
  const pageBg = meta?.pageBg ?? '#ffffff'
  const filename = `${opts.title.slice(0, 40).trim() || 'document'}-${ts()}`
  const width = 794 // A4 @96dpi
  const node = createElement(
    'div',
    { style: { padding: '32px 40px', background: pageBg } },
    createElement(
      'div',
      {
        style: {
          fontSize: 20,
          fontWeight: 600,
          padding: '4px 0 12px',
          borderBottom: '1px solid #e8e8e8',
          marginBottom: 16,
          color: meta?.dark ? '#eee' : '#222',
        },
      },
      opts.title,
    ),
    createElement(MdPreview, { text: opts.text, theme }),
  )
  // 离屏挂载：等字体与两帧排版稳定后再光栅化
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;background:${pageBg};`
  document.body.appendChild(host)
  try {
    const root = createRoot(host)
    root.render(node)
    await nextFrames(2)
    await document.fonts.ready
    await nextFrames(1)
    const { toCanvas } = await import('html-to-image')
    const target = (host.firstElementChild as HTMLElement | null) ?? host
    const canvas = await toCanvas(target, { pixelRatio: 2, backgroundColor: pageBg })
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' })
    const pageW = pdf.internal.pageSize.getWidth()
    const pageH = pdf.internal.pageSize.getHeight()
    const margin = 40
    const imgW = pageW - margin * 2
    const scale = imgW / canvas.width
    const sliceH = Math.floor((pageH - margin * 2) / scale)
    for (let y = 0; y < canvas.height; y += sliceH) {
      const slice = document.createElement('canvas')
      slice.width = canvas.width
      slice.height = Math.min(sliceH, canvas.height - y)
      slice.getContext('2d')!.drawImage(canvas, 0, y)
      if (y > 0) pdf.addPage()
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, imgW, slice.height * scale)
    }
    const bytes = new Uint8Array(pdf.output('arraybuffer') as ArrayBuffer)
    const path = await saveBytes(`${filename}.pdf`, bytes)
    opts.onToast?.(`已导出：${path}`)
  } catch (e) {
    console.error('[mdExport] pdf failed:', e)
    opts.onToast?.(`导出失败：${errText(e)}`, true)
  } finally {
    host.remove()
  }
}

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n
    const tick = () => (--left > 0 ? requestAnimationFrame(tick) : resolve())
    requestAnimationFrame(tick)
  })
}
