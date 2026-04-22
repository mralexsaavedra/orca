/* oxlint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type StoreState = {
  tabsByWorktree: Record<string, { id: string; ptyId: string | null; title?: string }[]>
  ptyIdsByTabId?: Record<string, string[]>
  worktreesByRepo: Record<string, { id: string; repoId: string; path: string }[]>
  repos: { id: string; connectionId?: string | null }[]
  cacheTimerByKey: Record<string, number | null>
  settings: { promptCacheTimerEnabled?: boolean; experimentalTerminalDaemon?: boolean } | null
  codexRestartNoticeByPtyId: Record<
    string,
    { previousAccountLabel: string; nextAccountLabel: string }
  >
  consumePendingColdRestore: ReturnType<typeof vi.fn>
  consumePendingSnapshot: ReturnType<typeof vi.fn>
}

type ConnectCallbacks = {
  onData?: (data: string) => void
  onError?: (msg: string) => void
}

type MockTransport = {
  attach: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn> & {
    mockImplementation: (
      impl: (
        opts: { callbacks?: ConnectCallbacks } & Record<string, unknown>
      ) => Promise<string | null>
    ) => unknown
  }
  sendInput: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  getPtyId: ReturnType<typeof vi.fn>
}

const scheduleRuntimeGraphSync = vi.fn()
const shouldSeedCacheTimerOnInitialTitle = vi.fn(() => false)

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

vi.mock('@/lib/agent-status', () => ({
  isGeminiTerminalTitle: vi.fn(() => false),
  isClaudeAgent: vi.fn(() => false),
  detectAgentStatusFromTitle: vi.fn((title: string) =>
    /Claude (working|done)/.test(title) ? (/working/.test(title) ? 'working' : 'idle') : null
  )
}))

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

function createMockTransport(initialPtyId: string | null = null): MockTransport {
  let ptyId = initialPtyId
  return {
    attach: vi.fn(({ existingPtyId }: { existingPtyId: string }) => {
      ptyId = existingPtyId
    }),
    connect: vi.fn().mockImplementation(async (opts: { sessionId?: string }) => {
      if (opts.sessionId) {
        ptyId = opts.sessionId
        return { id: opts.sessionId }
      }
      return ptyId
    }),
    sendInput: vi.fn(() => true),
    resize: vi.fn(() => true),
    getPtyId: vi.fn(() => ptyId)
  } as MockTransport
}

function createPane(paneId: number) {
  return {
    id: paneId,
    terminal: {
      cols: 120,
      rows: 40,
      write: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() }))
    },
    fitAddon: {
      fit: vi.fn()
    }
  }
}

function createManager(paneCount = 1) {
  return {
    setPaneGpuRendering: vi.fn(),
    getPanes: vi.fn(() => Array.from({ length: paneCount }, (_, index) => ({ id: index + 1 }))),
    closePane: vi.fn(),
    getActivePane: vi.fn<() => { id: number } | null>(() => null)
  }
}

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    cwd: '/tmp/wt-1',
    startup: null,
    restoredLeafId: null,
    restoredPtyIdByLeafId: {},
    paneTransportsRef: { current: new Map() },
    pendingWritesRef: { current: new Map() },
    isActiveRef: { current: true },
    isVisibleRef: { current: true },
    onPtyExitRef: { current: vi.fn() },
    onPtyErrorRef: { current: vi.fn() },
    clearTabPtyId: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(() => false),
    updateTabTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabPtyId: vi.fn(),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    dispatchNotification: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    ...overrides
  }
}

describe('connectPanePty', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    mockStoreState = {
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['tab-pty']
      },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1' }]
      },
      repos: [{ id: 'repo1', connectionId: null }],
      cacheTimerByKey: {},
      settings: { promptCacheTimerEnabled: true },
      codexRestartNoticeByPtyId: {},
      consumePendingColdRestore: vi.fn(() => null),
      consumePendingSnapshot: vi.fn(() => null)
    } as StoreState
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    globalThis.cancelAnimationFrame = vi.fn()
  })

  afterEach(() => {
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
    } else {
      delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame })
        .requestAnimationFrame
    }
    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
    } else {
      delete (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame })
        .cancelAnimationFrame
    }
  })

  it('does not send startup command via sendInput for local connections', async () => {
    // Why: the local PTY provider already writes the command via
    // writeStartupCommandWhenShellReady — sending it again from the renderer
    // would cause the command to appear twice in the terminal.
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-local-1'
    })
    transportFactoryQueue.push(transport)

    // Local connection: no connectionId
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ startup: { command: "claude 'say test'" } })

    connectPanePty(pane as never, manager as never, deps as never)
    expect(capturedDataCallback.current).not.toBeNull()

    // Simulate PTY output (shell prompt arriving)
    capturedDataCallback.current?.('(base) user@host $ ')

    // Even after the debounce window, the renderer must not inject the command
    // because the main process already wrote it via writeStartupCommandWhenShellReady.
    expect(transport.sendInput).not.toHaveBeenCalledWith(
      expect.stringContaining("claude 'say test'")
    )
  })

  it('blocks input to stale Codex panes until they restart', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-codex-stale')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-codex-stale' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-codex-stale']
      },
      codexRestartNoticeByPtyId: {
        'pty-codex-stale': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    const sendTerminalInput = onDataHandler as (data: string) => void
    sendTerminalInput('hello')

    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('blocks input when tab-level ptyId is stale even if panePtyId is null', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport(null)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-level-pty' }]
      },
      codexRestartNoticeByPtyId: {
        'tab-level-pty': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('hello')

    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('sends startup command via sendInput for SSH connections (relay has no shell-ready mechanism)', async () => {
    // Capture the setTimeout callback directly so we can fire it without
    // vi.useFakeTimers() (which would also replace the rAF mock from beforeEach).
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport()
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      // SSH connection: connectionId is set, relay ignores the command field
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }]
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({ startup: { command: "claude 'say test'" } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(capturedDataCallback.current).not.toBeNull()

      // Simulate shell prompt arriving — queues the debounce timer
      capturedDataCallback.current?.('user@remote $ ')

      // Fire all queued setTimeout callbacks (the debounce)
      for (const fn of pendingTimeouts) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith("claude 'say test'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('reattaches a remounted split pane to its restored leaf PTY instead of the tab-level PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: {
        ...mockStoreState.settings,
        experimentalTerminalDaemon: true
      }
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: 'pane:2',
      restoredPtyIdByLeafId: { 'pane:2': 'leaf-pty-2' }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    // Why: Option 2 deferred reattach uses connect({ sessionId }) instead of
    // attach({ existingPtyId }) so the daemon's createOrAttach runs at the
    // pane's real fitAddon dimensions.
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'leaf-pty-2' })
    )
    expect(transport.attach).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'leaf-pty-2')
  })

  it('reuses the existing local PTY on split remount when the daemon is disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-local-detached' }]
      },
      settings: {
        ...mockStoreState.settings,
        // Why: with the daemon off, split/remount should still keep the
        // in-process PTY alive within the same app session. This regression
        // came from treating every remount like a daemon session reattach.
        experimentalTerminalDaemon: false
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: 'pane:2',
      restoredPtyIdByLeafId: { 'pane:2': 'pty-local-detached' }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'pty-local-detached' })
    )
    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-local-detached')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-local-detached')
  })

  it('reattaches via daemon sessionId when the daemon is enabled and an in-session PTY is live', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-local-detached' }]
      },
      settings: {
        ...mockStoreState.settings,
        // Why: complement of the daemon-off case — with the daemon on, the
        // in-session remount path must go through connect({sessionId}) so
        // the daemon's createOrAttach runs at the pane's real dimensions.
        experimentalTerminalDaemon: true
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-local-detached' })
    )
    expect(transport.attach).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-local-detached')
  })

  it('persists a restarted pane PTY id and uses it on the next remount', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const restartedTransport = createMockTransport()
    let spawnedPtyId: string | null = null
    restartedTransport.connect.mockImplementation(async () => {
      spawnedPtyId = 'pty-restarted'
      const opts = createdTransportOptions[0]
      ;(opts.onPtySpawn as (ptyId: string) => void)('pty-restarted')
      return 'pty-restarted'
    })
    transportFactoryQueue.push(restartedTransport)

    const restartPane = createPane(1)
    const restartManager = createManager(1)
    const restartDeps = createDeps({
      paneTransportsRef: { current: new Map([[99, createMockTransport('another-pane-pty')]]) }
    })

    connectPanePty(restartPane as never, restartManager as never, restartDeps as never)
    await Promise.resolve()

    expect(spawnedPtyId).toBe('pty-restarted')
    expect(restartDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted')

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-restarted' }]
      },
      settings: {
        ...mockStoreState.settings,
        experimentalTerminalDaemon: true
      }
    }

    const remountTransport = createMockTransport()
    transportFactoryQueue.push(remountTransport)
    const remountPane = createPane(1)
    const remountManager = createManager(1)
    const remountDeps = createDeps({
      restoredLeafId: 'pane:1',
      restoredPtyIdByLeafId: { 'pane:1': 'pty-restarted' }
    })

    connectPanePty(remountPane as never, remountManager as never, remountDeps as never)

    expect(remountTransport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-restarted' })
    )
    expect(remountTransport.attach).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(remountDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted')
  })

  // Why: this pins down the reattach scenario directly. After Cmd+Q and
  // relaunch, a restored Claude pane emits its idle title first (no
  // working→idle transition fires), followed by a stream of BEL bytes from
  // its repaint loop. Before the fix, the BELs marked the tab unread on
  // every tab-switch — an undismissable indicator. The pane must observe the
  // idle title and immediately start dropping BEL at the pty-connection layer.
  it('drops BEL bytes that arrive after a restored Claude idle title (reattach path)', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane = vi.fn(() => ({ id: 999 }))
    const deps = createDeps({
      restoredLeafId: 'pane:1',
      restoredPtyIdByLeafId: { 'pane:1': 'pty-restored' }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!titleHandler || !bellHandler) {
      throw new Error('Expected onTitleChange and onBell to be registered')
    }

    // Step 1: the daemon replays the final pre-restart title. No working→idle
    // transition fires; the pane sees 'idle' on first sight.
    titleHandler('* Claude done', '* Claude done')

    // Step 2: Claude's post-reattach repaint stream — three separate BEL
    // chunks, mimicking the user's actual bug logs.
    bellHandler()
    bellHandler()
    bellHandler()

    // None of these should produce an unread mark or notification. Attention
    // for this pane now comes from a future working→idle transition.
    expect(deps.markWorktreeUnread).not.toHaveBeenCalled()
    expect(deps.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
  })

  // Why: the regression signature is "the dot comes back every time I click
  // away, even after the agent has exited". If onAgentExited does not clear
  // paneIsInAgentMode, then after Claude quits, a legitimate shell BEL (from
  // tooling running in the bare shell) would still be dropped.
  it('allows onBell again after onAgentExited fires', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane = vi.fn(() => ({ id: 999 }))
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const agentExitedHandler = createdTransportOptions[0]?.onAgentExited as (() => void) | undefined
    if (!titleHandler || !bellHandler || !agentExitedHandler) {
      throw new Error('Expected onTitleChange, onBell, and onAgentExited to be registered')
    }

    // Enter agent mode.
    titleHandler('* Claude done', '* Claude done')
    bellHandler()
    expect(deps.markTerminalTabUnread).not.toHaveBeenCalled()

    // Claude exits — shell prompt returns.
    agentExitedHandler()

    // A real shell BEL should now mark the tab again.
    bellHandler()
    expect(deps.markWorktreeUnread).toHaveBeenCalledTimes(1)
    expect(deps.markTerminalTabUnread).toHaveBeenCalledTimes(1)
    expect(deps.dispatchNotification).toHaveBeenCalledWith({ source: 'terminal-bell' })
  })

  // Why: this covers the reattach sequence. After Cmd+Q → relaunch, the
  // daemon returns a snapshot but xterm's @xterm/addon-serialize does NOT
  // include the OSC window title in its output, so replaying the snapshot
  // doesn't teach the pane it was in agent mode. The persisted tab title
  // (in the Orca store) does carry over the "* Claude done" string, so we
  // seed paneIsInAgentMode from it at connect time. Without this seed, the
  // post-reattach BEL repaint stream marks the tab unread on every tab
  // switch — the undismissable-bell bug after restart.
  it('seeds agent mode from the persisted tab title on reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    // The persisted tab title is what survives across restart. Place it in
    // store state the way a restored session would.
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', title: '* Claude done' }]
      }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane = vi.fn(() => ({ id: 999 }))
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler) {
      throw new Error('Expected onBell to be registered')
    }

    // BEL noise arrives immediately after reattach — before any PTY title
    // event has had a chance to flip the pane into agent mode. Seeding from
    // the persisted title is what catches this timing window.
    bellHandler()
    bellHandler()
    bellHandler()

    expect(deps.markWorktreeUnread).not.toHaveBeenCalled()
    expect(deps.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
  })

  // Why: Claude Code (and likely other TUIs) emits BEL bytes as part of its
  // normal UI rendering — every prompt redraw includes a BEL. If BEL drove
  // the attention signal for agent panes, clicking away from an agent tab
  // would re-flag it unread on the next render frame, producing a dot the
  // user cannot dismiss. onBell must become a no-op once we know the pane is
  // in agent mode (working OR idle); attention for agents comes from the
  // working→idle transition instead.
  it('drops onBell when the pane is in agent mode', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane = vi.fn(() => ({ id: 999 }))
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!titleHandler || !bellHandler) {
      throw new Error('Expected onTitleChange and onBell to be registered')
    }

    // Claude idle title — flips the pane into agent mode. No working→idle
    // transition is required (reattach case).
    titleHandler('* Claude done', '* Claude done')

    bellHandler()
    bellHandler()

    expect(deps.markWorktreeUnread).not.toHaveBeenCalled()
    expect(deps.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
  })

  // Why: the working→idle transition is the attention signal for agent
  // panes. onAgentBecameIdle must mark the tab and worktree unread so
  // background agent tabs get the indicator on completion.
  it('marks tab and worktree unread on agent working→idle transition', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Claude done')

    expect(deps.markWorktreeUnread).toHaveBeenCalledTimes(1)
    expect(deps.markTerminalTabUnread).toHaveBeenCalledTimes(1)
    expect(deps.dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: '* Claude done'
    })
  })

  it('debounces rapid bell bursts to one unread mark and notification', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-04-22T12:00:00Z'))
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      manager.getActivePane = vi.fn(() => ({ id: 999 }))
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
      if (!bellHandler) {
        throw new Error('Expected onBell handler to be registered')
      }

      bellHandler()
      vi.setSystemTime(new Date('2026-04-22T12:00:00.050Z'))
      bellHandler()
      vi.setSystemTime(new Date('2026-04-22T12:00:00.150Z'))
      bellHandler()

      expect(deps.markWorktreeUnread).toHaveBeenCalledTimes(2)
      expect(deps.markTerminalTabUnread).toHaveBeenCalledTimes(2)
      expect(deps.dispatchNotification).toHaveBeenCalledTimes(2)
      expect(deps.dispatchNotification).toHaveBeenNthCalledWith(1, { source: 'terminal-bell' })
      expect(deps.dispatchNotification).toHaveBeenNthCalledWith(2, { source: 'terminal-bell' })
    } finally {
      vi.useRealTimers()
    }
  })
})
