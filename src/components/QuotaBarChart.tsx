export interface ChartPoint {
  label: string
  value: number
  /** hover 提示 */
  hint: string
}

/** 轻量柱状图（无图表库依赖，div 实现） */
export default function QuotaBarChart({ points }: { points: ChartPoint[] }) {
  const max = Math.max(...points.map((p) => p.value), 1)
  return (
    <div>
      <div className="flex h-32 items-end gap-1">
        {points.map((p, i) => (
          <div key={i} className="flex h-full flex-1 flex-col justify-end" title={p.hint}>
            <div
              className={
                'w-full rounded-t transition-colors ' +
                (p.value > 0
                  ? 'bg-indigo-400/70 hover:bg-indigo-500 dark:bg-indigo-500/60 dark:hover:bg-indigo-400'
                  : 'bg-gray-200 dark:bg-gray-700')
              }
              style={{ height: `${p.value > 0 ? Math.max((p.value / max) * 100, 3) : 1.5}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        {points.map((p, i) => (
          <div
            key={i}
            className="flex-1 truncate text-center text-[10px] leading-tight text-gray-400"
          >
            {points.length > 10 && i % 3 !== 0 ? '' : p.label}
          </div>
        ))}
      </div>
    </div>
  )
}
