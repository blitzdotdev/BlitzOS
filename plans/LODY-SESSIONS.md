# Lody sessions: first-class chats and GitHub worktrees

Vendor Lody's chat and git-worktree features into BlitzOS. Keep an upstream pin.
Merge from upstream on a schedule. Demote harness TUI tabs; make sessions the
primary primitive. Replace the flat tab list in the rail with Chats and
GitHub Worktrees sections.

Upstream: https://github.com/LodyAI/Lody (Apache-2.0). Local mirror during
planning: `/workspace/lody-upstream`.

## 0. Locked decisions (2026-08-30, user-confirmed)

**Bias rule.** When Lody's UI or behavior and BlitzOS's conflict, vendor
Lody's and drop ours. No structural re-renders, no hybrid components. Reskin
later through the theme layer only. Every choice optimizes for cheap upstream
merge and maximum feature carry-over. The reference bar: Lody's composer
(machine chip, repo picker, branch picker + worktree pill, `/` commands, `@`
mentions, `$` skills, `+` attachments, model·effort selector, permission-mode
selector) must fully work in GitHub Worktree mode on a box.

1. **Sharing v1**: full shared sessions inside a workspace, opt-in. Every
   session defaults private to its member. Right-click share grants read-only
   or read-write. Read-write is full co-driver: prompt, answer permission
   requests (first response wins), cancel, steer. Owner and workspace admins
   grant/revoke; workspace admins additionally hold implicit read-only on all
   sessions in the workspace; workspace-role viewers can receive read-only
   only. A share includes read access scoped to that session's worktree
   (diffs and file views work); nothing else on the owner's box.
2. **Chat surface**: vendor Lody's UI wholesale (landing, session detail,
   stream, composer, dialogs) with a Blitz theme. Cascade-layer Tailwind
   scoping first, iframe fallback if bleed is unmanageable.
3. **Rail boundary**: the vendored zone is `div.shell-newbar` + `div.shell-list`
   only — Lody's `LoroSidebar` body (sections, filters, pins, badges) mounts
   there. `div.shell-rhead` (workspace title, Members / My machine / Details)
   stays native. Lody's own sidebar header/footer are suppressed via props,
   not source edits. The Terminals section is native rows injected through
   their `afterSessionListContent` slot.
   *(Phase 4, shipped: `div.shell-newbar` is GONE in the vendored shape rather
   than filled — their `home` nav entry, relabelled "New session", is the
   new-chat affordance, and the `+ New tab` menu moves into the Terminals
   section header. The suppression props did not exist upstream; phase 4 wrote
   them as seam patch 2 and drafted the PR that removes it.)*
4. **Default UX**: a fresh workspace opens the chat landing. TUI tabs are
   opt-in via the `+` menu and the Terminals section.
   *(Phase 4, shipped: with the flag on, `defaultWorkspaceTabs()` returns NO
   tabs, and no tabs is what `useLodyRail` reads as "fresh". Only a workspace
   the server has never stored a document for is affected — nothing migrates.)*
5. **Worktrees v1**: create + archive-with-backup + diff stats/badges. PR
   chips, PR polling, and merge flows are deferred. The worktree pill
   DEFAULTS ON for repo-backed sessions (seeded through Lody's own
   workdir-mode preference store, no vendor edit) and stays toggleable —
   upstream forces it only in their `github` context, ours is
   `local-shared`, and an off pill would edit the `/workspace` clone
   directly. Orchestrator ruling 2026-08-30, open to user veto.
   *(Phase 6 slice 0 shipped the seed: `webapp/src/lody/workdir-default.ts`
   writes their GLOBAL preference key once, when it is absent. Their per-project
   key still wins, so unticking the pill for a repo persists.)*
   *(2026-08-31: the same file now also decides where a session with NO repo
   works. Upstream leaves it in `<dataDir>/chats/<sessionId>`, which made the
   agent report an empty workspace and made every RELATIVE file chip open on
   "File not found" — the viewer joins a relative path to the session's workdir
   and nothing else. `session/create` carries no workdir field, so the fix
   registers `/workspace` through `local-project/add` and gives a projectless
   session that `ProjectRef` with no `useWorktree` and no `githubRepoFullName`:
   it stays a Chat, cuts no worktree, and works in `/workspace`.)*
   *(2026-08-31, second half: that decorator reaches sessions being CREATED, so
   a canary member's EXISTING sessions still opened onto "Session has no local
   project or GitHub repository workspace". The same `ProjectRef` is now
   attached when such a session is OPENED — driven off the surface's resolved
   address, guarded on the meta having synced and on the session being a plain
   chat, and inert on a grantee's surface. What it cannot move is a RUNNING
   agent's cwd: the daemon fixes that when the process starts and prefers a live
   session over the document, so an agent still mid-conversation keeps the chats
   directory until its process is recycled.)*
   *(Phase 5, shipped. Two things the wording did not anticipate: the worktree
   pill is only FORCED in their `github` context, so a `local-shared` session
   runs in the clone itself until the member ticks it — a product decision, not a
   bug (`LODY-RUNTIME-DESIGN.md` §10.3); and archiving a local-project worktree
   is broken upstream, which a mirror outside `vendor/` repairs (§10.1).)*
6. **Agents v1**: claude and codex only. English only. Recipes stay on
   `blitz-term` delivery and stay product-disabled.
