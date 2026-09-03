# Upstream PR: fall back to local mode when Git state is unavailable

Drafted 2026-09-03 for `LodyAI/Lody`, against the vendored pin `f3474894`.
It is the contribution that lets BlitzOS drop seam patch 18 in
`vendor/lody/BLITZ-PATCHES.md`.

## Before it is opened

Follow Lody's `.github/AGENTS.md`: open the required Issue and get maintainer
agreement first, preserve the public Context handoff, validate the PR body with
`node .github/scripts/check-pr-body.mjs --body-file <file>`, and use their
`fix: ...` commit convention plus the required `Model:` trailer for AI commits.

## The defect

The chat landing already falls a requested worktree back to local mode when it
cannot load Git state:

```ts
const effectiveWorkdirMode =
  selectedWorkdirMode === 'worktree' && worktreeAvailable ? 'worktree' : 'local';
```

The toggle renders from that effective value and the session payload uses it to
decide whether to set `branch` and `useWorktree`. On a terminal Git-state error,
the visible and persisted session is therefore a direct local-project session.

The Send button and `handleSubmit` contradict that decision. Both inspect the
selected value instead, so a persisted worktree preference plus a failed
`local-project/git-state` request disables the button forever and makes the
keyboard path return without starting a session.

## Reproduction

1. Persist `lody.workdirMode.global=worktree` (or select worktree for a project).
2. Open a local project whose machine is offline or whose Git-state RPC fails.
3. Type a prompt.

The toggle displays the local fallback, but Send stays disabled. Pressing Enter
also does nothing because `handleSubmit` reports
`local_project_git_state_failed` and returns.

## Proposed change

- Keep Send disabled while a requested worktree's Git state is still loading.
- Once the load has terminated with an error, allow Send.
- Remove the matching `handleSubmit` early return and its now-unused analytics
  reason.

No new fallback is introduced: the existing `effectiveWorkdirMode` already
builds a local `ProjectRef`, omits the worktree branch, records `local` in the
preference after a successful start, and renders the toggle off.

## Why it is safe

Healthy paths do not change. Runtime initialization still blocks, worktree
loading still blocks, and a successful Git-state result still dispatches with
`useWorktree: true`. Only a terminal error changes, and that state already has
`effectiveWorkdirMode === 'local'`; the patch makes the two submit gates agree
with the payload they guard.

## Tests

Add a derived-state regression proving that a sendable local prompt with a
selected worktree and a terminal Git-state error is enabled, while the existing
loading test remains disabled. Exercise the submit path far enough to prove it
creates a local-project session rather than returning the removed
`local_project_git_state_failed` reason.
