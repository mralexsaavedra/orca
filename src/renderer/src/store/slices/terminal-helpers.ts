import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { detectAgentStatusFromTitle } from '@/lib/agent-status'

export function emptyLayoutSnapshot(): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId: null,
    expandedLeafId: null
  }
}

export function clearTransientTerminalState(tab: TerminalTab, index: number): TerminalTab {
  return {
    ...tab,
    ptyId: null,
    title: getResetTitle(tab, index)
  }
}

function getResetTitle(tab: TerminalTab, index: number): string {
  const fallbackTitle =
    tab.customTitle?.trim() || tab.defaultTitle?.trim() || `Terminal ${index + 1}`
  // Why: reset any recognized agent title on hydration. The prior-session
  // agent is no longer actually running, so showing "Claude done" or a
  // working spinner is misleading. The separate `wasAgentPane` latch on the
  // tab carries the "this was an agent pane" fact across hydration so
  // pty-connection can still seed its BEL-suppression flag without needing
  // the live title to survive.
  return detectAgentStatusFromTitle(tab.title) !== null ? fallbackTitle : tab.title
}
