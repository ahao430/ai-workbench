import { useEffect } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import { call } from '../../api/ipc'

export default function AppLayout() {
  const navigate = useNavigate()

  // 首次启动：初始化向导未完成时进入 /setup（仅一次，主窗口侧）
  useEffect(() => {
    let ignore = false
    call<boolean>('setup_get_done')
      .then((done) => {
        if (!ignore && !done) navigate('/setup', { replace: true })
      })
      .catch(() => {})
    return () => {
      ignore = true
    }
  }, [navigate])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#f6f6f9] text-gray-900 dark:bg-[#141418] dark:text-gray-100">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
