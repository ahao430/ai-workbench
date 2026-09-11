/**
 * 共享 Markdown 预览（移植自 agent-platform packages/chat/src/markdown.tsx）：
 * GFM + KaTeX 数学公式 + 代码高亮 + 代码块复制按钮 + Mermaid（动态加载）
 * + PlantUML（plantuml.com 在线渲染）+ 多套主题（MD_THEMES）。
 * 主题作用域 .md-body.t-<key>；深色主题可用 pageBg 垫底。
 */

import { useId, useLayoutEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeRaw from 'rehype-raw'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import plantumlEncoder from 'plantuml-encoder'
import { MWEB_THEMES, type MwebThemeMeta } from '../../styles/mweb-themes'
import 'katex/dist/katex.min.css'
import '../../styles/markdown-theme.css'
import '../../styles/mweb-themes.css'

export interface MdThemeMeta {
  key: string
  label: string
  dark: boolean
  pageBg?: string
}

const BUILTIN_THEMES: MdThemeMeta[] = [
  { key: 'github', label: 'GitHub', dark: false },
  { key: 'github-dark', label: 'GitHub Dark', dark: true, pageBg: '#0d1117' },
  { key: 'onedark', label: 'One Dark', dark: true, pageBg: '#282c34' },
  { key: 'monokai', label: 'Monokai', dark: true, pageBg: '#272822' },
]

/** 内置 + MWeb 全套主题 */
export const MD_THEMES: readonly MdThemeMeta[] = [...BUILTIN_THEMES, ...MWEB_THEMES]
export type MdTheme = MdThemeMeta['key']

export function themeMeta(key: string): MdThemeMeta | undefined {
  return MD_THEMES.find((t) => t.key === key)
}

/** 复制文本到剪贴板（含 execCommand 兜底） */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** 安全兜底：渲染内嵌 HTML 后剥掉 script 元素与 on* 事件属性 */
function rehypeStripDangerous() {
  return (tree: RawHastNode) => {
    const walk = (node: RawHastNode) => {
      if (node.type === 'element') {
        node.children = (node.children ?? []).filter((c) => !(c.type === 'element' && c.tagName === 'script'))
        if (node.properties) {
          for (const k of Object.keys(node.properties)) {
            if (k.toLowerCase().startsWith('on')) delete node.properties[k]
          }
        }
      }
      for (const c of node.children ?? []) walk(c)
    }
    walk(tree)
  }
}

interface RawHastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: RawHastNode[]
}

export function MdPreview({
  text,
  theme = 'github',
  className = '',
}: {
  text: string
  theme?: MdTheme
  className?: string
}) {
  const components = useMemo<Components>(() => mdComponents(), [])
  const normalized = useMemo(() => normalizeMathDelimiters(text), [text])
  const meta = themeMeta(theme)
  return (
    <div
      className={`md-body t-${theme} ${className}`}
      style={{
        fontSize: 14,
        lineHeight: 1.7,
        wordBreak: 'break-word',
        background: meta?.pageBg ?? 'transparent',
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, [rehypeHighlight, { detect: true, ignoreMissing: true }], rehypeKatex, rehypeStripDangerous]}
        components={components}
        urlTransform={safeUrlTransform}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  )
}

/** LaTeX 分隔符 \(...\)/\[...\] → $...$/$$...$$（fenced code 内不转） */
function normalizeMathDelimiters(text: string): string {
  const convert = (s: string): string =>
    s
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, c: string) => `$${c.trim()}$`)
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, c: string) => `\n$$\n${c.trim()}\n$$\n`)
  const parts = text.split(/(```[\s\S]*?```)/)
  return parts.map((p, i) => (i % 2 === 1 ? p : convert(p))).join('')
}

/** URL 白名单：data:image/、http(s)/mailto/tel、tauri asset 协议、相对地址；其余协议置空 */
function safeUrlTransform(url: string): string {
  if (/^data:image\//i.test(url)) return url
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url
  // tauri asset 协议（convertFileSrc 产物）：语雀等防盗链图片经本机缓存渲染的通道
  if (/^asset:\/\//i.test(url)) return url
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return ''
  return url
}

/** 拦截 mermaid / plantuml 代码块；普通代码块包「复制」按钮；
 *  img 统一 no-referrer：语雀图床对带外部 Referer 的请求返回 403 */
function mdComponents(): Components {
  return {
    img(props) {
      return <img {...props} referrerPolicy="no-referrer" loading="lazy" />
    },
    pre(props) {
      const child = props.children
      const codeEl = (Array.isArray(child) ? child[0] : child) as
        | ReactElement<{ className?: string; children?: ReactNode }>
        | undefined
      const cls = codeEl?.props?.className ?? ''
      const match = /language-(\w[\w-]*)/.exec(cls)
      const lang = match?.[1]
      const code = nodeText(codeEl?.props?.children).replace(/\n$/, '')
      if (lang === 'mermaid') return <Mermaid chart={code} />
      if (lang === 'plantuml' || lang === 'puml') return <PlantUml code={code} />
      return <CodeBlock code={code}>{props.children}</CodeBlock>
    },
  }
}

/** 普通代码块：右上角「复制」按钮 */
function CodeBlock({ code, children }: { code: string; children: ReactNode }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <div className="md-pre-wrap" style={{ position: 'relative', margin: '0.8em 0' }}>
      <button
        type="button"
        className="md-copy-btn"
        aria-label="复制代码"
        onClick={async () => {
          if (await copyText(code)) {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }
        }}
      >
        {copied ? '已复制' : '复制'}
      </button>
      <pre className="language-md" style={{ margin: 0 }}>
        {children}
      </pre>
    </div>
  )
}

/** Mermaid：动态 import 渲染 SVG；语法错显示报错不崩页 */
function Mermaid({ chart }: { chart: string }): ReactNode {
  const rawId = useId()
  const id = useMemo(() => `m${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`, [rawId])
  const [svg, setSvg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useLayoutEffect(() => {
    let cancelled = false
    setSvg(null)
    setErr(null)
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({ startOnLoad: false })
        const res = await mermaid.render(id, chart)
        if (!cancelled) setSvg(res.svg)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chart, id])
  if (err) return <pre style={{ color: '#d4380d', whiteSpace: 'pre-wrap' }}>mermaid 渲染失败：{err}</pre>
  if (svg === null) return <div style={{ color: '#888' }}>渲染图表中…</div>
  return <div dangerouslySetInnerHTML={{ __html: svg }} />
}

/** PlantUML：编码后走 plantuml.com 在线 SVG（需联网，内容会发往该服务） */
function PlantUml({ code }: { code: string }): ReactNode {
  const encoded = useMemo(() => plantumlEncoder.encode(code), [code])
  return (
    <img
      src={`https://www.plantuml.com/plantuml/svg/${encoded}`}
      alt="plantuml"
      style={{ maxWidth: '100%', background: '#fff', border: '1px solid #eee', borderRadius: 6 }}
    />
  )
}

/** 递归还原 ReactNode 纯文本 */
function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return nodeText((node as ReactElement<{ children?: ReactNode }>).props.children)
  }
  return ''
}

export type { MwebThemeMeta }
