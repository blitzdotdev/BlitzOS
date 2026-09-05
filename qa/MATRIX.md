# Lody feature test matrix — BlitzOS mount

This matrix is the successor to the scratchpad v1 matrix. Do not renumber row
IDs. Move dead rows to the Retired section so baseline keys stay stable.

Every user-reachable feature of the vendored Lody UI, mapped to how a real-browser
sweep agent can test it against canary. Ordered by user journey, not by file.

Updated 2026-09-02 from the 2026-09-01 matrix. Verified against
`origin/main` at `64a09890` after the 32 commits in `ac06561b..origin/main`.
The checked-out worktree was not changed.

## 0. How to read this

**Path roots.** Every source citation is relative to the verified tree.

- `V/` = `/workspace/BlitzOS-box-image/vendor/lody/packages/components/src/`
- `W/` = `/workspace/BlitzOS-box-image/packages/webapp/src/`
- `B/` = `/workspace/BlitzOS-box-image/packages/box/`
- `CP/` = `/workspace/BlitzOS-box-image/packages/control-plane/`

Plans are `/workspace/BlitzOS-box-image/plans/`. The seam manual is
`/workspace/BlitzOS-box-image/vendor/lody/BLITZ-PATCHES.md`.

**Testability classes.** The Class column follows `plans/LODY-V1-SCOPE.md`:
controls in KILL or HIDE areas are `EXCLUDED`; an absence owned by BlitzOS, such
as Lody connection chrome, remains a reachable `HEADLESS` expectation.

| Class | Meaning |
|---|---|
| `HEADLESS` | Real Chromium over CDP against canary, D1-minted session. No agent turn needed. |
| `HEADLESS+PROMPT` | Needs a real prompt dispatched to an agent. QA workspace with Claude signed in on the box. |
| `SECOND-ACCOUNT` | Needs two workspace members (grant RO, grant RW, revoke, admin implicit view, co-driver answer). |
| `HUMAN-EYES` | Visual/UX judgement, a real pointer gesture, or a third-party popup a headless run cannot finish. |
| `ELECTRON-N/A` | Upstream Electron-only, structurally unreachable in our mount. The gate is cited. |
| `EXCLUDED` | Deliberately out of BlitzOS v1 scope, or unreachable because our router stubs it. Reason cited. |

**Status flags in Notes.**

- `[FIXED] #n` — merged PR `#n` changed the expectation after the v1 baseline.
- `[TESTED]` — a `packages/webapp/test/lody-*.test.*` file pins it.
- `[SEAM n]` — our mount diverges from upstream on purpose; current tree has seams 1–17.
- `[CORRECTED]` — sweep evidence or a user ruling corrected the v1 row without a product change.
- `[NEVER RUN]` — no evidence it has ever been exercised on canary.

**The mount, in one paragraph, because it decides half the classes below.**
Three vendored routes are real: chat landing, session detail, and archive.
Desktop mounts the landing/detail leaves directly. Below Lody's 768 px breakpoint,
`MobileSessionStack` keeps the landing mounted and layers detail as a real mobile
drawer. The twenty vendored settings routes and the remaining addresses are empty
stubs. Lody's `__root.tsx`, `_auth.tsx`, and `MainLayout` remain unmounted, so its
command palette, global dispatcher, Electron menu, terminal dock, OneSignal,
PostHog, stuck-connection banner, and settings modal do not exist here. BlitzOS
owns settings, organization switching, connectivity, navigation, and machine
lifecycle outside the vendored surface.

---

## 1. Landing and entry

| # | Feature | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| L1 | Lody chunk loads at all | `W/lody/LodySessionsRegion.tsx` — open a workspace with the flag on | The renderer lazy-loads only when the rail or surface asks for it, then stays cached. | HEADLESS | `[TESTED]` `lody-lazy-boundary.test.ts` |
| L2 | Box capability probe | `W/lody/box-capability.ts` — open a workspace on a pre-Lody image | `present` mounts Lody; `absent` keeps the rail notice and never resurrects the deleted native strip. | HEADLESS | `[FIXED] #159`; `[FIXED] #170`; `[TESTED]` `lody-old-box-fallback.test.tsx` |
| L3 | "Sessions need a newer machine" notice | `W/shell/SessionRail.tsx` (`.rail-notice`) — a member with no machine here | A sentence plus "Recreate", not a stuck connection state or legacy strip. | HEADLESS | `[FIXED] #159`; `[FIXED] #170` |
| L4 | Chat landing renders | `V/components/chat/chat-landing.tsx:6499` — go to the chat address | Hero, context switch and composer paint; never blank. | HEADLESS | `[FIXED]` `e58f1531`; `[TESTED]` `lody-landing-heading.ts` |
| L5 | Agent-config gate | `W/lody/agent-config-gate.tsx:30` — first mount | The landing is held until the daemon holds the config rows; it opens anyway if the bootstrap throws. | HEADLESS | `[TESTED]` `lody-session-surface.test.tsx` |
| L6 | Default `/workspace` project seeded | `W/lody/workdir-default.ts` — create a session with no repo | A projectless chat runs in `/workspace`, cuts no worktree, relative file chips resolve. | HEADLESS+PROMPT | `[FIXED]` `9127dbbb`; `[TESTED]` `lody-session-workdir.test.ts` |
| L7 | Backfill onto pre-existing sessions | `W/lody/use-session-project-backfill.ts:1` — open a session created before L6 | The project is attached on OPEN; Files and All Changes stop refusing. | HEADLESS | `[FIXED]` `46c68da9` |
| L8 | Toaster mounted | `W/lody/surface-providers.tsx:65` — trigger any vendored `toast.error` | A vendored refusal reaches the member instead of being swallowed. | HEADLESS | `[FIXED]` `febf800c`; `[TESTED]` `lody-toaster.test.tsx` |
| L9 | Agent-auth banner | `W/lody/agent-auth-notice.tsx:52` — send a turn with Claude signed out | A band above the chat says the agent is signed out, and carries its sign-in panel. | HEADLESS+PROMPT | `[FIXED]` `3ea3a251` scopes it to chat surfaces |
| L10 | ACP sign-in: start | `V/components/settings/acp-authentication-panel.tsx:441`, `window.open` at `:445` | The daemon runs `claude auth login --claudeai`; a popup carries the authorization URL. | HUMAN-EYES | Browser popup — allow popups. `[TESTED]` `lody-acp-authentication.test.ts` |
| L11 | ACP sign-in: paste the code | same panel, device-code copy `:353` | The code reaches the blocked login; the agent becomes usable. | HUMAN-EYES | Needs the npm patch `lody-acp-auth-queue.mjs`, else 285 s deadlock |
| L12 | First turn after sign-in | `W/lody/session-auth-recovery.ts:1` | The phantom `acpSessionId` is dropped, so the turn produces output. | HEADLESS+PROMPT | `[TESTED]` `lody-post-signin-turn.test.ts` |
| L13 | Theme adopted from the shell | `W/lody/blitz-theme.ts:378` — load in dark and in light | The surface never disagrees with the shell; no flash of the vendored palette. | HUMAN-EYES | `[TESTED]` `lody-theme-race.test.tsx` |
| L14 | Surface hidden, not unmounted within a workspace | `W/lody/SessionSurface.tsx` — switch between chat and a host tab | The active workspace keeps its WebSocket, IndexedDB repo, WASM state, draft, and terminal body mounted. | HEADLESS | Workspace changes deliberately tear down the old bridge; see L19. |
| L15 | Landing crash fallback | `V/components/chat/chat-landing-view.tsx:366` (raw textarea), retry `:401` | A composer crash shows the draft in a bare textarea plus "Try again". | HEADLESS | Force with a malformed search param |
| L16 | BlitzOS footer: box unreachable | `W/shell/workspace-status-line.ts`; `W/box-gateway-health.ts` | A running workspace whose gateway fails reads `workspace running · box unreachable`; recovery clears the suffix. | HEADLESS | `[FIXED] #155`; `[TESTED]` |
| L17 | Surface load failure never blanks the shell | `W/lody/SurfaceLoadBoundary.tsx` and lazy mount | A rejected Lody chunk shows an actionable retry/fallback while the shell rail and workspace controls remain usable. | HEADLESS | `[FIXED] #155`; `[TESTED]` |
| L18 | Sessions arrive without a page reload | `W/lody/LodySessionsRegion.tsx`; runtime remount key | A newly provisioned or newly capable workspace transitions from retry/probe state into live Lody in place. | HEADLESS | `[FIXED] #170`; `[TESTED]` |
| L19 | Workspace switch hands off the local bridge | `W/lody/LodySessionsRegion.tsx`; surface runtime cleanup | Switching workspaces disposes only the old runtime/bridge, mounts the selected workspace, and leaves no stale listener owning `window.ipc`. | HEADLESS | `[FIXED] #179`; `[TESTED]` |
| L20 | Workspace switch restores selected chat position | `W/lody/router.tsx`; runtime snapshot reset | Returning to a workspace restores its remembered chat/session address; no stale implicit local workspace id overrides selection. | HEADLESS | `[FIXED] #179`; `[FIXED] #181`; `[SEAM 17]`; `[TESTED]` |
| L21 | Tunnel waits for fresh delivered tokens | `B/rootfs/usr/local/libexec/blitz-*`; marker `/var/lib/blitz/tokens-ready` | Bootstrap removes a stale marker; the running instance writes it only after fresh tokens arrive; cloudflared waits. | HEADLESS | `[FIXED] #169`; `[FIXED] #172`; `[TESTED]` |
| L22 | Box watchdog recovers a wedged Lody daemon | box s6 watchdog and daemon `/healthz` | After three failed 10-second probes on the 60-second cadence, the daemon restarts; startup grace prevents a loop. | HEADLESS | `[FIXED] #167`; `[FIXED] #178`; `[TESTED]` |

*Section tally: HEADLESS 16 · +PROMPT 3 · HUMAN-EYES 3 · total 22.*

---

## 2. Rail (session list)

| # | Feature | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| R1 | GitHub Worktrees section | `W/lody/SessionRailSidebar.tsx` | A heading per repo, with repo-backed sessions grouped under it even if the repo registry arrived late. | HEADLESS | `[FIXED] #157`; `[TESTED]` `lody-rail-groups.test.tsx` |
| R2 | Chats section | `W/lody/SessionRailSidebar.tsx:393` | Repo-less sessions under "Chats". | HEADLESS | |
| R3 | Terminals section | `W/lody/SessionRailSidebar.tsx:426` | Native rows for `webapp_state` tabs under their header. | HEADLESS | Ours, not vendored |
| R4 | "Shared with you" section | `W/lody/SessionRailSidebar.tsx:409` | One row per received grant, RO/RW badge. | SECOND-ACCOUNT | `[TESTED]` `lody-shared-rail.test.tsx` |
| R5 | Section collapse | `W/lody/SessionRailSidebar.tsx` | Chats, Shared, Terminals, and repository sections fold without deleting their clickable headings. | HEADLESS | `[FIXED] #157`; `[TESTED]` `lody-rail-groups.test.tsx` |
| R6 | Per-repo collapse | `W/lody/SessionRailSidebar.tsx` | Only that repo's sessions fold; the heading remains available to reopen it. | HEADLESS | `[FIXED] #157`; `[TESTED]` `lody-rail-groups.test.tsx` |
| R7 | Session row click opens the session | `W/lody/SessionRailSidebar.tsx:344`; row `V/components/session-list.tsx:929` | The detail page opens AND the shell address moves. | HEADLESS | `[FIXED]` dogfood 3; `LODY_BUGS.md` item 1 |
| R8 | "+ New session" | `W/lody/SessionRailSidebar.tsx:464` | The landing opens with an EMPTY composer, even when already on it. | HEADLESS | `[FIXED]` `e58f1531`; `LODY_BUGS.md` items 2-3 |
| R9 | Row context menu: Rename | `V/components/session-list.tsx:1091` | Inline rename; title persists to the session doc. | HEADLESS | |
| R10 | Row context menu: Pin / Unpin | `V/components/session-list.tsx:1101` | The row moves to the Pinned group; the glyph flips. | HEADLESS | |
| R11 | Row context menu: Archive | `V/components/session-list.tsx:1111` | The session leaves the rail; its worktree gets a backup commit. | HEADLESS | Depends on `W/lody/local-projects.ts`'s Flock mirror |
| R12 | Row inline archive (two-stage) | `V/components/session-list.tsx:1033` → `V/components/sidebar-confirm-archive-button.tsx:124` | Hover, click, the button morphs into "Confirm"; blur cancels (`:98`). | HEADLESS | |
| R13 | Row "⋯" opens the context menu | `V/components/sidebar-row-shared.tsx:508` | A synthesized `contextmenu` event opens the same menu from a left click. | HEADLESS | |
| R14 | Row context menu: Share | `V/components/session-list.tsx:1135` | Opens the BlitzOS share dialog (`W/SessionShareDialog.tsx:56`). | SECOND-ACCOUNT | `[SEAM-free]` two props, no vendor hunk (LODY-SHARING §9 row 1) |
| R15 | Row context menu: Copy branch | `V/components/session-list.tsx:1158` | The branch name lands on the clipboard. | HEADLESS | Only renders with `session.branchName` |
| R16 | Row context menu: Open Pull Request | `V/components/session-list.tsx:1068` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| R17 | Row context menu: Copy Session URL | `V/components/session-list.tsx:1125` | — | EXCLUDED | `onCopySessionUrl` not passed; our address is not Lody's URL |
| R18 | Row context menu: Go to Opener Session | `V/components/sidebar-row-shared.tsx:377` | Navigates to the session that spawned this one. | HEADLESS+PROMPT | Needs a fork or an agent-created child |
| R19 | Opened-by disclosure tree | `V/components/sidebar-row-shared.tsx:448` | Child sessions indent under their opener; status outranks the tree glyph. | HEADLESS | |
| R20 | Row status indicator (unread / working / awaiting permission) | `V/components/sidebar-row-shared.tsx:122`, used `:528` | Dot, spinner, or a distinct waiting state. | HEADLESS+PROMPT | The spinner/dot are `text-primary`/`bg-primary`, repainted by `W/lody/blitz-skin.css` |
| R21 | Row diff stats `+n -n` | `V/components/session-list.tsx:1020` | Line counts after an editing turn. | HEADLESS+PROMPT | Skipped entirely when `githubRepoFullName` is missing (BLITZ-PATCHES) |
| R22 | Session hover info card | `V/components/session-info-hover-card.tsx:274` | Author, repo, folder, machine, branch-or-worktree, changes, PR + CI. | HUMAN-EYES | Hover-only |
| R23 | Hover card: copy a field | `V/components/session-info-hover-card.tsx:132` | Copies branch/repo/path, with "Copied" feedback (`:275`). | HEADLESS | |
| R24 | Rail highlight follows the address | `W/lody/SessionRailSidebar.tsx:330,339` | Exactly one row is highlighted, and it is the one the address names. | HEADLESS | `[FIXED]` `3ea3a251` (ADJ1) |
| R25 | Sidebar header suppressed; footer scoped | `W/lody/SessionRailSidebar.tsx` | No second workspace header or settings/help links; the approved Archive footer entry remains. | HEADLESS | `[FIXED] #164`; `[SEAM 2]`; `[SEAM 13]` |
| R26 | Rail width pinned to the shell grid | `W/lody/SessionRailSidebar.tsx:57,458-460` | Resizes with the shell, not with Lody's inline width. | HUMAN-EYES | |
| R27 | Repo group drag-reorder | `V/components/session-list.tsx` (dnd-kit) | Dragging a repo heading changes the per-workspace persisted order. | HEADLESS | `[FIXED] #157`; `[TESTED]` `lody-rail-groups.test.tsx` |
| R28 | Show more / Show less in a group | `V/components/session-list.tsx:1259` | Toggles between the latest-N preview and the full group. | HEADLESS | |
| R29 | "+" on a repo group heading | `V/components/session-list.tsx` | Opens the landing so the member can pick that repository; no inert hover control. | HEADLESS | `[FIXED] #157`; `[TESTED]` `lody-rail-groups.test.tsx` |
| R30 | Drag a rail row into the composer | `V/lib/session-mention-drag.ts` → `V/components/sessions/session-mention-drop-layer.tsx:14` | Every desktop row is a drag source; dropping writes a real `@session` mention. | HEADLESS | Both ends are mounted here |
| R31 | Sidebar organize / filter popover | `V/components/sidebar-filter-popover.tsx:127` | Organize (Workspace/Updated) + Show (My/All Tasks). | EXCLUDED | Desktop trigger lives in the suppressed header; mobile one in the suppressed footer (BLITZ-PATCHES seam 2) |
| R32 | "Updated" mode (recency buckets) | `V/components/sidebar-updated-session-list.tsx:559` | A flat, recency-bucketed list. | EXCLUDED | Unreachable without R31 |
| R33 | Workspace switcher / create / invite / connect repo | `V/components/loro-sidebar.tsx:936,956,960,964` | — | EXCLUDED | Suppressed header (`hideHeader`) |
| R34 | Footer: Archive | `V/components/loro-sidebar.tsx`; host `W/lody/SessionRailSidebar.tsx` | Exactly one vendored footer item remains; it opens the real Archive page and highlights the archive address. | HEADLESS | `[FIXED] #164`; `[SEAM 13]`; `[SEAM 14]`; `[TESTED]` |
| R35 | Local Projects sidebar section (+ import, + remove) | `V/components/loro-app-sidebar.tsx:2093,2131,1121` | — | EXCLUDED | We mount `LoroSidebar`, not `LoroAppSidebar`; our rail has no such section |
| R36 | Electron update banner | `V/components/sidebar-update-banner.tsx:71` | — | ELECTRON-N/A | Relies on the Electron updater (`hooks/use-electron-updater-state.ts:9`) |
| R37 | Tasks nav / new task | `V/components/loro-sidebar.tsx:1028,1035` | — | EXCLUDED | Tasks routes are stubs (`W/lody/router.tsx:362-376`) |
| R38 | Lody connection and sync pill is absent | `V/components/loro-sidebar.tsx` | No Lody "Syncing", "Reconnecting", or "Offline" pill appears; the BlitzOS workspace footer owns reachability. | HEADLESS | `[FIXED] #173`; `[SEAM 2]`; `[SEAM 15]`; `[TESTED]` |
| R39 | Sidebar keyboard nav (j/k, arrows) | `V/hooks/use-keyboard-navigation.ts:205` | Arrow traversal with a focus ring. | EXCLUDED | Registered as commands; no dispatcher is mounted (see X3) |
| R40 | Machine-type change keeps workspace in the rail | shell workspace filtering during destructive transition | A workspace remains visible and selected while its machine reports destroying/destroyed for a type change. | HEADLESS | `[FIXED] #161`; `[TESTED]` |
| R41 | Rail organization mark is absent | BlitzOS workspace strip and Lody rail header suppression | No organization badge/divider consumes rail space; organization switching lives in Settings → Profile. | HEADLESS | `[FIXED] #150`; `[FIXED] #162`; `[TESTED]` |

