import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Dropdown, Input, Popconfirm, Segmented, Space, Splitter } from 'antd'
import { Copy, Download, Eraser, ExternalLink, FileCode2 } from 'lucide-react'
import DiagramChat, { makeExtractor } from './DiagramChat'
import { copyToClipboard, lsGet, lsSet, loadSplit, saveSplit } from './shared'

const LS_KEY = 'aw-diagram:drawio'

// 官方 embed 编辑器（jgraph/drawio）：iframe + postMessage JSON 协议，完整画布可拖拽 / 选工具。
// proto=json 走机器消息；saveAndExit/noSaveBtn 关掉保存按钮（编辑经 autosave 实时同步回来）。
const EDITOR_EMBED_URL =
  'https://embed.diagrams.net/?embed=1&proto=json&libraries=1&saveAndExit=0&noSaveBtn=1&noExitBtn=1&spin=1'
const EDITOR_URL = 'https://app.diagrams.net/'

const SAMPLE_XML = `<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="2" value="开始" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
      <mxGeometry x="40" y="40" width="160" height="50" as="geometry"/>
    </mxCell>
    <mxCell id="3" value="已登录？" style="rhombus;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
      <mxGeometry x="240" y="30" width="120" height="70" as="geometry"/>
    </mxCell>
    <mxCell id="4" value="进入工作台" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
      <mxGeometry x="400" y="40" width="160" height="50" as="geometry"/>
    </mxCell>
    <mxCell id="5" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;" edge="1" source="2" target="3" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
    <mxCell id="6" value="是" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;" edge="1" source="3" target="4" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>`

const EMPTY_XML = `<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
  </root>
</mxGraphModel>`

/** 轻量 XML 校验：DOMParser 解析无 parsererror 即认为合法 */
function xmlError(xml: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const err = doc.getElementsByTagName('parsererror')[0]
    if (!err) return null
    return ((err.textContent ?? 'XML 解析失败').split('\n')[0]) ?? 'XML 解析失败'
  } catch {
    return 'XML 解析失败'
  }
}

