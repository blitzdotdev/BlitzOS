# Lody workspace keep-alive (Tier 2)

> **Historical design record.** As of 2026-09-04, use
> `docs/LODY-MERGE.md` for upstream procedure and
> `plans/LODY-DAEMON-FROM-TREE.md` for the source-built daemon migration.
> Conflict footprints and measurements below remain dated design evidence.

Status: Phases A-C are implemented with behavioral gates. The keep-alive pool
is enabled by default. The latest fixed-size jsdom commit benchmark is recorded
in `LODY-WORKSPACE-KEEPALIVE.probe.json`.

## Goal and benchmark

An already-visited workspace should return without rebuilding its Lody
renderer, IndexedDB-backed `LoroRepo`, WASM state, data-plane WebSocket, room
subscriptions, router, drafts, selection, or scroll position.

Retaining the tree removes provider, router, store and route reconstruction.
The jsdom benchmark below measures React commit work under fixed element sizes.
It does not claim browser or product latency.

## Non-negotiable invariants

1. A Lody surface may only communicate through the IPC client captured for
   that surface. It may not discover its box from the current value of
   `window.ipc` after construction.
2. Electron keeps its current behaviour. With no injected client, every
   existing helper continues to read `window.ipc` exactly as it does today.
3. A cache key is a daemon-minted identity or a bridge/client instance, never a
   URL. A rescue rebuild can put a new `lw_` identity at the same URL.
4. Two renderer stores may share referential stabilization only where a
   two-store gate proves distinct daemon identities still return correct
   values. Runtime data, transports and writable state remain surface-scoped.
5. Only the active surface may publish shell callbacks or portal its rail.
   Hidden surfaces retain their runtime but cannot overwrite the visible
   workspace's shell state.
6. A hidden surface whose bridge loses continuity is evicted. A later visit
   performs a fresh platform snapshot rather than reconnecting against an
   identity that may have been replaced.

## Phase A: per-surface IPC client

### Inventory result (2026-09-02)

- Production `window.ipc` is now read in one place:
  `lib/electron-ipc-client.ts`'s default client. Story fixtures assign it; the
  Blitz host still assigns it as an Electron-compatibility fallback. Bound
  surface clients do not read it.
- `window.repo` had one assignment and no readers. Runtime disposal now deletes
  it only when it still owns the value, so the debug handle cannot retain an
  evicted repo and an older runtime cannot clear a newer runtime's handle.
- The runtime path, local-platform poller, Loro data plane, local presence,
  machine RPC, session control, and every asynchronous file/history path in the
  Blitz-mounted route tree now carry `ipcClient` explicitly.
- Ambient helper calls remain in Electron-only roots and features: onboarding,
  native theme/menu/updater/window badge, native terminal, desktop path launch,
  global shortcuts, and native browser/export. Blitz does not set
  `__LODY_ELECTRON__` and does not mount upstream's root, so those deliberately
  retain the default client and byte-for-byte Electron behavior.
- Shared state still blocking keep-alive was confirmed in `doc-meta.ts`
  (`_prevSessionList`, `_prevArchivedSessionList`, `_prevAllActiveSessions` and
  atom-family closure memos), `machines.ts` (`_prevMachineMetaMap`),
  `presence.ts` (`_prevOnlineMachineIds`), and
  `use-machine-flock-rows.ts` (workspace-id-keyed sync/listener Maps shared by
  stores). `auth-client-singleton.ts` and shared `time-sync.ts` are also true
  module singletons and need an explicit keep-alive disposition.
- `clear-local-cache.ts` has one page-lifetime `bootClearPromise`. Fork PR #19
  is still open and clean as of 2026-09-02; re-pin after it merges before
  mounting the second runtime. Fork PR #20 is also open/clean; #21 is open as a
  draft.

### Additive vendor API

Build on the existing `getIpcServices`, `onIpcEvent`, `sendIpc`, and
`sendLocalSessionControl` seam. Add a small `LodyIpcClient` interface with
`signal`, `getServices`, `on`, `send`, and `dispose`, plus two implementations:

