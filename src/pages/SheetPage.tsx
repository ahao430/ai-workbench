import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Dropdown, Empty, Popconfirm, Spin, Splitter, Typography } from 'antd'
import { Download, Eraser, FilePlus2, Upload } from 'lucide-react'
import { isUniverSnapshot, type SheetData, type UniverSnapshot } from '../components/sheet/model'
// 纯类型导入，编译期擦除，不会把 Univer 引擎拖进页面壳 chunk
import type { UniverHandle } from '../components/sheet/UniverSheet'
import { exportCsv, exportXlsx, importSheetFile } from '../components/sheet/excel-io'
import SheetChat from '../components/sheet/SheetChat'
import { lsGet, lsSet } from '../components/diagram/shared'

// Univer 引擎 5MB+，懒加载：有草稿恢复时页面打开即挂载；空态下等用户新建/导入/AI 写表才拉取
const UniverSheetLazy = lazy(() => import('../components/sheet/UniverSheet').then((m) => ({ default: m.UniverSheet })))

/** 本地持久化键：表格快照（当前编辑草稿）；聊天历史在 SheetChat 内部管理 */
const LS_SNAP = 'aw-sheet:snap'

/** 左表格/右 AI 对话的分栏宽度（百分比，指右侧面板） */
const SPLIT_KEY = 'aw-sheet:split'
function loadSplit(): number {
  const v = Number(lsGet(SPLIT_KEY))
  return v >= 20 && v <= 78 ? v : 38
}
function saveSplit(sizes: number[]): void {
  const total = sizes[0] + sizes[1]
  if (total <= 0) return
  const pct = (sizes[1] / total) * 100
  if (pct >= 15 && pct <= 85) lsSet(SPLIT_KEY, String(Math.round(pct)))
}

/**
 * 表格工作台：左侧 Univer 电子表格（工具栏 / 公式栏 / 公式计算内置，可直接编辑），
 * 右侧 AI 对话走 function calling —— 模型调 set_sheet 工具整体写入工作簿；
 * 文件层 exceljs：导入 xlsx/csv/tsv/txt/json，导出 xlsx/csv。
 */
export default function SheetPage() {
  const { message } = App.useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const sheetRef = useRef<UniverHandle>(null)
  // Univer 编辑会触发 CommandExecuted → 版本号自增，驱动防抖保存
  const [version, setVersion] = useState(0)

  // 恢复上次工作簿（仅挂载时读一次）
  const initialSnapshot = useMemo<UniverSnapshot | null>(() => {
    const raw = lsGet(LS_SNAP)
    if (!raw) return null
    try {
      const v: unknown = JSON.parse(raw)
      return isUniverSnapshot(v) ? v : null
    } catch {
      return null
    }
  }, [])

  // 编辑器门控：有草稿则打开页面即加载 Univer；否则空态等交互（新建/导入/AI 写表）
  const [editorOn, setEditorOn] = useState(() => initialSnapshot !== null)
  // 编辑器就绪前排队的数据（懒加载 chunk 在途时 AI/导入 先到）
  const pendingRef = useRef<SheetData | null>(null)
  const readyRef = useRef(false)

  // 快照变化后防抖保存
  useEffect(() => {
    if (version === 0) return
    const id = setTimeout(() => {
      const snap = sheetRef.current?.getSnapshot()
      if (snap) lsSet(LS_SNAP, JSON.stringify(snap))
    }, 800)
    return () => clearTimeout(id)
  }, [version])

  /** 数据落地：引擎就绪直接写；否则点亮编辑器，onReady 后冲放 */
  const applyData = (data: SheetData) => {
    if (readyRef.current && sheetRef.current) {
      sheetRef.current.applySheetData(data)
    } else {
      pendingRef.current = data
      setEditorOn(true)
    }
    setVersion((v) => v + 1)
  }

  const handleReady = () => {
    readyRef.current = true
    if (pendingRef.current) {
      sheetRef.current?.applySheetData(pendingRef.current)
      pendingRef.current = null
    }
  }

  const onImportFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const data = await importSheetFile(file)
      applyData(data)
      message.success(`已导入 ${file.name}：${data.sheets.length} 个工作表`)
    } catch (e) {
      message.error(`${file.name} 导入失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const exportExcel = async () => {
    const data = sheetRef.current?.getSheetData()
    if (!data || !data.sheets.some((s) => s.cells.length)) return void message.warning('当前表格为空')
    try {
      await exportXlsx(data, data.sheets[0]?.name || 'sheet')
    } catch {
      message.error('导出失败')
    }
  }

  const exportCsvSheet = () => {
    const data = sheetRef.current?.getSheetData()
    if (!data || !data.sheets.some((s) => s.cells.length)) return void message.warning('当前表格为空')
    exportCsv(data, 0, data.sheets[0]?.name || 'sheet')
  }

  const clearSheet = () => {
    if (!editorOn) return void message.warning('当前没有打开的表格')
    sheetRef.current?.clear()
    lsSet(LS_SNAP, '')
    setVersion((v) => v + 1)
    message.success('已清空')
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col px-6 py-5">
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 12 }}>
        表格
      </Typography.Title>
      <Splitter layout="horizontal" className="min-h-0 flex-1" onResizeEnd={saveSplit}>
        <Splitter.Panel min="30%" max="78%">
          <div className="flex h-full min-w-0 flex-col gap-2 rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.csv,.tsv,.txt,.json"
                className="hidden"
                onChange={(e) => void onImportFile(e.target.files?.[0])}
              />
              <Button size="small" icon={<Upload size={13} />} onClick={() => fileRef.current?.click()}>
                导入
              </Button>
              <span className="text-[11px] text-gray-400">Excel / CSV / JSON</span>
              <div className="ml-auto flex items-center gap-1.5">
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      { key: 'xlsx', label: '导出 Excel' },
                      { key: 'csv', label: '导出 CSV' },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'xlsx') void exportExcel()
                      else exportCsvSheet()
                    },
                  }}
                >
                  <Button size="small" icon={<Download size={13} />}>
                    导出 ▾
                  </Button>
                </Dropdown>
                <Popconfirm title="清空当前表格？" onConfirm={clearSheet}>
                  <Button size="small" danger icon={<Eraser size={13} />}>
                    清空
                  </Button>
                </Popconfirm>
              </div>
            </div>
            {editorOn ? (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center gap-2 text-xs text-gray-400">
                    <Spin />
                    加载表格引擎…
                  </div>
                }
              >
                <UniverSheetLazy
                  ref={sheetRef}
                  initialSnapshot={initialSnapshot}
                  onChange={() => setVersion((v) => v + 1)}
                  onReady={handleReady}
                />
              </Suspense>
            ) : (
              <div className="grid h-full place-items-center">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <span className="text-xs text-gray-400">
                      尚未打开表格
                      <br />
                      引擎约 5MB，仅在需要时加载
                    </span>
                  }
                >
                  <Button size="small" type="primary" icon={<FilePlus2 size={13} />} onClick={() => setEditorOn(true)}>
                    新建空白表格
                  </Button>
                </Empty>
              </div>
            )}
          </div>
        </Splitter.Panel>
        <Splitter.Panel min="22%" defaultSize={`${loadSplit()}%`}>
          <SheetChat
            storageKey="aw-sheet:chat"
            getData={() => sheetRef.current?.getSheetData() ?? null}
            onSet={(data) => applyData(data)}
          />
        </Splitter.Panel>
      </Splitter>
    </div>
  )
}
