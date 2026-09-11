import { useRef, useState, type ReactNode } from 'react'
import { App, Button, Empty, Input, InputNumber, Modal, Popconfirm, Table, Tag, Tooltip } from 'antd'
import { ClipboardPaste, Eraser, Plus, Table2, Trash2, Upload, Wand2 } from 'lucide-react'
import {
  MAX_ROWS,
  parseCsv,
  parseDataFile,
  parseJsonDataset,
  refreshTypes,
  type Dataset,
  type ParseResult,
} from './data'

interface Props {
  dataset: Dataset | null
  onChange: (ds: Dataset | null) => void
  /** 根据数据更新图表配置：触发右侧 AI 按最新数据重新生成当前图表 */
  onUpdateConfig: () => void
}

const TYPE_COLOR: Record<string, string> = { number: 'blue', date: 'purple', boolean: 'orange', text: 'default' }

/** 应用解析结果 */
function applyResult(res: ParseResult, name: string, message: ReturnType<typeof App.useApp>['message']): boolean {
  if (res.truncated) message.warning(`${name} 超过 ${MAX_ROWS} 行，已截断为前 ${MAX_ROWS} 行`)
  else message.success(`已导入 ${name}：${res.dataset.rows.length} 行 × ${res.dataset.columns.length} 列`)
  return true
}

/**
 * 数据看板（图表页「数据」视图）：上传/粘贴/新建表格导入数据，表格内双击编辑单元格、
 * 增删行；一键让 AI 按最新数据重生成左侧图表配置。数据集全局共享（两个图表库同一份）。
 */
