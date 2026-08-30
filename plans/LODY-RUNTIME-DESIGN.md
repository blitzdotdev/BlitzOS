# Lody sessions — phase 2/3 browser runtime design

How the vendored Lody renderer is wired to the box daemon in the browser: the
platform provider, the two transport planes, the session-surface mount, and the
style compensation. Plan of record: `plans/LODY-SESSIONS.md`. Evidence:
`plans/evidence/lody-phase0.md` (render, Tailwind, bundle) and
`plans/evidence/lody-phase1.md` (daemon, relay-bridge, protocol v7).

Phase 2 exit test: a session is created from the browser, a turn dispatches, a
reply streams. Phase 3 exit test: send / steer / cancel / permission round trip
on a canary box.

## 0. What phases 0 and 1 settled

- The subtree, 85 runtime deps, the Vite bridge (`packages/webapp/src/lody/vendor-bridge.ts`)
  and the `lody` cascade layer are in place and measured.
- The sync surface is the daemon's own unix socket, re-served by
  `packages/box/rootfs/usr/local/libexec/blitz-lody-bridge` (`GET /sync` ws,
  `POST /rpc`, `GET /healthz`) and proxied by `packages/box/gateway/main.go`.
  No `loro-websocket` server, no `loro-repo` `WebSocketTransportAdapter`.
- Protocol version is **7** on both sides, as a `z.literal`: a skewed peer fails
  at parse time, not silently.
- `runtimeOverrides.claudeCodeExecutable` / `.codexPath` short-circuit the
  daemon's managed-runtime download; the bundled adapters read
  `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME` from the
  daemon's environment.
- Auth needs no browser work: `/workspaces/:id/webapp/7445/...` is a
  control-plane route reached with the session cookie, and the CP mints the box
  ticket. A browser `WebSocket` cannot set headers and does not need to.

## 1. `BlitzPlatformProvider`

Replaces the phase-0 `LodySpikePlatformProvider` in
`packages/webapp/src/lody/platform.tsx`.

### 1.1 The provider object

`PlatformProvider` (`vendor/lody/packages/platform/src/provider.ts:93`) has five
fields. Build it with `createLocalPlatformProvider`
(`vendor/lody/packages/platform/src/local.ts:67`); the helper supplies
`identity.signOut`, `workspaces.setActive` (single-workspace reject) and the
deliberately absent `create`.

| Field | Value | Why |
|---|---|---|
| `kind` | `'local'` | The box daemon runs the local composition (`LODY_PLATFORM=local`). |
| `identity.session` | `MutableStore<PlatformSessionState>` | `loading` → `authenticated` on the daemon snapshot (§1.2). |
| `workspaces.state` | `MutableStore<WorkspacesState>` | Same transition, same tick — both stores settle together. |
| `capabilities` | `LOCAL_PLATFORM_CAPABILITIES` (empty set) | **Do not add `remoteMachines`.** §7.2 of the plan says to; it is wrong. The box IS the local machine, and that capability means "dispatch to a machine other than the local one", which has no transport here. |
| `cloudApi` | `null` | A capability claiming availability with a null adapter is an invalid assembly by their own contract. |
| `sync` | `{ mode: 'local' }` | Sets `cloudPlaneEnabled = false` (`create-workspace-runtime.ts:445`): no Streams member, no token provider. |

Set `VITE_LODY_PLATFORM=local` in `env.defaults`. `getAppPlatformKind()`
(`components/src/lib/app-platform.ts:14`) reads it, and
`useImplicitLocalWorkspace()` returns `null` for any other value, stranding
`RuntimeProvider` at `effectiveWorkspaceId === null`
(`providers/runtime-provider.tsx:130`). An absent value already resolves to
`local`; set it anyway so the intent is declared.

### 1.2 Identity: the daemon owns it, our auth decorates it

`PlatformUser.id` is **not** a BlitzOS membership id. The local composition
mints a durable `local:<uuid>` user and one `lw_<uuid>` workspace into
`$LODY_DATA_DIR/workspace-catalog.json`
(`vendor/lody/packages/shared/src/node/local-workspace-catalog.ts`), and every
local write and access check runs against it (`platform/src/local.ts:93`). The
parser to mirror is `vendor/lody/apps/electron/src/main/local-platform-snapshot.ts`:
it rejects a `userId` without the `local:` prefix and requires exactly one
`state: 'active'` workspace.

Add a fourth bridge door, `GET /platform` (§3.4), serving that catalog, and read
it from `packages/webapp/src/lody/identity.ts`:

```
session    = { status: 'authenticated',
               user: { id: snapshot.userId,
                       name: viewer.name, image: viewer.avatarUrl } }
workspaces = { status: 'ready',
               workspaces: [{ id: snapshot.workspace.workspaceId,
                              name: activeWorkspace.title,          // ours, not "Lody"
                              slug: snapshot.workspace.slug ?? 'local',
                              role: snapshot.workspace.role }],
               activeWorkspaceId: snapshot.workspace.workspaceId }
```