- `windowIpcClient` is the default. It reads `window.ipc` lazily on every call,
  preserving Electron and all existing call sites.
- `createBoundIpcClient(bridge)` captures one bridge permanently. BlitzOS
  creates exactly one bound client per `SessionSurface`; terminal disposal
  aborts the signal and idempotently drains all listeners registered by it.

The existing helpers take an optional final client argument and delegate to it.
No current Electron caller changes. Do not introduce parallel helpers such as
`sendSurfaceIpc`; one IPC vocabulary makes missed conversions auditable.

Add `IpcClientProvider` with `windowIpcClient` as its context default. React
components use `useIpcClient`; `RuntimeProvider` reads the same context and
threads it explicitly through `createWorkspaceRuntime`, the local Loro data
plane, workspace-machine RPC, local session control, and local presence.
Plain modules never read React context.

Key local-platform provider/session/workspace state in a `WeakMap` by
`LodyIpcClient`. The stable default client retains Electron's one-provider
semantics; two bound clients receive two independent platform identities. This
supersedes seam 17's reset, which assumes surfaces are sequential.

Direct IPC uses reachable from BlitzOS's `ChatLanding`/`SessionDetail` route
tree must either use the context client or an explicit runtime client. Do not
rewrite Electron-only onboarding, updater, menu, or settings paths merely
because they import the same helpers.

### Failing-first proof

`packages/webapp/test/lody-ipc-client-isolation.test.ts` is the behavioural
gate. It creates bridge A, bridge B, and a poison global bridge, then proves:

1. Existing no-argument helpers still follow `window.ipc` (Electron
   compatibility).
2. Bound helpers continue to use A/B after `window.ipc` is replaced by poison.
3. Two simultaneously mounted local-platform consumers settle on `lw_A` and
   `lw_B` without a reset.
4. Two local Loro data-plane connections subscribe, send, receive, and
   unsubscribe only through their captured bridge.
5. Workspace-machine RPC and local session dispatch use the captured client,
   not poison.
6. The mounted import closure has no unapproved unscoped `getIpcServices`,
   `getPublicBrowserBridge`, `onIpcEvent`, `sendIpc`,
   `sendLocalSessionControl`, or `window.ipc` call. The guard parses call sites
   with Rolldown's Oxc TS/TSX AST, derives all `@lody/*` mappings from
   `vendor-bridge.ts`, rejects unresolved internal imports, and grants only
   exact helper/enclosing-function pairs rather than whole-file allowances.

The test must be run once with the client threading neutered and observed
failing before the implementation is accepted.

Mutation checks are recorded for both layers: replacing
`createBoundIpcClient(bridge)` with the default window client produced three
independent routing failures, and temporarily changing
`getPublicBrowserBridge(ipcClient)` to `getPublicBrowserBridge()` failed the
source audit at the exact file and line. Restoring each mutation made the gate
pass.

### Phase A + non-effect Phase B validation record (2026-09-02)

- IPC isolation gate: 10/10 passed, including two real provider trees, disposal,
  import-closure inventory and an actual cloud-mode runtime.
- Focused required Lody floor: 11 unique files, 79 tests passed, 2 skipped. The
  first aggregate run's two concurrent renderer imports exhausted their
  240-second hook budget; the same two files passed serially, 17 passed / 2
  skipped.
- `npm run typecheck`: passed across all workspaces.
- `npm run lint:gate`: passed at 66 anti-slop, 0 house, 8 unchanged max-lines
  warnings.
- `git diff --check`: passed. The temporary Vite filesystem allowlist needed
  for the shared icon dependency was reverted.

### Upstream conflict footprint

Seam 18 now touches 21 vendor source files: seven central
client/provider/runtime files (including one new provider) and fourteen mounted
helper/leaf callers. The caller changes are intentionally repetitive—one
context hook, an optional client argument, and dependency-list entries—with no
component restructure. An upstream pull only conflicts when upstream edits
those same few call-site lines; the generic central seam can be dropped
wholesale once the fork PR lands. Keep this phase in its own commit so a subtree
re-pin never has to reconcile it with cache isolation or the Blitz-owned LRU.

