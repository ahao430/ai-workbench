import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Dropdown, Input, Popconfirm, Segmented, Space, Splitter } from 'antd'
import {
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  restoreElements,
} from '@excalidraw/excalidraw'
// 0.18 起 JS 不再内联注入样式，必须显式引入（漏了则画布 overflow 失效排到视口外）
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Copy, Download, Eraser } from 'lucide-react'
import DiagramChat, { makeExtractor } from './DiagramChat'
import { copyToClipboard, lsGet, lsSet, loadSplit, saveSplit } from './shared'

const SYSTEM_PROMPT = `你是 Excalidraw 手绘图专家，根据用户描述生成场景 JSON。规则：
1. 把 {"elements":[...]} 形式的 JSON 放在一个 \`\`\`json 代码块中输出，除此之外只给一句以内的简短说明。
2. 元素用简写骨架：文本 {id,type:"text",x,y,text,fontSize}；矩形 {id,type:"rectangle",x,y,width,height,label:{text,fontSize},strokeColor,backgroundColor}；菱形 diamond、椭圆 ellipse 同矩形；箭头 {id,type:"arrow",x,y,start:{id},end:{id},strokeColor}。id 用简短字符串（n1/n2/e1…）。
3. 自己计算布局坐标：从左到右流动，矩形约 180x70、间距 60+，label 字号 16、标题 fontSize 28；颜色 strokeColor/backgroundColor 用十六进制（如 #1971c2/#a5d8ff、#2f9e44/#d8f5a2）。
4. 文字用中文；箭头必须引用已存在元素的 id 连接。
5. 用户要求增/删/改时，基于「当前图源码」修改并保留未提及元素（保留原 id）；用户要求画新图时整体替换。`

const LS_KEY = 'aw-diagram:excalidraw'

const SAMPLE_SCENE = JSON.stringify(
  {
    elements: [
      { id: 't1', type: 'text', x: 60, y: 20, text: '手绘风流程图', fontSize: 28 },
      {
        id: 'n1',
        type: 'rectangle',
        x: 60,
        y: 80,
        width: 180,
        height: 70,
        label: { text: '打开应用', fontSize: 16 },
        strokeColor: '#1971c2',
        backgroundColor: '#a5d8ff',
      },
      {
        id: 'n2',
        type: 'ellipse',
        x: 320,
        y: 78,
        width: 120,
        height: 74,
        label: { text: '开始干活', fontSize: 16 },
        strokeColor: '#2f9e44',
        backgroundColor: '#d8f5a2',
      },
      { id: 'e1', type: 'arrow', x: 240, y: 115, start: { id: 'n1' }, end: { id: 'n2' }, strokeColor: '#1e1e1e' },
    ],
  },
  null,
  2,
)

interface SceneData {
  elements: unknown[]
}

/** 解析场景 JSON；失败返回 null（JSON 模式展示报错，画布保持上次状态） */
function parseScene(json: string): SceneData | null {
  try {
    const parsed = JSON.parse(json) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as SceneData).elements)) {
      return parsed as SceneData
    }
    return null
  } catch {
    return null
  }
}

/** 画布内是否有此元素数组（简写骨架缺 version；画布导出的完整元素带 version） */
function isSkeletonList(elements: unknown[]): boolean {
  return elements.some((e) => !e || typeof e !== 'object' || (e as { version?: unknown }).version == null)
}

