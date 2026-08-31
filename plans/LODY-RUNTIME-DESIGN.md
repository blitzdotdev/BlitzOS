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

---

## 8. What phase 3 changed about this document (2026-08-30)

Phase 3 mounted `SessionSurface` for real against a `lody@0.88.1` daemon. What
follows is what the mount measured, in the same form §7 uses: what this document
said, what shipped, and why.

### 8.1 Risk 2, answered

The probe §6 asked for — "mount `SessionDetail` behind the §1.4 stack and
collect every 'must be used within' in one pass" — is
`packages/webapp/test/lody-session-surface.test.tsx`. It runs against the real
daemon rather than a fixture, because the page renders nothing without a
runtime.

**The session page demands exactly ONE provider beyond what phase 2 supplied.**

| Demand | Where | Resolution |
|---|---|---|
| `useAuthClient()` | `hooks/use-workspace-members.ts:26`, reached from `session-detail.tsx:1674`. No local-platform branch — the chat landing never calls it, the session page always does. | `packages/webapp/src/lody/inert-auth-client.ts` + their own `AuthProvider`, mounted in `BlitzPlatformProviders`. Four settled signed-out reads, nothing else; every other member is absent, so an upstream call site that appears at the next merge throws a TypeError naming it. |

Everything else §6 feared is NOT demanded by this mount:
`RecoverableConvexBetterAuthProvider`, `StableSessionProvider`, PostHog and
OneSignal are reached only from `__root.tsx` and `_auth.tsx`, and mounting the
two leaves directly skips all four. `usePostHog()` inside `RuntimeProvider`
(§1.4's open question) tolerates an absent `PostHogProvider`: the surface mounts
with no provider and logs nothing.

Three pieces of state those unmounted routes DO contribute, seeded in
`SessionSurface` instead:

- **`userAtom`** — `__root.tsx:157` fills it from the better-auth session. It
  must carry the DAEMON's `local:<uuid>`, because `buildVisibleMachineIndex`'s
  owner fallback (`lib/visible-machine-index.ts:64`) is the only thing that
  makes the box machine visible with no Convex row. With it, the composer's
  machine chip shows the box by name — which is **design-doc risk 3 answered
  from the UI end**, not just from the target router.
- **`localProbeResultAtom`** — Electron's CLI-state bridge fills it, and
  `localProbeEffectAtom` NULLS it outside Electron, after which
  `RuntimeProvider` calls `setLocalMachineId(null)` and the eleven components
  that read `localMachineIdAtom` (`session-chat-interface`, `session-detail`,
  `file-tree-view`, …) see no local machine. Seeded through a subscription
  rather than a write, because the ordering between their `atomEffect` and any
  `useEffect` of ours is not decidable in both mount orders.
- **the workspace-context atoms** — our `$workspaceName` route calls their own
  `useWorkspaceContextAtoms`, so the one-transaction rule §4.2 states is theirs
  to keep.

### 8.2 Nine more things the mount measured

| # | This document says | What shipped | Why |
|---|---|---|---|
| 1 | §1.4: `RuntimeProvider` sits in the stack, and §2/§3 build the runtime with `createLodyRuntime` | `RuntimeProvider` BUILDS the runtime; `createLodyRuntime` is now the headless equivalent the phase-2 test drives | `runtime-provider.tsx:255` calls `createWorkspaceRuntime` itself and owns the doc-meta subscription, the presence wiring and `runtimeInitializingAtom`. Setting `runtimeAtom` by hand would leave all three at their defaults and fork a coupled system. |
| 2 | — (not anticipated) | `VITE_PREVIEW_PUBLIC_BASE_DOMAIN` is REQUIRED | `lib/preview-public-config.ts:6` throws at MODULE LOAD without it, and `session-browser-panel.tsx` imports it. Set to `local.invalid` in `env.defaults`, which is their own Electron build's value (`electron.vite.config.ts:44`). |
| 3 | §2.1: every channel outside the allowlist rejects | Two channels are now accepted as NO-OPS: `app.setNativeTheme` (invoke) and `app.nativeTheme` (subscribe) | `theme-provider.tsx:155` calls the first on every theme change with no Electron guard at all, and the rejected promise is `void`-ed — design-doc risk 10, seen for real. Both ask the Electron MAIN process to repaint OS window chrome, which a browser does not have. With them accepted the unsupported-channel set is empty across a full mount, which is what makes asserting it meaningful. |
| 4 | §7.5 of the plan: "initialize their i18next with `en` only" | …and with `keySeparator: false` | `locales/en.json` is a FLAT map whose keys contain dots. Phase 0's init used i18next's default `keySeparator: '.'`, so every `t('sessions.stop')` missed and fell back to whatever inline default a call site carried — or to the raw key. The surface still rendered, which is why phase 0 did not notice. Their own init sets it (`i18n/index.tsx:121`). |
| 5 | §5.2: redeclare `--muted`/`--hover` "as a triplet from our palette" | Their own values are restored on the surface instead | Deriving `H S% L%` literals from our `color-mix(in oklab, …)` tokens forks the palette into a second, silently drifting copy, and §0's bias rule puts reskins in the theme layer — their VS Code theme engine, which compiles a theme to `--vscode-*` at runtime. A "Blitz" theme through that engine is phase 4+. |
| 6 | §5.2: "ours are unlayered, so ours win everywhere, inside the surface included" | True, and that is also the bug — including OUTSIDE the surface | Radix mounts dropdowns, selects, popovers, tooltips and dialogs as direct children of `document.body`, where a `.lody-surface`-scoped redeclaration cannot reach them and `bg-muted`/`bg-hover` lose their backgrounds. `lody-surface-shell.css` therefore carries a second selector, `body > :where(:not(#root, .files-context-backdrop, .files-context-menu))` — "a body child that is not ours". `lody-token-collisions.test.ts` pins the exclusion list against the classes our own portals render. |
| 7 | §5.1: the compensation sheet is "measured first, shipped if `@scope` does not hold" | Shipped, and pinned | `@scope` was not attempted: the portal problem above defeats it for the same reason it defeats the token scoping. `lody-tailwind-containment.test.ts` now asserts that every property phase 0 measured as leaking is declared in `lody-compensation.css`, per probe, with the probes re-mounted inside `.drive-shell` — where the product actually renders them. |
| 8 | — (not anticipated) | `ThemeProvider` writes `document.documentElement.style.colorScheme` | `theme-provider.tsx:149` sets it INLINE on the html element, which beats our `:root { color-scheme: dark }` from any stylesheet, so a surface that resolved `light` would repaint the whole shell's scrollbars and form controls. The phase-0 containment test cannot see this: it is a runtime DOM write, not a CSS rule. `adoptShellTheme()` writes their `next-themes` storage key from `appliedTheme()` on every mount, so their resolved theme is always ours. |
| 9 | — (not anticipated) | `react-resizable-panels` ships a DIFFERENT implementation to the SSR conditions | Its `edge-light`/`node` build contains no `useLayoutEffect` at all, so a consumer's layout effect runs before the group has a layout and `panel.collapse()` throws `Panel size not found`. `desktop-session-detail-layout.tsx:107` collapses its sidebar exactly that way, so under jsdom the entire session page failed to mount — for a reason that does not exist in a browser, and it cost a live turn to find. `vite.config.ts` aliases the package to its browser build for tests; `lody-resizable-panels.test.ts` guards the alias. |

### 8.3 The capabilities refresh: upstream's pass never runs for the box

§6 risk 6 asked "time `machine/acp-capabilities-refresh` against a cold daemon;
over ~3 s, make the bridge stream". **Measured: 2.0–3.0 s** across runs
(`lody-session-surface.test.tsx`). Under the trigger, so **the bridge keeps
answering `/session-control` as one body and no streaming bridge is built.**

But the timing was the smaller half of the risk. `createWorkspaceRuntime`'s own
startup pass (`:2413`) lists machines from `deps.getAuthorizedMachineIds()` —
the CONVEX-authorized set — and the box reaches the renderer through the owner
FALLBACK, which is deliberately excluded from that set. So upstream's pass lists
nothing and never runs, the machine Flock gets no `acpCapability` rows,
`buildAcpSelectorOptions` has nothing to build from, and the composer offers no
mode, model or effort at all. `refreshLodyAcpCapabilities`
(`packages/webapp/src/lody/agent-configs.ts`) runs THEIR
`runStartupAcpCapabilitiesRefresh` over our own four ports instead.

Two consequences recorded for later phases:

- `resyncMachineFlockRows(..., { requireRemoteSync: true })` — what their caller
  passes — always throws in `syncMode: 'local'`: "remote" there means the cloud
  plane, which this composition never opens. Ours passes `{}`.
- The **codex** config's refresh did not complete inside the test window
  (~25 s), while claude's took 2–3 s. Not diagnosed; it is a phase-5 item, and
  it costs the codex agent its selectors, nothing else.

### 8.4 Diff evidence needs no new door

`code-collab/*` is a machine-RPC method family
(`shared/src/local-machine-rpc.ts:54`), so `/lody/rpc` already carries all of
it — `open-turn-diff`, `open-current-diff`, `open-all-changes-diff`,
`get-file-index`. `session/cancel` rides the same door. Both are asserted to
round-trip in `lody-session-surface.test.tsx`, for free: a refusal that comes
back as a STRUCTURED response is the proof the plane routes the method.
**No fifth bridge door.**

`session/steer` is on the same union and needs no wiring either, but it is NOT
exercised: it takes an `expectedTurnId` and only means anything against a turn
that is already running, so it costs the same live turn the permission card
does. Whether the bundled claude adapter honours the `_meta.lody` steering
extension at all is therefore still unmeasured — the plan's §1 says the harness
contract carries it, and nothing here contradicts that or confirms it.

### 8.5 Twelve new npm dependencies

Mounting `SessionDetail` and `ChatLanding` for real pulls in what phase 0's
three leaves did not. Each arrives through a barrel or a lazy boundary inside
`@lody/components`, so none is a BlitzOS choice; all land in the lazy chunk.

`vaul` (their drawer), `framer-motion` (the desktop session layout),
`react-resizable-panels` (the same layout), `monaco-editor` (the session text
viewer), `frimousse` (the emoji picker), `@use-gesture/react` (mobile edge
swipe), `@meowdown/react` + `@prosekit/react` (the task body editor),
`three` + `@react-three/fiber` + `recharts` + `@number-flow/react` +
`@fontsource/bitcount-grid-double` (the settings usage screens, reached through
`components/settings/stats-setting`).

The last five are the clearest case of §5.1's barrel problem: nothing in the
chat loop wants a 3D usage calendar. Removing them needs a vendor edit, so they
stay, and phase 7's bundle sweep is where they get measured.

### 8.6 Exit test: what is proven, and what is not

Phase 3's exit test is `packages/webapp/test/lody-session-surface.test.tsx`. Six
assertions run free whenever a `lody` bundle is installed; one is gated behind
`BLITZ_LODY_LIVE_TURN=1` because it spends a turn.

**Proven, free:** the surface mounts against the real daemon; the data plane
connects; the box machine is offered by name; the composer arms on a keystroke;
the two agent configs reach the machine Flock and come back through the
run-configuration menu; the ACP adapter launches through `/usr/local/bin/claude`
and reports real models and modes; `session/cancel` and `code-collab/open-turn-diff`
round-trip; `SessionDetail` mounts with no provider missing; no `window.ipc`
channel is refused.

**Proven, live (two paid turns, the whole budget):** a prompt typed into the
real landing composer creates a session, dispatches it, and navigates the
surface to the session detail.

**NOT reached:** the permission-request card, the message queue and the Stop
button. Both live runs failed before them — the first on a stale assertion in
the test, the second on §8.2's `react-resizable-panels` trap, which stopped the
session page rendering at all. Both causes are fixed; the assertions are
written and stay in the file, gated, for the next run that has a turn to spend.

One finding stands in the way of the permission card even so, and phase 4 or 5
must deal with it: **`BUILTIN_DEFAULT_MODE_IDS.claude` is `'auto'`**
(`shared/src/ai.ts:402`), a mode whose classifier answers permission prompts on
the member's behalf. The card only appears when the classifier escalates, so the
exit test's prompt has to earn one. Selecting `default` ("Manual") from the
composer is the product answer, and the mode selector is exactly what §8.3's
capabilities pass makes possible — but driving that selector through a Radix
submenu in jsdom was not solved here.

A simulation was considered and rejected: the card is gated on
`liveSessionStatus`, which comes from PRESENCE
(`sessionLivePresenceAtomFamily`), and the daemon emits presence only for its
own origin. A second CRDT peer cannot fake it, so there is no free path to the
card.

---

## 9. What phase 4 changed about this document (2026-08-30)

Phase 4 made sessions first-class in the shell: `SessionRail`, Lody's own
sidebar body inside it, an address for a chat session, and the chat landing as
a fresh workspace's default. What follows is what that measured, in the form §7
and §8 use.

### 9.1 §4.3 and §4.4, answered

§4.3 said "deep links are a phase-4 decision; when they come they extend
`AppRoute` with `{ page: 'webApp'; sessionId }`". They came, and the shape is
one field wider than that guess, because there are THREE states and not two:

```ts
export type ChatAddress = null | 'landing' | { sessionId: string };
//   null       /workspaces/:id           the panes own the view
//   'landing'  /workspaces/:id/chat      the create surface, no session
//   {sessionId}/workspaces/:id/chat/:id  that session
```

A bare `/workspaces/:id` still means the panes, so no existing link moves.

**The URL is the ONLY place the selection persists, and that is the phase-4
decision blocker 5 asked for.** `webapp_state` keeps owning terminal tabs and
pane layout and learns nothing about chat sessions: the daemon's session list is
the source of truth for WHICH sessions exist, and that document is shared across
every member of a workspace — a stored id would point half of them at a session
archived on somebody else's box. What may persist is the active SELECTION, and
the address bar already persists every other selection this app has (the Drive
folder, the settings section) across a reload, a deep link and the back button,
with no server round trip and no cross-member leakage.

The two directions are wired so they cannot fight. The address drives the
surface (`CloudApp` effect → `api.openSession` / `api.openLanding`); the
surface's own navigations — the landing's send creates a session and goes to it
— mirror back (`router.subscribe('onResolved')` → `useLodyRail.mirror`). Both
compare before they act, so the pair converges instead of looping, and
`mirror` is a no-op while the panes own the view.

§4.4's other half shipped as written: a terminal row, a new tab, a preview and
an opened file all take the panes back, because `selectTtydSession` and
`addWorkspaceTab` are the two places that happens.

### 9.2 Six things the rail measured

| # | This document / the plan says | What shipped | Why |
|---|---|---|---|
| 1 | plan §8: Chats above GitHub Worktrees | GitHub Worktrees, then Chats, then Terminals | `LoroSidebar` renders `sessionListProps` before `afterSessionListContent`, and their own comment says why: "so Chats reads as the last section". Reordering means a second seam patch or rebuilding their scroll region. §0's bias rule settles it. |
| 2 | plan §8: three sections | Three HEADINGS, but an empty Lody section renders nothing at all | Upstream's rule (`loro-app-sidebar.tsx:2095`): a heading over no rows is a promise the sidebar cannot keep. Terminals is the exception because it is ours and its header carries the `+`. |
| 3 | §0.3: the vendored zone is `shell-newbar` + `shell-list` | `shell-newbar` is GONE in that shape, not filled | Their `home` nav entry IS the new-chat affordance — same action, same place — so it takes the label "New session" through `labels` and no native button is built. |
| 4 | §4.1: the surface is one mount | TWO mounts, one runtime | The rail is not a child of the provider stack, so the sidebar is `createPortal`-ed into `div.session-list--vendor`. A second stack around the rail would be a second runtime, WebSocket, IndexedDB repo and WASM instance. React context follows the RENDER tree, so the sidebar sits below `RuntimeProvider` and OUTSIDE the memory router — which is what makes `useResolvedWorkspaceScope` take its `currentWorkspaceIdAtom` branch there instead of the route-target one. |
| 5 | §5.2: the token block keys off `.lody-surface` | `.session-list--vendor` is named beside it | The portal is Lody DOM under `#root`, not under `.lody-surface`, so `--muted` and `--hover` would resolve to our finished colors and every hover background in the sidebar would vanish. |
| 6 | — (not anticipated) | `LoroSidebar` sizes its root with an INLINE width | Upstream it IS the window's resizable sidebar, sash included. The shell grid owns the rail's 252px, so `strip-rail.css` overrides the inline value — the one place an `!important` is the honest answer, because an inline style cannot be outranked any other way. |

### 9.3 The codex capabilities refresh: not slow, and not ours

§8.3 recorded that "the **codex** config's refresh did not complete inside the
test window (~25 s)" and deferred it. Measured against a cold daemon over the
real `/session-control` plane:

| Config | Runtime override | Cold daemon | Under a full `SessionSurface` mount |
|---|---|---|---|
| `blitz-claude` | `/usr/local/bin/claude` | 1.9 s | 2.1 s |
| `blitz-codex` | `/usr/local/bin/codex` | 0.8 s | 2.7 s |
| `blitz-codex` | `/opt/blitz/npm/bin/codex` (the vendor binary, not the shim) | 0.9 s | — |

**Codex is FASTER than claude, and nothing downloads.** The hypothesis in the
phase-4 brief — a managed-runtime download because `runtimeOverrides` lacks a
binary — is ruled out by construction and by measurement:
`apps/cli/src/agent/setting.ts:413` short-circuits `resolveManagedRuntimeForLaunch`
whenever `runtimeOverrides.codexPath` is set, spawns the bundled `codex-acp`
adapter with `CODEX_PATH` pointing at it, and `/usr/local/bin/codex` is the
box's PATH shim for `@openai/codex@0.147.0`. The shim and the vendor binary
measure the same, so the shim's `-c check_for_update_on_startup=false` costs
nothing either.

So the ~25 s was an artifact of WHERE it was measured: inside a jsdom mount that
was concurrently evaluating Monaco, three and mermaid and driving the composer,
on a four-core box. The same call measured 15 s in the full `npm test` run once
phase 4 added a second daemon-backed suite. Nothing is upstream's to fix and
nothing is ours to change; the plan's §6 risk 6 stays closed, and no streaming
bridge is built.

Two consequences for the suite:

- **The harness now takes a cross-file lock.** The local installation profile
  holds a host lease on 17789, so a second `lody start` on the same box never
  finishes provisioning its implicit workspace — it waits 60 s and the harness
  reports a timeout whose log says nothing. Vitest runs files in parallel, and
  phase 4 is the first change to need two daemon-backed suites.
- **The phase-3 refresh probe's 10 s bound became a 45 s hang detector.** The
  number was wall clock on a shared machine, which is exactly what the vendored
  `AGENTS.md` says a test must not depend on. The decision it served is settled
  by the clean numbers above.
- **The webapp suite now has a memory floor, and it is worth knowing before a
  sweep blames a change for it.** Three suites import the vendored renderer
  (phase 2's round trip, phase 3's surface, phase 4's rail), and a worker
  holding that graph — Monaco, three, mermaid, shiki, loro's WASM — plus a
  daemon runs to several hundred MB. On an 8 GiB box with ~1 GB free the OOM
  reaper takes the whole run with SIGKILL and code 137: no failing test, no
  stack, just `Killed`. With ~3 GB free it passes, repeatedly, at the default
  worker count. `--maxWorkers=2` halves the peak and, measured here, is not
  slower.
- **A SIGKILLed worker leaks a daemon**, and that daemon holds 17789, and the
  next run then fails to provision with an empty log. Nothing in-process can
  prevent it, so the harness names it in the timeout message
  (`ss -lntp | grep 17789`), registers an exit-time kill for every ordinary
  crash, and keys its lock's staleness on the owner PID being gone rather than
  on a timer.

### 9.4 The permission-mode selector: not a submenu

§8.6 recorded that "driving that selector through a Radix submenu in jsdom was
not solved here", and that it is what stands between the exit test and the
permission-request card (`BUILTIN_DEFAULT_MODE_IDS.claude` is `auto`, whose
classifier answers prompts on the member's behalf).

**It is not a submenu.** `DesktopPermissionModeButton`
(`components/sessions/desktop-run-config-menu.tsx:1014`) is a FLAT
`DropdownMenu` with its own trigger, `aria-label="Permission"`, deliberately
separate from the run-configuration menu — their comment at `:73` says
permission is "the knob users flip most". So it is driven exactly the way the
phase-3 test already drives the run-configuration trigger: `pointerdown`,
`mousedown`, `click`.

`packages/webapp/test/lody-permission-mode.test.tsx` opens it, finds Auto and
Manual, selects Manual and asserts the callback receives the mode ID `default`
— not the label. It runs at the component boundary, so it costs no daemon and
no turn. Its second case pins the other half of §8.3's finding: with no
`acpCapability` rows the control returns `null` and does not render at all, so a
test that looked for it would report "undrivable" when the real problem is that
upstream's capabilities pass never runs for a BlitzOS box.

The permission CARD is still unreached, and still needs a live turn whose mode
is `default`. Nothing structural is in the way any more.

### 9.5 Exit test: what is proven, and what is not

`packages/webapp/test/lody-session-rail.test.tsx` (daemon-gated),
`packages/webapp/test/session-rail.test.tsx`,
`packages/webapp/test/shell-mobile-drawer.test.tsx`,
`packages/webapp/test/lody-rail-defaults.test.tsx` and
`packages/webapp/test/lody-permission-mode.test.tsx` (all free, all gating every
merge).

**Proven, free:** the rail's two shapes and the renamed DOM path; the vendored
sidebar mounts into the portal host with no provider missing; their header and
footer are suppressed; "+ New session" opens the landing; the terminal rows are
byte-for-byte the old rail's and select their tab; the active-terminal highlight
follows `hidden`; a session the daemon already holds is listed under Chats and
its row opens the surface; the three chat addresses parse and round-trip; a
fresh workspace lands on the chat landing with the flag on and on the Claude tab
with it off; the mobile drawer opens, scrims and closes with the vendored zone
inside it; Manual is selectable.

**Proven, live (one turn, the whole phase-4 budget):** the rail's New session
opened the landing, the real composer sent, the daemon created the session and
the surface navigated to it.

**NOT reached:** nothing structural. The live case's remaining assertion — the
just-created session's row appearing in the rail — failed on the test's own
selector (`SessionList` renders a row as `div[role=button]` with
`data-sidebar-session-id`, and an anchor only when a `getSessionHref` is
supplied, which this rail does not supply). The selector is fixed and the same
assertion now passes for free against a seeded session, which is the same accept
unit the landing writes minus the paid dispatch.

---

## 10. What phase 5 changed about this document (2026-08-30)

Phase 5 made worktree sessions work: repos registered from the box, worktrees cut
off the `/workspace/<repo>` clones, archive with a backup commit, diff badges,
and the composer's whole control bar against a real registered clone. What
follows is what that measured, in the form §7, §8 and §9 use.

### 10.1 Three upstream couplings, all found by running the thing

None is in this document because none was foreseeable from reading. All three are
recorded in `vendor/lody/BLITZ-PATCHES.md` under "things upstream does not
support", and **none needed a vendor hunk**.

| # | What is broken | Where | What ships instead |
|---|---|---|---|
| 1 | **Archiving a local-project worktree resolves nothing and leaves the tree on disk.** `resolveWorktreeCleanupTarget` reads the project's `originalRootPath` out of `{...machineMeta.localProjects, ...getMachineFlockLocalProjects(machineFlockRows)}`. The DELETE caller passes `machineFlockRows`; the ARCHIVE caller does not. And `local-project/add` writes ONLY the Flock row. So on a box the archive path returns `null`, no backup commit is made, and the member's uncommitted work stays in a worktree nothing will ever clean up. | `apps/cli/src/lib/message-handler.ts:3971` vs `:4499`; shipped bundle `lody/dist/index.js:169066` vs `:169476` | `packages/webapp/src/lody/local-projects.ts` mirrors the Flock rows into the legacy `machineMeta.localProjects` field, which both paths still read. Run once per runtime beside the agent-config bootstrap. Upstream PR: pass `machineFlockRows` on the archive path; then delete the mirror. |
| 2 | **Every positional `localProjects.*` IPC helper omits `machineId`**, which every `local-project/*` request schema requires and which is `.strict()`. Upstream is right: in Electron the MAIN process is the machine. On a box the main process is the box and the browser is not, so `getGitState(workspaceId, localProjectId)` produced a request the daemon rejected at the boundary — and the landing's branch picker sat on "Checking whether this project is a git repository" forever. | `providers/workspace-machine-rpc-facade.ts:1006`, and the six helpers in `packages/webapp/src/lody/local-bridge.ts` | `local-bridge.ts` resolves the box's machineId from `/lody/platform` — the door `localPlatform.getSnapshot` already reads — caches it, and injects it into every positional helper. A failed read is not cached, so a call made before the daemon has written its catalog retries. |
| 3 | **A local project's repo name is dropped unless the CLOUD already knows the repo.** `resolveLocalProjectGithubRepoFullName` returns the daemon's own answer only if it also appears in `repositories`, the workspace's cloud-connected GitHub repo list. This composition has no cloud, so the list is empty, so a worktree session's `ProjectRef` never carries `githubRepoFullName` — and then the rail groups it under Chats instead of GitHub Worktrees AND turn post-processing skips `updateSessionDiffStats` entirely, because it is gated on `resolveProjectGitHubRepo(project)`. **This is what §6.4 is really asking for, and it is the one that costs a live turn to see**: the agent edits the worktree, the turn finalizes, and no diff stats are ever computed. | `components/chat/chat-landing.tsx:481`, gating `:3011`; the consequence at `session-execution-service.ts:2351` | `publishBoxReposAsWorkspaceRepos` (`packages/webapp/src/lody/local-projects.ts`) writes the box's own clones into `setWorkspaceReposCacheAtom`, which is the other half of `freshRepositories ?? cachedRepositories`. Each name is the daemon's answer to `local-project/git-state`, so nothing is invented: a clone with no GitHub remote contributes nothing and its sessions stay in Chats. |

Defect 2 had been latent since phase 2: nothing before phase 5 called a
positional helper, because `localProjects.control` carries `machineId` in the
request body and that is the door the earlier phases used.

### 10.2 §6.4 was right about the field and wrong about who sets it

The plan says "`ProjectRef.githubRepoFullName` is set so the sidebar groups
these under GitHub Worktrees", next to "registration happens daemon-side". Read
together that suggests `local-project/add` carries the repo name. It cannot:
`LocalProjectAddRequestSchema` is `.strict()` and has only `machineId`,
`rootPath`, `workspace?`, `allWorkspaces?`. What actually happens is a division
of labour, measured against a real daemon:

- The DAEMON derives the repo name from the clone's own remote
  (`probeGitHubRemoteAtRootPath`, `shared/src/node/local-project.ts:558`;
  `origin` first, push URL before fetch URL) and reports it on
  `local-project/git-state`. `/workspace/BlitzOS` → `blitzdotdev/BlitzOS`, for
  both an HTTPS and an SSH remote.
- The BROWSER copies it onto the session's `ProjectRef` when the session is
  created. That copy is what three separate daemon paths then read: the sidebar
  grouping (`resolveProjectGitHubRepo`, `shared/src/project.ts:152`), the
  removal preflight, and — the one that would be missed — the per-turn diff
  stats, which upstream gates on `resolveProjectGitHubRepo(project)` being
  truthy (`session-execution-service.ts:2351`). A worktree session whose
  `ProjectRef` lacks the field gets **no diff stats at all**.

So `startLodySession` gained an optional `project`, written into the ACCEPT UNIT
rather than patched in afterwards — and the browser's copy is conditional on a
cloud repo list a box does not have, which is defect 3 above.

### 10.3 The forced worktree pill is not forced here

§0's reference bar says "branch picker + forced worktree pill". `checked
disabled` is exactly what the landing renders — for the **`github`** context
(`chat-landing.tsx:3412`), which is the bare-mirror source §0.5 does not use. In
the **`local`** context, which is what a BlitzOS worktree session is, the pill is
a real toggle whose default comes from `readWorkdirModePreference`, and its
unticked state means the agent runs **in the `/workspace/<repo>` clone itself**.

Phase 5 does not change that: forcing it would be a vendor edit, and §0's bias
rule says theirs wins. It is recorded here because it is a product decision
somebody has to take, and the safe default is not the one that ships.

### 10.4 Attachments: a blocker, with the seam written out

§0.7 asks for the one adaptation in the plan — their cloud-upload fallback
replaced by a browser→box route over WebDAV. **There is no port to implement it
behind.** Searched: `PlatformProvider`/`PlatformContext` expose `identity`,
`workspaces`, `capabilities`, `cloudApi`, `sync` and no upload member;
`cloud-api-operations.ts` has no upload descriptor; `CloudAttachmentUploadPort`
(`packages/platform/src/cloud-port.ts:216`) is the CLI-side seam, carries only a
base URL, and `local.ts:120` sets it to `null`; `GitHubTokenPort` is the one
installable port of that style and covers tokens only.

What exists is a branch, and it is gated on the one global BlitzOS must never
set:

```ts
// lib/electron-session-file-sender.ts:19
export const canUseElectronLocalFileSend = (): boolean =>
  isElectronRenderer() && Boolean(getIpcServices());
```

With it false, `useChatLandingFileDraft` (`:157`) falls through to
`uploadSessionFile`, whose every URL is built from `API_BASE_URL` — Lody cloud,
which this composition has no account for.

**The seam proposal, not applied.** One hunk, same shape and same idea as seam
patch 1, in a third file:

```diff
 export const canUseElectronLocalFileSend = (): boolean =>
-  isElectronRenderer() && Boolean(getIpcServices());
+  (isElectronRenderer() || window.__LODY_LOCAL_BRIDGE__ === true) && Boolean(getIpcServices());
```

Behind it, `local-bridge.ts` gains one channel,
`localProjects.sendSessionFileLocal`, which PUTs the bytes to the box over the
existing dufs surface (`BoxEndpoints.filesBase`, `/workspaces/:id/webapp/7445/workspace/…`,
the same route `file-drop.ts` uses) and returns the `SessionInputBlock` array
`session-file-upload.ts:253` parses, with `transport: 'local'`. One extra
decision it forces: dufs serves `/workspace`, and a session's workdir is a
worktree under `/var/lib/blitz/lody` — so either the attachment lands at
`/workspace/.blitz-attachments/<sessionId>/<name>` and the agent is handed an
absolute path, or `webapp-surface.ts` grows a second prefix and the gateway with
it. The first needs no new box path and is the one to take.

It is NOT applied because the brief's rule is zero new hunks and a recorded
blocker instead. The `+` menu, its picker and the image/file split all render and
work; only the far end of the upload is missing.

**Phase 6 applied it** (§11.1), with one correction to the sketch above: the
daemon does not read the staged file as the agent's attachment, it COPIES it into
its own blob store during `session/file-send-local` and answers with the
`transport: 'local'` blocks the composer attaches to the message. So the staging
directory is a hand-off and the files are deleted again as soon as the call
returns — which is also what Electron does with its temp directory.

### 10.5 The composer parity table

The §0 acceptance artifact. Driven by
`packages/webapp/test/lody-worktree-composer.test.tsx` against a real
`lody@0.88.1` daemon holding a real registered clone with two branches, on the
real landing, in `local` (worktree) context.

| Control | Verdict | Evidence |
|---|---|---|
| machine chip | **PASS** | `DesktopMachineMenu` renders and names the box (`blitzos-dev`). Phase 3 proved it on the session page; this is the landing's own call site. |
| repo picker | **PASS** | The registered clone appears in `UnifiedProjectSelectorView` and selecting it puts the landing in `local` context. The options come from `MachineMeta.localProjects`, which for a box arrives only through `mergeMachineFlockMachineMeta` — so this also proves the Flock overlay reaches the landing. |
| branch picker | **PASS** | Renders on the base branch (`main`) once the worktree pill is ticked, and lists every branch the clone has (`main`, `release`). It is the whole `local-project/git-state` round trip through our bridge, and it failed until §10.1 defect 2 was fixed. |
| worktree pill | **PASS, but not forced** | Renders, is enabled once the git state lands, and toggles. See §10.3: `checked disabled` is the `github` context only. |
| `/` commands | **PASS** | The palette opens with the adapter's own `availableCommands` — `/usage`, `/insights`, `/recap`, `/security-review` and more, over 5 entries. Also the proof that OUR capabilities pass ran, since upstream's never does for a box (§8.3). |
| `@` mentions | **PASS** | The category menu opens (Files / Skills / Commands) and Files lists `README.md` and `index.ts` from the registered clone, over `local-project/list-files`. |
| `$` skills | **PASS (clean empty state)** | The palette opens against a clone with no `.claude/skills`; `local-project/list-skills` answers empty, which §0's bar accepts. No `cli_not_running`. |
| `+` attachments | **PARTIAL** | The menu, the hidden file input and the image/file split all render and work. The upload has no route to the box — §10.4, recorded blocker. |
| model · effort | **PASS** | The run-configuration menu renders the models and effort levels the capabilities refresh reported. |
| permission mode | **PASS** | `DesktopPermissionModeButton` opens and Manual (`default`) is selectable — the mode the permission card needs. Phase 4 pinned the control; phase 5 drives it on the landing and then spends the turn behind it. |

One jsdom-only ordering note, recorded so the next reader does not read it as a
product fault: the three mention palettes must be exercised `@`, `$`, `/` in that
order. With `/` first the palette stays closed for 30 s; third, the same
assertion passes in the same mount. In a browser the layer is warmed by the
pointer that lands in the composer, and jsdom has no such pointer.

### 10.6 The free path to a worktree, and what it saved

A worktree session is normally born from a dispatch, which is a paid turn. It
need not be: the daemon cuts the worktree in `createSessionInner`
(`session-manager.ts:1932`), which runs BEFORE `session.createAgent` (`:1404`).
So a `session/create` whose `runtimeOverrides.claudeCodeExecutable` points at
`/bin/false` creates the branch, the worktree and the session document, then
fails to launch an agent — and the whole lifecycle (branch name, worktree path,
clone untouched, dirty preflight, archive-with-backup) is assertable for nothing.
`packages/webapp/test/lody-worktree-session.test.ts` is that test.

Two things it measured that are not obvious:

- **The session document has to exist first.** `session/create` passes
  `assumeDocExisting: true`, so a control-socket create with no prior CRDT write
  leaves a session with no `machineId` — and `local-project/removal-preflight`
  filters on exactly that (`local-project-removal.ts:23`), so the session is
  invisible to it. The test therefore writes the accept unit with
  `startLodySession` first, which is also the product order.
- **`local-project/add` is idempotent on `rootPath`** — the same path returns the
  same `localProjectId` — which is what makes re-registration on every reboot
  safe. That is the daemon's property, captured in
  `fixtures/lody-project-registration/response/add-repeat.json`, and the box
  registrar's list-and-diff pass is an optimization on top of it rather than the
  safety.

### 10.7 The box registrar, and why it reads `/workspace`

`packages/box/rootfs/usr/local/libexec/blitz-lody-projects`, an s6 longrun
following `lody-daemon`, registers every git repository directly under
`/workspace` every 30 s.

§6.4 says to "drive it from box bootstrap using the `workspace_repos` list". It
does not, for two measured reasons. The template-repo cloner in
`core/bootstrap.ts` is a DETACHED best-effort retry loop that runs for up to ten
minutes after boot, so a one-shot handed the list at boot would register
directories that do not exist yet; and that file's emitted bytes are a pinned
contract, so growing them would cost a fixture change on every deployment path.
Inside the box, "the directories under `/workspace` that are git repositories" IS
that list, plus every repo the member cloned by hand — which is the same thing as
far as worktrees are concerned, and strictly more useful.

Its payloads are a cross-runtime contract with two BlitzOS producers (the
registrar and the browser bridge), so they have a fixture corpus captured from a
real daemon and conformance tests on both sides —
`packages/schema/fixtures/lody-project-registration/`, the row added to
CLAUDE.md's table.

### 10.8 The harness leaks a daemon, and now the run reaps it

§9.3 recorded that "a SIGKILLed worker leaks a daemon, and that daemon holds
17789, and the next run then fails to provision with an empty log. Nothing
in-process can prevent it." Phase 5 closes it from OUTSIDE the process:
`packages/webapp/test/lody-daemon-reaper.ts` is a Vitest `globalSetup` that runs
once before any worker and kills anything running
`<tmpdir>/lp-*/lody/dist/index.js` — the one path shape the harness ever spawns.

Deliberately narrow. A daemon at `/opt/blitz/npm/...` is the box's own or a
developer's own `lody start`, and killing it would be hostile; the harness's
existing timeout message already names that case with the command to find it.
Measured while writing this phase: an agent's own probe daemon under `/tmp/lp7`
wedged all four daemon-backed suites, the reaper correctly left it alone, and the
harness's message is what identified it.

### 10.9 Exit test: what is proven, and what is not

`packages/webapp/test/lody-worktree-session.test.ts` (daemon-gated, six free
cases), `packages/webapp/test/lody-worktree-composer.test.tsx` (daemon-gated, six
free cases plus one gated live turn),
`packages/box/guest-tests/test/lody-projects-registration.test.ts` and
`packages/webapp/test/lody-project-control-frames.test.ts` (both free, both
gating every merge).

**Proven, free:** the registrar registers every `/workspace` clone, once, and
skips what is not a repository; the daemon reports the clone's GitHub remote, its
branches and its working tree; no worktree setup script is configured and its
absence costs nothing; a worktree session runs on `lody/<id12>` under
`<dataDir>/repos/<repoId>/worktrees/<sessionId>` with the clone's HEAD, branch
and index untouched; a dirty worktree is reported dirty and survives a project
removal; archive commits `chore: archive backup for session <id8>` as
`Lody Archive <archive@lody.ai>`, keeps the branch and removes the tree; and
every composer control in §10.5 except `+`.

**Proven, live (three paid turns, and the third carried three exit tests at
once):** with the mode set to Manual from the landing's own permission selector,
a worktree session's agent asked for permission, the card rendered and was
answered, the agent's file landed in the worktree under
`<dataDir>/repos/…/worktrees/<sessionId>` while `/workspace/<repo>` stayed clean
on `main`, and the rail row grew its line-change badge. Eleven seconds from send
to badge.

The three turns were not three attempts at the same thing; each bought a finding
the free path could not reach.

| Turn | What it bought |
|---|---|
| 1 | The permission card and the worktree edit, both first time. It also showed that **the agent renames the branch**: the reflog reads `Branch: renamed refs/heads/lody/bced8554-c14 to refs/heads/feat/agent-wrote-thismd`, because the box's OWN agent rules (`/opt/blitz/skel/agent-rules.md`, installed by `blitz-init-state` as `~/.claude/CLAUDE.md`) tell it to work on a new branch, so it renames the one it is standing in. Nothing downstream cares — the worktree, the diff stats and the archive all key off the session id and the path — but an assertion that pins the branch name AFTER a turn is asserting the agent's manners, so that assertion lives in the free test. No diff badge. |
| 2 | Ruled out the test's own stale DOM node, and left the daemon log that named the real cause: the session's `configForLog` said `githubRepo: undefined`, so `updateSessionDiffStats` was never reached. That is §10.1 defect 3, and nothing short of a live turn surfaces it — every free path writes the `ProjectRef` itself and so cannot notice that the LANDING drops the field. |
| 3 | The fix, confirmed: `githubRepo: 'blitzdotdev/wt-composer'` at create, diff stats at finalization, badge on the row. |

**NOT reached:** nothing structural in the worktree path. `+` attachments were
the one §0 control that did not work, for the reason and with the seam in §10.4;
phase 6 slice 0 applied that seam and §11.1 records what it measured.

---

## 11. What phase 6 changed about this document (2026-08-30)

Phase 6 is opt-in per-session sharing (`LODY-SESSIONS.md` §0.1). Its design lives
in `plans/LODY-SHARING.md`; what belongs here is what the work measured about the
runtime, in the form §7–§10 use.

### 11.1 Attachments: §10.4's seam, applied, and one thing it had wrong

Seam patch 3 (`vendor/lody/BLITZ-PATCHES.md`) is the predicate §10.4 wrote out,
unchanged. The BlitzOS half behind it is
`packages/webapp/src/lody/session-attachments.ts` plus one channel in
`local-bridge.ts`, and §10.4's own sentence about where the bytes go is the part
that needed correcting.

§10.4 offered two placements — "either the attachment lands at
`/workspace/.blitz-attachments/<sessionId>/<name>` and the agent is handed an
absolute path, or `webapp-surface.ts` grows a second prefix" — and took the
first. The first is right, but not for the reason given: **the agent is never
handed a path at all.** `session/file-send-local` copies each file into the
daemon's own blob store and answers with `transport: 'local'`
`SessionFilePayload` blocks (`apps/cli/src/lib/message-handler.ts:7530`), which
the composer attaches to the outgoing message exactly like a cloud upload. So the
staging directory is a HAND-OFF, and the files are deleted as soon as the control
call returns — the same lifecycle Electron gives its temp directory
(`apps/electron/src/main/ipc/services/local-projects-ipc.ts:79`).

That is also why no new box path was needed and why the choice between the two
placements was never close: whatever directory the bytes pass through, they do
not stay there.

Four smaller things the channel measured:

| # | What | Why it matters |
|---|---|---|
| 1 | **dufs does not create missing intermediates**, so the channel issues `MKCOL .blitz-attachments/`, `MKCOL .blitz-attachments/<sessionId>/`, then `PUT`. 405 is success. | `core/files/sync.ts:75` already records this for the control plane's own uploads; getting it wrong shows up as a 409 on the PUT, far from the cause. |
| 2 | **The daemon answers `session_not_found` until the session's CRDT write reaches it.** `startLodySession` is a LOCAL durable write; the daemon reads `getDocMeta(getSessionRoomId(sessionId))` and refuses until the data plane has carried it. | The exit test polls the real call rather than sleeping: there is no cheaper probe for "the daemon has this session" than asking it. In the product the composer only offers `+` on a session it is already looking at, so the window does not exist. |
| 3 | **`LodyIpcArgument` is no longer `JsonValue`.** The attachment payload carries an `ArrayBuffer`, which no JSON type can express. | `packages/webapp/src/lody/ipc-arguments.ts` holds the three guards that narrow an argument by CHECKING it, so the widening cost no assertion at any of the ten positional-helper call sites. |
| 4 | **The staged name is Electron's, character for character** (`<index>-<basename>`, control characters to `_`, 255 bytes). | The daemon reports the basename back as the block's file name, so a different rule would show a different name in the transcript on a box than on the desktop. |

Exit evidence: `packages/webapp/test/lody-attachments.test.ts` — six free cases
over the WebDAV half, plus one daemon-backed case that drives the whole channel
and asserts the `transport: 'local'` block and the emptied staging directory.

### 11.2 The worktree pill's default, seeded

§10.3 recorded that the pill is a real toggle in the `local` context and that
`readWorkdirModePreference` defaults it to `'local'` — the mode that edits the
`/workspace/<repo>` clone in place. §0.5 ruled that BlitzOS defaults it ON
through their own preference store rather than through a vendor edit, and
`packages/webapp/src/lody/workdir-default.ts` is that: one write of their GLOBAL
key, only when it is absent.

The choice of key is the whole design. Upstream READS
`lody.workdirMode.global` and never writes it (`lib/workdir-mode-preferences.ts`
writes the per-project key only), so seeding the global one changes the default
without competing with anything: their per-project write still wins, so unticking
the pill for a repo persists, and a member who sets the global key by hand is
never overwritten.

### 11.3 The harness lock's deadline

§9.3 introduced a cross-file lock because the daemon's installation profile holds
a host lease on 17789. Its wait bound was 300 s, chosen when there were two
daemon-backed suites. The lock SERIALIZES them, so the bound has to outlast all
the others put together — and at five suites, each spending most of a minute on
provisioning before it asserts anything, 300 s is the same order as the work it
is supposed to survive. It is now 900 s, named `HARNESS_LOCK_WAIT_MS` with the
arithmetic beside it. Staleness is still the owner PID being gone, so a crashed
holder is still reaped on the next poll and this timer only bounds honest waiting.

### 11.4 The share affordance needed no vendor hunk

The phase brief allowed one: "investigate Lody's row context-menu extension
point; if a vendor hunk is unavoidable make it a minimal upstreamable 'extra menu
items' prop". It is avoidable, and the reason is worth recording because the
answer was not where the brief expected it.

`SessionList` has no host extension point for its row menu — the items are a
fixed list. But one of those fixed items is already a SHARE entry
(`components/session-list.tsx:1134`), drawn whenever the row carries a
`sharing` state and the list carries `onShareSessionWithTeam`
(`:820`, `:891`). Upstream fills `sharing` from a cloud visibility flip;
`SessionListRow` is a plain data type with no provenance check and BlitzOS
builds its own rows (`SessionRailSidebar.tsx`), so filling it from §0.1's rule —
a session is private until granted — is a field, not a patch. The "⋯" button
opens that same menu by synthesizing a `contextmenu` event
(`sidebar-row-shared.tsx:507`), so both affordances arrive together.

So the vendor divergence after phase 6 is what it was after phase 5 plus seam
patch 3's single predicate, and `vendor/lody/BLITZ-PATCHES.md`'s expected file
count moves from four to five for the attachment hunk alone.

### 11.5 Exit test: what is proven, and what is not

Phase 6's evidence is listed where its design lives: `plans/LODY-SHARING.md`
§9.1. In this document's own terms, three things are worth carrying forward:

- **The relay is only a relay for the member who owns the box.** A connection
  with no share claim keeps the phase-1 dumb-pipe path, so §2's framing contract
  is unchanged for every existing caller, and the parsing the ACL needs is paid
  for by the share alone.
- **A grantee's MOUNTED surface is not phase 6.** The vendored renderer's local
  plane is a singleton on `window.ipc` with a once-only transport guard and a
  two-valued plane enum (`LODY-SHARING.md` §6.1), so a second local machine costs
  four changes inside `vendor/`. The relay, the claim and the routes ship and are
  proven with a protocol-v7 peer instead; §8 of that document scopes the rest.
- **The permission answer is a CRDT write and nothing else** — no door, no
  method, no BlitzOS code. §8.6 recorded that the permission card is gated on
  presence and that a second CRDT peer cannot fake it; phase 6 adds the other
  half of that finding, which is that a second peer does not need to: answering
  is `permissionRequest.outcome = …` on the session document
  (`apps/cli/src/lib/message-handler.ts:8336` states the whole loop), and
  first-response-wins is the daemon's own `resolved` guard at `:8541`.

---

## 12. What the first canary dogfood found (2026-08-30)

One screenshot, on a brand-new box from the new image: the whole Lody surface
renders, the member's first prompt dispatches, the reply is **"Authentication
required"**, and the Retry button under it answers **"Workspace context is
missing, please retry."**

Three independent defects sat behind it. Each is written out below with what
this document said, what the code actually did, and what shipped. Two of them
were invisible to every existing test, and §12.4 says why.

### 12.1 The Retry error: `currentWorkspaceIdAtom` was never seeded

`packages/webapp/src/lody/router.tsx` called the vendored
`useWorkspaceContextAtoms(slug, undefined)`. That hook publishes
`{ slug, workspaceId: null }` in a layout effect and fills the id in from its
SECOND argument alone (`hooks/use-workspace-context-atoms.ts:34`, gated on
`access?.status === 'member' && access.organizationId`). With `undefined` there,
`currentWorkspaceIdAtom` stayed `null` for the entire life of the surface.

Nothing announced it, because the id is not what the surface is keyed on:

- `activeWorkspaceRuntimeAtom` resolves from the SLUG when a slug is present
  (`atoms/runtime.ts:485`), so the runtime still answered `ready`.
- `RuntimeProvider` on the local platform takes `effectiveWorkspaceId` from
  `useImplicitLocalWorkspace()`, not from the atom (`runtime-provider.tsx:129`),
  so the runtime was built with the right id anyway.
- `resolveWorkspaceDataScope` skips its id check entirely when
  `organizationsReady` is false (`lib/workspace-data-scope.ts:32`), and
  `organizationsReady` IS `currentWorkspaceId !== null` — so a null id disabled
  the very check that would have caught it.

What broke were the consumers that read the id directly. Twelve of them exist;
`useMachineAcpAuthentication` is the one a member met, and both of its entry
points refuse with `chat.validation.missingContext` — "Missing workspace
context" — when `workspaceId == null` (`:82`, `:160`).

**Shipped:** `createLodySessionRouter` takes a `workspaceId`, and the
`$workspaceName` route passes `{ status: 'member', organizationId: workspaceId }`
as the hook's own `access` argument. Zero vendor edits: this is the input the
hook is written to take, and it is the daemon's own `lw_<uuid>` out of the same
`/lody/platform` catalog `RuntimeProvider` reads, so the scope check now agrees
rather than flipping every scoped consumer to `switching`.

### 12.2 The `auth_required` itself: the row was local, not on the daemon

§3.5 was right that `runtimeOverrides` rides an agent-config row and that the
row is what points the adapter at `/usr/local/bin/claude`. What it did not say
is when the daemon can SEE that row.

`WorkspaceWriter`'s accept boundary is the local CRDT write, not remote sync
(`providers/workspace-writer.ts:52`). Phase 3's bootstrap awaited
`syncOnce()` BEFORE its writes and nothing after them, then published the rows
into the jotai cache — so the composer's picker was populated while the daemon
still had nothing. A prompt sent in that window creates a session whose
`agentConfigId` names a row the daemon cannot resolve, and the daemon's launch
resolver FAILS OPEN rather than refusing:
`session-launch-config-resolver.ts:57` returns `source: 'none'` with no
`runtimeOverrides`, `env` or `customAcp`. `resolveBuiltinACPProcessLaunch`
(`apps/cli/src/agent/setting.ts:442`) then takes its managed-runtime branch,
launches a claude binary nothing in the daemon's environment carries a token
for, and the adapter answers ACP `-32000` → `acp_auth_required`.

Two things the phase-2/3 record had wrong, both measured against a real
`lody@0.88.1` on 2026-08-30:

| Recorded | Measured |
|---|---|
| §3.5: "the s6 service environment carries `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR`, so the adapter sees what the TUI sees" | It carries NEITHER. `packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/run` sets `HOME`, `USER`, `LANG`, `LC_ALL`, `PATH`, `LODY_PLATFORM`, `LODY_DATA_DIR`, `LODY_MCP_HTTP_DISABLED` and nothing else. The override row is the ONLY thing that puts a credential on the agent's path, which is what makes this race fatal rather than cosmetic. |
| (not anticipated) The daemon might register competing override-less builtin configs of its own | It does not, on the local platform. `ensureBuiltinAgentConfigs` (`apps/cli/src/lib/lody.ts:210`) exists and would write rows with no `runtimeOverrides`, but a fresh daemon left the machine Flock with only `dotlodyPath` after 20 s. Ours are the only agent-config rows on a box. |

**Shipped, and why it is not the box-side seeding the brief asked for first.**
A box-side seeder was rejected on evidence, not preference: the row lives in the
machine Flock CRDT, so a box script would need a Loro client and Lody's Flock
encoding; and the vendor CLI cannot write the row we need — `lody agent-config
create` has no `--runtime-override` and no `--id`
(`apps/cli/src/commands/agent-config.ts:623`), so it can only create a config
that is missing the one field the whole mechanism turns on. That is the "not
feasible without vendor/npm patching" branch, so the documented fallback ships:

- `bootstrapLodyAgentConfigs` now calls `syncOnce()` a SECOND time, after the
  writes, so it resolves with the rows on the daemon.
- `LodyAgentConfigGate` (`packages/webapp/src/lody/agent-config-gate.tsx`, moved
  out of `SessionSurface.tsx` so a race can be tested without Monaco) renders the
  chat surface only once that resolves. The rail is NOT gated, so the surface is
  never blank, and the gate opens on failure too — trapping a member behind a
  spinner would be a worse failure than the one being prevented.

**The gate needed a third change, and it is the interesting one.** Holding the
router back deadlocked the whole surface on the first attempt, and the cycle is
worth stating because nothing in this document made it visible: the gate waits
for the runtime; `RuntimeProvider` creates no runtime while
`currentWorkspaceSlugAtom` is null (`runtime-provider.tsx:190`); and phase 3's
ONLY writer of that atom was the vendored `$workspaceName` route — which is
behind the gate. Measured as a 60 s timeout on "the data plane to report
connected" in the phase-3 exit test, with the gate's own log showing the runtime
subscription firing exactly once, with `null`.

So `seedWorkspaceContext` in `SessionSurface.tsx` now publishes the slug and id
ABOVE the router, which is what `mountLodyRuntimeAtoms` has always done for the
headless path. It states the dependency where it belongs — the surface knows its
workspace before it has an address — and the route's own write stays, agreeing
rather than competing. The id is repaired through `currentWorkspaceIdAtom` alone
(whose setter spreads the current context and cannot clear the slug) whenever the
hook's layout effect blanks it, and the repair is inert once the slug is not
ours, so a route unmount still clears.

The composer's own behaviour in the same window is worth recording, because it
is what a reader would otherwise assume: with NO rows at all a send does not
dispatch unconfigured, it refuses with "Choose an agent before starting"
(`chat-landing.tsx:2922`) — the send button carries no agent-config term
(`getChatLandingSubmitDisabled`) and the Enter path does not consult it at all.
So the *absent-row* half of the race is a confusing error, and the
*written-but-unsynced* half is the `auth_required` the screenshot shows.

### 12.3 The product path: a box with no Claude connection

Even with §12.1 and §12.2 fixed, a box whose workspace has no Claude connection
has nothing to sign in with. `/usr/local/bin/claude` mints per process start
through `blitz-cred-claude`, that minter exits non-zero and prints nothing when
the workspace is not connected, and the shim is silent by design — so the agent
simply runs signed out.

Lody's own Retry is the wrong answer here and cannot be made right: it asks the
daemon to run `claude auth login --claudeai`
(`apps/cli/src/agent/setting.ts:505`), an interactive CLI login on a machine
nobody is sitting at. §12.1 stops it lying about the reason; it does not make it
the product path.

**Shipped:** `packages/webapp/src/lody/agent-auth-notice.tsx`, a NATIVE banner
layered above the vendor notice with zero vendor edits. It watches the open
session document for the last `chat_failed` notice — the signal is a durable
history item (`apps/cli/src/lib/message-handler.ts:1687`), not an atom, so there
is nothing to subscribe to and it is polled every 2 s — and when the reason is
`acp_auth_required` it names the credential the box actually uses and offers
`onOpenConnections('claude')`, wired in `CloudApp` to the same panel-focus
`blitz connections open <provider>` raises from inside the box.

**No restart is needed after connecting.** The shim mints on every process
start, and every turn starts a new adapter process, so the next prompt picks the
token up. That is a property of the shim, not of the banner.

### 12.4 Why no test caught any of this

Both daemon-backed exit suites skip without a 21 MB `lody` bundle, which is CI,
and the paid-turn assertions skip again without `BLITZ_LODY_LIVE_TURN=1`. So the
merge gate never ran a single line of the surface's runtime behaviour.

`packages/webapp/test/lody-agent-signin.test.tsx` is the answer, and it is
deliberately daemon-free: a stub runtime over our own seam, so all eighteen
assertions gate a merge. It pins the workspace-id seeding AND its absence, the
sync-after-write ordering AND that a failed push still resolves, the gate's
closed and open states, and the banner's truth table.

One more measurement it forced, in `lody-daemon-harness.ts`:
`claudeCredentialAvailable()` read `~/.claude/.credentials.json` only. A box has
no such file — its credential is minted — so the helper answered `false` on
exactly the machine the product runs on, and the phase-2 exit test's
"the daemon accepted the dispatch" early return was being taken for the wrong
reason. It now also asks `blitz-cred-claude` by EXIT STATUS, with
`stdio: 'ignore'`, so the token never enters the test process.

## 13. What the second canary dogfood found (2026-08-31)

The report: clicking "Sign in with Claude" opens a popup that says
"Preparing Claude sign-in…" and never becomes anything else.

Three defects sat behind it, and §12.3's banner turned out to be a fourth.

### 13.1 The break point: async progress had no carrier

`AcpAuthenticationPanel.handleStart`
(`components/settings/acp-authentication-panel.tsx:113`) opens a placeholder
window immediately and navigates it only when `startAuthentication`'s
`onProgress` delivers `{status:'authorization', authorizationUrl}`. That frame
is a `machine/acp-authentication-progress` RESPONSE, and the daemon emits it
while the login process is still running — it is a NOTIFICATION on a request
that has not finished, not a reply.

The daemon serves `/session-control` two ways and picks by `Accept`
(`apps/cli/src/lib/local-session-control.ts:33`):

| `Accept` | Answer |
|---|---|
| `application/x-ndjson` | one `{"kind":"response"}` frame per response, as the flow produces it, then `{"kind":"complete"}` |
| anything else | one `{ok, responses:[…]}` envelope, written when the whole request has finished |

Neither of our two hops asked for the stream. `postLodyPlane`
(`webapp/src/lody/rpc-client.ts`) sent `content-type` and the local-control
header and no `Accept`, and read the body with `await response.text()`;
`blitz-lody-bridge`'s `forward()` then replaced the browser's headers with a
fixed `CONTROL_HEADERS` that had none either. So every call took the buffered
path, and the URL could not arrive until the process waiting for the member had
exited. Measured against a real `lody@0.88.1`: with the negotiation, the
`authorization` frame lands **40 ms** after the POST opens; without it, not at
all until the 285 s login timeout.

Everything else in the chain was already correct and needed no change: the Go
gateway proxies `/lody/control` with `FlushInterval: -1` (`gateway/main.go:1020`),
the bridge's `forward()` already pipes `upstreamResponse.pipe(response)`, and the
vendored runtime already de-duplicates a streamed response against the final
array (`create-workspace-runtime.ts:2109`). The gap was one header on two hops.

**Shipped.** `sendSessionControl` negotiates the stream, reads `response.body`
frame by frame and calls its per-response `emit` as each lands — the order
`sendLocalSessionControl` (`lib/electron-ipc-client.ts:66`) is written for, since
it unsubscribes in its `finally`. The buffered envelope is still parsed when the
daemon answers one, so a box whose bridge predates this degrades instead of
failing. `blitz-lody-bridge` carries the negotiation as a DECISION, not a relay:
it inspects the inbound `Accept` and sends the one constant or nothing, so no
caller-chosen bytes reach the daemon's control socket.

The per-request deadline moved with it. `postLodyPlane`'s flat 120 s cut a 285 s
login in half, so `sessionControlTimeoutMs` now mirrors Lody's own per-type table
(`apps/electron/src/main/services/cli-service.ts:74`): 300 s for
`machine/acp-authenticate`.

### 13.2 What the daemon's authenticate actually does, headless

Measured, claude 2.1.228, non-TTY, piped stdio, scratch `HOME`:

- It **honours `runtimeOverrides.claudeCodeExecutable`** — `setting.ts:503` uses
  the override for both `auth login --claudeai` and `auth status --json`, and
  falls back to a managed download only when there is none. Our agent config
  always sets it (`agent-configs.ts:37`, `/usr/local/bin/claude`), so the sign-in
  and the agent are the same binary and the same credential store.
- It **produces the URL without being signed in**, which was the open question.
  stdout carries `Opening browser to sign in…`, then
  `If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…`,
  then `Paste code here if prompted > `. The daemon's parser accepts it because
  the host is `claude.com` and the path contains `/oauth/`
  (`acp-authentication-output.ts:24`), and marks `acceptsAuthorizationCode` for
  claude, which is what renders the panel's code input.
- Identical with a `CLAUDE_CODE_OAUTH_TOKEN` already in the environment, so a box
  whose shim mints one still gets a usable sign-in flow.
- It **binds no loopback callback** (checked with `ss -lntp` against the process
  tree). `redirect_uri` is Anthropic's hosted `/oauth/code/callback`, which shows
  the member a code. So the pasted code is the only way the flow can finish, and
  it never exits on its own.

### 13.3 The deadlock behind the paste, and the second bundle patch

That last point exposed a defect the transport fix alone could not reach.
`MessageProcessor.extractQueueKey` returns `null` for every message it does not
name, and `ConcurrentQueue` maps `null` onto ONE shared chain, `__default__`,
whose tasks run strictly in sequence. Every `machine/*` message shares it.

So `submit-code` queues behind the `start` that is waiting for it. The daemon
says so itself:

```
Message still waiting in queue type=machine/acp-authenticate sessionId=N/A
queuedFor=10000ms active=1 waiting=0
```

`action: 'cancel'` is on the same chain, so Cancel cannot break it either; the
only exit is the 285 s timeout. Verified directly against the daemon's own
control socket, so it is not something our chain introduced.

**Shipped:** `packages/box/patches/lody-acp-auth-queue.mjs`, a second patch to
the published npm bundle beside `lody-local-platform.mjs`. It adds one case:

```js
case "machine/acp-authenticate":
  return message.action === "start" ? `acp-auth:${message.agentType}` : null;
```

A `start` moves onto its own per-agent chain; `submit-code` and `cancel` keep the
key they already had and are no longer behind it. Strictly narrowing — the only
message that changes chains is the one that was blocking the others — and the
per-agent grouping is a rule the daemon already enforces one layer in, from
`runningByAgentType` (`acp-authentication.ts`).

Its guard is the package version plus its own anchor at exactly one occurrence,
NOT a whole-file sha256: two patches now run over the same artifact, and a file
hash can only pin whichever runs first.

### 13.4 §12.3's banner was wrong, and this is the corrected credential story

The banner told members to connect Claude in the workspace Connections panel.
**There is no Claude card in that catalog and there never was.** `blitz-cred get
claude` mints from harness-credential ROAMING — it copies a credential some box
already holds because somebody signed in on it interactively — so the panel it
opened had nothing in it to click, and the one instruction the banner gave could
not be followed.

The two routes that DO exist, both of which end in the same box credential:

1. **Lody's own sign-in**, now that §13.1 and §13.3 make it complete. The daemon
   runs `claude auth login --claudeai` against `/usr/local/bin/claude`, streams
   the authorization URL back, and takes the pasted code on its own request.
2. **`claude` in a terminal tab.** The same login by hand, storing the same
   credential in the daemon's own `HOME`.

`agent-auth-notice.tsx` now renders Lody's `AcpAuthenticationPanel` inline as its
primary action — the vendor component, unmodified, with the same overrides the
agent config carries — and names the terminal beside it. The
`onOpenConnections` prop is deleted from the banner, `SessionSurface`,
`LodySessionsRegion` and `CloudApp`: a wire to a panel that cannot help is worse
than no button.

### 13.5 Why no test caught it, and the three that now do

§12.4's suite is daemon-free by design, and a stub runtime cannot have a
transport bug. The daemon-backed suites that could have are the ones CI skips.
Worse, they had stopped running anywhere at all — see §13.6.

- `webapp/test/lody-session-control-stream.test.ts` — the browser reads the
  captured corpus through a fake `fetch` whose chunk boundaries fall mid-token,
  and asserts every frame is emitted BEFORE the promise settles. Runs in CI.
- `box/guest-tests/test/lody-bridge-control-stream.test.ts` — the real bridge
  against a stand-in daemon that holds its stream open, so "piped, not pooled" is
  established rather than inferred. Runs in CI.
- `webapp/test/lody-acp-authentication.test.ts` — the whole chain against a real
  `lody@0.88.1`, driving `machine/acp-authenticate` with a stand-in `claude` that
  prints the real captured URL and then blocks on stdin. It asserts the
  authorization frame arrives while the request is still open, then submits the
  code and gets `input-accepted` — which is the §13.3 patch under test, since
  without it that request cannot be answered at all. No paid turn: no model is
  ever reached.

`packages/schema/fixtures/lody-session-control-stream/` is the corpus, captured
from a real daemon through the real bridge. The frame union stays Lody's
(`local-ipc.ts:80`); what the corpus pins is that our hand-written copy of it —
unavoidable, because that module is node-only and cannot enter a browser bundle —
keeps agreeing.

### 13.6 The harness could no longer start a daemon on a box

Found while verifying the above, and it had disabled every daemon-backed suite in
the repo: `startLodyHarness` failed with a 60 s "timed out waiting for the daemon
to provision its implicit workspace", whose real cause was
`Cannot start: foreground process N already owns the local agent runtime`.

The single-instance host lease is one TCP port per installation profile — 17789
for `lody-oss` — with no override, and **a box runs its own daemon on it**
(`s6-rc.d/lody-daemon`). It only ever worked because the box image had not yet
shipped `lody-local-platform.mjs`, so the box's own daemon could not reach local
mode and never took the lease. On a current image it does.

Two fixes, both in the harness:

- It now declares itself a SUPERVISOR through Lody's own Supervisor↔Worker
  contract (`local-cli-supervisor.ts`) — the same four env markers
  `lody daemon start` sets for the worker it forks — which skips the lease. It is
  one, in the sense the contract means: it spawns the process, owns its lifetime
  and kills it. The daemon is spawned with an `ipc` stdio channel to match, since
  a worker carrying the markers without one stops itself as an orphan. That buys
  a property §10.8 wanted and could not have: a vitest worker killed by the OOM
  reaper drops the channel, and the daemon exits by itself.
- `lody-local-platform.mjs` treats an ALREADY-PATCHED bundle as success. The
  harness copies the box's own `/opt/blitz/npm` bundle, which on a real box is
  already patched, and refusing there reported "the pinned lody version moved" —
  the wrong cause, loudly. The teeth are unchanged: that branch is taken only for
  exactly four rewritten call sites, none of the originals, at the pinned version.

### 13.7 The sharing relay's join, retried on a fresh socket

With §13.6 letting the daemon-backed suites run again, `lody-sharing-relay`
failed about one run in three — always the same way, always in `beforeAll`:

```
timed out waiting for a joined frame for session-<id>
```

The peer's frame list was EMPTY. Not `room_forbidden`, not an error frame —
nothing at all, on a socket that had opened cleanly. Every other join in the
suite answers in about 100 ms.

It is not the relay and not this change. Measured on the same harness: a
stand-alone peer doing exactly that join, shared and unshared, immediately after
`startLodySession` and after a settling wait, got its `joined` frame every time.
Reverting the §13.1 transport fix did not help, and neither did dropping the
§13.3 patch — which is the expected result, because neither touches `/sync`.
What is left is the harness's own gateway stand-in, which splices the WebSocket
upgrade by hand where production uses `httputil.ReverseProxy`.

So `readRoom` now retries on a FRESH socket, with a short bound, up to four
times. The outer `untilRoom` already retried; the inner wait was simply
spending the whole budget on one dead socket. Four consecutive runs green
afterwards, where three runs before it had one failure.

The suite could not have been compared against `main` on a current box, because
there it does not start at all (§13.6). If this flake predates the port, the
retry is still the right shape; if it is the stand-in shim, the retry is where
it belongs — production's upgrade hop is Go, and `gateway/main_test.go` owns it.