## Phase B: non-effect shared-state disposition

`packages/webapp/test/lody-two-store-memos.test.ts` interleaves two independent
Jotai stores, replaces both stores' inputs with structurally equal values to
invalidate the derived atoms, and then diverges one store. Doc-meta, machine
and presence derived values remain correct through the shared `_prev*` reuse
branches. Cross-store reference reuse is allowed only while values are equal.

| Item | Disposition |
|---|---|
| Doc-meta `_prev*` and atom-family closure memos | **Accepted.** The two-store gate proves correct values with distinct daemon IDs; only referential churn remains. No vendor edit. |
| Machine-meta `_prevMachineMetaMap` | **Accepted.** Correct under the same two-store gate; wrong only on a daemon-ID collision forbidden by the pool key. |
| Presence `_prevOnlineMachineIds` | **Accepted.** Correct under the same two-store gate; wrong only on a machine-ID collision. |
| Machine-flock sync/listener Maps | **Accepted.** Keys already include workspace and machine; duplicate mounting of one daemon identity is forbidden by Phase C. Entries are otherwise wasted work, not cross-box values. |
| Page-global boot-clear promise | **Accepted.** Distinct daemon identities use distinct database names and the page promise only coordinates boot clearing; no A/B data leak is demonstrated. |
| Auth-client singleton | **Accepted inert.** Blitz supplies its auth client directly in `packages/webapp/src/lody/platform.tsx` and never calls `createLodyAuthClient`. |
| Shared server-time offset | **Accepted inert.** Blitz does not mount `AppInitializer`, the only sync caller. |
| Monaco URI/model/provider ownership | **Delegated to the Phase C Activity boundary.** Route-tree effects are destroyed while hidden. The generic effect gate is tested; Monaco itself requires manual browser verification. |
| Global keyboard handlers | **Implemented and tested.** A probe listener is removed while hidden and restored on reveal. |
| Session-viewing presence | **Delegated to the Phase C Activity boundary.** `usePublishSessionViewing` is route-effect scoped; the generic Activity cleanup is tested, not a live presence transport. |
| Global Sonner store / per-surface toaster | **Known bug.** Lody producers use Sonner's global `toast` without surface attribution. A continuation started in hidden A can render its late toast in active B. The expected-failure test pins that handoff. The upstream sketch adds a runtime-bound `useToast` hook and per-runtime `toasterId`. |
| Session-mention slug map | **Accepted.** It is wrong only across boxes sharing a slug when a stale draft from the other box is expanded; session IDs remain daemon-minted and Phase C activation replaces the address owner. |
| Managed-preview frame LRU | **Accepted warm-state loss only.** Cross-box eviction can discard a hidden preview iframe, but does not route work to the wrong box; the session's durable browser state remains authoritative. |
| Root theme/CSS-variable ownership | **Fixed** in `packages/webapp/src/lody/SessionSurface.tsx` and `surface-providers.tsx`: one theme provider is hoisted above the keyed surface, and inactive surfaces never own the root. |
| Command registry singleton | **Accepted inert.** Blitz mounts neither `commands.attach(window)` nor `CommandPalette`, so no dispatcher consumes stacked registrations. |
| Unsettled local-platform interval | **Fixed** by seam 18: bound-client disposal aborts the poll, deletes its client state and disables later invokes. |
| Per-runtime page listeners/timers | **Accepted live runtime work.** They are required for continuity/reconnect. The real-provider gate awaits disposal and checks the data-plane listener drain; it does not enumerate every vendor timer. |
| Monaco worker/theme one-time registration | **Accepted.** Definitions are page-global, workspace-independent and idempotent. |

## Phase C: identity-keyed keep-alive pool