*Section tally: HEADLESS 25 · +PROMPT 3 · SECOND-ACCOUNT 2 · HUMAN-EYES 2 · ELECTRON-N/A 1 · EXCLUDED 8 · total 41.*

---

## 3. Session create (landing context)

| # | Feature | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| S1 | Context switch (Local / GitHub / Chat) | `V/components/chat/context-switch.tsx:91,105,109` | Switching context re-scopes the project and branch pickers. | HEADLESS | `github` is unreachable with no cloud repo list |
| S2 | Selection mirrored into the address | `W/lody/router.tsx` | `?machine`, `?project`, and `?repo` update with `replace` through memory-history search changes. | HEADLESS | `[CORRECTED]` sweep S2 was refuted; expectation stands. |
| S3 | Draft survives a tab switch | `W/lody/TerminalTabsStrip.tsx` and `W/lody/MobileSessionStack.tsx` | The landing stays mounted under desktop host tabs and the mobile session drawer; the unsent draft stays. | HEADLESS | `[FIXED] #171`; `[SEAM 16]` |
| S4 | `resetDraftKey` clears the draft | `W/lody/SessionSurface.tsx:396` | Prompt, attachments and draft session id all clear. | HEADLESS | `[FIXED]` `e58f1531` |
| S5 | Submit creates a session and navigates | `V/components/chat/chat-landing.tsx:2895` | A session doc is created, the rail gains a row, the surface moves to detail. | HEADLESS+PROMPT | The create is free; the reply is the paid part |
| S6 | Submit refused with no agent config | `V/components/chat/chat-landing.tsx:2922` | "Choose an agent before starting". | HEADLESS | Should be unreachable now — L5's gate closes the window |
| S7 | No-machine Lody product hint band | `V/components/chat/chat-landing.tsx` | — | EXCLUDED | Hidden by `hideProductHints`; wrong-product download/report/settings/Discord surface. `[FIXED] #151` `[SEAM 7]` `[SEAM 16]` |
| S8 | Hint → "Report bug" | `V/components/chat/chat-landing.tsx` | — | EXCLUDED | Hidden with S7 by approved `cloudSurfaces=false`. `[FIXED] #151` `[SEAM 7]` `[SEAM 16]` |
| S9 | Hint → "Go to agent settings" | `V/components/chat/chat-landing.tsx` | — | EXCLUDED | Lody settings are KILL; the whole hint band is absent instead of a silent no-op. `[FIXED] #151` `[SEAM 7]` `[SEAM 16]` |
| S10 | Hint → Discord | `V/components/chat/chat-landing.tsx` | — | EXCLUDED | Hidden with S7; wrong-product third-party link. `[FIXED] #151` `[SEAM 7]` `[SEAM 16]` |
| S11 | Composer notice band | `V/components/chat/chat-landing.tsx` | — | EXCLUDED | `[CORRECTED]` Cloud query is undefined under the local capability set; sweep path was unreachable. |
| S12 | Lody left-sidebar expand slot | `V/components/chat/chat-landing.tsx` | — | EXCLUDED | Rail chrome is KILL; BlitzOS owns its desktop rail and mobile navigation drawer. |

*Section tally: HEADLESS 5 · +PROMPT 1 · EXCLUDED 6 · total 12.*

---

## 4. Composer controls

The §0 acceptance bar of `plans/LODY-SESSIONS.md`. **There is one composer shell**
(`V/components/chat/chat-composer.tsx:229`) with two hosts: the landing
(`V/components/chat/chat-landing.tsx:6499`) and the reply
(`V/components/sessions/session-chat-input-area.tsx:2323`). Sweep both — the reply
composer deliberately has NO machine chip, repo picker, branch picker or worktree
toggle (`session-chat-input-area.tsx:2244`, `bottomBarNode = null`).

### 4a. Text entry and submit

| # | Control | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| C1 | Prompt textarea, auto-resize | `V/components/mentions/combined-mention-textarea.tsx:1009`, mounted `chat-composer.tsx:873`; sizing `chat-composer.tsx:506-550` | Grows to `maxRows` 11 then scrolls. There is no expand/collapse button. | HEADLESS | |
| C2 | Plain-textarea fallback | `V/components/mentions/combined-mention-textarea.tsx:930` | With every mention source unavailable it degrades to a bare `<Textarea>` and `@`/`$`/`/` stop working. | HEADLESS | The failure mode to watch for on a box with no project |
| C3 | Enter submits | `chat-landing.tsx:2760-2773`; reply `session-chat-input-area.tsx:1870-1888` | Sends, unless IME-composing. | HEADLESS | The Enter path does not consult `submitDisabled` |
| C4 | Shift+Enter newline | `V/lib/mobile-keyboard-action.ts:26-28` | Inserts a newline; never submits. | HEADLESS | |
| C5 | Cmd+Enter submits | landing and reply composer keyboard handlers | Cmd+Enter submits exactly like Enter; Shift+Enter still inserts a newline. | HEADLESS | `[CORRECTED]` user ruling; the sweep's old expectation was wrong. |
| C6 | Send button (landing) | `V/components/chat/chat-landing-view.tsx:344`; handler `chat-landing.tsx:6536` | Sends; label flips to the submitting label. | HEADLESS | |
| C7 | Send button (reply) | `V/components/sessions/session-chat-input-area.tsx:2293` | `sendMessage('button')`; spinner while pending/uploading/history-syncing (`:2310`). | HEADLESS | |
| C8 | Send disabled | `session-chat-input-area.tsx:1907`; landing `chat-landing.tsx:6534` | Disabled with no sendable content. | HEADLESS | |
| C9 | Stop / interrupt | `session-chat-input-area.tsx:2274` (`aria-label` `sessions.stop`) | Cancels the running turn. | HEADLESS+PROMPT | |
| C10 | Stop↔Send swap | `session-chat-input-area.tsx:1906` (`showStopButton = canStopAgent && !hasDraft && !isArchived`) | Typing while the agent works replaces Stop with Send. | HEADLESS+PROMPT | Easy to regress; nothing tests it |

### 4b. Typed triggers and the `@` menu

| # | Control | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| C11 | `/` slash-command palette | `V/components/mentions/combined-mention-textarea.tsx:924`; category `mention-registry.ts:744` | The adapter's own `availableCommands` (`/usage`, `/insights`, `/recap`, …). | HEADLESS | `[TESTED]` `lody-worktree-composer.test.tsx` |
| C12 | `/` armed only when the prompt is slash-only | `combined-mention-textarea.tsx:916` (`/^\/\S*$/`) | Typing `/` mid-sentence must NOT open the palette. | HEADLESS | |
| C13 | Slash list source and refresh | `V/hooks/use-available-commands.ts:12`; our refresh `W/lody/agent-configs.ts:1` | An empty capability cache removes the `/` trigger entirely (`:896`). | HEADLESS | Upstream's own refresh never runs for a box (RUNTIME-DESIGN §8.3) |
| C14 | `@` category menu | `combined-mention-textarea.tsx:922`; menu `V/components/mentions/mention-two-level-menu.tsx:568` | A two-level menu over the seven categories. | HEADLESS | |
| C15 | `@file` — Files | `mention-registry.ts:652`; `V/components/mentions/file-at-mention.tsx:678` | Files of the registered project over `local-project/list-files`; inserts `@path`. | HEADLESS | |
| C16 | `@file` directory drill-down | `V/components/mentions/mention-two-level-menu.tsx`; `mention-registry.ts` | Tab or Right descends; the menu remains in Files for bare paths and fetches the selected directory. | HEADLESS | `[FIXED] #160`; `[SEAM 11]`; `[TESTED]` `lody-composer-mentions.test.tsx` |
| C17 | `@issue` — Issues | `mention-registry.ts:664` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| C18 | `@pr` — Pull Requests | `mention-registry.ts:673` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| C19 | `#123` hydrator | `V/components/mentions/issue-pr-hash-mention.tsx:317`; hydrator `combined-mention-textarea.tsx:996` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| C20 | `$` skills | `V/components/mentions/mention-skill-source.tsx:40`; trigger `combined-mention-textarea.tsx:923` | Skills palette; inserts `$token`, expanded to `use /token [Skill Path](path)` on send. | HEADLESS | `[TESTED]` **empty state only** |
| C21 | `@skill` through the category menu | `mention-registry.ts:684` | The same list, reached from `@`. | HEADLESS | Lazy activation fires the skills RPC once (`combined-mention-textarea.tsx:736`) |
| C22 | `@session` — Sessions | `mention-registry.ts:715` | Inserts a title slug; the committed range carries the real session id. | HEADLESS | `[NEVER RUN]` |
| C23 | Session-scope toggle (Current project / All projects) | `mention-two-level-menu.tsx:291`; source `combined-mention-textarea.tsx:298` | The segmented control re-scopes the session list. | HEADLESS | |
| C24 | Session-scope keyboard command | `combined-mention-textarea.tsx:153` (`mention.toggleSessionProjectScope`) | — | EXCLUDED | Hidden by approved `keyboardShortcuts=false`; no palette or dispatcher mounts. `[FIXED] #151` `[SEAM 7]` |
| C25 | Sessions empty state → "View all projects" | `mention-two-level-menu.tsx:271` | Flips scope to `all`. | HEADLESS | |
| C26 | `@role` — Agent Roles | `V/components/chat/chat-landing.tsx` | — | EXCLUDED | Hidden by approved `agentRolesAndMcp=false`. `[FIXED] #151` `[SEAM 7]` |
| C27 | `@cmd` — Commands | `mention-registry.ts:745` | The slash list, reached through `@`. | HEADLESS | |
| C28 | Candidate detail side pane | `mention-two-level-menu.tsx:194`; Role case `:199` | Highlighting a row shows its detail (desktop only). | HEADLESS | |
| C29 | Menu "Back" row | `mention-two-level-menu.tsx:327` | Pops the `@ns:` prefix back to a bare `@`. | HEADLESS | |
| C30 | Menu: Enter commits | `V/ui/mention/mention-input.tsx:666` | Commits the highlighted (or exact-match) item. | HEADLESS | |
| C31 | Menu: Tab descends | `V/ui/mention/mention-input.tsx:674`; Shift+Tab explicitly does not (`:676`) | Tab descends into a category, else commits. | HEADLESS | Shift+Tab is reserved for the mode cycle |
| C32 | Menu: Right descends, Left goes up | `V/ui/mention/mention-input.tsx`; `mention-root.tsx` | Right descends; Left goes up exactly one directory/category instead of closing the menu. | HEADLESS | `[FIXED] #160`; `[SEAM 11]`; `[TESTED]` `lody-composer-mentions.test.tsx` |
| C33 | Menu: ↑ ↓ Home End | `V/ui/mention/mention-input.tsx:705,710,715,722` | Moves the highlight, looping. | HEADLESS | |
| C34 | Menu: Escape closes | `V/ui/mention/mention-input.tsx:729` | Closes without clearing the draft. | HEADLESS | |
| C35 | Chip-aware ← / → caret | `V/ui/mention/mention-input.tsx:499-536` | The caret jumps a committed mention as one unit. | HEADLESS | |
| C36 | Chip-aware Backspace | `V/ui/mention/mention-input.tsx:538-578` | Deletes the whole mention plus its trailing space. | HEADLESS | |
| C37 | Persisted mentions rehydrate | `combined-mention-textarea.tsx:438` (`PersistedMentionHydrator`), mounted `:970` | Chips return after a reload with no source loaded. | HEADLESS | |
| C38 | Mention chip click | `V/ui/mention/mention-input.tsx` | Clicking any painted chip selects its whole range. Only `pasted_text` invokes its editor action. | HEADLESS | `[FIXED] #160`; `[SEAM 11]`; `[TESTED]` `lody-composer-mentions.test.tsx` |
| C39 | Drag a session into the composer | `V/components/sessions/session-mention-drop-layer.tsx:14`; write `combined-mention-textarea.tsx:567` | Writes a real session mention range, not text. | HEADLESS | Rejects unknown / own / duplicate sessions |