7. **Attachments**: the one adaptation — their cloud-upload fallback is
   Lody-cloud; ours routes browser→box over the existing WebDAV surface.
   *(Phase 5: BLOCKED, and the only §0 control that was. Phase 6 slice 0 shipped
   it: seam patch 3 widens the one predicate, and
   `webapp/src/lody/session-attachments.ts` stages the bytes on the box over the
   existing dufs surface at `/workspace/.blitz-attachments/<sessionId>/` before
   handing the daemon those paths. `LODY-RUNTIME-DESIGN.md` §10.4, §11.1.)*

## 1. What Lody is, in BlitzOS terms

Lody is a local-first workspace for coding agents. Three parts matter to us:

1. **Renderer** (`packages/components`, 1213 files): the chat UI, the session
   pages, the sidebar with Chats / GitHub Worktrees sections. React 19 +
   Tailwind v4 + Jotai + Loro CRDT mirrors. 62 of 1213 files touch Electron,
   all behind one seam (`lib/electron-ipc-client.ts` returns `null` in a
   browser). A 209-story Storybook proves the leaves render in a plain browser.
2. **Daemon** (`apps/cli`, npm package `lody`, latest 0.88.1): runs ACP agents
   as stdio child processes, owns session CRDT docs in SQLite, owns the
   `WorktreeManager` (1804 lines: create, archive-with-backup-commit, safe
   delete, per-repo file locks, speculative pre-warm). Runs headless via
   `lody daemon start`. This is the box-side half.
3. **Transport**: the renderer and the daemon share Loro CRDT documents. The
   renderer writes session meta + user turns; the daemon's dispatch watcher
   picks them up (durable pointer, not a bus). Desktop uses Electron IPC.
   Browser uses "Loro Streams" — a hosted gateway that is **not** in the public
   tree. See §4 for our replacement.

Key session model facts:

- A session doc holds `history`, a message queue, and ~60 meta fields
  (`SessionMeta`: `title`, `project`, `isWorktree`, `branchName`, `diffStats`,
  `pullRequestState`, `machineId`, `parentSessionId`, ...).
- Worktrees live at `<dataDir>/repos/<repoId>/worktrees/<sessionId>`. Branch
  names: `session/<id8>` (GitHub source) or `lody/<id12>` (local source).
  Two sources: `github` (bare mirror clone) and `local-shared` (worktrees cut
  off an existing local repo — no network needed).
- Lody never pushes or merges itself. UI chips ("Commit & Push", "Create PR",
  "Resolve Conflicts") send natural-language prompts to the agent, which uses
  `gh`. PR merge is one GitHub REST call from the client. PR discovery is
  `gh pr list` inside the worktree.
- Archive auto-commits dirty work (`chore: archive backup for session ...`,
  author `Lody Archive <archive@lody.ai>`) and keeps the branch. Delete
  refuses dirty local-shared worktrees and keeps them on disk.
- The ACP harness contract is plain ACP plus optional `_meta.lody` extensions
  (usage, rate limits, steering, fork, tasks). A vanilla ACP agent works.
  Adapters for claude/codex live in separate public repos, pinned as git
  submodules (`acp-extension-core` MIT, `-claude`/`-codex` Apache-2.0). The
  npm `lody` package bundles them prebuilt.

## 2. What BlitzOS already has

- **No chat surface at all.** BlitzOS used to carry a browser ACP client
  (`webapp/src/chat/`, `ChatPanel.tsx`) wired to a box actor
  (`packages/box/actor`, WS on 7444, SQLite journal, `session/list`, replay,
  permission fan-out), dormant behind `NATIVE_CHAT_ENABLED = false`. All of it
  was DELETED on this branch (2026-08-29): the client, the actor, the journal,
  the `chat` tab type, the recipe `chat` harness, the bootstrap prompt sender,
  and the ACP fixture corpus. Port 7444 stays reserved everywhere because boxes
  already in the field still run the old actor; nothing in this tree listens on
  it. Guest-side conformance tests moved to `packages/box/guest-tests/`.
  `plans/COCKPIT-UI-RESTORATION.md` parked that path "for a dedicated plan" —
  this plan is it, and the parked work is retired rather than resumed.
- The rail: `shell/WorkspaceSessionRail.tsx` + `strip-rail.css` renders
  `aside.shell-rail > div.shell-list` as a flat projection of the tab list
  (`DriveRailSession`), built to survive a swap to real session rows.
- Tabs are the primitive: `WorkspaceTabs` in `webapp_state` (D1, last-write
  wins), tab id = tmux session key on the box. Terminals ride ttyd through the
  box gateway, which is now the ONLY proxied box port (7445). Any new box path
  must be added in `packages/schema/src/webapp-surface.ts` AND
  `packages/box/gateway/main.go` (two-sided, drift-tested contract).
- Repos are cloned to `/workspace/<dir>` on the box (`workspace_repos` table).
  `git` and `gh` are in the image. No worktree feature exists anywhere.
- Webapp styling: plain global CSS + `tokens.css`, dark-first, no Tailwind.
  npm workspaces, Vite 8, React 19.2.8, TS 7.

## 3. Decision: adopt Lody's session plane wholesale

We adopt the Lody daemon as the session engine on the box, and the vendored
Lody renderer packages as the session/chat surface in the webapp. There is no
transition to manage: the old box-actor chat path is already gone (§2), so the
daemon arrives on empty ground.

Why wholesale, not cherry-pick: the user goal is an upstream pin with
automatic merges. That only stays cheap if we run their code with our
modifications confined to declared seams (§5.3). Their session management,
dispatch, worktree lifecycle, and chat UI are one coupled system (CRDT schema
↔ daemon watcher ↔ UI atoms); extracting halves of it creates a permanent
hand-maintained fork, which is the outcome to avoid.

What we do NOT adopt:

- Lody cloud (Convex, better-auth, billing, telemetry): capability-gated off.
  `PlatformCapabilities` = empty set is a supported first-class mode.
- The hosted Loro Streams gateway: replaced by the open-source
  `loro-websocket` server proxied through our box gateway (§4).
- Lody's GitHub token broker: worktrees use the `local-shared` source against
  our existing `/workspace/<repo>` clones, so worktree creation needs no
  network. Push/PR auth stays on the existing box mechanism (`gh` +
  `blitz-cred`).
- Electron surfaces (public browser panel, terminal dock, IDE launchers):
  already null-out in a browser.
- Nothing from the deleted box actor: no ACP journal, no `chat-session.db`, no
  7444 listener. The daemon owns session state end to end.

## 4. Transport: browser ⇄ daemon

The gap: in browser mode Lody routes every CRDT room and all machine RPC over
the hosted Streams service (`create-workspace-runtime.ts` `syncMode:'cloud'`).
That service is private. The replacement, verified against published packages:

- `loro-repo@0.20.0` (MIT) exports `./transport/websocket` alongside
  `./transport/streams`. The transport is pluggable.
- `loro-websocket@0.6.2` (upstream Loro project) ships a `SimpleServer` for
  syncing CRDTs over plain WebSocket.

Target shape, one new box service and two gateway routes:

```
browser (vendored Lody renderer)
  loro-repo transport/websocket ──wss /workspaces/:id/webapp/7445/lody/sync──┐
  machine-rpc shim            ──wss /workspaces/:id/webapp/7445/lody/rpc──┐  │
                                                                          ▼  ▼
box gateway (Go, 7445, ticket auth) ── proxies to ── lody daemon (s6 service)
                                                       ├ loro-websocket server
                                                       ├ machine-rpc (exists:
                                                       │   unix socket HTTP)
                                                       └ ACP child processes
```

- Sync: run a `loro-websocket` server inside or beside the daemon, bound to
  loopback, attached to the daemon's LoroRepo. Gateway proxies `/lody/sync`.
- RPC: the daemon already serves machine RPC on a local socket
  (`LOCAL_MACHINE_RPC_PATH`). Gateway proxies `/lody/rpc` to it. In the
  renderer, `workspace-machine-rpc-facade.ts` is the single routing seam for
  all machine calls — we add a "box websocket" plane there. This is one of the
  declared seam patches (§5.3).
- Auth: both paths ride the existing webApp ticket (`X-Blitz-WebApp-Token`),
  same as ttyd. Viewers get read-only or 403, the same policy the gateway
  already applies to every 7445 surface.
- Both routes go into `webapp-surface.ts` + `gateway/main.go` + both
  conformance tests (hard contract).

**Phase-0 spike must prove this pair end to end** before anything else builds
on it. If `loro-websocket`'s server cannot attach to the daemon's repo without
invasive daemon changes, fallback: adapt the Electron `loro-data-plane-relay`
protocol (already in the public tree) to a WebSocket listener — a larger but
bounded shim.

Sharing architecture (implements §0.1): a session's rooms live on the owner's
box. Share grants are rows in D1 (`session_shares`: workspace, session id,
owner membership, grantee membership, level ro|rw). The control-plane proxy
gains a route to a TARGET member's machine for shared sessions (today it
routes only to the requester's own), and mints tickets whose claims carry the
grant. The box sync server enforces per-room ACL from those claims: room
`session-<id>` is readable under a grant or an admin ticket; read-only grants
have their inbound updates dropped at the relay (a CRDT client cannot write
what the relay refuses to apply). The RPC shim scopes grantees to the shared
session's worktree RPCs only. Because CRDT replicas re-sync from their own
state, the relay itself stays stateless.

*(Phase 6, shipped — `plans/LODY-SHARING.md`. Three corrections to the sketch
above. The claim is not a level but two disjoint id lists, because one grantee
can hold read-only on one session and read-write on another on the same box. The
target route is a distinct PREFIX,
`/workspaces/:id/shared/:membershipId/webapp/7445/…`, so a caller who forgets it
reaches their own box rather than someone else's. And "the RPC shim scopes
grantees" is the BRIDGE, not the shim: the browser half cannot be the enforcement
point, so the box parses the bodies. The grantee's mounted SURFACE is a scoped
follow-up (§8 there) — the vendored renderer's local plane is a singleton on
`window.ipc`.)*

## 5. Vendoring mechanics

### 5.1 Layout

```
vendor/lody/                  # git subtree of LodyAI/Lody, squashed
vendor/lody/UPSTREAM.md       # pinned upstream SHA + npm lody version + date
vendor/lody/BLITZ-PATCHES.md  # every deliberate divergence, file + reason
```

- Add: `git subtree add --prefix vendor/lody <url> <sha> --squash`.
- The three ACP extension submodule dirs stay empty in the subtree; we do not
  build `apps/cli` from source. The box installs the prebuilt npm `lody`
  package, which bundles the adapters. Pin the npm version in the Dockerfile
  next to the pinned `claude`/`codex` binaries.
- Renderer packages we import from the subtree source (their `exports` maps
  point at raw `.ts/.tsx` — no build step upstream either):
  `@lody/components`, `@lody/shared`, `@lody/platform`,
  `@lody/loro-streams-rpc`, plus the root `locales/` (the components package
  imports `../../../../locales/en.json` — preserve that relative depth or
  alias it).
- Exclude from our build: `apps/*`, `packages/turn-diff-store` (Node-only;
  diff evidence arrives over RPC), `code-review-*`, `cli-supervisor`,
  `site-docs`, `packages/ignore`.

