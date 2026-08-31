# Terminal tabs inside the Lody session viewer

One tab strip, not two. Today a workspace with `VITE_BLITZ_LODY_SESSIONS` on
draws Lody's session tab strip when a chat is open and the native pane tab strip
when a terminal is, and the member reads that as two products. This plan makes a
terminal a tab of the session viewer, deletes the second strip from view, and
does it with ONE declared vendor seam.

The requirement is `/workspace/LODY_BUGS.md` item 4, verbatim:

> in general, i expect terminal tabs to be integrated into lody session tab
> viewer. there should be no separate tab system for terminals, it should b
> eintegrated

Read first: `CLAUDE.md` §"Vendored Lody: rules and upstream merges",
`plans/LODY-SESSIONS.md` §0 (the bias rule), `vendor/lody/BLITZ-PATCHES.md`,
`docs/LODY-MERGE.md` §4. Line numbers into `vendor/lody` are stated at the
pinned commit `f3474894` (`vendor/lody/UPSTREAM.md:11`).

## 0. Locked decisions

**Bias rule, applied.** §0's rule is "copy Lody's behavior rather than reconcile
the two". It settles the CHROME question and not the TRANSPORT question. The tab
strip, the pill, the drag order, the close affordance, the `+` — all theirs. The
thing behind a terminal tab stays ours, because Lody's own terminal cannot reach
a browser and replacing tmux is not what item 4 asks for (§2).

1. **A terminal is a tab of the one strip `SessionTabBar` draws.** Not a bottom
   dock, not a side panel, not a second strip anywhere.
2. **The strip has two hosts, one tab list.** `SessionDetail` draws it when a
   session is open; a thin route of ours draws the same component on the chat
   landing, where there is no session to root it in. One array, one selection,
   one address — so it is one tab system with two mount points, which is what
   the vendored surface's own structure forces (§3.4).
3. **Terminal state stays in `webapp_state`.** The list is `WorkspaceTabs`
   (`packages/webapp/src/storage.ts:71`), the identity is the numeric
   `WorkspaceTab.id`, and the PTY is the tmux session `<type>-<id>` that
   `blitz-term` attaches. Nothing about a terminal enters a Loro document.
4. **v1 is one region.** The split pane is suspended while the flag is on
   (§5.3). `region` survives untouched in `webapp_state`, so a rollback restores
   it byte-for-byte.
5. **The native strip renders nothing when the flag is on and the box answers
   `present`.** Deleting `WebAppHeader`'s tab strip is a later PR, after a
   canary dogfood proves nothing else reads it.

## 1. What a tab is in Lody's session viewer

### 1.1 Three strips, and only one of them is "the" strip

| Region | Component | Kinds it draws | Where its state lives |
|---|---|---|---|
| Top / conversation | `SessionTabBar` (`components/sessions/session-tab-bar.tsx:534`) | parent session, child session, draft; viewer tabs in `variant="mixed"` | `SessionDetail` React state |
| Right / side panel | `SessionSidePanelTabBar` (`components/sessions/session-side-panel-tab-bar.tsx:204`) | `files \| changes \| pr \| browser \| session \| file \| diff` | `SessionDetail` React state |
| Bottom dock | `TerminalDock` (`components/terminal/terminal-dock.tsx`) | terminals only, Electron only | component state + three jotai atoms |

The layout that fixes the three is `DesktopSessionDetailLayout`
(`components/sessions/desktop-session-detail-layout.tsx:47`), whose props are
`topBar`, `chatSurfaces`, `terminalDock`, `secondaryPanel`, rendered at `:153`,
`:155`, `:156`, `:219`. `SessionDetail` fills all four at `session-detail.tsx:5751`.

The strip item 4 means is the TOP one. It is the strip the native
`webapp-tabstrip` competes with, it spans the pane, and it is the one a member
calls "the tabs".

**"Surface" is not a model noun in their tree.** It names a rendered pane group
(`desktopChatSurfaces` `:5586`, `desktopViewerSurfaces` `:5649`,
`desktopSideSessionSurfaces` `:5662`) and two component files. There is no
`Surface` type. The nouns are tab, panel and viewer.

### 1.2 More than one is open, and the list is plain React state

There is no jotai store and no zustand store for session-viewer tabs. Every list
is `useState` inside one 5792-line component,
`components/sessions/session-detail.tsx`:

| Line | State | Meaning |
|---|---|---|
| `:729` | `viewerTabs: ViewerTab[]` | open file/diff viewers |
| `:730` | `activeViewerTabId: string \| null` | selected viewer |
| `:760` | `activeTabSessionIdRaw: string` | selected top-strip tab |
| `:892` | `draftTabs: DraftSessionTab[]` | unsent "New tab" drafts |
| `:715` | `openedSidebarTabs: SidebarTab[]` | open fixed panels |
| `:920` | `tabOrder: string[]` | one unified DnD order for every sortable tab |

