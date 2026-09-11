/**
 * 供应商品牌识别与图标：按名称/地址匹配官方 logo，
 * 未识别的回退为首字母彩色章。托盘菜单栏图标为独立资源（src-tauri/icons）。
 */
import zhipuPng from '../assets/brands/zhipu.png'
import deepseekPng from '../assets/brands/deepseek.png'

export type Brand = 'zhipu' | 'deepseek' | null

export function brandOf(p: { name: string; baseUrl?: string }): Brand {
  const s = `${p.name} ${p.baseUrl ?? ''}`.toLowerCase()
  if (s.includes('zhipu') || s.includes('智谱') || s.includes('bigmodel') || s.includes('chatglm')) return 'zhipu'
  if (s.includes('deepseek')) return 'deepseek'
  return null
}

export function BrandAvatar({
  p,
  size = 20,
}: {
  p: { name: string; baseUrl?: string }
  size?: number
}) {
  const b = brandOf(p)
  if (b === 'zhipu') {
    return <img src={zhipuPng} width={size} height={size} className="rounded-md" alt="智谱" />
  }
  if (b === 'deepseek') {
    return <img src={deepseekPng} width={size} height={size} className="rounded-md" alt="DeepSeek" />
  }
  const ch = (p.name || '?').trim().charAt(0).toUpperCase()
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      className="flex items-center justify-center rounded-md bg-indigo-500 font-semibold text-white"
    >
      {ch}
    </span>
  )
}
