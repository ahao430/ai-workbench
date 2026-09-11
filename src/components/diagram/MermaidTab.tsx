import { useEffect, useRef, useState } from 'react'
import { App, Button, Dropdown, Input, Popconfirm, Segmented, Space, Splitter } from 'antd'
import { Check, Copy, Download, Eraser, FileCode2 } from 'lucide-react'
import DiagramChat, { makeExtractor } from './DiagramChat'
import { copyToClipboard, downloadBlob, lsGet, lsSet, svgToPngBlob, useDebounced, PANE_CLASS, TEXTAREA_STYLE, loadSplit, saveSplit } from './shared'

const LS_KEY = 'aw-diagram:mermaid'

const SAMPLES: Record<string, string> = {
  流程图: `flowchart TD
    A[开始] --> B{已登录?}
    B -- 是 --> C[进入工作台]
    B -- 否 --> D[跳转登录页]
    D --> C
    C --> E[选一个助手开始干活]`,
  时序图: `sequenceDiagram
    actor U as 用户
    participant A as 应用
    participant S as AI 服务
    U->>A: 输入问题
    A->>S: 转发请求
    S-->>A: 流式返回
    A-->>U: 渲染回答
    U->>A: 追问
    A->>S: 带上下文再请求
    S-->>A: 继续回答
    A-->>U: 渲染回答`,
  类图: `classDiagram
    class SessionRepo {
      +list() Session[]
      +create(s) void
      +remove(id) void
    }
    class MessageRepo {
      +listBySession(id) Message[]
      +add(m) void
    }
    class ChatStore {
      +send(text) void
      +stop() void
    }
    ChatStore --> SessionRepo
    ChatStore --> MessageRepo`,
  状态图: `stateDiagram-v2
    [*] --> 草稿
    草稿 --> 已提交: 提交审批
    已提交 --> 已通过: 审批通过
    已提交 --> 已驳回: 审批驳回
    已驳回 --> 草稿: 修改
    已通过 --> [*]`,
  ER图: `erDiagram
    USER ||--o{ SESSION : creates
    SESSION ||--o{ MESSAGE : contains
    USER {
      int id
      string name
    }
    SESSION {
      int id
      string title
    }
    MESSAGE {
      int id
      string content
    }`,
  甘特图: `gantt
    title 迭代排期
    dateFormat YYYY-MM-DD
    section 设计
    需求评审 :done, d1, 2026-09-01, 2d
    交互稿 :d2, after d1, 3d
    section 开发
    前端 :d3, after d2, 5d
    联调 :d4, after d3, 3d`,
  饼图: `pie title 时间分配
    "写代码" : 45
    "开会" : 25
    "评审" : 15
    "文档" : 15`,
  思维导图: `mindmap
  root((AI 工作台))
    聊天
      多模型
      流式输出
    画图
      文生图
      图生图
    流程图
      Mermaid
      PlantUML`,
}

const SYSTEM_PROMPT = `你是 Mermaid 图表专家，根据用户描述画图。规则：
1. 把完整的 mermaid 源码放在一个 \`\`\`mermaid 代码块中输出，除此之外只给一句以内的简短说明。
2. 节点与标注用中文；方向（TD/LR）与布局要清晰，避免连线交叉。
3. 用户要求增/删/改时，基于「当前图源码」修改并保留未提及部分；用户要求画新图时整体重写。
4. 只输出合法 mermaid 语法（v11），不要编造不存在的指令。`

/** Mermaid 文本画图：左侧编辑/预览切换 + 右侧大块 AI 对话，本地渲染（无网络） */
export default function MermaidTab() {
  const { message } = App.useApp()
  const [text, setText] = useState(() => lsGet(LS_KEY) ?? SAMPLES['流程图'])
  const [view, setView] = useState<'edit' | 'preview'>('preview')
  const [svg, setSvg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const seqRef = useRef(0)

  useEffect(() => {
    lsSet(LS_KEY, text)
  }, [text])

  // 防抖渲染：输入停 400ms 再渲染；乱序返回时按序号丢弃旧结果
  const debounced = useDebounced(text, 400)
  useEffect(() => {
    const seq = ++seqRef.current
    if (!debounced.trim()) {
      setSvg(null)
      setErr(null)
      return
    }
    setBusy(true)
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })
        const res = await mermaid.render(`aw-mermaid-${seq}`, debounced)
        if (seq !== seqRef.current) return
        setSvg(res.svg)
        setErr(null)
      } catch (e) {
        if (seq !== seqRef.current) return
        setSvg(null)
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (seq === seqRef.current) setBusy(false)
      }
    })()
  }, [debounced])

  const copy = async () => {
    if (await copyToClipboard(text)) {
      setCopied(true)
      message.success('已复制')
      setTimeout(() => setCopied(false), 1500)
    } else message.error('复制失败')
  }

  const dlSvg = () => {
    if (!svg) return void message.warning('先渲染成功再下载')
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'mermaid.svg')
  }
  const dlPng = async () => {
    if (!svg) return void message.warning('先渲染成功再下载')
    try {
      downloadBlob(await svgToPngBlob(svg, 2), 'mermaid.png')
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
            <Dropdown
              menu={{
                items: Object.keys(SAMPLES).map((k) => ({ key: k, label: k })),
                onClick: ({ key }) => {
                  setText(SAMPLES[key] ?? '')
                  setView('preview')
                },
              }}
            >
              <Button size="small" icon={<FileCode2 size={13} />}>
                示例 ▾
              </Button>
            </Dropdown>
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
              placeholder="输入 mermaid 文本，或用右侧 AI 对话生成"
            />
          </div>
        ) : (
          <div className={`${PANE_CLASS} min-h-0 flex-1 overflow-auto p-4`}>
            {err ? (
              <pre className="whitespace-pre-wrap text-xs" style={{ color: '#d4380d' }}>
                渲染失败：{err}
              </pre>
            ) : svg ? (
              <div className="mx-auto w-fit" dangerouslySetInnerHTML={{ __html: svg }} />
            ) : (
              <div className="grid h-full place-items-center text-xs text-gray-400">
                {debounced.trim() ? (busy ? '渲染中…' : '') : '左侧输入 mermaid 文本，本地实时渲染'}
              </div>
            )}
          </div>
        )}
      </div>
      </Splitter.Panel>
      <Splitter.Panel min="22%" defaultSize={`${loadSplit()}%`}>
        <DiagramChat
        storageKey="aw-diagram:mermaid-chat"
        systemPrompt={SYSTEM_PROMPT}
        getContext={() => text}
        extractCode={makeExtractor(['flowchart', 'graph ', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'erDiagram', 'gantt', 'pie', 'mindmap', 'journey', 'timeline', 'gitGraph', 'quadrantChart', 'sankey'])}
        onApply={(code) => {
          setText(code)
          setView('preview')
        }}
      />
      </Splitter.Panel>
    </Splitter>
  )
}
