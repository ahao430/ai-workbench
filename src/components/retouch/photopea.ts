/**
 * Photopea Live Messaging 协议封装（https://www.photopea.com/api/live）。
 *
 * 约定：向 iframe postMessage —— String 按 Photopea 脚本执行，ArrayBuffer 作为文件打开；
 * 回包经 window message 事件到达：echoToOE 的字符串、saveToOE 的 ArrayBuffer，
 * 每处理完一条外部消息 Photopea 会补发一次 "done"。调用按队列串行（一次只发一条，
 * 收到 done 再发下一条），因此脚本回显与本轮文件不会串组。
 */

/**
 * 嵌入地址实测注意（2026-09）：裸 https://www.photopea.com/ 对新访客返回营销落地页，
 * 不是编辑器、永远不会发就绪 "done"；必须像官方 playground 那样带 ?rnd= 防缓存随机数
 * 和 #hash 环境参数才会直接进编辑器。
 *
 * environment（官方 /api/environment 参数，均实测）：
 * - showbranding: false 去掉顶栏 Log In / 社交链接等品牌区
 * - showpanels: [1, 0] 保留第一列功能面板（Color/Properties/Layers 等），
 *   隐藏第二列 —— 免费版右侧的大块「Support Photopea」推广就住在第二列
 */
const PHOTOPEA_ENV = { environment: { showbranding: false, showpanels: [1, 0] } }
export const PHOTOPEA_URL = `https://www.photopea.com/?rnd=${Math.floor(
  Math.random() * 0xffffffff,
)}#${encodeURIComponent(JSON.stringify(PHOTOPEA_ENV))}`

export interface PeaResult {
  texts: string[]
  files: ArrayBuffer[]
}

export interface PeaDocInfo {
  ok: boolean
  width?: number
  height?: number
  layers?: Array<{ name: string; visible: boolean }>
  error?: string
}

/** 回传当前文档信息（无文档时 ok:false）；脚本自包 try/catch，异常也走 echo */
const DOC_INFO_SCRIPT = `var __o={ok:false};try{var d=app.activeDocument;__o={ok:true,width:d.width,height:d.height,layers:(d.layers||[]).map(function(l){return{name:String(l.name),visible:!!l.visible}})}}catch(e){__o={ok:false,error:String(e)}}app.echoToOE(JSON.stringify(__o))`

type Call = {
  msg: string | ArrayBuffer
  timeoutMs: number
  resolve: (r: PeaResult) => void
  reject: (e: Error) => void
}

/** waitReady 的注册项：完成时清理各自的 ping 定时器 */
interface ReadyWaiter {
  resolve: () => void
  reject: (e: Error) => void
  cleanup: () => void
}

/** 单 iframe 会话：attach 后串行执行脚本/文件消息，直到 detach */
export class PhotopeaBridge {
  private iframe: HTMLIFrameElement | null = null
  private listener: ((e: MessageEvent) => void) | null = null
  private ready = false
  private readyWaiters: ReadyWaiter[] = []
  private queue: Call[] = []
  private inFlight: { call: Call; texts: string[]; files: ArrayBuffer[]; timer: number } | null = null

  attach(iframe: HTMLIFrameElement) {
    this.detach()
    this.iframe = iframe
    this.ready = false
    this.listener = (e: MessageEvent) => this.onMessage(e)
    window.addEventListener('message', this.listener)
    // 挂载前积压的调用现在可以继续泵
    this.pump()
  }

