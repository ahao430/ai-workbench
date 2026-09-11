/**
 * 表格轻量数据模型（纯 JSON，不依赖 Univer）——页面壳 / AI 上下文 / excel-io 共用。
 * 放独立模块是因为 UniverSheet 组件本身挂了 5MB+ 的 Univer 引擎（页面按需懒加载），
 * 这些纯函数要在编辑器未加载时也能用（校验快照、恢复草稿判断）。
 */

/** 与 set_sheet 工具 / excel-io 共用的轻量数据模型（= 前缀字符串表示公式） */
export interface SheetItem {
  name: string
  cells: (string | number)[][]
}
export interface SheetData {
  sheets: SheetItem[]
}

/** Univer 工作簿快照（IWorkbookData 的宽松子集，只做 JSON 持久化与回放） */
export interface UniverSnapshot {
  sheetOrder?: string[]
  sheets?: Record<string, { id?: string; name?: string; cellData?: Record<number, Record<number, { v?: unknown; f?: string }>> }>
  [key: string]: unknown
}

/** 快照是否有效（sheets 键值对 + sheet 名校验） */
export function isUniverSnapshot(v: unknown): v is UniverSnapshot {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const sheets = (v as UniverSnapshot).sheets
  if (!sheets || typeof sheets !== 'object' || Array.isArray(sheets)) return false
  const list = Object.values(sheets)
  if (list.length === 0) return false
  return list.every((s) => !!s && typeof s === 'object' && typeof (s as { name?: unknown }).name === 'string')
}

/** 快照 → SheetData（AI 上下文 / excel 导出）：f → '=公式'，v → 值；裁掉尾部空行列。 */
export function snapshotToSheetData(snap: UniverSnapshot): SheetData | null {
  const sheetsMap = snap.sheets ?? {}
  const order = Array.isArray(snap.sheetOrder) ? (snap.sheetOrder as string[]) : Object.keys(sheetsMap)
  const sheets: SheetItem[] = []
  for (const sid of order) {
    const s = sheetsMap[sid]
    if (!s?.name) continue
    const cellData = s.cellData ?? {}
    const rowKeys = Object.keys(cellData).map(Number).filter((n) => !Number.isNaN(n))
    if (rowKeys.length === 0) {
      sheets.push({ name: s.name, cells: [] })
      continue
    }
    const maxRow = Math.max(...rowKeys)
    let maxCol = 0
    for (const r of rowKeys) maxCol = Math.max(maxCol, ...Object.keys(cellData[r] ?? {}).map(Number))
    const cells: (string | number)[][] = []
    let lastNonEmptyRow = -1
    for (let r = 0; r <= maxRow; r++) {
      const row: (string | number)[] = []
      let nonEmpty = false
      for (let c = 0; c <= maxCol; c++) {
        const cd = cellData[r]?.[c]
        let val: string | number = ''
        if (cd) {
          // Univer 快照里 f 自带前导 =，剥掉再统一补，避免上下文出现 == 污染模型输出
          if (typeof cd.f === 'string' && cd.f !== '') val = `=${cd.f.replace(/^=+/, '')}`
          else if (typeof cd.v === 'number') val = cd.v
          else if (typeof cd.v === 'string' && cd.v !== '') val = cd.v
        }
        if (val !== '') nonEmpty = true
        row.push(val)
      }
      cells.push(row)
      if (nonEmpty) lastNonEmptyRow = r
    }
    const trimmed = cells
      .slice(0, lastNonEmptyRow + 1)
      .map((row) => {
        while (row.length > 0 && row[row.length - 1] === '') row.pop()
        return row
      })
    sheets.push({ name: s.name, cells: trimmed })
  }
  return sheets.length > 0 ? { sheets } : null
}