Our auth contributes display name, avatar and workspace title only. Membership,
roles and sharing stay in D1 and reach Lody in phase 6 through the gateway
ticket, never through `PlatformProvider`. Poll the door on the 500 ms cadence of
`providers/local-platform-provider.ts:29` until it settles.

### 1.3 The `AuthenticatedConvexContext` stub (phase-0 blocker #2)

`useAuthenticatedConvex` (`components/src/hooks/use-authenticated-convex.ts:16`)
throws without a provider, and capability gating does not reach it. Its value is
`AuthenticatedConvexState & {...}`, whose state half is
`{ isAuthenticated, isLoading }` (`lib/authed-convex-query.ts:1`). The settled
signed-out shape, byte-for-byte their Storybook preview
(`components/.storybook/preview.tsx:108`):

```ts
const SIGNED_OUT_CONVEX: AuthenticatedConvexContextValue = {
  authSessionId: null, isAuthenticated: false, isLoading: false,
  isRecovering: false, confirmedUnauthenticated: true,
  claimAutomaticCommand: () => false, requestAuthRecovery: () => {},
};
```

`isAuthenticated: false` makes `useRecoverableConvexQuery`
(`hooks/use-recoverable-convex-query.ts:38`) take `skip`;
`confirmedUnauthenticated: true` stops anything waiting for auth.

**A `ConvexProvider` is required too** — the spike escaped it by mounting three
leaves. `useRecoverableConvexQuery` calls `ConvexReact.useQueries({})` even when
skipping, and `useQueries` throws without a client. Mirror the preview
(`preview.tsx:104`) with a client incapable of I/O:

```ts
new ConvexReactClient('http://127.0.0.1:1/', {
  webSocketConstructor: NeverConnectingWebSocket,   // BaseConvexClientOptions
  unsavedChangesWarning: false, logger: false,
});
```

`webSocketConstructor` is documented at
`node_modules/convex/dist/cjs-types/browser/sync/client.d.ts:30`. A stub that
never fires `open` makes zero cloud I/O a construction property, not a URL
accident.

### 1.4 Provider stack, outermost first

```
<ConvexProvider client={inertConvexClient}>              §1.3
 <AuthenticatedConvexContext.Provider value={SIGNED_OUT_CONVEX}>
  <PlatformContext.Provider value={blitzPlatform}>       @lody/platform/react
   <I18nextProvider i18n={initLodyI18n()}>               src/lody/i18n.ts, en only
    <ThemeProvider>                                      their VS Code theme engine
     <TooltipProvider>
      <RouterContextProvider router={memoryRouter}>      §4.2
       <RuntimeProvider>                                 providers/runtime-provider.tsx
        <SessionSurfaceRoutes />
```

`RuntimeProvider` also calls `usePostHog()` (`runtime-provider.tsx:100`). Verify
it tolerates an absent `PostHogProvider`; if not, wrap a disabled client. Never
a real key — `telemetry` is not in our capability set.

## 2. Data plane

### 2.1 The seam is `window.ipc`, not a source patch

`create-workspace-runtime.ts:2679` calls `createLocalLoroDataPlaneConnection()`
through a static import, and `RuntimeDeps` (`:143-182`) has no DI field for it.
But that factory (`providers/local-loro-data-plane-connection.ts:8`) gates only
on `getIpcServices()`, and `getIpcServices()` (`lib/electron-ipc-client.ts:50`)
is a **generic proxy over `window.ipc`** — a `{ invoke(channel, ...args),
on(channel, cb): () => void, send(channel, payload) }` bridge dispatching
`groupName.methodName` by string (`createLodyIpcProxy`, `:22`). Nothing about it
is Electron-specific.

So `packages/webapp/src/lody/local-bridge.ts` installs `window.ipc` before the
runtime mounts, and the data plane needs **no vendor edit at all**. Channels are
pinned by `vendor/lody/packages/shared/src/electron-ipc-channels.ts`:

| Channel | Kind | Payload | Implementation |
|---|---|---|---|
| `loro.send` | send | `LocalLoroDataPlaneClientMessage` | `ws.send(JSON.stringify(msg))` |
| `loro.subscribe` | send | `null` | open the socket if closed |
| `loro.isConnected` | invoke | → `boolean` | socket readyState |
| `loro.event` | on | `LocalLoroDataPlaneServerMessage` | parsed WS text frame |
| `loro.status` | on | `boolean` | open/close transitions |
| `machineRpc.send` | invoke | `LocalMachineRpcRequest` → `SendLocalMachineRpcResult` | §3.2 |
| `sessionControl.send` | invoke | `SessionControlSendInput` | §3.4 |
| `sessionControl.response` | on | `{ requestId, response }` | §3.4 |
| `localProjects.*` | invoke | §3.3 | §3.4 |
| `localPlatform.getSnapshot` | invoke | → `ElectronLocalPlatformSnapshot` | §1.2 |

Every other channel rejects with `lody_ipc_channel_unsupported`. The allowlist is
explicit so a new upstream call site fails loudly instead of hanging.

