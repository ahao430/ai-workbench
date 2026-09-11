import { useEffect, useMemo, useState } from 'react'
import { App, Button, Dropdown, Input, Popconfirm, Segmented, Space, Splitter, Tooltip } from 'antd'
import plantumlEncoder from 'plantuml-encoder'
import { Check, Copy, ExternalLink, FileCode2 } from 'lucide-react'
import { openLinkInApp } from '../../lib/openLink'
import DiagramChat, { makeExtractor } from './DiagramChat'
import { copyToClipboard, lsGet, lsSet, useDebounced, PANE_CLASS, TEXTAREA_STYLE, loadSplit, saveSplit } from './shared'

const LS_KEY = 'aw-diagram:plantuml'

const SAMPLES: Record<string, string> = {
  活动图: `@startuml
start
:打开应用;
if (已登录?) then (yes)
  :进入工作台;
else (no)
  :跳转登录页;
endif
:开始干活;
stop
@enduml`,
  时序图: `@startuml
actor 用户
participant "应用" as A
participant "AI 服务" as S
用户 -> A: 输入问题
A -> S: 转发请求
S --> A: 流式返回
A --> 用户: 渲染回答
用户 -> A: 追问
A -> S: 带上下文再请求
S --> A: 继续回答
A --> 用户: 渲染回答
@enduml`,
  类图: `@startuml
class SessionRepo {
  +list() Session[]
  +create(s)
  +remove(id)
}
class MessageRepo {
  +listBySession(id) Message[]
  +add(m)
}
class ChatStore {
  +send(text)
  +stop()
}
ChatStore --> SessionRepo
ChatStore --> MessageRepo
@enduml`,
  状态图: `@startuml
[*] --> 草稿
草稿 --> 已提交: 提交审批
已提交 --> 已通过: 审批通过
已提交 --> 已驳回: 审批驳回
已驳回 --> 草稿: 修改
已通过 --> [*]
@enduml`,
  组件图: `@startuml
package "前端" {
  [聊天页]
  [流程图页]
}
package "Rust 核心" {
  [llm_chat]
  [gateway]
}
cloud "AI 网关" {
  [大模型]
}
[聊天页] --> llm_chat
[流程图页] --> llm_chat
llm_chat --> gateway
gateway --> 大模型
@enduml`,
  部署图: `@startuml
node "用户电脑" {
  artifact "桌面应用" as App
}
node "公司服务器" {
  artifact "AI 网关" as GW
  database "secrets.db" as DB
}
cloud "公网" as Net
App --> GW : HTTPS
GW --> DB : 读密钥
GW --> Net : 转发大模型请求
@enduml`,
  用例图: `@startuml
left to right direction
actor 用户
actor 管理员
rectangle 工作台 {
  (聊天) -- 用户
  (画图) -- 用户
  (流程图) -- 用户
  (配置服务) -- 管理员
}
@enduml`,
}

const SYSTEM_PROMPT = `你是 PlantUML 图表专家，根据用户描述画图。规则：
1. 把完整 PlantUML 源码放在一个 \`\`\`plantuml 代码块中输出（必须 @startuml/@enduml 包裹），除此之外只给一句以内的简短说明。
2. 节点、消息、标注用中文；布局要清晰。
3. 用户要求增/删/改时，基于「当前图源码」修改并保留未提及部分；用户要求画新图时整体重写。
4. 只用 PlantUML 标准语法，不要编造指令。`

/** PlantUML 文本画图：编辑/预览切换 + 右侧 AI 对话；渲染经 plantuml.com 在线完成（文本会发往该服务） */
export default function PlantUmlTab() {
  const { message } = App.useApp()
  const [text, setText] = useState(() => lsGet(LS_KEY) ?? SAMPLES['活动图'])
  const [view, setView] = useState<'edit' | 'preview'>('preview')
  const [copied, setCopied] = useState(false)
  // 图片加载有网络开销，防抖放宽到 600ms，避免每次按键都请求 plantuml.com
  const debounced = useDebounced(text, 600)

  useEffect(() => {
    lsSet(LS_KEY, text)
  }, [text])

  const url = useMemo(() => {
    const t = debounced.trim()
    if (!t) return null
    try {
      return `https://www.plantuml.com/plantuml/svg/${plantumlEncoder.encode(t)}`
    } catch {
      return null
    }
  }, [debounced])

  const copy = async () => {
    if (await copyToClipboard(text)) {
      setCopied(true)
      message.success('已复制')
      setTimeout(() => setCopied(false), 1500)
    } else message.error('复制失败')
  }

  const copyLink = async () => {
    if (await copyToClipboard(url ?? '')) message.success('图片链接已复制')
    else message.error('复制失败')
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
              复制文本
            </Button>
            <Tooltip title="复制可在浏览器直接打开的图片链接">
              <Button size="small" icon={<Copy size={13} />} disabled={!url} onClick={() => void copyLink()}>
                复制链接
              </Button>
            </Tooltip>
            <Button
              size="small"
              icon={<ExternalLink size={13} />}
              disabled={!url}
              onClick={() => void openLinkInApp({ id: 'plantuml-view', name: 'PlantUML 图', url: url ?? '' }, (m) => message.error(m))}
            >
              大图
            </Button>
            <Popconfirm title="清空编辑器？" onConfirm={() => setText('')}>
              <Button size="small" danger>
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
              placeholder="@startuml … @enduml，或用右侧 AI 对话生成"
            />
          </div>
        ) : (
          <div className={`${PANE_CLASS} flex min-h-0 flex-1 flex-col overflow-hidden p-4`}>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
              {url ? (
                <img src={url} alt="plantuml" className="max-h-full max-w-full object-contain" />
              ) : (
                <div className="text-xs text-gray-400">左侧输入 PlantUML 文本，渲染需联网</div>
              )}
            </div>
            <div className="pt-2 text-center text-[11px] text-gray-400">
              渲染经 plantuml.com 在线完成，图文本会发送至该服务（无本地 PlantUML 引擎）
            </div>
          </div>
        )}
      </div>
      </Splitter.Panel>
      <Splitter.Panel min="22%" defaultSize={`${loadSplit()}%`}>
        <DiagramChat
        storageKey="aw-diagram:plantuml-chat"
        systemPrompt={SYSTEM_PROMPT}
        getContext={() => text}
        extractCode={makeExtractor(['@startuml', '@startmindmap', '@startgantt', '@startsalt', '@startjson'])}
        onApply={(code) => {
          setText(code)
          setView('preview')
        }}
      />
      </Splitter.Panel>
    </Splitter>
  )
}
