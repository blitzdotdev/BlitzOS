# Lody v1 scope — the approved record

This file is the durable record of what the vendored Lody surface offers in
BlitzOS v1. The user approved the split. Before this file the record lived
outside the repo, so a reader had no way to check a claim against the tree.

Three sources agree with this file, and each one holds a different half:

- `packages/webapp/src/lody/v1-scope.ts` — the flags, and the props they build.
- `vendor/lody/BLITZ-PATCHES.md` — the seam patches that carry the props into
  the vendored components.
- The 463-row support matrix — the evidence. It grouped every row into 25
  feature areas.

Path roots: `V/` = `vendor/lody/packages/components/src/`,
`W/` = `packages/webapp/src/`.

## 1. The 25 areas, and the call on each

**KEEP 16 areas · KILL 4 areas · DECIDE 5 areas, all five now answered.**

| # | Area | Rows | Call |
|---|---|--:|---|
| 1 | Mount, boot, theme, agent sign-in | 22 | KEEP |
| 2 | Session rail | 29 | KEEP |
| 3 | Rail chrome we do not mount | 11 | KILL |
| 4 | Landing scope selectors | 20 | KEEP |
| 5 | Composer text, drafts, focus | 21 | KEEP |
| 6 | Mentions, slash commands, skills | 25 | KEEP |
| 7 | Attachments | 15 | KEEP |
| 8 | Run configuration | 14 | KEEP |
| 9 | Message queue and steering | 7 | KEEP |
| 10 | Transcript and message actions | 38 | KEEP |
| 11 | Permission requests and questions | 9 | KEEP |
| 12 | Conversation chrome and header menu | 39 | KEEP |
| 13 | Files panel and file viewer | 31 | KEEP |
| 14 | Diffs, changes and Side Chat | 17 | KEEP |
| 15 | Tabs and terminals | 35 | KEEP |
| 16 | Worktrees | 13 | KEEP |
| 17 | Sharing | 20 | KEEP |
| 18 | Electron-only surfaces | 21 | KILL |
| 19 | Command palette and keyboard chords | 9 | HIDE |
| 20 | Settings surface and stub routes | 8 | KILL |
| 21 | GitHub and pull-request flows | 22 | HIDE |
| 22 | Lody-cloud and wrong-product surfaces | 18 | KILL |
| 23 | Mobile | 5 | KEEP (amended, see §5) |
| 24 | Agent Roles and MCP pickers | 8 | HIDE |
| 25 | Deferred v1 items | 6 | Split |

KILL and HIDE differ. A KILL area has no code path to it. A HIDE area has
working code behind a flag, and one line brings it back.

## 2. The five decisions

1. **GitHub and pull requests: HIDE.** BlitzOS connects no GitHub App, so every
   PR flow fails after the button. Upstream's own `githubIntegration` capability
   answers `false` on a local platform, so seam patch 7 makes the surfaces ask.
2. **Settings: KILL the affordances.** BlitzOS serves its own settings. The
   Lody entry points flip an atom that nothing reads.
3. **Agent Roles and MCP: HIDE.** Nothing writes the workspace catalog rows, so
   both pickers are empty by construction.
4. **Command palette and chords: HIDE.** We mount neither `commands.attach`
   nor `CommandPalette`, so no chord reaches a dispatcher.
5. **Deferred v1 items: the archive page ships.** Host-tab drag, split view and
   agent orchestration stay out of v1.

## 3. The flags

`W/lody/v1-scope.ts` holds five flags. All five are `false` in v1.

| Flag | Areas | Mechanism |
|---|---|---|
| `gitHubIntegration` | 21 | Upstream's own platform capability. |
| `agentRolesAndMcp` | 24 | `hideAgentRoles` prop. |
| `keyboardShortcuts` | 19 | `keyboardShortcutsAvailable` prop. |
| `cloudSurfaces` | 22, 25 | `hideCloudMenuItems`, `hideNotificationPrompt`, `hideProductHints`, `hideTeamScope` props. |
| `languageService` | 13 | `hideLanguageServiceActions` prop. |

Two tests keep the areas dark: `packages/webapp/test/lody-v1-scope.test.tsx`
pins the DOM, and `lody-v1-scope-sources.test.ts` pins the wiring.

## 4. The seam patches

An edit inside `vendor/lody` is legal only at a seam declared in
`vendor/lody/BLITZ-PATCHES.md`. Read that file for the hunks. The index:

| # | What it carries |
|---|---|
| 1 | The local-bridge predicate. |
| 2 | `LoroSidebar` header and footer suppression. |
| 3 | The attachment-sender predicate. |
| 4 | The read-only session surface. |
| 5 | Pluggable surface tabs — the terminal strip. |
| 6 | The Side Chat launcher needs an assistant turn. |
| 7 | Host suppression of the v1 scope cuts. |
| 8 | The cloud-token guard must not preempt the local transport. |
| 9 | `SessionList` rows lost the worktree glyph. |
| 10 | The side panel's file surfaces. |
| 11 | The composer's mention chips and the file drill-down. |
| 12 | A landing image has no offline fallback. |
| 13 | `LoroSidebar`'s footer, one entry at a time. |
| 14 | The archive page's v1 scope cuts. |
| 15 | The mobile branch: host tabs and the mobile scope cuts. |

## 5. Amendments

Each amendment carries a date and the change it records.

- **2026-09-01 — the archive page ships (#164).** Area 25 said DECIDE. The
  archive page enters v1 with restore and permanent delete. Seam patch 14 hides
  its My Tasks / All Tasks scope control.
- **2026-09-02 — mobile is IN.** Area 23 said KILL, because both real routes
  dropped the mobile branch. Lody's real phone experience now mounts, scrubbed
  to this scope. A phone gets `MobileWorkspaceStack`, not squeezed desktop UI.
  Seam patch 15 carries the host tabs into the mobile tab sheet and the scope
  cuts into the mobile-only components.
- **2026-09-02 — connection status is Lody-side REMOVED.** BlitzOS chrome owns
  connection status. The Lody indicators and banners go dark on both layouts.
  Branch `lody-connection-status-removal` carries that change.
- **Unchanged.** GitHub and PR flows, the command palette and the two pickers
  stay hidden. A v1 revisit flips one field in `W/lody/v1-scope.ts`.