### 4c. Attachments and MCP

| # | Control | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| C40 | `+` attachment menu | `V/components/chat/attachment-add-menu.tsx:102`, mounted `chat-composer.tsx:933` | An upward dropdown; hidden entirely when neither attach nor MCP is available (`:76`). | HEADLESS | |
| C41 | `+` → Add attachment | `V/components/chat/attachment-add-menu.tsx`; landing and reply inputs | Files stage over the local bridge without a cloud token; a landing image falls back to that file pipeline. | HEADLESS | `[FIXED] #156`; `[FIXED] #163`; `[SEAM 3]` `[SEAM 8]` `[SEAM 12]`; `[TESTED]` |
| C42 | Drag-and-drop onto the composer | `V/components/chat/chat-composer.tsx`; landing and reply wiring | Files split by MIME and use the tokenless local handoff; a landing image degrades to a file. | HEADLESS | `[FIXED] #156`; `[FIXED] #163`; `[TESTED]` `lody-attachment-guard.test.tsx` |
| C43 | Paste files or images | landing and reply paste handlers | Clipboard files split by MIME; tokenless local files work, including landing-image fallback. | HEADLESS | `[FIXED] #156`; `[FIXED] #163`; `[TESTED]` `lody-attachment-guard.test.tsx` |
| C44 | Large-text paste → "Pasted text" chip | `chat-landing.tsx:2779-2784` | A `[Pasted N chars]` chip instead of flooding the box. | HEADLESS | |
| C45 | Pasted-text editor dialog | `chat-composer.tsx:1138` (dialog `:1116`) | Full-height editor showing `N chars · M lines`; edits write back. | HEADLESS | |
| C46 | Pasted-text copy re-expansion | `chat-composer.tsx:421` | Copying across the chip puts the FULL original text on the clipboard. | HEADLESS | |
| C47 | Image thumbnail → lightbox | `chat-composer.tsx:734`, dialog `:1042` | Opens the image preview. | HEADLESS | |
| C48 | Remove image | `chat-composer.tsx:761` → `session-chat-input-area.tsx:1371` | The chip and the staged file go. | HEADLESS | |
| C49 | Retry image upload | reply composer retry handler | A failed in-session image upload retries through the local path without requiring a cloud token. | HEADLESS | `[FIXED] #156`; `[SEAM 8]`; `[TESTED]` |
| C50 | File attachment card | `chat-composer.tsx:790`; extension badge `:220` | Square card with type badge, name, size and phase. | HEADLESS | |
| C51 | Remove file | `chat-composer.tsx:857` → `session-chat-input-area.tsx:1463` | The card goes; an in-flight upload aborts. | HEADLESS | |
| C52 | Retry file upload | landing and reply file-draft retry handlers | Retries the tokenless local transfer instead of returning at the cloud-token guard. | HEADLESS | `[FIXED] #156`; `[SEAM 8]`; `[TESTED]` |
| C53 | Upload progress (image % / file phases) | `chat-composer.tsx:748,772,847` | Clip-path fill, percent, and preparing/uploading/verifying. | HEADLESS | |
| C54 | Oversize image auto-degrade | `session-chat-input-area.tsx:1313` | An image over 5 MiB is silently re-routed into the file pipeline. | HEADLESS | Silent by design — assert it lands as a FILE card |
| C55 | `+` → MCP submenu | `V/components/chat/attachment-add-menu.tsx` | — | EXCLUDED | Hidden by the empty local catalog and approved `agentRolesAndMcp=false`. `[FIXED] #151` |
| C56 | MCP server checkbox | `V/components/chat/attachment-add-menu.tsx` | — | EXCLUDED | Same scope decision as C55. `[FIXED] #151` |
| C57 | MCP "applies next start" hint | `V/components/chat/attachment-add-menu.tsx` | — | EXCLUDED | Same scope decision as C55. `[FIXED] #151` |

### 4d. Scope selectors (landing only)

| # | Control | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| C58 | Machine chip | `V/components/sessions/desktop-run-config-menu.tsx:240`, mounted `chat-landing.tsx:3714` | Names the box; filters projects and agent configs. | HEADLESS | `[TESTED]` parity table PASS (RUNTIME-DESIGN §10.5) |
| C59 | Machine chip → "Add machine" | `desktop-run-config-menu.tsx:318` → `chat-landing.tsx:6590` | — | EXCLUDED | `V/components/chat/machine-pairing-dialog.tsx` is a cloud pairing flow |
| C60 | Repo / project picker | `V/components/chat/unified-project-selector.tsx:510`, mounted `chat-landing.tsx:3723` | Every `/workspace` repo listed and selectable; caps at 20 rendered rows. | HEADLESS | `[FIXED]` `b1b4e082`; `[TESTED]` `lody-project-mirror.test.ts` |
| C61 | Project picker search | `unified-project-selector.tsx:554`, autofocus `:504` | Fuzzy-filters the complete option set. | HEADLESS | |
| C62 | Project picker clear (`X`) | `unified-project-selector.tsx:483` | Resets to no project. | HEADLESS | |
| C63 | Picker → "No project" | `unified-project-selector.tsx:627` | A plain chat with no project. | HEADLESS | Depends on L6 |
| C64 | Picker → "Add local project" | `unified-project-selector.tsx:631` → `chat-landing.tsx:6583` | The in-app RPC directory browser, rooted at `/workspace`. | HEADLESS | `[FIXED]` `b1b4e082` (it used to open at `os.homedir()`) |
| C65 | Picker → "Connect GitHub" | `unified-project-selector.tsx:635` → `openSettings('github')` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| C66 | Picker → project "Private" share segment | `unified-project-selector.tsx:295` | — | EXCLUDED | Lody cloud project sharing; ours is per-session |
| C67 | Branch picker | `V/components/chat/chat-landing-selectors.tsx:210`, mounted `chat-landing.tsx:3366` | Lists every branch of the clone; opens upward. | HEADLESS | `[TESTED]` parity PASS |
| C68 | Branch picker search | `chat-landing-selectors.tsx:236` | Searchable past 6 options. | HEADLESS | |
| C69 | Branch picker visibility rule | `chat-landing.tsx:3349` (`getChatLandingBranchSelectorState`) | A direct (non-worktree) local project renders NO branch picker. | HEADLESS | Easy to misread as a bug |
| C70 | Branch reload retry | `chat-landing.tsx:3382` | A red refresh glyph after a git-state error, and it re-fetches. | HEADLESS | Reachable only by breaking `local-project/git-state` |
| C71 | Worktree pill (local) | `chat-landing.tsx:3424` → `V/components/shared/workdir-mode-selector.tsx:38` | Ticked by default and toggleable; disabled with a reason for a non-git project. | HEADLESS | Default seeded by `W/lody/workdir-default.ts` (LODY-SESSIONS §0.5) |
| C72 | Worktree pill (github, forced) | `chat-landing.tsx:3414` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| C73 | Branch + worktree combined pill | `chat-landing.tsx:3433` | One rounded container with a hairline divider. | HEADLESS | |

### 4e. Run configuration

| # | Control | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| C74 | Run-config button (the face) | `desktop-run-config-menu.tsx:689`, aria `:637`; reply `session-chat-input-area.tsx:2183`, landing `chat-landing.tsx:3751` | `[agent] model · reasoning ⌄` opens the consolidated menu. | HEADLESS | |
| C75 | "Select a machine first" tooltip | `desktop-run-config-menu.tsx:686` | The disabled variant explains itself. | HEADLESS | |
| C76 | "Recently used" group | `V/components/sessions/recent-run-config-menu-group.tsx` | Device-local history lists combinations actually started, scoped by workspace id. | HEADLESS | `[CORRECTED]` COMPB-2 was refuted; the first check lost localStorage in a fresh context. |
| C77 | Agent picker | `desktop-run-config-menu.tsx:757` | Lists the agent configs on the allowed machine. | HEADLESS | Claude and Codex only (LODY-SESSIONS §0.6) |
| C78 | Agent picker LOCKED after the first turn | `desktop-run-config-menu.tsx:741`; `agentLocked` at `session-chat-input-area.tsx:2190` | Read-only once the conversation is non-empty. | HEADLESS+PROMPT | |
| C79 | Model picker | `desktop-run-config-menu.tsx:826`, list `:842` | The models the capabilities refresh reported. | HEADLESS | `[TESTED]` parity PASS |
| C80 | Model picker fuzzy search | `desktop-run-config-menu.tsx:842` (`MenuOptionSearchList`) | A search row appears once the list is long. | HEADLESS | |
| C81 | Provider extra `select` options | `desktop-run-config-menu.tsx:791-823` | One submenu per ACP config option. | HEADLESS | |
| C82 | Interaction-mode picker | `desktop-run-config-menu.tsx:881-902` | Sets the provider's interaction mode. | HEADLESS | |
| C83 | Reasoning-effort picker | `desktop-run-config-menu.tsx:904-925` | Sets reasoning effort. **This is the "thinking" control — there is no boolean toggle.** | HEADLESS | `[TESTED]` parity PASS |
| C84 | Plan-mode toggle | `desktop-run-config-menu.tsx:928` (`ToggleItem`) | Switch row that deliberately keeps the menu open (`:173`). | HEADLESS | |
| C85 | Fast-mode toggle | `desktop-run-config-menu.tsx:944` | Same, for the provider's fast option. | HEADLESS | |
| C86 | Agent Role row — create | `V/components/sessions/desktop-run-config-menu.tsx` | — | EXCLUDED | Hidden by approved `agentRolesAndMcp=false`. `[FIXED] #151` `[SEAM 7]` |
| C87 | Agent Role row — pick | `V/components/sessions/desktop-run-config-menu.tsx` | — | EXCLUDED | Same scope decision as C86. `[FIXED] #151` `[SEAM 7]` |
| C88 | Role editor dialog | landing and reply mounts | — | EXCLUDED | Same scope decision as C86. `[FIXED] #151` `[SEAM 7]` |
| C89 | Role-pinned run-config face | `V/components/sessions/desktop-run-config-menu.tsx` | — | EXCLUDED | Same scope decision as C86. `[FIXED] #151` `[SEAM 7]` |
| C90 | Permission-mode button | `desktop-run-config-menu.tsx:1048`, list `:1060`; reply mount `session-chat-input-area.tsx:2204`, landing `chat-landing.tsx:3785` | A flat list of permission modes with per-mode icon and safety copy. | HEADLESS | `[TESTED]` `lody-permission-mode.test.tsx` |
| C91 | Permission button hidden behind a Role | landing and reply mounts | — | EXCLUDED | Same scope decision as C86. `[FIXED] #151` `[SEAM 7]` |
| C92 | Usage popover | `V/components/sessions/session-usage-popover.tsx:131`; mounts `session-chat-input-area.tsx:2232`, `chat-landing.tsx:3798` | Context usage, 5-hour and weekly rate limits, reset time, spend. Fetches ON OPEN. | HEADLESS+PROMPT | Empty until a turn reports usage |
| C93 | DeepSeek delegation-cost warning | `desktop-run-config-menu.tsx:862-879` | — | EXCLUDED | DeepSeek is not in §0.6's agent list |

### 4f. Drafts, focus, notices

| # | Control | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| C94 | Composer status line | `chat-composer.tsx:919` (box), `:1005` (dialog) | An `alert`/`status` line under the composer. | HEADLESS | Uses raw `amber-*` literals no token reaches (RUNTIME-DESIGN §14.6) |
| C95 | Adaptive placeholder | `V/lib/chat-composer-placeholder.ts`, resolved `chat-composer.tsx:320-330` | Advertises `@`/`$`/`/` only when those sources are enabled. | HEADLESS | Good proxy for C2's failure mode |
| C96 | Archived-session lockout | `session-chat-input-area.tsx:2049`, `:2344`, `:2326-2327` | The composer disables and every mention source is removed. | HEADLESS | |
| C97 | Draft persistence — reply (5 caches) | `session-chat-input-area.tsx:289,190,191,192,233` | Text, images, files, pasted text and mention ranges survive a session switch. | HEADLESS | In-memory; not across a reload |
| C98 | Draft persistence — landing | `chat-landing.tsx:953,956,958,974` | Prompt, pasted drafts and mention ranges survive leaving `/chat`. | HEADLESS | |
| C99 | `draftKey` swap protection | `combined-mention-textarea.tsx:852-861`; passed `session-chat-input-area.tsx:2365` | Switching sessions drops the outgoing ranges during render, so stale chips never paint. | HEADLESS | |
| C100 | Cmd+L discovery hint chip | `V/components/chat/chat-composer.tsx` | — | EXCLUDED | Approved command-palette/chord area is hidden; no registration means no chip. `[FIXED] #151` `[SEAM 7]` `[TESTED]` |
| C101 | Click-background-to-focus | `chat-composer.tsx:673-690`; enabled `session-chat-input-area.tsx:2387` | Clicking empty space in the box focuses the textarea. | HEADLESS | |
| C102 | ⌘L focus-composer chord | `V/lib/commands/built-ins.ts:84`; binding `V/lib/commands/shortcuts.ts:66` | — | EXCLUDED | Hidden by approved `keyboardShortcuts=false`; no palette or dispatcher mounts. `[FIXED] #151` `[SEAM 7]` |
| C103 | Shift+Tab cycle permission mode | `V/hooks/use-composer-cycle-commands.ts:42`; binding `shortcuts.ts:90` | — | EXCLUDED | Hidden by approved `keyboardShortcuts=false`; no palette or dispatcher mounts. `[FIXED] #151` `[SEAM 7]` |
| C104 | Focus returns to the prompt after a menu pick | `V/lib/menu-focus.ts`; marker `chat-composer.tsx:903` | Focus goes to the prompt, never the trigger. | HEADLESS | |
| C105 | Comment-reference chip | `V/components/chat/comment-reference-chip.tsx`, rendered `chat-composer.tsx:695`; remove `:698` | A diff/preview comment staged onto the next message; click navigates to it. | HEADLESS+PROMPT | Needs a diff comment first (SP42) |
| C106 | Visual-annotation chip | `V/components/chat/visual-annotation-reference-chip.tsx`, rendered `chat-composer.tsx:708` | — | ELECTRON-N/A | Produced only by the preview surface (SP51) |
| C107 | Free-turn-limit notice + Upgrade | `session-chat-input-area.tsx:2252`, button `:2261` | — | EXCLUDED | Lody cloud billing |
| C108 | External-history sync chip | `session-chat-input-area.tsx:2246` | — | EXCLUDED | CLI-history import is a Lody-cloud path |
| C109 | Composer crash fallback (reply) | `chat-landing-view.tsx:366` | A bare textarea holding the draft plus "Try again". | HEADLESS | |
| C110 | Mobile run-config sheet | `V/components/mobile/mobile-run-config-sheet.tsx` — viewport below 768 px | The real sheet opens from the mobile composer and applies supported machine, project, model, and permission choices. | HEADLESS | `[FIXED] #171`; `[SEAM 16]` |