**Do not set `window.__LODY_ELECTRON__`.** 44 sites read it: window controls in
`routes/__root.tsx`, `electron-menu-handler`, `use-electron-updater-state`, the
native theme bridge (`theme-provider.tsx:87`), OneSignal,
`loro-app-sidebar.tsx:510`. Set `window.__LODY_LOCAL_BRIDGE__ = true` instead and
take the five-token seam patch in §3.1 for the sites that gate the LOCAL planes.

### 2.2 `LocalLoroDataPlaneConnection` over a WebSocket

`packages/webapp/src/lody/data-plane-connection.ts` implements the four-method
seam declared at `vendor/lody/packages/shared/src/local-loro-transport.ts:44`
(`send`, `onMessage`, `onStatusChange`, `isConnected`) — the same four the
Electron version implements in 30 lines. `LocalLoroTransportAdapter` is used
unchanged; `create-workspace-runtime.ts:2693` constructs it with
`{ workspaceId, peerId, connection }` and `repo.addTransport('local', …)`.

1. **Framing.** One WebSocket text message = one JSON frame. The bridge appends
   the `\n` toward the daemon and strips it back; the browser never sees one.
2. **Serialization.** `send` takes an object, so `JSON.stringify` it. `onMessage`
   must `JSON.parse` and validate with `LocalLoroDataPlaneServerMessageSchema`
   before delivering — external data parsed at the boundary, per CLAUDE.md. An
   unparseable frame is counted and dropped, never thrown: the pipe is a
   broadcast and the adapter filters by `workspaceId` + `peerId`.
3. **Status.** `onStatusChange(listener)` calls the listener immediately with the
   current value — the Electron version does, and the adapter needs it to rejoin
   — and returns an unsubscribe.
4. **Reconnect.** One socket per browser tab, so a tab close is a peer death and
   the daemon drops its subscriptions with no synthesized `detach`. On an
   unexpected close, redial with the relay's backoff
   (`loro-data-plane-relay.ts:21-22`, 1 s → 30 s) and emit `status=false` then
   `true`; the adapter rejoins every room. Send `detach` on `beforeunload` as a
   courtesy, never as a requirement.
5. **Liveness.** `ping`/`pong` are protocol frames, not WebSocket control frames,
   and the bridge forwards them untouched. Own the watchdog with their numbers:
   ping every 15 s, 45 s of silence is dead (`loro-data-plane-relay.ts:16-17`).
6. **Caps.** Never send over `LOCAL_LORO_DATA_PLANE_MAX_PAYLOAD_BYTES`
   (32 MiB − 64 KiB); drop the socket on an inbound frame over
   `LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES`.
7. **Presence is not wired in phase 2/3.** `create-workspace-runtime.ts:2710`
   gates the local presence store on `getIpcServices() && deps.onPresenceSnapshot`,
   which our bridge satisfies, but the daemon emits `presence` only for its own
   origin. Take it as free; build nothing on it before phase 6.

### 2.3 Frame contract → fixture corpus (CLAUDE.md cross-runtime rule)

Phase 1 shipped no fixtures because the relay copies bytes without reading them
(`lody-phase1.md` blocker 4). `data-plane-connection.ts` is the first
BlitzOS-authored producer and parser, so the contract becomes ours:
`packages/schema/fixtures/lody-data-plane/`, plus
`packages/webapp/test/lody-data-plane-frames.test.ts` (browser) and
`packages/box/guest-tests/test/lody-bridge-frames.test.ts` (bridge framing: one
line in, one message out, and back). Enumerated from
`vendor/lody/packages/shared/src/local-loro-data-plane.ts`:

- Constants: `protocolVersion: 7` (a `z.literal` on every frame),
  `MAX_FRAME_BYTES = 33554432`, `MAX_PAYLOAD_BYTES = frame − 65536`,
  `PAYLOAD_TOO_LARGE = 'payload_too_large'`.
- Room, discriminated on `scope`: `meta` | `doc` (+`docId`) | `flock-doc`
  (+`flockDocId`).
- Payload, discriminated on `kind`: `doc-update` (`dataBase64`),
  `doc-update-chunk` (`transferId`, `chunkIndex`, `chunkCount`, `dataBase64`),
  `flock-json` (`bundle`).
- Client → server (`LocalLoroDataPlaneClientMessageSchema`): `join` (`requestId`,
  `workspaceId`, `peerId`, `room`, `haveVersion?`), `update` (+`payload`),
  `leave`, `detach` (no room), `machine-monitor` (`dataBase64`), `ping` (no
  workspace/peer — it belongs to the socket).
- Server → client (`LocalLoroDataPlaneServerMessageSchema`): `joined`
  (`requestId`, `serverVersion?`, `payload?`), `update` (peer-addressed),
  `room-status` (`connecting|joined|reconnecting|disconnected|error`), `error`
  (`code`, `message?`, `terminal?`, optional `room`/`peerId`/`requestId`),
  `presence` (`dataBase64`, workspace broadcast), `machine-monitor`, `pong`.
