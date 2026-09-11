import { useState } from 'react'
import { Alert, Button, Input, Modal } from 'antd'
import { Sparkles } from 'lucide-react'
import { errText } from '../../lib/err'
import { llmComplete } from '../../api/chat'
import { ensureAiServices } from '../../hooks/useAiServices'
import ProviderModelSelect, { type CascadeValue } from '../ProviderModelSelect'

const LS_KEY = 'aw-notes-ai'
const SYSTEM =
  '你是笔记编辑助手。按用户指令改进提供的 Markdown 笔记：保持原意与结构，优化表达、修正错别字与格式；只输出改进后的完整 Markdown，不要解释。'

type Stored = CascadeValue

function load(): Stored {
  try {
    return { serviceKey: null, model: null, ...(JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Partial<Stored>) }
  } catch {
    return { serviceKey: null, model: null }
  }
}

/** AI 优化笔记弹窗：默认供应商/模型（localStorage 记住）+ 指令 → 返回优化后全文 */
export default function NoteAiModal({
  open,
  content,
  onClose,
  onApply,
}: {
  open: boolean
  content: string
  onClose: () => void
  onApply: (text: string) => void
}) {
  const [sel, setSel] = useState<Stored>(load)
  const [instruction, setInstruction] = useState('润色这段笔记，让结构更清晰、表达更简洁')
  const [result, setResult] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    const svc = (await ensureAiServices()).find((x) => x.key === sel.serviceKey)
    if (!svc) {
      setError('请先选择 AI 服务')
      return
    }
    if (!sel.model?.trim()) {
      setError('请填写模型')
      return
    }
    setRunning(true)
    setError(null)
    setResult('')
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(sel))
      const out = await llmComplete({
        spec: svc.spec,
        model: sel.model.trim(),
        system: SYSTEM,
        prompt: `指令：${instruction.trim() || '润色并优化'}\n\n笔记内容：\n\n${content}`,
        temperature: 0.4,
      })
      setResult(out)
    } catch (e) {
      setError(errText(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={15} className="text-indigo-500" /> AI 优化笔记
        </span>
      }
      open={open}
      width={720}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      <div className="flex flex-col gap-3 pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <ProviderModelSelect
            value={sel}
            onChange={setSel}
            filter="text"
            placeholder="模型（可输入自定义）"
            size="middle"
          />
          <span className="text-xs text-gray-400">默认配置自动记住</span>
        </div>
        <Input.TextArea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="优化指令，例如：精简为要点清单 / 扩写第二段 / 改为周报格式"
          autoSize={{ minRows: 1, maxRows: 3 }}
        />
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={running} onClick={() => void run()}>
            生成
          </Button>
        </div>
        {error && <Alert type="error" showIcon message={error} />}
        {result && (
          <>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-black/5 bg-gray-50 p-3 text-sm dark:border-white/10 dark:bg-gray-900">
              <pre className="m-0 whitespace-pre-wrap font-sans">{result}</pre>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button onClick={() => void run()} loading={running}>
                重新生成
              </Button>
              <Button
                type="primary"
                onClick={() => {
                  onApply(result)
                  onClose()
                }}
              >
                应用到笔记
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
