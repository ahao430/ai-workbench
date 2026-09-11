/**
 * 图表数据看板的数据层：CSV / Excel / JSON → 统一数据集（列名 + 行对象数组），
 * 并生成注入 AI 系统提示的数据段（列类型、数值列统计、样本行）。
 * 数据只在本机（内存 + localStorage），不经任何远端。
 */
import { loadExcelWorkbook } from '../../lib/exceljsLoad'

/** 列类型（按值抽样推断，展示与提示词用，不做强校验） */
export type ColumnType = 'number' | 'date' | 'boolean' | 'text'

export interface DatasetColumn {
  key: string
  type: ColumnType
}

export interface Dataset {
  /** 来源名：文件名 / 「粘贴数据」 */
  name: string
  columns: DatasetColumn[]
  rows: Array<Record<string, unknown>>
  /** 导入时间 ms */
  addedAt: number
}

/** 单个数据集最大行数：超出截断（防内存/localStorage 爆掉） */
export const MAX_ROWS = 10000

export interface ParseResult {
  dataset: Dataset
  /** 超过 MAX_ROWS 被截断 */
  truncated: boolean
}

// ---------- 标量清洗 ----------

/** 数字形态的字符串转数值；前导零 / 超 15 位数字保持文本防失真（与 Excel 导出同规则） */
function coerceScalar(v: string): string | number {
  const s = v.trim()
  if (!s) return ''
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) && s.replace(/[^0-9]/g, '').length <= 15) return Number(s)
  return s
}

/** exceljs 单元格值可能为富文本/公式结果/日期等，统一还原为标量 */
function cellScalar(v: unknown): string | number | boolean | null {
  if (v == null) return null
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  if (v instanceof Date) {
    const iso = v.toISOString()
    // 有时分秒才带时间，纯日期更利于按天聚合
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ')
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('result' in o) return cellScalar(o.result)
    if (Array.isArray(o.richText)) {
      const text = (o.richText as Array<{ text: string }>).map((t) => t.text).join('')
      return coerceScalar(text) === '' ? '' : String(coerceScalar(text))
    }
    if ('text' in o) return String(o.text)
    if ('error' in o) return null
  }
  return String(v)
}

/** JSON 值清洗：对象/数组转 JSON 文本，其余原样 */
function jsonScalar(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === 'object' && v !== null && !(v instanceof Date)) return JSON.stringify(v)
  return v
}

// ---------- 类型推断 ----------

const DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/

/** 对列值抽样（≤200 个非空值）推断类型：全部数字→number，全部日期串→date，全部布尔→boolean */
export function inferColumnType(values: unknown[]): ColumnType {
  const sample = values.filter((v) => v !== null && v !== '' && v !== undefined).slice(0, 200)
  if (!sample.length) return 'text'
  const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim()))
  const isDate = (v: unknown) => typeof v === 'string' && DATE_RE.test(v.trim())
  const isBool = (v: unknown) => typeof v === 'boolean'
  if (sample.every(isBool)) return 'boolean'
  if (sample.every(isNum)) return 'number'
  if (sample.every((v) => typeof v === 'string' && (isDate(v) || v.trim() === ''))) return 'date'
  return 'text'
}

function buildDataset(name: string, columns: string[], rows: Array<Record<string, unknown>>): Dataset {
  const cols = columns.map((key) => ({ key, type: inferColumnType(rows.map((r) => r[key])) }))
  return { name, columns: cols, rows, addedAt: Date.now() }
}

function capRows(name: string, columns: string[], rows: Array<Record<string, unknown>>): ParseResult {
  const truncated = rows.length > MAX_ROWS
  return { dataset: buildDataset(name, columns, truncated ? rows.slice(0, MAX_ROWS) : rows), truncated }
}

// ---------- CSV ----------

/** 首行引号外出现次数最多的分隔符（Excel 中文环境常导出 ; 或 Tab） */
function detectDelimiter(line: string): string {
  const counts: Array<[string, number]> = [
    [',', 0],
    [';', 0],
    ['\t', 0],
  ]
  let inQ = false
  for (const ch of line) {
    if (ch === '"') inQ = !inQ
    else if (!inQ) {
      const hit = counts.find(([d]) => d === ch)
      if (hit) hit[1]++
    }
  }
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ','
}

