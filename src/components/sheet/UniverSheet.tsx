import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { createUniver, LocaleType, mergeLocales, type FUniver } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import '@univerjs/preset-sheets-core/lib/index.css'
import { snapshotToSheetData, type SheetData, type UniverSnapshot } from './model'

type WorkbookData = Parameters<FUniver['createWorkbook']>[0]

/** 0 起列号 → 列字母（A、B、…、AA）。 */
function colName(n: number): string {
  let s = ''
  let x = n
  do {
    s = String.fromCharCode(65 + (x % 26)) + s
    x = Math.floor(x / 26) - 1
  } while (x >= 0)
  return s
}

/**
 * 就地重写当前工作簿（不 dispose 单元）：同名 sheet 复用、多余的删、缺的建，
 * 每个 sheet 先清空已用区域再 setValues（'=xxx' 由 Facade 识别为公式）。
 * 之所以不 disposeUnit + createWorkbook 整簿替换：实测第二次起公式引擎会与新簿脱绑，全表公式 #VALUE!。
 */
function applyDataInPlace(api: FUniver, data: SheetData): void {
  let wb = api.getActiveWorkbook()
  if (!wb) wb = api.createWorkbook({} as WorkbookData)

  // 目标 sheet：同名复用，缺的新建
  const targets = data.sheets.map((s) => {
    let ws = wb.getSheetByName(s.name)
    if (!ws) {
      ws = wb.insertSheet()
      ws.setName(s.name)
    }
    return ws
  })
  // 删除不在目标里的旧 sheet
  for (const s of wb.getSheets()) {
    if (!data.sheets.some((d) => d.name === s.getSheetName())) wb.deleteSheet(s)
  }
  // 逐 sheet：清旧写新（公式串防御性归一为单个前导 =）
  data.sheets.forEach((d, i) => {
    const ws = targets[i]
    if (!ws) return
    ws.getDataRange().clear()
    if (d.cells.length === 0) return
    const maxCol = Math.max(...d.cells.map((row) => row.length))
    if (maxCol <= 0) return
    const values = d.cells.map((row) => row.map((v) => (typeof v === 'string' && v.startsWith('=') ? `=${v.replace(/^=+/, '')}` : v)))
    ws.getRange(`A1:${colName(maxCol - 1)}${d.cells.length}`).setValues(values)
  })
  // 激活第一个目标 sheet
  if (targets[0]) wb.setActiveSheet(targets[0])
}

/** 当前活跃工作簿快照（无实例 / 无工作簿时为 null）。 */
function currentSnapshot(api: FUniver | null): UniverSnapshot | null {
  const wb = api?.getActiveWorkbook()
  return (wb?.getWorkbook().getSnapshot() as UniverSnapshot | undefined) ?? null
}

export interface UniverHandle {
  /** set_sheet 工具 / 导入文件落地：整体替换工作簿 */
  applySheetData(data: SheetData): void
  /** 当前数据（含手动编辑），AI 上下文与 excel 导出用 */
  getSheetData(): SheetData | null
  /** 当前完整快照（保存/恢复用） */
  getSnapshot(): UniverSnapshot | null
  /** 回放快照 */
  loadSnapshot(snap: UniverSnapshot): void
  /** 清空为空白工作簿 */
  clear(): void
}

/**
 * Univer 电子表格（官方 preset-sheets-core：工具栏 + 公式栏 + 公式引擎全内置）。
 * 编辑状态由 Univer 自己持有，父组件通过 onChange（CommandExecuted）感知变化。
 */
export const UniverSheet = forwardRef<
  UniverHandle,
  { initialSnapshot?: UniverSnapshot | null; onChange?: () => void; onReady?: () => void }
>(function UniverSheet({ initialSnapshot, onChange, onReady }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<FUniver | null>(null)
  // 仅挂载时使用一次（与 useEffect [] 对应）
  const initialRef = useRef(initialSnapshot)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

    useEffect(() => {
    // StrictMode（dev）下 effect 双执行：挂载→清理→再挂载在同一渲染周期内发生。
    // Univer 是 canvas 引擎，dispose 会同步卸载它内部的 React UI root，周期内
    // create→dispose→create 会打断第二个实例的 UI 挂载（画布/工具栏整体不渲染，
    // 公式栏在 0 尺寸容器里排版报 "column width is less than 0"）。
    // 因此延迟到下一个宏任务初始化：假卸载只会取消定时器，真卸载才 dispose。
    // 不用 requestAnimationFrame——页面不可见时它会被暂停，表格就一直空白。
    let instance: ReturnType<typeof createUniver> | null = null
    let disposable: { dispose(): void } | null = null
    const timer = window.setTimeout(() => {
      instance = createUniver({
        locale: LocaleType.ZH_CN,
        locales: { [LocaleType.ZH_CN]: mergeLocales(UniverPresetSheetsCoreZhCN) },
        presets: [UniverSheetsCorePreset({ container: containerRef.current! })],
      })
      apiRef.current = instance.univerAPI
      instance.univerAPI.createWorkbook((initialRef.current ?? {}) as WorkbookData)
      disposable = instance.univerAPI.addEvent(instance.univerAPI.Event.CommandExecuted, () => onChangeRef.current?.())
      // 实例+工作簿就绪（页面据此冲放在编辑器加载期间排队的数据）
      onReadyRef.current?.()
    })
    return () => {
      window.clearTimeout(timer)
      try {
        disposable?.dispose()
        instance?.univer.dispose()
      } catch {
        // 卸载途中实例已部分释放时 Univer 可能抛错，忽略
      }
      apiRef.current = null
    }
    }, [])

    useImperativeHandle(
      ref,
      (): UniverHandle => ({
        applySheetData(data) {
          if (apiRef.current) applyDataInPlace(apiRef.current, data)
        },
        getSheetData() {
          const snap = currentSnapshot(apiRef.current)
          return snap ? snapshotToSheetData(snap) : null
        },
        getSnapshot() {
          return currentSnapshot(apiRef.current)
        },
        loadSnapshot(snap) {
          const api = apiRef.current
          if (!api) return
          const cur = api.getActiveWorkbook()
          if (cur) api.disposeUnit(cur.getId())
          api.createWorkbook(snap as WorkbookData)
        },
        clear() {
          const api = apiRef.current
          if (!api) return
          const cur = api.getActiveWorkbook()
          if (cur) api.disposeUnit(cur.getId())
          api.createWorkbook({} as WorkbookData)
        },
      }),
      [],
    )

    return <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
  },
)
