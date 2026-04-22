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
  // Why: preserve agent *idle* titles (e.g. "* Claude done") across restart.
  // The pane may reattach into the same agent process, in which case keeping
  // the title matches reality (and is what pty-connection.ts reads to seed
  // its BEL-suppression agent-mode flag — without the seed, a restored Claude
  // pane would flag the tab unread on every BEL from its repaint loop). Only
  // "working" titles are reset: those encode ephemeral per-request state
  // (e.g. "⠋ Claude working") that is misleading after a restart because no
  // request is actually in flight on the newly-reconnected PTY.
  return detectAgentStatusFromTitle(tab.title) === 'working' ? fallbackTitle : tab.title
}