### 4g. Message queue and steering

| # | Control | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| C111 | Queue vs dispatch vs steer decision | `V/components/sessions/session-message-submit-route.ts:23`, rules `:30-50`; call `session-chat-interface.tsx:3772` | Busy + preference decides guide/steer, queue, or direct dispatch. | HEADLESS+PROMPT | |
| C112 | "Up next" queue panel | `V/components/sessions/message-queue/message-queue-display.tsx:126`, mounted `session-chat-interface.tsx:5903` | Pending turns listed with a count. | HEADLESS+PROMPT | |
| C113 | Queue: Steer (first item) | `message-queue-row.tsx:293` | Native acknowledged steering, else interrupt-and-send. | HEADLESS+PROMPT | |
| C114 | Queue: Edit | `message-queue-row.tsx:305`, textarea `:197`, save `:223` | Inline edit, Enter commits. | HEADLESS+PROMPT | |
| C115 | Queue: Remove | `message-queue-row.tsx:310` | Drops the queued message. | HEADLESS+PROMPT | |
| C116 | Queue: drag to reorder | `message-queue-row.tsx:138` | Reorders the queue. | HEADLESS+PROMPT | |
| C117 | Queue: image preview | `V/components/sessions/message-queue/queued-image-preview.tsx:82` | Previews a queued attachment. | HEADLESS+PROMPT | |

### 4h. Read-only / shared composer

| # | Control | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| C118 | Composer suppressed for a read-only viewer | `V/components/sessions/session-chat-interface.tsx:5876` | No composer at all on an RO grantee's surface. | SECOND-ACCOUNT | `[SEAM 4]`; `[TESTED]` `lody-shared-surface.test.tsx` |
| C119 | RW grantee's composer has no selectors | LODY-SHARING §10.3 | No model, effort or permission control; the send inherits the session's config. | SECOND-ACCOUNT | By design — the machine Flock is admin-only |

**Not present anywhere, stated so nobody hunts for them:** voice/dictation, an
expand/collapse composer button, a Cmd+Enter submit, and a boolean thinking toggle.
| C120 | Landing image tokenless fallback | `V/hooks/use-chat-landing-image-draft.ts`; local file draft | With no Lody cloud token and a local bridge, a landing image becomes a file attachment and remains retryable. | HEADLESS | `[FIXED] #163`; `[SEAM 12]`; `[TESTED]` `lody-attachment-guard.test.tsx` |

*Section tally: HEADLESS 82 · +PROMPT 12 · SECOND-ACCOUNT 2 · ELECTRON-N/A 1 · EXCLUDED 23 · total 120.*

---

## 5. In-conversation features

| # | Feature | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| IC1 | Transcript renders | `V/components/sessions/session-chat-interface.tsx:1` | User and assistant turns in order. | HEADLESS | `[TESTED]` `lody-session-roundtrip.test.ts`; reuse a fixture session with history |
| IC2 | Markdown (GFM, sanitized raw HTML) | `V/components/ai-gui/markdown-renderer.tsx:1026` | Prose, lists, tables render. | HUMAN-EYES | |
| IC3 | Code-block syntax highlight (shiki) | `V/components/ai-gui/markdown-renderer.tsx:513-603` | Fenced code is tokenized. | HUMAN-EYES | `shiki/bundle/full` is aliased in `W/lody/vendor-bridge.ts` |
| IC4 | Copy code button | `V/components/ai-gui/markdown-renderer.tsx:619`, aria `:893` | Copies the block source. | HEADLESS | |
| IC5 | Mermaid diagram block | `V/components/ai-gui/markdown-renderer.tsx:609,622` | Renders from the lazy chunk, theme-aware. | HUMAN-EYES | `[TESTED]` boundary only (`lody-lazy-boundary.test.ts`) |
| IC6 | Mermaid copy button | `V/components/ai-gui/markdown-renderer.tsx:623` | Copies the diagram source. | HEADLESS | |
| IC7 | External link hardening | `V/components/ai-gui/markdown-renderer.tsx:201` | Opens in a new tab with a hardened `rel`. | HEADLESS | |
| IC8 | Agent-file link (open / copy path) | `V/components/ai-gui/markdown-renderer.tsx:701`, aria `:855` | Opens the file if an open action exists, else copies the path. | HEADLESS | |
| IC9 | Inline markdown image | `V/components/ai-gui/markdown-renderer.tsx:799` | Renders with alt text. | HEADLESS | |
| IC10 | Copy message (user) | `V/components/ai-gui/view.tsx:2839` | Copies the message text. | HEADLESS | |
| IC11 | Copy response (assistant) | `V/components/ai-gui/view.tsx:3521`, "Copied" `:3535` | Copies the assistant response. | HEADLESS | |
| IC12 | Copy plan | `V/components/ai-gui/view.tsx:5199` | Copies a plan block. | HEADLESS+PROMPT | |
| IC13 | Edit a user message | `V/components/ai-gui/view.tsx:2779` → `V/components/ai-gui/user-message-editor.tsx` | Opens the inline editor. | HEADLESS+PROMPT | |
| IC14 | Editor Cancel / Send | `user-message-editor.tsx:106` / `:116` | Discards, or edits and resends. | HEADLESS+PROMPT | Failure path `session-chat-interface.tsx:2949` |
| IC15 | Pin / unpin a message | `V/components/ai-gui/view.tsx:2805`; unpin `V/components/sessions/session-pin.tsx:75` | The message is pinned above the transcript. | HEADLESS | |
| IC16 | "Not delivered" + Resend | `V/components/ai-gui/view.tsx:2679`, confirm `:2889-2904` | Re-dispatches an undelivered message. | HEADLESS+PROMPT | |
| IC17 | Delivery / steering status | `V/components/ai-gui/view.tsx:2683,2694,2697` | Not delivered / Steering / Delivered / Sending. | HEADLESS+PROMPT | |
| IC18 | Fork a turn (GitFork) | `V/components/ai-gui/view.tsx:3335` | One-click fork when no worktree option applies. | HEADLESS+PROMPT | |
| IC19 | Fork destination popover | `V/components/ai-gui/view.tsx:3358` → `V/components/sessions/session-fork-destination-menu.tsx:98` | "Current workspace" (`:35`) or "New worktree" (`:47`). | HEADLESS+PROMPT | |
| IC20 | Dirty-worktree fork confirm | `V/components/sessions/session-detail.tsx:4633`, action `:4656` | "Continue from committed HEAD" drops uncommitted work. | HEADLESS+PROMPT | |
| IC21 | Fork-origin system notice | `V/components/ai-gui/view.tsx:2082`, link `:2088` | "Forked from …" navigates to the origin. | HEADLESS+PROMPT | |
| IC22 | Session-created card → "View session" | `V/components/ai-gui/view.tsx:1914-1921` | Jumps to a session the agent created mid-conversation. | HEADLESS+PROMPT | Needs X16 |
| IC23 | Tool-activity summary collapse | `V/components/ai-gui/view.tsx:3089`, summary text `:3058-3078` | "Thought · N commands · N files" expands the group. | HEADLESS+PROMPT | |
| IC24 | Turn-duration row toggle | `V/components/ai-gui/view.tsx:3148` | "Worked for Xm Ys" expands the turn's tool detail. | HEADLESS+PROMPT | |
| IC25 | Thinking / Thought block | `V/components/ai-gui/view.tsx:3281` | Reveals the model's reasoning text. | HEADLESS+PROMPT | |
| IC26 | Tool-call card expand | `V/components/ai-gui/view.tsx:5044`, default-expand rule `:5567` | Expands to arguments and output; auto-expanded while running or on failure. | HEADLESS+PROMPT | |
| IC27 | Tool file-path click | `V/components/ai-gui/view.tsx:5617` | Opens that file in the side-panel viewer. | HEADLESS+PROMPT | |
| IC28 | Terminal output block (ANSI) | `V/components/ai-gui/view.tsx:5503` → `V/components/ai-gui/terminal-component.tsx:93` | Renders ANSI with the VS Code theme, tail-limited. | HEADLESS+PROMPT | |
| IC29 | Focus terminal output | `V/components/ai-gui/terminal-component.tsx:245` | Enables scroll and selection inside the block. | HEADLESS+PROMPT | |
| IC30 | "Streaming in your CLI" notice | `V/components/ai-gui/view.tsx:5762` | Says output is going to the external CLI. | HEADLESS+PROMPT | |
| IC31 | Worktree script output steps | `V/components/ai-gui/view.tsx:2455-2457`, steps `:2493-2507` | Per-step setup/cleanup output expands. | HEADLESS+PROMPT | |
| IC32 | Assistant edited-files list | `V/components/ai-gui/assistant-edited-files.tsx:142`, show more `:159` | "N files edited"; clicking one opens the file/diff. | HEADLESS+PROMPT | |
| IC33 | Subagent task panel | `V/components/ai-gui/subagent-task-panel.tsx:167`, statuses `:85-93` | Expands the subagent task list. | HEADLESS+PROMPT | `[NEVER RUN]` |
| IC34 | Session file card (attachment) | `V/components/ai-gui/session-file-card.tsx:147` | Opens the file preview dialog; upload/expiry states `:69-75`. | HEADLESS+PROMPT | |
| IC35 | File preview: Rendered / Raw | `V/components/ai-gui/session-file-preview-dialog.tsx:92,95` | Switches view mode. | HEADLESS+PROMPT | |
| IC36 | File preview: Copy | `session-file-preview-dialog.tsx:105` | Copies the content. | HEADLESS+PROMPT | |
| IC37 | File preview: Download | `session-file-preview-dialog.tsx:116,158` | Downloads the attachment. | HEADLESS+PROMPT | |
| IC38 | Inline image + gallery | `V/components/ai-gui/view.tsx:4439`, dialog `:1760` | Opens the full-screen gallery and steps between images. | HEADLESS+PROMPT | |
| IC39 | Zoomable viewer context menu (Copy / Save Image) | `V/components/shared/zoomable-image-viewer.tsx:209,210` | — | ELECTRON-N/A | `V/lib/image-preview-export.ts:41` bails when not Electron |
| IC40 | Scroll-to-latest pill | `V/components/ai-gui/view.tsx:1752` | Appears when unstuck from the bottom; scrolls to newest. | HEADLESS | |
| IC41 | Conversation outline rail | `V/components/ai-gui/conversation-outline-rail.tsx:593`, tick click `:638` | Ticks jump to a conversation round. | HEADLESS | `[NEVER RUN]` |
| IC42 | Outline hover preview | `conversation-outline-rail.tsx:694-695` | Hovering a tick previews the turn text. | HUMAN-EYES | |
| IC43 | Turn configuration popover | `V/components/ai-gui/view.tsx:2976`, title `:2993` | Shows the run config recorded for that turn. | HEADLESS+PROMPT | |
| IC44 | Turn timing / timestamp | `V/components/ai-gui/view.tsx:3556-3568`, `:3433` | Completion timestamp and elapsed duration. | HEADLESS+PROMPT | |
| IC45 | Chat-failed notice → View details | `V/components/ai-gui/view.tsx:2323`, `:2347`; reasons `:2204-2292` | Opens the failure dialog. | HEADLESS+PROMPT | This is the same signal `W/lody/agent-auth-notice.tsx` polls for |
| IC46 | Chat-failed dialog: Copy error | `V/components/ai-gui/chat-failed-detail-dialog.tsx:135` | Copies a diagnostic report. | HEADLESS+PROMPT | |
| IC47 | Agent warning notice | `V/components/ai-gui/view.tsx:2408` | Renders inline. | HEADLESS+PROMPT | |
| IC48 | Context compaction status | `V/components/ai-gui/view.tsx:5364-5367` | Compacting / compacted / failed. | HEADLESS+PROMPT | |
| IC49 | Codex retry notice | `V/components/ai-gui/view.tsx:5348` | "Connection interrupted, Codex is retrying". | HEADLESS+PROMPT | Codex is in scope (§0.6) |
| IC50 | Orchestration operation summaries | `V/components/ai-gui/view.tsx:1976-2028` | Operation failed / cancelled / not started. | HEADLESS+PROMPT | Needs X16 |
| IC51 | Comment reference card | `V/components/ai-gui/comment-reference-card.tsx:31` | Jumps to the referenced diff comment. | HEADLESS+PROMPT | |
| IC52 | Visual annotation reference card | `V/components/ai-gui/visual-annotation-reference-card.tsx:34` | — | ELECTRON-N/A | Produced only by the preview surface |
| IC53 | Permission Required card | `V/components/sessions/floating-permission-request.tsx:171`, header `:199` | A card listing the agent-supplied options. | HEADLESS+PROMPT | Options are agent-supplied, classified by `kind` (`:156`, `:168`) |
| IC54 | Permission option buttons | `floating-permission-request.tsx:232-256`, click `:244` | Deny / Allow Once / Always Allow answer with an `optionId`. | HEADLESS+PROMPT | **The header and the body are separate children — the buttons are NOT under the header** (LODY-SHARING §10.5 turn 3) |
| IC55 | Permission resolved states | `floating-permission-request.tsx:194-198`, disabled `:180` | Header becomes Approved / Denied / Cancelled. | HEADLESS+PROMPT | |
| IC56 | Permission command "Show more" | `floating-permission-request.tsx:134`, labels `:141-142` | Expands the clamped command being approved. | HEADLESS+PROMPT | |
| IC57 | "Permission actions are disabled" footer | `floating-permission-request.tsx:265` | Shown when `isReady` is false. | HEADLESS | Assert it does NOT appear on a healthy box |
| IC58 | AskUserQuestion card | `V/components/sessions/ask-user-question-card.tsx:421` | Multi-question card with a progress bar. | HEADLESS+PROMPT | `[NEVER RUN]` |
| IC59 | AskUserQuestion controls | pagination `:434`, prev/next `:667`,`:682`, submit `:646`,`:694`, custom answer `:626`, details `:523`, cancel `:500`, auto-continue `:481` | Each answers or navigates the question set. | HEADLESS+PROMPT | `[NEVER RUN]` |
| IC60 | Notification permission prompt | `V/components/sessions/notification-permission-prompt.tsx` | — | EXCLUDED | Hidden by approved `cloudSurfaces=false`; OneSignal is not mounted. `[FIXED] #151` `[SEAM 7]` `[SEAM 16]` |
| IC61 | Goal banner + Pause / Resume / Clear / Dismiss | `V/components/sessions/session-goal-banner.tsx:237,285,294,304,315` | Objective, elapsed time, token budget, and the three verbs. | HEADLESS+PROMPT | `[NEVER RUN]` (Codex Goals) |
| IC62 | Plan bar | `V/components/sessions/session-plan-bar.tsx:66` | Current plan summary or "Plan cleared". | HEADLESS+PROMPT | |
| IC63 | Proposed plan: Implement / Continue discussing | `session-chat-interface.tsx:4603`, `:4614` | Sends "Implement the plan", or stays in plan mode. | HEADLESS+PROMPT | |
| IC64 | Lody offline status is absent | session composer status chip | Browser-offline and machine-offline Lody messages never render; machine-removed remains because it blocks sending. | HEADLESS | `[FIXED] #173`; `[SEAM 15]`; `[SEAM 16]`; `[TESTED]` |
| IC65 | Lody catch-up indicators are absent | session info bar and mobile header | Ambient "Syncing" indicators and the mobile connection banner stay dark; data-specific loading states remain. | HEADLESS | `[FIXED] #173`; `[SEAM 15]`; `[SEAM 16]`; `[TESTED]` |
| IC66 | Scheduled tasks panel | `V/components/sessions/scheduled-tasks-panel.tsx:166`, countdown `:82-90` | Upcoming cron/wakeup triggers. | HEADLESS+PROMPT | `[NEVER RUN]` |
| IC67 | Auto review (status / menu / info / confirm) | `V/components/sessions/auto-review-status.tsx:101`; menu `auto-review-menu-item.tsx:82` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| IC68 | Info chips row + promote | `V/components/sessions/info-chip.tsx:61,89,193` | Runs a chip action or expands its popover. | HEADLESS | |
| IC69 | Info bar: Open preview | `V/components/sessions/session-info-bar.tsx:313` | — | ELECTRON-N/A | Opens SP51 |
| IC70 | Info bar: private-access chip | `V/components/sessions/session-info-bar.tsx:298` | Runs the sharing action for a private session. | SECOND-ACCOUNT | |
| IC71 | Info chip: copy folder / worktree path | `V/components/sessions/session-info-chips.tsx:525`, labels `:500-506` | Copies the path, with a toast. | HEADLESS | |
| IC72 | Pull request badge | `V/components/sessions/pull-request-badge.tsx:113,127` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| IC73 | Session relation card | `V/components/shared/session-relation-card.tsx:49` | Navigates to a related session. | HEADLESS+PROMPT | |
| IC74 | Child-tab empty state suggestions | `V/components/sessions/child-tab-empty-state.tsx:43` | Prefills the composer of a new child tab. | HEADLESS | |
| IC75 | Session not found → "Back to Sessions" | `V/components/sessions/session-not-found.tsx:57` | The card, plus every host tab moving to the landing's strip. | HEADLESS | `[FIXED]` `f1b19d0f` `[SEAM 5]` hunks 19-20; `[TESTED]` `lody-terminal-tab-wave3.test.tsx` |
| IC76 | Find in session: open | `session-chat-interface.tsx:1273` | Opens the in-conversation search bar. | HEADLESS | |
| IC77 | Search input + highlight | `session-chat-interface.tsx:1634`; matching `V/components/sessions/session-search-context.tsx:47` | Highlights matches across messages. | HEADLESS | |
| IC78 | Search prev / next + counter | `session-chat-interface.tsx:1675`, `:1679`, counter `:1569`, empty `:1574` | Steps through matches. | HEADLESS | |
| IC79 | Search close | `session-chat-interface.tsx:1688` | Closes the bar. | HEADLESS | |
| IC80 | Header menu: session context block | `session-chat-interface.tsx:1145-1232` — copy repo `:1154`, branch `:1177`, path `:1211` | Each row copies its value; machine + Worktree/Local badge at `:1226`. | HEADLESS | |
| IC81 | Header menu: Fork session | `session-chat-interface.tsx:1286`, `:1328` | Forks at the last assistant turn. | HEADLESS+PROMPT | Refuses with a toast when there is nothing to fork |
| IC82 | Header menu: Rename Chat | `session-chat-interface.tsx:1339`; dialog `V/components/sessions/rename-session-dialog.tsx:124` | Title changes in the header and the rail. | HEADLESS | |
| IC83 | Header menu: Change owner | session header menu | — | EXCLUDED | Hidden by approved `cloudSurfaces=false`. `[FIXED] #151` `[SEAM 7]` `[SEAM 16]` |
| IC84 | Header menu: Share with team | session header menu | — | EXCLUDED | Hidden by approved `cloudSurfaces=false`; BlitzOS sharing remains R14. `[FIXED] #151` `[SEAM 7]` `[SEAM 16]` |
| IC85 | Copy ▸ Copy base branch | `session-chat-interface.tsx:1435` | Copies the base branch, with a toast. | HEADLESS | |
| IC86 | Copy ▸ Copy path | `session-chat-interface.tsx:1454`, disabled reason `:1450` | Copies the session workspace path. | HEADLESS | Refuses with "Workspace path unavailable" when the project is missing |
| IC87 | Copy ▸ Copy as Markdown | `session-chat-interface.tsx:1471`, trim notes `:319-338` | The whole conversation as Markdown. | HEADLESS+PROMPT | |
| IC88 | Header menu: Copy URL | session header menu | — | EXCLUDED | Hidden because the vendored memory-router URL is not a BlitzOS deep link. `[FIXED] #151` `[SEAM 7]` `[SEAM 16]` |
| IC89 | Archive page: Restore session | `V/components/archive/archive-view.tsx` | Restore removes the row from Archive, returns it to the rail, and preserves its session content. | HEADLESS | `[FIXED] #164`; `[SEAM 14]`; `[TESTED]` |
| IC90 | Archive page: Delete permanently | `V/components/archive/archive-view.tsx`; permanent-delete dialog | Confirmation permanently removes the archived session and its Archive row; cancel is inert. | HEADLESS | `[FIXED] #164`; `[SEAM 14]`; `[TESTED]` |
| IC91 | Header menu: Archive session | `session-chat-interface.tsx:1527` | Archives from inside the session. | HEADLESS | |
| IC92 | Archive confirm dialog | `session-detail.tsx:4569`, Archive `:4588` | "Archive chat?" then archives. | HEADLESS | |
| IC93 | Header menu: Opened by / Opened sessions | `session-chat-interface.tsx:1070`, `:1092` | Navigate to the opener or a child. | HEADLESS+PROMPT | |
| IC94 | Open in IDE / path launchers | `session-chat-interface.tsx:5260`, guard `:5279`, render gate `:5479`; picker `:5490-5540` | — | ELECTRON-N/A | Explicitly `isElectronRendererForPathLaunch` |
| IC95 | HTML attachment: "Connect and open" | `session-chat-interface.tsx:5954`, action `:5972` | Opens the agent-reported dev-server port. | HEADLESS+PROMPT | `[NEVER RUN]` |
| IC96 | Quick action: Create PR | `session-chat-interface.tsx:4467` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| IC97 | Quick action: Create Draft PR | `session-chat-interface.tsx:4473` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| IC98 | Quick action: Commit & Push | `session-chat-interface.tsx:4479` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| IC99 | Quick action: Resolve Conflicts | `session-chat-interface.tsx:4485` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| IC100 | Quick action: Fix CI Errors | `session-chat-interface.tsx:4492` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| IC101 | Quick action: Ready for review | `session-chat-interface.tsx:4500` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| IC102 | Conversation drop overlay | `V/components/shared/conversation-drop-overlay.tsx:31` | Lights up on a file or session-mention drag over the conversation. | HEADLESS | |
| IC103 | Conversation font size | `V/components/ai-gui/conversation-font-size-classes.ts` | — | EXCLUDED | Set from a stubbed settings page |
| IC104 | Permission card suppressed for RO | `session-chat-interface.tsx:5761` | No answer buttons for a read-only viewer. | SECOND-ACCOUNT | `[SEAM 4]` |
| IC105 | Permission card is gated on PRESENCE | LODY-SHARING §8.6 | The card appears only while a peer is on the room. | HEADLESS+PROMPT | Known flake — poll, never read once |