The session-shaped tabs are not local state: they are derived from the Loro
doc-meta cache through `childSessionsAtomFamily` (`atoms/doc-meta.ts:356`),
`archivedChildSessionsAtomFamily` (`:361`) and `sideSessionsAtomFamily` (`:383`),
read at `session-detail.tsx:883`, `:885`, `:887`. That is the whole reason a
child tab survives a reload and the SELECTION does not.

Contrast: Tasks DOES use a jotai store (`openTaskTabsAtom`, `atoms/tasks.ts:135`).
The session viewer does not, so there is no atom to write into from outside and
no registry to register with.

### 1.3 Selection

`activeTabSessionIdRaw` (`:760`) is the raw selection; `activeTabSessionId`
(`:1077`) is the same value validated against the live child list and the drafts,
so a tab that disappears cannot blank the pane. Selection is per parent session
and resets on a session switch (`:951`).

The URL carries exactly one piece of it: `?tab=session:<id>`, parsed by
`parseSessionTabSearch` (`lib/session-tab-url.ts:12`). **That parser returns
`{kind:'invalid'}` for any value that does not start with `session:`**
(`:19-21`), and `invalid` resets the whole tab state to the parent session
(`lib/session-detail-initial-state.ts:44-51`). Our terminal selection therefore
must NOT ride that search parameter — it arrives as a prop (§3.2).

### 1.4 What draws a tab, and what draws its content

The strip's per-tab dispatch is a nested ternary over one union,
`session-tab-bar.tsx:529`:

```ts
type SortableItemData =
  | { kind: 'session'; session: SessionMeta }
  | { kind: 'draft'; draft: DraftSessionTab }
  | { kind: 'viewer'; tab: ViewerTabItem };
```

rendered at `:786-822`. `ViewerTabItem` is at `:43` (`type: 'file' | 'diff'`).

The content is `desktopChatSurfaces` (`session-detail.tsx:5586`): every session
tab and every draft is mounted `absolute inset-0` and merely `hidden` when
inactive (`:5601`, `:5626`). Nothing unmounts on a tab switch — the same rule
`WorkPanes` applies to ttyd sessions, which is what makes a portal unnecessary
later (§3.5).

### 1.5 There is no extension point

Grepping `registerTab|tabRegistry|registerPanel|panelRegistry|TAB_KINDS` across
`vendor/lody/packages/components/src` returns nothing. Adding a side-panel kind
today means touching ten sites (the two unions, the icon switch, the id-prefix
rule, two zod schemas, the ordering statement, the `+` menu list, the content
dispatch, two id-prefix routers, and the mobile enum).

The top strip is far cheaper, and that is the finding this plan turns on:
**`SessionTabBar` already carries a non-session tab channel that production does
not use.** `viewerTabs`, `activeViewerTabId`, `onViewerTabSelect`,
`onViewerTabClose`, `tabOrder` and `onTabReorder` are all declared
(`session-tab-bar.tsx:69-79`), the `viewer` arm of `SortableItemData` is
implemented (`:812-821`), and the one production call site passes
`variant="session"` and no viewer tabs at all (`session-detail.tsx:5510`). The
only other callers are three stories and the onboarding tour. So the strip
already knows how to draw, sort, select and close a tab that is not a session;
the patch fills a hole that exists rather than cutting a new one.

### 1.6 Persistence

localStorage, per parent session, in `lib/session-draft-tabs.ts`:
`lody:draft-tabs:<id>` (`:129`), `lody:tab-order:<id>` (`:132`),
`lody:last-active-tab:<id>` (`:134`). Read through
`getSessionDetailInitialTabState` (`lib/session-detail-initial-state.ts:28`),
written by one effect (`session-detail.tsx:3856`).

Two asymmetries a design must not inherit: only ONE viewer tab is persisted
(`persistedLastActiveTabStateSchema.viewerTab` is singular,
`session-draft-tabs.ts:74`; the restore is `viewerTab ? [viewerTab] : []`,
`session-detail-initial-state.ts:59`), and a `?tab=` value bypasses persistence
entirely. Neither touches us: our tab list is `webapp_state` and our selection is
the BlitzOS address.

## 2. Does Lody already have a terminal, and should we use it

**Yes, and there are two of them.**

### 2.1 The ACP harness terminal — not a terminal in the product sense

The daemon implements all five ACP client methods and advertises the capability:
`terminal: this.terminalEnabled` in `initialize`
(`apps/cli/src/agent/agent-client.ts:1731`), with `terminal/create` `:1264`,
`terminal/output` `:1286`, `terminal/release` `:1295`, `terminal/wait_for_exit`
`:1302`, `terminal/kill` `:1312`, over `ShellTerminalManager`
(`apps/cli/src/session/terminal-manager.ts:265`, constructed per session at
`apps/cli/src/session/session.ts:139`).