- Corpus: one instance of each of the 13 types, one chunked doc-update transfer
  (3 chunks), one `terminal: true` `payload_too_large` error, and one frame
  carrying an unknown field — the schemas are deliberately not `.strict()` and
  that tolerance must be pinned.

## 3. RPC plane

### 3.1 The routing seam in `workspace-machine-rpc-facade.ts`

The facade sends local RPC through `getIpcServices()?.machineRpc.send` (`:94`),
which our bridge now provides — but four guards also require
`window.__LODY_ELECTRON__` (`:120` `canUseLocalMachineRpc`, `:182` file preview,
`:999` `requestLocalProjectGitState`, `:1055` `requestLocalProjectControl`), and
a fifth guards session control (`create-workspace-runtime.ts:2058`
`canUseLocalSessionControl`). In `syncMode: 'local'` the cloud fallback throws by
design (`create-workspace-runtime.ts:1943`, `:2342`), so these are hard failures.

**Declared seam patch, five tokens in two files** — both files are already §5.3
seams 1 and 2, so the seam list does not grow:

```
-  window.__LODY_ELECTRON__ &&
+  (window.__LODY_ELECTRON__ || window.__LODY_LOCAL_BRIDGE__) &&
```

plus one line adding `__LODY_LOCAL_BRIDGE__?: true` to
`components/src/window-globals.d.ts:30`. Record all three in
`vendor/lody/BLITZ-PATCHES.md` and open the upstream PR as "allow a non-Electron
local bridge": the predicate is strictly additive. Rejected alternative — a Vite
`resolveId` hook redirecting `./local-loro-data-plane-connection` — hides the
swap from every reader and still cannot reach the four facade guards.

### 3.2 Transport: one POST per request

`packages/webapp/src/lody/rpc-client.ts` posts JSON to `lodyRpcUrl`
(`packages/webapp/src/resolver.ts:9`). `machineRpc.send` takes a
`LocalMachineRpcRequest` (`shared/src/local-machine-rpc.ts:53`, `.strict()`,
discriminated on `method`) and must return `SendLocalMachineRpcResult` —
`{ ok: true, result }` | `{ ok: false, error }`; the facade turns a non-ok into a
retryable `transient_io` Code Collab error
(`workspace-machine-rpc-facade.ts:88`). The bridge already sets
`x-lody-local-control: 1` and targets `/machine-rpc`. `timeoutMs` rides in the
body; enforce it browser-side with an `AbortController` too, because the bridge
does not.

### 3.3 The methods phase 3 actually uses

| Method | Params | Called from |
|---|---|---|
| `session/dispatch-turn` | `sessionId`, `userTurnId`, `userId`, `timestamp`, `inputConfig` | send, after the CRDT write |
| `session/steer` | + `expectedTurnId` | composer steer |
| `session/cancel` | `sessionId`, `turnId` | stop button |
| `session/prepare`, `session/prepare-cancel` | `SessionPreparationSpec` / `…CancelSpec` | worktree pre-warm from the composer |
| `session/terminate` | `sessionId` | close / archive |
| `session/fork`, `session/edit-and-resend` | their specs | message actions |
| `code-collab/get-file-index` | `CodeCollabV2FileIndexRequest` | file tree, All Changes |
| `code-collab/open-text`, `refresh-text`, `save-text` | | editor |
| `code-collab/open-current-diff`, `open-all-changes-diff`, `open-turn-diff` | | diff views |
| `file/preview-local` | `FilePreviewV3Request` | file preview — the local-target method; never fall back to `file/preview` |

`local-project/*` and `worktree/*` are **not** machine-RPC methods: they are
`LocalProjectControlRequest` (`message-schemas.ts:2063`), reached through
`localProjects.control` / `.getGitState` / `.listFiles` / `.listDir` /
`.readFile` / `.listSessionWorktreeFiles` / `.readSessionWorktreeFile` /
`.checkoutBranch` — the method names in
`apps/electron/src/main/ipc/services/local-projects-ipc.ts`, which our bridge
reproduces. Phase 1 proved `local-project/add`, `/list` and `/git-state` answer
on `/project-control` with no login.

`session/create`, `session/chat`, `machine/status`,
`machine/acp-capabilities-refresh` and `machine/acp-binary-status` are
`LocalSessionControlRequest` (`message-schemas.ts:1770`) and go to
`/session-control`. The capabilities refresh fills the composer's model and
effort selectors (`hooks/use-acp-selector-options.ts`), so the plan's "the
composer must fully work" bar depends on that door existing.

### 3.4 Three more bridge doors (a phase-2 box change)

| Bridge path | Gateway path | Upstream |
|---|---|---|
| `POST /control` | `/lody/control` | control socket `/session-control` |
| `POST /project` | `/lody/project` | control socket `/project-control` |
| `GET /platform` | `/lody/platform` | `$LODY_DATA_DIR/workspace-catalog.json` + `run/daemon.json` machineId |

Each lands in `packages/schema/src/webapp-surface.ts`,
`packages/control-plane/core/webapp-surface.ts`, `packages/box/gateway/main.go`,
both drift tests, and `resolver.ts` as `lodyControlUrl` / `lodyProjectUrl` /
`lodyPlatformUrl`. Viewer policy matches `/lody/rpc`: 403 until phase 6.