/** CSV 解析：引号/转义引号/换行在引号内/CRLF 全支持 */
export function parseCsv(text: string, name = '粘贴数据'): ParseResult {
  const t = text.replace(/^\uFEFF/, '')
  const nl = t.indexOf('\n')
  const delim = detectDelimiter(nl >= 0 ? t.slice(0, nl) : t)

  const cells: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQ = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inQ) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          cell += '"'
          i++
        } else inQ = false
      } else cell += ch
    } else if (ch === '"') {
      inQ = true
    } else if (ch === delim) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      cells.push(row)
      row = []
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    cells.push(row)
  }
  // 去尾部全空行
  while (cells.length && cells[cells.length - 1].every((c) => c.trim() === '')) cells.pop()

  const [header, ...body] = cells
  if (!header?.some((h) => h.trim())) throw new Error('CSV 缺少表头（首行全空）')
  const columns = header.map((h, i) => h.trim() || `列${i + 1}`)
  const rows = body
    .map((r) => Object.fromEntries(columns.map((c, i) => [c, coerceScalar(r[i] ?? '')])))
    .filter((r) => Object.values(r).some((v) => v !== '' && v !== null))
  if (!rows.length) throw new Error('CSV 没有可用的数据行')
  return capRows(name, columns, rows)
}

// ---------- JSON ----------

/** JSON 数据集兼容多种形态：对象数组 / 二维数组（首行表头）/{columns,data} / 列式对象 */
export function parseJsonDataset(text: string, name = '粘贴数据'): ParseResult {
  const v = JSON.parse(text) as unknown
  let columns: string[] = []
  let rawRows: Array<Record<string, unknown>> = []

  if (Array.isArray(v)) {
    if (v.length === 0) throw new Error('JSON 数组为空')
    if (v.every((r) => Array.isArray(r))) {
      // 二维数组：首行作表头
      const [header, ...body] = v as unknown[][]
      columns = (header as unknown[]).map((h, i) => (h == null || h === '' ? `列${i + 1}` : String(h)))
      rawRows = (body as unknown[][]).map((r) =>
        Object.fromEntries(columns.map((c, i) => [c, jsonScalar(r[i] ?? null)])),
      )
    } else {
      // 对象数组：列名取全部键的并集（保持首见顺序）
      const keys = new Set<string>()
      for (const r of v as unknown[]) {
        if (r && typeof r === 'object' && !Array.isArray(r)) Object.keys(r as object).forEach((k) => keys.add(k))
      }
      if (!keys.size) throw new Error('JSON 数组元素不是对象')
      columns = [...keys]
      rawRows = (v as Array<Record<string, unknown>>).map((r) =>
        Object.fromEntries(columns.map((c) => [c, jsonScalar(r?.[c] ?? null)])),
      )
    }
  } else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const data = (Array.isArray(o.data) ? o.data : Array.isArray(o.rows) ? o.rows : null) as unknown[] | null
    if (data) {
      // {data|rows: [...]} 可选 columns 指定列顺序
      const inner = parseJsonDataset(JSON.stringify(data), name)
      const order = Array.isArray(o.columns) ? (o.columns as unknown[]).map(String) : null
      columns = order ?? inner.dataset.columns.map((c) => c.key)
      rawRows = inner.dataset.rows
      if (order) {
        // 补齐缺失列
        rawRows = rawRows.map((r) => Object.fromEntries(columns.map((c) => [c, jsonScalar(r[c] ?? null)])))
      }
    } else {
      // 列式对象 {a:[...], b:[...]}：等长数组转置为行
      const entries = Object.entries(o).filter(([, val]) => Array.isArray(val))
      if (entries.length && entries.every(([, arr]) => (arr as unknown[]).length === (entries[0][1] as unknown[]).length)) {
        columns = entries.map(([k]) => k)
        const len = (entries[0][1] as unknown[]).length
        rawRows = Array.from({ length: len }, (_, i) =>
          Object.fromEntries(columns.map((c, j) => [c, jsonScalar((entries[j][1] as unknown[])[i] ?? null)])),
        )
      } else {
        throw new Error('JSON 不是支持的形态（对象数组 / 二维数组 / {data} / 列式对象）')
      }
    }
  } else {
    throw new Error('JSON 根节点必须是数组或对象')
  }

  const rows = rawRows.filter((r) => Object.values(r).some((x) => x !== null && x !== ''))
  if (!rows.length) throw new Error('JSON 没有可用的数据行')
  return capRows(name, columns, rows)
}

// ---------- Excel ----------

