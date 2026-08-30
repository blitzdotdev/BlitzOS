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

| # | File | Line (at `966623d0`) | Upstream anchor | What it gates |
|---|---|---|---|---|
| 1 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 120 | `window.__LODY_ELECTRON__ &&` inside `canUseLocalMachineRpc`'s `Boolean(...)` | every local Machine RPC, including `session/dispatch-turn` |
| 2 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 182 | `const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__;` | `file/preview-local`; without it a local path is sent to Streams |
| 3 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 999 | `window.__LODY_ELECTRON__ &&` in `requestLocalProjectGitState` | the sidebar's branch/worktree state |
| 4 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 1055 | `window.__LODY_ELECTRON__ &&` in `requestLocalProjectControl` | every `local-project/*` and `worktree/*` call |
| 5 | `packages/components/src/providers/create-workspace-runtime.ts` | 2058 | `if (!window.__LODY_ELECTRON__) {` in `canUseLocalSessionControl` | `session/create`, `session/chat`, `machine/*` |
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

Verify this divergence with:

```sh
git diff --stat <subtree-import-commit> -- vendor/lody \
  ':!vendor/lody/UPSTREAM.md' ':!vendor/lody/BLITZ-PATCHES.md'
```

Expected after phase 4: exactly FOUR files — the three above with six
added/changed lines, plus `components/loro-sidebar.tsx` from seam patch 2.

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

| # | File | Line (at `966623d0`) | Upstream anchor | What it does |
|---|---|---|---|---|
| 1 | `packages/components/src/components/loro-sidebar.tsx` | 168 | after `bottomFloatingContent?: ReactNode;` in `LoroSidebarProps` | declares `hideHeader?: boolean` and `hideFooter?: boolean` |
| 2 | same | 646 | after `bottomFloatingContent,` in the destructuring | defaults both to `false` |
| 3 | same | 876 | the `group/sidebar-header` `<div>` | wraps it in `{hideHeader ? null : ( … )}` |
| 4 | same | 1212 | the `getLoroSidebarFooterClassName(isMobile)` `<div>` | wraps it in `{hideFooter ? null : ( … )}` |

Hunks 3 and 4 are a guard plus a re-indent of the block they wrap, which is why
the raw diff is ~170 lines and the meaningful one is four:

```sh
git diff -w <subtree-import-commit> -- \
  vendor/lody/packages/components/src/components/loro-sidebar.tsx
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

## Patches to the published npm artifact (NOT to this tree)

These are applied at box-image build to the `lody` package installed from npm.
Nothing under `vendor/lody` changes, but they are recorded here because this
file is the merge agent's conflict manual and **every one of them is a standing
obligation at every version bump**.

| Patch | Target | Anchor | Reason |
|---|---|---|---|
| `packages/box/patches/lody-local-platform.mjs` | `lody/dist/index.js` | 4× `resolvePlatformKind("cloud")` | `lody@0.88.1` on npm is the CLOUD build: its Vite config inlines the platform as a literal, so the local composition root is unreachable and the daemon blocks on a device-authorization login. The patch restores the `LODY_PLATFORM` env read. Without it a box cannot start the daemon at all. |

**Per-bump obligation.** Bumping the `lody` pin in `packages/box/Dockerfile`
requires re-auditing this patch in the same change. It is guarded twice, so
neglect fails the image build loudly rather than shipping a broken box:

1. `EXPECTED_INPUT_SHA256` pins the sha256 of the published `dist/index.js`.
   Any new version fails here first.
2. `EXPECTED_OCCURRENCES` pins the anchor count at 4. A refactor that moves or
   splits the call sites fails here.

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
  set (`:2415`), and the box is visible only through
  `buildVisibleMachineIndex`'s owner fallback, which is excluded from it.
  `packages/webapp/src/lody/agent-configs.ts` runs their own
  `runStartupAcpCapabilitiesRefresh` over BlitzOS ports instead. Candidate
  upstream PR: let the caller supply the machine list.
- **`locales/en.json` is a FLAT map with dotted keys**, so any i18next instance
  built for their components needs `keySeparator: false` — their own init sets
  it (`i18n/index.tsx:121`) and `packages/webapp/src/lody/i18n.ts` now does too.
  Not a divergence, a required initialization option; recorded because getting
  it wrong is silent.
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