`/session-control` answers `{ ok, responses: [...] }` — the whole batch at the
end, where Electron streams each response through the `sessionControl.response`
push channel. Our `sessionControl.send` therefore replays the array through the
registered listeners with the caller's `requestId` before it resolves. Progress
messages (`machine/acp-binary-progress`) are lost; we never install a binary, so
nothing consumes them.

### 3.5 `runtimeOverrides` injection point

`runtimeOverrides` is **not** a per-dispatch parameter. It is a field on an
agent-config row in the machine Flock document (`atoms/agents.ts:140`, parsed at
`:158` against `BuiltinRuntimeOverridesSchema`), copied into session meta at
launch and read back by `components/ai-gui/view.tsx:2380` as
`agentConfig?.runtimeOverrides ?? sessionLaunch?.runtimeOverrides`.

The injection point is therefore a bootstrap in
`packages/webapp/src/lody/agent-configs.ts`, run once per runtime after
`activeWorkspaceRuntimeAtom` settles, idempotent on config id, through
`cmdCreateAgentConfigAtom` (`atoms/agents.ts:325` →
`writeAgentConfigToMachineFlock`, `:42`):

```
{ id: 'blitz-claude', machineId: <box machineId>, cliType: 'builtin',
  agentType: 'claude-code', name: 'Claude Code', env: {},
  runtimeOverrides: { claudeCodeExecutable: '/usr/local/bin/claude' } }
{ id: 'blitz-codex',  machineId: <box machineId>, cliType: 'builtin',
  agentType: 'codex', name: 'Codex', env: {},
  runtimeOverrides: { codexPath: '/usr/local/bin/codex' } }
```

Invariants, from `lody-phase1.md` §A.d:

- Never write a builtin config without an override. Without one the daemon
  resolves its managed runtime and downloads a second unpinned agent binary —
  what the image's `DISABLE_AUTOUPDATER` pin prevents everywhere else.
- `hasBuiltinRuntimeOverrideValues` (`atoms/agents.ts:348`) makes an
  override-bearing config ineligible for the provider-setup/install flow. That is
  wanted: the install path can never run.
- Credentials stay on the existing box path. The s6 service environment carries
  `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR`, so the adapter sees what the
  TUI sees. Never put a token in `config.env`: that row is a synced CRDT.
  `session/create.env` stays the per-turn escape hatch for phase 6.
- Never register `kimi` or `grok`: managed-runtime only, no override to pin.

## 4. `SessionSurface`

### 4.1 Mount point and lifecycle

`packages/webapp/src/lody/SessionSurface.tsx`, mounted once inside
`section.webapp-workspace-view` (`packages/webapp/src/CloudApp.tsx:1543`) beside
`<WorkPanes>`, wrapped in `<div class="lody-surface">`. It stays **mounted** and
is toggled with `hidden`, exactly as `shell/WorkPanes.tsx:193` keeps every ttyd
session rendered: the runtime owns a WebSocket, an IndexedDB repo and a WASM
instance, so remounting on each rail click would resync from scratch. One
`React.lazy` dynamic import, preserving the phase-0 measurement (entry +1.9 KB,
the rest in an 849 KB gzip lazy chunk, entry CSS hash unchanged), taken only
when `LODY_SESSIONS_ENABLED && activeWorkspaceRunning`.

### 4.2 Memory-history router

Their pages are TanStack file routes under
`vendor/lody/packages/components/src/routes/$workspaceName/_auth/`, and `_auth`
is a cloud auth gate we cannot mount. Build our own tree in
`packages/webapp/src/lody/router.tsx` the way their Storybook preview does
(`.storybook/preview.tsx:32-95`), but with the real components:

- `/$workspaceName` — `Outlet`.
- `/$workspaceName/chat` → `ChatLanding` (`components/chat/chat-landing.tsx`),
  `validateSearch: parseChatLandingSearch`.
- `/$workspaceName/sessions/$sessionId` → `SessionDetail`
  (`components/sessions/session-detail.tsx`).
- `null`-rendering stubs for every other address their components navigate to,
  or `navigate` throws: `/$workspaceName/archive`, `/$workspaceName/tasks`,
  `/$workspaceName/tasks/$taskId`, `/$workspaceName/settings` and its children
  (`about`, `account`, `agents`, `ai-usage`, `appearance`, `billing`, `github`,
  `keyboard-shortcuts`, `machines`, `people`, `preferences`, `projects`,
  `workspace`), `/`, `/workspace/create`. The generator for this list is
  `grep -rho "to: '/[^']*'"` over `components/`, `hooks/`, `lib/`; re-run it at
  every upstream merge.