*Section tally: HEADLESS 31 · +PROMPT 51 · SECOND-ACCOUNT 2 · HUMAN-EYES 4 · ELECTRON-N/A 4 · EXCLUDED 13 · total 105.*

---

## 6. Tabs

One strip, two hosts: `SessionDetail` when a session is open, `TerminalTabsStrip`
on the landing.

| # | Feature | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| T1 | Session tab strip renders | `V/components/sessions/session-tab-bar.tsx:766` | Parent tab, child tabs, draft tabs. | HEADLESS | |
| T2 | Select a conversation tab | `session-tab-bar.tsx:253`; wrapper `session-detail.tsx:756` | The conversation shows and any host tab deselects. | HEADLESS | `[SEAM 5]` hunks 16-18; `[TESTED]` `lody-tab-selection-sync.test.tsx` |
| T3 | Close a tab | `session-tab-bar.tsx:317`; target `V/components/sessions/session-tab-close-target.ts:8` | The child closes and the neighbour is selected. | HEADLESS | |
| T4 | Main thread is not closeable | `session-tab-bar.tsx:309` | No `X` on the parent tab. | HEADLESS | |
| T5 | `+` new child chat | `session-tab-bar.tsx:751` | A draft tab opens and is selected. | HEADLESS | `[FIXED]` `e58f1531` — the draft used to open underneath a host tab |
| T6 | Close a draft tab | `session-tab-bar.tsx:407` | The unsent draft goes. | HEADLESS | |
| T7 | Draft tab promotes on first send | `session-detail.tsx` `handleSendDraft` | Meta plus the first user turn are written together, then the tab promotes. | HEADLESS+PROMPT | |
| T8 | Viewer tab (file / diff) select | `session-tab-bar.tsx:465` | Focuses that viewer. | HEADLESS | |
| T9 | Viewer tab close | `session-tab-bar.tsx:501` | Closes the viewer. | HEADLESS | |
| T10 | Viewer tab dirty / saving / conflict dot | `session-tab-bar.tsx:442-446` | Yellow, pulsing blue, red. | HEADLESS | |
| T11 | Archived tabs menu | `session-tab-bar.tsx:869` | Lists archived child tabs. | HEADLESS | |
| T12 | Restore an archived tab | `session-tab-bar.tsx:903` | Un-archives and reopens it. | HEADLESS | |
| T13 | Adaptive overflow | `V/components/sessions/adaptive-tab-strip.tsx` | Tabs collapse into overflow as width shrinks. | HUMAN-EYES | |
| T14 | Session tab drag reorder | `V/components/sessions/adaptive-tab-strip.tsx` | Conversation and viewer tabs reorder and persist; custom host tabs remain fixed-order. | HUMAN-EYES | The deleted native drag path is not this vendored dnd-kit path. |
| T15 | Session tab is a mention drag source | `V/lib/session-mention-drag.ts` | Parent tabs HTML5-drag; child tabs arm the dnd-kit store. | HEADLESS | |
| T16 | Host (terminal) tab in the strip | `W/lody/surface-tabs.ts:46`; strip `W/lody/TerminalTabsStrip.tsx:31` | A terminal appears as a tab of the SAME strip, with its own glyph. | HEADLESS | `[SEAM 5]`; `[TESTED]` `lody-surface-tabs.test.tsx` |
| T17 | Select a host tab | `W/CloudApp.tsx:1675` | The terminal fills the pane; every conversation surface hides. | HEADLESS | `[FIXED]` `e58f1531`, `f94c87d1` |
| T18 | Close a host tab | Lody strip close control and `W/CloudApp.tsx` | The tab row disappears and `POST /terminal/kill` ends the exactly named tmux session. | HEADLESS | `[FIXED] #154`; `[TESTED]` `terminal-tab-tmux-kill.test.tsx` |
| T19 | Strip on the landing (no session) | `W/lody/TerminalTabsStrip.tsx:31` | `variant="viewer"`, no session tabs, no `+`. | HEADLESS | `[SEAM 5]` hunks 4-6 |
| T20 | Exactly one real strip after capability settles | Lody session strip plus `W/shell/PaneChrome.tsx` | Desktop shows the Lody strip; the deleted native strip never returns on refresh or a root address. | HEADLESS | `[FIXED] #159`; `[TESTED]` `legacy-tab-strip-deleted.test.ts` |
| T21 | Terminal address stays in step | `W/lody/use-terminal-address-sync.ts:56` | Address, strip selection and rail highlight never disagree. | HEADLESS | `[FIXED]` `f94c87d1` |
| T22 | Host tab survives a tab switch | `W/lody/TerminalTabsStrip.tsx:69` | Hidden, not unmounted — no ttyd reconnect. | HEADLESS | |
| T23 | Host tab survives a refresh | LODY-TERMINAL-TABS §4.4 | Comes back from `webapp_state`; tmux re-attaches. | HEADLESS | |
| T24 | Host tab on a dead session | `W/CloudApp.tsx` `onSessionMissing` | The selection moves to the landing's strip; with no terminal addressed the card stays. | HEADLESS | `[SEAM 5]` hunks 19-20 |
| T27 | Cmd+W over a host tab | LODY-TERMINAL-TABS §5.5 | — | EXCLUDED | Hidden by approved `keyboardShortcuts=false`; no palette or dispatcher mounts. `[FIXED] #151` `[SEAM 7]` |
| T28 | Mobile session tab sheet | `V/components/mobile/mobile-session-tab-sheet.tsx` — session detail below 768 px | The real sheet lists conversation and viewer tabs and selects or closes the supported tab kinds. | HEADLESS | `[FIXED] #171`; `[SEAM 16]`; `[TESTED]` |
| T29 | Mobile terminal tabs in the tab sheet | mobile session tab sheet plus `W/lody/surface-tabs.ts` | Below 768 px, terminal and other host tabs appear beside conversation/viewer tabs and select the mounted host body. | HEADLESS | `[FIXED] #171`; `[SEAM 16]`; `[TESTED]` |
| T30 | Cold-probe tab-strip skeleton | `W/shell/PaneChrome.tsx` | While capability is `probing`, an aria-labelled loading skeleton appears; the deleted native strip never flashes. | HEADLESS | `[FIXED] #159`; `[TESTED]` `lody-terminal-tab-wave3.test.tsx` |
| T31 | Bare workspace root normalizes to chat | `W/lody/use-lody-rail.ts` | On a desktop layout where Lody owns tabs, `/workspaces/:id` replaces to chat even when stored host tabs exist. | HEADLESS | `[FIXED] #159`; `[TESTED]` `lody-terminal-tab-wave3.test.tsx` |
| T32 | Legacy native tab strip stays deleted | `packages/webapp/test/legacy-tab-strip-deleted.test.ts`; shell source | No `WebAppHeader`, native strip marker, drag module, split control, or orphaned strip CSS returns. | HEADLESS | `[FIXED] #159`; `[TESTED]` source pin |