  detach() {
    if (this.listener) window.removeEventListener('message', this.listener)
    this.listener = null
    this.iframe = null
    this.ready = false
    // 清理未完成的调用，避免 Promise 悬挂
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer)
      this.inFlight.call.reject(new Error('Photopea 编辑器已重载'))
      this.inFlight = null
    }
    for (const c of this.queue.splice(0)) c.reject(new Error('Photopea 编辑器已重载'))
    for (const w of this.readyWaiters.splice(0)) {
      w.cleanup()
      w.reject(new Error('Photopea 编辑器已重载'))
    }
  }

  /** Photopea 初始化完成的首次 "done"。
   *  注意：组件重挂载（HMR 等）时 iframe 并未重载、Photopea 已初始化，不会再主动发 done，
   *  所以同时每 2s 发一次 ping 脚本——已初始化的实例收到任何消息都会回包并补发 done。 */
  waitReady(timeoutMs = 120000): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let iv = 0
      let timer = 0
      const ping = () => {
        try {
          this.iframe?.contentWindow?.postMessage('app.echoToOE("__PP_PING__")', '*')
        } catch {
          /* ignore */
        }
      }
      const finish = (err?: Error) => {
        window.clearInterval(iv)
        window.clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }
      iv = window.setInterval(ping, 2000)
      ping()
      timer = window.setTimeout(() => finish(new Error('Photopea 加载超时')), timeoutMs)
      this.readyWaiters.push({ resolve: () => finish(), reject: (e) => finish(e), cleanup: () => {
        window.clearInterval(iv)
        window.clearTimeout(timer)
      } })
    })
  }

  private onMessage(e: MessageEvent) {
    const win = this.iframe?.contentWindow
    if (!win || e.source !== win) return
    if (e.data === 'done') {
      if (!this.inFlight) {
        // 首次 done = Photopea 就绪（或 ping 探测的补发 done）
        this.ready = true
        const ws = this.readyWaiters.splice(0)
        ws.forEach((w) => w.resolve())
        return
      }
      const cur = this.inFlight
      this.inFlight = null
      clearTimeout(cur.timer)
      cur.call.resolve({ texts: cur.texts, files: cur.files })
      this.pump()
      return
    }
    if (!this.inFlight) return
    if (typeof e.data === 'string') this.inFlight.texts.push(e.data)
    else if (e.data instanceof ArrayBuffer) this.inFlight.files.push(e.data)
    else if (ArrayBuffer.isView(e.data)) {
      // 部分宿主把 ArrayBuffer 包成 TypedArray 传过来
      this.inFlight.files.push(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength) as ArrayBuffer)
    }
  }

  private pump() {
    if (this.inFlight || !this.queue.length) return
    const win = this.iframe?.contentWindow
    if (!win) return // 未挂载：调用留队，attach 后再泵
    if (!this.ready) {
      // 未就绪：队列原位等待；多个并发 pump 也只会各自再触发一次（就绪后 inFlight 互斥）
      void this.waitReady()
        .then(() => this.pump())
        .catch(() => {
          for (const c of this.queue.splice(0)) c.reject(new Error('Photopea 加载超时'))
        })
      return
    }
    const call = this.queue.shift()!
    this.inFlight = {
      call,
      texts: [],
      files: [],
      timer: window.setTimeout(() => {
        const cur = this.inFlight
        this.inFlight = null
        // 脚本报错弹窗等场景会吞掉 done：把已收到的部分结果交还，避免整轮作废
        if (cur && (cur.texts.length || cur.files.length)) cur.call.resolve({ texts: cur.texts, files: cur.files })
        else cur?.call.reject(new Error('Photopea 响应超时（脚本可能弹了错误窗）'))
        this.pump()
      }, call.timeoutMs),
    }
    win.postMessage(call.msg, '*')
  }

  /** 执行一段 Photopea 脚本，收齐回显与导出文件 */
  runScript(script: string, timeoutMs = 30000): Promise<PeaResult> {
    return new Promise<PeaResult>((resolve, reject) => {
      this.queue.push({ msg: script, timeoutMs, resolve, reject })
      this.pump()
    })
  }

  /** 直接打开一个文件（ArrayBuffer → 新文档） */
  openFile(bytes: ArrayBuffer, timeoutMs = 60000): Promise<PeaResult> {
    return new Promise<PeaResult>((resolve, reject) => {
      this.queue.push({ msg: bytes, timeoutMs, resolve, reject })
      this.pump()
    })
  }

  /** 当前文档信息（无文档返回 null） */
  async docInfo(): Promise<PeaDocInfo | null> {
    const r = await this.runScript(DOC_INFO_SCRIPT, 20000)
    for (let i = r.texts.length - 1; i >= 0; i--) {
      try {
        const v = JSON.parse(r.texts[i]) as PeaDocInfo
        if (typeof v === 'object' && v && 'ok' in v) return v
      } catch {
        /* 跳过非 JSON 回显 */
      }
    }
    return null
  }

  /** 导出当前文档（saveToOE，格式如 "png" / "jpg:0.85"）；无文档或失败返回 null */
  async exportBlob(format = 'png', timeoutMs = 45000): Promise<Blob | null> {
    const r = await this.runScript(`app.activeDocument.saveToOE("${format}")`, timeoutMs)
    const buf = r.files[0]
    if (!buf) return null
    const mime = format.startsWith('jpg') ? 'image/jpeg' : format.startsWith('webp') ? 'image/webp' : 'image/png'
    return new Blob([buf], { type: mime })
  }

  /**
   * 把生成图插入当前文档：优先 app.open(dataUrl, null, true) 作为智能对象图层，
   * 失败（或没有活动文档）退化为直接 post 文件新开文档。返回实际落点。
   */
  async insertImage(dataUrl: string): Promise<'layer' | 'document'> {
    const before = await this.docInfo().catch(() => null)
    const script = `try{app.open(${JSON.stringify(dataUrl)},null,true);app.echoToOE("__OPEN_OK__")}catch(e){app.echoToOE("__OPEN_ERR__"+e)}`
    const r = await this.runScript(script, 60000).catch(() => null)
    if (r && r.texts.some((t) => t.includes('__OPEN_ERR__'))) {
      await this.openFile(dataUrlToBytes(dataUrl))
      return 'document'
    }
    const after = await this.docInfo().catch(() => null)
    if (after?.ok) {
      if (before?.ok && (after.layers?.length ?? 0) > (before.layers?.length ?? 0)) return 'layer'
      if (!before?.ok) return 'document'
    }
    // 未知状态兜底：直接开成新文档，确保图片可见
    await this.openFile(dataUrlToBytes(dataUrl))
    return 'document'
  }
}

/** data URL → ArrayBuffer（atob 逐字节转，图片量级 <10MB 可接受） */
export function dataUrlToBytes(dataUrl: string): ArrayBuffer {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/** 文档快照缩成给多模态模型看的 data URL（最长边 ≤ max，JPEG 压掉透明） */
export async function blobToVisionUrl(blob: Blob, max = 1280, quality = 0.85): Promise<string> {
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = () => reject(new Error('快照解码失败'))
      im.src = url
    })
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 不可用')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', quality)
  } finally {
    URL.revokeObjectURL(url)
  }
}