/** Excalidraw 画图：官方 React 组件（本地渲染，可拖拽/手绘），支持 JSON 场景文本模式 */
export default function ExcalidrawTab() {
  const { message } = App.useApp()
  const [sceneText, setSceneText] = useState(() => lsGet(LS_KEY) ?? SAMPLE_SCENE)
  const [mode, setMode] = useState<'canvas' | 'json'>('canvas')
  const scene = useMemo(() => parseScene(sceneText), [sceneText])

  useEffect(() => {
    lsSet(LS_KEY, sceneText)
  }, [sceneText])

  // 导出 PNG：官方 exportToBlob（导出当前场景全部元素，含手绘风渲染）
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const exportPng = async () => {
    const api = apiRef.current
    if (!api) return void message.warning('画布还没就绪')
    try {
      const blob = await exportToBlob({
        elements: api.getSceneElements(),
        appState: api.getAppState(),
        files: api.getFiles(),
        mimeType: 'image/png',
        exportPadding: 20,
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'excalidraw.png'
      a.click()
      URL.revokeObjectURL(url)
      message.success('已导出 PNG')
    } catch (e) {
      message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <Splitter layout="horizontal" className="h-[72vh]" onResizeEnd={saveSplit}>
      <Splitter.Panel min="30%" max="78%">
        <div className="flex h-full min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => setMode(v as 'canvas' | 'json')}
            options={[
              { label: '画布', value: 'canvas' },
              { label: 'JSON', value: 'json' },
            ]}
          />
        <Space size="small" wrap>
          <Dropdown
            menu={{
              items: [
                { key: 'png', label: '导出 PNG' },
                { key: 'excalidraw', label: '下载 .excalidraw' },
                { key: 'sample', label: '载入示例' },
              ],
              onClick: ({ key }) => {
                if (key === 'png') void exportPng()
                else if (key === 'excalidraw') {
                  const blob = new Blob([sceneText], { type: 'application/json' })
                  const a = document.createElement('a')
                  a.href = URL.createObjectURL(blob)
                  a.download = 'diagram.excalidraw'
                  a.click()
                  URL.revokeObjectURL(a.href)
                } else if (key === 'sample') {
                  setSceneText(SAMPLE_SCENE)
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
            onClick={() => void copyToClipboard(sceneText).then((ok) => (ok ? message.success('场景 JSON 已复制') : message.error('复制失败')))}
          >
            复制
          </Button>
          <Popconfirm title="清空画布？" onConfirm={() => setSceneText(JSON.stringify({ elements: [] }, null, 2))}>
            <Button size="small" danger icon={<Eraser size={13} />}>
              清空
            </Button>
          </Popconfirm>
        </Space>
      </div>
      {mode === 'canvas' ? (
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
          <ExcalidrawCanvas scene={scene} onSceneChange={setSceneText} onApi={(a) => (apiRef.current = a)} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1">
          <div className="min-h-0 flex-1">
            <Input.TextArea
              value={sceneText}
              onChange={(e) => setSceneText(e.target.value)}
              style={{ height: '100%', resize: 'none', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}
            />
          </div>
          {!scene && (
            <div className="text-xs" style={{ color: '#d4380d' }}>
              JSON 解析失败，请检查格式
            </div>
          )}
        </div>
      )}
      </div>
      </Splitter.Panel>
      <Splitter.Panel min="22%" defaultSize={`${loadSplit()}%`}>
        <DiagramChat
          storageKey="aw-diagram:excalidraw-chat"
          systemPrompt={SYSTEM_PROMPT}
          getContext={() => sceneText}
          extractCode={makeExtractor(['{'])}
          onApply={(code) => {
            setSceneText(code)
            setMode('canvas')
          }}
        />
      </Splitter.Panel>
    </Splitter>
  )
}

/**
 * Excalidraw 画布（官方 React 组件，本地渲染）：
 *   外部 scene 变化（JSON 手改后切回画布）→ 骨架走 convertToExcalidrawElements
 *   （自动生成绑定 label / 箭头吸附），完整元素走 restoreElements → updateScene；
 *   用户画布编辑 onChange → 序列化回 JSON。lastSynced 记录两侧一致的内容防回环。
 */
function ExcalidrawCanvas({
  scene,
  onSceneChange,
  onApi,
}: {
  scene: SceneData | null
  onSceneChange: (json: string) => void
  onApi?: (api: ExcalidrawImperativeAPI) => void
}) {
  const { message } = App.useApp()
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const lastSynced = useRef<string | null>(null)
  const onSceneChangeRef = useRef(onSceneChange)
  onSceneChangeRef.current = onSceneChange

  // StrictMode 双挂载下第一个 API 实例会作废：API 变化时清掉同步标记，新实例强制重放场景
  useEffect(() => {
    lastSynced.current = null
  }, [api])

  // 外部 scene → updateScene
  useEffect(() => {
    if (!api || !scene) return
    const json = JSON.stringify(scene)
    if (json === lastSynced.current) return
    lastSynced.current = json
    try {
      const elements = isSkeletonList(scene.elements)
        ? convertToExcalidrawElements(scene.elements as Parameters<typeof convertToExcalidrawElements>[0], {
            regenerateIds: false,
          })
        : restoreElements(scene.elements as ExcalidrawElement[], null)
      api.updateScene({ elements: elements ?? [], appState: { viewBackgroundColor: '#ffffff' } })
    } catch (e) {
      message.error(`场景渲染失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [api, scene])

  const initialData = useMemo(() => {
    if (!scene) return {}
    try {
      const elements = isSkeletonList(scene.elements)
        ? convertToExcalidrawElements(scene.elements as Parameters<typeof convertToExcalidrawElements>[0], {
            regenerateIds: false,
          })
        : restoreElements(scene.elements as ExcalidrawElement[], null)
      return { elements: elements ?? [], scrollToContent: true, appState: { viewBackgroundColor: '#ffffff' } }
    } catch {
      return {}
    }
    // 只在挂载时用一次；后续变化走 updateScene
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Excalidraw
      excalidrawAPI={(a) => {
        setApi(a)
        onApi?.(a)
      }}
      initialData={initialData}
      theme="light"
      onChange={(elements) => {
        // 用户编辑（updateScene 也会触发；与 lastSynced 相同说明是自己的回声，跳过）
        const alive = elements.filter((e) => !e.isDeleted)
        const json = JSON.stringify({ elements: alive })
        if (json === lastSynced.current) return
        lastSynced.current = json
        onSceneChangeRef.current(JSON.stringify({ elements: alive }, null, 2))
      }}
    />
  )
}