*Section tally: HEADLESS 26 · +PROMPT 1 · HUMAN-EYES 2 · EXCLUDED 1 · total 30.*

---

## 7. Side panels

Five options, built at `V/components/sessions/session-detail.tsx:3455`
(Files `:3459`, All Changes `:3464`, Browser `:3471`, PR `:3478`) plus Side Chat
(`:3484`).

| # | Feature | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| SP1 | "+" add-panel menu | `V/components/sessions/session-side-panel-tab-bar.tsx:312`, items `:323` | Lists panels not yet open; disabled when none remain. | HEADLESS | |
| SP2 | Empty-state panel grid | `session-side-panel-tab-bar.tsx:186`; host `session-detail.tsx:5905` | "Open a panel" tiles. | HEADLESS | |
| SP3 | Select a panel tab | `session-side-panel-tab-bar.tsx:258`, keyboard `:264` | Activates the panel. | HEADLESS | |
| SP4 | Close a panel tab + fallback | `session-side-panel-tab-bar.tsx:292`; rule `:104` | Closes and falls back to the neighbour. | HEADLESS | |
| SP5 | Panel dirty / saving / conflict dot | `session-side-panel-tab-bar.tsx:270` | Yellow, pulsing blue, red. | HEADLESS | |
| SP6 | Hide / show the side region | `session-detail.tsx:5587-5588` | Collapses the right panel. | HEADLESS | |
| SP7 | Panel tab strip scrolls and says so | `W/lody/blitz-skin.css` | With more tabs than fit, the strip scrolls. | HEADLESS | `[FIXED]` `5eaa8498`; `[TESTED]` `lody-side-panel-strip.test.tsx` |
| SP8 | Files panel opens | `session-detail.tsx:3459` | The session workspace file tree renders. | HEADLESS | `[FIXED]` via `lody-code-collab-worktree-root.mjs` + L6/L7 — the "dead Files panel" bug |
| SP9 | File tree select / activate | `V/components/sessions/components/file-tree-view.tsx:304`, `:405` | Enter or click opens a `file:` viewer tab. | HEADLESS | `:594` computes an Electron flag inline — check which arm we take |
| SP10 | Legacy local-error file-tree retry | `V/components/sessions/components/file-tree-view.tsx` | — | EXCLUDED | `[CORRECTED]` Unreachable: remote sessions take the provider path. Its reachable replacement is SP65. |
| SP11 | File tree empty, unavailable, or error | file-tree view and provider boundary | Honest empty/error copy renders; provider-unavailable state offers the reachable retry in SP65. | HEADLESS | `[FIXED] #158`; `[SEAM 10]`; `[TESTED]` |
| SP12 | Quick open file | `V/components/sessions/session-file-quick-open.tsx` | Cmd/Ctrl+P opens the desktop dialog, fuzzy-searches the box file index, and opens the selection. | HEADLESS | `[FIXED] #158`; `[SEAM 10]`; `[TESTED]` |
| SP13 | File viewer (Monaco) | `V/components/sessions/session-file-content-view.tsx`; viewer `session-monaco-text-viewer.tsx` | Renders the file text. | HEADLESS | `:265` reads `__LODY_ELECTRON__`, false here |
| SP14 | Preview toggle (Markdown / HTML) | `session-file-content-view.tsx:1336`, hide `:1339` | Renders a preview; HTML preview explicitly runs scripts. | HEADLESS | |
| SP15 | Markdown source toggle | `session-file-content-view.tsx:1204`, `:1261` | Rendered vs raw. | HEADLESS | |
| SP16 | Copy full Markdown | `session-file-content-view.tsx:1345` | Copies the whole file. | HEADLESS | |
| SP17 | Add HTML annotation | `session-file-content-view.tsx:1365` | Click-to-annotate on the HTML preview. | HEADLESS | `[NEVER RUN]` |
| SP18 | Reload preview | `session-file-content-view.tsx:1380` | Reloads the preview frame. | HEADLESS | |
| SP19 | Wrap lines | `session-file-content-view.tsx:1397` | Toggles word wrap. | HEADLESS | |
| SP20 | Search in file | `session-file-content-view.tsx:1415` | Opens Monaco's find widget. | HEADLESS | |
| SP21 | Save button, with no shortcut promise | `V/components/sessions/session-file-content-view.tsx` | The explicit Save control writes to the box; its title does not advertise Cmd/Ctrl+S. | HEADLESS | `[FIXED] #158`; `[CORRECTED]` user ruling; `[TESTED]` |
| SP22 | Refresh file | `session-file-content-view.tsx:1451` | Re-reads from disk. | HEADLESS | |
| SP23 | Save-conflict resolution | `V/components/sessions/session-file-content-view.tsx` | All four conflict actions render useful localized detail with no raw `{{conflict}}` placeholder. | HEADLESS | `[FIXED] #158`; `[TESTED]` |
| SP24 | Save / live-sync status chips | `session-file-content-view.tsx:1759-1816` | Saved, Unsaved, Saving, Save failed, External change, Conflict, Syncing live. | HEADLESS | |
| SP25 | Lody file-viewer offline chip is absent | `V/components/sessions/session-file-content-view.tsx` | No file-local offline glyph or copy appears; the BlitzOS workspace footer owns the outage. | HEADLESS | `[FIXED] #173`; `[SEAM 15]`; `[SEAM 16]`; `[TESTED]` |
| SP26 | Go to Definition / Find References | file-viewer context actions | — | EXCLUDED | Hidden by approved `languageService=false`. `[FIXED] #158` `[SEAM 10]` `[TESTED]` |
| SP27 | Truncated-file notice | `session-file-content-view.tsx:1236`, `:1278` | "File content was truncated." | HEADLESS | |
| SP28 | Copy file path | desktop viewer header and mobile file drawer | The exact file path lands on the clipboard with confirmation. | HEADLESS | `[FIXED] #158`; `[SEAM 10]`; `[TESTED]` |
| SP29 | Image preview in the viewer | `V/components/sessions/session-file-image-preview.tsx:81` | Opens the zoomable viewer. | HEADLESS | |
| SP30 | Binary file notice | `V/components/sessions/session-file-binary-preview.tsx:29-32` | "This file is binary and can't be diffed yet." | HEADLESS | |
| SP31 | File error states (13 kinds) | `V/components/sessions/session-file-error-state.tsx:43-245`, details `:314` | Distinct copy for not-found, permission, locked, too-large, encoding, outside-workspace, host-unavailable… | HEADLESS | Force each with a crafted path |
| SP32 | All Changes panel | `session-detail.tsx:3464`; data `V/components/sessions/use-session-all-changes-diff-data.ts` | The whole conversation's diff, against the WORKTREE. | HEADLESS+PROMPT | `[FIXED]` `a82800b2` — was silently empty in every worktree session |
| SP33 | Turn-scoped Changes viewer | `session-detail.tsx:2794`, `:2821`, `:2852` | A `diff:` tab scoped to one turn. | HEADLESS+PROMPT | |
| SP34 | Changes sidebar | `V/components/sessions/session-changes-sidebar.tsx:237` | Changed files with add/del counts. | HEADLESS+PROMPT | |
| SP35 | View mode: Types / Files | `session-changes-sidebar.tsx:252`, `:255`; groups `:100-103` | Groups by Code/Docs/Tests/Dev, or a flat list. | HEADLESS+PROMPT | |
| SP36 | Open a changed file's diff | `session-changes-sidebar.tsx:147` | Focuses the diff on that path. | HEADLESS+PROMPT | |
| SP37 | Changes loading / syncing / empty | `session-changes-sidebar.tsx:161-167` | "Loading changes…" / "Syncing changes…" / "No changes yet." | HEADLESS | The empty state is what the worktree bug looked like |
| SP38 | Diff unavailable / too large | `V/components/sessions/session-conversation-diff-panel.tsx:652`, `:288` | "Diff unavailable" / ">1MB to diff". | HEADLESS+PROMPT | |
| SP39 | Per-file diff lazy block | `session-conversation-diff-panel.tsx:189`, skeleton `:56` | Each file's diff renders as it scrolls into view. | HEADLESS+PROMPT | |
| SP40 | Copy file path (diff header) | `V/ui/diff-viewer/diff-file-header-actions.tsx:50` | Copies the path. | HEADLESS+PROMPT | |
| SP41 | Open file (diff header) | `V/ui/diff-viewer/diff-file-header-actions.tsx:65` | Opens it in the viewer. | HEADLESS+PROMPT | |
| SP42 | Add an inline diff comment | `V/ui/diff-viewer/diff-viewer.tsx:935` → `V/ui/diff-viewer/session-comment-add-button.tsx:19` | Hovering a diff line offers "+". | HEADLESS+PROMPT | `[NEVER RUN]` |
| SP43 | Comment draft: Cancel / Comment | `V/ui/diff-viewer/session-comment-draft.tsx:95`, `:122`; note `:114` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| SP44 | GitHub review threads | `V/ui/diff-viewer/github-comment-thread.tsx:174,181,275` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| SP45 | Diff focus scroll | `V/components/sessions/use-diff-focus-scroll.ts` | Auto-scrolls to the focused file when a diff tab opens. | HEADLESS+PROMPT | |
| SP46 | Side Chat launcher | `session-detail.tsx:3484`; state `V/lib/session-side-chat.ts` `getSideChatLauncherState` | Forks the active conversation into the side panel. | HEADLESS+PROMPT | |
| SP47 | Side Chat disabled before an assistant turn | `session-detail.tsx:3358` (hunk 24) | Disabled, not silently refused. | HEADLESS | `[FIXED]` `d64d3920` `[SEAM 6]`; `[TESTED]` `lody-side-chat-guard.test.tsx` |
| SP48 | Side Chat tab title | `session-detail.tsx:3583` | The side session's own title, falling back to "Side Chat". | HEADLESS+PROMPT | |
| SP49 | Close Side Chat | `session-detail.tsx:4098` | Closes it; "Unable to close side chat" on failure. | HEADLESS+PROMPT | |
| SP50 | Side Chat fork failure paths | `session-detail.tsx:1327`, `:1352`, `:3388` | Three distinct toasts. | HEADLESS+PROMPT | Now that `<Toaster/>` is mounted these are visible |
| SP51 | Browser panel | `session-detail.tsx:3471`; `V/components/sessions/session-browser-panel.tsx:169`, `:265`, `:444` | — | ELECTRON-N/A | The local endpoint is `isElectronRenderer() && machinePlane === 'local'` |
| SP52 | Browser toolbar (back/forward/reload/address) | `V/components/sessions/session-browser-toolbar.tsx:115,122,133,153` | — | ELECTRON-N/A | Depends on SP51 |
| SP53 | Annotate page | `session-browser-toolbar.tsx:188`; composer `V/components/sessions/managed-preview-surface.tsx:735` | — | ELECTRON-N/A | Depends on SP51 |
| SP54 | Share preview / stop sharing | `session-browser-toolbar.tsx:199`, `:207` | — | EXCLUDED | Lody-cloud tunnel; BlitzOS has its own preview links |
| SP55 | Managed preview iframe | `V/components/sessions/managed-preview-surface.tsx:316` | — | EXCLUDED | Lody-cloud managed previews |
| SP56 | Visual annotation pins overlay | `V/components/preview/visual-annotation-comments-overlay.tsx:252,416,205` | — | ELECTRON-N/A | Depends on SP51 |
| SP57 | PR panel | `session-detail.tsx:3478` → `V/components/sessions/pr-tab-view.tsx` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| SP58 | PR merge + method | `pr-tab-view.tsx:704`, `:721` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| SP59 | PR close / reopen / delete branch / ready | `pr-tab-view.tsx:688,907,931,867` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| SP60 | PR checks summary + permissions | `pr-tab-view.tsx:266`, `:321` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| SP61 | PR comment composer | `pr-tab-view.tsx:1045`, `:1054` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |
| SP62 | Mobile Files drawer | mobile session detail below 768 px | The Files drawer opens, browses the project, and hands a selected file to the viewer. | HEADLESS | `[FIXED] #171`; the old composite row is split into SP62, SP68, and SP69. |
| SP63 | Project file browser | `V/components/files/project-file-browser.tsx:95` | — | EXCLUDED | Reachable only from the local-project page, which is a stub |
| SP64 | Terminal dock toggle | `session-detail.tsx:638`; host `V/components/terminal-dock-host.tsx:26`, `:54` | — | ELECTRON-N/A | Two hard gates; upstream's own docs say desktop-only |
| SP65 | Provider-unavailable file-tree retry | file provider boundary and file-tree unavailable panel | "Try again" increments the provider reload nonce; offline-to-online also re-arms the acquire. | HEADLESS | `[FIXED] #158`; `[SEAM 10]`; `[TESTED]` |
| SP66 | Diff body custom element registration | `@pierre/diffs`; postinstall side-effect entry | Every All Changes and turn-scoped diff renders a real `<diffs-container>` body, not an empty host element. | HEADLESS+PROMPT | `[FIXED] #168`; `[TESTED]`; prominent because this regressed once. |
| SP67 | Collapsed side-panel controls stay onscreen | `W/lody/blitz-skin.css` — collapse the side panel at a narrow desktop width | Add-panel and show-sidebar controls remain inside the viewport and keep usable hit targets. | HUMAN-EYES | `[FIXED] #158`; `[TESTED]` |
| SP68 | Mobile Pull Request drawer | mobile session detail PR drawer | — | EXCLUDED | The mobile shell now mounts, but `githubIntegration=false` leaves no PR to open. `[FIXED] #171` |
| SP69 | Mobile Browser drawer | mobile session detail browser drawer | — | ELECTRON-N/A | The drawer shell mounts, but `SessionBrowserPanel` still requires the Electron local endpoint. #171 does not remove that gate. |

**Not present:** there is no split/unified diff view-mode toggle and no
stage/discard control anywhere in this tree. The diff surface is read-only plus
commenting; git writes go through the PR panel and the agent quick actions.

*Section tally: HEADLESS 33 · +PROMPT 16 · HUMAN-EYES 1 · ELECTRON-N/A 6 · EXCLUDED 13 · total 69.*

---

## 8. Worktrees