export default function DataBoard({ dataset, onChange, onUpdateConfig }: Props) {
  const { message } = App.useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  // 单元格编辑：正在编辑的行列 + 草稿值
  const [editing, setEditing] = useState<{ row: number; col: string } | null>(null)
  const [draft, setDraft] = useState('')

  // 粘贴弹窗
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteErr, setPasteErr] = useState<string | null>(null)

  // 新建表格弹窗
  const [newOpen, setNewOpen] = useState(false)
  const [newCols, setNewCols] = useState('')
  const [newRows, setNewRows] = useState(5)
  const [newErr, setNewErr] = useState<string | null>(null)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try {
      const res = await parseDataFile(file)
      applyResult(res, file.name, message)
      onChange(refreshTypes(res.dataset))
    } catch (e) {
      message.error(`${file.name} 解析失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const onPaste = () => {
    const text = pasteText.trim()
    if (!text) return
    try {
      // 先按 JSON 试，失败回落 CSV
      let res: ParseResult
      try {
        res = parseJsonDataset(text)
      } catch {
        res = parseCsv(text)
      }
      applyResult(res, '粘贴数据', message)
      onChange(res.dataset)
      setPasteOpen(false)
      setPasteText('')
      setPasteErr(null)
    } catch (e) {
      setPasteErr(e instanceof Error ? e.message : String(e))
    }
  }

  const createTable = () => {
    const cols = newCols
      .split(/[,，;；\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!cols.length) return void setNewErr('至少填写一个列名')
    // 重名列加序号
    const seen = new Set<string>()
    const columns = cols.map((c) => {
      let key = c
      let n = 2
      while (seen.has(key)) key = `${c}(${n++})`
      seen.add(key)
      return key
    })
    const ds: Dataset = {
      name: `表格 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      columns: columns.map((key) => ({ key, type: 'text' })),
      rows: Array.from({ length: newRows }, () => Object.fromEntries(columns.map((c) => [c, '']))),
      addedAt: Date.now(),
    }
    onChange(ds)
    message.success(`已新建表格：${columns.length} 列 × ${newRows} 行，点击单元格开始录入`)
    setNewOpen(false)
    setNewCols('')
    setNewErr(null)
  }

  // ---------- 表格编辑 ----------

  const startEdit = (row: number, col: string, v: unknown) => {
    setEditing({ row, col })
    setDraft(v == null ? '' : String(v))
  }

  const commitEdit = () => {
    if (!editing || !dataset) return
    const { row, col } = editing
    const colType = dataset.columns.find((c) => c.key === col)?.type
    // 数字列尽量保数值（填了非数字就按文本保存，类型下次刷新时重推）
    const val: string | number =
      colType === 'number' && draft.trim() !== '' && Number.isFinite(Number(draft)) ? Number(draft) : draft
    if (String(dataset.rows[row]?.[col] ?? '') === String(val)) {
      setEditing(null)
      return
    }
    const rows = dataset.rows.map((r, i) => (i === row ? { ...r, [col]: val } : r))
    onChange(refreshTypes({ ...dataset, rows }))
    setEditing(null)
  }

  const addRow = () => {
    if (!dataset) return
    if (dataset.rows.length >= MAX_ROWS) return void message.warning(`最多 ${MAX_ROWS} 行`)
    onChange({ ...dataset, rows: [...dataset.rows, Object.fromEntries(dataset.columns.map((c) => [c.key, '']))] })
  }

  const delRow = (i: number) => {
    if (!dataset) return
    onChange(refreshTypes({ ...dataset, rows: dataset.rows.filter((_, x) => x !== i) }))
  }

  const cellCls = 'cursor-pointer hover:bg-indigo-500/5 dark:hover:bg-indigo-400/10'

  const columns: Array<{ title: ReactNode; key: string; dataIndex: string; ellipsis: boolean; render: (v: unknown, _r: unknown, i: number) => ReactNode }> = [
    ...(dataset?.columns ?? []).map((c) => ({
      title: (
        <span>
          {c.key} <Tag className="mr-0 align-middle" color={TYPE_COLOR[c.type]} style={{ fontSize: 10, lineHeight: '16px' }}>{c.type}</Tag>
        </span>
      ),
      key: c.key,
      dataIndex: c.key,
      ellipsis: true,
      render: (v: unknown, _r: unknown, i: number) =>
        editing && editing.row === i && editing.col === c.key ? (
          <Input
            size="small"
            autoFocus
            variant="borderless"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPressEnter={commitEdit}
            onBlur={commitEdit}
            onFocus={(e) => e.target.select()}
          />
        ) : (
          <Tooltip title="点击编辑">
            <div className={cellCls} onClick={() => startEdit(i, c.key, v)}>
              {v == null || v === '' ? <span className="text-gray-300">-</span> : String(v)}
            </div>
          </Tooltip>
        ),
    })),
    {
      title: '',
      key: '__ops',
      dataIndex: '__ops',
      ellipsis: false,
      render: (_v: unknown, _r: unknown, i: number) => (
        <Button type="text" size="small" danger icon={<Trash2 size={12} />} onClick={() => delRow(i)} />
      ),
    },
  ]

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {dataset ? (
          <>
            <Tag className="m-0 max-w-[280px]" color="indigo">
              <span className="truncate">{dataset.name}</span>
              <span className="ml-1 opacity-75">
                {dataset.rows.length}行×{dataset.columns.length}列
              </span>
            </Tag>
            <span className="text-[11px] text-gray-400">点击单元格编辑</span>
          </>
        ) : (
          <span className="text-xs text-gray-400">导入 CSV / Excel / JSON、粘贴文本，或直接新建表格录入</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.json"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button size="small" icon={<Upload size={12} />} loading={busy} onClick={() => fileRef.current?.click()}>
            上传
          </Button>
          <Button size="small" icon={<ClipboardPaste size={12} />} onClick={() => { setPasteErr(null); setPasteOpen(true) }}>
            粘贴
          </Button>
          <Button size="small" icon={<Table2 size={12} />} onClick={() => { setNewErr(null); setNewOpen(true) }}>
            新建表格
          </Button>
          {dataset && (
            <>
              <Button size="small" icon={<Plus size={12} />} onClick={addRow}>
                加行
              </Button>
              <Button size="small" type="primary" icon={<Wand2 size={12} />} onClick={onUpdateConfig}>
                根据数据更新配置
              </Button>
              <Popconfirm title="清空数据集？" description="左侧图表不受影响，仅清空数据与 AI 上下文" onConfirm={() => onChange(null)}>
                <Button size="small" danger icon={<Eraser size={12} />} />
              </Popconfirm>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {dataset ? (
          <div className="h-full overflow-auto p-1">
            <Table
              size="small"
              bordered
              rowKey={(_, i) => String(i)}
              pagination={
                dataset.rows.length > 50
                  ? { pageSize: 50, showSizeChanger: true, pageSizeOptions: [20, 50, 100, 500], showTotal: (t) => `共 ${t} 行` }
                  : false
              }
              scroll={{ x: 'max-content' }}
              dataSource={dataset.rows}
              columns={columns}
            />
          </div>
        ) : (
          <div className="grid h-full place-items-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span className="text-xs text-gray-400">
                  暂无数据集——上传 / 粘贴 / 新建表格后，
                  <br />
                  可在对话中要求按数据画图，或点「根据数据更新配置」刷新当前图表
                </span>
              }
            />
          </div>
        )}
      </div>

      <Modal
        title="粘贴数据（CSV 或 JSON）"
        open={pasteOpen}
        onCancel={() => setPasteOpen(false)}
        onOk={onPaste}
        okText="解析并导入"
        cancelText="取消"
        okButtonProps={{ disabled: !pasteText.trim() }}
        width={640}
      >
        <Input.TextArea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={'CSV：首行为表头\n月份,销量,金额\n1月,120,9800\n\nJSON：对象数组\n[{ "月份": "1月", "销量": 120 }]'}
          autoSize={{ minRows: 10, maxRows: 20 }}
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }}
        />
        {pasteErr && (
          <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
            {pasteErr}
          </div>
        )}
      </Modal>

      <Modal
        title="新建表格"
        open={newOpen}
        onCancel={() => setNewOpen(false)}
        onOk={createTable}
        okText="创建"
        cancelText="取消"
        width={480}
      >
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 text-xs text-gray-500">列名（逗号、分号或换行分隔）</div>
            <Input.TextArea
              value={newCols}
              onChange={(e) => setNewCols(e.target.value)}
              placeholder={'月份, 产品, 销量, 金额'}
              autoSize={{ minRows: 2, maxRows: 6 }}
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-gray-500">初始行数</div>
            <InputNumber min={1} max={1000} value={newRows} onChange={(v) => setNewRows(v ?? 5)} />
          </div>
          {newErr && (
            <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
              {newErr}
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}
