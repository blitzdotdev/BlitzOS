# BlitzOS divergences from upstream Lody

Every deliberate edit inside `vendor/lody` is listed here, with the file, the
upstream anchor it depends on, and the reason. This is the conflict manual; the
single merge procedure is `docs/LODY-MERGE.md`. The target daemon design and
migration are in `plans/LODY-DAEMON-FROM-TREE.md`.

**The rule: nothing in `vendor/lody` is edited except at a declared seam.**
Everything BlitzOS-specific lives in `packages/webapp/src/lody/`. If a vendored
component cannot render without a change, stub around it from there or record a
blocker — do not patch the vendor tree.

The runbook classifies every touched seam consistently: class A means upstream
now supplies the behavior and the seam is deleted; class B means the same
behavior is re-anchored with the drill below; class C means the mechanism or
product meaning changed and a human must decide.

## Seam patches

### 1. The local-bridge predicate (phase 2, 2026-08-30)

**One idea, six hunks in three files, all the same shape.** BlitzOS reaches the
Lody daemon from a browser, not from Electron, so it installs `window.ipc`
(`packages/webapp/src/lody/local-bridge.ts`) and sets
`window.__LODY_LOCAL_BRIDGE__` instead of `window.__LODY_ELECTRON__`. Setting the
Electron flag is not an option: 44 sites read it — window controls in
`routes/__root.tsx`, `electron-menu-handler`, `use-electron-updater-state`, the
native theme bridge (`theme-provider.tsx:87`), OneSignal,
`loro-app-sidebar.tsx:510` — and a browser satisfies none of them.

The DATA plane needs no patch at all: `createLocalLoroDataPlaneConnection`
(`providers/local-loro-data-plane-connection.ts:8`) gates only on
`getIpcServices()`, which is a generic proxy over `window.ipc`. Five guards on
the LOCAL RPC and session-control planes additionally require the Electron flag,
and in `syncMode: 'local'` the cloud fallback behind each of them throws by
design (`create-workspace-runtime.ts:1943`, `:2342`), so each is a hard failure
rather than a degraded path.

Every hunk is strictly additive — the predicate can only become true where it
was false — so upstream Electron behaviour is unchanged. Open upstream as
"allow a non-Electron local bridge".

| # | File | Line (at `f4b1ba25`) | Upstream anchor | What it gates |
|---|---|---|---|---|
| 1 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 120 | `window.__LODY_ELECTRON__ &&` inside `canUseLocalMachineRpc`'s `Boolean(...)` | every local Machine RPC, including `session/dispatch-turn` |
| 2 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 182 | `const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__;` | `file/preview-local`; without it a local path is sent to Streams |
| 3 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 999 | `window.__LODY_ELECTRON__ &&` in `requestLocalProjectGitState` | the sidebar's branch/worktree state |
| 4 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 1055 | `window.__LODY_ELECTRON__ &&` in `requestLocalProjectControl` | every `local-project/*` and `worktree/*` call |
| 5 | `packages/components/src/providers/create-workspace-runtime.ts` | 2074 | `if (!window.__LODY_ELECTRON__) {` in `canUseLocalSessionControl` | `session/create`, `session/chat`, `machine/*` |
| 6 | `packages/components/src/window-globals.d.ts` | 30 | `__LODY_ELECTRON__?: true;` | declares `__LODY_LOCAL_BRIDGE__?: true;` so the five above typecheck |

Hunks 1, 3 and 4 read:

```diff
-  window.__LODY_ELECTRON__ &&
+  (window.__LODY_ELECTRON__ || window.__LODY_LOCAL_BRIDGE__) &&
```

Hunk 2 is the same predicate re-wrapped across three lines to stay inside the
line budget; the variable keeps the name `isElectron` deliberately, because
renaming it would grow the diff past the one idea being carried. Hunk 5 reads
`if (!window.__LODY_ELECTRON__ && !window.__LODY_LOCAL_BRIDGE__) {`. Hunk 6 adds
one declaration line.

`create-workspace-runtime.ts:300` (`isElectronLocalDataPlaneEnabled`) is
deliberately NOT patched. It only picks a default `syncMode` when the caller
supplies none, and `packages/webapp/src/lody/runtime.ts` always passes
`syncMode: 'local'` explicitly.

**Rejected alternative:** a Vite `resolveId` hook redirecting
`./local-loro-data-plane-connection` to ours. It hides the swap from every
reader, and it still cannot reach the four facade guards.

**Merge conflict drill.** If a guard is reworded upstream, the conflict is
mechanical: the new predicate keeps its meaning and gains
`|| window.__LODY_LOCAL_BRIDGE__`. If the flag itself is replaced by a
capability check, drop these hunks and satisfy the new check instead.

Verify this divergence by diffing OUR subtree against the upstream commit it was
imported from. Not against the squash commit — that commit holds the upstream
tree at its own root, so diffing a merged branch against it reports the entire
vendored tree as added (measured, and it is the first thing that goes wrong):

```sh
git diff --stat <upstream-sha> $(git rev-parse HEAD:vendor/lody) -- . \
  ':!UPSTREAM.md' ':!BLITZ-PATCHES.md'
```

Expected after seam patch 8: exactly FOURTEEN files (seam patch 9 raises it to
FIFTEEN and seam patch 10 to TWENTY; see their own entries) — the three above with six
added/changed lines, plus `components/loro-sidebar.tsx` from seam patch 2,
`lib/electron-session-file-sender.ts` from seam patch 3,
`components/sessions/session-chat-interface.tsx` +
`components/sessions/session-detail.tsx` from seam patch 4,
`components/sessions/session-tab-bar.tsx` from seam patch 5, which also adds
hunks to `session-detail.tsx`, seam patch 7's five new ones:
`lib/session-github-state.ts`, `components/chat/chat-landing.tsx`,
`components/chat/unified-project-selector.tsx`,
`components/sessions/session-chat-input-area.tsx` and
`components/sessions/session-conversation-diff-panel.tsx`, and seam patch 8's
one new one: `hooks/use-chat-landing-file-draft.ts`, which also adds hunks to
`session-chat-input-area.tsx`.

### 2. `LoroSidebar` header/footer suppression (phase 4, 2026-08-30)

**Two optional props, four hunks, one file.** §0.3 of `plans/LODY-SESSIONS.md`
puts Lody's sidebar BODY inside the BlitzOS rail while `div.shell-rhead` — the
workspace title, Members, My machine, Details — stays native above it. Their
sidebar draws its own workspace-identity header and its own settings / help /
archive footer, and BlitzOS serves both from its own chrome, so mounted as-is
the rail carries two workspace headers and two settings entries.

The plan says "suppressed via props, not source edits". Upstream at `966623d0`
has no such prop — `afterSessionListContent` is the only slot — so phase 4 added
them, as the smallest additive change that could be upstreamed unchanged. The
upstream PR is drafted in `plans/evidence/lody-sidebar-props-pr.md`; **drop this
patch when it merges.**

| # | File | Line (at `f4b1ba25`) | Upstream anchor | What it does |
|---|---|---|---|---|
| 1 | `packages/components/src/components/loro-sidebar.tsx` | 171 | after `bottomFloatingContent?: ReactNode;` in `LoroSidebarProps` | declares `hideHeader?: boolean` and `hideFooter?: boolean` |
| 2 | same | 635 | after `bottomFloatingContent,` in the destructuring | defaults both to `false` |
| 3 | same | 880 | the `group/sidebar-header` `<div>` | wraps it in `{hideHeader ? null : ( … )}` |
| 4 | same | 1224 | the `getLoroSidebarFooterClassName(isMobile)` `<div>` | wraps it in `{hideFooter ? null : ( … )}` |

Hunks 3 and 4 are a guard plus a re-indent of the block they wrap, which is why
the raw diff is ~170 lines and the meaningful one is four:

```sh
git diff -w <upstream-sha> $(git rev-parse HEAD:vendor/lody) -- \
  packages/components/src/components/loro-sidebar.tsx
```

Expected: 23 changed lines, of which 15 are the two doc comments.

Every hunk is strictly additive: with both props absent the component renders
byte-for-byte what it rendered before, and no upstream call site passes either.

**What a host that hides the footer takes on.** The footer is the only place the
filter popover renders on MOBILE (`:1260`); the desktop trigger lives in the
first section header instead. So a mobile host that hides the footer owns the
organize/scope control. BlitzOS does not offer one in phase 4 — the rail has
exactly three sections and no organize modes — and the prop's doc comment says
so.

**Merge conflict drill.** If the header or the footer block is restructured
upstream, re-apply by wrapping whatever renders in its place; the guard is one
line on each side and carries no logic. If upstream adds its own suppression
(the PR, or anything equivalent), delete these hunks and pass the new prop from
`packages/webapp/src/lody/SessionRailSidebar.tsx`.

### 3. The attachment-sender predicate (phase 6, 2026-08-30)

**One hunk, one file, and it is seam patch 1's idea in a third place.** `+`
attachments have a local fast path — hand the bytes to the machine that runs the
session instead of uploading them to Lody cloud — and it is gated on the one
global BlitzOS must never set:

```diff
 export const canUseElectronLocalFileSend = (): boolean =>
-  isElectronRenderer() && Boolean(getIpcServices());
+  (isElectronRenderer() ||
+    (typeof window !== 'undefined' && window.__LODY_LOCAL_BRIDGE__ === true)) &&
+  Boolean(getIpcServices());
```

| # | File | Line (at `f4b1ba25`) | Upstream anchor | What it gates |
|---|---|---|---|---|
| 1 | `packages/components/src/lib/electron-session-file-sender.ts` | 19 | `isElectronRenderer() && Boolean(getIpcServices());` | `localProjects.sendSessionFileLocal`, read by `use-chat-landing-file-draft.ts:104` and `session-chat-input-area.tsx:524` |

The `typeof window` guard is not decoration: `isElectronRenderer()` carries one
(`lib/electron.ts:5`), and dropping it would make this module throw where it
previously returned `false`. The declaration this hunk depends on —
`__LODY_LOCAL_BRIDGE__?: true` in `window-globals.d.ts` — is seam patch 1's
hunk 6 and is already applied.

Phase 5 recorded this as a BLOCKER rather than applying it
(`plans/LODY-RUNTIME-DESIGN.md` §10.4), because that phase's brief allowed no new
hunks. Phase 6 applies it, and the BlitzOS half behind it is
`packages/webapp/src/lody/session-attachments.ts`: the bytes are staged on the
box over the existing dufs WebDAV surface at
`/workspace/.blitz-attachments/<sessionId>/`, the daemon is handed those absolute
paths, and the staging files are deleted once it has copied them into its blob
store. No new gateway path, no `webapp-surface.ts` entry, no Go change.

Strictly additive, like seam patch 1: the predicate can only become true where it
was false, and no upstream build sets the flag. Upstream PR drafted at
`plans/evidence/lody-attachment-seam-pr.md`; **drop this patch when it merges.**

**Merge conflict drill.** Identical to seam patch 1's: if the guard is reworded,
the new predicate keeps its meaning and gains the `__LODY_LOCAL_BRIDGE__` arm. If
upstream replaces the flag with a capability probe over `window.ipc` — the
alternative the PR sketch names and rejects — drop this hunk and let the probe
answer, because the BlitzOS bridge does serve the channel.

### 4. The read-only session surface (phase 7, 2026-08-30)

**Two optional props, four hunks, two files.** BlitzOS grants a member read-only
access to another member's session (`plans/LODY-SESSIONS.md` §0.1), and mounts
that session in their own browser against the owner's box
(`plans/LODY-SHARING.md` §10). Upstream has no read-only mode at all: every
member of a Lody workspace may drive every session they can see, so
`SessionChatInterface` has no notion of a viewer.

The two suppressions it DOES have — `isArchivedSession` and `isMachineRemoved` —
were considered and rejected. Borrowing either would put a false statement on the
screen: the session is neither archived nor on a removed machine, and both change
the header copy as well as the composer.

| # | File | Line (at `f4b1ba25`) | Upstream anchor | What it does |
|---|---|---|---|---|
| 1 | `packages/components/src/components/sessions/session-chat-interface.tsx` | 1740 | after `hideMessageArea?: boolean;` in the props interface | declares `readOnly?: boolean` |
| 2 | same | 1910 | after `hideMessageArea = false,` in the destructuring | defaults it to `false` |
| 3 | same | 5988 | `{shouldReplaceComposerWithPermission ? null : (` | adds `readOnly ||`, so the composer is not rendered |
| 4 | same | 5875 | the `<FloatingPermissionRequest …/>` element | wraps it in `{readOnly ? null : ( … )}` — its options are answers, and an answer this viewer cannot write is a button that does nothing |
| 5 | `packages/components/src/components/sessions/session-detail.tsx` | 692, 698 | the inline props type and destructuring of `SessionDetail` | declares and defaults `readOnly` |
| 6 | same | 5769, 5844 | the `<SessionChatInterface>` that renders a session tab | passes `readOnly={readOnly}` |

The `headerVariant="toolbar"` instance at `:5622` is deliberately NOT passed the
prop: it carries `hideMessageArea`, so it renders no composer and no permission
card, and passing a prop that selects nothing would suggest it did.

Strictly additive: with the prop absent every call site renders byte-for-byte
what it rendered before, and no upstream call site passes it. Upstream PR drafted
at `plans/evidence/lody-readonly-prop-pr.md`; **drop this patch when it merges.**

**What the prop does NOT do, and what that leaves.** It suppresses two controls.
The header's "…" menu still offers archive, delete, rename and fork to a
read-only viewer, and every one of those fails at the BlitzOS relay rather than
in the UI. Widening the prop to the menu is a bigger diff through
`headerVariant="toolbar"`'s own call site and is the follow-up if upstream wants
it; the enforcement does not depend on it.

**Merge conflict drill.** If the composer's render guard is restructured,
re-apply by adding `readOnly ||` to whatever decides it renders. If upstream
grows its own viewer concept (a role on the session, a capability), drop these
hunks and pass that instead — the BlitzOS half is one boolean on
`packages/webapp/src/lody/SessionSurface.tsx`.

### 5. Pluggable surface tabs (2026-08-31; hunks 19-20 added in wave 3)

**One idea, two files.** A host that embeds the session viewer may contribute
tabs of its own to the ONE tab strip `SessionTabBar` draws, and supply their
content. BlitzOS uses it to put workspace terminals — ttyd over tmux, which is
`webapp_state` and never a session — inside Lody's strip, so a member sees one
tab system rather than two (`plans/LODY-TERMINAL-TABS.md`).

The patch fills a hole that already exists rather than cutting a new one.
`SessionTabBar` already carries a non-session tab channel that production does
not use: `viewerTabs`, `activeViewerTabId`, `onViewerTabSelect`,
`onViewerTabClose` are all declared, the `viewer` arm of `SortableItemData` is
implemented, and the one production call site (`session-detail.tsx`) passes
`variant="session"` and no viewer tabs at all. `variant="viewer"` is declared
too — and cannot be used, because `parentSession` is required by a strip that
variant tells not to draw.

`packages/components/src/components/sessions/session-tab-bar.tsx`

| # | Line (at `f4b1ba25`) | Upstream anchor | What it does |
|---|---|---|---|
| 1 | 1 | the `react` import | adds `type ReactNode` |
| 2 | 44 | `export interface ViewerTabItem` | widens `type` to `'file' \| 'diff' \| 'custom'` and adds `icon?: ReactNode` |
| 3 | 465 | the `<span className="shrink-0">` glyph in `ViewerTabContent` | draws `tab.icon` when the host supplied one |
| 4 | 60 | `parentSession: SessionMeta;` | makes it `parentSession?: SessionMeta;` |
| 5 | 725 | `[parentSession.id, ...sortableIds]` | reads the id only when `showSessionTabs` AND a session was given |
| 6 | 770 | `<AdaptiveTabStripItem itemId={parentSession.id}>` | the existing `showSessionTabs &&` guard gains `parentSession &&` |

Hunks 4–6 are the "a strip need not be rooted in a session" half, and they are
what `packages/webapp/src/lody/TerminalTabsStrip.tsx` mounts: the same component,
`variant="viewer"`, on the chat landing where there is no session to root it in.

`packages/components/src/components/sessions/session-detail.tsx`