It has **no input path at all**. The `TerminalManager` interface
(`terminal-manager.ts:13-34`) exposes create, read, wait, kill, release and
nothing that writes; state is a byte `Buffer` accumulated from `onData` (`:36-44`,
`:97`) capped at 1 MiB (`:59`), spawned through `SessionSandbox.spawn` with an
argv array rather than a shell (`:104`). The renderer draws it read-only into a
`<pre>` through Anser (`components/ai-gui/terminal-component.tsx:204`, `:234`).

It is a tool-call card. It is not a candidate.

### 2.2 The interactive dock — a real PTY, unreachable from a browser

`LocalTerminalPanel` (`components/terminal/local-terminal-panel.tsx`) is xterm.js
bound to a PTY: `t.onData(d => channel.input(id, d))` `:218`, `t.onResize`
`:227`, `attachCustomKeyEventHandler` `:158`. `TerminalDock`
(`components/terminal/terminal-dock.tsx`) gives it a tab strip (`:490`) and a `+`
(`:540`), capped at `TERMINAL_MAX_PER_SESSION = 8`
(`packages/shared/src/terminal-protocol.ts:14`). The chain is
`TerminalChannel` (`terminal-channel.ts:21`) → `createElectronTerminalChannel` →
Electron IPC → `TerminalRelay` (unix socket) → `startLocalTerminalServer`
(`apps/cli/src/lib/local-terminal-server.ts:238`) → `TerminalPtyService`
(node-pty).

**It is Electron-gated at two places and both are hard.** `TerminalDockHost`
returns `null` unless `window.__LODY_ELECTRON__ === true`
(`components/terminal-dock-host.tsx:25`, `:54`), and
`TerminalDockToggleButton` returns `null` unless `isElectronRenderer()`
(`session-detail.tsx:628`). Their own docs say so: *"Remote sessions, mobile
clients, and the web app do not currently provide an interactive terminal"*
(`site-docs/content/docs/en/(features)/terminal.mdx`).

That gate is also the good news: **the dock is already invisible in the BlitzOS
mount, and this plan needs no hunk to keep it that way.** It is mounted at
`session-detail.tsx:5755` and renders nothing.

### 2.3 Recommendation: mount our ttyd/xterm view, do not reuse their PTY

Reuse it would mean, in order: widen the two Electron gates (seam patch 1's idea
in a fourth and fifth place); implement a `TerminalChannel` over a new bridge
door; open `/terminal` in `blitz-lody-bridge` and a matching path in
`packages/box/gateway/main.go` and `packages/schema/src/webapp-surface.ts` (a
two-sided drift-tested contract); add a fixture corpus for
`TerminalClientMessageSchema` / `TerminalServerEventSchema`
(`packages/shared/src/terminal-protocol.ts:25`, `:72`) on three runtimes, per
`CLAUDE.md`'s cross-runtime rule; and confirm `@lydell/node-pty` has a prebuild
for the box image, which their own code doubts enough to lazy-`require` it
(`apps/cli/src/lib/terminal-pty-service.ts:41-50`).

And at the end of that, four things would be WORSE:

1. **The dock is a second tab strip.** It draws `lody-terminal-tab-strip`
   (`terminal-dock.tsx:490`) at the bottom of the pane. Adopting it satisfies
   "Lody has terminals" and fails item 4 exactly as written.
2. **Persistence is lost.** Their dock's open/active memory is a module-level
   `Map` (`terminal-dock.tsx:54`) that does not survive a reload; the PTY is a
   node-pty child of the daemon with 512 KiB of replayed scrollback. Ours is
   tmux: `tmux new-session -A -s "<type>-<tabId>"`
   (`packages/box/rootfs/usr/local/libexec/blitz-term:140`), which survives the
   daemon, the browser, and the member going home.
3. **The harnesses are lost.** `blitz-term`'s type map (`:35-40`) is what makes a
   tab a Claude Code TUI or a Codex TUI, and it is the delivery path recipes
   still use (`plans/LODY-SESSIONS.md` §9 step 0). A node-pty login shell has
   none of that.
4. **It costs a box-image bake and a daemon-side flag** to learn anything at all,
   where the recommended path costs zero box changes.

So: **keep `TtydTerminal` (`packages/webapp/src/TtydTerminal.tsx:86`) as the tab
CONTENT and adopt Lody's tab CHROME.** This is not a violation of the bias rule —
the rule says do not reconcile two UIs, and the UI here becomes theirs entirely.
What stays ours is a transport the vendored tree cannot reach from a browser.

Recorded as a candidate for later: if upstream ever gives `TerminalChannel` a
non-Electron transport, our channel adapter is a ~150-line file and the dock
becomes an option again. It is named in `BLITZ-PATCHES.md`'s workaround list so a
merge agent notices the day it happens.

## 3. The seam

### 3.1 Seam patch 5 — "pluggable surface tabs"

