# BlitzOS divergences from upstream Lody

Every deliberate edit inside `vendor/lody` is listed here, with the file, the
upstream anchor it depends on, and the reason. An upstream-merge agent treats
this file as its conflict manual (`plans/LODY-SESSIONS.md` §5.3, §5.4).

**The rule: nothing in `vendor/lody` is edited except at a declared seam.**
Everything BlitzOS-specific lives in `packages/webapp/src/lody/`. If a vendored
component cannot render without a change, stub around it from there or record a
blocker — do not patch the vendor tree.

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

| # | File | Line (at `f3474894`) | Upstream anchor | What it gates |
|---|---|---|---|---|
| 1 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 120 | `window.__LODY_ELECTRON__ &&` inside `canUseLocalMachineRpc`'s `Boolean(...)` | every local Machine RPC, including `session/dispatch-turn` |
| 2 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 182 | `const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__;` | `file/preview-local`; without it a local path is sent to Streams |
| 3 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 1001 | `window.__LODY_ELECTRON__ &&` in `requestLocalProjectGitState` | the sidebar's branch/worktree state |
| 4 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 1057 | `window.__LODY_ELECTRON__ &&` in `requestLocalProjectControl` | every `local-project/*` and `worktree/*` call |
| 5 | `packages/components/src/providers/create-workspace-runtime.ts` | 2058 | `if (!window.__LODY_ELECTRON__) {` in `canUseLocalSessionControl` | `session/create`, `session/chat`, `machine/*` |
| 6 | `packages/components/src/window-globals.d.ts` | 31 | `__LODY_ELECTRON__?: true;` | declares `__LODY_LOCAL_BRIDGE__?: true;` so the five above typecheck |

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

`create-workspace-runtime.ts:299` (`isElectronLocalDataPlaneEnabled`) is
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

Expected after seam patch 7: exactly THIRTEEN files — the three above with six
added/changed lines, plus `components/loro-sidebar.tsx` from seam patch 2,
`lib/electron-session-file-sender.ts` from seam patch 3,
`components/sessions/session-chat-interface.tsx` +
`components/sessions/session-detail.tsx` from seam patch 4,
`components/sessions/session-tab-bar.tsx` from seam patch 5, which also adds
hunks to `session-detail.tsx`, and seam patch 7's five new ones:
`lib/session-github-state.ts`, `components/chat/chat-landing.tsx`,
`components/chat/unified-project-selector.tsx`,
`components/sessions/session-chat-input-area.tsx` and
`components/sessions/session-conversation-diff-panel.tsx`.

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

| # | File | Line (at `f3474894`) | Upstream anchor | What it does |
|---|---|---|---|---|
| 1 | `packages/components/src/components/loro-sidebar.tsx` | 175 | after `bottomFloatingContent?: ReactNode;` in `LoroSidebarProps` | declares `hideHeader?: boolean` and `hideFooter?: boolean` |
| 2 | same | 649 | after `bottomFloatingContent,` in the destructuring | defaults both to `false` |
| 3 | same | 893 | the `group/sidebar-header` `<div>` | wraps it in `{hideHeader ? null : ( … )}` |
| 4 | same | 1234 | the `getLoroSidebarFooterClassName(isMobile)` `<div>` | wraps it in `{hideFooter ? null : ( … )}` |

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
filter popover renders on MOBILE (`:1265`); the desktop trigger lives in the
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

| # | File | Line (at `f3474894`) | Upstream anchor | What it gates |
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

| # | File | Line (at `f3474894`) | Upstream anchor | What it does |
|---|---|---|---|---|
| 1 | `packages/components/src/components/sessions/session-chat-interface.tsx` | 1740 | after `hideMessageArea?: boolean;` in the props interface | declares `readOnly?: boolean` |
| 2 | same | 1910 | after `hideMessageArea = false,` in the destructuring | defaults it to `false` |
| 3 | same | 5876 | `{shouldReplaceComposerWithPermission ? null : (` | adds `readOnly ||`, so the composer is not rendered |
| 4 | same | 5761 | the `<FloatingPermissionRequest …/>` element | wraps it in `{readOnly ? null : ( … )}` — its options are answers, and an answer this viewer cannot write is a button that does nothing |
| 5 | `packages/components/src/components/sessions/session-detail.tsx` | 667 | the inline props type and destructuring of `SessionDetail` | declares and defaults `readOnly` |
| 6 | same | 4930, 5558 | the `<SessionChatInterface>` that renders a session tab | passes `readOnly={readOnly}` |

