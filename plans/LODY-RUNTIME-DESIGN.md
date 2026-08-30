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
