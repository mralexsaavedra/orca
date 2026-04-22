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

test.describe('Terminal attention (restart)', () => {
  // Why: the end-to-end reproduction of the user's reported bug. A restored
  // Claude tab emits its idle title first (preserved by the store's
  // persistence layer — clearTransientTerminalState keeps *idle* agent
  // titles across hydration) and then its post-reattach repaint loop, which
  // includes BEL bytes. Without pty-connection seeding paneIsInAgentMode
  // from the persisted title at connect time, those BELs mark the tab
  // unread on every tab-switch after restart — an undismissable indicator.
  test('a restored Claude-like tab with BEL noise does not produce an undismissable bell', async (// oxlint-disable-next-line no-empty-pattern -- Playwright restart sessions do not use the shared fixtures.
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

      // Daemon-backed terminals survive restart via createOrAttach. Non-daemon
      // tabs cold-spawn fresh on relaunch and don't exercise the reattach path.
      await enableTerminalDaemon(firstLaunch.page)
      // Why: give the daemon a moment to finish initializing before spawning a
      // new tab. Without this, createTerminalTab can race the daemon's
      // readiness and discoverActivePtyId below can't locate the PTY.
      await firstLaunch.page.waitForTimeout(500)
      const agentTabId = await createTerminalTab(firstLaunch.page, worktreeId)
      await waitForActiveTerminalManager(firstLaunch.page, 30_000)
      const agentTabPtyId = await discoverActivePtyId(firstLaunch.page)

      // Park the daemon-backed tab in "Claude idle" — the agent title is what
      // clearTransientTerminalState will preserve across restart.
      await execInTerminal(
        firstLaunch.page,
        agentTabPtyId,
        `node -e "process.stdout.write('\\u001b]0;* Claude done\\u0007')"`
      )
      await expect
        .poll(
          async () =>
            (await getWorktreeTabs(firstLaunch.page, worktreeId)).some(
              (tab) => tab.id === agentTabId && /Claude done/.test(tab.title ?? '')
            ),
          {
            timeout: 10_000,
            message: 'Agent tab did not pick up the idle title before restart'
          }
        )
        .toBe(true)

      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)

      const restoredTabs = await getWorktreeTabs(secondLaunch.page, worktreeId)
      const restoredAgentTab = restoredTabs.find((tab) => tab.id === agentTabId)
      if (!restoredAgentTab) {
        throw new Error('Agent tab did not survive restart')
      }

      // Activate the agent tab once so reconnect finishes, then move focus
      // away so the agent tab is unfocused — the exact trigger condition
      // the user reported ("switch away from the Claude tab and the bell
      // comes back").
      await activateTerminalTab(secondLaunch.page, agentTabId)
      await waitForActiveTerminalManager(secondLaunch.page, 30_000)
      const firstNonAgentTabId = restoredTabs.find((tab) => tab.id !== agentTabId)?.id
      if (!firstNonAgentTabId) {
        throw new Error(
          'Expected at least one non-agent tab in the restored session for focus-away'
        )
      }
      await activateTerminalTab(secondLaunch.page, firstNonAgentTabId)

      // Emit raw BEL bytes into every PTY the restored agent tab owns. This
      // mirrors what Claude Code's reattach-repaint stream would look like
      // (continuous BEL emission interleaved with draw bytes). Writing
      // directly to pty.write — instead of running `node -e` via a shell —
      // avoids the restored TUI swallowing our command at its input prompt.
      const agentPtyIds = await secondLaunch.page.evaluate((tabId) => {
        const store = window.__store
        if (!store) {
          return [] as string[]
        }
        return store.getState().ptyIdsByTabId[tabId] ?? []
      }, agentTabId)
      if (agentPtyIds.length === 0) {
        throw new Error('Restored agent tab has no PTY ids to write BEL into')
      }
      await secondLaunch.page.evaluate((ids) => {
        for (const id of ids) {
          for (let i = 0; i < 10; i++) {
            window.api.pty.write(id, '')
          }
        }
      }, agentPtyIds)

      await secondLaunch.page.waitForTimeout(1500)

      const agentTabBell = secondLaunch.page
        .locator(
          `[data-testid="sortable-tab"][data-tab-id="${agentTabId}"] [data-testid="tab-activity-bell"]`
        )
        .first()
      await expect(agentTabBell).toBeHidden()
      await expect
        .poll(async () => (await getUnreadTerminalTabIds(secondLaunch.page)).includes(agentTabId), {
          timeout: 2_000,
          message: 'Restored agent tab was marked unread by post-reattach BEL noise'
        })
        .toBe(false)

      // Switching between tabs repeatedly must not cause the bell to appear
      // either. This mirrors the user's literal reproduction ("move back and
      // forth between tabs … it never goes away").
      for (let i = 0; i < 3; i++) {
        await activateTerminalTab(secondLaunch.page, agentTabId)
        await activateTerminalTab(secondLaunch.page, firstNonAgentTabId)
      }
      await secondLaunch.page.waitForTimeout(500)
      await expect(agentTabBell).toBeHidden()
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