> **Amendment (as built).** The table below is the DESIGN's eight hunks. The
> shipped seam is **twenty**, and `vendor/lody/BLITZ-PATCHES.md` is the record:
> PR #135 added hunks 9-15 (a memo that must sit above the page's early
> returns, the `activeChatSurfaceId` rule, and the two `isActive` reads it
> needs) and 16-18 (`onSessionTabSelect`, the announcing setter, and the three
> corrections that keep the raw one), and wave 3 added 19-20
> (`onSessionMissing`, so a dead session does not take the strip with it — §7's
> F7). Still one idea and still strictly additive; the count grew because the
> design under-counted what "an active host tab hides the conversation
> surfaces" costs, not because a second idea was added.

**One idea, eight hunks, two files.** A host that embeds the session viewer may
contribute tabs of its own to the one tab strip and supply their content.
Strictly additive: with every new prop absent, `SessionDetail` and
`SessionTabBar` render byte-for-byte what they render today, and no upstream call
site passes one.

`packages/components/src/components/sessions/session-tab-bar.tsx`

| # | Line (`f3474894`) | Upstream anchor | What it does |
|---|---|---|---|
| 1 | `:43` | `export interface ViewerTabItem` | widens `type` to `'file' \| 'diff' \| 'custom'` and adds `icon?: ReactNode` |
| 2 | `:58` | `parentSession: SessionMeta;` | makes it `parentSession?: SessionMeta;` |
| 3 | `:726` | `[parentSession.id, ...sortableIds]` | reads the id only when `showSessionTabs` and a session was given |
| 4 | `:766` | `<AdaptiveTabStripItem itemId={parentSession.id}>` | the existing `showSessionTabs &&` guard gains `parentSession &&` |

Hunks 2–4 are the "a strip need not be rooted in a session" half. They exist for
`variant="viewer"`, which upstream already declares (`:53`, `:560-563`) and
already renders without session tabs — the required prop is the one thing that
stops a host from using the variant it was given.

`packages/components/src/components/sessions/session-detail.tsx`

