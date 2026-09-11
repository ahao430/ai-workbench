import { Checkbox, Tag } from 'antd'
import type { YqRepo } from '../../api/yuque'

/** 子空间分组：团队（group）在前、个人（user）在后 */
interface RepoGroup {
  key: string
  kind: 'group' | 'user' | 'other'
  name: string
  repos: YqRepo[]
}

function groupOf(repos: YqRepo[]): RepoGroup[] {
  const map = new Map<string, RepoGroup>()
  for (const r of repos) {
    const kind: RepoGroup['kind'] =
      r.ownerKind === 'group' ? 'group' : r.ownerKind === 'user' ? 'user' : 'other'
    const name = r.ownerName || (kind === 'user' ? '个人知识库' : '未分组')
    const key = `${kind}:${name}`
    if (!map.has(key)) map.set(key, { key, kind, name, repos: [] })
    map.get(key)!.repos.push(r)
  }
  const arr = [...map.values()]
  const rank = (g: RepoGroup['kind']) => (g === 'group' ? 0 : g === 'user' ? 1 : 2)
  arr.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, 'zh-CN'))
  return arr
}

/** 知识空间选择器：按子空间（团队/个人）分组，支持整组全选与全选全部 */
export default function YqSpacePicker({
  repos,
  picked,
  onChange,
}: {
  repos: YqRepo[]
  picked: Set<string>
  onChange: (next: Set<string>) => void
}) {
  const groups = groupOf(repos)
  const total = repos.length

  const toggleOne = (ns: string, on: boolean) => {
    const next = new Set(picked)
    if (on) next.add(ns)
    else next.delete(ns)
    onChange(next)
  }

  const toggleGroup = (g: RepoGroup, on: boolean) => {
    const next = new Set(picked)
    const nss = g.repos.map((r) => r.namespace)
    if (on) nss.forEach((ns) => next.add(ns))
    else nss.forEach((ns) => next.delete(ns))
    onChange(next)
  }

  const toggleAll = (on: boolean) => {
    onChange(on ? new Set(repos.map((r) => r.namespace)) : new Set())
  }

  return (
    <div className="flex flex-col gap-1">
      {total > 0 && (
        <div className="mb-1 flex items-center justify-between border-b border-black/5 pb-2 dark:border-white/10">
          <Checkbox
            checked={picked.size === total}
            indeterminate={picked.size > 0 && picked.size < total}
            onChange={(e) => toggleAll(e.target.checked)}
          >
            全选全部
          </Checkbox>
          <span className="text-xs text-gray-400">
            已选 {picked.size} / {total}
          </span>
        </div>
      )}
      {groups.map((g) => {
        const on = g.repos.filter((r) => picked.has(r.namespace)).length
        return (
          <div key={g.key} className="mb-1">
            <Checkbox
              checked={on === g.repos.length && on > 0}
              indeterminate={on > 0 && on < g.repos.length}
              onChange={(e) => toggleGroup(g, e.target.checked)}
            >
              <span className="text-sm font-medium">{g.name}</span>
              {g.kind === 'group' && (
                <Tag color="geekblue" bordered={false} className="ml-1.5">
                  团队
                </Tag>
              )}
              {g.kind === 'user' && (
                <Tag bordered={false} className="ml-1.5">
                  个人
                </Tag>
              )}
              <span className="ml-1.5 text-xs text-gray-400">
                {on}/{g.repos.length}
              </span>
            </Checkbox>
            <div className="ml-6 mt-0.5 flex flex-col gap-0.5">
              {g.repos.map((r) => (
                <Checkbox
                  key={r.namespace}
                  checked={picked.has(r.namespace)}
                  onChange={(e) => toggleOne(r.namespace, e.target.checked)}
                  className="text-sm"
                >
                  {r.name}
                  {r.public === 1 ? (
                    <span className="ml-1.5 text-[11px] text-emerald-500">公开</span>
                  ) : (
                    <span className="ml-1.5 text-[11px] text-gray-400">私有</span>
                  )}
                  {r.description && (
                    <span className="ml-2 text-xs text-gray-400">{r.description.slice(0, 30)}</span>
                  )}
                </Checkbox>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