The `headerVariant="toolbar"` instance at `:5448` is deliberately NOT passed the
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

| # | Line (at `f3474894`) | Upstream anchor | What it does |
|---|---|---|---|
| 1 | 1 | the `react` import | adds `type ReactNode` |
| 2 | 43 | `export interface ViewerTabItem` | widens `type` to `'file' \| 'diff' \| 'custom'` and adds `icon?: ReactNode` |
| 3 | 464 | the `<span className="shrink-0">` glyph in `ViewerTabContent` | draws `tab.icon` when the host supplied one |
| 4 | 58 | `parentSession: SessionMeta;` | makes it `parentSession?: SessionMeta;` |
| 5 | 726 | `[parentSession.id, ...sortableIds]` | reads the id only when `showSessionTabs` AND a session was given |
| 6 | 766 | `<AdaptiveTabStripItem itemId={parentSession.id}>` | the existing `showSessionTabs &&` guard gains `parentSession &&` |

Hunks 4–6 are the "a strip need not be rooted in a session" half, and they are
what `packages/webapp/src/lody/TerminalTabsStrip.tsx` mounts: the same component,
`variant="viewer"`, on the chat landing where there is no session to root it in.

`packages/components/src/components/sessions/session-detail.tsx`

| # | Line (at `f3474894`) | Upstream anchor | What it does |
|---|---|---|---|
| 7 | 90 | the `react` import | adds `type ReactNode` |
| 8 | 657 | after `TerminalDockToggleButton` | declares `SessionSurfaceTab` and the `EMPTY_SURFACE_TABS` default |
| 9 | 667 | after `readOnly = false,` and its type entry (seam patch 4's anchor) | declares and defaults `surfaceTabs`, `activeSurfaceTabId`, `onSurfaceTabSelect`, `onSurfaceTabClose` |
| 10 | 3393 | immediately above `viewerTabItems` | maps `surfaceTabs` to `ViewerTabItem[]`, memoized so a page contributing none hands `SessionTabBar` one stable empty array |
| 11 | 5510 | `variant="session"` in the `SessionTabBar` element | `variant={surfaceTabs.length > 0 ? 'mixed' : 'session'}` |
| 12 | 5517 | after `onNewTab={handleNewTab}` | passes `viewerTabs`, `activeViewerTabId`, `onViewerTabSelect`, `onViewerTabClose` |
| 13 | 5586 | before `desktopChatSurfaces` | `activeChatSurfaceId`: an active HOST tab deselects every conversation surface, the same rule `hasActiveViewerTab` applies to the strip |
| 14 | 5587, 5626 | the two `const isActive = … === activeTabSessionId;` | read `activeChatSurfaceId` instead |
| 15 | 5624 | the end of `desktopChatSurfaces`'s children | maps `surfaceTabs` to `<div className={cn('absolute inset-0', !isActive && 'hidden')}>{tab.content}</div>`, the same shape the drafts get |
| 16 | 667 | beside hunk 9's four props | declares `onSessionTabSelect` |
| 17 | 756 | `const [activeTabSessionIdRaw, setActiveTabSessionId] = useState<string>(` | keeps the raw setter as `setActiveTabSessionIdState` and adds `setActiveTabSessionId`, a wrapper that announces the tab it selected |
| 18 | 947, 2585, 2591 | the three `setActiveTabSessionId` writers that are a CORRECTION | take the raw setter instead |
| 19 | 728 | beside hunk 16's `onSessionTabSelect` | declares `onSessionMissing`, and holds it in a ref beside `onSessionTabSelectRef` |
| 20 | 4408 | inside upstream's `sessionPresenceState === 'not-found'` effect, above `fireDetailNotFoundOnce` | calls `onSessionMissing?.(sessionId)` |

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
host's selection has to end when the page selects a conversation tab — and that
selection is `useState` (`activeTabSessionIdRaw`), per parent session, not in the
URL and not in any atom. Without a notification the host tab stays selected,
hunk 15 keeps drawing it, and clicking a session tab in the strip does nothing a
member can see.

**Why the SETTER and not `handleSessionTabSelect`.** Ten call sites move that
state, and the first version of this patch notified from the strip's own handler
alone. That left the other nine inert — the strip's `+` created a draft tab that
opened underneath the host tab and never appeared, which is the same defect one
button along. A wrapper is one mechanism for all of them, and it is one place to
add the next one.

**Why a wrapper and not an effect on the value.** An effect fires on a CHANGE,
and the click that most needs the call changes nothing: the parent tab is
already `activeTabSessionId` while a host tab covers it, so the one transition
the field report was about is exactly the one a change check swallows.

Hunk 18's three exclusions are `setActiveTabSessionId((prev) => …)` corrections
rather than selections: the session-switch reset (which runs during RENDER,
where a host callback may not be called at all) and the two `?tab=` URL syncs,
which re-assert a selection that already happened and re-fire whenever the
parsed value's identity changes. Their signature difference — an updater, not an
id — is what makes the exclusion structural rather than a judgement call: the
wrapper takes a `string`.

**Hunk 10's position is load-bearing, and it is not where the design put it.**
`SessionDetail` returns early below `:3400` (the loading and missing-session
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
a fourth, hand-maintained kind enum (`mobile/mobile-session-tab-sheet.tsx:55`);
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

| # | Line (at `f3474894`) | Upstream anchor | What it does |
|---|---|---|---|
| 21 | 666, 672 | `onMobileBack,` and `onMobileBack?: () => void;` — seam patch 5's own anchor | declares and defaults `sideChatRequiresAssistantTurn`, `false` |
| 22 | 1080 | immediately above `const activeSessionTabId = useMemo<SessionId \| null>` | holds the active tab id in a ref and adds `activeTabAssistantTurnId` state |
| 23 | 1691 | `chatRefsMap.current.set(tabId, ref);` inside `setChatTabRef` | mirrors `getLastAssistantTurnId()` into that state on ATTACH |
| 24 | 3358 | `disabled: launcherState === 'disabled' \|\| isCreatingSideSession,` in `sideChatOption` | adds the third term, gated on the prop |

Hunk 24 is the only one that replaces an upstream line, so it is the only one
named in `lody-surface-tabs.test.tsx`'s anchor table; the other three add lines
and are covered by that file's subsequence check.

**Why a mirror and not a read.** `chatRefsMap` is a ref: `getLastAssistantTurnId()`
answers when somebody asks, which is right for a click and useless for a rendered
state — nothing re-renders when a turn lands. Hunk 23 turns the ref write into a
state write, and `useImperativeHandle` is what makes it current: the handle's own
dependency list carries `lastCompletedAssistantMessageId`
(`session-chat-interface.tsx:4661`), so React re-attaches the ref on the commit
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

**One idea, 40 hunks in seven files, and every one of them is inert by default.**
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
they are the `f3474894` baseline's own numbers (that file is pinned by
`packages/webapp/test/upstream-baseline/`); for `session-chat-interface.tsx`
seam patch 4 shifted everything below its line 1910 by five.

`packages/components/src/lib/session-github-state.ts` — the single point every
GitHub surface reads through

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 1 | 78 | `export const getSessionGitHubState = (` | adds a third parameter, `gitHubIntegrationAvailable = true`, and the doc comment that says when to pass it |
| 2 | 81, 82 | `const repoFullName = (resolveProjectGitHubRepo(...))` and `const latestPr = getLatestPullRequest(sourceSession);` | both answer the flag: `''` and `null` with it off |

Hunk 2 is why the rest is small. `canShowGitHubActions` is `!!repoFullName`,
`hasExistingPr` is `!!repoFullName && !!latestPr`, and every consumer named in
the matrix — the info bar (`session-info-action-state.ts:43`), the PR tab
(`session-detail.tsx:3475`, `:5508`), the PR badge
(`session-chat-interface.tsx:5135`), the diff panel's `commentsEnabled` and
`prLinked` (`session-conversation-diff-panel.tsx:662`, `:665`) — is downstream
of those two values.

`packages/components/src/components/sessions/session-chat-interface.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 3 | 152 | the `@/lib/app-location` import | imports `useAppCapability` |
| 4 | 1005 | `compact = false,` in `SessionHeaderMenu`'s destructuring | defaults `hideCloudMenuItems` to `false` |
| 5 | 1032 | `compact?: boolean;` in its inline props type | declares `hideCloudMenuItems?: boolean` |
| 6 | 1343 | `{owner && !isArchived ? (` | adds `&& !hideCloudMenuItems` — IC83 |
| 7 | 1388 | `{sharing && sharing.visibility !== 'team' ? (` | the same term — IC84 |
| 8 | 1473 | the `Copy URL` `<DropdownMenuItem>` | wraps it in `{hideCloudMenuItems ? null : ( … )}` — IC88 |
| 9 | 1740 | `readOnly?: boolean;` in `SessionChatInterfaceProps` | declares `hideCloudMenuItems`, `hideNotificationPrompt`, `hideAgentRoles` |
| 10 | 1910 | `readOnly = false,` in the destructuring | defaults all three to `false` |
| 11 | 2146 | above the `getSessionGitHubState` memo | reads the `githubIntegration` capability |
| 12 | 2156, 2157 | the memo's body and dependency list | passes it as the third argument |
| 13 | 5581 | `onOpenReviewSettings={…}` on `<SessionHeaderMenu>` | passes `hideCloudMenuItems` |
| 14 | 5774 | `<NotificationPermissionPrompt … />` | wraps it in `{hideNotificationPrompt ? null : ( … )}` — IC60 |
| 15 | 5879 | `session={session}` on `<SessionChatInputArea>` | passes `hideAgentRoles` |

`packages/components/src/components/sessions/session-detail.tsx` (pinned)

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 16 | 214 | the `@/lib/session-github-state` import block | imports `useAppCapability` |
| 17 | 695 | `readOnly = false,` in the destructuring | defaults the four new props |
| 18 | 711 | `readOnly?: boolean;` in the inline props type | declares `hideCloudMenuItems`, `hideNotificationPrompt`, `hideAgentRoles`, `keyboardShortcutsAvailable` |
| 19 | 1563 | above the `getSessionGitHubState` memo | reads the `githubIntegration` capability |
| 20 | 1564, 1565 | the memo's body and dependency list | passes it as the third argument |
| 21 | 3719 | the `});` that closes the `session.focusInput` registration | passes `keyboardShortcutsAvailable` as `useCommand`'s second argument — C100 |
| 22 | 5723 | `readOnly,` in the shared chat-surface props builder | forwards the three `hide*` props to every chat surface the page mounts |

Hunks 20 and 21 are the only three lines this patch removes from the baseline,
and all three are named in `lody-surface-tabs.test.tsx`'s anchor table.

`packages/components/src/components/sessions/session-chat-input-area.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 23 | 17 | the `@/lib/agent-role-form` import | imports `useAppCapability` |
| 24 | 372 | `session: SessionMeta;` in `SessionChatInputAreaProps` | declares `hideAgentRoles?: boolean` |
| 25 | 460 | `session,` in the destructuring | defaults it to `false` |
| 26 | 1926 | `const repoFullName = useMemo(() => resolveSessionRepoFullName(session), [session]);` | answers the capability, so `@issue`/`@pr` and the `#123` hydrator go dark — C17, C18, C19 |
| 27 | 2168 | `agentRoles={agentRolesProp}` on the mobile run-config sheet | `undefined` when hidden |
| 28 | 2201 | `agentRoles={agentRolesProp}` on `<DesktopRunConfigMenu>` | `undefined` when hidden — C86-C89, and with no Role selectable C91 cannot fire |

`packages/components/src/components/chat/chat-landing.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 29 | 382 | `onSelectionUrlSync?: …` in `ChatLandingProps` | declares `hideProductHints` and `hideAgentRoles` |
| 30 | 559 | `onSelectionUrlSync,` in the destructuring | defaults both to `false` |
| 31 | 3774 | `agentRoles={{ … }}` on the desktop run-config menu | `undefined` when hidden |
| 32 | 4080 | `agentRoles={{ … }}` on the mobile one | the same |
| 33 | 4163 | above `selectedLocalProjectGithubRepoFullName` | reads the `githubIntegration` capability and returns `undefined` without it |
| 34 | 4273 | `return { kind: 'github' …, repoFullName: selectedRepo, … }` in `mentionSource` | drops the repo name without the capability |
| 35 | 6541 | `hintType={hintType}` | `null` when `hideProductHints` — S7, S8, S9, S10 in one line |

`packages/components/src/components/chat/unified-project-selector.tsx`

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 36 | 20 | the `@/lib/github-avatar` import | imports `useAppCapability` |
| 37 | 398 | `const { t } = useTranslation();` in `UnifiedProjectSelectorView` | reads the capability |
| 38 | 635 | the `repos.connectMore` `<DropdownMenuItem>` | renders it only with the capability — C65 |

`packages/components/src/components/sessions/session-conversation-diff-panel.tsx`
— the same two-line shape as hunks 11-12, and what takes SP43 and SP44 with it:
`commentsEnabled` and `prLinked` are both `Boolean(latestPrNumber && repoFullName)`.

| # | Line | Upstream anchor | What it does |
|---|---|---|---|
| 39 | 47 | the `@/lib/github-token` import | imports `useAppCapability` |
| 40 | 430, 432, 433 | the `getSessionGitHubState` memo | reads the capability and passes it as the third argument |

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

## Patches to the published npm artifact (NOT to this tree)

These are applied at box-image build to the `lody` package installed from npm.
Nothing under `vendor/lody` changes, but they are recorded here because this
file is the merge agent's conflict manual and **every one of them is a standing
obligation at every version bump**.

| Patch | Target | Anchor | Reason |
|---|---|---|---|
| `packages/box/patches/lody-local-platform.mjs` | `lody/dist/index.js` | 4× `resolvePlatformKind("cloud")` | `lody@0.88.1` on npm is the CLOUD build: its Vite config inlines the platform as a literal, so the local composition root is unreachable and the daemon blocks on a device-authorization login. The patch restores the `LODY_PLATFORM` env read. Without it a box cannot start the daemon at all. |
| `packages/box/patches/lody-acp-auth-queue.mjs` | `lody/dist/index.js` | the `extractQueueKey` switch tail in `MessageProcessor` | Every `machine/*` message falls to `extractQueueKey`'s `default: return null`, and `ConcurrentQueue` maps `null` onto ONE serial chain (`__default__`). `machine/acp-authenticate` with `action: 'start'` runs `claude auth login --claudeai`, which blocks on stdin until the member pastes the code back — so the `submit-code` carrying that code queues behind the login waiting for it, and so does `cancel`. The patch gives a `start` its own per-agent chain. Without it an interactive agent sign-in can never be completed, only timed out after 285 s. |
| `packages/box/patches/lody-code-collab-worktree-root.mjs` | `lody/dist/index.js` | the `project?.kind === "local"` branch of `resolveCodeCollabWorkspaceRoot` | That branch answers with the local project's ROOT PATH and never reads `project.useWorktree` or `meta.isWorktree`, so once no live `Session` object is left the whole Code Collab surface of a worktree session — All Changes, the Files tab, every file chip — resolves to the `/workspace/<repo>` clone instead of the worktree. The clone is clean by design, so the panel renders an empty SUCCESS ("No changes yet.") rather than an error. The patch answers with the worktree when the session is a worktree session and the worktree exists. Without it the side panel of every BlitzOS worktree session is silently empty. |

Applied in that order. **The order is not cosmetic:** `lody-local-platform`
guards on a sha256 of `dist/index.js` AS PUBLISHED, so nothing may rewrite the
file before it runs. The other two therefore guard on the installed package's
version plus their own anchor at exactly one occurrence — a file hash can
only ever pin the first patch in a chain. All three are idempotent: re-running
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

**Per-bump obligation.** Bumping the `lody` pin in `packages/box/Dockerfile`
requires re-auditing this patch in the same change. It is guarded twice, so
neglect fails the image build loudly rather than shipping a broken box:

1. `EXPECTED_INPUT_SHA256` pins the sha256 of the published `dist/index.js`.
   Any new version fails here first.
2. `EXPECTED_OCCURRENCES` pins the anchor count at 4. A refactor that moves or
   splits the call sites fails here.

`lody-acp-auth-queue.mjs` has the same obligation and its own two guards: the
version read from the installed `package.json`, and its anchor at exactly one
occurrence. Re-auditing it means confirming that `extractQueueKey` still sends
unnamed types to one shared chain — if a bump fixes that upstream, DELETE the
patch instead of updating it.

`lody-code-collab-worktree-root.mjs` is guarded the same two ways. Re-auditing it
means confirming that the local-project branch of `resolveCodeCollabWorkspaceRoot`
(`apps/cli/src/lib/message-handler.ts:6238`) still ignores `useWorktree` and
`isWorktree`, which their own terminal resolver reads
(`apps/cli/src/lib/terminal-workdir-resolver.ts:97`). The patch is strictly
ADDITIVE: it inserts one branch in front of the existing return, and takes it
only when the session is a worktree session AND `WorktreeManager.hasWorktree`
finds the worktree on disk. Every other session, and a worktree session whose
worktree is gone, keeps the answer it has today.
`packages/webapp/test/lody-worktree-session.test.ts` measures both directions
against a real daemon.

Re-auditing means: confirm the anchor still selects the platform, confirm the
count, run `LODY_PLATFORM=local lody start` and see "Starting in local platform
mode", then update `EXPECTED_INPUT_SHA256`, `EXPECTED_VERSION` and the Dockerfile
pin together.

**Patching all four sites is deliberate**, and it is a wider patch than
`plans/evidence/lody-phase1.md` §0 first proposed. One of the four is the
default argument of `getInstallationProfile()`, which selects the whole
installation profile. Patching only the `getCliPlatformKind` site leaves the
daemon running the local composition under the CLOUD profile: socket basenames
`lody-*`, host lease on 17788, data dir `~/.lody`. Patching all four moves it to
the LOCAL profile: basenames `lody-oss-*`, host lease on **17789**, data dir
`~/.lody-oss`. The box depends on the second shape — 17789 is the port pinned in
`RESERVED_PREVIEW_PORTS`, and `lody-oss-` is the namespace
`/usr/local/libexec/blitz-lody-bridge` derives its socket paths from. Narrowing
this patch to one site breaks both.

## Planned seams (not yet applied)

Declared ahead of time so a merge agent recognises them when they appear.

| File | Upstream anchor | Reason | Phase |
|---|---|---|---|
| ~~`create-workspace-runtime.ts` — websocket transport~~ | — | **Not needed, and the plan's §5.3 item 1 is withdrawn.** Phase 1 measured that the daemon already SERVES its `LoroRepo` on a unix socket for the Electron renderer, so the browser speaks Lody's own protocol v7 through `blitz-lody-bridge` rather than a `loro-repo` `transport/websocket`. The local branch in this file was already the one we want. See `plans/evidence/lody-phase1.md` §A.b. | — |
| ~~`workspace-machine-rpc-facade.ts` — box websocket RPC plane~~ | — | **Not needed.** The facade's existing LOCAL plane is the one we want; it reaches `window.ipc`, which we install. What it needed instead was the predicate widening above, which is a far smaller patch than a new plane. | — |
| `packages/components/src/lib/electron-ipc-client.ts` | `getIpcServices()` | No change expected — it is a generic proxy over `window.ipc`, and installing that global is exactly how BlitzOS uses it. Listed so nobody "fixes" it. | — |
| ~~`loro-sidebar.tsx` — suppression props~~ | — | **Applied**; see seam patch 2 above. | 4 |

## Things upstream does not support that we work around OUTSIDE the vendor tree

Recorded here because each is a candidate seam if the workaround stops holding.

- **The command palette and its keyboard shortcuts are not mounted at all, and
  three of its commands would ignore a host tab if they were.**
  `session.archiveCurrent` (`$mod+Alt+a`), `session.closeFocusedTab` and the
  `session.nextTab` / `session.previousTab` cycle all resolve against
  `SessionDetail`'s own `activeTabSessionId` (`session-detail.tsx:3783`, `:3901`,
  `:4116`), which is the CONVERSATION selection — a host tab is invisible to
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
  set (`:2416`), and the box is visible only through
  `buildVisibleMachineIndex`'s owner fallback, which is excluded from it.
  `packages/webapp/src/lody/agent-configs.ts` runs their own
  `runStartupAcpCapabilitiesRefresh` over BlitzOS ports instead. Candidate
  upstream PR: let the caller supply the machine list.
- **`locales/en.json` is a FLAT map with dotted keys**, so any i18next instance
  built for their components needs `keySeparator: false` — their own init sets
  it (`i18n/index.tsx:121`) and `packages/webapp/src/lody/i18n.ts` now does too.
  Not a divergence, a required initialization option; recorded because getting
  it wrong is silent.
- **The archive path cannot resolve a local project's root path** (phase 5).
  `resolveWorktreeCleanupTarget` (`apps/cli/src/lib/message-handler.ts:4334`)
  merges `machineMeta.localProjects` with `getMachineFlockLocalProjects(
  options.machineFlockRows)`. The DELETE caller passes `machineFlockRows`
  (`:4518`); the ARCHIVE caller does not (`:3989`) — and the same asymmetry is in
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
  (`components/chat/chat-landing.tsx:481`) returns the name the daemon derived
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