/** drawio #create URL 用的压缩：encodeURIComponent → raw DEFLATE → Base64（官方约定） */
async function deflateRawBase64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(encodeURIComponent(text))
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const buf = new Uint8Array(await new Response(stream).arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

/** 生成 app.diagrams.net 的 #create 链接（浏览器本地压缩，图内容不经我方服务） */
async function buildDrawioEditUrl(xml: string): Promise<string> {
  const data = await deflateRawBase64(xml)
  const create = JSON.stringify({ type: 'xml', compressed: true, data })
  return `${EDITOR_URL}?grid=0&pv=0#create=${encodeURIComponent(create)}`
}

/** 简化 mxGraphModel → 完整 .drawio 文件（未压缩，drawio 可直接打开） */
function wrapDrawioFile(xml: string): string {
  const model = xml.trim()
  if (model.startsWith('<mxfile')) return `${model}\n`
  return `<mxfile host="ai-workbench-app">\n  <diagram id="diagram" name="第 1 页">\n    ${
    model.startsWith('<mxGraphModel') ? model : `<mxGraphModel>${model}</mxGraphModel>`
  }\n  </diagram>\n</mxfile>\n`
}

const SYSTEM_PROMPT = `你是 draw.io 图表专家，根据用户描述生成 mxGraphModel XML。规则：
1. 把完整的 <mxGraphModel> XML 放在一个 \`\`\`xml 代码块中输出，除此之外只给一句以内的简短说明。
2. 结构：<root><mxCell id="0"/><mxCell id="1" parent="0"/> 之后是节点（vertex="1" parent="1" + <mxGeometry x y width height as="geometry"/>）与连线（edge="1" parent="1" source/target + <mxGeometry relative="1" as="geometry"/>）。
3. 自己计算布局坐标：从左到右或从上到下流动，节点 160x50 左右、间距 60+，避免重叠；菱形 style="rhombus;whiteSpace=wrap;html=1;"，圆角矩形加 rounded=1。
4. 节点文字 value 用中文；可加 fillColor/strokeColor（#dae8fc/#6c8ebf、#d5e8d4/#82b366、#ffe6cc/#d79b00 等配色）。
5. 用户要求增/删/改时，基于「当前图源码」修改并保留未提及的 mxCell（保留原 id）；用户要求画新图时整体重写。`

/** drawio 画图：官方 embed 编辑器（iframe），画布可自由拖拽编辑，autosave 实时回写 XML；可切 XML 文本模式 */
export default function DrawioTab() {
  const { message } = App.useApp()
  const [xmlText, setXmlText] = useState(() => lsGet(LS_KEY) ?? SAMPLE_XML)
  const [mode, setMode] = useState<'canvas' | 'xml'>('canvas')
  const parseError = useMemo(() => xmlError(xmlText), [xmlText])

  useEffect(() => {
    lsSet(LS_KEY, xmlText)
  }, [xmlText])

  // 「在 draw.io 中打开」链接预计算：压缩是异步的，等压缩完再 window.open 会脱离
  // 用户手势被弹窗拦截 → XML 变化时后台算好缓存，点击时同步打开。
  const [editUrl, setEditUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (parseError) {
      setEditUrl(null)
      return
    }
    buildDrawioEditUrl(xmlText)
      .then((u) => alive && setEditUrl(u))
      .catch(() => alive && setEditUrl(null))
    return () => {
      alive = false
    }
  }, [xmlText, parseError])

  // 导出 PNG：向 embed 编辑器发 export action，编辑器把渲染结果经 event:export 回传
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const exportingRef = useRef(false)
  const exportPng = () => {
    const win = iframeRef.current?.contentWindow
    if (!win || exportingRef.current) return
    exportingRef.current = true
    window.setTimeout(() => {
      if (exportingRef.current) {
        exportingRef.current = false
        message.error('导出超时（画布可能还没就绪），稍后重试')
      }
    }, 8000)
    win.postMessage(JSON.stringify({ action: 'export', format: 'png', xml: xmlText, scale: 1, border: 4 }), '*')
  }

  return (
    <Splitter layout="horizontal" className="h-[72vh]" onResizeEnd={saveSplit}>
      <Splitter.Panel min="30%" max="78%">
        <div className="flex h-full min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => setMode(v as 'canvas' | 'xml')}
            options={[
              { label: '画布', value: 'canvas' },
              { label: 'XML', value: 'xml' },
            ]}
          />
          <Space size="small" wrap>
            <Button size="small" icon={<FileCode2 size={13} />} onClick={() => setXmlText(SAMPLE_XML)}>
              示例
            </Button>
            <Dropdown
              menu={{
                items: [
                  { key: 'png', label: '导出 PNG' },
                  { key: 'drawio', label: '下载 .drawio' },
                ],
                onClick: ({ key }) => {
                  if (key === 'png') exportPng()
                  else {
                    const blob = new Blob([wrapDrawioFile(xmlText)], { type: 'application/xml' })
                    const a = document.createElement('a')
                    a.href = URL.createObjectURL(blob)
                    a.download = 'diagram.drawio'
                    a.click()
                    URL.revokeObjectURL(a.href)
                  }
                },
              }}
            >
              <Button size="small" icon={<Download size={13} />}>
                导出
              </Button>
            </Dropdown>
            <Button
              size="small"
              icon={<Copy size={13} />}
              onClick={() => void copyToClipboard(xmlText).then((ok) => (ok ? message.success('XML 已复制') : message.error('复制失败')))}
            >
              复制
            </Button>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<ExternalLink size={13} />}
              onClick={() => {
                if (parseError) return void message.warning('XML 不合法，无法打开')
                if (!editUrl) return void message.warning('链接生成中，稍后再点')
                window.open(editUrl, '_blank', 'noreferrer')
              }}
            >
              在 draw.io 中打开
            </Button>
            <Popconfirm title="清空画布？" onConfirm={() => setXmlText(EMPTY_XML)}>
              <Button size="small" danger icon={<Eraser size={13} />}>
                清空
              </Button>
            </Popconfirm>
          </Space>
        </div>
        {mode === 'canvas' ? (
          <DrawioEditor
            xml={xmlText}
            valid={!parseError}
            onXmlChange={setXmlText}
            onIframe={(el) => {
              iframeRef.current = el
            }}
            onExportData={(data) => {
              if (!exportingRef.current) return
              exportingRef.current = false
              const dataUrl = data.startsWith('data:') ? data : `data:image/png;base64,${data}`
              const a = document.createElement('a')
              a.href = dataUrl
              a.download = 'diagram.png'
              a.click()
              message.success('已导出 PNG')
            }}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-1">
            <div className="min-h-0 flex-1">
              <Input.TextArea
                value={xmlText}
                onChange={(e) => setXmlText(e.target.value)}
                style={{ height: '100%', resize: 'none', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}
              />
            </div>
            {parseError && (
              <div className="text-xs" style={{ color: '#d4380d' }}>
                {parseError}
              </div>
            )}
          </div>
        )}
      </div>
      </Splitter.Panel>
      <Splitter.Panel min="22%" defaultSize={`${loadSplit()}%`}>
        <DiagramChat
        storageKey="aw-diagram:drawio-chat"
        systemPrompt={SYSTEM_PROMPT}
        getContext={() => xmlText}
        extractCode={makeExtractor(['<mxGraphModel', '<mxfile'])}
        onApply={(code) => {
          setXmlText(code)
          setMode('canvas')
        }}
      />
      </Splitter.Panel>
    </Splitter>
  )
}

