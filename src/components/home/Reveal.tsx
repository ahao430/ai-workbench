import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 滚动浮现（参考 React Bits Scroll Reveal）：元素到过视口内即淡入上浮，一次性触发。
 * 判定用滚动位置而不是 IntersectionObserver——快速滚动时元素可能"飞过"视口
 * 停在其上方外，IO 不会触发导致板块永远隐藏；top < 视口底的判据对飞过的一样成立。
 * 看板滚动容器是 AppLayout 的 <main>（overflow-y-auto），向上找最近滚动祖先。
 * prefers-reduced-motion 时直接显示。
 */
export default function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode
  className?: string
  /** 错峰延迟（毫秒） */
  delay?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true)
      return
    }
    const scroller: HTMLElement | Window = el.closest('main') ?? window
    const check = () => {
      // 元素顶边进入视口底部以上（留 6% 缓冲）即视为见过
      if (el.getBoundingClientRect().top < window.innerHeight * 0.94) {
        setShown(true)
        scroller.removeEventListener('scroll', onScroll)
      }
    }
    const onScroll = () => requestAnimationFrame(check)
    check() // 首屏元素直接判定
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'translateY(0)' : 'translateY(20px)',
        transition: `opacity .55s cubic-bezier(.22,.61,.36,1) ${delay}ms, transform .55s cubic-bezier(.22,.61,.36,1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  )
}
