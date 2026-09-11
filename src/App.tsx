import { Component, Suspense, lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Spin } from 'antd'
import AppLayout from './components/layout/AppLayout'

/** ErrorBoundary：捕获渲染错误并显示，避免白屏 */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-8">
          <h2 className="mb-2 text-lg font-semibold text-red-500">页面渲染出错</h2>
          <pre className="whitespace-pre-wrap text-sm text-gray-600">{this.state.error.message}</pre>
          <pre className="mt-2 whitespace-pre-wrap text-xs text-gray-400">{this.state.error.stack}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

// 路由级代码分割：控制主包体积
function lazyPage<T extends ComponentType<Record<string, unknown>>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(factory)
}

const HomePage = lazyPage(() => import('./pages/HomePage'))
const ChatPage = lazyPage(() => import('./pages/ChatPage'))
const DrawPage = lazyPage(() => import('./pages/DrawPage'))
const DiagramPage = lazyPage(() => import('./pages/DiagramPage'))
const RetouchPage = lazyPage(() => import('./pages/RetouchPage'))
const ChartsPage = lazyPage(() => import('./pages/ChartsPage'))
const SheetPage = lazyPage(() => import('./pages/SheetPage'))
const SkillsPage = lazyPage(() => import('./pages/SkillsPage'))
const McpPage = lazyPage(() => import('./pages/McpPage'))
const KnowledgePage = lazyPage(() => import('./pages/KnowledgePage'))
const NotesPage = lazyPage(() => import('./pages/NotesPage'))
const TodoPage = lazyPage(() => import('./pages/TodoPage'))
const AIServicePage = lazyPage(() => import('./pages/AIServicePage'))
const YunxiaoPage = lazyPage(() => import('./pages/YunxiaoPage'))
const ToolsPage = lazyPage(() => import('./pages/ToolsPage'))
const TasksPage = lazyPage(() => import('./pages/TasksPage'))
const LinksPage = lazyPage(() => import('./pages/LinksPage'))
const SettingsPage = lazyPage(() => import('./pages/SettingsPage'))
const YuquePage = lazyPage(() => import('./pages/YuquePage'))
const AgentPage = lazyPage(() => import('./pages/AgentPage'))
// 首次启动初始化向导：独立全屏路由（不套主布局/侧栏）
const SetupPage = lazyPage(() => import('./pages/SetupPage'))
// 托盘用量面板：独立窗口路由（不套主布局/侧栏）
const TrayPanelPage = lazyPage(() => import('./pages/TrayPanelPage'))

function PageLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spin />
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route
          path="/"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <HomePage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/chat"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <ChatPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/draw"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <DrawPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/diagram"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <DiagramPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/retouch"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <RetouchPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/charts"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <ChartsPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/sheet"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <SheetPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/skills"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <SkillsPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/mcp"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <McpPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/knowledge"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <KnowledgePage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/yuque"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <YuquePage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/notes"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <NotesPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/todo"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <TodoPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/agent"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <AgentPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/ai-service"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <AIServicePage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/yunxiao"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <YunxiaoPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/links"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <LinksPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/tasks"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <TasksPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/tools"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <ToolsPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route
          path="/settings"
          element={
            <ErrorBoundary><Suspense fallback={<PageLoading />}>
              <SettingsPage />
            </Suspense></ErrorBoundary>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      <Route
        path="/setup"
        element={
          <ErrorBoundary><Suspense fallback={<PageLoading />}>
            <SetupPage />
          </Suspense></ErrorBoundary>
        }
      />
      <Route
        path="/tray-panel"
        element={
          <ErrorBoundary><Suspense fallback={<PageLoading />}>
            <TrayPanelPage />
          </Suspense></ErrorBoundary>
        }
      />
    </Routes>
  )
}
