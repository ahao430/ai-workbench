import { useMemo, useState } from 'react'
import { App as AntApp, Button, Empty, Tabs, Tag } from 'antd'
import { Download } from 'lucide-react'
import type { YqSheetTab } from '../../api/yuque'
import { exportExcel } from '../../lib/mdExport'
import { errText } from '../../lib/err'

/** 渲染上限：超出截断（语雀表格动辄上千行，全渲染会卡；导出不受限） */
const MAX_ROWS = 1000
const MAX_COLS = 120

/** 计算有效网格范围（按有值单元格收缩；同时给出截断标记） */
function gridOf(tab: YqSheetTab) {
  let maxR = -1
  let maxC = -1
  for (const [r, row] of Object.entries(tab.cells)) {
    for (const [c, v] of Object.entries(row)) {
      if (!v) continue
      const ri = Number(r)
      const ci = Number(c)
      if (ri > maxR) maxR = ri
      if (ci > maxC) maxC = ci
    }
  }
  return {
    rows: Math.min(maxR + 1, MAX_ROWS),
    cols: Math.min(maxC + 1, MAX_COLS),
    truncated: maxR + 1 > MAX_ROWS || maxC + 1 > MAX_COLS,
  }
}

/** 语雀表格（Sheet）渲染：多 sheet 页签 + 冻结行号 + 导出 Excel（exceljs，全部页完整导出） */
export default function SheetView({ tabs, title }: { tabs: YqSheetTab[]; title: string }) {
  const { message } = AntApp.useApp()
  const [active, setActive] = useState(0)
  const [exporting, setExporting] = useState(false)
  const tab = tabs[Math.min(active, tabs.length - 1)]
  const grid = useMemo(() => (tab ? gridOf(tab) : null), [tab])

  if (!tab || !grid || grid.rows === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="空表格" className="mt-10" />
  }

  const doExport = async () => {
    setExporting(true)
    try {
      const path = await exportExcel(title, tabs)
      message.success(`已导出：${path}`)
    } catch (e) {
      message.error(`导出失败：${errText(e)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-black/5 bg-white px-3 py-1.5 shadow-sm dark:border-white/10 dark:bg-white/5">
        {tabs.length > 1 ? (
          <Tabs
            size="small"
            activeKey={String(active)}
            onChange={(k) => setActive(Number(k))}
            items={tabs.map((t, i) => ({ key: String(i), label: t.name || `Sheet${i + 1}` }))}
          />
        ) : (
          <Tag bordered={false}>{tab.name || 'Sheet1'}</Tag>
        )}
        <span className="ml-auto text-xs text-gray-400">
          {grid.rows} 行 × {grid.cols} 列
          {grid.truncated && '（预览已截断，导出不受限）'}
        </span>
        <Button size="small" icon={<Download size={13} />} loading={exporting} onClick={() => void doExport()}>
          导出 Excel
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/10 dark:bg-white/5">
        <table className="border-separate border-spacing-0 text-[13px]" style={{ borderCollapse: 'separate' }}>
          <tbody>
            {Array.from({ length: grid.rows }, (_, r) => (
              <tr key={r}>
                <th className="sticky left-0 z-10 w-10 border-b border-r border-black/10 bg-gray-50 px-1 text-right text-[11px] font-normal tabular-nums text-gray-400 dark:border-white/10 dark:bg-white/10">
                  {r + 1}
                </th>
                {Array.from({ length: grid.cols }, (_, c) => (
                  <td
                    key={c}
                    className="max-w-[24rem] truncate border-b border-r border-black/10 px-2 py-1 whitespace-nowrap text-gray-700 dark:border-white/10 dark:text-gray-200"
                    title={tab.cells[String(r)]?.[String(c)]}
                  >
                    {tab.cells[String(r)]?.[String(c)] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
