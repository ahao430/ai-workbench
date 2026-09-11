import { useCallback, useEffect, useState } from 'react'
import { App, Button, Card, Empty, Input, Modal, Popconfirm, Select, Switch, Tag, TimePicker } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { Plus, Timer } from 'lucide-react'
import { errText, fmtDateTime } from '../../lib/err'
import { appApi, scheduleText, LEGACY_KIND_LABELS, TASK_KINDS, type ScheduledTask } from '../../api/app'

const WEEK_OPTIONS = [
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
  { value: '7', label: '周日' },
]

const uid = () => `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/** HH:mm 文本 ↔ TimePicker（空值回退 09:00） */
const timeValue = (t: string | undefined) => dayjs(t || '09:00', 'HH:mm')
const onTimeChange = (editing: ScheduledTask, setEditing: (t: ScheduledTask) => void) => (v: Dayjs | null) =>
  setEditing({ ...editing, time: v ? v.format('HH:mm') : editing.time })

/** 定时任务：列表 + 新建/编辑 + 启停删除；flat = 作为页面嵌入（去掉卡片壳） */
export default function ScheduledTasksCard({ flat }: { flat?: boolean }) {
  const { message } = App.useApp()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<ScheduledTask | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setTasks(await appApi.tasks())
    } catch (e) {
      message.error(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const persist = async (next: ScheduledTask[]) => {
    setSaving(true)
    try {
      await appApi.saveTasks(next)
      setTasks(next)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (t: ScheduledTask, on: boolean) => {
    await persist(tasks.map((x) => (x.id === t.id ? { ...x, enabled: on } : x)))
  }

  const remove = async (t: ScheduledTask) => {
    await persist(tasks.filter((x) => x.id !== t.id))
    message.success('已删除')
  }

  const kindMeta = (k: string) => {
    const meta = TASK_KINDS.find((x) => x.value === k)
    if (meta) return meta
    // 遗留动作（如 webdav_backup）：不可新建，但列表名称可读、编辑时不显示参数框
    if (LEGACY_KIND_LABELS[k]) return { value: k, label: LEGACY_KIND_LABELS[k], hasParam: false, paramPlaceholder: '' }
    return undefined
  }

  return (
    <Card
      style={flat ? undefined : { marginTop: 16 }}
      title={
        <span className="flex items-center gap-1.5 text-sm">
          <Timer size={14} />
          定时任务
        </span>
      }
      extra={
        <Button
          size="small"
          type="primary"
          icon={<Plus size={13} />}
          onClick={() =>
            setEditing({ id: uid(), name: '', kind: 'notify', param: '', schedule: 'daily', time: '09:00', enabled: true })
          }
        >
          新建任务
        </Button>
      }
    >
      {tasks.length === 0 && !loading && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有定时任务" />
      )}
      <div className="flex flex-col gap-2">
        {tasks.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-black/5 px-3 py-2 dark:border-white/10"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="truncate font-medium">{t.name}</span>
                <Tag style={{ marginInlineEnd: 0 }}>{kindMeta(t.kind)?.label ?? t.kind}</Tag>
                <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                  {scheduleText(t)}
                </Tag>
                {!t.enabled && <Tag color="default" style={{ marginInlineEnd: 0 }}>已停用</Tag>}
              </div>
              {t.param && (
                <p className="m-0 mt-0.5 truncate text-xs text-gray-400" title={t.param}>
                  {t.param}
                </p>
              )}
              {t.lastRunAt ? (
                <span className="text-[11px] text-gray-400">上次触发：{fmtDateTime(t.lastRunAt)}</span>
              ) : (
                <span className="text-[11px] text-gray-400">未触发过</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Switch size="small" checked={t.enabled} onChange={(v) => void toggle(t, v)} />
              <Button size="small" onClick={() => setEditing({ ...t })}>
                编辑
              </Button>
              <Popconfirm title={`删除任务「${t.name}」？`} onConfirm={() => void remove(t)}>
                <Button size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            </div>
          </div>
        ))}
      </div>

      <Modal
        title={editing && tasks.some((x) => x.id === editing.id) ? '编辑任务' : '新建任务'}
        open={!!editing}
        onOk={async () => {
          if (!editing) return
          if (!editing.name.trim()) {
            message.warning('请填写任务名')
            return
          }
          if (kindMeta(editing.kind)?.hasParam && !editing.param.trim()) {
            message.warning('请填写任务参数')
            return
          }
          if ((editing.kind === 'webhook' || editing.kind === 'open_url') && !editing.param.trim().startsWith('http')) {
            message.warning('链接/Webhook 地址需以 http 开头')
            return
          }
          setSaving(true)
          try {
            await persist(tasks.some((x) => x.id === editing.id) ? tasks.map((x) => (x.id === editing.id ? editing : x)) : [...tasks, editing])
            setEditing(null)
          } finally {
            setSaving(false)
          }
        }}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        onCancel={() => setEditing(null)}
      >
        {editing && (
          <div className="flex flex-col gap-3 pt-2">
            <div>
              <div className="mb-1 text-xs text-gray-500">任务名</div>
              <Input
                placeholder="如：写周报提醒"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </div>
            <div>
              <div className="mb-1 text-xs text-gray-500">动作</div>
              <Select
                className="w-full"
                value={editing.kind}
                onChange={(v) => {
                  // 切换动作后旧参数语义失效（通知文本 ≠ 链接），清空让用户重填；
                  // 打开链接 ↔ Webhook 都是 URL，互换时保留
                  const urlKind = (k: string) => k === 'open_url' || k === 'webhook'
                  setEditing({ ...editing, kind: v, param: urlKind(editing.kind) && urlKind(v) ? editing.param : '' })
                }}
                options={[
                  ...TASK_KINDS.map((k) => ({ value: k.value, label: k.label })),
                  // 编辑遗留任务时注入当前值，避免 Select 显示原始 kind id
                  ...(LEGACY_KIND_LABELS[editing.kind] ? [{ value: editing.kind, label: LEGACY_KIND_LABELS[editing.kind] }] : []),
                ]}
              />
            </div>
            {kindMeta(editing.kind)?.hasParam && (
              <div>
                <div className="mb-1 text-xs text-gray-500">参数</div>
                <Input
                  placeholder={kindMeta(editing.kind)?.paramPlaceholder}
                  value={editing.param}
                  onChange={(e) => setEditing({ ...editing, param: e.target.value })}
                />
              </div>
            )}
            <div className="flex items-center gap-2">
              <Select
                className="w-36"
                value={editing.schedule === 'daily' ? 'daily' : editing.schedule.startsWith('weekly') ? 'weekly' : 'interval'}
                onChange={(v) =>
                  setEditing({
                    ...editing,
                    schedule: v === 'daily' ? 'daily' : v === 'weekly' ? 'weekly:1,2,3,4,5' : 'interval:60',
                    time: editing.time || '09:00',
                  })
                }
                options={[
                  { value: 'daily', label: '每天' },
                  { value: 'weekly', label: '每周指定几天' },
                  { value: 'interval', label: '每 N 分钟' },
                ]}
              />
              {editing.schedule === 'daily' && (
                <TimePicker
                  className="w-28"
                  format="HH:mm"
                  minuteStep={5}
                  allowClear={false}
                  value={timeValue(editing.time)}
                  onChange={onTimeChange(editing, setEditing)}
                />
              )}
              {editing.schedule.startsWith('weekly') && (
                <>
                  <Select
                    className="w-56"
                    mode="multiple"
                    placeholder="选择周几"
                    value={editing.schedule.slice('weekly:'.length).split(',').map((x) => x.trim()).filter(Boolean)}
                    onChange={(days) => setEditing({ ...editing, schedule: `weekly:${days.sort().join(',')}` })}
                    options={WEEK_OPTIONS}
                  />
                  <TimePicker
                    className="w-28"
                    format="HH:mm"
                    minuteStep={5}
                    allowClear={false}
                    value={timeValue(editing.time)}
                    onChange={onTimeChange(editing, setEditing)}
                  />
                </>
              )}
              {editing.schedule.startsWith('interval') && (
                <Input
                  className="w-28"
                  type="number"
                  suffix="分钟"
                  min={1}
                  value={editing.schedule.slice('interval:'.length)}
                  onChange={(e) => setEditing({ ...editing, schedule: `interval:${e.target.value || '60'}` })}
                />
              )}
            </div>
          </div>
        )}
      </Modal>
    </Card>
  )
}
