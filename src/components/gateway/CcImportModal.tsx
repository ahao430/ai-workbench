import { useEffect, useState } from 'react'
import { Alert, App, Button, Checkbox, Empty, Modal, Tag } from 'antd'
import { Import } from 'lucide-react'
import Database from '@tauri-apps/plugin-sql'
import { errText } from '../../lib/err'
import { secretPut } from '../../api/chat'
import { ccswitchDbPath, mergeCcEntries, parseCcRow, type CcImportItem } from '../../api/ccswitch'
import { inferCurrency } from '../../lib/providerPresets'
import { providerRepo, type Provider } from '../../db/providers'

/** 从 cc-switch 一键导入供应商：读其 SQLite（只读查询），claude/codex 条目合并为双地址供应商 */
export default function CcImportModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const { message } = App.useApp()
  const [items, setItems] = useState<CcImportItem[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void scan()
  }, [open])

  const scan = async () => {
    setLoading(true)
    setError(null)
    try {
      const dbPath = await ccswitchDbPath()
      if (!dbPath) {
        setError('未检测到 cc-switch（~/.cc-switch/cc-switch.db 不存在）')
        return
      }
      const db = await Database.load(`sqlite:${dbPath}`)
      const rows = await db.select<Array<{ app_type: string; name: string; settings_config: string; is_current: number }>>(
        "SELECT app_type, name, settings_config, is_current FROM providers WHERE app_type IN ('claude','codex')",
      )
      const entries = rows
        .map((r) => parseCcRow(r.app_type, r.name, r.settings_config, r.is_current === 1))
        .filter((e): e is NonNullable<typeof e> => e !== null)
      const merged = mergeCcEntries(entries)
      // 与现有供应商去重（baseUrl 或 anthropicBaseUrl 相同 → 已存在）
      const existing: Provider[] = await providerRepo.list()
      for (const it of merged) {
        it.exists = existing.some(
          (p) =>
            p.baseUrl.replace(/\/$/, '') === it.baseUrl.replace(/\/$/, '') ||
            (it.anthropicBaseUrl && p.anthropicBaseUrl.replace(/\/$/, '') === it.anthropicBaseUrl.replace(/\/$/, '')),
        )
      }
      setItems(merged)
      setSelected(Object.fromEntries(merged.map((i) => [i.key, !i.exists])))
      // 注意：不能 close——plugin-sql 按路径缓存连接池，关闭后再次 load 会拿到已关闭的池
    } catch (e) {
      setError(`读取 cc-switch 数据失败：${errText(e)}`)
    } finally {
      setLoading(false)
    }
  }

  const doImport = async () => {
    setImporting(true)
    try {
      const picked = items.filter((i) => selected[i.key])
      // 同名追加序号
      const existing = await providerRepo.list()
      for (const it of picked) {
        let name = it.name
        let n = 2
        while (existing.some((p) => p.name === name)) {
          name = `${it.name} ${n++}`
        }
        const id = crypto.randomUUID()
        const secretRef = `provider-${id}`
        await secretPut(secretRef, it.apiKey)
        const currency = inferCurrency({ name, baseUrl: it.baseUrl })
        await providerRepo.create({
          id,
          name,
          baseUrl: it.baseUrl,
          anthropicBaseUrl: it.anthropicBaseUrl,
          secretRef,
          kind: it.kind,
          currency,
        })
        existing.push({ id, name, baseUrl: it.baseUrl, anthropicBaseUrl: it.anthropicBaseUrl ?? '', secretRef, enabled: 1, createdAt: 0, kind: it.kind, quotaType: '', showOnHome: 0, showOnTray: 0, currency })
      }
      message.success(`已导入 ${picked.length} 个供应商`)
      onImported()
      onClose()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Import size={16} className="text-indigo-500" />
          从 cc-switch 导入供应商
        </span>
      }
      open={open}
      width={640}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      {error ? (
        <Alert type="warning" showIcon message={error} className="mb-3" />
      ) : loading ? (
        <p className="py-6 text-center text-sm text-gray-400">扫描中…</p>
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="cc-switch 中没有可导入的供应商" />
      ) : (
        <>
          <p className="mb-2 text-xs text-gray-400">
            自动读取 cc-switch 的 claude / codex 供应商，相同服务的两个协议地址会合并为一条（OpenAI + Anthropic）。
          </p>
          <div className="max-h-[50vh] overflow-y-auto">
            {items.map((it) => (
              <div key={it.key} className="flex items-center gap-2 border-b border-black/5 py-2 last:border-0 dark:border-white/10">
                <Checkbox
                  checked={!!selected[it.key] && !it.exists}
                  disabled={it.exists}
                  onChange={(e) => setSelected((s) => ({ ...s, [it.key]: e.target.checked }))}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {it.name}
                    <Tag color={it.kind === 'anthropic' ? 'orange' : 'geekblue'} style={{ marginInlineEnd: 0 }}>
                      {it.kind === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                    </Tag>
                    {it.isCurrent && (
                      <Tag color="green" style={{ marginInlineEnd: 0 }}>
                        cc-switch 当前
                      </Tag>
                    )}
                    {it.exists && (
                      <Tag style={{ marginInlineEnd: 0 }}>已存在</Tag>
                    )}
                  </div>
                  <div className="truncate font-mono text-xs text-gray-400" title={it.baseUrl}>
                    {it.baseUrl}
                    {it.anthropicBaseUrl ? ` · ${it.anthropicBaseUrl}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              loading={importing}
              disabled={!items.some((i) => selected[i.key] && !i.exists)}
              onClick={() => void doImport()}
            >
              导入所选
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}
