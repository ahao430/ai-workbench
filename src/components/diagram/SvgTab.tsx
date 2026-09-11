import { useEffect, useMemo, useState } from 'react'
import { App, Button, Input, Popconfirm, Segmented, Space, Splitter } from 'antd'
import { Check, Copy, Download, Eraser, FileCode2 } from 'lucide-react'
import DiagramChat, { makeExtractor } from './DiagramChat'
import { copyToClipboard, downloadBlob, lsGet, lsSet, svgToPngBlob, useDebounced, PANE_CLASS, TEXTAREA_STYLE, loadSplit, saveSplit } from './shared'

const LS_KEY = 'aw-diagram:svg'

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="200" viewBox="0 0 560 200" font-family="sans-serif">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#6366f1"/>
    </marker>
  </defs>
  <rect x="20" y="75" width="140" height="50" rx="10" fill="#eef2ff" stroke="#6366f1"/>
  <text x="90" y="105" text-anchor="middle" font-size="14" fill="#3730a3">打开应用</text>
  <polygon points="240,100 310,60 380,100 310,140" fill="#f0fdf4" stroke="#22c55e"/>
  <text x="310" y="105" text-anchor="middle" font-size="14" fill="#15803d">已登录？</text>
  <rect x="410" y="75" width="130" height="50" rx="25" fill="#fff7ed" stroke="#f97316"/>
  <text x="475" y="105" text-anchor="middle" font-size="14" fill="#c2410c">进入工作台</text>
  <line x1="160" y1="100" x2="234" y2="100" stroke="#6366f1" stroke-width="2" marker-end="url(#arr)"/>
  <line x1="386" y1="100" x2="404" y2="100" stroke="#6366f1" stroke-width="2" marker-end="url(#arr)"/>
  <text x="345" y="88" font-size="12" fill="#64748b">是</text>
</svg>`

const SYSTEM_PROMPT = `你是 SVG 图形专家，根据用户描述手写 SVG 矢量图。规则：
1. 把完整的 SVG 源码放在一个 \`\`\`svg 代码块中输出，除此之外只给一句以内的简短说明。
2. 必须带 xmlns="http://www.w3.org/2000/svg"，设置合适的 width/height 与 viewBox（整体不超过 900x700）。
3. 文字用中文、font-family="sans-serif"，配色协调（可参考 indigo/emerald/amber 系）；箭头用 <marker>。
4. 布局自己计算坐标：节点间距均匀、文字居中（text-anchor="middle"），连线不穿过节点。
5. 用户要求增/删/改时，基于「当前图源码」修改并保留未提及部分；用户要求画新图时整体重写。`

/** SVG 文本画图：编辑/预览切换 + 右侧 AI 对话；data URL 渲染（不执行脚本） */
export default function SvgTab() {
  const { message } = App.useApp()
  const [text, setText] = useState(() => lsGet(LS_KEY) ?? SAMPLE_SVG)
  const [view, setView] = useState<'edit' | 'preview'>('preview')
  const [copied, setCopied] = useState(false)
  const debounced = useDebounced(text, 400)

  useEffect(() => {
    lsSet(LS_KEY, text)
  }, [text])

  const err = useMemo(() => {
    if (!debounced.trim()) return null
    try {
      const doc = new DOMParser().parseFromString(debounced, 'image/svg+xml')
      return doc.getElementsByTagName('parsererror')[0] ? 'SVG 解析失败，请检查语法' : null
    } catch {
      return 'SVG 解析失败'
    }
  }, [debounced])

  const previewUrl = useMemo(
    () => (debounced.trim() && !err ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(debounced)}` : null),
    [debounced, err],
  )

  const copy = async () => {
    if (await copyToClipboard(text)) {
      setCopied(true)
      message.success('已复制')
      setTimeout(() => setCopied(false), 1500)
    } else message.error('复制失败')
  }

  const dlSvg = () => {
    if (!previewUrl) return void message.warning('先写好合法 SVG 再下载')
    downloadBlob(new Blob([text], { type: 'image/svg+xml' }), 'diagram.svg')
  }
  const dlPng = async () => {
    if (!previewUrl) return void message.warning('先写好合法 SVG 再下载')
    try {
      downloadBlob(await svgToPngBlob(text, 2), 'diagram.png')
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出失败')
    }
  }

  return (
    <Splitter layout="horizontal" className="h-[72vh]" onResizeEnd={saveSplit}>
      <Splitter.Panel min="30%" max="78%">
        <div className="flex h-full min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            size="small"
            value={view}
            onChange={(v) => setView(v as 'edit' | 'preview')}
            options={[
              { label: '编辑', value: 'edit' },
              { label: '预览', value: 'preview' },
            ]}
          />
          <Space size="small" wrap>
            <Button size="small" icon={<FileCode2 size={13} />} onClick={() => { setText(SAMPLE_SVG); setView('preview') }}>
              示例
            </Button>
            <Button size="small" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => void copy()}>
              复制
            </Button>
            <Button size="small" icon={<Download size={13} />} onClick={() => void dlPng()}>
              PNG
            </Button>
            <Button size="small" icon={<Download size={13} />} onClick={dlSvg}>
              SVG
            </Button>
            <Popconfirm title="清空编辑器？" onConfirm={() => setText('')}>
              <Button size="small" danger icon={<Eraser size={13} />}>
                清空
              </Button>
            </Popconfirm>
          </Space>
        </div>
        {view === 'edit' ? (
          <div className="min-h-0 flex-1">
            <Input.TextArea
              value={text}
              onChange={(e) => setText(e.target.value)}
              style={TEXTAREA_STYLE}
              placeholder="<svg …> 手写源码，或用右侧 AI 对话生成"
            />
          </div>
        ) : (
          <div className={`${PANE_CLASS} flex min-h-0 flex-1 items-center justify-center overflow-auto p-4`}>
            {err ? (
              <div className="text-xs" style={{ color: '#d4380d' }}>
                {err}
              </div>
            ) : previewUrl ? (
              <img src={previewUrl} alt="svg" className="max-h-full max-w-full object-contain" />
            ) : (
              <div className="text-xs text-gray-400">左侧输入 SVG 源码，实时预览</div>
            )}
          </div>
        )}
      </div>
      </Splitter.Panel>
      <Splitter.Panel min="22%" defaultSize={`${loadSplit()}%`}>
        <DiagramChat
        storageKey="aw-diagram:svg-chat"
        systemPrompt={SYSTEM_PROMPT}
        getContext={() => text}
        extractCode={makeExtractor(['<svg'])}
        onApply={(code) => {
          setText(code)
          setView('preview')
        }}
      />
      </Splitter.Panel>
    </Splitter>
  )
}