### 5.2 Dependencies (npm ↔ pnpm bridge)

- Add Lody's renderer dependencies to `@blitzos/webapp`'s `package.json`,
  resolved from their `pnpm-workspace.yaml` catalog (loro stack, jotai, virtua,
  streamdown, radix set, tailwindcss v4, i18next, ...). React dedupes to our
  19.2.x via a Vite alias, as their Electron config already does.
- Their `patchedDependencies` (8 patches: `@pierre/diffs`, `react-photo-view`,
  `loro-repo`, `mdast-util-gfm-autolink-literal`, `remend`, ...) port to npm
  via `patch-package` in a postinstall, with the patch files copied from
  `vendor/lody/patches/`. Audit each patch at every upstream merge.
- Vite plugins to copy into our webapp config: wasm + top-level-await
  handling, `vite-emojibase-assets`, the mermaid lazy-boundary guard, and the
  bundle aliases (`shiki/bundle/full` → `shiki`). Their
  `apps/electron/electron.vite.config.ts:127-147` is the reference.

### 5.3 Patch policy (what keeps auto-merge cheap)

- Never edit `vendor/lody` except at declared seams. Current seam list:
  1. `providers/create-workspace-runtime.ts` — construct with the websocket
     transport instead of Streams.
  2. `providers/workspace-machine-rpc-facade.ts` — add the box-websocket RPC
     plane.
  3. `lib/electron-ipc-client.ts` — no change expected (returns `null`), listed
     for awareness.
  4. `components/loro-sidebar.tsx` — header/footer suppression props (§0.3):
     upstream at 966623d0 has none. Open a props PR upstream; carry a seam
     patch only until it merges. Recorded in BLITZ-PATCHES.md.
- Everything else BlitzOS-specific lives OUTSIDE `vendor/`:
  `webapp/src/lody/` holds our `BlitzPlatformProvider`, transport adapters,
  token ports, style overlay, and mount points.
- Style and design changes go through theming, not source edits: a CSS overlay
  maps our `tokens.css` values onto Lody's theme custom properties (their
  VS Code theme engine compiles themes to CSS variables at runtime — we ship a
  "Blitz" theme instead of patching component classes).
- Record every seam patch in `BLITZ-PATCHES.md` with file, upstream anchor,
  and reason. The merge agent treats this file as its conflict manual.

### 5.4 Scheduled upstream merge

- Cadence: every few days, an agent runs:
  1. `git subtree pull --prefix vendor/lody <url> <ref> --squash` on a fresh
     branch.
  2. Re-resolve the dependency catalog into `package.json`; re-check the 8
     patches; bump the npm `lody` pin to the release matching the subtree SHA
     (renderer and daemon must move together — the CRDT mirrors tolerate
     unknown fields, but do not bank on skew).
  3. Build, typecheck, run the Lody smoke stories + our tests.
  4. Open a PR; never merge to main unattended.
- The routine is a checked-in doc (`docs/LODY-MERGE.md`) so any agent can run
  it; wire it to a scheduled cloud agent once the first two manual merges go
  clean.

## 6. Box changes

1. Image: `npm i -g lody@<pin>` in `packages/box/Dockerfile` beside claude and
   codex. Data dir on the state volume: `LODY_DATA_DIR=/var/lib/blitz/lody`,
   which survives VM replacement like every other `/var/lib/blitz` path.
2. s6 service `lody-daemon`: `lody daemon start` on loopback, plus the
   loro-websocket sync server (§4). Environment: `GIT_AUTHOR_*` from the
   member identity; agent credentials via the existing per-turn minting or
   `blitz-cred` shim — spike decides whether the bundled acp adapters accept
   the same env the shipped CLIs take (`CLAUDE_CODE_OAUTH_TOKEN`, codex
   config), measured against those CLIs rather than against deleted code.
3. Gateway: `/lody/sync` and `/lody/rpc` proxy routes, ticket-verified,
   viewer-restricted; entries in `webapp-surface.ts` + Go + both drift tests.
4. Worktrees: configure Lody local projects for each `/workspace/<repo>` clone
   (registration happens daemon-side; drive it from box bootstrap using the
   `workspace_repos` list). Worktree source is `local-shared`, so branches are
   `lody/<id12>` cut off the existing clone, placed under
   `/var/lib/blitz/lody/repos/...`. `ProjectRef.githubRepoFullName` is set so
   the sidebar groups these under GitHub Worktrees.
   *(Phase 5, shipped: an s6 longrun `lody-projects` scans `/workspace` for git
   repositories every 30 s and registers each over `/project-control`, rather
   than being handed the `workspace_repos` list — the cloner is a detached retry
   loop that runs for ten minutes after boot, so a list handed down at boot names
   directories that do not exist yet. `local-project/add` CANNOT carry
   `githubRepoFullName`: the daemon derives it from the clone's remote and the
   browser copies it onto the session's `ProjectRef`. Both in
   `LODY-RUNTIME-DESIGN.md` §10.2, §10.7.)*
5. Port 7444 stays reserved and unused. Do not bind the daemon to it: boxes in
   the field still run the old actor there, and the reserved-port fixture pins
   the set on all three sides.

## 7. Webapp changes

1. Mount: a new `SessionSurface` component renders the vendored Lody session
   UI (landing, session page, conversation stream) inside
   `section.webapp-workspace-view` when the active rail selection is a chat
   session. Terminals, files, previews render exactly as today.
2. Providers: `webapp/src/lody/platform.ts` implements `PlatformProvider`
   (`kind:'cloud'`-shaped identity from our auth, capabilities = empty set +
   `remoteMachines`, cloudApi = unavailable stubs). `webapp/src/lody/runtime.ts`
   builds the workspace runtime with the websocket transport against the
   resolver's `/lody/sync` URL.
