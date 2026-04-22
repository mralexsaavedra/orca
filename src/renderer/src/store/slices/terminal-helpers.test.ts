import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import { emptyLayoutSnapshot, clearTransientTerminalState } from './terminal-helpers'

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-123',
    worktreeId: 'wt-1',
    title: 'bash',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: Date.now(),
    ...overrides
  }
}

describe('emptyLayoutSnapshot', () => {
  it('returns correct default structure', () => {
    const snapshot = emptyLayoutSnapshot()
    expect(snapshot).toEqual({
      root: null,
      activeLeafId: null,
      expandedLeafId: null
    })
  })
})

describe('clearTransientTerminalState', () => {
  it('clears ptyId to null', () => {
    const tab = makeTab({ ptyId: 'pty-abc' })
    const result = clearTransientTerminalState(tab, 0)
    expect(result.ptyId).toBeNull()
  })

  it('uses customTitle as fallback when tab has agent status in title', () => {
    const tab = makeTab({ title: '. claude', customTitle: 'My Agent' })
    const result = clearTransientTerminalState(tab, 0)
    expect(result.title).toBe('My Agent')
  })

  it('uses "Terminal {index+1}" fallback when agent status in title and no customTitle', () => {
    const tab = makeTab({ title: '. claude', customTitle: null })
    const result = clearTransientTerminalState(tab, 0)
    expect(result.title).toBe('Terminal 1')
  })

  it('prefers defaultTitle over index fallback when present', () => {
    const tab = makeTab({ title: '. claude', customTitle: null, defaultTitle: 'Terminal 4' })
    const result = clearTransientTerminalState(tab, 0)
    expect(result.title).toBe('Terminal 4')
  })

  it('keeps original title when no agent status detected', () => {
    const tab = makeTab({ title: 'bash' })
    const result = clearTransientTerminalState(tab, 0)
    expect(result.title).toBe('bash')
  })

  // Why: preserving idle agent titles across restart feeds the
  // paneIsInAgentMode seed in pty-connection.ts — without it, a restored
  // Claude pane's post-reattach BEL repaint stream marks the tab unread on
  // every tab switch (undismissable-bell bug).
  it('preserves idle agent titles across hydration', () => {
    const tab = makeTab({ title: '* Claude done', customTitle: null })
    const result = clearTransientTerminalState(tab, 0)
    expect(result.title).toBe('* Claude done')
  })

  it('still resets working agent titles to fallback across hydration', () => {
    // Why: "working" titles encode ephemeral per-request state that is
    // misleading after restart — the prior request is not actually in flight
    // on the reconnected PTY, so we reset to the stable terminal label.
    const tab = makeTab({ title: '⠋ Claude working', customTitle: null })
    const result = clearTransientTerminalState(tab, 0)
    expect(result.title).toBe('Terminal 1')
  })

  it('uses "Terminal {index+1}" when customTitle is whitespace only', () => {
    const tab = makeTab({ title: '⠋ codex running', customTitle: '   ' })
    const result = clearTransientTerminalState(tab, 0)
    expect(result.title).toBe('Terminal 1')
  })

  it('index-based fallback numbering: index 0 → "Terminal 1"', () => {
    const tab = makeTab({ title: '. claude', customTitle: null })
    const result = clearTransientTerminalState(tab, 0)
    expect(result.title).toBe('Terminal 1')
  })

  it('index-based fallback numbering: index 2 → "Terminal 3"', () => {
    const tab = makeTab({ title: '. claude', customTitle: null })
    const result = clearTransientTerminalState(tab, 2)
    expect(result.title).toBe('Terminal 3')
  })
})
