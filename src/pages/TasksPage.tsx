import ScheduledTasksCard from '../components/settings/ScheduledTasksCard'

/** 定时任务：独立菜单页（设置页不再承载） */
export default function TasksPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-10">
      <h2 className="m-0 text-lg font-semibold">定时任务</h2>
      <p className="mb-2 mt-1 text-xs text-gray-400">
        到点自动执行：提醒通知、打开链接、调用 Webhook。需应用在后台运行（开机自启动 + 托盘常驻可保证）。
        WebDAV 自动备份在「设置 → WebDAV 同步」里开启。
      </p>
      <ScheduledTasksCard flat />
    </div>
  )
}
