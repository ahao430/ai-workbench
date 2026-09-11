import { Tabs, Typography } from 'antd'
import MermaidTab from '../components/diagram/MermaidTab'
import PlantUmlTab from '../components/diagram/PlantUmlTab'
import DrawioTab from '../components/diagram/DrawioTab'
import ExcalidrawTab from '../components/diagram/ExcalidrawTab'
import SvgTab from '../components/diagram/SvgTab'

/** 流程图画图：Mermaid / PlantUML 文本图 + drawio / Excalidraw 画布 + 手写 SVG，各 tab 内容本机 localStorage 持久化 */
export default function DiagramPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        流程图
      </Typography.Title>
      <Tabs
        defaultActiveKey="mermaid"
        items={[
          {
            key: 'mermaid',
            label: 'Mermaid',
            children: <MermaidTab />,
          },
          {
            key: 'plantuml',
            label: 'PlantUML',
            children: <PlantUmlTab />,
          },
          {
            key: 'drawio',
            label: 'draw.io',
            children: <DrawioTab />,
          },
          {
            key: 'excalidraw',
            label: 'Excalidraw',
            children: <ExcalidrawTab />,
          },
          {
            key: 'svg',
            label: 'SVG',
            children: <SvgTab />,
          },
        ]}
      />
    </div>
  )
}
