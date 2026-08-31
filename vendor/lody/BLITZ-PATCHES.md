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

Expected after phase 7: exactly SEVEN files — the three above with six
added/changed lines, plus `components/loro-sidebar.tsx` from seam patch 2,
`lib/electron-session-file-sender.ts` from seam patch 3, and
`components/sessions/session-chat-interface.tsx` +
`components/sessions/session-detail.tsx` from seam patch 4.

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

## Patches to the published npm artifact (NOT to this tree)

These are applied at box-image build to the `lody` package installed from npm.
Nothing under `vendor/lody` changes, but they are recorded here because this
file is the merge agent's conflict manual and **every one of them is a standing
obligation at every version bump**.

| Patch | Target | Anchor | Reason |
|---|---|---|---|
| `packages/box/patches/lody-local-platform.mjs` | `lody/dist/index.js` | 4× `resolvePlatformKind("cloud")` | `lody@0.88.1` on npm is the CLOUD build: its Vite config inlines the platform as a literal, so the local composition root is unreachable and the daemon blocks on a device-authorization login. The patch restores the `LODY_PLATFORM` env read. Without it a box cannot start the daemon at all. |
| `packages/box/patches/lody-acp-auth-queue.mjs` | `lody/dist/index.js` | the `extractQueueKey` switch tail in `MessageProcessor` | Every `machine/*` message falls to `extractQueueKey`'s `default: return null`, and `ConcurrentQueue` maps `null` onto ONE serial chain (`__default__`). `machine/acp-authenticate` with `action: 'start'` runs `claude auth login --claudeai`, which blocks on stdin until the member pastes the code back — so the `submit-code` carrying that code queues behind the login waiting for it, and so does `cancel`. The patch gives a `start` its own per-agent chain. Without it an interactive agent sign-in can never be completed, only timed out after 285 s. |

Applied in that order. **The order is not cosmetic:** `lody-local-platform`
guards on a sha256 of `dist/index.js` AS PUBLISHED, so nothing may rewrite the
file before it runs. `lody-acp-auth-queue` therefore guards on the installed
package's version plus its own anchor at exactly one occurrence — a file hash can
only ever pin the first patch in a chain. Both are idempotent: re-running either
on an already-patched bundle reports it and exits 0, which is what lets
`packages/webapp/test/lody-daemon-harness.ts` copy a real box's bundle and
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
