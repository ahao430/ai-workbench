import { useCallback, useEffect, useRef, useState } from 'react'
import { App, Button, Dropdown, Space, Splitter, Tooltip, Typography } from 'antd'
import { Download, ExternalLink, PanelRightClose, PanelRightOpen, RefreshCw, Upload } from 'lucide-react'
import { save } from '@tauri-apps/plugin-dialog'
import RetouchChat from '../components/retouch/RetouchChat'
import { PHOTOPEA_URL, PhotopeaBridge } from '../components/retouch/photopea'
import { downloadBlob, lsGet, lsSet } from '../components/diagram/shared'
import { call, isTauri } from '../api/ipc'

const SPLIT_KEY = 'aw-retouch:split'
const CHAT_OPEN_KEY = 'aw-retouch:chat-open'

/**
 * 导出格式：saveToOE 实测可用的全部格式（2026-09 逐个验证）。
 * tga/avif/exr/mp4/psb/raw/svg 会弹 Photopea 内部对话框、API 无法无头导出，不放进来。
 */
const EXPORT_FORMATS: Record<string, { spec: string; ext: string; name: string }> = {
  png: { spec: 'png', ext: 'png', name: 'PNG 图片' },
  jpg: { spec: 'jpg:0.92', ext: 'jpg', name: 'JPG 图片' },
  webp: { spec: 'webp', ext: 'webp', name: 'WEBP 图片' },
  gif: { spec: 'gif', ext: 'gif', name: 'GIF 动图' },
  pdf: { spec: 'pdf', ext: 'pdf', name: 'PDF 文档' },
  psd: { spec: 'psd', ext: 'psd', name: 'PSD 工程' },
  bmp: { spec: 'bmp', ext: 'bmp', name: 'BMP 图片' },
  ico: { spec: 'ico', ext: 'ico', name: 'ICO 图标' },
  tiff: { spec: 'tiff', ext: 'tiff', name: 'TIFF 图片' },
  dds: { spec: 'dds', ext: 'dds', name: 'DDS 纹理' },
  dxf: { spec: 'dxf', ext: 'dxf', name: 'DXF 图形' },
  emf: { spec: 'emf', ext: 'emf', name: 'EMF 图形' },
  ppm: { spec: 'ppm', ext: 'ppm', name: 'PPM 图片' },
}

const fmtItem = (key: string) => ({ key, label: EXPORT_FORMATS[key].name })

/** 导入接受面：Photopea 支持的全部常用格式（PSD/AI/XD/Fig/Sketch/PDF/RAW/视频等，image/* 覆盖常规图片） */
const IMPORT_ACCEPT =
  'image/*,.psd,.psb,.ai,.xd,.fig,.sketch,.pdf,.cdr,.eps,.pdn,.indd,.mp4,.dds,.tga,.exr,.avif,.dng,.cr2,.cr3,.nef,.arw,.rw2,.raf,.orf,.fff'

function loadSplit(): number {
  const v = Number(lsGet(SPLIT_KEY))
  return v >= 20 && v <= 80 ? v : 40
}
function saveSplit(sizes: number[]): void {
  const total = sizes[0] + sizes[1]
  if (total <= 0) return
  const pct = (sizes[1] / total) * 100
  if (pct >= 15 && pct <= 85) lsSet(SPLIT_KEY, String(Math.round(pct)))
}

/**
 * 修图：iframe 内嵌 Photopea（官方 Live Messaging postMessage 协议）+ 右侧 AI 对话。
 * 图片文件在 Photopea 内本地处理；AI 修改会把当前文档快照发给所选模型服务。
 */
export default function RetouchPage() {
  const [bridge] = useState(() => new PhotopeaBridge())
  // AI 面板可整体收起，让 Photopea 铺满整行（页面区域本就不大）
  const [chatOpen, setChatOpen] = useState(() => lsGet(CHAT_OPEN_KEY) !== '0')
  const toggleChat = () => {
    setChatOpen((v) => {
      lsSet(CHAT_OPEN_KEY, v ? '0' : '1')
      return !v
    })
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-3 px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 2 }}>
            修图
          </Typography.Title>
          <p className="m-0 text-xs text-gray-400">Photopea 网页版 Photoshop + AI：描述需求，助手直接在画布里改</p>
        </div>
        <Tooltip title={chatOpen ? '收起 AI 面板，编辑器铺满' : '展开 AI 面板'}>
          <Button
            size="small"
            aria-label="切换 AI 面板"
            icon={chatOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            onClick={toggleChat}
          />
        </Tooltip>
      </div>
      <Splitter layout="horizontal" className="min-h-0 flex-1" onResizeEnd={saveSplit}>
        <Splitter.Panel min="34%" max={chatOpen ? '80%' : '100%'}>
          <PhotopeaEditor bridge={bridge} />
        </Splitter.Panel>
        {chatOpen && (
          <Splitter.Panel min="20%" defaultSize={`${loadSplit()}%`}>
            <RetouchChat bridge={bridge} />
          </Splitter.Panel>
        )}
      </Splitter>
    </div>
  )
}

