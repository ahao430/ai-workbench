import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'light' | 'dark'

interface UiState {
  theme: ThemeMode
  sidebarCollapsed: boolean
  /** 额度自动刷新间隔（秒），0 = 关闭，默认 30s */
  quotaRefreshSec: number
  /** Agent 新会话使用的 CLI（pi/claude/codex/opencode），Agent 页公共配置/设置页均可改 */
  agentCli: string
  /** Agent 全局关闭的技能名（未列出的默认开启） */
  agentSkillsOff: string[]
  /** Agent 全局关闭的 MCP 名（未列出的默认开启；仅 Claude Code 会话注入） */
  agentMcpsOff: string[]
  setTheme: (theme: ThemeMode) => void
  toggleSidebar: () => void
  setQuotaRefreshSec: (sec: number) => void
  setAgentCli: (cli: string) => void
  setAgentSkillsOff: (off: string[]) => void
  setAgentMcpsOff: (off: string[]) => void
}

/** 界面偏好（主题/侧栏折叠/额度刷新间隔/Agent 公共配置），localStorage 持久化 */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'light',
      sidebarCollapsed: false,
      quotaRefreshSec: 30,
      agentCli: 'pi',
      agentSkillsOff: [],
      agentMcpsOff: [],
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setQuotaRefreshSec: (quotaRefreshSec) => set({ quotaRefreshSec }),
      setAgentCli: (agentCli) => set({ agentCli }),
      setAgentSkillsOff: (agentSkillsOff) => set({ agentSkillsOff }),
      setAgentMcpsOff: (agentMcpsOff) => set({ agentMcpsOff }),
    }),
    { name: 'ai-workbench-ui' },
  ),
)