`createMemoryHistory({ initialEntries: ['/' + slug + '/chat'] })`, slug =
`snapshot.workspace.slug ?? 'local'` (`LOCAL_WORKSPACE_FALLBACK_SLUG`,
`providers/local-platform-provider.ts:27`). Publish the route target before
`RuntimeProvider` reads it: `useSetAtom(setWorkspaceContextAtom)({ slug,
workspaceId })` (`atoms/workspace-context.ts:21`) — one call, one transaction.
Do not set `currentWorkspaceIdAtom` and `currentWorkspaceSlugAtom` separately;
those compatibility setters clear each other.

### 4.3 Bridging to `sessions-page-state.ts`

`packages/webapp/src/sessions-page-state.ts` stays a flat `AppRoute` union and
learns nothing about chat sessions in phase 3. The memory router's address is
internal state, mirrored one way: the rail calls `router.navigate({ to:
'/$workspaceName/sessions/$sessionId', params })`, and
`router.subscribe('onResolved')` sets `activeLodySessionId` in `CloudApp` state,
which drives `hidden` on `<SessionSurface>` and the rail highlight. No browser
URL change, no history entry. Deep links are a phase-4 decision; when they come
they extend `AppRoute` with `{ page: 'webApp'; sessionId }` and feed
`initialEntries`.

### 4.4 Selection wiring

`CloudApp.tsx` gains `activeLodySessionId: string | null` beside
`railActiveSessionId` (`:987`):

- Selecting a terminal row calls `selectTtydSession` (`:1034`) **and** clears
  `activeLodySessionId`; the surface hides and `<WorkPanes>` shows.
- Selecting a chat row sets `activeLodySessionId` and leaves `WorkspaceTabs`
  untouched. Chat sessions are never tabs (§8 of the plan).
- `+ New session` navigates to `/$workspaceName/chat` and sets a landing
  sentinel, so the surface is visible with no session selected.
- In phase 3 the rail is still `shell/WorkspaceSessionRail.tsx`; one temporary
  "Chats" row driven by the memory router exercises the whole loop.
  `LoroSidebar` replaces it in phase 4.

### 4.5 Flag gating

`LODY_SESSIONS_ENABLED` (`packages/webapp/src/lody/flag.ts`) gates the dynamic
import, the `window.ipc` install, the compensation stylesheet, the rail's chat
section and `+ New session`. Off is the default, and off must mean **the Lody
chunk is never fetched** — assert it in a test, because one static import in
`CloudApp.tsx` would silently pull 3.5 MB into the entry graph.
`LODY_SPIKE_HASH` and `SessionSurfaceSpike.tsx` are deleted when `SessionSurface`
lands; their fixtures move to `packages/webapp/test/` as render fixtures.

## 5. Styling

### 5.1 The compensation stylesheet

New file `packages/webapp/src/lody/blitz-compensation.css`, imported **first**
from `packages/webapp/src/webapp-base.css` so every later rule of ours wins a
tie. It is unlayered, so it beats `@layer lody` by rule rather than specificity,
and every selector is wrapped in `:where()` so its specificity is zero and no
rule of ours can lose to it. Properties come from the pinned per-probe table in
`plans/evidence/lody-phase0.md` §3; every declaration is `revert` — author CSS
rolling back to the user-agent origin, which is exactly "give the element its
browser default back". Scope every selector to our own containers
(`.drive-shell`, `.webapp-shell`), never `#root`: `.lody-surface` lives under
`#root`, so an `#root`-scoped rule would reach into the surface.

```css
:where(html, body) { -webkit-text-size-adjust: revert; }
:where(.drive-shell, .drive-shell *, .webapp-shell, .webapp-shell *) {
  animation-duration: revert; animation-iteration-count: revert;
  outline-color: revert; scroll-behavior: revert; transition-duration: revert;
}
:where(html) { tab-size: revert; line-height: revert; padding: revert;
  border-width: revert; border-style: revert;
  font-feature-settings: revert; font-variation-settings: revert; }
/* Their `body { … }` is a direct declaration, so no layer saves our inherited
   :root font. Restore ours by name. */
body { font-family: var(--font-ui); font-size: initial; line-height: normal;
  color-scheme: inherit;              /* :root already carries dark|light */
  -webkit-font-smoothing: auto; -moz-osx-font-smoothing: auto;
  counter-reset: revert; padding: revert;
  border-width: revert; border-style: revert; }
/* The two rows the product renders all day (phase 0: "these two matter today"). */
:where(.shell-s, .files-tree-row) { margin: revert; padding: revert;
  border-width: revert; border-style: revert; -webkit-tap-highlight-color: revert; }
:where(.drive-shell, .webapp-shell)
:where(button, input, select, textarea, a, h1, h2, h3, h4, h5, h6,
       ul, ol, li, img, table) {
  margin: revert; padding: revert; -webkit-tap-highlight-color: revert;
  border-width: revert; border-style: revert; border-color: revert; }
:where(.drive-shell, .webapp-shell) :where(button, input) {
  appearance: revert; background-color: revert; border-radius: revert;
  color: revert; opacity: revert; letter-spacing: revert;
  font-feature-settings: revert; font-variation-settings: revert; }
:where(.drive-shell, .webapp-shell) :where(button) { cursor: revert; }
:where(.drive-shell, .webapp-shell) :where(a) {
  text-decoration: revert; -webkit-text-decoration: revert; }
:where(.drive-shell, .webapp-shell) :where(h1, h2, h3, h4, h5, h6) {
  font-size: revert; font-weight: revert; }
:where(.drive-shell, .webapp-shell) :where(ul, ol) { list-style: revert; }
:where(.drive-shell, .webapp-shell) :where(img) {
  display: revert; height: revert; max-width: revert; vertical-align: revert; }
:where(.drive-shell, .webapp-shell) :where(table) {
  border-collapse: revert; text-indent: revert; }
```

