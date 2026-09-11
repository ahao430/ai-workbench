import { useEffect, useRef } from 'react'

/**
 * 极光动效背景（参考 React Bits Aurora）：canvas 上几个大号径向渐变光斑缓慢漂移、
 * hue 微移，配合 lighter 混合形成流动的极光感；鼠标位置对光斑施加轻微视差（可交互）。
 * 性能约束（WKWebView）：光斑 ≤4 个、DPR ≤2、页面隐藏时暂停 rAF；
 * prefers-reduced-motion 时只画一帧静态图。StrictMode 双挂载靠完整 cleanup 兜底。
 */
export default function AuroraCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let running = true
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // 鼠标目标位与当前位分离，lerp 平滑跟随
    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 }

    const blobs = [
      { hue: 245, r: 0.42, speed: 0.00016, phase: 0.0, ox: 0.30, oy: 0.32, amp: 0.22 },
      { hue: 205, r: 0.36, speed: 0.00023, phase: 2.1, ox: 0.74, oy: 0.28, amp: 0.18 },
      { hue: 288, r: 0.34, speed: 0.00019, phase: 4.2, ox: 0.52, oy: 0.80, amp: 0.20 },
      { hue: 168, r: 0.26, speed: 0.00027, phase: 1.3, ox: 0.18, oy: 0.70, amp: 0.15 },
    ]

    const resize = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (!w || !h) return
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      if (!r.width || !r.height) return
      mouse.tx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
      mouse.ty = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    }
    window.addEventListener('pointermove', onMove, { passive: true })

    const draw = (t: number) => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w && h) {
        mouse.x += (mouse.tx - mouse.x) * 0.05
        mouse.y += (mouse.ty - mouse.y) * 0.05
        ctx.clearRect(0, 0, w, h)
        ctx.globalCompositeOperation = 'lighter'
        for (const b of blobs) {
          const px = (mouse.x - 0.5) * 0.14
          const py = (mouse.y - 0.5) * 0.10
          const x = (b.ox + Math.sin(t * b.speed + b.phase) * b.amp + px) * w
          const y = (b.oy + Math.cos(t * b.speed * 1.35 + b.phase) * b.amp * 0.7 + py) * h
          const rad = b.r * Math.min(w, h) * 1.45
          const hue = b.hue + Math.sin(t * 0.00022 + b.phase) * 14
          const g = ctx.createRadialGradient(x, y, 0, x, y, rad)
          g.addColorStop(0, `hsla(${hue}, 84%, 62%, 0.42)`)
          g.addColorStop(0.55, `hsla(${hue}, 84%, 58%, 0.16)`)
          g.addColorStop(1, 'hsla(0, 0%, 0%, 0)')
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(x, y, rad, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      if (running) raf = requestAnimationFrame(draw)
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      draw(4200) // 画一帧静态构图后不再调度
    } else {
      raf = requestAnimationFrame(draw)
    }

    // 页面不可见（托盘后台/最小化）时暂停，回前台恢复
    const onVis = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!running && !reduced) {
        running = true
        raf = requestAnimationFrame(draw)
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  return <canvas ref={canvasRef} className={className} aria-hidden />
}