`keepalive-pool.ts` is the pure state machine and exports the single capacity
constant, **2 total live surfaces**, plus an explicit device policy. Capacity is
two when `navigator.deviceMemory >= 4`, or when that hint is absent and the
shell is desktop-class: `(pointer: fine)` matches and the shared
`MOBILE_WEBAPP_QUERY` does not. Every other device uses one. Entries are
provisional until the platform snapshot reports
`(machineId, lw_workspaceId)`. Endpoint fingerprints are only lookup hints for
continuous, identity-known hidden entries. They are never cache keys. Before a
`RuntimeProvider` mounts, the provisional surface must acquire that identity's
claim. Within one document, a retained holder defeats a duplicate provisional
surface. Other claims wait for the previous holder's completed `disposed`
event. A second browser tab can still open the same IndexedDB. A
runtime-lifetime Web Lock is the follow-up for cross-document exclusion.
Activation also checks the platform identity. A mismatch evicts the retained
entry before the replacement mounts.

`LodySurfacePool.tsx` keeps the React side to ownership and rendering. Every
entry has a stable React key and retains its bridge, bound IPC client, Jotai
store, runtime providers, runtime, repo, router and route DOM. Owned entries use
LRU eviction. A shared/foreign-grant surface is transient and can coexist only
with the most recently used owned surface. Capability probing temporarily
deactivates the current entry rather than losing the cache.

Inactive route trees (`RouterProvider` and the mobile stack below it) are inside
React 19.2 `<Activity mode="hidden">`; the store, platform, bridge,
`RuntimeProvider`, and agent-config gate stay live above it. One surface owner
above Activity holds the workspace context until eviction. The outer surface is also `hidden`,
`inert`, and `aria-hidden`. Address subscriptions, project backfill, and the
auth-notice two-second poll
also remain live above Activity; they are accepted per-runtime background work.
Reveal restores the last connected focused element,
falling back to the composer or surface root. jsdom preserves `scrollTop`
through Activity hide/reveal only as a property-level approximation. The
surface captures the known live conversation/Radix scroll viewport offsets
before hide and reapplies them in the reveal layout effect; the jsdom
gate pins this explicit restore. Virtualizer/layout behavior still needs manual
Chromium verification.

Ownership tokens accept API publication, router mirroring, the visible rail
wrapper and `window.ipc` only from the active entry. The active toaster is also
the sole renderer and handoff dismisses the global queue, subject to the late
producer limitation documented above. Every retained
surface keeps its rail subtree mounted in its own hidden/inert wrapper under a
matching Activity boundary, so activation reveals the existing rows rather
than rebuilding their projections. Reactivation publishes the cached API
immediately, compares the shell's workspace-chat address, and navigates the
retained router only on a real difference. It does not remount the surface.

The active/hidden values live in a small context consumed only by the ownership,
Activity, rail-wrapper, toaster, identity-validation and focus leaves. The
provider/router body is memoized, so flipping ownership does not re-render the
whole runtime tree. Identity revalidation remains fire-and-forget, and the
agent-config gate remains mounted and ready above Activity.

The pool canonicalizes each entry's mount-only target values, including the
`fetchImpl` and `webSocketConstructor` functions captured by bridge creation,
and the shell memoizes its rail binding. This matters outside the probe: `LodySessionsRegion`
constructs target descriptions while rendering, and fresh-but-equivalent
endpoint objects must not pierce the retained body's shallow memo comparison.
The surface-pool adapter test pins endpoint-object reuse across reactivation.

The data-plane reports every non-disposal physical socket loss, including a
failure before the first open, plus redial; the bridge forwards explicit
identity-change notices it observes. A discontinuous hidden entry is evicted immediately. An active entry
becomes non-reusable and re-fetches `/lody/platform`; matching identity restores
continuity and mismatching identity remounts fresh. Surface teardown follows
actual constructor attempts, never wrapper mounts. `RuntimeProvider` emits
`starting` immediately before each `createWorkspaceRuntime()` call and carries
one unique attempt id through `created`, `failed`, and `disposed`. Blitz holds
one completion promise per attempt. Created attempts wait for `disposed`.
`failed` is emitted only after constructor rollback has
destroyed the partial repo and detached any transport/listener already
installed. If missing slug/workspace id means no attempt starts, teardown has
nothing to await and releases immediately.

