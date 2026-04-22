/* oxlint-disable max-lines */
import {
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker,
  normalizeTerminalTitle,
  extractLastOscTitle
} from '../../../../shared/agent-detection'
import type { OpenCodeStatusEvent } from '../../../../shared/types'
import {
  ptyDataHandlers,
  ptyExitHandlers,
  openCodeStatusHandlers,
  ptyTeardownHandlers,
  ensurePtyDispatcher,
  getEagerPtyBufferHandle
} from './pty-dispatcher'
import type { PtyTransport, IpcPtyTransportOptions, PtyConnectResult } from './pty-dispatcher'
import { createBellDetector } from './bell-detector'

// Re-export public API so existing consumers keep working.
export {
  ensurePtyDispatcher,
  getEagerPtyBufferHandle,
  registerEagerPtyBuffer,
  unregisterPtyDataHandlers
} from './pty-dispatcher'
export type {
  EagerPtyHandle,
  PtyTransport,
  PtyConnectResult,
  IpcPtyTransportOptions
} from './pty-dispatcher'
export { extractLastOscTitle } from '../../../../shared/agent-detection'

export function createIpcPtyTransport(opts: IpcPtyTransportOptions = {}): PtyTransport {
  const {
    cwd,
    env,
    command,
    connectionId,
    worktreeId,
    onPtyExit,
    onTitleChange,
    onPtySpawn,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited
  } = opts
  let connected = false
  let destroyed = false
  let ptyId: string | null = null
  const chunkContainsBell = createBellDetector()
  let suppressAttentionEvents = false
  let suppressAgentIdleTransitions = false
  // Why: reattach can stream a catch-up burst that includes a BEL from a
  // completion that fired while Orca was closed. We cannot distinguish a
  // replayed completion BEL from a brand-new one, so we drop BEL during the
  // same short grace window that covers idle-title transitions. Without this,
  // the tab would be marked unread by the replayed bell on every restart and
  // clicking through it would bring the mark back on the next relaunch.
  let suppressCatchupBells = false
  let lastEmittedTitle: string | null = null
  let lastObservedTerminalTitle: string | null = null
  let openCodeStatus: OpenCodeStatusEvent['status'] | null = null
  let staleTitleTimer: ReturnType<typeof setTimeout> | null = null
  let reattachGraceTimer: ReturnType<typeof setTimeout> | null = null
  const agentTracker =
    onAgentBecameIdle || onAgentBecameWorking || onAgentExited
      ? createAgentStatusTracker(
          (title) => {
            if (!suppressAgentIdleTransitions) {
              onAgentBecameIdle?.(title)
            }
          },
          onAgentBecameWorking,
          onAgentExited
        )
      : null

  const STALE_TITLE_TIMEOUT = 3000 // ms before stale working title is cleared
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}

  function unregisterPtyHandlers(id: string): void {
    ptyDataHandlers.delete(id)
    ptyExitHandlers.delete(id)
    openCodeStatusHandlers.delete(id)
    ptyTeardownHandlers.delete(id)
  }

  function unregisterPtyDataAndStatusHandlers(id: string): void {
    ptyDataHandlers.delete(id)
    openCodeStatusHandlers.delete(id)
  }

  // Why: arm a 2s grace window that drops catch-up attention events (replayed
  // idle-title transitions and BEL) streamed by the daemon after a reattach.
  // Shared by both reattach paths: in-session remount goes through attach(),
  // while cold-app-relaunch goes through connect({sessionId}) — without
  // covering both, a completion BEL from a prior session re-fires on every
  // restart and permanently marks the tab unread.
  function armReattachGraceWindow(): void {
    suppressAgentIdleTransitions = true
    suppressCatchupBells = true
    if (reattachGraceTimer) {
      clearTimeout(reattachGraceTimer)
    }
    reattachGraceTimer = setTimeout(() => {
      reattachGraceTimer = null
      suppressAgentIdleTransitions = false
      suppressCatchupBells = false
      // Why: reset the tracker again here. Any working→idle transition during
      // the grace period was suppressed at the callback layer but still
      // mutated lastStatus. Reset so the first post-grace title starts clean.
      agentTracker?.reset()
    }, 2000)
  }

  function getSyntheticOpenCodeTitle(status: OpenCodeStatusEvent['status']): string {
    const baseTitle =
      lastObservedTerminalTitle && lastObservedTerminalTitle !== 'OpenCode'
        ? `OpenCode · ${lastObservedTerminalTitle}`
        : 'OpenCode'

    if (status === 'working') {
      return `⠋ ${baseTitle}`
    }
    if (status === 'permission') {
      return `${baseTitle} permission needed`
    }
    return baseTitle
  }

  function applyOpenCodeStatus(event: OpenCodeStatusEvent): void {
    openCodeStatus = event.status
    if (staleTitleTimer) {
      clearTimeout(staleTitleTimer)
      staleTitleTimer = null
    }

    const rawTitle = getSyntheticOpenCodeTitle(event.status)
    const title = normalizeTerminalTitle(rawTitle)
    lastEmittedTitle = title
    onTitleChange?.(title, rawTitle)
    agentTracker?.handleTitle(rawTitle)
  }

  function applyObservedTerminalTitle(title: string): void {
    lastObservedTerminalTitle = title
    // Why: while OpenCode has an explicit non-idle status, that status is the
    // source of truth — the observed title is only used as context text.
    if (openCodeStatus && openCodeStatus !== 'idle') {
      applyOpenCodeStatus({ ptyId: ptyId ?? '', status: openCodeStatus })
      return
    }

    lastEmittedTitle = normalizeTerminalTitle(title)
    onTitleChange?.(lastEmittedTitle, title)
    agentTracker?.handleTitle(title)
  }

  // Why: shared by connect() and attach() to avoid duplicating title/bell/exit logic.
  function registerPtyDataHandler(id: string): void {
    ptyDataHandlers.set(id, (data) => {
      storedCallbacks.onData?.(data)
      if (onTitleChange) {
        const title = extractLastOscTitle(data)
        if (title !== null) {
          if (staleTitleTimer) {
            clearTimeout(staleTitleTimer)
            staleTitleTimer = null
          }
          applyObservedTerminalTitle(title)
        } else if (lastEmittedTitle && detectAgentStatusFromTitle(lastEmittedTitle) === 'working') {
          if (staleTitleTimer) {
            clearTimeout(staleTitleTimer)
          }
          staleTitleTimer = setTimeout(() => {
            staleTitleTimer = null
            if (lastEmittedTitle && detectAgentStatusFromTitle(lastEmittedTitle) === 'working') {
              const cleared = clearWorkingIndicators(lastEmittedTitle)
              lastEmittedTitle = cleared
              onTitleChange(cleared, cleared)
              agentTracker?.handleTitle(cleared)
            }
          }, STALE_TITLE_TIMEOUT)
        }
      }
      if (onBell && chunkContainsBell(data) && !suppressAttentionEvents && !suppressCatchupBells) {
        onBell()
      }
    })
  }

  function clearAccumulatedState(): void {
    if (staleTitleTimer) {
      clearTimeout(staleTitleTimer)
      staleTitleTimer = null
    }
    if (reattachGraceTimer) {
      clearTimeout(reattachGraceTimer)
      reattachGraceTimer = null
    }
    suppressAgentIdleTransitions = false
    suppressCatchupBells = false
    agentTracker?.reset()
    openCodeStatus = null
  }

  function registerPtyExitHandler(id: string): void {
    ptyExitHandlers.set(id, (code) => {
      clearAccumulatedState()
      connected = false
      ptyId = null
      unregisterPtyHandlers(id)
      storedCallbacks.onExit?.(code)
      storedCallbacks.onDisconnect?.()
      onPtyExit?.(id)
    })
    openCodeStatusHandlers.set(id, applyOpenCodeStatus)
    // Why: shutdownWorktreeTerminals bypasses the transport layer — it
    // kills PTYs directly via IPC without calling disconnect()/destroy().
    // This teardown callback lets unregisterPtyDataHandlers cancel
    // accumulated closure state (staleTitleTimer, agent tracker) that
    // would otherwise fire stale notifications after the data handler
    // is removed but before the exit event arrives.
    ptyTeardownHandlers.set(id, clearAccumulatedState)
  }

  return {
    async connect(options) {
      storedCallbacks = options.callbacks
      ensurePtyDispatcher()

      if (destroyed) {
        return
      }

      try {
        const result = await window.api.pty.spawn({
          cols: options.cols ?? 80,
          rows: options.rows ?? 24,
          cwd,
          env,
          command,
          ...(connectionId ? { connectionId } : {}),
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          worktreeId
        })

        // If destroyed while spawn was in flight, kill the new pty and bail
        if (destroyed) {
          window.api.pty.kill(result.id)
          return
        }

        ptyId = result.id
        connected = true

        // Why: for deferred reattach (Option 2), the daemon returns snapshot/
        // coldRestore data from createOrAttach. Skip onPtySpawn for reattach —
        // it would reset lastActivityAt and destroy the recency sort order.
        if (!result.isReattach && !result.coldRestore) {
          onPtySpawn?.(result.id)
        }

        registerPtyDataHandler(result.id)
        registerPtyExitHandler(result.id)

        storedCallbacks.onConnect?.()
        storedCallbacks.onStatus?.('shell')

        if (result.isReattach || result.coldRestore) {
          // Why: cold-app relaunch of a daemon-backed tab comes through this
          // path (deferred reattach in pty-connection.ts), not attach(). The
          // daemon streams catch-up bytes — including any BEL from a
          // completion that fired while Orca was closed — after the first
          // onData frame. Without arming the grace window here, every
          // restart of a tab whose agent had completed would re-raise a
          // phantom "needs attention" mark that tab-clicks couldn't clear.
          armReattachGraceWindow()
          return {
            id: result.id,
            snapshot: result.snapshot,
            isAlternateScreen: result.isAlternateScreen,
            coldRestore: result.coldRestore
          } satisfies PtyConnectResult
        }
        return result.id
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Why: on cold start, SSH provider isn't registered yet so pty:spawn
        // throws a raw IPC error. Replace with a friendly message since this
        // is an expected state, not an application crash.
        if (connectionId && msg.includes('No PTY provider for connection')) {
          storedCallbacks.onError?.(
            'SSH connection is not active. Use the reconnect dialog or Settings to connect.'
          )
        } else {
          storedCallbacks.onError?.(msg)
        }
        return undefined
      }
    },

    attach(options) {
      storedCallbacks = options.callbacks
      ensurePtyDispatcher()

      if (destroyed) {
        return
      }

      const id = options.existingPtyId
      ptyId = id
      connected = true
      // Why: skip onPtySpawn — it would reset lastActivityAt and destroy the
      // recency sort order that reconnectPersistedTerminals preserved.
      registerPtyDataHandler(id)
      registerPtyExitHandler(id)

      const bufferHandle = getEagerPtyBufferHandle(id)
      if (bufferHandle) {
        const buffered = bufferHandle.flush()
        if (buffered) {
          // Why: eager PTY buffers contain output produced before the pane
          // attached, often from a previous app session. We still replay that
          // data so titles and scrollback restore correctly, but it must not
          // generate fresh unread badges or notifications for unrelated
          // worktrees just because Orca is reconnecting background terminals.
          suppressAttentionEvents = true
          try {
            ptyDataHandlers.get(id)?.(buffered)
          } finally {
            suppressAttentionEvents = false
          }
        }
        bufferHandle.dispose()
        // Why: replaying the eager buffer silently feeds historical OSC
        // titles through the agent-status tracker. Its `lastStatus` field
        // is mutated by every replayed title — if the prior session ended
        // mid-"working", lastStatus would persist as 'working' into the
        // live session. A later real title detected as 'idle' (common when
        // the cwd path contains an agent name after the agent has exited)
        // would then look like a fresh working→idle transition and fire
        // a phantom unread notification. Reset after replay so only
        // post-attach titles drive transitions.
        agentTracker?.reset()
      }

      // Why: on reattach, the daemon keeps streaming a short tail of
      // catch-up bytes (titles, prompt redraws, spinner frames, BEL from
      // completions that fired while the app was closed) after the
      // eager-buffer flush window closes. Those events are indistinguishable
      // from fresh activity. Drop attention signals for a short grace window.
      armReattachGraceWindow()

      // Why: clear the display before writing the snapshot so restored
      // content doesn't layer on top of stale output. Skip the clear for
      // alternate-screen sessions — the snapshot already fills the screen
      // and clearing would erase it.
      if (!options.isAlternateScreen) {
        storedCallbacks.onData?.('\x1b[2J\x1b[3J\x1b[H')
      }

      if (options.cols && options.rows) {
        window.api.pty.resize(id, options.cols, options.rows)
      }

      storedCallbacks.onConnect?.()
      storedCallbacks.onStatus?.('shell')
    },

    disconnect() {
      if (staleTitleTimer) {
        clearTimeout(staleTitleTimer)
        staleTitleTimer = null
      }
      openCodeStatus = null
      if (ptyId) {
        const id = ptyId
        window.api.pty.kill(id)
        connected = false
        ptyId = null
        unregisterPtyHandlers(id)
        storedCallbacks.onDisconnect?.()
      }
    },

    detach() {
      if (staleTitleTimer) {
        clearTimeout(staleTitleTimer)
        staleTitleTimer = null
      }
      openCodeStatus = null
      if (ptyId) {
        // Why: detach() is used for in-session remounts such as moving a tab
        // between split groups. Stop delivering data/title events into the
        // unmounted pane immediately, but keep the PTY exit observer alive so
        // a shell that dies during the remount gap can still clear stale
        // tab/leaf bindings before the next pane attempts to reattach.
        unregisterPtyDataAndStatusHandlers(ptyId)
      }
      connected = false
      ptyId = null
      storedCallbacks = {}
    },

    sendInput(data: string): boolean {
      if (!connected || !ptyId) {
        return false
      }
      window.api.pty.write(ptyId, data)
      return true
    },

    resize(cols: number, rows: number): boolean {
      if (!connected || !ptyId) {
        return false
      }
      window.api.pty.resize(ptyId, cols, rows)
      return true
    },

    isConnected() {
      return connected
    },

    getPtyId() {
      return ptyId
    },

    destroy() {
      destroyed = true
      this.disconnect()
    }
  }
}