| # | Line (at `f4b1ba25`) | Upstream anchor | What it does |
|---|---|---|---|
| 7 | 105 | the `react` import | adds `type ReactNode` |
| 8 | 682 | after `TerminalDockToggleButton` | declares `SessionSurfaceTab` and the `EMPTY_SURFACE_TABS` default |
| 9 | 692, 698 | after `readOnly = false,` and its type entry (seam patch 4's anchor) | declares and defaults `surfaceTabs`, `activeSurfaceTabId`, `onSurfaceTabSelect`, `onSurfaceTabClose` |
| 10 | 3527 | immediately above `viewerTabItems` | maps `surfaceTabs` to `ViewerTabItem[]`, memoized so a page contributing none hands `SessionTabBar` one stable empty array |
| 11 | 5675 | `variant="session"` in the `SessionTabBar` element | `variant={surfaceTabs.length > 0 ? 'mixed' : 'session'}` |
| 12 | 5682 | after `onNewTab={handleNewTab}` | passes `viewerTabs`, `activeViewerTabId`, `onViewerTabSelect`, `onViewerTabClose` |
| 13 | 5751 | before `desktopChatSurfaces` | `activeChatSurfaceId`: an active HOST tab deselects every conversation surface, the same rule `hasActiveViewerTab` applies to the strip |
| 14 | 5758, 5792 | the two `const isActive = … === activeTabSessionId;` | read `activeChatSurfaceId` instead |
| 15 | 5810 | the end of `desktopChatSurfaces`'s children | maps `surfaceTabs` to `<div className={cn('absolute inset-0', !isActive && 'hidden')}>{tab.content}</div>`, the same shape the drafts get |
| 16 | 692, 698 | beside hunk 9's four props | declares `onSessionTabSelect` |
| 17 | 1665 | `navigateToSessionTab`, upstream's single explicit `?tab` writer | announces the selected conversation before writing the URL |
| 18 | — | retired by upstream's URL-derived selection | no correction writers remain: `activeTabSessionId` is derived from `?tab`, so hunk 17 is the sole explicit writer |
| 19 | 692, 698 | beside hunk 16's `onSessionTabSelect` | declares `onSessionMissing`, and holds it in a ref beside `onSessionTabSelectRef` |
| 20 | 4455 | inside upstream's `sessionPresenceState === 'not-found'` effect, above `fireDetailNotFoundOnce` | calls `onSessionMissing?.(sessionId)` |

**Hunks 19–20 are the OTHER thing the host cannot see: the strip is gone.**
`SessionDetail` returns above the tab strip on two branches — loading and
not-found — and the not-found one is terminal. Every host tab goes with that
return, the member's terminal included, and its tmux session is still attached
on the box. BlitzOS moves the selection to the strip's OTHER host, the chat
landing, whose strip needs no session to be rooted in
(`plans/LODY-TERMINAL-TABS.md` §3.4). With no host tab in the address the card
stays, which is the honest answer to a dead session on its own.

The call sits ABOVE upstream's `fireDetailNotFoundOnce` gate deliberately: that
gate is a once-per-session-id analytics guard, and what the host does with this
is move an address, which can come back. It reads the callback from a ref, so a
fresh host closure does not re-run an upstream effect whose dependency list is
upstream's.

**Hunks 16–18 are the seam's only OUTWARD edge, and they exist because hunk 13
has no way back.** An active host tab hides every conversation surface, so the
host's selection has to end when the page selects a conversation tab. Upstream
now derives that selection from `?tab` and funnels explicit selections through
`navigateToSessionTab`; hunk 17 announces from that single URL writer. Without
the notification the host tab stays selected, hunk 15 keeps drawing it, and
clicking a session tab in the strip does nothing a member can see.

**Why the URL writer and not `handleSessionTabSelect`.** The strip is not the
only caller: draft creation, promotion, close fallback and browser-panel opening
also select a conversation. `navigateToSessionTab` is upstream's chokepoint for
all explicit `?tab` writes, so one notification covers the current callers and
the next one.

**Why the writer and not an effect on the value.** An effect fires on a CHANGE,
and the click that most needs the call changes nothing: the parent tab is
already `activeTabSessionId` while a host tab covers it, so the one transition
the field report was about is exactly the one a change check swallows.

Hunk 18 no longer carries code. The upstream URL migration removed the old
render-time reset and URL-to-local-state correction writers; the parsed URL is
the state. The guard now pins that no second local selection store returns and
that explicit URL selection has exactly one announcing writer.

**Hunk 10's position is load-bearing, and it is not where the design put it.**
`SessionDetail` returns early below `:3527` (the loading and missing-session
branches), so a `useMemo` beside the `tabBar` element runs on some renders and
not others — React reports "Rendered more hooks than during the previous
render", the page dies into `CatchBoundary`, and the session never draws. It
sits beside `viewerTabItems` for that reason: the hook must be above every
early return, next to the other list the strip is built from. Measured, not
reasoned about — `packages/webapp/test/lody-shared-surface.test.tsx` caught it
against a real daemon.

The API is six props, one idea. The host owns the list, the selection and both
verbs; the viewer owns the drawing and the layout, and tells the host when its
own selection has taken the view back. There is no registry, no atom
and no context — grepping `registerTab|tabRegistry|registerPanel|panelRegistry`
across `packages/components/src` returns nothing, so there is no extension
mechanism to hook into and this is the smallest thing that could be one.

```ts
export interface SessionSurfaceTab {
  id: string;        // unique across this strip; must not collide with a session id
  label: string;
  icon?: ReactNode;
  content: ReactNode; // mounted always, hidden when another tab is active
}

surfaceTabs?: readonly SessionSurfaceTab[];
activeSurfaceTabId?: string | null;
onSurfaceTabSelect?: (tabId: string) => void;
onSurfaceTabClose?: (tabId: string) => void;
/** This page selected a CONVERSATION tab, so no host tab is selected now. */
onSessionTabSelect?: (tabId: string) => void;
/** This page has no session to draw, so it returns above the strip and every
 *  host tab goes with it. */
onSessionMissing?: (sessionId: string) => void;
```

**`content: ReactNode`, not a portal host.** A ref-callback host element was the
first design, on the rail-portal precedent. It was rejected: React remounts a
portal whose container identity changes, so the container swap it was meant to
avoid happens anyway, and the prop is a fifth member of the seam that buys
nothing. Mounted inline and hidden-not-unmounted, a host tab survives every tab
switch inside one session.

**The mobile branch is deliberately NOT patched.** `MobileSessionTabSheet` keeps
a fourth, hand-maintained kind enum (`mobile/mobile-session-tab-sheet.tsx:67`);
the props are inert there and the mobile drawer keeps today's behaviour.

Strictly additive: with every new prop absent, `SessionDetail` and
`SessionTabBar` render byte-for-byte what they rendered before, and no upstream
call site passes one. `packages/webapp/test/lody-surface-tabs.test.tsx` pins
that — it diffs this file against the upstream commit and refuses any changed
line that is not one of the anchors above, and it renders the real
`SessionTabBar` with today's production prop set. Upstream PR drafted at
`plans/evidence/lody-surface-tabs-pr.md`; **drop this patch when it merges.**

**Merge conflict drill.**

- If `SortableItemData` grows a real fourth arm upstream — a host/custom kind of
  its own — DROP hunks 2 and 3 and use theirs; the BlitzOS half is the same four
  props either way.
- If `variant` is removed, or `variant="viewer"` goes with it, hunks 4–6 go with
  it too, and `TerminalTabsStrip` needs whatever replaces the variant.
- If `desktopChatSurfaces` is restructured, re-apply hunks 13–15 by giving the
  new structure the same rule: a host tab, when active, hides the conversation
  surfaces and shows its own. Hunk 17 goes with them: the rule and its way back
  are one idea, and keeping 13 without 17 is the defect this patch fixed.
- If the conversation selection stops being one `useState` — an atom, a reducer,
  a URL field — hunks 17 and 18 follow it to whatever the new single writer is.
  What must not happen is a return to notifying per call site.
- If the not-found branch moves, or `sessionPresenceState` is replaced, hunk 20
  follows it to wherever the page decides it has no session to draw. Hunk 19
  without a call site is the shape of the defect it fixes: the host keeps a
  selection in a strip that is not on screen.
- If upstream grows its own host-tab concept, delete all twenty hunks and pass
  that instead — the BlitzOS half is one binding on
  `packages/webapp/src/lody/surface-tabs.ts`.

### 6. The Side Chat launcher needs an assistant turn (wave 4, 2026-08-31)

**One idea, four hunks in one file, and it is inert without one prop.** In a
session the agent has not answered yet, the side panel's Side Chat entry accepts
a click and nothing visible happens. The launcher forks the active conversation
(`handleCreateSideSession` → `forkActiveConversation`), a fork needs a completed
assistant turn, and with none `forkActiveConversation` returns after a
`toast.error`. BlitzOS mounted no `<Toaster/>` until wave 4's C1, so that refusal
was swallowed and the entry read as dead rather than as refused.

C1 puts the message on screen. This patch makes the entry say so BEFORE the
click, and it says it the way the same launcher already says it for an offline
machine: `disabled`. Hiding the entry was the alternative and is worse — a
session that has not answered yet would look like one where Side Chat does not
exist, and the option comes back a second later.

`packages/components/src/components/sessions/session-detail.tsx`

| # | Line (at `f4b1ba25`) | Upstream anchor | What it does |
|---|---|---|---|
| 21 | 692, 698 | `onMobileBack,` and `onMobileBack?: () => void;` — seam patch 5's own anchor | declares and defaults `sideChatRequiresAssistantTurn`, `false` |
| 22 | 1149 | immediately above `const activeSessionTabId = useMemo<SessionId \| null>` | holds the active tab id in a ref and adds `activeTabAssistantTurnId` state |
| 23 | 1760 | `chatRefsMap.current.set(tabId, ref);` inside `setChatTabRef` | mirrors `getLastAssistantTurnId()` into that state on ATTACH |
| 24 | 3495 | `disabled: launcherState === 'disabled' \|\| isCreatingSideSession,` in `sideChatOption` | adds the third term, gated on the prop |

Hunk 24 is the only one that replaces an upstream line, so it is the only one
named in `lody-surface-tabs.test.tsx`'s anchor table; the other three add lines
and are covered by that file's subsequence check.

**Why a mirror and not a read.** `chatRefsMap` is a ref: `getLastAssistantTurnId()`
answers when somebody asks, which is right for a click and useless for a rendered
state — nothing re-renders when a turn lands. Hunk 23 turns the ref write into a
state write, and `useImperativeHandle` is what makes it current: the handle's own
dependency list carries `lastCompletedAssistantMessageId`
(`session-chat-interface.tsx:4842`), so React re-attaches the ref on the commit
that first has a turn. No new subscription, no second document read.

**Hunk 23 IGNORES THE DETACH, and that is the whole of the loop safety.** Every
render of the page hands each chat surface a fresh `ref={(el) => setChatTabRef(…)}`
arrow, so React calls it with `null` and then with the handle inside one commit.
Taking the `null` would queue a state change on every commit — `null`, then the
value — and React cannot bail out of the pair, so the page would re-render for
ever. Taking only the attach settles on one value, which `Object.is` bails out on
when it has not changed.

**What it costs, measured against what it fixes.** The mirror is empty until the
active surface has attached its handle AND its message list has reported a
completed turn, so a session that HAS answered shows the launcher disabled for
the moment its history takes to paint. That is a control nobody is looking at
during a page load; the alternative it replaces is a control a member clicks and
which answers with an error.

**The active tab arrives through a ref, not a dependency**, so `setChatTabRef`
keeps its empty dependency list. A dependency would change the callback's
identity on every tab switch, and that callback is what every chat surface is
attached by.

**Fork semantics are untouched.** `forkActiveConversation`, `handleForkAssistant`
and the `sessions.forkNoAssistant` toast are exactly upstream's; what changes is
whether the entry OFFERS the click. A host that does not pass the prop gets
today's behaviour to the byte, and no upstream call site passes it —
`packages/webapp/test/lody-surface-tabs.test.tsx` pins that with the same
baseline subsequence check seam patch 5 uses, and
`packages/webapp/test/lody-side-chat-guard.test.tsx` names each part.

Upstream would probably rather have this unconditional — "disable Side Chat when
there is nothing to fork" is not a BlitzOS opinion — and the prop exists only
because the inertness rule above is what makes this tree's vendor edits safe to
carry. Open it upstream as the unconditional version and **drop the prop when it
merges.**

**Merge conflict drill.**

- If `sideChatOption` stops being built from `getSideChatLauncherState`, hunk 24
  follows the `disabled` field to wherever the launcher's state is decided.
- If the chat surfaces stop being attached through `setChatTabRef`, hunk 23 goes
  to whatever replaces it — and the detach rule goes with it, or the page loops.
- If upstream disables the launcher itself, DROP all four hunks and the
  `sideChatRequiresAssistantTurn` line in `packages/webapp/src/lody/router.tsx`.

### 7. Host suppression of surfaces BlitzOS does not serve (v1 scope cuts, 2026-09-01)

**One idea, 42 hunks in seven files, and every one of them is inert by default.**
The 463-row support matrix (`plans/LODY-SESSIONS.md`, the scope decision) found
four groups of controls that RENDER in a BlitzOS browser and cannot work there.
Each one is a control a member can click, and the failure is never at the button:
it is a toast that lies, a settings screen that never opens, a PR call with no
GitHub App behind it, or a keyboard chord no dispatcher answers. This patch lets
the host say so BEFORE the click.

The four groups, and what each is:

| Group | Rows | What renders today |
|---|---|---|
| GitHub and pull requests | R16, C17-C19, C65, C72, IC67, IC72, IC96-IC101, SP43, SP44, SP57-SP61, WT15 | A local clone carries a GitHub remote, so `repoFullName` is non-empty, so the info bar's six actions, the PR panel tab, the PR badge, the `@issue`/`@pr` mention categories, the `#123` hydrator and the diff-comment draft all light up against an App that is not there. |
| Cloud header rows | IC83, IC84, IC88 | "Change owner" (a workspace with one member), "Share with team" (the host serves sharing itself) and "Copy URL" (a deep link built from the daemon slug inside a memory router — it toasts success either way). |
| The notification prompt | IC60 | Enable asks the browser for a permission nothing consumes, because OneSignal is not mounted. |
| The hint band | S7, S8, S9, S10 | Outside Electron `noMachineVariant` always resolves `download-client`, so a hosted surface tells the member to install the Lody DESKTOP app, beside Report-a-bug (uploads to Lody), Discord, and a Go-to-Settings button that only flips an atom. |

**TWO MECHANISMS, AND THE CHOICE IS NOT A PREFERENCE.**

1. **GitHub reuses upstream's own gate.** `PLATFORM_CAPABILITIES` already names
   `githubIntegration` — "GitHub App integration (repo registry, brokered
   tokens, PR status)" — and `LOCAL_PLATFORM_CAPABILITIES` is empty, so the
   answer is already `false` in every local build, upstream's included. Seven
   places just never asked. `auto-archive-pr-watcher.tsx:22`,
   `general-setting.tsx:110` and `integrations-setting.tsx:270` are the same
   check, already written. **This half is a bug fix, not a BlitzOS opinion: open
   it upstream as-is and drop nothing when it merges — there is no prop to drop.**
2. **The other three are new optional props**, because upstream has no gate for
   them and inventing a capability for each would be a bigger claim than the
   suppression. Every one defaults to today's behaviour and no upstream call
   site passes any of them.

Our side is one constant, `packages/webapp/src/lody/v1-scope.ts`, read by
`packages/webapp/src/lody/router.tsx` (the props) and
`packages/webapp/src/lody/platform.tsx` (the capability). A v1 revisit flips one
field there.

#### The hunks

Line numbers are the vendored tree's BEFORE this patch. For `session-detail.tsx`
they are the `f4b1ba25` baseline's own numbers (that file is pinned by
`packages/webapp/test/upstream-baseline/`); for `session-chat-interface.tsx`
seam patch 4 shifted everything below its line 1910 by five.

`packages/components/src/lib/session-github-state.ts` — the single point every
GitHub surface reads through

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 1 | 78 | `export const getSessionGitHubState = (` | adds a third parameter, `gitHubIntegrationAvailable = true`, and the doc comment that says when to pass it |
| 2 | 81, 83 | `const repoFullName = (resolveProjectGitHubRepo(...))` and `const latestPr = getLatestPullRequest(sourceSession);` | both answer the flag: `''` and `null` with it off |

