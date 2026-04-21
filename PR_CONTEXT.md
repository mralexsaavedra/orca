# PR 3 of 4 — Agent Status: sidebar indicators & hovercard

> Delete this file before pushing the PR. It exists only so reviewers
> (human or agent) can place the change in the context of the larger rollout.

## Position in the rollout

```
main
 └── PR 1 — types + store
      ├── PR 2 — main-process hooks (produces data)
      └── PR 3 (THIS) — sidebar status UI
           └── PR 4 — Agent Dashboard panel
```

Base: `brennanb2025/pr1-agent-status-types`. Retarget to `main` once PR 1
merges. **This PR can land without PR 2** — the sidebar will simply show
nothing new because no explicit status entries exist. It becomes live as
soon as PR 2 is deployed.

This PR is intentionally the smallest visible slice: it polishes the existing
sidebar to consume the agent-status slice and adds a hovercard. No new
top-level panel or route.

## What this PR adds

- `src/renderer/src/components/AgentStateDot.tsx` — shared colored dot
  indicator reused by the sidebar and (later) the dashboard. Exports
  `AgentDotState` and `agentStateLabel`.
- `src/renderer/src/components/sidebar/AgentStatusHover.tsx` — hovercard
  that expands a worktree row to show every agent currently running in it,
  including retained "done" entries (so a just-finished agent doesn't vanish).
- `src/renderer/src/components/sidebar/StatusIndicator.tsx` — accepts
  explicit agent state via the new dot component in addition to the existing
  visual `Status` union.
- `src/renderer/src/components/sidebar/WorktreeCard.tsx` /
  `WorktreeList.tsx` — wire the hovercard and the dot into the row.
- `src/renderer/src/components/sidebar/smart-sort.ts` (+ test) — adds an
  "agents running" signal to the sort so hot worktrees float to the top.
- `src/renderer/src/components/sidebar/visible-worktrees.ts` — honors
  agent-activity when deciding which worktrees to keep mounted.
- `src/renderer/src/lib/agent-catalog.tsx` — agent icon mapping used by the
  hovercard (and reused by the dashboard in PR 4).

## Deliberately out of scope

- No Agent Dashboard panel — PR 4.
- No changes to the main-process hook pipeline — PR 2 owns that. If you see
  no data in the sidebar locally, that's expected without PR 2 deployed.
- Title-based detection logic is unchanged — this PR only adds the explicit
  path alongside it.

## Review focus

- Hovercard open/close semantics — does it survive the pointer moving from
  row to card? Does it dismiss on Escape / scroll?
- Smart-sort stability: introducing the new signal shouldn't make the list
  jitter every time a status event arrives.
- Color/a11y of `AgentStateDot` — four states, distinguishable without
  color alone (label + tooltip).
- Performance: `WorktreeCard` rerender frequency under a burst of status
  events (use React devtools Highlight Updates).

## How to verify locally

```
pnpm install
pnpm tc
pnpm test src/renderer/src/components/sidebar/smart-sort.test.ts
pnpm dev
```
Without PR 2, explicit status won't populate — you can seed the store by
hand in devtools to exercise the UI:
```js
useAppStore.setState((s) => ({
  agentStatusByPaneKey: {
    ...s.agentStatusByPaneKey,
    'some-tab-id:0': {
      agentType: 'claude', state: 'working', updatedAt: Date.now(),
      worktreeId: '<wt-id>', tabId: 'some-tab-id', paneId: 0, history: []
    }
  }
}))
```