| # | Line (`f3474894`) | Upstream anchor | What it does |
|---|---|---|---|
| 5 | `:667` | after `readOnly = false,` and its type entry (seam patch 4's anchor) | declares and defaults the four props of §3.2 |
| 6 | `:5510` | `variant="session"` in the `SessionTabBar` element | `variant={surfaceTabs.length > 0 ? 'mixed' : 'session'}` |
| 7 | `:5517` | after `onNewTab={handleNewTab}` | passes `viewerTabs`, `activeViewerTabId`, `onViewerTabSelect`, `onViewerTabClose` from the new props |
| 8 | `:5624` | the end of `desktopChatSurfaces`'s children | maps `surfaceTabs` to `<div className={cn('absolute inset-0', !isActive && 'hidden')}>{tab.content}</div>`, the same shape the drafts get at `:5626` |

Nothing else. The mobile branch is deliberately NOT patched: `MobileSessionTabSheet`
keeps a fourth, hand-maintained kind enum (`mobile/mobile-session-tab-sheet.tsx:55`)
and widening it is a second idea (§5.5).

### 3.2 The API surface

Declared on `SessionDetail`'s inline props type at `:667`, beside `readOnly`:

```ts
/** One tab the HOST contributes to this session's tab strip. */
export interface SessionSurfaceTab {
  /** Unique across this strip. Must not collide with a session id. */
  id: string;
  label: string;
  icon?: ReactNode;
  /** Rendered as a peer of the chat surfaces: mounted always, hidden when
   *  another tab is active. */
  content: ReactNode;
}

surfaceTabs?: readonly SessionSurfaceTab[];
activeSurfaceTabId?: string | null;
onSurfaceTabSelect?: (tabId: string) => void;
onSurfaceTabClose?: (tabId: string) => void;
```

Four props, one idea. The host owns the list, the selection and both verbs; the
viewer owns the drawing and the layout. There is no registry, no atom and no
context — which is what keeps the patch to eight hunks in a tree that has no
extension mechanism at all (§1.5).

**Why `content: ReactNode` and not a portal host.** A ref-callback host element
was the first design, on the rail-portal precedent
(`SessionSurface.tsx:420`). It was rejected: React remounts a portal whose
container identity changes, so the container-swap this was meant to avoid happens
anyway, and the prop is a fifth member of the seam that buys nothing. Mounted
inline and hidden-not-unmounted, a terminal survives every tab switch inside one
session (`session-detail.tsx:5601` is the rule it inherits). A session SWITCH or a
visit to the landing does remount it, and that costs one WebSocket reconnect —
the same event a page refresh already causes, absorbed by tmux (§4.4).

### 3.3 The upstream PR sketch

`plans/evidence/lody-surface-tabs-pr.md`, drafted in the shape
`plans/evidence/lody-sidebar-props-pr.md` fixed:

- Title: `feat(sessions): let a host contribute tabs to the session tab strip`.
- Problem: `SessionTabBar` is already props-driven and already carries a
  non-session tab channel (`viewerTabs`, `SortableItemData`'s `viewer` arm), but
  `SessionDetail` is the only production caller and it passes neither, so an
  embedder that wants one more tab beside the conversation has to fork the page.
  Meanwhile `variant="viewer"` exists and cannot be used, because `parentSession`
  is required by a strip that variant tells not to draw.
- Summary: four optional props on `SessionDetail`, one optional prop and one
  widened union member on `SessionTabBar`. Every default is today's behaviour.
- Decisions to challenge: `content: ReactNode` versus a render prop keyed by id;
  `type: 'custom'` on `ViewerTabItem` versus a fourth arm on `SortableItemData`;
  whether `parentSession` should become optional or `variant="viewer"` should be
  removed instead.
- Not done: mobile (`MobileSessionTabSheet` keeps its own enum), DnD reorder
  across host tabs, and any keyboard-shortcut integration
  (`getSessionTabCloseTarget`, `session-tab-close-target.ts:8`, still resolves
  Cmd+W to a conversation or side-panel tab).
- **Drop seam patch 5 when it merges.** The BlitzOS half is the same four props
  either way, which is the point of upstreaming rather than patching.

Their `.github/AGENTS.md` requires an Issue URL and maintainer agreement before a
PR, and closes an over-200-line PR without one. This diff is small under
`git diff -w`; hunk 8 re-indents nothing, so the raw and whitespace-ignoring
counts should agree. Validate with `node .github/scripts/check-pr-body.mjs`.

### 3.4 Where the strip is drawn when no session is open

`SessionDetail` is the strip's only host, and it needs a session. A flag-on
workspace opens the chat landing with zero tabs
(`storage.ts:181` `defaultWorkspaceTabs()` returns none with
`LODY_SESSIONS_ENABLED`), so "open a terminal before you open a chat" has to
work or the feature is unusable on a fresh workspace.

The answer is OUR composition, not a second patch. `router.tsx`'s `ChatRoute`
(`packages/webapp/src/lody/router.tsx:153`) gains a strip above `ChatLanding`:
the same vendored `SessionTabBar`, `variant="viewer"`, the same
`surfaceTabs`-derived `viewerTabs`, no session tabs because there are no
sessions to draw. Selecting a terminal there swaps the body from `ChatLanding` to
that terminal's content; selecting nothing leaves the landing exactly as phase 4
shipped it.

Two mount points, one component, one tab array, one selection, one address. That
is one tab SYSTEM by every test item 4 states, and it is the only shape the
vendored structure allows without hoisting the strip out of `SessionDetail` —
which would mean re-implementing child tabs, drafts, the archived popover,
rename, DnD and the close-archives-a-session rule, i.e. exactly the structural
re-render §0's bias rule forbids.

### 3.5 What stays in `packages/webapp/src/lody/`

| File | New / changed | Role |
|---|---|---|
| `surface-tabs.ts` | new | `WorkspaceTab[]` → `SessionSurfaceTab[]`; the id namespace `blitz-tab:<id>`; the label and icon rules |
| `SurfaceTabContent.tsx` | new | one workspace tab's body, lifted out of `WorkPanes`'s switch |
| `TerminalTabsStrip.tsx` | new | the landing-host strip of §3.4 |
| `router.tsx` | changed | `ChatRoute` composes the strip; `sessionDetailRouteComponent` passes the four props through |
| `SessionSurface.tsx` | changed | `surfaceTabs` joins `LodyRailBinding` as a sibling binding; threaded to the router factory |
| `LodySessionsRegion.tsx` | changed | passes the binding, and passes NOTHING when `sharedOpen !== null` (§5.1) |

The id namespace matters: `blitz-tab:<WorkspaceTab.id>` cannot collide with a
session id, a `file:`/`diff:` viewer id or a `draft-` id, and it is what
`onSurfaceTabSelect` parses back into the numeric id `webapp_state` and tmux both
key on.

## 4. Lifecycle

### 4.1 Open

Two affordances, and neither is new code on the box.

- **The `+` menu.** With the flag on, the pane strip disappears (§4.6), so the
  `+` menu is the one already mounted in the rail's Terminals section header:
  `NewTabControl variant="icon"`, built at `CloudApp.tsx:1666-1675` and handed
  down as `terminalsAction` (`SessionRailSidebar.tsx:410-426`). It offers
  `SPAWN_SESSION_TYPES` — claude, codex, terminal (`NewTabMenu.tsx:12-16`) — and
  lands on `spawnTtydSession` (`CloudApp.tsx:1116`).
- **The rail's Terminals section.** A row click is `onSelectTerminal`
  (`SessionSurface.tsx:426`), today `selectTtydSession` + `closeChat()`
  (`CloudApp.tsx:1119-1126`). It stops calling `closeChat()`: the surface no
  longer yields the view to the panes, it selects a tab inside itself.

The strip's own `+` keeps its Lody meaning — `handleNewTab`
(`session-detail.tsx:1844`) creates a draft chat tab. Merging the two `+`s into
one menu needs a fifth seam prop and is deferred (§5.5).

### 4.2 Select

`onSurfaceTabSelect('blitz-tab:7')` → `CloudApp` sets the address. The address is
the only place a selection lives, exactly as phase 4 decided for chat sessions
(`plans/LODY-RUNTIME-DESIGN.md` §9.1). `ChatAddress`
(`packages/webapp/src/sessions-page-state.ts:44`) gains two arms:

```ts
export type ChatAddress =
  | null
  | 'landing'
  | { sessionId: string }
  | { sessionId: string; sharedFrom: string }
  | { terminalId: string }                      // the landing host
  | { sessionId: string; terminalId: string };  // a session's strip
```

served by `/workspaces/:id/chat/terminal/:tabId` and
`/workspaces/:id/chat/:sessionId/terminal/:tabId`, parsed beside the existing
`shared` pattern at `sessions-page-state.ts:106`. A bare `/workspaces/:id` still
means the panes, so every existing link resolves where it did.

**It does not ride `?tab=`.** `parseSessionTabSearch` treats anything that is not
`session:<id>` as `invalid` and resets the whole tab state
(`lib/session-tab-url.ts:19`, `lib/session-detail-initial-state.ts:44`), so a
`terminal:` value there would silently blank the session's own tab selection on
every navigation. The selection arrives as `activeSurfaceTabId`, a prop, and the
vendored URL contract is untouched.

### 4.3 Close

`onSurfaceTabClose('blitz-tab:7')` → `closeTtydSession` (`CloudApp.tsx:1224`) →
`workspace-panes.ts:89` `closeTab`, which already picks a successor and already
carries the dirty-file confirm detour for `file` tabs. Our successor rule wins;
their `getSidePanelTabCloseFallback` is not consulted, because the list is not
theirs.

Two differences from a session tab, both worth stating in the confirm copy we do
NOT show: closing a session tab archives or deletes a real session
(`session-detail.tsx:2120`); closing a terminal tab deletes a row in
`webapp_state` and **leaves the tmux session running on the box**. That is
today's behaviour and this plan does not change it.

### 4.4 Survive a refresh

Three independent facts already carry it, and none is new:

1. The tab list is server-side. `WorkspaceWebAppStateV1` (`storage.ts:98`) is
   read on mount (`use-workspace-persistence.ts:70`) and written back debounced
   (`:121`) through `GET`/`PUT /workspaces/:id/webapp-state` (`api.ts:726-741`).
2. The selection is in the URL (§4.2).
3. The PTY is tmux. `sessionKey = String(tab.id)` (`WorkPanes.tsx:278`) becomes
   `?arg=<sessionKey>` (`TtydTerminal.tsx:428`) becomes
   `tmux new-session -A -s "<type>-<tabId>"` (`blitz-term:57`, `:140`). Re-attach
   is the normal path, not a recovery path.

So a refresh lands on the same tab, showing the same PTY, with its scrollback.
The same three facts absorb the one cost §3.2 accepts: a session switch remounts
the terminal and it re-attaches, at the price of a reconnect
(`TtydTerminal.tsx:466-472`, 500 ms→5 s backoff) and a redraw.

**What this replaces.** `renderedSessions` keeps every visited terminal mounted
forever behind `retainedSessionIdsRef` (`CloudApp.tsx:1293-1304`). Inside one
session that rule is preserved by hunk 8's `hidden`; across sessions it is not,
and the honest statement is that the retain-forever guarantee narrows to
retain-within-a-session. Measure the reconnect on canary before deciding whether
it needs more.

### 4.5 An old box

`useLodySessionsCapability` (`packages/webapp/src/lody/box-capability.ts:110`)
already answers this and needs no change. A pre-Lody image has no `/lody/*` door,
answers 403 or 404, and the probe reads `absent` (`:55-59`). Then
`LodySessionsRegion` returns `null` before `lazy()` (`LodySessionsRegion.tsx:130`),
`useLodyRail` publishes no `onVendorHost` (`use-lody-rail.ts:203`), `SessionRail`
falls back to its native list and its pinned "New tab" bar
(`SessionRail.tsx:149-190`), and the fresh-workspace default becomes
`terminalFirstWorkspaceTabs()` (`use-lody-rail.ts:174-181`,
`CloudApp.tsx:951-957`).

**The strip suppression of §4.6 is gated on the same signal, and only that
signal.** An `absent` box keeps the native pane strip, which is the whole
flag-off experience and the correct answer for a machine that cannot run the
surface.

### 4.6 What the native strip does when the flag is on

> **Amendment (as built).** This section names `available` as the signal, and
> it is no longer the signal, twice over. PR #137 replaced it with
> `lodySurfaceMounts` — `available` is `capability !== 'absent'`, which stays
> true through `probing`, and a workspace with no running box stays `probing`
> for good, so the panes were handed to a host that never mounted. Wave 3 then
> gated the STRIPS on visibility as well (`surfaceHostsTabs`), because
> `lodySurfaceMounts` answers "the surface exists" and `/workspaces/:id` is
> `chat === null`, where the surface is mounted and hidden: the panes were
> giving their strip away to a strip nobody could see. The pane BODIES already
> followed visibility; the two now follow one answer.

It renders nothing. `WorkPanes` draws one `div.webapp-pane-strip` per visible
region at `WorkPanes.tsx:147-181`, each a `WebAppHeader` whose tab strip is
`WebAppHeader.tsx:207`. `WorkPanes` gains one prop — `tabStrips: boolean` —
passed from `CloudApp` as the same `available` the rail reads
(`LODY_SESSIONS_ENABLED && capability !== 'absent'`, `use-lody-rail.ts:108`), and
the `visibleRegions.map` at `:147` is guarded by it.

Nothing else changes in `WorkPanes`: the pane bodies still render, still hidden
per tab, and are what the surface tab's `content` points at through
`SurfaceTabContent`. `WebAppHeader`, `NewTabMenu` and the context menu stay in
the tree, reachable with the flag off and on an `absent` box.

**Deletion is a later PR**, after a canary dogfood. `WebAppHeader` is 300+ lines
carrying rename, the context menu, drag-and-drop and the preview-link list, and
half of that has no home yet in the vendored strip.

## 5. v1 non-goals

### 5.1 No terminal sharing

A grantee's surface gets no `surfaceTabs` at all. `LodySessionsRegion` builds the
binding only when `sharedOpen === null` (`LodySessionsRegion.tsx:151`), for the
same reason the bridge refuses `/control` outright and narrows `/platform` to
three fields (`plans/LODY-SHARING.md` §4.3): a terminal is an arbitrary shell on
the owner's box, and no share level in §0.1 grants that. There is no gateway
path, no bridge door and no ACL to write, because there is nothing to permit.

### 5.2 No terminal state in the CRDT doc

The list stays in `webapp_state` (D1, last-write-wins) and the PTY stays on the
member's own machine. Nothing about a terminal is written to a Loro document, so
no upstream session-meta field is borrowed, no `ignoreUnknownProperties`
tolerance is depended on, and an upstream merge cannot collide with it.

### 5.3 One region: split view is suspended

Today `WorkspaceTabs` carries `region: 'main' | 'side'` and `WorkPanes` draws two
strips (`workspace-panes.ts:171` `moveTab`, `:194` `splitTab`). One strip cannot
show two panes. While the flag is on and the box is `present`, every tab is drawn
in one strip and split is not offered.

`region` is neither migrated nor cleared — a stored `'side'` tab renders as an
ordinary tab and comes back to its pane the moment the flag is off. Re-adding
split inside the surface is a follow-up and needs a layout answer, not a tab
answer.

### 5.4 No DnD reorder for host tabs

`onTabReorder`/`tabOrder` write `lody:tab-order:<parentSessionId>` in
localStorage (`session-draft-tabs.ts:216`), which is per-session and per-browser;
our order is per-workspace in `webapp_state`. Wiring the two is a real design
question and v1 does not answer it: host tabs sort after the session tabs in
`webapp_state` order and do not drag.

### 5.5 Not in v1

- Mobile. `MobileSessionTabSheet` keeps its own kind enum
  (`mobile/mobile-session-tab-sheet.tsx:55`) and the props are inert there; the
  mobile drawer keeps today's behaviour.
- One merged `+` menu (chat draft + three terminal types) in the strip.
- Cmd+W over a host tab (`session-tab-close-target.ts:8` is not patched).
- Reusing Lody's own terminal transport (§2.3).
- Deleting `WebAppHeader`'s tab strip (§4.6).

## 6. Migration and rollback

One switch, the one that already exists.

| | `VITE_BLITZ_LODY_SESSIONS` off | on, box `absent` | on, box `present` |
|---|---|---|---|
| Session strip | not mounted | not mounted | terminals + sessions |
| Native pane strip | drawn | drawn | not drawn |
| Terminal transport | ttyd/tmux | ttyd/tmux | ttyd/tmux |
| `webapp_state` | unchanged | unchanged | unchanged |

Rollback is a rebuild with the flag off. Nothing migrates, because nothing about
a terminal moves: the list, the ids, the tmux names, the gateway path and the
`webapp_state` document are the same bytes in all three columns. The only state
this plan adds is two URL shapes, and an unrecognised address already falls
through to `HOME` (`sessions-page-state.ts:103`).

The box needs no change at all. No new gateway path, no `webapp-surface.ts`
entry, no Go change, no image bake — which is the second reason §2.3 recommends
what it recommends.

## 7. Test plan

What pins the seam, so an upstream merge that moves it FAILS rather than
degrades:

1. **`packages/webapp/test/lody-surface-tabs.test.tsx`** (new). Mounts the REAL
   vendored `SessionDetail` through the fixture surface
   (`packages/webapp/test/lody-fixture-surface.tsx`, the precedent seam patch 2
   uses at `lody-fixture-render.test.tsx:115`) and asserts four things: a
   contributed tab appears in the strip; selecting it calls
   `onSurfaceTabSelect` with the namespaced id; closing it calls
   `onSurfaceTabClose`; and its `content` is in the DOM while another tab is
   active, merely `hidden`. Then the inertness case — with all four props absent
   the strip's DOM is unchanged from the unpatched render, which is what makes
   the patch safe to upstream.
2. **`docs/LODY-MERGE.md` §4**: the expected divergent-file count goes 7 → 8
   (`session-tab-bar.tsx` is new; `session-detail.tsx` is already listed for seam
   patch 4), and the grep list gains
   `grep -n 'surfaceTabs' vendor/lody/packages/components/src/components/sessions/session-{detail,tab-bar}.tsx`
   and `grep -n 'parentSession?' …/session-tab-bar.tsx`.
3. **`vendor/lody/BLITZ-PATCHES.md`**: seam patch 5 with the eight anchors of
   §3.1, its merge-conflict drill (if `SortableItemData` grows a real fourth arm
   upstream, drop hunk 1 and use theirs; if `variant` is removed, the
   `parentSession` hunks go with it), and the "drop when the PR merges" row.
4. **`packages/webapp/test/sessions-page-state`**: parse/format round trip for
   both new address arms, including the `terminal` segment against a session id
   that is literally `terminal`.
5. **`packages/webapp/test/lody-old-box-fallback.test.tsx`** (extend): with the
   probe answering `absent`, the native pane strip is present; with `present`, it
   is not. One assertion each, on the same signal §4.5 names.
6. **A sharing assertion** (extend `lody-shared-rail.test.tsx`): a surface
   mounted with `shared` receives no `surfaceTabs`.
7. **`packages/webapp/test/lody-router.test.tsx`**: the landing host of §3.4
   renders the strip with no session tabs and does not throw on a
   `variant="viewer"` mount with no `parentSession` — the assertion that would
   catch hunks 2–4 being lost in a merge, which typecheck cannot, because losing
   them makes a REQUIRED prop required again at a call site that stops
   compiling — so in fact typecheck catches that one, and this test catches the
   opposite: upstream making the strip read `parentSession` somewhere new.

Gates as always: `npm run typecheck`, `npm run lint:gate`, `npm test`.

## 8. Implementation shape

One PR for the change, one for the deletion.

**PR 1 — the seam and the surface tabs.**

| Area | Files | Rough size |
|---|---|---|
| Vendor seam | `session-tab-bar.tsx`, `session-detail.tsx` | ~40 lines, 8 hunks |
| Seam records | `vendor/lody/BLITZ-PATCHES.md`, `plans/evidence/lody-surface-tabs-pr.md`, `docs/LODY-MERGE.md` | ~200 lines of prose |
| Webapp glue | `lody/surface-tabs.ts`, `lody/SurfaceTabContent.tsx`, `lody/TerminalTabsStrip.tsx` | ~300 lines new |
| Webapp wiring | `lody/router.tsx`, `lody/SessionSurface.tsx`, `lody/LodySessionsRegion.tsx`, `CloudApp.tsx`, `sessions-page-state.ts`, `shell/WorkPanes.tsx` | ~200 lines changed |
| Tests | the seven of §7 | ~450 lines |

`WorkPanes.tsx` is the one file with a shape risk: lifting its per-tab switch
(`:193-286`) into `SurfaceTabContent` must leave the pane path working unchanged
for the flag-off and `absent` columns of §6. Split it on touch, per `CLAUDE.md`'s
"prefer editing the four split seams" rule; do not rewrite it.

**PR 2 — the deletion.** After a canary dogfood: remove the pane strips, and with
them whichever of `WebAppHeader`'s controls the vendored strip now serves. Rename
and the context menu are the open ones — Lody's strip has rename
(`session-tab-bar.tsx`'s `onTabRename`) and no equivalent of the preview-link
list.

## 9. Open questions (do not block PR 1)

1. **Does a terminal belong to a session?** Lody's own dock scopes terminals to
   a session and resolves the cwd from its worktree
   (`apps/cli/src/lib/terminal-workdir-resolver.ts`). Ours are workspace-global,
   so the same terminals appear in every session's strip. That is defensible and
   it is also the thing a member is most likely to question first. Changing it
   changes the tmux name, which is load-bearing — so it is a v2 question with a
   migration attached, not a v1 default.
2. **What does the strip do with 20 terminals?** `AdaptiveTabStrip`
   (`adaptive-tab-strip.tsx`) handles overflow for a handful of session tabs.
   Upstream caps terminals at 8 per session
   (`packages/shared/src/terminal-protocol.ts:14`); BlitzOS caps nothing. Measure
   before adding a cap.
3. **Does hunk 6's `variant="mixed"` change anything for a session with no
   terminals?** It should not — `surfaceTabs.length > 0` keeps `'session'` in
   that case — but `hasActiveViewerTab` (`session-tab-bar.tsx:724`) is
   `variant === 'mixed'`-gated and deserves one assertion of its own.