/** xlsx 读取（exceljs 仅支持 .xlsx；旧版 .xls 由调用方拦截提示） */
export async function parseExcelBuffer(buf: ArrayBuffer, name: string): Promise<ParseResult> {
  const Workbook = await loadExcelWorkbook()
  const wb = new Workbook()
  await wb.xlsx.load(buf)
  const ws = wb.worksheets.find((s) => s.rowCount > 0)
  if (!ws) throw new Error('Excel 没有可用的工作表')

  const grid: Array<Array<string | number | boolean | null>> = []
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals: Array<string | number | boolean | null> = []
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      vals[col - 1] = cellScalar(cell.value)
    })
    grid.push(vals)
  })
  // eachRow(includeEmpty:false) 已跳过全空行；再滤一次防御
  const rows2d = grid.filter((r) => r.some((c) => c !== null && c !== ''))
  if (rows2d.length < 2) throw new Error('Excel 缺少表头或数据行')

  const header = rows2d[0]
  const width = Math.max(...rows2d.map((r) => r.length))
  const columns: string[] = []
  for (let i = 0; i < width; i++) {
    const h = header[i]
    const base = h == null || h === '' ? `列${i + 1}` : String(h)
    // 重名列加序号，避免行对象键互相覆盖
    let key = base
    let n = 2
    while (columns.includes(key)) key = `${base}(${n++})`
    columns.push(key)
  }
  const rows = rows2d.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])))
  return capRows(name, columns, rows)
}

// ---------- 文件分发 ----------

/** 按扩展名解析数据文件为数据集 */
export async function parseDataFile(file: File): Promise<ParseResult> {
  const name = file.name
  const lower = name.toLowerCase()
  if (lower.endsWith('.xlsx')) {
    return parseExcelBuffer(await file.arrayBuffer(), name)
  }
  if (lower.endsWith('.xls')) {
    throw new Error('暂不支持旧版 .xls，请先用 Excel 另存为 .xlsx')
  }
  const text = await file.text()
  if (lower.endsWith('.json')) return parseJsonDataset(text, name)
  // .csv/.tsv/.txt 都按分隔文本解析
  return parseCsv(text, name)
}

// ---------- 提示词 ----------

function fmtVal(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n]/.test(s) ? JSON.stringify(s) : s
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** 数据集 → 注入系统提示的文本段；无数据集返回空串 */
export function datasetPrompt(ds: Dataset | null): string {
  if (!ds || !ds.rows.length) return ''
  const cols = ds.columns.map((c) => `${c.key}(${c.type === 'text' ? '文本' : c.type === 'number' ? '数字' : c.type === 'date' ? '日期' : '布尔'})`).join('、')

  const lines: string[] = [
    `\n\n【当前数据集】${ds.name}：${ds.rows.length} 行 × ${ds.columns.length} 列`,
    `列：${cols}`,
  ]

  // 数值列统计帮助模型选尺度与聚合方式
  const stats = ds.columns
    .filter((c) => c.type === 'number')
    .map((c) => {
      const vals = ds.rows.map((r) => Number(r[c.key])).filter((n) => Number.isFinite(n))
      if (!vals.length) return null
      const sum = vals.reduce((a, b) => a + b, 0)
      return `${c.key}：min=${round2(Math.min(...vals))}，max=${round2(Math.max(...vals))}，sum=${round2(sum)}`
    })
    .filter(Boolean)
  if (stats.length) lines.push(`数值列统计：${stats.join('；')}`)

  const FULL = 60
  if (ds.rows.length <= FULL) {
    lines.push(`数据（全量 ${ds.rows.length} 行，CSV 格式，字段名与列名一致）：`)
  } else {
    lines.push(`数据（共 ${ds.rows.length} 行，仅列前 30 行样本，字段名与列名一致）：`)
  }
  lines.push(ds.columns.map((c) => c.key).join(','))
  for (const r of ds.rows.slice(0, ds.rows.length <= FULL ? FULL : 30)) {
    lines.push(ds.columns.map((c) => fmtVal(r[c.key])).join(','))
  }
  if (ds.rows.length > FULL) lines.push('（生成图表时请先按类目聚合（求和/计数/平均）或取有代表性的样本，并在说明中注明口径）')
  return lines.join('\n')
}

// ---------- 持久化 ----------

/** 编辑/新建后按当前值重推列类型（列名不变，只刷新 type） */
export function refreshTypes(ds: Dataset): Dataset {
  return {
    ...ds,
    columns: ds.columns.map((c) => ({ key: c.key, type: inferColumnType(ds.rows.map((r) => r[c.key])) })),
  }
}

const LS_KEY = 'aw-charts:dataset'

export function saveDataset(ds: Dataset | null): void {
  try {
    if (ds) localStorage.setItem(LS_KEY, JSON.stringify(ds))
    else localStorage.removeItem(LS_KEY)
  } catch {
    // 超出 localStorage 配额时放弃持久化（仅本次会话可用）
  }
}

export function loadDataset(): Dataset | null {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null') as Dataset | null
    if (v && typeof v.name === 'string' && Array.isArray(v.columns) && Array.isArray(v.rows)) {
      return { ...v, columns: v.columns.filter((c) => c && typeof c.key === 'string') }
    }
  } catch {
    /* ignore */
  }
  return null
}