| # | Feature | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| WT1 | Worktree cut on create | `W/lody/workdir-default.ts`; daemon `session-manager.ts:1932` | A `lody/<id12>` branch and a worktree directory appear. | HEADLESS | `[TESTED]` `lody-worktree-session.test.ts` (free path, no turn) |
| WT2 | Grouped under GitHub Worktrees | `W/lody/SessionRailSidebar.tsx`; project backfill | A repo-backed row lands under its repository, including sessions created before the remote arrived. | HEADLESS | `[FIXED] #157`; `[TESTED]` `lody-rail-groups.test.tsx` |
| WT3 | Branch named in the info bar | `V/components/sessions/session-info-bar.tsx` | The worktree branch is stated. | HEADLESS | |
| WT4 | Worktree chip + copy path | `V/components/sessions/session-info-chips.tsx:503,525` | "Copied the path to the worktree". | HEADLESS | |
| WT5 | Worktree indicator on a rail row | `V/components/sidebar-row-shared.tsx`; `session-list.tsx` | A worktree-backed SessionList row carries the visible Worktree glyph. | HEADLESS | `[FIXED] #157`; `[SEAM 9]`; `[TESTED]` |
| WT6 | Hover card shows Worktree, not Branch | `V/components/session-info-hover-card.tsx:351`, `:360` | The card swaps the field. | HUMAN-EYES | |
| WT7 | Diff stats / badges | `V/components/session-list.tsx:1020` | `+n -n` after an editing turn. | HEADLESS+PROMPT | Skipped when `githubRepoFullName` is missing |
| WT8 | All Changes resolves to the WORKTREE | `packages/box/patches/lody-code-collab-worktree-root.mjs` | Not the `/workspace/<repo>` clone, which is clean by design. | HEADLESS+PROMPT | `[FIXED]` `a82800b2` |
| WT9 | Fork into a NEW worktree | `V/components/sessions/session-fork-destination-menu.tsx:46-53` | A new session from the latest committed HEAD in a fresh worktree. | HEADLESS+PROMPT | |
| WT10 | Worktree availability probe | `session-detail.tsx:4234` (`resolveForkWorktreeAvailability`) | `hidden` / `checking` / `available`; "Checking Git status…" disables the option. | HEADLESS+PROMPT | |
| WT11 | Dirty-worktree fork confirm | `session-detail.tsx:4633`, action `:4656` | Proceeds from committed HEAD, dropping uncommitted work. | HEADLESS+PROMPT | |
| WT12 | Archive with backup commit | `V/components/session-list.tsx:1111` → daemon archive | `chore: archive backup…` is made and the branch kept. | HEADLESS | Needs `W/lody/local-projects.ts`'s `machineMeta.localProjects` mirror, or it resolves nothing |
| WT13 | Worktree setup/cleanup script output | `V/components/ai-gui/view.tsx:2455-2457` | Per-step output streams into the transcript. | HEADLESS+PROMPT | Scripts are configured from a stubbed settings page |
| WT14 | Worktree cleanup on project removal | `V/components/loro-app-sidebar.tsx:387,394,405` | — | EXCLUDED | The Local Projects sidebar section is not mounted (R35) |
| WT15 | Merge / PR from a worktree | `pr-tab-view.tsx:704`; quick actions `session-chat-interface.tsx:4467-4501` | — | EXCLUDED | Hidden by approved `gitHubIntegration=false`. `[FIXED] #151` `[SEAM 7]` |

*Section tally: HEADLESS 6 · +PROMPT 6 · HUMAN-EYES 1 · EXCLUDED 2 · total 15.*

---

## 9. Sharing

Control plane `core/session-shares.ts`; dialog `W/SessionShareDialog.tsx`.

| # | Feature | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| SH1 | Open the share dialog | `W/SessionShareDialog.tsx:56` via `W/lody/SessionRailSidebar.tsx:357` | A row per other member, three level buttons each. | SECOND-ACCOUNT | |
| SH2 | Grant read-only | `W/SessionShareDialog.tsx:101` | An `ro` row; the grantee's rail gains the session. | SECOND-ACCOUNT | `[TESTED]` `control-plane/test/session-shares.test.ts` |
| SH3 | Grant read-write | same | An `rw` row; the grantee gets a composer. | SECOND-ACCOUNT | |
| SH4 | Revoke ("No access") | `W/SessionShareDialog.tsx:99` | The row goes AND the live WebSocket is drained. | SECOND-ACCOUNT | A failed drain does not fail the revoke — check both halves |
| SH5 | Viewer cannot receive RW | `W/SessionShareDialog.tsx:158` | The button is disabled with a title explaining why. | SECOND-ACCOUNT | The server also refuses with a 400 |
| SH6 | Re-grant at a different level | `W/SessionShareDialog.tsx:101` (`PUT` upserts) | 201 for a new row, 200 for a level change. | SECOND-ACCOUNT | |
| SH7 | "This workspace has no one else in it yet" | `W/SessionShareDialog.tsx:140` | The honest empty state in a solo workspace. | SECOND-ACCOUNT | |
| SH8 | Admin implicit read-only | LODY-SHARING §1.2 | An admin sees any session with no grant row. | SECOND-ACCOUNT | `[TESTED]` control-plane only; never driven in a browser |
| SH9 | Grantee opens a shared session | `W/lody/LodySessionsRegion.tsx:190` | The runtime tears down and rebuilds against the OWNER's box. | SECOND-ACCOUNT | Exactly one surface at a time (§10.2) |
| SH10 | RO grantee: transcript renders | `W/lody/SessionSurface.tsx:526` | Title and history render; no composer, no permission buttons. | SECOND-ACCOUNT | `[SEAM 4]`; `[TESTED]` `lody-shared-surface.test.tsx` |
| SH11 | RO grantee: diffs and file views | LODY-SHARING §0 | The worktree's diffs and files are readable. | SECOND-ACCOUNT | `[NEVER RUN]` in a browser |
| SH12 | RW grantee sends a prompt | `W/lody/SessionSurface.tsx:526` with `readOnly=false` | The prompt lands AND dispatches (`latestUserMsgId` is writable). | SECOND-ACCOUNT | The metadata allowlist is three fields (§10.2 item 2) |
| SH13 | RW grantee answers a permission request | `V/components/sessions/floating-permission-request.tsx:244` | First answer wins and the agent acts on it. | SECOND-ACCOUNT | **NOT PROVEN** — LODY-SHARING §10.5 |
| SH14 | RW grantee's rename converges away | LODY-SHARING §10.2 item 2 | The rename does not land; the relay drops it. | SECOND-ACCOUNT | The header still OFFERS rename/archive/delete/fork |
| SH15 | Grantee gets no terminal tabs | `W/lody/LodySessionsRegion.tsx:204` | No `surfaceTabs` at all on a shared surface. | SECOND-ACCOUNT | LODY-TERMINAL-TABS §5.1 |
| SH16 | "+ New session" returns to the grantee's own box | `W/lody/SessionRailSidebar.tsx:464` | Their own landing, their own runtime. | SECOND-ACCOUNT | |
| SH17 | Shared row titles | `W/lody/shared-sessions.ts:1` | Each row shows the owner's title, read from the projected meta room. | SECOND-ACCOUNT | `[TESTED]` `lody-sharing-relay.test.ts` |
| SH18 | Switching between two owners' shared sessions | `W/lody/LodySessionsRegion.tsx:194` (key by owner membership) | Rebuilds the runtime across owners, not across sessions on one box. | SECOND-ACCOUNT | Needs three members |

*Section tally: SECOND-ACCOUNT 18 · total 18.*

---

## 10. Terminals

BlitzOS keeps ttyd + tmux as the tab CONTENT and adopts Lody's tab CHROME.

| # | Feature | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| TM1 | `+ New tab` control | `W/lody/SessionRailSidebar.tsx:432` → `W/NewTabControl` | A menu with terminal / Claude / Codex / preview entries. | HEADLESS | |
| TM2 | Spawn a shell tab | `W/CloudApp.tsx` (`spawnTtydSession`) | ttyd attaches a fresh tmux session. | HEADLESS | |
| TM3 | Spawn a Claude Code TUI tab | same menu | `blitz-term` launches the Claude TUI in tmux. | HEADLESS | |
| TM4 | Spawn a Codex TUI tab | same menu | Same for Codex. | HEADLESS | |
| TM5 | Open a preview port as a tab | `W/CloudApp.tsx` (`openPreviewPort`) | The port opens as a tab in the same strip. | HEADLESS | |
| TM6 | Open a preview link as a tab | `W/CloudApp.tsx` (`openPreviewLink`) | Same for a public link. | HEADLESS | |
| TM7 | Terminal keyboard I/O | `W/SurfaceTabContent.tsx:70` | Typing reaches the shell; output paints. | HEADLESS | |
| TM8 | Terminal copy / paste | `W/terminal-touch-controller.ts` + ttyd | Selection copies; paste reaches the shell. | HUMAN-EYES | |
| TM9 | Terminal resize | `W/SurfaceTabContent.tsx:64` | tmux re-flows to the pane geometry. | HUMAN-EYES | |
| TM10 | Terminal survives a refresh | LODY-TERMINAL-TABS §4.4 | tmux keeps the process; the tab re-attaches. | HEADLESS | |
| TM11 | Sign-in URL capture from a terminal | `W/CloudApp.tsx` (`onSignInUrl`) | A device-code URL printed in the terminal is surfaced. | HUMAN-EYES | The hand path for L10/L11 |
| TM12 | Lody PTY dock toggle | `V/components/sessions/session-detail.tsx:638`; host `V/components/terminal-dock-host.tsx:26`, `:54` | — | ELECTRON-N/A | |
| TM13 | Lody dock: new / select / close terminal | `V/components/terminal/terminal-dock.tsx:528,504,516` | — | ELECTRON-N/A | Channel is `null` without the IPC bridge (`electron-terminal-channel.ts:69-71`) |
| TM14 | Lody dock: resize / collapse | `terminal-dock.tsx:483-488`, `:554` | — | ELECTRON-N/A | |
| TM15 | Lody terminal copy / paste (kbd + menu) | `V/components/terminal/local-terminal-panel.tsx:162,168,373-390` | — | ELECTRON-N/A | |
| TM16 | Lody terminal keyboard selection | `local-terminal-panel.tsx:176-199`; logic `terminal-keyboard-selection.ts` | — | ELECTRON-N/A | |
| TM17 | Lody terminal scrollback + replay on re-attach | `local-terminal-panel.tsx:136`, `:232-242` | — | ELECTRON-N/A | |
| TM18 | Lody terminal font / theme settings | `V/components/settings/appearance-setting.tsx:253-308`, gate `:354` | — | ELECTRON-N/A | |
| TM19 | Ctrl+` / ⌘J toggle terminal | `V/lib/commands/shortcuts.ts:78` (`electron(...)`) | — | ELECTRON-N/A | Declared Electron-only, and no dispatcher is mounted either |
| TM20 | Lody's own PTY dock tab strip | `V/components/terminal/terminal-dock.tsx` | — | ELECTRON-N/A | Still Electron-only. #159 deleted BlitzOS `WebAppHeader`, not this unreachable vendored dock. |
| TM21 | Close a terminal from its rail row | `W/lody/SessionRailSidebar.tsx`; shell close handler | Desktop, mobile, and old-box layouts can close from the rail; the row disappears and its tmux session is killed. | HEADLESS | `[FIXED] #154`; `[FIXED] #159`; `[TESTED]` |

**Not present in Lody's terminal at all** (so BlitzOS is not missing them):
search-in-terminal, clear, rename a tab, reorder tabs, split panes, a reconnect
button, and a working-directory display.

*Section tally: HEADLESS 9 · HUMAN-EYES 3 · ELECTRON-N/A 9 · total 21.*

---

## 11. Global, settings and misc

