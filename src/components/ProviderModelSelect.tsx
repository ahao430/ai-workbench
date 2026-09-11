import { useEffect, useMemo, useState } from 'react'
import { Cascader } from 'antd'
import { useAiServices, type AiService } from '../hooks/useAiServices'
import { listModels } from '../api/chat'
import { capabilityRepo } from '../db/providers'
import { resolveCapability } from '../lib/capability'

export interface CascadeValue {
  serviceKey: string | null
  model: string | null
}

/** 服务 → 模型列表（含画图能力标记，模块级缓存） */
interface ServiceModels {
  all: string[]
  image: string[]
}

const modelsCache = new Map<string, Promise<ServiceModels>>()

function loadServiceModels(svc: AiService): Promise<ServiceModels> {
  let p = modelsCache.get(svc.key)
  if (!p) {
    p = listModels(svc.spec)
      .then(async (all) => {
        const image: string[] = []
        for (const id of all) {
          const cap = await resolveCapability(svc.key, id, capabilityRepo.get)
          if (cap.isImage) image.push(id)
        }
        return { all, image }
      })
      .catch(() => ({ all: [] as string[], image: [] as string[] }))
    modelsCache.set(svc.key, p)
  }
  return p
}

interface Props {
  value: CascadeValue
  onChange: (v: CascadeValue) => void
  /** 模型过滤：image = 仅画图模型；text = 排除画图模型；all = 全部（默认） */
  filter?: 'all' | 'image' | 'text'
  size?: 'small' | 'middle'
  style?: React.CSSProperties
  placeholder?: string
  /** anthropic 协议供应商默认排除（聊天/画图统一 OpenAI） */
  excludeAnthropic?: boolean
}

interface CascaderNode {
  value: string
  label: string
  isLeaf?: boolean
  loading?: boolean
  children?: CascaderNode[]
}

/** 供应商 → 模型 二级联动（单控件两级菜单；展开供应商时异步拉取其模型列表） */
export default function ProviderModelSelect({
  value,
  onChange,
  filter = 'all',
  size = 'small',
  style,
  placeholder = '供应商 / 模型',
  excludeAnthropic = true,
}: Props) {
  const { services } = useAiServices()
  const effServices = useMemo(
    () => (excludeAnthropic ? services.filter((s) => s.apiFormat !== 'anthropic') : services),
    [services, excludeAnthropic],
  )
  const [modelsBySvc, setModelsBySvc] = useState<Record<string, ServiceModels>>({})

  // 挂载即预热全部服务的模型列表（模块级缓存去重）。不能依赖点开时再 loadData：
  // rc-cascader 受控 value 有选中项时，任何重渲染都会把下拉展开列重置回已选路径，
  // loadData 里的 setState 恰好触发这次重渲染 → 点别的供应商会被"弹"回已选的那家
  useEffect(() => {
    let alive = true
    for (const svc of effServices) {
      void loadServiceModels(svc).then((m) => {
        if (!alive) return
        // key 已存在时返回原引用，避免无意义的重渲染
        setModelsBySvc((prev) => (svc.key in prev ? prev : { ...prev, [svc.key]: m }))
      })
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effServices])

  const filtered = (key: string): string[] => {
    const m = modelsBySvc[key]
    if (!m) return []
    if (filter === 'image') return m.image
    if (filter === 'text') return m.all.filter((x) => !m.image.includes(x))
    return m.all
  }

  const options: CascaderNode[] = useMemo(
    () =>
      effServices.map((s) => {
        const list = filtered(s.key)
        return {
          value: s.key,
          label: s.label,
          isLeaf: false,
          children: modelsBySvc[s.key]
            ? list.length
              ? list.map((m) => ({ value: m, label: m }))
              : [{ value: `${s.key}__empty`, label: '（该服务无模型）', disabled: true }]
            : undefined,
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effServices, modelsBySvc, filter],
  )

  // 仅兜底预热未完成的竞态；已加载过的一律不再 setState（见上方注释：受控 value 下
  // 任何重渲染都会让 antd 把展开列重置回已选路径，表现为"选过就切不动供应商"）
  const loadData = async (selected: CascaderNode[]) => {
    const target = selected[selected.length - 1]
    const svc = effServices.find((s) => s.key === target.value)
    if (!svc || modelsBySvc[svc.key]) return
    const m = await loadServiceModels(svc)
    setModelsBySvc((prev) => (svc.key in prev ? prev : { ...prev, [svc.key]: m }))
  }

  // path 引用必须按内容稳定：rc-cascader 的 useActive 以 values[0] 引用为依赖，若每次
  // 渲染都是新数组，任何重渲染（loadData 的 setState、父组件刷新）都会把下拉展开列
  // 重置回已选路径 —— 表现为"选过一次后就切不动供应商"
  const path = useMemo(
    () => (value.serviceKey ? (value.model ? [value.serviceKey, value.model] : [value.serviceKey]) : undefined),
    [value.serviceKey, value.model],
  )

  return (
    <Cascader
      size={size}
      style={style}
      options={options}
      value={path}
      loadData={(ls) => void loadData(ls as CascaderNode[])}
      changeOnSelect={false}
      showSearch={{ filter: (input, path) => path.some((o) => String(o.label).toLowerCase().includes(input.toLowerCase())) }}
      placeholder={placeholder}
      onChange={(v) => {
        const arr = v as string[]
        onChange({ serviceKey: arr?.[0] ?? null, model: arr?.[1] ?? null })
      }}
      displayRender={(labels) => labels.join(' · ')}
      allowClear
    />
  )
}