/** Photopea iframe + 顶部工具条（上传/导出/重载）。bridge 随 iframe 挂载/卸载 attach/detach；
 *  组件重挂载（HMR 等）时 iframe 不重载，就绪靠 bridge.waitReady 的 ping 探测恢复 */
function PhotopeaEditor({ bridge }: { bridge: PhotopeaBridge }) {
  const { message } = App.useApp()
  const [attempt, setAttempt] = useState(0)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  // ref 回调必须稳定（useCallback）：内联箭头函数每次渲染都会被 React 以 null→el 重调，
  // 任何 setState 都会触发 bridge.detach() 杀掉在途调用（导出/脚本全被拒）
  const bindIframe = useCallback(
    (el: HTMLIFrameElement | null) => {
      if (el) bridge.attach(el)
      else bridge.detach()
    },
    [bridge],
  )

  // attempt 变化（首载/重试）→ 等 Photopea 初始化完成的首次 "done"
  useEffect(() => {
    setReady(false)
    setFailed(false)
    bridge
      .waitReady(120000)
      .then(() => setReady(true))
      .catch(() => setFailed(true))
  }, [attempt, bridge])

  const upload = async (files: FileList | null) => {
    const f = files?.[0]
    if (!f) return
    setBusy(true)
    try {
      await bridge.openFile(await f.arrayBuffer())
      message.success(`已打开 ${f.name}`)
    } catch (e) {
      message.error(`打开失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  /** 导出：Tauri 下弹系统保存对话框写入所选路径（iframe 里 Photopea 自带菜单的保存无效）；
   *  浏览器调试环境兜底走浏览器下载 */
  const exportAs = async (fmt: string) => {
    const f = EXPORT_FORMATS[fmt]
    if (!f) return
    setBusy(true)
    try {
      const blob = await bridge.exportBlob(f.spec, 60000)
      if (!blob) {
        message.warning('没有可导出的文档')
        return
      }
      if (!isTauri) {
        downloadBlob(blob, `retouch.${f.ext}`)
        message.success('已导出')
        return
      }
      const path = await save({
        defaultPath: `retouch.${f.ext}`,
        filters: [{ name: f.name, extensions: [f.ext] }],
      })
      if (!path) return
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(r.error ?? new Error('读取导出数据失败'))
        r.readAsDataURL(blob)
      })
      await call('image_save_export', { path, dataUrl })
      message.success(`已保存到 ${path}`)
    } catch (e) {
      message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Space size="small" wrap>
          <Tooltip title="支持 PSD / AI / XD / Fig / Sketch / PDF / RAW 相机格式及常见图片、视频">
            <Button size="small" type="primary" icon={<Upload size={13} />} loading={busy} onClick={() => fileInput.current?.click()}>
              打开图片
            </Button>
          </Tooltip>
          <Dropdown
            menu={{
              items: [
                {
                  type: 'group' as const,
                  label: '图片',
                  children: [fmtItem('png'), fmtItem('jpg'), fmtItem('webp'), fmtItem('gif')],
                },
                {
                  type: 'group' as const,
                  label: '文档 / 工程',
                  children: [fmtItem('pdf'), fmtItem('psd')],
                },
                {
                  key: 'more',
                  label: '更多格式',
                  children: [fmtItem('bmp'), fmtItem('ico'), fmtItem('tiff'), fmtItem('dds'), fmtItem('dxf'), fmtItem('emf'), fmtItem('ppm')],
                },
              ],
              onClick: ({ key }) => void exportAs(key),
            }}
          >
            <Button size="small" icon={<Download size={13} />} disabled={!ready || busy}>
              导出
            </Button>
          </Dropdown>
        </Space>
        <Space size="small" wrap>
          <span className="text-[11px] text-gray-400">图片在 Photopea 内本地处理</span>
          <Tooltip title="重新加载编辑器">
            <Button size="small" icon={<RefreshCw size={13} />} onClick={() => setAttempt((n) => n + 1)} />
          </Tooltip>
          <Button
            size="small"
            type="text"
            icon={<ExternalLink size={13} />}
            onClick={() => window.open(PHOTOPEA_URL, '_blank', 'noreferrer')}
          />
        </Space>
        <input
          ref={fileInput}
          type="file"
          accept={IMPORT_ACCEPT}
          className="hidden"
          onChange={(e) => void upload(e.target.files)}
        />
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <iframe
          key={attempt}
          ref={bindIframe}
          src={PHOTOPEA_URL}
          title="Photopea"
          className="w-full flex-1 rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
          style={{ border: '1px solid', opacity: ready ? 1 : 0.001 }}
          allow="clipboard-read; clipboard-write"
        />
        {!ready && !failed && (
          <div className="absolute inset-0 grid place-items-center rounded-lg bg-gray-50 text-xs text-gray-400 dark:bg-gray-900">
            正在加载 Photopea（www.photopea.com，约 10~30 秒，需联网）…
          </div>
        )}
        {failed && (
          <div className="absolute inset-0 grid place-items-center rounded-lg bg-gray-50 text-center text-xs text-red-500 dark:bg-gray-900">
            <div>
              Photopea 加载失败或超时（网络受限 / 内网拦截）。
              <Button size="small" className="mx-2" onClick={() => setAttempt((n) => n + 1)}>
                重试
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