Hunk 2 is why the rest is small. `canShowGitHubActions` is `!!repoFullName`,
`hasExistingPr` is `!!repoFullName && !!latestPr`, and every consumer named in
the matrix — the info bar (`session-info-action-state.ts:43`), the PR tab in
`session-detail.tsx`, the PR badge (`session-chat-interface.tsx:5325`), and the
diff panel's `commentsEnabled` and `prLinked`
(`session-conversation-diff-panel.tsx:668`, `:671`) — is downstream
of those two values.

`packages/components/src/components/sessions/session-chat-interface.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 3 | 159 | the `date-fns/locale` import | imports `useAppCapability` |
| 4 | 1021 | `compact = false,` in `SessionHeaderMenu`'s destructuring | defaults `hideCloudMenuItems` to `false` |
| 5 | 1048 | `compact?: boolean;` in its inline props type | declares `hideCloudMenuItems?: boolean` |
| 6 | 1359 | `{owner && !isArchived ? (` | adds `&& !hideCloudMenuItems` — IC83 |
| 7 | 1404 | `{sharing && sharing.visibility !== 'team' ? (` | the same term — IC84 |
| 8 | 1489 | the `Copy URL` `<DropdownMenuItem>` | wraps it in `{hideCloudMenuItems ? null : ( … )}` — IC88 |
| 9 | 1746 | `readOnly?: boolean;` in `SessionChatInterfaceProps` | declares `hideCloudMenuItems`, `hideNotificationPrompt`, `hideAgentRoles` |
| 10 | 1917 | `readOnly = false,` in the destructuring | defaults all three to `false` |
| 11 | 2247 | above the `getSessionGitHubState` memo | reads the `githubIntegration` capability |
| 12 | 2257, 2258 | the memo's body and dependency list | passes it as the third argument |
| 13 | 5698 | `onOpenReviewSettings={…}` on `<SessionHeaderMenu>` | passes `hideCloudMenuItems` |
| 14 | 5886 | `<NotificationPermissionPrompt … />` | wraps it in `{hideNotificationPrompt ? null : ( … )}` — IC60 |
| 15 | 5991 | `session={session}` on `<SessionChatInputArea>` | passes `hideAgentRoles` |

`packages/components/src/components/sessions/session-detail.tsx` (pinned)

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 16 | 224 | the `@/lib/session-github-state` import block | imports `useAppCapability` |
| 17 | 692 | `readOnly = false,` in the destructuring | defaults the four new props |
| 18 | 698 | `readOnly?: boolean;` in the inline props type | declares `hideCloudMenuItems`, `hideNotificationPrompt`, `hideAgentRoles`, `keyboardShortcutsAvailable` |
| 19 | 1606 | above the `getSessionGitHubState` memo | reads the `githubIntegration` capability |
| 20 | 1608, 1609 | the memo's body and dependency list | passes it as the third argument |
| 21 | 3876 | the `});` that closes the `session.focusInput` registration | passes `keyboardShortcutsAvailable` as `useCommand`'s second argument — C100 |
| 22 | 5723 | `readOnly,` in the shared chat-surface props builder | forwards the three `hide*` props to every chat surface the page mounts |

Hunks 20 and 21 are the only three lines this patch removes from the baseline,
and all three are named in `lody-surface-tabs.test.tsx`'s anchor table.

`packages/components/src/components/sessions/session-chat-input-area.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 23 | 18 | the `@/hooks/use-session-agent-role` import | imports `useAppCapability` |
| 24 | 380 | `session: SessionMeta;` in `SessionChatInputAreaProps` | declares `hideAgentRoles?: boolean` |
| 25 | 493 | `session,` in the destructuring | defaults it to `false` |
| 26 | 2043 | `const repoFullName = useMemo(() => resolveSessionRepoFullName(session), [session]);` | answers the capability, so `@issue`/`@pr` and the `#123` hydrator go dark — C17, C18, C19 |
| 27 | 2332 | `agentRoles={agentRolesProp}` on the mobile run-config sheet | `undefined` when hidden |
| 28 | 2365 | `agentRoles={agentRolesProp}` on `<DesktopRunConfigMenu>` | `undefined` when hidden — C86-C89, and with no Role selectable C91 cannot fire |

`packages/components/src/components/chat/chat-landing.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 29 | 384 | `onSelectionUrlSync?: …` in `ChatLandingProps` | declares `hideProductHints` and `hideAgentRoles` |
| 30 | 561 | `onSelectionUrlSync,` in the destructuring | defaults both to `false` |
| 31 | 3777 | `agentRoles={{ … }}` on the desktop run-config menu | `undefined` when hidden |
| 32 | 4083 | `agentRoles={{ … }}` on the mobile one | the same |
| 33 | 4166 | above `selectedLocalProjectGithubRepoFullName` | reads the `githubIntegration` capability and returns `undefined` without it |
| 34 | 4276 | `return { kind: 'github' …, repoFullName: selectedRepo, … }` in `mentionSource` | drops the repo name without the capability |
| 35 | 6545 | `hintType={hintType}` | `null` when `hideProductHints` — S7, S8, S9, S10 in one line |

`packages/components/src/components/chat/unified-project-selector.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 36 | 20 | the `@/components/session-sharing` import | imports `useAppCapability` |
| 37 | 398 | `const { t } = useTranslation();` in `UnifiedProjectSelectorView` | reads the capability |
| 38 | 410 | above the selectable-options memo | clears a controlled GitHub selection when the capability is unavailable, so a stale URL or saved draft cannot retain the unsupported remote path |
| 39 | 428 | `for (const repository of repositories ?? [])` | adds cached GitHub repositories to the selectable project list only with the capability; BlitzOS deliberately caches clone names for local-project metadata, not as remote project choices |
| 40 | 635 | the `repos.connectMore` `<DropdownMenuItem>` | renders it only with the capability — C65 |

`packages/components/src/components/sessions/session-conversation-diff-panel.tsx`
— the same two-line shape as hunks 11-12, and what takes SP43 and SP44 with it:
`commentsEnabled` and `prLinked` are both `Boolean(latestPrNumber && repoFullName)`.

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 41 | 47 | the `@/lib/github-token` import | imports `useAppCapability` |
| 42 | 430, 432, 433 | the `getSessionGitHubState` memo | reads the capability and passes it as the third argument |

#### What this patch does NOT do, and why

- **C55-C57, the MCP picker, needed no hunk.** `attachment-add-menu.tsx:75`
  already reads `hasMcp = mcpServers.length > 0`, and nothing writes the MCP
  catalog rows, so the `+` menu offers attachments alone. Pinned rather than
  patched.
- **X1-X5, the command palette and the dispatcher, needed no hunk.** Neither
  `CommandPalette` nor `commands.attach(window)` is mounted, which
  `packages/webapp/test/lody-terminal-tab-wave3.test.tsx:815-827` already pins
  from both sides. C100 is the one visible consequence, and hunk 21 is it.
- **The other 15 `useCommand` registrations in `session-detail.tsx` keep their
  bindings.** None of them draws anything — X4 says no command is reachable —
  and gating all sixteen would be fifteen anchors in a pinned file for no
  member-visible change. If one of them ever grows a rendered affordance the way
  `session.focusInput` did, it takes the same second argument.
- **Nothing is deleted.** Two of the four groups are HIDDEN in v1, not
  abandoned, and a deletion could not carry that distinction.

#### Merge conflict drill

- The capability half re-applies mechanically: whatever computes `repoFullName`
  or offers a GitHub entry gains `useAppCapability('githubIntegration')`. If
  upstream adds its own check, **drop that hunk and keep the rest.**
- If upstream grows a settings surface gate, a notification gate or a
  host-hints prop, drop the matching prop and pass upstream's instead — the
  BlitzOS half is one field in `packages/webapp/src/lody/v1-scope.ts`.
- If `useCommand`'s second argument goes away, hunk 21 becomes a conditional
  registration around the same call.
- The four groups and their row ids are restated in `v1-scope.ts`, so a merge
  that drops a hunk fails `packages/webapp/test/lody-v1-scope.test.tsx` with the
  surface it let back in.

### 8. The cloud-token guard must not preempt the local transport (COMPB-1, 2026-09-01)

**One idea, five hunks in two files, and it is a bug in upstream's own local
build.** Seam patch 3 opened the local fast path to a non-Electron bridge, and
`packages/webapp/test/lody-attachments.test.ts` proves the channel behind it
carries bytes. It still never runs: at all three attachment entry points a
`if (!workspaceId || !authToken)` bail stands IN FRONT of the local handoff, and
that handoff needs no cloud token at all. A BlitzOS box holds none, so every `+`
attachment fails with "Missing workspace or auth token" before a single MKCOL or
PUT is issued.

The field report is the canary QA sweep's COMPB-1, reproduced twice in a real
browser, with BUG-CA-01 (no MKCOL or PUT ever issued) and
BUG-CA-02 ("Retry upload" is inert, because retry re-enters the same guard)
downstream of it. The verifier proved the far end works by calling
`localProjects.sendSessionFileLocal` by hand on the same page: dufs answered
MKCOL 201 and PUT 201.

**This is not a BlitzOS opinion.** `apps/electron` composes `local` explicitly
and the root `AGENTS.md` says the OSS desktop entry "must not make authenticated
product-cloud requests". A local-only Electron build therefore has no
`authToken` either, and loses the one control the local transport was written to
serve. Open upstream as "a missing cloud token disables the local file
handoff"; the sketch is `plans/evidence/lody-attachment-guard-pr.md`. **Drop
this patch when it merges.**

#### The hunks

Line numbers are the vendored tree's BEFORE this patch. For
`session-chat-input-area.tsx` they are seam patch 7's numbers, which sit five
below `f4b1ba25` for that file.

`packages/components/src/components/sessions/session-chat-input-area.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 1 | 1158 | `if (canSendFileLocally && session.machineId) {` in `startFileUpload`, with its comment block | MOVES that block above the guard at 1142 and adds `workspaceId &&` to its condition — the guard still owns the cloud path below it |
| 2 | 1142 | `if (!workspaceId || !authToken) {` in `startFileUpload` | unchanged text, now reached only after the local path declined |
| 3 | 961 | `if (!workspaceId || !authToken) {` in `startUpload` (images) | becomes `if (!workspaceId || (!authToken && !canSendFileLocally)) {` |
| 4 | 1007 | `const uploaded = await uploadSessionImage({` | throws `imageUploadMissingAuthLabel` first when there is no token, so a tokenless image lands in the `catch` upstream already wrote |

`packages/components/src/hooks/use-chat-landing-file-draft.ts`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 5 | 157 | `if (canSendFileLocally && machineId) {` in `startUpload`, with its comment block | the same move as hunk 1, above the guard at 143, gaining `workspaceId &&` |

**Hunk 4 is why the image path needed no new fallback.** Upstream already
degrades a failed image upload to a pending FILE attachment over the local
transport (`session-chat-input-area.tsx:1007-1072`, toast
`sessions.imageStoredAsLocalFile`). A missing token is exactly "there is no
cloud upload to attempt", so hunks 3 and 4 route it into that same `catch`
rather than write a second fallback beside it. The one behaviour change inside
it: `reason_code` reads `upload_error` instead of `missing_auth` on that path,
and renderer telemetry is hard-disabled in a local build anyway.

**One entry point is deliberately NOT patched here, and it was the remaining
gap.** `hooks/use-chat-landing-image-draft.ts:138` carries the same guard, and
there is nothing to MOVE in front of it: that hook has no `canSendFileLocally`,
no handoff and no degrade-to-file fallback — an image on the LANDING has only
the cloud path upstream. Giving it one means adding a fallback upstream does not
have, across two sibling hooks, which is a product opinion rather than this
patch's one idea. So this patch left it, and an image staged on the landing
still failed on a box while the same image staged inside a session became a file
attachment (hunks 3-4). **Seam patch 12 is that follow-up** and closes the gap;
read the two together, but keep them separable — 12 drops on its own if upstream
grows the fallback, and this one drops on its own if upstream fixes the order.

**Upstream behaviour with a token present is unchanged, and that is checkable
rather than asserted.** Hunks 1 and 5 move a block whose only reachable
predecessor was the guard, so with `authToken` set the order of operations is
byte-identical: guard passes, local path runs first, cloud path second. Hunk 3
adds a disjunct that is `false` whenever `authToken` is set, so the guard's
condition is unchanged there. Hunk 4's throw is unreachable with a token, since
the guard above it already returned when `authToken` was absent AND no local
transport was available. Every hunk can only make the local path reachable where
it was not; none of them can make the cloud path unreachable.

`packages/webapp/test/lody-attachment-guard.test.tsx` drives the real vendored
landing hook over a stub `window.ipc` for all three cases — no token with the
bridge, no token without it, and a token WITH the bridge — and pins the composer
half at the source, because `SessionChatInputArea` needs a runtime and a daemon.

#### Merge conflict drill

- If upstream reorders or rewords either guard, re-apply by putting the local
  handoff in front of it. The rule is one sentence: **nothing that needs a cloud
  token may run before a path that does not.**
- If upstream widens the guard to name the local transport itself — a
  `canSendFileLocally ||` arm, or a capability — drop these hunks and keep
  upstream's.
- If the image degrade-to-file fallback is removed upstream, hunks 3 and 4 go
  with it; the file hunks stand alone.

### 9. `SessionList` rows lost the worktree glyph (WT-TERM-2, 2026-09-01)

**One idea, four hunks in one file, all additive.** `SessionRowWorktreeIndicator`
(`sidebar-row-shared.tsx:269`) exists, is exported, and is rendered by exactly
two callers: `loro-app-sidebar.tsx:719`, which draws upstream's own Local
Projects rows, and `sidebar-updated-session-list.tsx:922`. `SessionList` — the
component that draws the Chats and GitHub Worktrees rows, and the ONLY session
row a BlitzOS rail has — never renders it, although its rows already carry
`isWorktree` (`session-list-rows.ts:339` sets it from the session meta). So on a
box the glyph can never appear: the QA sweep found 0 `[aria-label="Worktree"]`
nodes on every load, hovered and unhovered, over three worktree-backed sessions.

The data is upstream's, the placement is upstream's, and the omission reads as an
oversight rather than a decision: upstream's own comment on the indicator says
"only LOCAL-project rows pass a truthy `isWorktree`", which is exactly what a
BlitzOS session is. Open upstream as "the worktree glyph is missing from
`SessionList` rows". **Drop this patch when it merges.**

#### The hunks

Line numbers are the vendored tree's BEFORE this patch.

`packages/components/src/components/session-list.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 1 | 85 | `SessionRowLeadingSlot,` in the `@/components/sidebar-row-shared` import list | adds `SessionRowWorktreeIndicator,` |
| 2 | 795 | `const showMergeablePill = isMergeable && !isSelected;` | adds `const showWorktreeIcon = session.isWorktree === true;` beside it — the same name and the same expression as `loro-app-sidebar.tsx:596` |
| 3 | 989 | `) : hasPr \|\| hasChanges \|\| showMergeablePill \|\| isMobile ? (` | gains `\|\| showWorktreeIcon`, so a worktree session with no PR and no diff still renders the metric cluster |
| 4 | 1009 | `{hasPr ? (` inside that cluster | renders `<SessionRowWorktreeIndicator isWorktree={showWorktreeIcon} />` immediately before the PR icon |

**Placement is copied, not chosen.** `loro-app-sidebar.tsx:717-721` puts the
glyph to the LEFT of the PR icon and to the RIGHT of the line diff, so a
worktree row reads `[diff][worktree][PR]`; hunk 4 lands it in the same position
inside `SessionList`'s cluster. The component itself renders `null` for a falsy
`isWorktree`, so hunk 4 alone changes nothing for a non-worktree row and hunk 3
is what makes the cluster reachable for the rows that were previously empty.

**The chat branch is deliberately NOT patched.** A `group.kind === 'chat'` row
takes the time-only branch above (`:997`) and keeps it. A BlitzOS worktree
session belongs under its repository heading, not under Chats, and the seam that
puts it there is `packages/webapp/src/lody/workdir-default.ts` §2b — patching
both would paper over that grouping bug instead of showing it.

`packages/webapp/test/lody-rail-groups.test.tsx` drives the real vendored
`SessionList`, through the real `SessionRailSidebar`, over a worktree row and a
plain row — and pins this section by name, so deleting the hunks without
retiring the declaration fails.

#### Merge conflict drill

- If upstream adds the glyph itself, drop all four hunks and keep upstream's.
- If the end slot's rest cluster is restructured, re-apply by the one rule: a
  row whose `isWorktree` is true renders `SessionRowWorktreeIndicator`, next to
  the PR icon.
### 10. The side panel's file surfaces (panels-a sweep, 2026-09-01)

**Four defects, eleven hunks in six files, and three of the four are bugs in
upstream's own desktop branch.** The panels-a QA lane drove the side panel on a
real box and confirmed four rows. Each one is a control that renders, or fails
to render, on DESKTOP only — the mobile branch already models every one of them
correctly, which is why the fixes are small and upstreamable as they stand.

| Row | Severity | What a member meets today |
|---|---|---|
| BUG-1 | major | `Ctrl+P` (quick open file) does nothing on desktop. `{fileQuickOpenDialog}` is mounted only inside the `if (isMobile)` return, so the desktop tree has no dialog to open. The keydown handler runs and reports `defaultPrevented: true`, which is why it read as a dead chord rather than a missing mount. |
| BUG-2 | major | Once the file index fails once, "Files unavailable" is terminal. The acquisition effect keys on `{cache, flockDocId, loadLocalSnapshot, prepareTarget}`, and a reconnect changes none of them, so nothing ever retries. Closing and reopening the panel restores the whole tree at once, which is the proof that only the effect is stuck. The panel offers no retry either: the `Try again` action exists on the `local-error` branch and on no other. |
| SP28 | minor | The desktop file viewer has no "Copy file path". `MobileFileViewerDrawer` has carried one since it landed (`sessions.fileViewer.copyPath`, already in `locales/en.json`), and `ui/diff-viewer/diff-file-header-actions.tsx` draws the same button with the same key. |
| SP26 | minor | `Go to Definition` / `Find References` answer "Host language service does not support this file" on every identifier, because a BlitzOS box runs no language service. The two Monaco actions are registered unconditionally, so the entries are in the editor's context menu and on F12 / Shift+F12 whatever the host can answer. |

**Which hunks are inert, and which are a fix.** BUG-1, BUG-2 and SP28 change
upstream behaviour on purpose — they are the fix, and each is one upstream PR.
SP26 is the only BlitzOS opinion here, so it rides the seam-patch-7 shape: one
optional prop per level, defaulting to today's behaviour, and no upstream call
site passes any of them. Our side is one field in
`packages/webapp/src/lody/v1-scope.ts` (`languageService`).

#### The hunks

Line numbers for `session-detail.tsx` are the `f4b1ba25` baseline's own
(`packages/webapp/test/upstream-baseline/`); every other file is numbered at the
vendored tree BEFORE this patch. **Every hunk in the pinned file is purely
ADDITIVE** — this patch removes no upstream line, so it declares no new anchor
in `lody-surface-tabs.test.tsx`.

`packages/components/src/components/sessions/session-detail.tsx` (pinned)

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 1 | 5934 | `{archiveConfirmDialog}` in the DESKTOP return | mounts `{fileQuickOpenDialog}` beside it — BUG-1. It portals out, so tree position does not matter; the comment above that block already says so for the two dialogs already there. |
| 2 | 5510 | `viewStateKey={\`session-files:${activeSession.id}\`}` on `<FileTreeView>` | passes `onProviderRetry` — BUG-2 |
| 3 | 692 | `onMobileBack,` in the destructuring | defaults `hideLanguageServiceActions` to `false` |
| 4 | 698 | `onMobileBack?: () => void;` in the inline props type | declares `hideLanguageServiceActions?: boolean` |
| 5 | 4693 | `preferNativeMarkdownSelection={isMobile}` on `<SessionFileContentView>` | passes `lspAvailable={!hideLanguageServiceActions}` — SP26, and `renderViewerTabContent` is shared by both branches, so one line covers desktop and mobile |

`packages/components/src/hooks/use-code-collab-session-file-provider.ts` — BUG-2's
mechanism

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 6 | 188 | `readonly prepareTarget?: () => Promise<FileIndexTargetPlane>;` in `useCodeCollabFileIndexLoadState`'s argument type | adds `readonly reloadNonce?: number;`, joined into the existing `requestKey` memo so bumping it re-runs the acquisition effect exactly as a changed cache or doc id would |
| 7 | 497 | the closing `useMemo` that builds the hook's result | wraps it so the result also carries `reload`, and re-arms automatically on an offline → online transition of the owning machine (`useMachineOnlineStatus`, upstream's own presence hook) |

Hunk 7 re-arms on a TRANSITION, never on a status. A "retry while the status is
error" effect loops forever against a machine that is online and answering
errors; an offline → online edge can fire at most once per outage, and the
`Try again` button covers every other cause.

`packages/components/src/components/sessions/components/file-tree-view.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 8 | 67 | `viewStateKey?: string;` in `FileTreeViewProps` | declares `onProviderRetry?: () => void` |
| 9 | 518 | the `renderBranch === 'unavailable'` `FileTreeStatePanel` | gives it the same `action` the `local-error` branch already draws — the same `RefreshCw` + `sessions.codeSession.files.retry` — when the caller passes a retry |

`packages/components/src/components/sessions/session-file-content-view.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 10 | 1411 | the `showSearchButton` `<button>` in the viewer toolbar | adds the "Copy file path" button before it, and adds its `handleCopyFilePath` callback plus `showCopyPathButton` to `showViewerTopBar` — SP28 |
| 11 | 989 | `const isLspEnabled =` | declares `lspAvailable?: boolean` (default `true`), answers it in `isLspEnabled`, and passes `lspActions={lspAvailable}` to `<SessionMonacoTextViewer>` — SP26 |

`packages/components/src/components/sessions/session-monaco-text-viewer.tsx` and
`packages/components/src/lib/session-monaco-editor-controller.ts` — SP26's last
two levels: `lspActions?: boolean` (default `true`) on the viewer, joined to the
mount-time `initialPropsRef` snapshot, and `lspActions` on
`SessionMonacoEditorControllerOptions`, which gates the two `addAction` calls.
Gating the ACTIONS rather than the callbacks is the point: an action whose
callback is `undefined` still sits in the context menu and does nothing at all,
which is worse than the message it replaces.

Verify this divergence by diffing OUR subtree against the upstream commit it was
imported from, exactly as seam patch 1 describes. **Expected after seam patch 10:
TWENTY files** — the fourteen seam patch 8 left, plus `components/session-list.tsx`
from seam patch 9, plus this patch's five new
ones (`hooks/use-code-collab-session-file-provider.ts`,
`components/sessions/components/file-tree-view.tsx`,
`components/sessions/session-file-content-view.tsx`,
`components/sessions/session-monaco-text-viewer.tsx`,
`lib/session-monaco-editor-controller.ts`), which also adds hunks to
`components/sessions/session-detail.tsx`.

#### What this patch does NOT do, and why

- **BUG-3, the collapsed strip's off-screen controls, needed no hunk.** With the
  side panel collapsed the panel is 0 wide, so `SessionSidePanelTabBar`'s two
  `shrink-0` controls overflow to the RIGHT of the window — measured at cx=1911
  and cx=1943 in a 1920 viewport. One declaration in
  `packages/webapp/src/lody/blitz-skin.css` sends that overflow the other way,
  and it cannot move anything while the strip has room, because the scroll area
  beside those controls is `flex-1` and leaves no free space to distribute.
- **Nothing is deleted.** SP26 is HIDDEN for v1: a box that grows a language
  service flips one field.

#### Merge conflict drill

- Hunks 1, 2, 8, 9 and 10 are additions at a named JSX site. If upstream moves
  the site, re-apply at wherever it went; if upstream mounts the quick-open
  dialog on desktop itself, or grows its own provider retry or copy-path button,
  **drop that hunk and keep upstream's.**
- Hunks 6 and 7 depend only on `requestKey` still being the effect's identity.
  If upstream replaces the effect with its own invalidation (a query client, a
  resource key), drop them and drive that instead.
- If upstream gates the LSP actions on a capability of its own, drop hunks
  3, 4, 5, 11 and the two viewer/controller hunks with them, and answer the new
  gate from `v1-scope.ts`.

### 11. The composer's mention chips and the file drill-down (composer-a sweep, 2026-09-01)

**Two defects, eight hunks in five files, none of them BlitzOS-specific.** The
composer-a QA lane drove the `@` composer on a real box and confirmed both rows.
Every hunk here is an upstream bug fix — no host flag, no BlitzOS prop — so this
whole section is one upstream PR and **drops when it merges.**

| Row | Severity | What a member meets today |
|---|---|---|
| BUG-CA-05 | minor | A committed chip (`@README.md `) answers no click. The QA lane read `elementFromPoint` and found the `z-10` textarea over the highlight mirror, and concluded the pointer never reached the chip. It does: `MentionInput`'s own `onClick` hit-tests the click point against the mirror's rects (`isPointInsideMentionHighlight`) and calls `onMentionClick`. What is missing is the OTHER half — nothing happens to the range itself, so the click has no visible outcome for any kind except `pasted_text`, whose composer handler opens a preview. |
| BUG-CA-06 | minor | The `@` file drill-down leaves the Files category. Descending into a directory writes a bare path (`@.github/`), which carries no `<namespace>:` prefix, so `selectMentionMenuView` falls back to the AGGREGATE level and answers a directory listing across every source — the lane measured 8 rows, 4 real entries plus `/design-sync`, `/cloudflare-email-service`, `/update-config` and `/turnstile-spin`. ArrowLeft then closes the whole menu instead of going up a level: `tryNavigateBack` only pops a `<namespace>:` prefix, so the key falls through to a plain caret move, and `onMentionUpdate` reads a `/` after the caret as interfering text and closes. |

**One rule fixes the listing, and it belongs to the product layer.** A bare
search that carries a `/` is a path, and only the file source can answer a path.
`MentionCategory` gains `ownsBareSearch`, the file category is the one caller,
and the selector stays neutral — it asks the categories rather than naming one.

**"Up one level" is one helper, shared by three callers.** `mention-trigger.ts`
already owns the `<ns>:` grammar; it gains
`getMentionDrillDownParent`, which answers `<ns>:` → bare trigger and
`src/components/` → `src/` → bare trigger, and answers `null` for anything that
is not a completed drill-down level. `MentionRoot.onNavigateBack` takes the
destination search instead of always writing the bare trigger, so ArrowLeft and
the menu's own Back button move by the same rule.

**Backspace is deliberately unchanged.** `isMentionNavigationPrefix` stays what
it is, so inside a path Backspace still deletes one character at a time — the
behaviour `ui/mention/AGENTS.md` states and `mention-navigation.test.tsx`
("leaves Backspace alone inside a path drill-down") pins. This patch therefore
supersedes ONE sentence of that vendor doc: ArrowLeft no longer shares
Backspace's namespace-only rule. The doc file itself is left untouched so the
merge surface stays at five source files.

#### The hunks

Line numbers are the vendored tree's BEFORE this patch. Hunks 5-8 are purely
additive; hunks 1-4 rewrite a line each, and none of the five files is covered by
`packages/webapp/test/upstream-baseline/`, so this patch declares no new anchor
in `lody-surface-tabs.test.tsx`.

`packages/components/src/ui/mention/mention-trigger.ts`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 5 | 54 | the closing `}` of `isMentionNavigationPrefix` | appends `getMentionDrillDownParent` and its private `getPathDrillDownParent`, beside the grammar they extend |

`packages/components/src/ui/mention/mention-root.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 1 | 208 | `  onNavigateBack: () => boolean;` | takes an optional destination search, defaulting to the bare trigger |
| 2 | 676 | `    const nextValue = input.value.slice(0, caret) + input.value.slice(caretPosition);` | writes that destination into the trigger span, puts the caret after it, and seeds `filterStore.search` with it |

`packages/components/src/ui/mention/mention-input.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 3 | 17 | `import { findTriggerCandidates, isMentionNavigationPrefix } from './mention-trigger';` | also imports `getMentionDrillDownParent` |
| 4 | 777 | `          if (tryNavigateBack()) event.preventDefault();` inside `case 'ArrowLeft'` | calls `tryNavigateUp()` instead — one level, not the whole prefix. `case 'Backspace'` keeps `tryNavigateBack()` |
| 6 | 716 | the closing `}` of `tryNavigateBack` | adds `tryNavigateUp` beside it |
| 7 | 543 | `      if (!context.onMentionClick) return;` | the chip hit-test no longer needs a handler to run, and a hit SELECTS the range before the optional handler is called — BUG-CA-05 |

`packages/components/src/components/mentions/mention-registry.ts`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 8a | 171 | `  getCandidates: (term: string, limit?: number) => MentionCandidate[];` | declares `ownsBareSearch?: (search: string) => boolean` above it |
| 8b | 253 | `  if (!search) {` in `selectMentionMenuView` | after the empty-search branch, a category that claims the bare search answers it at the `category` level |
| 8c | 659 | `        getCandidates: (term, limit) => buildFileCandidates(...)` in the file category | passes `ownsBareSearch: isMentionPathSearch`, the exported one-line predicate this patch adds |

`packages/components/src/components/mentions/mention-two-level-menu.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 8d | 502 | `    if (onNavigateBack()) inputRef.current?.focus();` | pops ONE level, by the same helper ArrowLeft uses, and falls back to the bare trigger when there is no level above |

**Why selecting the range is the right answer for BUG-CA-05.** A committed
mention is already atomic to every other input path: `onBeforeInput` deletes the
whole range on Backspace, and horizontal arrows step OVER it rather than into it.
A caret dropped in the middle of a chip is therefore a position no edit can use.
The chip mirror also already paints a selected range
(`CHIP_SELECTED_CLASS_NAME`, `mention-highlighter.tsx:123`) — an affordance a
click could not reach until now, only a drag. Text editing is untouched: the
range is selected only when the click point is inside a painted chip rect, and a
click that lands anywhere else, or that ends a drag-selection, returns exactly
where it did before.

**What this patch does NOT do.** It does not open the referenced file or session
(feature-matrix row C38 asserts that, and no such callback exists at any level
between the session surface and `CombinedMentionTextarea`). Chip click stays a
composer-local gesture, and `chat-composer.tsx`'s `handleMentionClick` keeps
answering `pasted_text` alone.

`packages/webapp/test/lody-composer-mentions.test.tsx` drives the real vendored
`Mention` primitive and the real registry over both rows, and pins this section
by name, so deleting the hunks without retiring the declaration fails.

Verify this divergence by diffing OUR subtree against the upstream commit it was
imported from, exactly as seam patch 1 describes. **Expected after seam patch 11:
five more files than seam patch 10's twenty — TWENTY-FIVE.** The five new ones
are `ui/mention/mention-trigger.ts`, `ui/mention/mention-root.tsx`,
`ui/mention/mention-input.tsx`, `components/mentions/mention-registry.ts` and
`components/mentions/mention-two-level-menu.tsx`.

#### Merge conflict drill

- If upstream scopes a path drill-down to the file source itself, drop hunks 8a,
  8b and 8c and keep upstream's rule.
- If upstream gives `onNavigateBack` a destination of its own, or generalises the
  drill-down grammar past `<ns>:`, drop hunks 1, 2, 5, 6 and 8d and re-express
  ArrowLeft against the new grammar. The one invariant to keep: Backspace walks a
  path one character at a time; ArrowLeft moves a level.
- If upstream gives a chip click an action of its own, drop hunk 7 rather than
  merge the two — two things happening on one click is not the fix.

### 12. A landing image has no offline fallback (COMPB-1 remainder, 2026-09-01)

**One idea, five hunks in three files, and it finishes seam patch 8.** Patch 8
put the local transport in front of the cloud-token guard everywhere a local
handoff already existed, and named the one place none did: the landing image
draft. So on a box a file attaches from the landing, an image attaches from
inside a session (it degrades to a file), and an image on the LANDING is the
single combination that still fails with "Missing workspace or auth token".

The behaviour that closes it is upstream's own, and it already ships one surface
away. `session-chat-input-area.tsx:1007-1072` turns an image it cannot upload
into a pending FILE attachment over the local transport, with the toast
`sessions.imageStoredAsLocalFile`. In-session that is one component holding both
state machines, so the image moves from `pendingImages` into `pendingFiles` in
place. On the landing the same two state machines are two sibling hooks
(`use-chat-landing-image-draft.ts`, `use-chat-landing-file-draft.ts`), both
mounted by `chat-landing.tsx` and already sharing one draft session id. So the
degrade is the same move across that seam: the image hook hands the raw `File`
to the file hook's own entry point. Open upstream as "an image staged on the
chat landing has no offline fallback"; the sketch is
`plans/evidence/lody-landing-image-degrade-pr.md`. **Drop this patch when it
merges.**

#### The hunks

Line numbers are the vendored tree's BEFORE this patch.

`packages/components/src/hooks/use-chat-landing-image-draft.ts`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 1 | 57 | `  ensureSessionId: () => SessionId;` in the args type | adds the optional `degradeToFileAttachments?: (files: File[]) => void`, and destructures it |
| 2 | 80 | `const imageSelectionSkippedLabel = t(` | hoists `imageStoredAsLocalFileLabel` beside the other labels, from upstream's own key |
| 3 | 138 | `if (!workspaceId || !authToken) {` in `startUpload`, with its `capturePostHogEvent` block | INSERTS the degrade above it, gated on `!authToken && workspaceId && degradeToFileAttachments`. The guard's text is unchanged and still owns the cloud path below |

`packages/components/src/hooks/use-chat-landing-file-draft.ts`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 4 | 377 | `canAddMoreFiles: pendingFiles.length < SESSION_FILE_MAX_COUNT,` | also returns `canSendFileLocally`, the predicate this hook already computes at :100 |

`packages/components/src/components/chat/chat-landing.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 5 | 1313 | the `useChatLandingImageDraft({…})` / `useChatLandingFileDraft({…})` pair | swaps their order (the file draft has never read anything from the image draft) and passes `degradeToFileAttachments: canSendFileLocally ? addFileAttachments : undefined` |

**The image hook re-uses the file hook rather than copying its transport.** The
degrade calls `addFiles` on the file draft, which is `handleAddFiles` — the same
entry point the composer's `+` uses. So the bytes take seam patch 8's hunk 5,
under the file draft's own size and count limits, with its own chip, its own
status and its own Retry. Nothing about `sendSessionFileToLocalRuntime` is
restated in the image hook, and there is exactly one place on the landing that
knows how to hand a file to a box. The two hooks already share `sessionId` and
`ensureSessionId`, so the degraded file lands on the same reserved session id
the image would have.

**Availability is asked, not re-derived.** Hunk 4 returns the file draft's
existing `canSendFileLocally` instead of computing a third copy of
`localMachineId === machineId && canUseElectronLocalFileSend()` (it already
exists twice, at `use-chat-landing-file-draft.ts:100` and
`session-chat-input-area.tsx:530`). The draft that would carry the bytes is the
right authority on whether it can. With no bridge the callback is `undefined`,
the inserted block is skipped, and the unchanged guard fails the image with the
unchanged message — a browser with no token and no bridge still has nowhere to
put an image, and must still say so.

**Upstream behaviour with a cloud token present is unchanged, and that is
checkable rather than asserted.** The inserted block's condition leads with
`!authToken`, so with a token it is `false` and `startUpload` runs the same
statements in the same order as before. Hunks 1, 2 and 4 add a parameter, a
label and a returned field, and change no existing expression. Hunk 5 reorders
two independent hook calls and adds one argument. The degrade is also NOT
extended to a genuine upload failure: upstream degrades on any failed image
upload in-session, but doing that here would change what a token holder sees,
and this patch's one idea is the tokenless case alone.

`packages/webapp/test/lody-attachment-guard.test.tsx` drives the REAL vendored
image hook over a stub `window.ipc` for the same three cases seam patch 8 pinned
— no token with the bridge, no token without it, and a token WITH the bridge —
and pins this section by name.

Verify this divergence by diffing OUR subtree against the upstream commit it was
imported from, exactly as seam patch 1 describes. **Expected after seam patch 12:
one more file than seam patch 11's twenty-five — TWENTY-SIX.** The new one is
`hooks/use-chat-landing-image-draft.ts`; the other two files this patch touches
were already diverged by seam patches 7 and 8.

#### Merge conflict drill

- If upstream gives the landing image draft a fallback of its own — a local
  handoff, or a degrade to the file draft — drop all five hunks and keep
  upstream's.
- If upstream deletes the in-session degrade, drop this patch with it: the
  behaviour it mirrors would no longer exist, and keeping it would make the
  landing do something no other surface does.
- If the two landing drafts are merged into one hook, re-apply by the one rule:
  **with no cloud token and a local transport available, a staged image becomes
  a pending file attachment instead of an error.**
- Hunk 5's reorder is not the idea; if upstream moves those calls, keep whatever
  order it chooses and pass the argument from wherever the predicate is legible.

### 13. `LoroSidebar`'s footer, one entry at a time (archive page, 2026-09-01)

**One optional prop, four guards, one file — and it is seam patch 2 admitting it
was too coarse.** Seam patch 2 gave the sidebar `hideFooter`, because BlitzOS
serves settings and help from its own chrome. The footer also carries the
ARCHIVE entry, which is upstream's only affordance that leads to the archive
page, so hiding the footer hid the one thing the host wanted to keep. The rail
had a page it could not reach.

`hideFooter` cannot express "keep one of them": it is a boolean over the whole
rail. So the item list becomes the prop, and `hideFooter` keeps its meaning as
the shorter spelling for "none of them".

| # | File | Line (at `f4b1ba25`) | Upstream anchor | What it does |
|---|---|---|---|---|
| 1 | `packages/components/src/components/loro-sidebar.tsx` | 68 | after `export type LoroSidebarNavKey` | declares `LoroSidebarFooterItem` and `LORO_SIDEBAR_FOOTER_ITEMS`, the default |
| 2 | same | 171 | after `hideFooter?: boolean;` in `LoroSidebarProps` | declares `footerItems?: readonly LoroSidebarFooterItem[]` |
| 3 | same | 635 | after `hideFooter = false,` in the destructuring | defaults it to every item |
| 4 | same | 1224 | the `Settings` `IconButton` | wraps it in `{footerItems.includes('settings') ? ( … ) : null}` |
| 5 | same | 1230 | the Help `DropdownMenu` | the same term for `'help'` |
| 6 | same | 1256 | the `Archive` `IconButton` | the same term for `'archive'` |
| 7 | same | 1260 | `{isMobile ? (` on `SidebarFilterPopover` | adds `&& footerItems.includes('filter')` |

Strictly additive: with the prop absent every item is in the list and the footer
renders byte-for-byte what it rendered before. No upstream call site passes it.

**What BlitzOS passes.** `packages/webapp/src/lody/SessionRailSidebar.tsx` drops
`hideFooter` and passes `footerItems={["archive"]}`, so the rail shows the
Archive entry and nothing else. The mobile filter popover stays hidden, which is
what seam patch 2's own note already said the host owns.

**Merge conflict drill.** If the footer block is restructured, re-apply by
wrapping whatever renders in each item's place; every guard is one term and
carries no logic. If upstream grows its own per-item suppression, delete these
hunks and pass the new prop from `SessionRailSidebar.tsx`.

### 14. The archive page's v1 scope cuts (archive page, 2026-09-01)

**Seam patch 7's two mechanisms, applied to the page seam patch 13 made
reachable.** The archive page ships two surfaces the v1 scope hides everywhere
else, and both are the same defect they are on the session page: a control that
renders and cannot work.

| Surface | Row area | What renders without this patch |
|---|---|---|
| The row's pull-request badge | the GitHub group (R16, C17-C19, IC96-IC101) | A BlitzOS worktree session carries `pullRequests`, so the archived row draws a PR status glyph that links to github.com through an App that is not connected. |
| The My Tasks / All Tasks scope control | T25 | A local workspace has exactly one member, so both entries list the same sessions. The rail already pins `scope: "my"` and seam patch 2 hides the mobile filter popover — the archive page was the one surface still offering the switch. |

**TWO MECHANISMS, THE SAME CHOICE SEAM PATCH 7 MADE.**

1. **The PR badge reuses upstream's own gate.** `useAppCapability('githubIntegration')`
   is the check `session-detail.tsx` and five other files already make; the
   archive row simply never asked. **This half is a bug fix, not a BlitzOS
   opinion: open it upstream as-is, and there is no prop to drop when it merges.**
2. **The scope control is a new optional prop**, because upstream has no
   capability for "this workspace has one member" and inventing one would be a
   bigger claim than the suppression.

| # | File | Line (at `f4b1ba25`) | Upstream anchor | What it does |
|---|---|---|---|---|
| 1 | `packages/components/src/components/archive/archive-view.tsx` | 27 | the `@/lib/utils` import | imports `useAppCapability` |
| 2 | same | 317 | `function getArchivedSessionItemViewModel(` | adds a third parameter, `gitHubIntegrationAvailable = true`, and the doc comment that says when to pass it |
| 3 | same | 328 | `const pullRequests = session.pullRequests ?? [];` | answers the flag: an empty list with it off, which zeroes `prUrl`, `prStatusMeta`, `PrIcon` and `prTooltipLabel` together |
| 4 | same | 404 | the `DesktopArchivedSessionItem` destructuring | reads the capability and passes it |
| 5 | same | 634 | the `MobileArchivedSessionItem` destructuring | the same |
| 6 | same | 1034 | `export function ArchiveView()` | declares `ArchiveViewProps` with `hideTeamScope?: boolean`, defaulted `false` |
| 7 | same | 1046 | `const [archiveScope, setArchiveScope] = useAtom(archiveScopeAtom);` | renames the stored value and pins the ANSWER to `'my'` with the prop on — the atom is still written, so turning the prop off restores the member's own last choice |
| 8 | same | 1489 | `{isMobile ? (` on the toolbar's scope dropdown | adds `&& !hideTeamScope` |
| 9 | same | 1752 | `<WebArchiveScreen archiveScope={archiveScope}` | forwards `hideTeamScope` |
| 10 | `packages/components/src/components/archive/web-archive-screen.tsx` | 23 | `archiveScope: ArchiveScope;` in `WebArchiveScreenProps` | declares `hideTeamScope?: boolean` |
| 11 | same | 38 | `archiveScope,` in the destructuring | defaults it to `false` |
| 12 | same | 131 | the `div.ml-2` that holds the scope `DropdownMenu` | wraps it in `{hideTeamScope ? null : ( … )}` |

Hunk 3 is why the rest is small, and it is hunk 2 of seam patch 7 in a second
place: every PR value the row draws is downstream of that one list.

Our side is the same constant seam patch 7 reads,
`packages/webapp/src/lody/v1-scope.ts`: `hideTeamScope` joins
`lodyV1SuppressionProps()` under the `cloudSurfaces` flag, and `router.tsx`
passes it to `<ArchiveView>` exactly as it passes the other five.

`packages/webapp/test/lody-archive-page.test.tsx` asserts both cuts from both
sides — dark with the suppression, present without it — and
`packages/webapp/test/lody-v1-scope-sources.test.ts` pins this section by name.

Verify this divergence by diffing OUR subtree against the upstream commit it was
imported from, exactly as seam patch 1 describes. **Expected after seam patches
13 and 14: two more files than seam patch 12's twenty-six — TWENTY-EIGHT.** Seam
patch 13 adds NO file, because `components/loro-sidebar.tsx` is already seam
patch 2's. The two new ones are seam patch 14's:
`components/archive/archive-view.tsx` and
`components/archive/web-archive-screen.tsx`.

**Merge conflict drill.** If upstream adds the capability check itself, drop
hunks 1-5 and keep upstream's. If upstream gives the archive page a
single-member answer of its own, drop hunks 6-12 and pass nothing.

### 15. The host owns connectivity, so Lody must not narrate it (2026-09-02)

**One optional prop, eighteen hunks in five files, and it is a boundary rather
than a scope cut.** BlitzOS surfaces connectivity itself. The shell footer's left slot
carries one sentence built by `packages/webapp/src/shell/workspace-status-line.ts`
— `workspace running · box unreachable` when the machine runs and the browser
cannot reach its gateway, the lifecycle word otherwise — and
`packages/webapp/src/box-gateway-health.ts` is the probe behind it. That sentence
is true about the WHOLE workspace: the terminal, the files, the previews and the
Lody surface all go through the same gateway.

Lody, mounted inside that shell, tells the same story again from a narrower
vantage and in different words. The two do not agree, because they cannot: a
member reading `You are offline. Reconnect to sync.` beside `workspace running`
learns nothing about which one to believe, and a spinner that says the session
document is catching up is a fact about a room, not about the box. The ruling is
that the host says it and the vendored surface says nothing.

| Surface | Where | What renders without this patch |
|---|---|---|
| The composer status chip, `browser-offline` | `session-status-strip.tsx:62` through `StatusChip` in the session info bar | `You are offline. Reconnect to sync.` (QA row IC64) |
| The same chip, `machine-offline` | the same slot | `Machine is offline` / `{{machineName}} is offline` |
| The info bar's ambient catch-up spinner | `session-info-bar.tsx:339` | `SessionSyncingIndicator`, pinned to the bar's right edge (IC65) |
| The mobile session header's catch-up spinner | `session-detail.tsx`'s `MobileProjectInfo` | the same indicator beside the session title |
| The page header's spinner and offline cloud glyph | `SessionProjectInfo` in `session-chat-interface.tsx` | unreachable from BlitzOS today — the page mounts every chat surface with `hideHeader: true` — and gated anyway, so the prop means one thing everywhere |
| The file viewer's status bar | `session-file-content-view.tsx:1545` | an `Offline` cloud glyph titled `Machine is offline`, beside the save and live-sync items |
| The mobile home connection banner | `chat-landing.tsx:6333` | `连接中… / 正在重连… / 离线 / 已连接`, which upstream's own comment calls a mirror of the desktop `ConnectionPill` |

**WHAT THIS PATCH DELIBERATELY LEAVES ALONE**, and each one is a decision:

- **`machine-removed` keeps its chip.** `This machine was removed from the
  workspace. Messages can no longer be sent.` is not connection state — it is a
  membership fact, and it BLOCKS SENDING. Suppressing it would leave a member
  with a dead composer and no sentence anywhere explaining why; the footer says
  nothing about it, because the footer is about reachability.
- **The file viewer's save and live-sync items stay.** `Saved` / `Unsaved` /
  `Save failed` / `Live sync delayed` are per-file operation feedback about an
  edit the member just made, not ambient connectivity. Only the `machine-offline`
  item of that bar answers the prop.
- **Every message that REPLACES content stays.** `sessions.codeSession.connecting`
  — "Connecting to code session…" in both `session-file-content-view.tsx` and
  `session-file-quick-open.tsx` — `sessions.changes.syncing` ("Syncing changes…",
  `session-changes-sidebar.tsx`) and `session-file-error-state.tsx`'s
  `temporarily-unavailable` panel are what a panel draws INSTEAD of its data.
  Each explains one thing the member asked for, at the place they asked for it.
  Suppressing them leaves a blank panel, and the footer sentence cannot fill it.
- **`sessions.externalHistorySyncing`** ("Syncing {{provider}} history") is an
  agent-history import, not transport, and **`sessions.activity.codexRetrying`**
  ("Connection interrupted, Codex is retrying", `ai-gui/view.tsx`) is turn data
  the agent published. Neither is the browser's link to the box.
- **`chat.localGitStateMachineOffline`** — "Target machine is offline. Start the
  CLI on that machine to load branches." — stays, for the same reason as the
  panels: it is why one branch list failed to load. Its second sentence is wrong
  for a box and belongs to a wrong-product sweep, not to this one.
- **The mobile chat filter's `Offline` bucket**
  (`chat.mobileHome.filters.running.offline`) is a filter category over sessions,
  not a report about this member's connection.
- **The `ConnectionPill` needed no hunk.** It renders inside `LoroSidebar`'s
  workspace-identity header, and `packages/webapp/src/lody/SessionRailSidebar.tsx`
  already passes seam patch 2's `hideHeader`. Our rail also passes neither
  `connectionUiState` nor `workspaceSyncing`, so the pill has no state to draw
  even without that. Pinned rather than patched.
- **`StuckConnectionBannerContainer` needed no hunk.** It mounts once in
  `MainLayout`, and BlitzOS mounts `ChatLanding`, `SessionDetail` and
  `ArchiveView` directly. Pinned rather than patched.
- **Two more render nothing here, and are pinned rather than patched.**
  `SessionListRow.isOffline` (`session-list.tsx:146`) is a field of the row type
  that no renderer in that file reads, and our rail never sets it; and every
  settings screen that prints Online / Offline sits behind the twenty stubbed
  settings routes in `packages/webapp/src/lody/router.tsx`.

**ONE PROP, FRAMED FOR ANY EMBEDDING HOST.** `hideConnectionStatus` says "this
surface is embedded in a host that reports connectivity itself"; it is not
BlitzOS-shaped and needs no capability. Every hunk defaults to today's behaviour
and no upstream call site passes it. Upstream has no gate to reuse here: unlike
`githubIntegration`, there is no capability that means "somebody else draws the
status bar".

#### The hunks

Line numbers are the vendored tree's BEFORE this patch, except for
`session-detail.tsx`, which is pinned by `packages/webapp/test/upstream-baseline/`
and is numbered against that baseline.

`packages/components/src/components/sessions/session-status-strip.tsx` — the
single point every one of these states resolves through

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 1 | 38 | `export function resolveSessionStatusStripState(args: {` | adds `connectionStatusHidden?: boolean` to the argument type, with the doc comment that says when a host passes it |
| 2 | 40, 42 | `if (!args.browserOnline) return { kind: 'browser-offline' };` and `if (args.machineOnlineStatus === 'offline') {` | both answer the flag. The `machine-removed` branch between them does NOT |

Hunk 2 is why the rest of the chip is untouched: `StatusChip` renders `null` for
a `null` state, so gating the resolver takes the cluster chip and the stage chip
together, on desktop and on mobile.

`packages/components/src/components/sessions/session-chat-interface.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 3 | 1746 | `hideAgentRoles?: boolean;` in `SessionChatInterfaceProps` (seam patch 7's own anchor) | declares `hideConnectionStatus?: boolean` |
| 4 | 1917 | `hideAgentRoles = false,` in the destructuring | defaults it to `false` |
| 5 | 2490, 2492 | the `resolveSessionStatusStripState` memo body and its dependency list | passes `connectionStatusHidden: hideConnectionStatus` |
| 6 | 5750 | `isSyncing={effectiveTitleSyncing}` on `<SessionProjectInfo>` | adds `!hideConnectionStatus &&` |
| 7 | 5751 | `isMachineOffline={sessionMachineOnlineStatus === 'offline'}` | the same term |
| 8 | 5979 | `syncing={!isMobile && effectiveTitleSyncing}` on `<SessionInfoBar>` | the same term |

`packages/components/src/components/sessions/session-detail.tsx` (pinned)

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 9 | 692 | `onMobileBack,` in the destructuring (seam patch 10's own anchor) | defaults `hideConnectionStatus` to `false` |
| 10 | 698 | `onMobileBack?: () => void;` in the inline props type | declares `hideConnectionStatus?: boolean` |
| 11 | 1180 | `    activeSessionTabId !== null && isSyncingRoomSyncState(activeSessionDocSyncState),` | adds `!hideConnectionStatus &&`, which takes the mobile header spinner and the `titleSyncing` override together |
| 12 | 4693 | `preferNativeMarkdownSelection={isMobile}` on `<SessionFileContentView>` (seam patch 10's own anchor) | passes `hideConnectionStatus` |
| 13 | 5723 | `hideHeader: true,` in the shared chat-surface props builder | forwards `hideConnectionStatus` to every chat surface the page mounts |

Hunk 11 is the ONE line this patch removes from the baseline, and it is declared
in `packages/webapp/test/lody-surface-tabs.test.tsx`'s anchor table with the
others. Hunks 9, 10, 12 and 13 add lines and remove none.

`packages/components/src/components/sessions/session-file-content-view.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 14 | 161, 213 | `lspAvailable?: boolean;` and `lspAvailable = true,` (seam patch 10's own anchors) | declares `hideConnectionStatus?: boolean`, defaulted `false` |
| 15 | 1492 | `machineOffline={` on `<SessionFileRealtimeStatusBar>` | answers it, so the bar keeps its save and live-sync items and drops the offline glyph |

`packages/components/src/components/chat/chat-landing.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 16 | 384 | `hideProductHints?: boolean;` in `ChatLandingProps` (seam patch 7's own anchor) | declares `hideConnectionStatus?: boolean` |
| 17 | 561 | `hideProductHints = false,` in the destructuring | defaults it to `false` |
| 18 | 6260 | `connectionUiState={mobileHomeConnectionUiState}` on `<MobileHomeScreen>` | passes `undefined` when hidden |

Hunk 18 needs no change in `mobile-home-screen.tsx`: that prop is already
optional there and already defaults to `'online'`, the one state at which the
banner does not render. The atom keeps its value, so flipping the prop back
restores the banner with no other edit.

Our side is the same constant seam patches 7, 10 and 14 read,
`packages/webapp/src/lody/v1-scope.ts`: a sixth flag, `connectionStatus`, turns
into `hideConnectionStatus` in `lodyV1SuppressionProps()`, and `router.tsx`
passes it to `<SessionDetail>` and `<ChatLanding>`. The flag is not a "not in v1"
decision like the other five — it is an ownership boundary — so its row in that
file says so, and flipping it is what a host that stops reporting connectivity
would do.

`packages/webapp/test/lody-connection-status.test.tsx` asserts every surface from
both sides: dark with the suppression while the underlying state is ACTIVE, and
present without it. The same file pins the BlitzOS footer sentence, so a change
that took Lody's status away and dropped ours too fails there.

Verify this divergence by diffing OUR subtree against the upstream commit it was
imported from, exactly as seam patch 1 describes. **Expected after seam patch 15:
one more file than seam patch 14's twenty-eight — TWENTY-NINE.** The new one is
`components/sessions/session-status-strip.tsx`; the other four were already
diverged by seam patches 7 and 10.

**Merge conflict drill.** Every hunk is one term added to a boolean, or one
optional field added to a props type. If upstream restructures a call site,
re-apply at wherever it went. If upstream grows its own way for an embedding host
to own connectivity — a capability, a provider, a prop of its own — drop all
eighteen hunks and answer that instead from `v1-scope.ts`. If the status strip
gains a FOURTH state, decide it explicitly: connectivity answers the flag,
anything about membership or a blocked action does not.

### 16. The mobile branch: host tabs and the v1 scope cuts (mobile mount, 2026-09-02)

**One idea in two halves, 24 hunks in four files.** BlitzOS now mounts Lody's
real phone experience (`packages/webapp/src/lody/MobileSessionStack.tsx`), so
two things that were true only on a desktop have to become true on a phone: a
host tab must be reachable, and the v1 scope cuts must fire.

Seam patch 5 said this in writing — *"The mobile branch is deliberately NOT
patched. `MobileSessionTabSheet` keeps a fourth, hand-maintained kind enum; the
props are inert there and the mobile drawer keeps today's behaviour."* That was
correct while both routes dropped the mobile branch. It is the gap now.

**THE STRUCTURAL CAUSE, AND IT IS ONE SENTENCE.** `session-detail.tsx` returns
for mobile above `:5432`, and `getSharedChatSurfaceProps` — the builder that
forwards `hideCloudMenuItems`, `hideNotificationPrompt`, `hideAgentRoles` and
seam patch 15's `hideConnectionStatus` to every chat surface — is defined at
`:5710`, below it. The mobile branch hand-writes its own
`SessionChatInterface` props and carried `readOnly` alone. So **props are lost
at the mobile fork and capabilities are not**: every
`useAppCapability('githubIntegration')` call sits above the return and answers
on both branches, which is why seam patch 7's GitHub half needs nothing here and
its other groups need everything.

The same fork explains the landing. `hideProductHints` is read at
`chat-landing.tsx:6545`, and the mobile branch returns above `:6260`/`:6416`.

**WHAT SEAM PATCH 15 ALREADY DOES, SO THIS PATCH DOES NOT.** Connectivity is
that patch's subject and it reaches the mobile branch on its own in two of the
three places it matters:

- The mobile home's connection banner is its hunk 18, on the one call site.
- The mobile session header's catch-up spinner is its hunk 11, which gates
  `activeSessionDocIsSyncing` at the source rather than at the header.
- The composer status chip is the exception, and it is hunk 12 below. Its hunk
  13 forwards `hideConnectionStatus` through the shared builder, which the
  mobile branch never reaches — the same sentence again.

`hideConnectionStatus` is therefore DECLARED by seam patch 15 and merely
forwarded here. One flag, one prop, one gate story.

#### Half A — a host tab in the mobile tab sheet

`packages/components/src/components/mobile/mobile-session-tab-sheet.tsx`

| # | Line (at `f4b1ba25`) | Upstream anchor | What it does |
|---|---|---|---|
| 1 | 67 | `kind: 'file' \| 'diff' \| 'pr' \| 'browser' \| 'files';` | adds `\| 'custom'` |
| 2 | 64-68 | `ViewerTabEntry` | adds `icon?: ReactNode` (already imported at `:1`) |
| 3 | 116-122 | `const VIEWER_ICON: Record<ViewerTabEntry['kind'], typeof FileIcon>` | adds the `custom` entry — the `Record` is total, so hunk 1 does not compile without it |
| 4 | 244-248 | `const Icon = VIEWER_ICON[v.kind];` and the `leading` element | draws `v.icon` when the host supplied one, exactly as seam patch 5 hunk 3 does on the desktop strip (`session-tab-bar.tsx:465`) |

**HUNK 1 IS ALSO A BUG FIX.** `session-detail.tsx:4295` already writes
`kind: v.type` from a `ViewerTabItem`, whose `type` seam patch 5 hunk 2 widened
to `'file' | 'diff' | 'custom'`. The mobile enum did not follow, so that
assignment has been unsound since wave 3. It is unreachable today only because
nothing on the mobile path reads `surfaceTabItems`.

**THE SHEET GETS NO CLOSE VERB, AND THAT IS UPSTREAM'S DESIGN.** `ViewerRow` is
one `<button>` whose whole body is the row, and its doc comment says "no
close" — the sheet has no close affordance for any tab kind. Adding one would
mean a sibling button and a restructured row, for a verb the phone already has:
a terminal closes from its BlitzOS rail row (`SessionRailSidebar`'s
`onCloseTerminal`). §0's bias rule applies — copy Lody's behaviour.

`packages/components/src/components/sessions/session-detail.tsx` (pinned)

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 5 | 4192 | `const hasActiveViewerTab =` | adds `hasActiveSurfaceTab`, the mobile counterpart of seam patch 5 hunk 13's `activeChatSurfaceId` |
| 6 | 4305-4313 | the `for (const v of viewerTabItems)` loop in `mobileViewers`, and its dependency list | appends `surfaceTabItems` as `{ kind: 'custom', icon, active }` |
| 7 | 4371-4389 | `handleMobileViewerSelect` and its dependency list | routes a host tab id to `onSurfaceTabSelect` before the file/viewer arms |
| 8 | 5077, 5144 | the two `const isActive = !hasActiveViewerTab && …` | an active host tab hides the conversations and the drafts, the rule seam patch 5 hunk 13 gives the desktop |
| 9 | 5181 | after the non-file viewer surfaces, inside `div[role="main"]` | mounts every host tab's `content`, hidden unless active — the mobile mirror of seam patch 5 hunk 15 |

Hunks 5-9 need no new prop: `surfaceTabs`, `activeSurfaceTabId` and
`onSurfaceTabSelect` are seam patch 5's, declared at `:748` and already inert by
default. `onSurfaceTabClose` stays desktop-only for the reason above.

#### Half B — the v1 scope cuts, on the mobile path

`packages/components/src/components/sessions/session-detail.tsx` (pinned)

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 10 | 5089-5151 | the mobile `<SessionChatInterface>` surfaces | forwards `hideCloudMenuItems`, `hideNotificationPrompt` and `hideAgentRoles` beside the `readOnly` they already had — IC60, C86-C89, C91 |
| 11 | the same element | the same | forwards seam patch 15's `hideConnectionStatus`, which its hunk 13 gives the desktop surfaces through the shared builder — IC64 |
| 12 | 4831 | `if (activeSessionSharing) {` in `mobileMenuInfoRows` | adds `&& !hideCloudMenuItems` — the visibility row states cloud sharing on a host that serves sharing itself |
| 13 | 4921 | the `copy-url` `mobileMenuActions.push` | wraps it in the same term — IC88, the mobile twin of seam patch 7 hunk 8 |
| 14 | 4932 | `if (activeSessionSharing && activeSessionSharing.visibility !== 'team')` | adds the third term — IC84, the mobile twin of seam patch 7 hunk 7 |
| 15 | 5058 | `owner={isMultiMemberWorkspace && !activeSession.isArchived ? …}` | adds the third term — IC83, the mobile twin of seam patch 7 hunk 6 |
| 16 | 593-594, 607 | `MobileProjectInfo`'s `repoFullName` / `isGitHub` | takes a `gitHubAvailable` prop, so the header stops drawing the octocat and the repo slug for a local clone that merely has a GitHub remote |
| 17 | 5015-5018 | the `<MobileProjectInfo>` element | passes the capability |

**Hunk 16 is a CAPABILITY bug, not a prop one, and it is the only one of its
kind on this page.** `MobileProjectInfo` re-derives `repoFullName` from the
session instead of taking the value `getSessionGitHubState` already nulls
(seam patch 7 hunk 2). Every other GitHub surface on the mobile path — the PR
entry in the tab sheet, the PR drawer, the diff panel's comments, the composer's
`@issue`/`@pr` — reads the gated value and is already dark. **Open this half
upstream as a bug fix; there is no prop to drop when it merges.**

`packages/components/src/components/chat/chat-landing.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 18 | 384-390 | `hideProductHints?: boolean;` in `ChatLandingProps` | declares `hideSettingsEntry` |
| 19 | 561 | the destructuring | defaults it to `false` |
| 20 | 6269 | `onAddGitHubRepository={handleConnectGitRepo}` | `undefined` without the `githubIntegration` capability `:4166` already reads — the row's handler opens a GitHub settings screen we do not serve |
| 21 | 6416-6422 | `onSettingsOpen={() => …}` | `undefined` when `hideSettingsEntry` — the gear navigates to `/$workspaceName/settings`, which is a stub route that renders nothing |

`packages/components/src/components/mobile/mobile-home-screen.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 22 | `MobileHomeScreenProps` | beside `showTasksTab` | declares `showGitHubProjects` (default `true`) and `hideOnboarding` (default `false`) |
| 23 | 1334-1341 | `const showChatOnboarding =` | adds `!hideOnboarding` — the "Lody runs on your computer / Download Lody" takeover is the mobile twin of the desktop hint band's `download-client` (S7), and `hideProductHints` never reached it |
| 24 | 1105-1141, 1850-1930, 1654 | `ProjectsSubTabSelector`, `ProjectsTabView` and its call site | take `showGitHub`, drop the GitHub segment without it, and pin the rendered sub-tab to `local` so a stale `'github'` choice cannot reach an empty list |

The numbering counts anchors, not source lines: hunks 22 and 24 are several
anchors each in one file with two new props.

#### What this patch does NOT do

- **Connectivity is seam patch 15's, and only hunk 11 above is new.** See the
  note near the top: two of the three mobile connection surfaces are already
  gated by that patch's own hunks.
- **The workspace switcher and the create-workspace sheet need no hunk.** Both
  mount only under `multiWorkspaceAvailable`, and the local platform declines
  `multiWorkspace`, so the header falls through to a static nameplate.
- **The Inbox and Tasks tabs need no hunk.** `showInboxTab` and `showTasksTab`
  are host props and `chat-landing.tsx` already computes both as `false`.
- **The sidebar drawer needs no hunk.** BlitzOS does not mount `MainLayout`, so
  `MobileSidebarDrawer` has no call site, and upstream hard-disables its
  swipe-open at `mobile-sidebar-drawer.tsx:214`.
- **The back chevron in the mobile session header stays.** It pops the session
  drawer back to the landing, which is the stack's own verb. The BlitzOS `☰`
  opens the workspace rail. Two different verbs, one navigation story.
- **Nothing is deleted.** Every hunk is a term, a default or a forwarded prop.

Strictly additive: with every new prop absent and `surfaceTabs` empty, all four
files render byte-for-byte what they rendered before, and no upstream call site
passes one. Upstream PR sketch: half A and hunk 16 go up as bug fixes; half B
goes up as the same optional-prop shape seam patch 7 uses.

Verify this divergence by diffing OUR subtree against the upstream commit it was
imported from, exactly as seam patch 1 describes. **Expected after seam patch
16: one more file than seam patch 15's twenty-nine — THIRTY.** Only
`components/mobile/mobile-session-tab-sheet.tsx` and
`components/mobile/mobile-home-screen.tsx` are new here, and the second of those
is the thirtieth; `session-detail.tsx` and `chat/chat-landing.tsx` are already
seam patches 5, 7 and 15's.

`packages/webapp/test/lody-mobile-mount.test.tsx` pins both halves, and
`packages/webapp/test/lody-v1-scope-sources.test.ts` pins this section by name.

**Merge conflict drill.**

- If upstream hoists `getSharedChatSurfaceProps` above the mobile return, or
  otherwise makes one builder serve both branches, **drop hunks 10-15** and pass
  the props once. That single change would also retire seam patch 15's hunk 13
  distinction, which is the clearest sign the fork is the real defect.
- If `ViewerTabEntry` grows a host arm of its own, drop hunks 1-4 and use it.
- If the mobile branch gains a surface block of its own, hunks 8 and 9 follow it
  to wherever it decides which tab is on screen.
- If `MobileProjectInfo` starts reading `getSessionGitHubState`, drop hunk 16.
- If upstream gives the mobile home its own settings or GitHub gate, drop the
  matching hunk and pass upstream's — the BlitzOS half is one field in
  `packages/webapp/src/lody/v1-scope.ts`.

### 17. The local-platform snapshot must forget the previous box (superseded by seam 18, 2026-09-02)

**Superseded.** Seam 18's client-keyed provider state replaces the sequential
singleton reset described below. The additive reset remains in the subtree for
standalone compatibility and its historical regression test, but Blitz's
keep-alive composition does not use it to switch surfaces. Drop it when seam 18
lands upstream.

**One idea, one file, and it is additive.** BlitzOS drives MANY box daemons from
one browser tab — one per workspace — where Electron drives exactly one local
daemon per renderer. `local-platform-provider.ts` is written for Electron's
world: `cachedProvider` / `cachedSessionStore` / `cachedWorkspacesStore` /
`snapshotPollingStarted` are module-scope singletons, and the poll settles on
the FIRST `localPlatform.getSnapshot` and never reads again for the life of the
page. So the second workspace a member visits gets `useImplicitLocalWorkspace()`
= the FIRST box's `lw_<uuid>`, and `RuntimeProvider` (`runtime-provider.tsx:239`,
the local branch) builds its runtime from it: it opens `lody-loro-repo-db-<A>`
and subscribes to box A's rooms while the data plane dials box B. Nothing syncs,
no error is raised, and the rail stays empty until a full reload — the one thing
that reset the module. That reload is the observed "cure" in the field report.

The fix adds `resetLocalPlatformSnapshotState()`, which clears those singletons
and stops the running poll interval, so the next read re-polls
`localPlatform.getSnapshot` against whatever `window.ipc` is installed now.
BlitzOS calls it from the INCOMING surface's render
(`packages/webapp/src/lody/SessionSurface.tsx`, `useLodyLocalBridge`, gated on a
new bridge so it fires once per box) — before that surface's child
`RuntimeProvider` re-reads the snapshot, and the departing surface (keyed by box
in `LodySessionsRegion`) does not re-render, so there is no teardown race.

Strictly additive: nothing upstream changes behaviour, because Electron never
calls the reset and the poll it guards still settles exactly once. The interval
was a local `let intervalId` in `startLocalPlatformSnapshotPolling`; it is
promoted to the module-scope `snapshotPollInterval` (renamed in place, same
three uses) only so the reset can clear a poll that has not settled yet.

| # | File | Line | Upstream anchor | What it does |
|---|---|---|---|---|
| 1 | `packages/components/src/providers/local-platform-provider.ts` | 31-34 | after `let snapshotPollingStarted = false;` | declares module-scope `snapshotPollInterval` |
| 2 | same | 40-95 | `let intervalId` in `startLocalPlatformSnapshotPolling` | drops the local `intervalId`, uses `snapshotPollInterval` in its place (declare/clear-on-settle/clear-on-error/assign) |
| 3 | same | 111-117 | after `ensureLocalPlatformSnapshotPolling()` | exports `resetLocalPlatformSnapshotState()` |

Guard: `packages/webapp/test/lody-local-platform-reset.test.tsx` drives the real
vendored hook across a box switch and fails without hunk 3.

**Candidate upstream PR:** key the local-platform snapshot by the installed IPC
bridge (or expose this reset) so a host driving more than one daemon can move
between them. Until then this is the smallest seam that closes it.
### 18. A renderer surface owns its IPC client (Tier 2 keep-alive, declared 2026-09-02)

Seam 17 makes sequential hand-off correct but cannot make two surfaces correct
at once. The renderer helpers formerly rediscovered page-global `window.ipc`,
so an asynchronous operation could leave through another surface's bridge. The
fix adds a structural `LodyIpcClient`: omitted arguments retain Electron's lazy
window-backed default, while an embedding host captures one bridge, provides it
to one React subtree and threads it into plain runtime code.

Bound clients now have a terminal disposal lifecycle. Disposal aborts their
signal, drains every previously registered listener idempotently, and makes
later service lookup/send/event operations reject or no-op.
The local-platform state is a client-keyed WeakMap; its abort listener clears a
never-settling snapshot interval and deletes the entry. The local Loro adapter
owns every message unsubscribe, not only its status listener.
`RuntimeProvider` also accepts one optional additive `onRuntimeLifecycle`
callback. It reports `starting` immediately before the constructor call, then
uses the same unique attempt id for `created` or rollback-complete `failed` and
for `disposed` after awaited runtime cleanup. `createWorkspaceRuntime` catches
every post-repo construction error, detaches any transport/listener installed
so far, and awaits `repo.destroy()` before rejecting. This lets an embedding
surface retain IPC authority until construction or repo destruction finishes.
Omission preserves upstream behavior. `RuntimeDeps.localIpcHost` and the matching facade dependency are an explicit
fast-path capability: supplying a client no longer implies a local plane.
Omission preserves the existing Electron/global-host test.

The Blitz-mounted public-browser panel is reachable from both desktop and
mobile `SessionDetail`; its calls therefore consume `useIpcClient()`. The theme
provider remains ambient without another vendor edit: Blitz hoists one provider
above its keyed surfaces, publishes compatibility `window.ipc` only for the
active surface, and its bridge explicitly no-ops `app.nativeTheme` and
`app.setNativeTheme`. Those reads cannot reach a data/session/machine plane.

**Cumulative seam-vs-upstream inventory.** The original Phase A change touched
exactly **19** vendor source files. The public-browser follow-up added two; seam
18 cumulatively touches the following **21** upstream files. This table is not
the smaller `ead5af60..HEAD` branch footprint:

| File | Stable upstream anchor | Mechanical seam change |
|---|---|---|
| `packages/components/src/lib/electron-ipc-client.ts` | `LodyIpcBridge`, four helpers, `getPublicBrowserBridge` | disposable client/default/bound factory and optional client arguments |
| `packages/components/src/providers/ipc-client-provider.tsx` | new file | client plus explicit `localIpcHost` context |
| `packages/components/src/providers/local-platform-provider.ts` | local snapshot singleton / `startLocalPlatformSnapshotPolling` | client-keyed state and abort cleanup |
| `packages/components/src/providers/runtime-provider.tsx` | `RuntimeProvider` / `createWorkspaceRuntime({...})` | consume and thread client and host capability |
| `packages/components/src/providers/create-workspace-runtime.ts` | `RuntimeDeps`, `canUseLocalSessionControl`, local attach | capture client/capability for runtime, control and presence |
| `packages/components/src/providers/local-loro-data-plane-connection.ts` | `createLocalLoroDataPlaneConnection` | explicit client plus owned message unsubscribes |
| `packages/components/src/providers/workspace-machine-rpc-facade.ts` | `WorkspaceMachineRpcFacadeDeps`, `canUseLocalMachineRpc` | explicit client and local-host capability |
| `packages/components/src/components/chat/chat-landing.tsx` | direct local file/project IPC calls | nearest `useIpcClient()` and final arguments |
| `packages/components/src/components/mentions/mention-project-file-source.ts` | `MentionProjectFileSource` local reads | nearest client and final arguments |
| `packages/components/src/components/sessions/session-chat-input-area.tsx` | local session-file sender construction | nearest client dependency |
| `packages/components/src/components/sessions/session-detail.tsx` | session action/file-provider assembly | nearest client dependency |
| `packages/components/src/components/sessions/session-file-content-view.tsx` | project file/history reads | nearest client and final arguments |
| `packages/components/src/hooks/use-chat-landing-file-draft.ts` | Electron file sender | context client argument |
| `packages/components/src/hooks/use-local-project-file-paths.ts` | local-project path RPC | context client argument |
| `packages/components/src/hooks/use-local-projects-admin.ts` | local-project admin RPC | context client argument |
| `packages/components/src/hooks/use-session-actions.ts` | session control/action fast paths | context client argument |
| `packages/components/src/lib/electron-session-file-sender.ts` | exported sender/capability helpers | optional client dependency |
| `packages/components/src/lib/local-project-rpc-file-provider.ts` | provider options / local service lookup | optional client dependency |
| `packages/components/src/lib/project-history-control-client.ts` | four history entry points | optional client dependency |
| `packages/components/src/components/sessions/public-browser-surface.tsx` | `getPublicBrowserBridge` during surface render | **added here:** context client argument |
| `packages/components/src/components/sessions/session-browser-panel.tsx` | back/forward/reload/stop public-browser callbacks | **added here:** context client argument/deps |

**Correctness follow-up footprint (2026-09-03).** The file list remains exactly
the 21 rows above. This pass changes only two already-listed seam files:

| File | Diff lines | Why every line is in the seam |
|---|---:|---|
| `packages/components/src/lib/electron-ipc-client.ts` | +9 / -2 | Wraps `on` to own each unsubscribe and drains that set from terminal `dispose`; no default-client behavior changes. |
| `packages/components/src/providers/runtime-provider.tsx` | +14 / -5 | Adds the optional three-phase lifecycle callback and emits it at construction settlement and completed disposal; absent callbacks retain prior behavior. |

Total vendor source footprint for this follow-up: **+23 / -7** lines across two
of seam 18's existing 21 files (exactly 30 changed lines).

**Final correctness footprint (2026-09-03).** This pass remains inside two
already-listed seam files:

| File | Diff lines | Why every line is in the seam |
|---|---:|---|
| `packages/components/src/providers/runtime-provider.tsx` | +13 / -6 | Adds `starting` plus attempt ids and carries the id through construction settlement and completed disposal; an absent callback still changes nothing. |
| `packages/components/src/providers/create-workspace-runtime.ts` | +11 / -1 | Wraps post-repo construction in rollback, upgrades rollback to transport teardown and then the full disposer as those become available, and rejects only after cleanup. |

Total vendor source footprint for the final pass: **+24 / -7** lines (31 changed
lines). The cumulative `ead5af60..HEAD` aggregate is ten vendor files at
**+258 / -89**, including nine source files at **+132 / -37**; the tenth file is
this seam inventory.

`packages/webapp/test/lody-ipc-client-isolation.test.ts` derives its inventory
from the import closure rooted at Blitz's `SessionSurface.tsx`. It fails every
unbound `getIpcServices`, `onIpcEvent`, `sendIpc`,
`sendLocalSessionControl`, `getPublicBrowserBridge`, or `window.ipc` site except
exact helper plus enclosing-function sites represented by this allowlist, with
the expected count inside each named scope. Moving a guarded call to an
unguarded function in the same file therefore fails even when the file/helper
count is unchanged:

| File | Why ambient IPC is allowed |
|---|---|
| `theme-provider.tsx` | Native OS theme/window-chrome channels only; both are declared bridge no-ops, and one hoisted active owner mounts it. |
| `atoms/local-probe.ts` | Returns before IPC outside Electron. |
| `hooks/use-electron-cli-daemon.ts` | Inert unless `window.__LODY_ELECTRON__`. |
| `components/terminal/electron-terminal-channel.ts` | Constructed only by the Electron-gated terminal host. |
| `components/sessions/session-chat-interface.tsx` | Ambient sites are inside Electron-only desktop path launch. |
| `lib/electron.ts` | Fullscreen IPC is Electron-gated. |
| `lib/native-browser.ts` | Native URL open is Electron/native-shell gated. |
| `lib/image-preview-export.ts` | Export IPC is Electron-gated. |
| `lib/clear-local-cache.ts` | IPC reload is Electron-gated; Web uses `location.reload()`. |
| `components/mobile/mobile-about-settings.tsx` | Blitz stubs every settings route; these updater actions are never mounted. |
| `components/mobile/mobile-general-settings.tsx` | Blitz stubs every settings route; these notification and OS-setting controls are never mounted. |
| `components/settings/about-setting.tsx` | Blitz stubs every settings route; these updater actions are never mounted. |
| `components/settings/general-setting.tsx` | Blitz stubs every settings route; these notification and OS-setting controls are never mounted. |
| `hooks/use-electron-auto-launch.ts` | Both callers are stubbed settings routes, and every operation returns unless its Electron flag is true. |
| `hooks/use-electron-updater-state.ts` | The effect returns unless `window.__LODY_ELECTRON__` is true. |
| `lib/native-global-shortcuts.ts` | All callers are Electron-only shortcut settings; Blitz disables both that surface and its dispatcher. |
| `lib/electron-ipc-client.ts` | The intentional compatibility default and sole production reader of `window.ipc`. |

**Candidate upstream PR: “allow an embedding renderer to provide a disposable
IPC client per React/runtime subtree.”** Commit sketch: (1) additive client,
provider and helper parameters with unchanged Electron defaults; (2)
client-keyed local-platform state released by the client signal; (3) explicit
local-host capability through runtime/facade; (4) mechanical mounted leaf
conversions, including public browser; (5) two-provider poison-global and
post-disposal tests. The API contains no Blitz URL, workspace or relay concept.
Drop seam 17's reset implementation once the keyed provider lands upstream.

## Transition-only patches to the published npm artifact

At HEAD, `packages/box/Dockerfile` installs `lody@0.88.1` from npm and applies
these five scripts at box-image build. Nothing under `vendor/lody` changes.
This is the shipping transition only, until plan PR C replaces the npm package
with the daemon built from this tree. An upstream merge does not select, bump,
or re-audit an npm artifact; that procedure exists only in repository history.

| Patch | Target | Anchor | Reason |
|---|---|---|---|
| `packages/box/patches/lody-local-platform.mjs` | `lody/dist/index.js` | 4× `resolvePlatformKind("cloud")` | The transitional npm artifact is the CLOUD build: its Vite config inlines the platform as a literal, so the local composition root is unreachable and the daemon blocks on a device-authorization login. The patch restores the `LODY_PLATFORM` env read. The source build already emits local mode, so this patch is deleted by plan PR C. |
| `packages/box/patches/lody-acp-auth-queue.mjs` | `lody/dist/index.js` | the `extractQueueKey` switch tail in `MessageProcessor` | Every `machine/*` message falls to `extractQueueKey`'s `default: return null`, and `ConcurrentQueue` maps `null` onto ONE serial chain (`__default__`). `machine/acp-authenticate` with `action: 'start'` runs `claude auth login --claudeai`, which blocks on stdin until the member pastes the code back — so the `submit-code` carrying that code queues behind the login waiting for it, and so does `cancel`. The patch gives a `start` its own per-agent chain. Without it an interactive agent sign-in can never be completed, only timed out after 285 s. |
| `packages/box/patches/lody-code-collab-worktree-root.mjs` | `lody/dist/index.js` | the `project?.kind === "local"` branch of `resolveCodeCollabWorkspaceRoot` | That branch answers with the local project's ROOT PATH and never reads `project.useWorktree` or `meta.isWorktree`, so once no live `Session` object is left the whole Code Collab surface of a worktree session — All Changes, the Files tab, every file chip — resolves to the `/workspace/<repo>` clone instead of the worktree. The clone is clean by design, so the panel renders an empty SUCCESS ("No changes yet.") rather than an error. The patch answers with the worktree when the session is a worktree session and the worktree exists. Without it the side panel of every BlitzOS worktree session is silently empty. |
| `packages/box/patches/lody-builtin-mcp-off.mjs` | `lody/dist/index.js` | the first line of `AgentClient.buildMcpServers` (`const builtin = this.buildBuiltinMcpServers(workdir);`) and the `LODY_MCP_TOOLS_REMINDER` declaration in `buildPrompt` | Every ACP agent is handed one stdio MCP server, `lody __internal lody-mcp-server`, which is the whole `lody` bundle loaded again as a child of the agent: 266 MB resident per session (measured on a cx33, 2026-09-02), the largest per-session fixed cost on a box, serving tools BlitzOS does not use (`lody_session_*`, `lody_task_*`, `lody_review_submit`, `lody_report_preview_candidate`). Codex starts it in its own process group, so the daemon's group kill never reaches it and it outlives its agent. The patch makes the built-in list empty — workspace-configured MCP servers still load — and blanks the per-turn reminder that would otherwise advertise the missing tools. |
| `packages/box/patches/lody-session-sandbox.mjs` | `lody/dist/index.js` | the `parentDir` line of `LinuxCgroupSessionSandbox.initialize` and the `memoryMaxBytes`/`cpuMax` lines of `calculateAutomaticSessionSandboxLimits` | The daemon ends a session by signalling the agent's process group, but codex runs tool commands under their own session id and starts MCP servers in their own groups, and Claude Code's Bash tool is detached — so `npm test` trees and MCP servers outlive the session. Lody's per-session cgroup sandbox (`cgroup.kill` on termination) is the fix and is inert on a box, because it derives its parent from the daemon's own cgroup, which cannot hand controllers to children while holding the daemon (cgroup v2's no-internal-process rule). The patch parents the leaves beside `lody.scope` instead, under `blitz-user.slice/lody-sessions`, which `blitz-cgroup init` builds with `+memory +pids +cpu` and hands to uid 1000; and it drops upstream's memory/cpu capacity split (25% reserved, the rest divided across open sessions), so the leaves write `max` and keep only `pids.max` 1024. The box's own ceiling stays the only budget. |

Applied in that order. **The order is not cosmetic:** `lody-local-platform`
guards on a sha256 of `dist/index.js` AS PUBLISHED, so nothing may rewrite the
file before it runs. The other four therefore guard on the installed package's
version plus their own anchor at exactly one occurrence — a file hash can
only ever pin the first patch in a chain. All five are idempotent: re-running
any of them on an already-patched bundle reports it and exits 0, which is what
lets `packages/webapp/test/lody-daemon-harness.ts` copy a real box's bundle and
re-apply the image build's patches to the copy.

The queue patch is strictly NARROWING. The only message that changes chains is
the `machine/acp-authenticate` start that was blocking the others; nothing gains
a peer it did not already have. Grouping starts per agent type is a rule the
daemon already enforces one layer in, from `runningByAgentType`
(`apps/cli/src/agent/acp-authentication.ts`), so this moves it out rather than
inventing it. **Open upstream as "keyless control messages should not serialize
behind a long-running interactive login", and drop this patch when it merges.**

The table is the current-behavior record; `docs/LODY-MERGE.md` is the only
procedure. Plan PR C may delete a compiled script only after its behavior is
supplied by the source build, moved to a declared source seam, or deliberately
retired. The approved design already settles three: source builds local mode,
upstream now resolves Code Collab worktree roots, and ACP authentication becomes
the source seam below. The built-in MCP and cgroup-sandbox behavior landed after
the initial spike and must receive an explicit source/configuration disposition
before their transition scripts disappear.

### Target daemon source seam: ACP authentication queue

Plan PR C moves the queue behavior to
`apps/cli/src/lib/message-processor.ts`, beside `extractQueueKey`. Only
`machine/acp-authenticate` with `action: 'start'` returns
`acp-auth:${message.agentType}`. Submit and cancel return `null`, so they
remain able to run while the interactive login waits. Starts for one agent type
serialize; starts for different agent types may proceed independently.

**Merge conflict drill.** If upstream adds an equivalent non-blocking lane,
classify this as A and do not add the seam. If the switch merely moves, classify
it as B and keep the exact start-only rule. If upstream replaces queueing or
authentication concurrency, classify it as C and stop for a human. The focused
source test must hold one start open, prove submit and cancel run before release,
prove same-agent starts serialize, and prove different-agent starts may overlap.

## Planned seams (not yet applied)

Declared ahead of time so a merge agent recognises them when they appear.

| File | Upstream anchor | Reason | Phase |
|---|---|---|---|
| ~~`create-workspace-runtime.ts` — websocket transport~~ | — | **Not needed, and the plan's §5.3 item 1 is withdrawn.** Phase 1 measured that the daemon already SERVES its `LoroRepo` on a unix socket for the Electron renderer, so the browser speaks Lody's own protocol v7 through `blitz-lody-bridge` rather than a `loro-repo` `transport/websocket`. The local branch in this file was already the one we want. See `plans/evidence/lody-phase1.md` §A.b. | — |
| ~~`workspace-machine-rpc-facade.ts` — box websocket RPC plane~~ | — | **Not needed.** The facade's existing LOCAL plane is the one we want; it reaches `window.ipc`, which we install. What it needed instead was the predicate widening above, which is a far smaller patch than a new plane. | — |
| ~~`packages/components/src/lib/electron-ipc-client.ts`~~ | — | **Applied as seam patch 18.** A page-global bridge is sufficient only while surfaces are sequential; Tier 2 requires a client per renderer subtree. | Tier 2 |
| ~~`loro-sidebar.tsx` — suppression props~~ | — | **Applied**; see seam patch 2 above. | 4 |

## Things upstream does not support that we work around OUTSIDE the vendor tree

Recorded here because each is a candidate seam if the workaround stops holding.

- **The command palette and its keyboard shortcuts are not mounted at all, and
  three of its commands would ignore a host tab if they were.**
  `session.archiveCurrent` (`$mod+Alt+a`), `session.closeFocusedTab` and the
  `session.nextTab` / `session.previousTab` cycle all resolve against
  `SessionDetail`'s own URL-derived `activeTabSessionId` (the archive/close/cycle
  handlers around `session-detail.tsx:2483`, `:4013`, `:4361`), which is the
  CONVERSATION selection — a host tab is invisible to
  every one of them, so with a terminal on screen they would act on the chat
  behind it. **They cannot be reached in the BlitzOS mount**: the registry's
  capture-phase keydown listener is attached by `commands.attach(window)` in
  `components/AppInitializer.tsx`, which only `routes/__root.tsx` mounts, and
  `CommandPalette` is mounted only by `routes/$workspaceName/_auth.tsx`. This
  surface mounts neither (`packages/webapp/src/lody/SessionSurface.tsx`, "what
  we do not mount, and why it is safe"), so no chord reaches a command and no
  palette reaches `execute()`. Recorded rather than fixed, because a host-side
  fix would be a fix to something that does not run;
  `packages/webapp/test/lody-terminal-tab-wave3.test.tsx` pins both halves, so
  the day either dispatcher is mounted the limitation becomes a failing test.
  **Candidate upstream PR: resolve the close and cycle targets over the same
  `viewerTabs` the strip already draws** (`getSessionTabCloseTarget`,
  `lib/session-tab-close-target.ts:8`) — the same list seam patch 5 fills, which
  is why it is one idea with that patch rather than a new one.
- ~~**`LoroSidebar` has no header/footer suppression props.**~~ Phase 4 added
  them at seam patch 2 and drafted the upstream PR
  (`plans/evidence/lody-sidebar-props-pr.md`).
- **`useAuthenticatedConvex` throws without a provider**, and the composer's
  mention sources call it even with `cloudApi: null`. Supplied from
  `packages/webapp/src/lody/platform.tsx` with the settled signed-out value
  their own Storybook preview uses.
- **`useAuthClient()` has no local-platform branch**, and `SessionDetail`
  reaches it through `useWorkspaceMembers` (`hooks/use-workspace-members.ts:26`),
  which calls `authClient.useActiveOrganization()`. A real better-auth client
  fetches on subscribe, which this composition promises never to do, so
  `packages/webapp/src/lody/inert-auth-client.ts` supplies four settled
  signed-out reads and nothing else — any other member is absent, so a new
  upstream call site throws a TypeError naming it. Their own `AuthProvider`
  carries it. Candidate seam if the client's surface grows.
- **`theme-provider.tsx` calls two Electron IPC channels unconditionally**:
  `app.setNativeTheme` (`:155`) and `app.nativeTheme` (`:139`). Both ask the
  main process to repaint OS window chrome. `local-bridge.ts` accepts them as
  no-ops rather than refusing, because a refusal is an unhandled rejection on
  every mount. Candidate upstream PR: guard both on `getIpcServices()` being an
  Electron bridge.
- **`theme-provider.tsx` writes `document.documentElement.style.colorScheme`**
  (`:149`) — an inline style on the html element, outside the Lody surface,
  which beats any stylesheet of ours. `SessionSurface.adoptShellTheme()` forces
  their stored theme to the shell's on every mount so the two never disagree.
- **`createWorkspaceRuntime`'s startup ACP capabilities pass never runs for a
  BlitzOS box**: its `listMachineIds` port reads the Convex-authorized machine
  set (`:2455`), and the box is visible only through
  `buildVisibleMachineIndex`'s owner fallback, which is excluded from it.
  `packages/webapp/src/lody/agent-configs.ts` runs their own
  `runStartupAcpCapabilitiesRefresh` over BlitzOS ports instead. Candidate
  upstream PR: let the caller supply the machine list.
- **`locales/en.json` is a FLAT map with dotted keys**, so any i18next instance
  built for their components needs `keySeparator: false` — their own init sets
  it (`i18n/index.tsx:121`) and `packages/webapp/src/lody/i18n.ts` now does too.
  Not a divergence, a required initialization option; recorded because getting
  it wrong is silent.
- **Two strings in `locales/en.json` are wrong on a box** (panels-b sweep).
  `packages/webapp/src/lody/i18n.ts` merges `BLITZ_LODY_EN_OVERRIDES` over their
  bundle, so neither is a vendor edit. `sessions.fileSave.conflictDetail`
  interpolates `{{conflict}}` and no call site passes one — the save-conflict
  banner printed the raw placeholder (SP23-I18N), and the replacement is
  upstream's own inline default for that key. `sessions.fileViewer.save.withShortcut`
  advertises "Save (⌘S / Ctrl+S)", and this surface mounts no dispatcher for
  `$mod+s` (`v1-scope.ts`, `keyboardShortcuts`), so the Save button promised a
  chord nothing answers (SP21-KEY, user ruling: drop the advert, do NOT mount
  the command layer). `packages/webapp/test/lody-panel-fixes.test.tsx` asserts
  the VENDORED string still carries each defect, so an upstream fix fails a test
  and the override is deleted rather than shadowing a corrected string.
  **Candidate upstream PR for the first one: pass the conflict the runtime
  already has** (`SaveTextConflictError.conflict`) into that `t()` call.
- **The archive path cannot resolve a local project's root path** (phase 5).
  `resolveWorktreeCleanupTarget` (`apps/cli/src/lib/message-handler.ts:4330`)
  merges `machineMeta.localProjects` with `getMachineFlockLocalProjects(
  options.machineFlockRows)`. The DELETE caller passes `machineFlockRows`
  (`:4514`); the ARCHIVE caller does not (`:3986`) — and the same asymmetry is in
  the shipped bundle (`lody/dist/index.js:169066` vs `:169476` at 0.88.1). Since
  `local-project/add` writes only the FLOCK row (`lody-fleet.ts:1552` →
  `local-project-meta.ts:76`), archive resolves nothing on a box, returns `null`,
  and leaves the worktree on disk with the member's uncommitted work in it and no
  backup commit. `packages/webapp/src/lody/local-projects.ts` mirrors the Flock
  rows into the legacy `machineMeta.localProjects` field, which both paths still
  read. **Candidate upstream PR: pass `machineFlockRows` on the archive path** —
  four lines, and then this mirror is deleted.
- **The positional `localProjects.*` IPC helpers carry no `machineId`**, because
  in Electron the main process IS the machine and fills its own id in.
  `requestLocalProjectGitState` (`workspace-machine-rpc-facade.ts:1006`) calls
  `getGitState(workspaceId, localProjectId)` with two arguments, and every
  `local-project/*` request schema requires `machineId`. On a box the main
  process is the box and the browser is not, so `local-bridge.ts` resolves the id
  from `/lody/platform` and injects it. Not a divergence — an adaptation the
  Electron seam does not need — but it is why every one of those helpers silently
  failed the daemon's `.strict()` parse until phase 5.
- **A local project's repo name is dropped unless the cloud already knows the
  repo** (phase 5). `resolveLocalProjectGithubRepoFullName`
  (`components/chat/chat-landing.tsx:522`) returns the name the daemon derived
  from the clone's remote only if it also appears in `repositories`, the
  workspace's cloud-connected GitHub repo list. With no cloud that list is empty,
  so a worktree session's `ProjectRef` never carries `githubRepoFullName` — and
  then the rail groups it under Chats instead of GitHub Worktrees, and turn
  post-processing skips `updateSessionDiffStats` altogether
  (`session-execution-service.ts:2351`). `publishBoxReposAsWorkspaceRepos`
  (`packages/webapp/src/lody/local-projects.ts`) writes the box's own clones into
  `setWorkspaceReposCacheAtom` instead, which is the other half of
  `freshRepositories ?? cachedRepositories`. Candidate upstream PR: treat a local
  project's own remote as sufficient when the workspace has no cloud repo list.
- ~~**The local attachment fast path is gated on `__LODY_ELECTRON__`.**~~ Phase 6
  applied the hunk at seam patch 3 and drafted the upstream PR
  (`plans/evidence/lody-attachment-seam-pr.md`).
- **`acpSessionId` is persisted before the ACP session has carried a turn**
  (canary dogfood 3). `createSessionInnerWithAgent` writes it as soon as the
  adapter answers `session/new` (`apps/cli/src/session/session-manager.ts:1455`),
  and the claude adapter accepts `session/new` while the CLI is signed out — it
  refuses only at prompt time. So a turn that fails `acp_auth_required` leaves an
  id for an ACP session that holds no conversation. The member signs in, sends
  the next message, and the daemon RESUMES it: `loadSession` answers `Resource
  not found`, the daemon falls into its replay fallback
  (`session-execution-service.ts:3499`), and THAT turn comes back
  `agent_no_output`. Measured against a real `lody@0.88.1` in
  `packages/webapp/test/lody-post-signin-turn.test.ts`; the daemon's own log
  reads `[ACP_RESUME_FAILED] loadSession: Resource not found` and then
  `completed without any agent output`. `packages/webapp/src/lody/session-auth-recovery.ts`
  drops the phantom id from the session's doc meta —
  an authored write on a dual-authored document, so no vendor hunk — under three
  conditions, so an id that names a real conversation is never touched.
  **Candidate upstream PR: persist `acpSessionId` only once the ACP session has
  carried a turn, or clear it when a resume reports the session is gone.** The
  silent turn behind the fallback is a second, separate upstream defect and is
  not fixed here; the leading explanation is the adapter resolving a dead SDK
  stream as `end_turn` with no notification (`dist/claude-acp.js:63062`).
- **Lody's own interactive terminal cannot reach a browser.**
  `LocalTerminalPanel` is a real PTY (xterm.js → `TerminalChannel` → Electron
  IPC → `TerminalRelay` → node-pty), and it is Electron-gated at two hard
  places: `TerminalDockHost` returns `null` unless
  `window.__LODY_ELECTRON__ === true` (`components/terminal-dock-host.tsx:25`,
  `:54`) and `TerminalDockToggleButton` unless `isElectronRenderer()`
  (`session-detail.tsx:628`). Their own docs say so
  (`site-docs/.../(features)/terminal.mdx`). So BlitzOS keeps ttyd + tmux as the
  tab CONTENT and adopts Lody's tab CHROME through seam patch 5 — and the gate
  is also why the dock needs no hunt to stay invisible in our mount. **Watch for
  the day `TerminalChannel` gains a non-Electron transport**: our channel
  adapter would be a ~150-line file and the dock becomes an option again. Note
  what would be LOST if it were adopted as-is, so the trade is re-made and not
  assumed: the dock draws its own strip (`lody-terminal-tab-strip`,
  `terminal-dock.tsx:490`), which is the second strip this whole effort deletes;
  its open/active memory is a module-level `Map` that does not survive a reload,
  where tmux survives the daemon and the browser; and `blitz-term`'s type map is
  what makes a tab a Claude Code or Codex TUI.
- **`acp-extension-dsh` is an empty submodule.** Aliased to a local stub; see
  `UPSTREAM.md`.
- **`packages/components/vite-renderer-bundle-aliases.ts` cannot be imported.**
  It resolves `./node_modules/beautiful-mermaid/...` next to itself at module
  load, which only exists under pnpm's nested layout. The two rules we need
  (`shiki/bundle/full` → `shiki`, and the loro WASM URL rewrite) are ported into
  `packages/webapp/src/lody/vendor-bridge.ts` instead.
- **Their Tailwind entry cannot be imported into a cascade layer.**
  `@import "…/tailwind/index.css" layer(lody)` fails with "`@utility` cannot be
  nested", so the compiled output is wrapped instead. See
  `plans/evidence/lody-phase0.md`.