3. Router: Lody routes are TanStack-based; mount them under a memory-history
   router inside `SessionSurface` (the Storybook preview proves this pattern),
   bridged to our `sessions-page-state.ts` routing. Do not adopt TanStack for
   the rest of the app.
4. Styling — Phase 0 verdict (plans/evidence/lody-phase0.md): cascade layer
   holds every property our unlayered CSS declares; the residue is preflight
   resets on bare elements (`button`, `h1`, `li`, `a`, `input` lose browser
   defaults) plus margins/borders on `.shell-s` and `.files-tree-row`.
   Decision: NO iframe. Ship a small compensation stylesheet on our side that
   re-declares the affected defaults for native surfaces (our CSS is
   unlayered, so it wins by rule, not specificity). Phase 3 also resolves the
   five token-name collisions (`--font-mono`, `--hover`, `--muted`,
   `--terminal-background`, `--terminal-selection`) as part of the Blitz
   theme overlay (§5.3).
5. i18n: initialize their i18next instance with `en` only; keep `zh_CN` files
   in the vendor tree unloaded.

## 8. The rail: sessions become first-class

Rename, then restructure (`shell/WorkspaceSessionRail.tsx` →
`shell/SessionRail.tsx`; CSS prefix `shell-` stays, classes gain a
`session-rail` root; the DOM path the product knows —
`aside.shell-rail > div.shell-list` — becomes `aside.session-rail >
div.session-list`).

The list region is Lody's sidebar itself, per §0.3 — `LoroSidebar` is pure
and props-driven, so we mount its body in the `shell-newbar`+`shell-list`
zone, suppress its own header/footer via props, and inject Terminals through
its `afterSessionListContent` slot. Target layout:

```
┌ rail ──────────────────────────┐
│ workspace head (unchanged)     │
│ [ + New session ]              │  ← creates a chat session (Lody startSession)
│ Chats                        ▾ │  ← sessions with no project
│   ● fix the login redirect     │     rows: title, relative time, live dot
│   ○ yesterday's refactor       │     (.shell-s__a / --live already exist)
│ GitHub Worktrees             ▾ │  ← sessions with repoFullName, grouped by repo
│   blitzdotdev/BlitzOS          │     row badges: diff ±, PR state, dirty
│     ● lody/ab12 – rail swap    │
│ Terminals                    ▾ │  ← today's TUI tabs, demoted to a section
│   claude · tab 1               │
└────────────────────────────────┘
```

- "+ New session" opens a new chat session (Lody landing/composer). The
  existing "+ New tab" menu survives as a secondary control in the tab strip
  and in the Terminals section header: Claude Code TUI, Codex TUI, terminal —
  unchanged tmux/ttyd path.
- Data: Chats and GitHub Worktrees sections read Lody session meta from the
  runtime (`sessionMetaCacheAtom` equivalent via a thin hook in
  `webapp/src/lody/`); Terminals section keeps reading `webapp_state` tabs.
- Selection: rail selection drives which pane shows — a chat session mounts
  `SessionSurface`; a terminal row activates its tab as today.
- Archive/delete/rename actions call Lody session actions (archive keeps the
  branch and a backup commit — surface that copy in the confirm dialog).

`webapp_state` keeps owning terminal tabs and pane layout. Chat sessions are
NOT tabs and never enter `WorkspaceTabs`. The old `type:'chat'` tab is already
deleted from both parsers; a stored one is DROPPED on read, on both sides, so
an old shared document still parses.

**What phase 4 shipped that differs from the sketch above** (details and
measurements in `plans/LODY-RUNTIME-DESIGN.md` §9):

- **The sketch's order is not the shipped order.** `LoroSidebar` renders
  `sessionListProps` before `afterSessionListContent`, and their own comment
  says why ("so Chats reads as the last section"), so the rail reads GitHub
  Worktrees, then Chats, then Terminals. §0's bias rule settles it.
- **An empty Lody section renders nothing, header included** — upstream's rule
  (`loro-app-sidebar.tsx:2095`). Terminals is the exception, because it is ours
  and its header carries the `+`.
- **"+ New session" is their `home` nav entry, relabelled.** It is the same
  action — go to the chat landing, which is the create surface — so there is no
  native button and no `div.shell-newbar` in the vendored shape.
- **The selection is an ADDRESS.** `AppRoute`'s webApp variant carries
  `chat: null | 'landing' | { sessionId }`, served by `/workspaces/:id`,
  `/workspaces/:id/chat` and `/workspaces/:id/chat/:id`. That is the whole
  answer to "where does the active chat selection persist": in the URL, and
  nowhere else. `webapp_state` learns nothing about chat sessions, because the
  daemon's list is what exists and a stale id in a document shared across a
  workspace would point other members at a session archived on somebody else's
  box.
- **Archive / rename / pin are wired to Lody's own `useSessionActions`**, so
  they are their dialogs and their copy. The archive-backup wording in the
  confirm dialog is theirs and was not restated on our side.

**What phase 5 changed in the rail.** The filter phase 4 copied from upstream
(`loro-app-sidebar.tsx:1565`, drop every session whose `project.kind` is
`'local'`) is GONE. Upstream drops them because it has a Local Projects section
to draw them in; this rail does not, and a BlitzOS worktree session is exactly
`{ kind: 'local', useWorktree: true }` — so the filter hid every one of them.
Nothing replaces it: `buildSessionListRows` already sets a row's `repoFullName`
from `resolveProjectGitHubRepo`, which reads `githubRepoFullName` off a local
`ProjectRef`, so a worktree session groups under GitHub Worktrees by repo with no
code of ours. A local project with no GitHub remote yields no `repoFullName` and
its sessions read as Chats — the honest degradation, against upstream's, which is
to hide them.

