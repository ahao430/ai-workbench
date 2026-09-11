import type { SheetData } from './model'
import { loadExcelWorkbook } from '../../lib/exceljsLoad'

type Cell = string | number

/**
 * exceljs 文件层：SheetData ↔ xlsx/csv/json。
 * 数据模型是简单 JSON（sheets + 二维数组，= 前缀为公式），exceljs 只负责文件编解码。
 */

function download(blob: Blob, filename: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

/** 导出 xlsx（全部 sheet；公式写入 exceljs，打开文件时由 Excel 计算）。 */
export async function exportXlsx(data: SheetData, filename: string): Promise<void> {
  const Workbook = await loadExcelWorkbook()
  const wb = new Workbook()
  for (const s of data.sheets) {
    const ws = wb.addWorksheet(s.name)
    s.cells.forEach((row, r) => {
      row.forEach((v, c) => {
        const cell = ws.getCell(r + 1, c + 1)
        if (typeof v === 'number') cell.value = v
        else if (v.startsWith('=')) cell.value = { formula: v.slice(1) }
        else cell.value = v
      })
    })
  }
  const buf = await wb.xlsx.writeBuffer()
  download(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`,
  )
}

/** 单个 sheet 导出 CSV（公式导出为空占位，避免把 '=SUM(..)' 文本写进文件）。 */
export function exportCsv(data: SheetData, sheetIndex: number, filename: string): void {
  const sheet = data.sheets[sheetIndex]
  if (!sheet) return
  const lines = sheet.cells.map((row) =>
    row
      .map((v) => {
        const s = typeof v === 'string' && v.startsWith('=') ? '' : String(v)
        return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
      })
      .join(','),
  )
  download(new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `${filename}.csv`)
}

/** exceljs 单元格值 → 简单模型值。 */
function toCell(v: unknown): Cell {
  if (v == null) return ''
  if (typeof v === 'number' || typeof v === 'string') return v
  if (typeof v === 'object') {
    const o = v as { formula?: unknown; result?: unknown; richText?: Array<{ text?: string }>; text?: unknown }
    // 公式 → '=公式'（exceljs 模型可能带前导 =，先剥掉再统一补）
    if (typeof o.formula === 'string') return `=${o.formula.replace(/^=/, '')}`
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text ?? '').join('')
    if (o.text != null) return String(o.text)
    if (o.result != null) return typeof o.result === 'number' ? o.result : String(o.result)
  }
  return String(v)
}

/** 纯数字文本 → 数值（公式可计算）；前导零 / 超 15 位数字保持文本防失真。 */
function coerceNumber(s: string): Cell {
  if (/^-?\d+(\.\d+)?$/.test(s) && s.replace(/[^0-9]/g, '').length <= 15) return Number(s)
  return s
}

/** 导入 xlsx → SheetData（公式还原为 = 前缀字符串）。 */
export async function importXlsx(file: File): Promise<SheetData> {
  const Workbook = await loadExcelWorkbook()
  const wb = new Workbook()
  await wb.xlsx.load(await file.arrayBuffer())
  const sheets = wb.worksheets.map((ws) => {
    const cells: Cell[][] = []
    ws.eachRow({ includeEmpty: true }, (row, r) => {
      const out: Cell[] = []
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        out[c - 1] = toCell(cell.value)
      })
      // 行内空洞补空串
      for (let i = 0; i < out.length; i++) if (out[i] == null) out[i] = ''
      cells[r - 1] = out
    })
    return { name: ws.name, cells }
  })
  return { sheets: sheets.length > 0 ? sheets : [{ name: 'Sheet1', cells: [] }] }
}

/** 解析一行 CSV/TSV 文本（引号包裹 / 引号转义 / 引号内换行），返回字段数组。 */
function parseCsvLines(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuote = false
  const src = text.replace(/^\ufeff/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else inQuote = false
      } else field += ch
    } else if (ch === '"') inQuote = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** 按引号外的分隔符出现次数探测（, / ; / \t）。 */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  let inQuote = false
  for (const ch of text) {
    if (ch === '"') inQuote = !inQuote
    else if (!inQuote && ch in counts) counts[ch]++
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
}

/** 导入 CSV/TSV → SheetData（首行为数据行，数字文本转数值）。 */
export function importCsv(text: string, name = 'Sheet1'): SheetData {
  const delim = detectDelimiter(text)
  const rows = parseCsvLines(text, delim).filter((r) => r.some((c) => c.trim() !== ''))
  return { sheets: [{ name, cells: rows.map((r) => r.map(coerceNumber)) }] }
}

/** JSON 值 → 单元格文本（对象数组化，null/undefined → 空串）。 */
function jsonCell(v: unknown): Cell {
  if (v == null) return ''
  if (typeof v === 'number' || typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return JSON.stringify(v)
}

/**
 * 导入 JSON → SheetData。只接受两种规整格式：
 * 1. 对象数组 Array<Object>（键并集为表头）；2. 二维数组 Array<Array>。
 * 其他结构（包装对象 / 嵌套对象等）不做自动转换，提示用外部工具预处理。
 */
export function importJson(text: string, name = 'Sheet1'): SheetData {
  const v: unknown = JSON.parse(text)
  const cells: Cell[][] = []
  const badShape = () =>
    new Error(`JSON 仅支持对象数组（Array<Object>）或二维数组（Array<Array>）格式，当前顶层是 ${v == null ? String(v) : typeof v}，请先用外部工具转换`)
  if (!Array.isArray(v)) throw badShape()
  if (v.length === 0) throw new Error('JSON 数组为空，没有可导入的数据')
  // 二维数组：元素统一为数组，首行可为表头
  if (v.every((r) => Array.isArray(r))) {
    for (const r of v as unknown[][]) cells.push(r.map(jsonCell))
    return { sheets: [{ name, cells }] }
  }
  // 对象数组：键并集做表头
  if (v.every((r) => r && typeof r === 'object')) {
    const keys: string[] = []
    for (const r of v as Record<string, unknown>[]) {
      for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k)
    }
    cells.push(keys.map(String))
    for (const r of v as Record<string, unknown>[]) cells.push(keys.map((k) => jsonCell(r[k])))
    return { sheets: [{ name, cells }] }
  }
  throw new Error('JSON 仅支持对象数组（Array<Object>）或二维数组（Array<Array>）格式，数组元素需统一为对象或数组，请先用外部工具转换')
}

/** 按扩展名导入文件 → SheetData（xlsx / csv / tsv / txt / json）。 */
export async function importSheetFile(file: File): Promise<SheetData> {
  const base = file.name.replace(/\.[^.]+$/, '') || 'Sheet1'
  const ext = (file.name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase()
  if (ext === 'xlsx') return importXlsx(file)
  if (ext === 'xls') throw new Error('暂不支持旧版 .xls，请先用 Excel 另存为 .xlsx')
  if (ext === 'json') return importJson(await file.text(), base)
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return importCsv(await file.text(), base)
  throw new Error(`不支持的文件类型 .${ext}（支持 xlsx / csv / tsv / txt / json）`)
}
