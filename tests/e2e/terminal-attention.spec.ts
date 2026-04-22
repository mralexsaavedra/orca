import { readFileSync, existsSync } from 'fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { createRestartSession, attachRepoAndOpenTerminal } from './helpers/orca-restart'
import {
  discoverActivePtyId,
  execInTerminal,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  getWorktreeTabs,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'

test.describe.configure({ mode: 'serial' })

async function createTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('createTerminalTab: window.__store is unavailable')
    }

    const state = store.getState()
    const newTab = state.createTab(targetWorktreeId)
    state.setActiveTabType('terminal')
    return newTab.id
  }, worktreeId)

  await expect
    .poll(async () => (await getWorktreeTabs(page, worktreeId)).some((tab) => tab.id === tabId), {
      timeout: 5_000,
      message: `Terminal tab ${tabId} was not created`
    })
    .toBe(true)

  return tabId
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('activateTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    state.setActiveTabType('terminal')
    state.setActiveTab(targetTabId)
  }, tabId)

  await expect
    .poll(async () => getActiveTabId(page), {
      timeout: 5_000,
      message: `Terminal tab ${tabId} did not become active`
    })
    .toBe(tabId)
}

async function emitTerminalBell(page: Page, ptyId: string): Promise<void> {
  // Why: `node -e process.stdout.write('\u0007')` emits BEL as PTY output on
  // every platform Orca supports. Writing a raw Ctrl+G input character would
  // depend on shell readline behavior, which differs across bash/zsh/PowerShell.
  await execInTerminal(page, ptyId, `node -e "process.stdout.write('\\u0007')"`)
}

async function emitAgentLikeTitleChurn(page: Page, ptyId: string): Promise<void> {
  // Why: the restore regression came from replayed OSC title history mutating
  // the agent tracker during attach. Emit one working and one idle title using
  // Node so the sequence is shell-agnostic across macOS/Linux/Windows.
  await execInTerminal(
    page,
    ptyId,
    `node -e "process.stdout.write('\\u001b]0;. Claude working\\u0007');process.stdout.write('\\u001b]0;* Claude done\\u0007')"`
  )
}

async function getUnreadTerminalTabIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return []
    }
    return Object.keys(store.getState().unreadTerminalTabs)
  })
}

async function isWorktreeUnread(page: Page, worktreeId: string): Promise<boolean> {
  return page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      return false
    }
    const worktrees = Object.values(store.getState().worktreesByRepo).flat()
    return worktrees.find((worktree) => worktree.id === targetWorktreeId)?.isUnread === true
  }, worktreeId)
}

async function enableTerminalDaemon(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('enableTerminalDaemon: window.__store is unavailable')
    }
    await store.getState().updateSettings({ experimentalTerminalDaemon: true })
  })

  await expect
    .poll(
      async () =>
        page.evaluate(
          () => window.__store?.getState().settings?.experimentalTerminalDaemon === true
        ),
      {
        timeout: 10_000,
        message: 'experimentalTerminalDaemon was not enabled'
      }
    )
    .toBe(true)
}