`packages/webapp/test/lody-tailwind-containment.test.ts` pins the leak set
exactly. Extend it: for each probe, assert the compensation sheet declares every
leaked property. The compensation then cannot drift behind an upstream preflight
change — the merge fails loudly instead. Measure `@scope (.lody-surface)` around
the compiled output first (phase 0's option 1, one at-rule deeper in
`lodyCascadeLayerPlugin`); if it holds, most of the block above is deleted
rather than shipped. Radix portals to `document.body` are why it may not.

### 5.2 The five token collisions

Both trees define `--font-mono`, `--hover`, `--muted`, `--terminal-background`
and `--terminal-selection`. Ours are unlayered on `:root`
(`packages/webapp/src/tokens.css`), theirs are layered on `:root` inside
`@layer base` (`components/src/tailwind/index.css:786`, `:894`, `:921`), so ours
win everywhere, inside the surface included. Only two of the five are actually
broken, and the fixes differ:

| Token | Theirs | Ours | Resolution |
|---|---|---|---|
| `--muted` | HSL triplet `220 16% 96%`, read as `hsl(var(--muted))` and by the v3 preset's `colors.muted` | finished `color-mix()` | **Broken.** Redeclare on `.lody-surface` as a triplet from our palette. Every `bg-muted` / `text-muted-foreground` utility depends on it. |
| `--hover` | HSL triplet `220 14% 95%` | finished color | **Broken.** Same fix. |
| `--terminal-background` | `hsl(var(--background))`, a finished color | finished color | Same type, different value. Redeclare on `.lody-surface` from `--paper`. |
| `--terminal-selection` | `hsl(var(--selection) / 0.5)`, finished | finished | Same. |
| `--font-mono` | font stack | font stack | Compatible. Keep ours (Fira Code) and let it reskin their code blocks. Their `@fontsource/jetbrains-mono` import stays in the lazy chunk (163 files, 2.4 MB, per-`unicode-range`, so a browser fetches a handful); removing it needs a vendor edit and is not worth one. |

Mechanism: `packages/webapp/src/lody/blitz-theme.css`, unlayered, redeclaring the
four value-carrying names on `.lody-surface` — higher specificity than `:root`
and unlayered, so it wins inside the surface and changes nothing outside.
Triplet values are computed once from `tokens.css` and written as literals with a
comment naming the source token; `color-mix()` cannot yield an `H S% L%` triplet,
so they cannot be derived at runtime. The rest of the Blitz reskin is not CSS
overrides: their theme engine compiles a VS Code theme to `--vscode-*` custom
properties at runtime (`components/src/lib/vscode-theme/vscode-theme-css.ts`), so
ship a "Blitz" theme through it and leave their component classes alone.

## 6. Risks and probes

| # | Risk | Probe |
|---|---|---|
| 1 | The daemon rejects a dispatch whose `userId` is not its own local identity, making `/platform` load-bearing before it exists. | Post `session/dispatch-turn` twice, with the catalog `local:<uuid>` and with a synthetic id, and compare. Run it before writing `identity.ts`. |
| 2 | `ConvexProvider` is not the only cloud provider the session page needs (`RecoverableConvexBetterAuthProvider`, PostHog, OneSignal). | Mount `SessionDetail` from a fixture behind the §1.4 stack in a jsdom test and collect every "must be used within" message in one pass. |
| 3 | `useVisibleMachineMetas` (`runtime-provider.tsx:86`) returns nothing without cloud authorization, so `getAuthorizedMachineIds` stays null and the box never becomes a dispatch target. | Read the `localOnly` path (`providers/workspace-target-router.ts:106`), then assert `getPlaneForMachine(boxMachineId) === 'local'` within 2 s of attach. |
| 4 | The browser needs the box `machineId` before any RPC and before agent-config seeding, but the daemon mints it. | Serve it from `/lody/platform` out of `$LODY_DATA_DIR/run/daemon.json`, and gate §3.5 on it. |
| 5 | The first real turn surfaces adapter-launch problems the config probes could not (`lody-phase1.md` blocker 5). | Budget one paid turn on canary as the phase-2 exit test; capture the daemon log around the ACP spawn. |
| 6 | `/session-control` returns its batch only at the end, so a long `machine/acp-capabilities-refresh` looks hung and the composer's selectors stay empty. | Time the refresh against a cold daemon. Over ~3 s, make the bridge stream newline-delimited JSON instead of one body. |
| 7 | The five-token seam patch conflicts at an upstream merge because a guard is reworded. | The apply script greps the exact pre-image and exits non-zero; `docs/LODY-MERGE.md` lists it beside the npm platform patch. |
| 8 | Shiki's language set is emitted twice (~13 MB of 27 MB of JS): the worker build is a separate Rollup pass. | Measure again with `SessionSurface` in place; if it persists, share the worker graph through `worker.rollupOptions` before phase 7. |
| 9 | `@scope (.lody-surface)` would delete most of §5.1 but may break Radix body portals. | Wrap the compiled sheet one at-rule deeper, then run the containment test plus a portal render (dialog + select). |
| 10 | The `window.ipc` allowlist rejects a channel a future upstream calls unconditionally, and the failure is a rejected promise nobody awaits. | Log every `lody_ipc_channel_unsupported` through the runtime's analytics chokepoint; assert the set is empty across a full phase-3 round trip. |