## 9. Migration

Retirement happened FIRST, not last. Step 0 below is done on this branch, so
nothing here waits on a dead surface being removed.

0. **Done (2026-08-29).** The native-chat surface, the box actor, its journal,
   the `chat` tab type, the recipe `chat` harness, the bootstrap prompt sender,
   the ACP fixture corpus and the `NATIVE_CHAT_ENABLED` flag are deleted.
   `plans/COCKPIT-UI-RESTORATION.md` carries a note pointing here. Recipes lost
   their ACP delivery path with the sender: a recipe launch now writes
   `/var/lib/blitz/recipe/{invocation.env,prompt.txt}` and `blitz-term` delivers
   the prompt into the TUI session it creates. That is the only recipe
   mechanism, and recipes themselves are product-disabled today.
1. Ship box daemon + gateway routes dark (no UI), behind
   `LODY_SESSIONS_ENABLED`.
2. Ship `SessionSurface` + rail sections behind the flag; dogfood on canary.
3. Flip the flag on canary; terminals unaffected.
4. Decide whether recipes move to the daemon (§12 question 1) or stay on the
   `blitz-term` delivery they use today.
5. Update `packages/box/README.md`'s surface contract when the daemon's routes
   land.

## 10. Phases

| Phase | Deliverable | Exit test | Status |
|---|---|---|---|
| 0 spike | Subtree added; Lody `SessionChatStream` + composer render inside our shell from fixture data; Tailwind containment verdict; loro-websocket ⇄ loro-repo round trip in a test | story-grade render, no style bleed into Finder/terminals; CRDT echo test green | **done** (`plans/evidence/lody-phase0.md`) |
| 1 box | `lody` pinned in image, s6 service, sync+rpc gateway routes, surface contract updated | `wscat` through gateway with ticket reaches daemon; drift tests green | **done** (`plans/evidence/lody-phase1.md`) |
| 2 runtime | BlitzPlatformProvider, websocket transport seam patch, RPC plane shim | create session from browser console; turn dispatched; reply streams | **done** (`plans/LODY-RUNTIME-DESIGN.md` §7) |
| 3 surface | `SessionSurface` mounted; full chat loop (permissions, diffs, queue) | send/steer/cancel/permission round trip on canary box | **done, with one gap** — `LODY-RUNTIME-DESIGN.md` §8.6. Send and session creation are proven live through the real composer; the permission card, the queue and Stop are written and gated but were not reached inside the two-turn budget, and reaching the card first needs the composer's permission-mode selector (§8.3). |
| 4 rail | `SessionRail` with Chats / GitHub Worktrees / Terminals; + New session | new chat from rail; terminal tabs unchanged; mobile drawer works | **done** — `LODY-RUNTIME-DESIGN.md` §9. All four exit tests pass. Sections and order follow upstream, not §8's sketch (§9.2). Chat sessions are addressed in the URL and nowhere else (§9.1). |
| 5 worktrees | local projects registered from `workspace_repos`; worktree sessions; diff stats/badges; full composer parity (repo/branch pickers, `/` `@` `$` `+`, model/effort, permission mode) | worktree session edits code on a branch; archive backs up dirty state; every screenshot control works in worktree mode | **done, with one blocker** — `LODY-RUNTIME-DESIGN.md` §10. Nine of the ten composer controls pass (§10.5); `+` attachments have no port to implement §0.7 behind and are a recorded blocker with an exact seam (§10.4). Registration reads `/workspace` rather than the `workspace_repos` list, for the reasons in §10.7. Two upstream defects were found and worked around without a vendor hunk (§10.1). |
| 6 sharing | `session_shares` D1 + CP routes; target-member proxy routing; sync-server ACL (ro drops inbound updates); worktree-scoped RPC for grantees; right-click share UI; admin implicit RO | RO grantee follows a live session + diffs, cannot write; RW grantee prompts and answers a permission; revoke cuts access | **done** — `plans/LODY-SHARING.md`. The grants, the target-member route, the ticket claim, the relay ACL and the owner's share/revoke UI shipped in phase 6 and are proven against a real daemon; the grantee's MOUNTED surface was scoped in §8 and shipped in phase 7 (§10). The four `vendor/lody` changes §6.1 feared were not needed: one box per runtime, one runtime per document, and a per-document projection of the `meta` room. |
| 7 flag + automate | flag flip on canary, `docs/LODY-MERGE.md`, first two upstream merges by hand, then scheduled | one scheduled merge PR lands clean | **done, except the flip itself** — `plans/LODY-SHARING.md` §10 (the grantee's mounted surface), `docs/LODY-MERGE.md` (the runbook and its first real merge: 11 commits, one conflict, seven divergent files, all gates green). What phase 7 cannot do is deploy: the bake, the canary dogfood and the flag flip are §13's checklist and they need a human with credentials. |

Phases 1–2 and the Phase 0 UI spike can run in parallel worktrees.

## 11. Risks

- **Transport spike fails** (loro-websocket server cannot attach to the
  daemon's repo): fall back to a WS port of the public
  `loro-data-plane-relay` protocol; bounded but bigger. Do not start Phase 2
  until Phase 0 settles this.
- **npm `lody` vs public tree skew**: npm is at 0.88.1; the public tree's
  `apps/cli` says 0.76.0. The public tree may lag releases. Pin both sides to
  a verified-compatible pair at every merge; the CRDT `ignoreUnknownProperties`
  rule absorbs small skew.
- **Tailwind preflight vs our global CSS**: the single biggest UI risk; hence
  the layered-CSS-then-iframe ladder in §7.4 and a Phase 0 exit test.
- **Dependency weight**: ~100 new renderer deps incl. wasm (loro, sqlite-wasm)
  and heavy lazy chunks (mermaid, monaco, three). Enforce lazy boundaries
  (their vite guards do this) and measure bundle size in Phase 0.
- **Credential path for bundled adapters**: the daemon's claude/codex adapters
  must accept our minted tokens without Lody cloud login. Verified in Phase 1;
  if not, we run the adapters with env injection via a small daemon config, or
  patch at a declared seam in the npm package via `patch-package`.
- **License hygiene**: Apache-2.0 both sides; carry `vendor/lody/LICENSE` and
  regenerate our third-party notices from their
  `THIRD_PARTY_NOTICES.md` + new deps.

## 12. Open questions (do not block Phase 0)

1. Do recipes move to the daemon, or do they stay on the `blitz-term` prompt
   delivery they use today? (§9.4. Deferred; recipes are product-disabled.)
2. ~~Cross-member visibility~~ — RESOLVED by §0.1: opt-in per-session sharing
   with RO/RW grants and admin implicit RO, in Phase 6.
3. Worktree base for the GitHub Worktrees flow: always the `/workspace` clone
   (`local-shared`), or offer Lody's `github` bare-mirror source once a token
   bridge exists? (v1: always `local-shared`.)
4. Does "+ New session" default to Claude or to the workspace `agentDefault`
   from `webapp_state`? (Default until decided: `agentDefault`.)

## 13. Release checklist

Everything in phases 0–7 is in the tree and dark. What is left needs a human
with credentials, and it has to happen in this order. Nothing below was done by
phase 7 — no image was baked and nothing was deployed.

### 13.1 Bake the box image

The daemon, the bridge, the `lody-projects` registrar and the gateway's share
handling all live in the box image, and none of them is in the field. Nothing
else on this list works until an image carrying them is the pin.

**Two images, and this section used to name only the second one.** #115 landed
after phase 7 was written and made `docs/BOX-IMAGE.md` the authority, so read
that document rather than this paragraph where the two disagree.

| # | Image | What it is | Where the pin lives |
|---|---|---|---|
| 1 | the **box** OCI image | the container the VM runs — this is where every Lody change is | `BLITZ_DEPLOY_VAR_BOX_IMAGE_REF` / `_TAG` / `_SHA256` in `.github/workflows/canary.yml` |
| 2 | the **golden** Hetzner snapshot | a VM snapshot that already carries docker and a copy of image 1, so first boot skips ~94 s of work | `HETZNER_SERVER_IMAGES` in BOTH `.github/workflows/canary.yml` and `.github/workflows/release.yml` |

Only image 1 is load-bearing here. Do image 2 second, or not at all.

**Image 1 — canary rebakes into its own R2 bucket, not GHCR.** That is #115's
whole point: `write:packages` lives only inside `release.yml`, and that workflow
also deploys client prod, so **cutting a `v*` tag to refresh the canary box
image is the wrong instrument** — it ships the platform to a paying client.
Follow *Rebaking the canary image* in `docs/BOX-IMAGE.md` (build at the merge
commit, canary-scoped `wrangler.toml`, `publish-box-image.mjs` with
`CF_CLAUDE_TOKEN_STAGING`), then pin the three values it prints in
`canary.yml`. None of the three is a secret.

**Image 2 — optional, and it reads image 1's pin.**

```sh
npm run golden:bake -- --location hel1     # needs HETZNER_API_TOKEN and the
                                           # three BOX_IMAGE_* values from above
```

`CLAUDE.md`'s Hetzner section is the warning that matters — **canary and client
prod share one Hetzner project**, so a snapshot id is valid for both, the id
goes into `HETZNER_SERVER_IMAGES` in both workflows, and deleting the old
snapshot breaks both deployments quietly (`HetznerProvider` warns
`hetzner_server_image_rejected` and falls back to stock Ubuntu). A snapshot
left stale is *only* slow: the bootstrap fetches whatever `BOX_IMAGE_*` names,
so a golden image carrying yesterday's box cannot ship yesterday's box.

### 13.2 Advertise the shared-sessions capability

**The one line phase 6 said phase 7 must not forget**, and phase 7 could not do
it because it requires the bake above. A ticket carrying a `share` claim is
REFUSED by a gateway older than this change — its decoder disallows unknown
fields, on purpose — so the control plane must know which VMs can take one.

| Where | What to add |
|---|---|
| `packages/control-plane/core/webapp-tickets.ts:42` | set `BOX_IMAGE_SHARED_SESSIONS_SINCE_MS` to the moment the new image becomes the pin. It is `1_788_048_000_000` today and its comment says it is a placeholder. |
| `packages/control-plane/core/compute/hetzner.ts:250` | add `webAppSharedSessionsSinceMs: BOX_IMAGE_SHARED_SESSIONS_SINCE_MS,` beside `webAppViewerGuardsSinceMs` in `capabilities()` |
| `packages/control-plane/core/compute/aws.ts:396` | the same line, in the same place |

The refusal that reads it is `core/workspaces.ts:953`. Undefined means "never",
which is why sharing is refused everywhere today and why a cutoff set in the
PAST would be worse than none: it would mark every VM created today as capable
and hand a real member exactly the unreadable 403 the capability prevents.

**Verified, and there is no fourth cutoff.** `ProviderCapabilities`
(`core/compute/types.ts:15-24`) carries three: `webAppTicketsSinceMs`,
`webAppViewerGuardsSinceMs`, `webAppSharedSessionsSinceMs`. There is NO
capability for "this image runs the Lody daemon at all", and that is a real gap
rather than an oversight to fix blind: a box on an older image with the webapp
flag on answers 404 on every `/lody/*` path, and the surface reports "Sessions
are unavailable on this workspace". Acceptable while the flag is off everywhere
and every canary box is recycled onto the new image; if the flag ever reaches a
fleet with mixed images, that capability is the next thing to add.

**FIELD NOTE (2026-08-31, the fourth canary dogfood): the paragraph above got
two things wrong, and the gap it named is now closed in the browser instead of
in a cutoff.** Measured on a workspace whose machine ran a pre-Lody image:

- The status is **403, not 404**. The old gateway has no `/lody/*` route, so the
  path falls through to dufs, and dufs refuses it.
- **Nothing reported anything.** `fetchLodyPlatformSnapshot` folds every non-ok
  status into `null` — "the daemon has not written its catalog yet" — so the
  surface's poller never settled, its gated branch never mounted, and `error`
  stayed `null`, which is the only thing that renders "Sessions are unavailable
  on this workspace". What a member actually got was the legacy rail with an
  empty vendored zone, no explanation, and one 403 in the console every 500 ms.
  It reads as "the reskin does not work".

**A fourth cutoff is still the wrong instrument, and now for a stated reason.**
`createdAt` cannot answer this question: a machine can be recreated onto a new
image at any moment and the control plane learns nothing about the image it
came up on, so a cutoff would be wrong in both directions on the same fleet.
The browser asks the box instead — one GET of `/lody/platform`, read for its
STATUS — and degrades the whole workspace when the answer is structural. The
mechanism is `packages/webapp/src/lody/box-capability.ts` and the design note is
`plans/LODY-RUNTIME-DESIGN.md` §17.

**#112's machine-stats needs no fourth cutoff either, and the reason is worth
naming**, because it is the shape a guest feature should have. The guest POSTs
to `/workspaces/self/machine-stats` every ten minutes and the control plane
fills `machines.disk_used_percent`; a box on an older image simply never calls,
`volumeUsedPercent` stays absent, and the meter renders nothing. Nothing is
refused and nothing 403s. A capability cutoff is only needed where the OLD side
rejects the NEW payload — which is exactly the `share` claim's problem above,
and not this one. The recycle in §13.4 fills the meter as a side effect.

### 13.3 Flip the flag, box image first

Two names for one flag, and the ORDER between them is the whole point:

| # | Flag | Where | Why first |
|---|---|---|---|
| 1 | `BLITZ_LODY_SESSIONS` | the box image / s6 service environment | the daemon has to be running before a browser dials it. A box with the daemon and no UI is inert; a UI with no daemon is a broken screen. |
| 2 | `VITE_BLITZ_LODY_SESSIONS` | the webapp build (`env.defaults`, and the deployment's build env) | read at MODULE LOAD (`webapp/src/lody/flag.ts`), so it is a build-time decision and flipping it means a deploy. |

Reverse the order and every member on canary sees a rail that cannot list a
session.

### 13.4 Dogfood on canary

Canary deploys on every push to `main` (`docs/DEPLOY-RUNBOOK.md`). Recycle a
workspace onto the new image first — the capability cutoff is `createdAt`-based,
so an existing VM stays incapable however new the code is.

1. `curl -s https://<canary>/version` — confirm `boxImageRef` is the new image.
   Since #115 that value is canary's R2 manifest URL, not a GHCR digest, so
   check `boxImageTag` and `boxImageSha256` beside it: mode B pins with all
   three, and the tag is what names the archive the digest is of.
2. Open a workspace. It lands on the chat landing (§0.4), the rail shows the
   three sections, and "+ New session" opens the composer.
3. Send one turn. Confirm the transcript streams and the machine chip names the
   box.
4. Register a repo under `/workspace`, tick the worktree pill, run a turn, and
   confirm the diff badge appears on the rail row.
5. Share that session read-only with a second member. Confirm their rail grows
   "Shared with you", the row opens, the transcript renders and there is no
   composer.
6. Re-share read-write. Confirm the composer appears and a prompt runs on the
   owner's box.
7. Revoke. Confirm the row goes and the live connection is cut
   (`plans/LODY-SHARING.md` §5).
8. Terminals: open a TUI tab and confirm it is unchanged.
9. Two things this image carries that are not ours, and that the same recycle
   is the only chance to see: "My machine" should draw a volume meter within
   ten minutes (#112's `machine-stats` service reporting for the first time),
   and the daemon should sit in its own memory leaf —
   `cat /sys/fs/cgroup/blitz-user.slice/lody.scope/memory.max` from a terminal
   tab, which is the placement the deleted actor used to hold (#113,
   `docs/MEMORY-BOUNDARY.md`). A daemon outside that leaf is a runaway agent
   with no ceiling.

Step 6 is also the cheapest place to close the one thing the exit tests could
not (`plans/LODY-SHARING.md` §10.5): whether the daemon acts on a permission
answered by a non-owner. Answer one card from the grantee's browser and watch
the agent continue.

### 13.5 Schedule the merge agent

`docs/LODY-MERGE.md` is written to be executed verbatim. §5.4 says to wire it to
a schedule "once the first two manual merges go clean" — one has, and its
friction is in that document's log. Wire the second by hand before scheduling.