async function bootstrapRestoredLaunch(page: Page, expectedWorktreeId: string): Promise<void> {
  await waitForSessionReady(page)
  await expect
    .poll(async () => getActiveWorktreeId(page), {
      timeout: 10_000,
      message: 'Restored launch did not reactivate the expected worktree'
    })
    .toBe(expectedWorktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
}

test.describe('Terminal attention', () => {
  test('a bell marks a background tab unread and clears on focus', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const firstTabId = await getActiveTabId(orcaPage)
    if (!firstTabId) {
      throw new Error('Expected an initial terminal tab')
    }

    const secondTabId = await createTerminalTab(orcaPage, worktreeId)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const secondTabPtyId = await discoverActivePtyId(orcaPage)

    await activateTerminalTab(orcaPage, firstTabId)
    // Why: the transport arms a 2s grace window on reattach that suppresses
    // BEL so a replayed completion bell from a prior session can't manufacture
    // phantom unread marks. Wait past that window before emitting a fresh
    // bell so the test exercises the normal live-bell path, not the
    // grace-window suppression path. The grace-window behavior itself is
    // verified by the transport unit tests.
    await orcaPage.waitForTimeout(2500)

    await emitTerminalBell(orcaPage, secondTabPtyId)

    await expect
      .poll(async () => (await getUnreadTerminalTabIds(orcaPage)).includes(secondTabId), {
        timeout: 10_000,
        message: 'Background tab did not become unread after BEL'
      })
      .toBe(true)

    const secondTabBell = orcaPage
      .locator(
        `[data-testid="sortable-tab"][data-tab-id="${secondTabId}"] [data-testid="tab-activity-bell"]`
      )
      .first()
    await expect(secondTabBell).toBeVisible()

    await activateTerminalTab(orcaPage, secondTabId)

    await expect
      .poll(async () => (await getUnreadTerminalTabIds(orcaPage)).includes(secondTabId), {
        timeout: 5_000,
        message: 'Unread tab state did not clear when the user focused the tab'
      })
      .toBe(false)
    await expect(secondTabBell).toBeHidden()
  })

  test('restore does not manufacture unread attention from replayed terminal titles', async (// oxlint-disable-next-line no-empty-pattern -- Playwright restart sessions do not use the shared fixtures.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const worktreeId = await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
      await waitForSessionReady(firstLaunch.page)
      await waitForActiveWorktree(firstLaunch.page)
      await ensureTerminalVisible(firstLaunch.page)
      await waitForActiveTerminalManager(firstLaunch.page, 30_000)

      await enableTerminalDaemon(firstLaunch.page)
      const daemonTabId = await createTerminalTab(firstLaunch.page, worktreeId)
      await waitForActiveTerminalManager(firstLaunch.page, 30_000)
      const daemonTabPtyId = await discoverActivePtyId(firstLaunch.page)

      await emitAgentLikeTitleChurn(firstLaunch.page, daemonTabPtyId)
      await expect
        .poll(
          async () =>
            (await getWorktreeTabs(firstLaunch.page, worktreeId)).some(
              (tab) => tab.id === daemonTabId && /Claude done/.test(tab.title ?? '')
            ),
          {
            timeout: 10_000,
            message: 'Daemon-backed tab did not observe the synthetic agent title churn'
          }
        )
        .toBe(true)

      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)

      await expect
        .poll(async () => await getUnreadTerminalTabIds(secondLaunch.page), {
          timeout: 10_000,
          message: 'Restore created unread terminal attention with no new BEL'
        })
        .toEqual([])
      await expect
        .poll(async () => await isWorktreeUnread(secondLaunch.page, worktreeId), {
          timeout: 10_000,
          message: 'Restore marked the worktree unread with no new BEL'
        })
        .toBe(false)
      await expect(secondLaunch.page.locator('[data-testid="tab-activity-bell"]')).toHaveCount(0)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      session.dispose()
    }
  })

  // Why: the bug this guards against is Claude completion → BEL → Cmd+Q →
  // relaunch producing a phantom unread dot on a tab the user never saw ring.
  // The daemon keeps the BEL in its catch-up buffer and streams it after
  // reattach; without the transport's grace window covering BEL, the tab gets
  // re-marked on every launch and tab-clicks cannot clear it permanently.
  test('restore does not manufacture unread attention from a pre-shutdown BEL', async (// oxlint-disable-next-line no-empty-pattern -- Playwright restart sessions do not use the shared fixtures.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const worktreeId = await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
      await waitForSessionReady(firstLaunch.page)
      await waitForActiveWorktree(firstLaunch.page)
      await ensureTerminalVisible(firstLaunch.page)
      await waitForActiveTerminalManager(firstLaunch.page, 30_000)

      // Daemon-backed terminals route through the reattach path on relaunch
      // (connect({sessionId}) returning isReattach), which is the code path
      // this test exercises. Non-daemon terminals cold-spawn fresh and don't
      // replay any buffered BEL.
      await enableTerminalDaemon(firstLaunch.page)
      const daemonTabId = await createTerminalTab(firstLaunch.page, worktreeId)
      await waitForActiveTerminalManager(firstLaunch.page, 30_000)
      const daemonTabPtyId = await discoverActivePtyId(firstLaunch.page)

      // Focus a different tab so the BEL legitimately marks the daemon tab
      // unread in the first session — markTerminalTabUnread no-ops on the
      // focused tab. Without this, the BEL would be suppressed in-session and
      // there'd be nothing for the daemon to replay.
      const originalTabId = await firstLaunch.page.evaluate(() => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is unavailable')
        }
        const activeWorktreeId = store.getState().activeWorktreeId
        if (!activeWorktreeId) {
          return null
        }
        const tabs = store.getState().tabsByWorktree[activeWorktreeId] ?? []
        return tabs[0]?.id ?? null
      })
      if (!originalTabId || originalTabId === daemonTabId) {
        throw new Error(
          'Expected a non-daemon tab to exist so we can focus away from the daemon tab'
        )
      }
      await activateTerminalTab(firstLaunch.page, originalTabId)

      await emitTerminalBell(firstLaunch.page, daemonTabPtyId)
      await expect
        .poll(async () => (await getUnreadTerminalTabIds(firstLaunch.page)).includes(daemonTabId), {
          timeout: 10_000,
          message: 'Daemon-backed tab did not record the pre-shutdown BEL as unread'
        })
        .toBe(true)

      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)

      // After restart, no tab should be flagged. The pre-shutdown unread is
      // transient UI state and is not persisted, and the replayed catch-up
      // BEL must not re-raise it.
      await expect
        .poll(async () => await getUnreadTerminalTabIds(secondLaunch.page), {
          timeout: 10_000,
          message: 'Restore manufactured unread attention from the replayed catch-up BEL'
        })
        .toEqual([])
      await expect
        .poll(async () => await isWorktreeUnread(secondLaunch.page, worktreeId), {
          timeout: 10_000,
          message: 'Restore marked the worktree unread from the replayed catch-up BEL'
        })
        .toBe(false)
      await expect(secondLaunch.page.locator('[data-testid="tab-activity-bell"]')).toHaveCount(0)

      // Why: the bug's signature was "the dot comes back every time I
      // relaunch". Once the grace window closes (2s), no further phantom
      // unread should appear either.
      await secondLaunch.page.waitForTimeout(3000)
      await expect
        .poll(async () => await getUnreadTerminalTabIds(secondLaunch.page), {
          timeout: 5_000,
          message: 'Phantom unread attention appeared after the reattach grace window expired'
        })
        .toEqual([])
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      session.dispose()
    }
  })
})