---

## 7. What phase 2 changed about this document (2026-08-30)

Phase 2 built §1, §2, §3 and §6 against a real `lody@0.88.1` daemon. Nine things
in the plan above were measured to be wrong or incomplete. Each is listed with
what the code actually does, because this document is the brief phase 3 reads.

| # | This document says | What shipped | Why |
|---|---|---|---|
| 1 | §3.4: `/lody/platform` serves the catalog **plus the machineId from `run/daemon.json`** | The machineId comes from the catalog's own `machine` block | `run/daemon.json` on 0.88.1 carries only `{pid, socketPath, controlSocketPath, version, startedAt}`. There is no machineId in it. `workspace-catalog.json` has `machine.machineId`, so the catalog is the whole source and the bridge serves it byte-for-byte. |
| 2 | §3.5: agent config `agentType: 'claude-code'` | `agentType: 'claude'` | `'claude-code'` is the RUNTIME NAME in `MANAGED_BUILTIN_RUNTIMES` (`shared/src/ai.ts:21`); the agent type beside it is `'claude'`, and `usesAcpProvidedSessionTitle` (`:47`) branches on that exact string. |
| 3 | §2.1 table lists `localPlatform.getSnapshot` among the channels | It is LOAD-BEARING, not optional | `RuntimeProvider` resolves its workspace id through `useImplicitLocalWorkspace()` (`providers/local-platform-provider.ts:143`), which polls that channel on a MODULE-LEVEL singleton store — not through the `PlatformContext` we supply. Without the channel the runtime never gets a workspace id and never mounts, whatever `BlitzPlatformProvider` says. |
| 4 | §3.1: the seam patch is "five tokens in two files" plus a `window-globals.d.ts` line | Six hunks in three files | Same five predicates, but the file-preview guard (`:182`) needed re-wrapping across three lines to stay in the line budget. All six are recorded in `vendor/lody/BLITZ-PATCHES.md` with their upstream anchors. |
| 5 | §5.3 of `LODY-SESSIONS.md` still lists two "planned seams" for a websocket transport and a box RPC plane | Both are WITHDRAWN | The daemon's own data-plane socket is the sync surface (phase 1, §A.b) and the facade's existing local plane is the RPC surface. Neither needed a new plane; both needed the predicate above. |
| 6 | §1.1: build the provider with `createLocalPlatformProvider` | Done, and it is also the source of the empty capability set | `LOCAL_PLATFORM_CAPABILITIES` is what that helper installs, so §1.1's "do not add `remoteMachines`" is enforced by construction rather than by discipline. |
| 7 | — (not anticipated) | `@lody/*` types cannot be IMPORTED at all | `vendor-modules.d.ts` declares them as shorthand ambient modules, so TypeScript reads every imported name as a NAMESPACE and rejects it in a type position. `packages/webapp/src/lody/wire-types.ts` states the contracts on our side instead; the real shapes are enforced at runtime by Lody's own zod schemas at every boundary. |
| 8 | — (not anticipated) | `effect@3.18.4` is a runtime dependency of the renderer | `providers/local-reconnect-loop.ts` imports it. Phase 0's dependency sweep missed it because nothing in the spike's import graph reached the runtime. |
| 9 | §4.5: the flag is `LODY_SESSIONS_ENABLED` | The env var is `VITE_BLITZ_LODY_SESSIONS`; the exported symbol keeps its name | The box reads `BLITZ_LODY_SESSIONS`; one name across both halves beats two. See `packages/webapp/src/lody/flag.ts`. |

Two more things the plan did not cover, both measured:

- **A dispatch is a paid turn.** `session/dispatch-turn` launches the ACP adapter,
  so the phase-2 exit test splits: everything up to and including the CRDT write
  runs whenever a daemon is installed, and the dispatch runs only under
  `BLITZ_LODY_LIVE_TURN=1`. `npm test` therefore never spends a turn.
- **The assistant row appears before its content.** The daemon writes the
  assistant history entry with `items: []` and only `modelInfo` filled as soon as
  the adapter accepts the turn, then streams blocks into it. A test that waits
  for the ROW passes on an agent that connected and then said nothing; the exit
  test waits for non-empty `items`.