/** drawio embed 协议消息（官方 postMessage JSON 协议的子集） */
interface DrawioEvent {
  event?: string
  xml?: string
  data?: string
}

/**
 * drawio embed 编辑器：
 *   init → 宿主 load(xml)；用户编辑 → autosave 事件回传整份 xml；
 *   外部 xml 变化（手改 XML 切回画布）→ 再 load。lastSynced 记录两侧一致的 xml 防回环。
 */
function DrawioEditor({
  xml,
  valid,
  onXmlChange,
  onIframe,
  onExportData,
}: {
  xml: string
  valid: boolean
  onXmlChange: (xml: string) => void
  onIframe?: (el: HTMLIFrameElement | null) => void
  onExportData?: (data: string) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [ready, setReady] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const lastSynced = useRef<string | null>(null)
  const onExportDataRef = useRef(onExportData)
  onExportDataRef.current = onExportData

  // 握手 + autosave 接收；xml 变化不重建监听（外部推送由下面的 effect 负责）
  const xmlRef = useRef(xml)
  xmlRef.current = xml
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const win = iframeRef.current?.contentWindow
      if (!win || e.source !== win) return
      let msg: DrawioEvent
      try {
        msg = (typeof e.data === 'string' ? JSON.parse(e.data) : e.data) as DrawioEvent
      } catch {
        return
      }
      if (msg.event === 'init') {
        setLoadFailed(false)
        setReady(true)
        const cur = xmlRef.current
        lastSynced.current = cur
        win.postMessage(JSON.stringify({ action: 'load', xml: cur, autosave: 1 }), '*')
      } else if ((msg.event === 'autosave' || msg.event === 'save') && typeof msg.xml === 'string') {
        lastSynced.current = msg.xml
        onXmlChange(msg.xml)
      } else if (msg.event === 'export' && typeof msg.data === 'string') {
        onExportDataRef.current?.(msg.data)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onXmlChange])

  // 外部 xml 变化 → 推给编辑器（编辑器自己改出来的已在 lastSynced，跳过）
  useEffect(() => {
    if (!ready || !valid || xml === lastSynced.current) return
    const win = iframeRef.current?.contentWindow
    if (!win) return
    lastSynced.current = xml
    win.postMessage(JSON.stringify({ action: 'load', xml, autosave: 1 }), '*')
  }, [xml, ready, valid])

  // CDN 偶发很慢：加载中给提示，60s 还没握手给重试
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (ready) return
    setLoadFailed(false)
    const timer = setTimeout(() => setLoadFailed(true), 60000)
    return () => clearTimeout(timer)
  }, [attempt, ready])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <iframe
        key={attempt}
        ref={(el) => {
          iframeRef.current = el
          onIframe?.(el)
        }}
        src={EDITOR_EMBED_URL}
        title="drawio"
        className="w-full flex-1 rounded-lg border border-gray-200 dark:border-gray-700"
        style={{ border: 'none', opacity: ready ? 1 : 0 }}
      />
      {!ready && !loadFailed && <div className="p-2 text-xs text-gray-400">正在加载 drawio 画布（embed.diagrams.net，需联网）…</div>}
      {loadFailed && (
        <div className="p-2 text-xs" style={{ color: '#d4380d' }}>
          embed.diagrams.net 加载失败或超时（CDN 偶发慢 / 内网拦截）。
          <Button size="small" className="mx-2" onClick={() => setAttempt((n) => n + 1)}>
            重试
          </Button>
          仍不行可下载 .drawio 用桌面版打开。
        </div>
      )}
    </div>
  )
}