| # | Feature | Entry point | Expected behavior | Class | Notes |
|---|---|---|---|---|---|
| X1 | Command palette (⌘K / ⌘⇧P) | `V/components/commands/command-palette.tsx:39`; mounted only by `routes/$workspaceName/_auth.tsx:91` | — | EXCLUDED | Hidden by approved `keyboardShortcuts=false`; no palette or dispatcher mounts. `[FIXED] #151` `[SEAM 7]` |
| X2 | Palette search + interleaved session results | `command-palette.tsx:144-168`; scoring `V/components/commands/fuzzy-match.ts:16` | — | EXCLUDED | Hidden by approved `keyboardShortcuts=false`; no palette or dispatcher mounts. `[FIXED] #151` `[SEAM 7]` |
| X3 | Global keyboard dispatcher | `V/lib/commands/registry.ts:107-114`; attached by `V/components/AppInitializer.tsx` | — | EXCLUDED | Hidden by approved `keyboardShortcuts=false`; no palette or dispatcher mounts. `[FIXED] #151` `[SEAM 7]` |
| X4 | The 30+ registered commands | `V/lib/commands/built-ins.ts:28-229`; session ones `session-detail.tsx:3842-4184` | — | EXCLUDED | Hidden by approved `keyboardShortcuts=false`; no palette or dispatcher mounts. `[FIXED] #151` `[SEAM 7]` |
| X5 | Shortcut customization / reset / unbind | `V/components/settings/keyboard-shortcuts-setting.tsx:96,351,355` | — | EXCLUDED | Hidden by approved `keyboardShortcuts=false`; no palette or dispatcher mounts. `[FIXED] #151` `[SEAM 7]` |
| X6 | Global OS accelerators (`app.focus`) | `V/lib/commands/shortcuts.ts:114-129` | — | ELECTRON-N/A | Registered by the Electron main process |
| X7 | Lody settings affordances | Lody settings hooks and suppressed entry points | — | EXCLUDED | Settings is KILL. Desktop hints are gone and the mobile home gear is scrubbed. `[FIXED] #151` `[SEAM 7]` `[SEAM 16]` |
| X8 | The 20 Lody settings pages | `W/lody/router.tsx` versus upstream settings route directory | All twenty addresses resolve safely to empty stubs; no Lody settings affordance reaches them. | EXCLUDED | `[FIXED] #151`; `[TESTED]` `lody-v1-scope-sources.test.ts`; BlitzOS settings are X29-X30. |
| X9 | Archive page | `W/lody/router.tsx`; `V/components/archive/archive-view.tsx` | Search, sort, group, selection, and archive rows work; team scope and PR badges stay hidden by v1 scope. | HEADLESS | `[FIXED] #164`; `[SEAM 13]`; `[SEAM 14]`; `[TESTED]` |
| X10 | Tasks pages (board, list, detail, quick-add, inbox) | `V/components/tasks/**` | — | EXCLUDED | `W/lody/router.tsx:362-376` stubs them; also behind a beta guard upstream |
| X11 | Local-project page | `W/lody/router.tsx:398` | — | EXCLUDED | Stubbed; upstream it is only a redirect anyway |
| X12 | Onboarding (7 steps) | `V/routes/onboarding.tsx:13`, gate `:68` | — | ELECTRON-N/A | `if (!isElectronRenderer()) return <Navigate to="/" />` |
| X13 | Mobile layout and stack | `W/lody/MobileSessionStack.tsx`; Lody breakpoint 768 px | Below 768 px, the real Lody landing is the mounted base and session detail opens as a full-width right drawer. | HEADLESS | `[FIXED] #171`; `[SEAM 16]`; `[TESTED]` |
| X14 | Mobile screens, sheets, and gestures | `V/components/mobile/**`; `W/lody/MobileSessionStack.tsx` | Mobile home/project screens, back, drawer close, and edge-swipe geometry use the real Lody branch. | HUMAN-EYES | `[FIXED] #171`; `[SEAM 16]` |
| X15 | Push notifications | `V/components/settings/general-setting.tsx:737-771` (OneSignal) | — | EXCLUDED | OneSignal is not mounted (`W/lody/SessionSurface.tsx:16-22`) |
| X16 | Agent session orchestration | MCP tool `lody_session_create` and opener tree | — | EXCLUDED | Deferred by approved v1 scope. R18, IC22, and IC50 remain testable only with prebuilt fixture state. |
| X17 | Bug report dialog | `V/components/bug-report/bug-report-dialog.tsx:132,161,204` | — | EXCLUDED | Reached only from the suppressed footer; uploads to Lody cloud |
| X18 | i18n | `W/lody/i18n.ts:1` | English only, flat dotted keys, `keySeparator: false`. | HEADLESS | A missing key renders the raw dotted string — a good sweep signal |
| X19 | Tailwind containment / token collisions | `W/lody/lody-compensation.css`, `W/lody/lody-surface.css` | Vendored styles do not leak out and shell styles do not reach in. | HUMAN-EYES | `[TESTED]` `lody-tailwind-containment.test.ts`, `lody-token-collisions.test.ts` |
| X20 | Unsupported IPC channel report | `W/lody/SessionSurface.tsx:150` | Empty is the healthy answer after a full session round trip. | HEADLESS | A new upstream call site shows up here instead of as a silent rejection |
| X21 | Resizable panels | `W/lody/lody-surface-shell.css` | The chat / side-panel sash drags and persists. | HUMAN-EYES | `[TESTED]` `lody-resizable-panels.test.tsx` |
| X22 | Error-boundary fallback + copy report | `V/components/error-boundary-fallback.tsx`; builder `V/lib/error-boundary-report.ts` | Shows the real error and a one-click copy on every build. | HEADLESS | Bounded auto-reset (`MAX_AUTOMATIC_RESETS`) |
| X23 | Stuck-connection banner (45 s) | `V/components/stuck-connection-banner.tsx` | — | EXCLUDED | Mounted only in `MainLayout` |
| X24 | Clear local cache on boot | `V/lib/clear-local-cache.ts`; `maybeClearLodyCacheOnBoot` | Runs once per page load from `RuntimeProvider` before opening IndexedDB. | HEADLESS | The trigger UI lives on a stubbed settings page |
| X25 | Fabric sidebar background (WebGL2) | `V/components/fabric/sidebar-fabric.tsx`; simulator `fabric-simulator.tsx:353` | Decorative; no user controls. | HUMAN-EYES | Watch for a GPU-less canary VM |
| X26 | Device resource monitoring | `V/components/settings/device-resource-monitor.tsx:41` | — | EXCLUDED | Lives on a stubbed settings page |
| X27 | Lody Review (HTML report) | `V/packages/code-review-viewer` | — | EXCLUDED | A separate CLI product |
| X28 | Workspace switcher / create / invite | `V/components/loro-sidebar.tsx:936,956,960` | — | EXCLUDED | Suppressed header |
| X29 | BlitzOS settings surface ladder | BlitzOS Settings layout and stylesheet | Each settings page uses the redesigned surface hierarchy, spacing, headings, and responsive layout in both themes. | HUMAN-EYES | `[FIXED] #150` |
| X30 | Organization switcher in Settings → Profile | BlitzOS Settings Profile organizations section | Current organization is badged; Switch changes organization; Create organization uses the approved control. | HEADLESS | `[FIXED] #150`; `[FIXED] #162`; `[TESTED]` |
| X31 | Interrupted stop remains recoverable | machine lifecycle intent and start recovery path | An interrupted stop settles back to stopped/recoverable state; Start reuses the same workspace volume instead of stranding it. | HEADLESS | `[FIXED] #165`; `[TESTED]` |
| X32 | Mobile workspace navigation drawer | `W/shell/PaneChrome.tsx`; shell drawer | The labelled hamburger opens the workspace/rail drawer, reports expanded state, and closes after navigation. | HEADLESS | `[FIXED] #159`; `[FIXED] #171`; `[TESTED]` |
| X33 | Mobile landing remains mounted under detail | `W/lody/MobileSessionStack.tsx` | Opening and closing a session preserves the landing draft, scroll, selected context, and close animation. | HEADLESS | `[FIXED] #171`; `[SEAM 16]`; `[TESTED]` |
| X34 | Mobile scrubbed surfaces stay absent | `W/lody/v1-scope.ts`; mobile-only seam wiring | No Lody settings gear, product download hint, cloud menu rows, notification prompt, Agent Roles, connection banner, or LSP action appears. | HEADLESS | `[FIXED] #171`; `[FIXED] #173`; `[SEAM 16]`; `[TESTED]` |
| X35 | Documented 768–899 px boundary | Lody `use-mobile.ts` (768 px); `W/mobile-webapp.ts` (900 px) | Below 768 uses Lody mobile. From 768 through 899 the shell uses its drawer while Lody intentionally uses desktop layout; 900+ is desktop/desktop. | HEADLESS | `[FIXED] #171`; assert 767, 768, 899, and 900 px. |

*Section tally: HEADLESS 12 · HUMAN-EYES 5 · ELECTRON-N/A 2 · EXCLUDED 16 · total 35.*

---

## 12. Counts per class

| Class | §1 | §2 | §3 | §4 | §5 | §6 | §7 | §8 | §9 | §10 | §11 | **Total** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| HEADLESS | 16 | 25 | 5 | 82 | 31 | 26 | 33 | 6 | 0 | 9 | 12 | **245** |
| HEADLESS+PROMPT | 3 | 3 | 1 | 12 | 51 | 1 | 16 | 6 | 0 | 0 | 0 | **93** |
| SECOND-ACCOUNT | 0 | 2 | 0 | 2 | 2 | 0 | 0 | 0 | 18 | 0 | 0 | **24** |
| HUMAN-EYES | 3 | 2 | 0 | 0 | 4 | 2 | 1 | 1 | 0 | 3 | 5 | **21** |
| ELECTRON-N/A | 0 | 1 | 0 | 1 | 4 | 0 | 6 | 0 | 0 | 9 | 2 | **23** |
| EXCLUDED | 0 | 8 | 6 | 23 | 13 | 1 | 13 | 2 | 0 | 0 | 16 | **82** |
| **Section total** | **22** | **41** | **12** | **120** | **105** | **30** | **69** | **15** | **18** | **21** | **35** | **488** |

Counted mechanically from §§1–11. Retired ids are outside active class totals.

**Reachable surface to sweep: 383 rows** (HEADLESS + HEADLESS+PROMPT +
SECOND-ACCOUNT + HUMAN-EYES). The other 105 rows remain as explicit
gates, so a sweep agent does not file bugs against descoped or Electron-only UI.

**Delta from v1:** 102 surviving rows changed · 27 new rows ·
2 retired rows · 488 active rows.

---

## 13. The ten rows most likely broken

The ranking now favors the most recent state-machine seams, the mobile reversal,
and paths that have already regressed silently.

| Rank | Row | Why |
|---|---|---|
| 1 | **L20 — workspace switch restores the right runtime and chat** | #181 added seam 17 after stale implicit workspace state selected the previous runtime. It can look healthy while showing the wrong workspace, so assert identity and address together. |
| 2 | **SP66 — diff body registration** | #168 repaired a packaging side-effect regression that left a valid diff host with no rendered body. Exercise both All Changes and turn-scoped diffs after every install or vendor bump. |
| 3 | **L18 — sessions arrive without reload** | #170 repaired four independent latches. Test a no-machine to provisioned transition and a transient capability/transport failure in the same browser page. |
| 4 | **L22 — daemon watchdog recovery** | #167 and #178 span the image, s6, health endpoint, grace window, and canary flag. A process may exist while the UI remains permanently disconnected. |
| 5 | **L21 — fresh-token tunnel gate** | #169/#172 coordinate bootstrap cleanup, token delivery, a marker, and cloudflared. A stale marker produces the worst shape: a tunnel that starts successfully with dead credentials. |
| 6 | **T29 — terminal tabs in the mobile sheet** | Seam 16 widens a vendored discriminated union and forwards selection/close callbacks through the early mobile fork. A vendor merge can drop one hunk while ordinary conversations still work. |
| 7 | **IC89 — archive restore** | The route, footer seam, session mutation, and rail refresh all must agree. Restore can succeed in storage yet leave the row stranded until reload. |
| 8 | **SH13 — RW grantee answers a permission request** | The relay half is proven; the complete viewer-to-daemon answer remains unproven. Attach the viewer before dispatch and locate buttons outside the card header. |
| 9 | **C120 — landing image tokenless fallback** | Seam 12 crosses the image and file draft state machines. It must degrade only without a cloud token and preserve the normal cloud path when one exists. |
| 10 | **C2 — composer plain-text fallback** | A delayed project/catalog registration silently removes every mention trigger while leaving a plausible textarea. Assert `@`, `$`, and `/`, not merely that text can be entered. |

**Cheap runners-up.** R40 during a machine-type change; X31 after an interrupted
stop; X35 at 767/768/899/900 px; C10's Stop-to-Send swap; and SP65 after an
offline-to-online edge.

---

## 14. What a sweep agent needs, per class

### HEADLESS — 245 rows

- Use a canary origin and a workspace whose machine is running and whose Lody
  capability eventually probes `present`. Poll through the agent-config and
  capability gates; never make a one-shot assertion during boot.
- A **D1-minted session cookie is only web control-plane authentication**. Mint it
  in the D1 database serving the target origin, bind it to a principal who is an
  active member of the target organization/workspace, and keep separate browser
  profiles for distinct principals. It does not itself mint a box credential,
  workspace surface ticket, Cloudflare tunnel token, or Claude credential.
- Do not reuse a cookie copied from another origin or deployment. The row may
  authenticate yet fail organization membership, ticket issuance, or box routing.
  That is fixture failure, not a Lody connection-status assertion.
- Both gates must be on: `VITE_BLITZ_LODY_SESSIONS=true` in the web build and
  `BLITZ_LODY_SESSIONS=1` in the box image. #178 repaired a canary image that
  omitted the box half.
- **The sanctioned box automation path is `CP/core/machine-plane.ts`.** Use the
  box credential for its narrow machine-plane routes to list/view workspaces and
  machine types, and to provision/start/stop/recreate machines. It is not a
  browser session and it exposes no workspace create/delete route. Destructive
  ownership checks still apply: a box agent cannot recreate or delete a
  person-created machine.
- **One lane, one box container.** Concurrent lanes need distinct container
  names, state volumes, workspace bind mounts, SSH host ports, tunnel ports,
  browser profiles, and recorded fixture ids. Never point two mutation lanes at
  one `webapp_state` document or one daemon data directory.
- **Port 17789 belongs to the box Lody daemon.** It is the local profile's
  single-instance host lease and a reserved preview port, not a browser endpoint.
  A host-side daemon harness will fail or attach to the wrong process if it shares
  that namespace. Run it in the lane's isolated container/network namespace; do
  not kill a shared box daemon to free the port.
- Box fixtures still need a GitHub-remote clone for rail/worktree metadata, a
  clone with two branches for C67, a project with `.claude/skills/` for C20, a
  non-git directory for C71, and an over-limit file for SP27/SP31.
- Prefer roles and `aria-label` selectors. At mobile boundaries test 767, 768,
  899, and 900 px; X35 documents the mixed shell/Lody interval.

### HEADLESS+PROMPT — 93 rows

- Add a Claude credential signed in on the box. A D1 session cookie never supplies
  it. Use Lody's ACP panel or a terminal login; the image must carry the ACP auth
  queue patch or code submission can deadlock behind the login command.
- Group paid turns. One editing turn can cover rail diff stats, worktree state,
  All Changes, turn diffs, file mutations, and transcript tool rows.
- For permission rows, attach the second-account viewer before dispatch. Presence
  gates the card, and its answer buttons are siblings of the header rather than
  descendants. Set permission mode to Manual before a turn that must ask.

### SECOND-ACCOUNT — 24 rows

- Use two distinct principals and browser profiles in one workspace. The owner
  box must remain up because a grantee reaches that box, not their own.
- Add an admin who owns neither session for SH8, a workspace viewer for SH5, and
  a third box for SH18. Treat one-time invite codes as secrets.
- Exactly one Lody surface owns `window.ipc` at once. Do not mount an own and a
  shared surface concurrently; assert both row removal and socket closure for SH4.

### HUMAN-EYES — 21 rows

- Capture both themes. For desktop geometry cover 900 px and a wide viewport;
  for mobile cover 767 px. Also inspect 768 and 899 px, where the shell uses its
  mobile drawer while Lody intentionally uses desktop layout.
- Judge shiki, mermaid, hover cards, panel containment, settings hierarchy,
  mobile drawer motion, and the WebGL fabric background visually.
- Use real pointer gestures for terminal selection/paste, panel resize, tab drag,
  and the mobile edge swipe. ACP device login remains a human/popup path.

### ELECTRON-N/A — 23 rows; EXCLUDED — 82 rows

Nothing to run as a product feature. If one becomes reachable, the reachability
is itself the finding. Mobile being mounted does **not** remove Electron gates:
the Browser drawer shell now exists, but `SessionBrowserPanel` still requires the
Electron local endpoint, and `MobileSessionStack` does not mount `TerminalDockHost`.
For HIDE/KILL areas, test their absence through the explicit HEADLESS ownership
rows or the source/DOM scope tests, not by trying to complete the excluded flow.

---

## 15. Sweep-1 corrections applied

- S2 and COMPB-2 were refuted; S2 and C76 retain their positive expectations.
- C5 now states the user ruling: Cmd+Enter submits.
- S11 is EXCLUDED because the cloud query is absent under local capabilities.
- SP10 is EXCLUDED as an unreachable legacy branch; SP65 covers the reachable
  provider-unavailable retry added by #158.
- Agent Roles and MCP rows are EXCLUDED under the approved HIDE decision.
- T18 states close-to-kill and cites #154.
- The current patch ledger contains seams **1–17**. The scope plan's index ends at
  16, but #181 added seam 17 for workspace-switch runtime snapshot reset.
- No merged unknown-workspace-id not-found change exists in `origin/main`.
  #181 fixes a stale implicit local workspace id, which is recorded separately in L20.

---

## 16. Retired rows

Retired ids stay here so regression baselines never mistake deletion for omission.
They are not included in §12 class totals.

| # | Former feature | Reason |
|---|---|---|
| T25 | Host tab drag-reorder | #159 deleted the legacy drag modules and their only handle; custom host tabs remain fixed-order in the surviving Lody strip. |
| T26 | Split view through the legacy pane strip | #159 deleted `splitTab`, `otherRegion`, pane-drop geometry, and the UI path that invoked them. |