The runtime kill switch is `localStorage["blitz.lody.keepalive"] = "off"`.
It defaults **on**. The pool listens to cross-document `storage` events.
Turning it off in another document shrinks a mounted pool to one entry.
A DevTools change in the current document needs a reload.

## Measurement record

`lody-keepalive-activation.probe.test.tsx` boots two independent daemons.
Seeded session titles identify the active route and rail. `performance.now()`
surrounds each root update. A `MutationObserver` records when the retained DOM
becomes visible. Readiness also requires the composer and the target socket's
public `OPEN` state. No product code carries benchmark marks or counters.

This is a jsdom React-commit benchmark. `installLodyDomStubs()` supplies fixed
element sizes. It does not measure browser layout, paint, tunnels, or product
latency. The committed artifact is
`plans/LODY-WORKSPACE-KEEPALIVE.probe.json`.

The 2026-09-04 run produced these observable-boundary results:

| Measurement | Result |
|---|---:|
| Cold B visible / ready | 170.4 / 438.1 ms |
| Retained visible p50 / p95 (10 samples) | 149.5 / 238.4 ms |
| Retained ready p50 / p95 (10 samples) | 149.5 / 238.4 ms |
| Full A to B to A cycle p50 / p95 | 319.1 / 415.5 ms |
| Open sockets before B / with both / after A eviction | 1 / 2 / 1 |

The exact command is stored in the artifact. It uses the source-built
`f4b1ba25` daemon bundle and `--maxWorkers=1`. Vitest did not expose
`global.gc`. RSS and heap values are allocator high-water samples. A browser
trace remains necessary for layout and paint.

## Final correctness closure (2026-09-03)

| Finding | Status | Closure |
|---|---|---|
| F1 | **Closed** | Attempt-ID lifecycle promises replace wrapper counters. Construction eviction, two StrictMode attempts, and the no-attempt early return are gated. |
| F2 | **Closed** | `createWorkspaceRuntime` rolls attached resources and the repo back before rejection; the fake-repo gate proves destroy-before-`failed`, claim release ordering, and same-identity recreation. |
| F3 | **Closed** | Cross-document storage notifications resize a mounted pool immediately. A same-document DevTools change needs a reload. |
| F4 | **Closed** | Memory-present and memory-absent desktop/mobile branches are explicit and unit tested against the shell's shared breakpoint. |
| F5 | **Closed** | Ambient IPC is allowlisted by helper plus enclosing function; the equal-count guarded-to-unguarded mutation fails. |
| F6 | **Closed** | Constructor rollback excludes pre-handle repo leaks. The probe-only production handle metric was deleted. |
| F7 | **Closed** | Conversation and Radix offsets use selector/index semantic keys and re-resolve replacement nodes. Real Chromium layout/virtualizer verification remains a manual release check. |
| F8 | **Closed** | Bridge-construction function identities participate in the mount token, forcing serialized remount instead of partial prop update. |
| F9 | **Closed** | The probe reads DOM and socket boundaries. Production carries no reveal marks or measurement timers. |
| F10 | **Closed** | Seam 18 is labeled as a cumulative upstream inventory and the branch aggregate is recorded in `BLITZ-PATCHES.md`. |
| F11 | **Closed** | The discarded pure pool-disposal call was deleted; React child unmount remains the real teardown path. |

The review simplifications are also closed. Lifecycle state is one promise per
real attempt, and production has no measurement work.
`lodySurfaceIdentityKey` is the sole identity key/equality implementation used
by the pool, `SessionSurface`, and the claim queue. Previously partial S1-F1,
S1-F4, C-F1, C-F2, C-F4, C-F6, C-F7, C-F8, and C-F9 are therefore closed; the
The Sonner limitation is now tracked as a known bug with an upstream seam sketch.

## Upstream/conflict strategy

The client abstraction is generic Lody infrastructure: no Blitz URL, workspace
membership, or relay concept belongs in it. Submit it to the public Lody fork,
then re-pin the subtree rather than carrying a second implementation as a
permanent Blitz patch. Keep IPC isolation, store-cache isolation, and the
Blitz-owned LRU in separate commits so an upstream re-pin can accept or drop
each seam independently.
