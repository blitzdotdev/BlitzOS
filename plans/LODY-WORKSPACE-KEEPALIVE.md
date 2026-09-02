# Lody workspace keep-alive (Tier 2)

Status: Phase A is implemented locally and has a behavioral + mutation-tested
gate. Phase B remains the active prerequisite. The keep-alive pool is not
allowed to mount until the shared-cache gates below are green.

## Goal and measured budget

An already-visited workspace should return without rebuilding its Lody
renderer, IndexedDB-backed `LoroRepo`, WASM state, data-plane WebSocket, room
subscriptions, router, drafts, selection, or scroll position.

The original verified compute-only baseline is 751 ms for a warm remount
(`packages/webapp/test/lody-switch-cost.probe.test.tsx`). After Phase A, the
same probe measured 1,579 ms cold, 784 ms warm, and 772 ms warm with bootstrap
stubbed. That is noise around the same rebuild floor, not a speed claim. A
retained surface should activate in one render frame, targeting 10-50 ms:
roughly 700-740 ms saved in the probe, plus the field's serialized tunnel round
trips.

## Non-negotiable invariants

1. A Lody surface may only communicate through the IPC client captured for
   that surface. It may not discover its box from the current value of
   `window.ipc` after construction.
2. Electron keeps its current behaviour. With no injected client, every
   existing helper continues to read `window.ipc` exactly as it does today.
3. A cache key is a daemon-minted identity or a bridge/client instance, never a
   URL. A rescue rebuild can put a new `lw_` identity at the same URL.
4. Two renderer stores may not share referential memo state. Keep-alive remains
   disabled until the doc-meta, machine, presence, and machine-flock caches are
   scoped by store/runtime.
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
`getServices`, `on`, and `send`, plus two implementations:

- `windowIpcClient` is the default. It reads `window.ipc` lazily on every call,
  preserving Electron and all existing call sites.
- `createBoundIpcClient(bridge)` captures one bridge permanently. BlitzOS
  creates exactly one bound client per `SessionSurface`.

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
6. The live runtime source has no unscoped `getIpcServices`, `onIpcEvent`,
   `sendIpc`, or `sendLocalSessionControl` call. This source guard prevents a
   future upstream call site from silently restoring the singleton.

The test must be run once with the client threading neutered and observed
failing before the implementation is accepted.

That mutation check is recorded: replacing `createBoundIpcClient(bridge)` with
the default window client produced three independent failures (data plane,
platform identity, and dispatch routing); restoring the capture made all six
checks pass.

### Phase A validation record (2026-09-02)

- IPC isolation gate: 6/6 passed after the mutation was restored.
- Focused required Lody floor: 9 files passed, 53 tests passed, 1 skipped.
- `npm run typecheck`: passed.
- `npm run lint:gate`: passed at 74 anti-slop, 0 house, 8 max-lines.
- `npm test`: the first run passed all 110 webapp files / 937 tests but hit an
  unrelated guest CLI assertion because this runner supplied conflicting
  `NO_COLOR` and `FORCE_COLOR`; the unchanged guest paths passed 4/4 with the
  conflict removed. Subsequent clean-color runs exposed the documented
  `lody-tab-selection-sync` load flake and real-relay 60-second timeouts.
  Crucially, a detached, unchanged `HEAD` worktree reproduced the relay timeout
  in isolation on a different relay assertion. The full root command therefore
  does not currently produce a stable zero with this daemon bundle; do not
  misattribute that baseline nondeterminism to seam 18.

### Upstream conflict footprint

Phase A currently touches 19 vendor source files: seven central
client/provider/runtime files (including one new provider) and twelve mounted
helper/leaf callers. The caller changes are intentionally repetitive—one
context hook, an optional client argument, and dependency-list entries—with no
component restructure. An upstream pull only conflicts when upstream edits
those same few call-site lines; the generic central seam can be dropped
wholesale once the fork PR lands. Keep this phase in its own commit so a subtree
re-pin never has to reconcile it with cache isolation or the Blitz-owned LRU.

## Phase B: shared cache isolation

Before two real surfaces mount, add two-store tests and scope these caches:

- `atoms/doc-meta.ts`: previous session-list values and atom-family closure
  memos;
- `atoms/machines.ts`: previous machine meta map;
- `atoms/presence.ts`: previous online-machine-id set;
- `hooks/use-machine-flock-rows.ts`: sync state and listener maps by runtime,
  matching its existing runtime-keyed WeakMaps;
- `lib/clear-local-cache.ts`: consume the per-database page-lifetime behaviour
  from Lody fork PR #19 before a second live runtime can open the same DB.

## Phase C: identity-keyed keep-alive pool

Implement an LRU in `LodySessionsRegion`, initially capped at two total live
surfaces. Owned surfaces are cacheable. A shared surface is initially transient
and may coexist with only the most-recent owned surface, making the common
shared-to-own return instant without retaining revocable foreign access.

Key retained entries by `(machineId, lw_workspaceId)` and store their bridge,
IPC client, Jotai store, runtime, router, and last-used sequence together. Never
key reuse by `lodySyncUrl` or another endpoint URL.

Eviction must dispose the bridge socket, runtime transports, repo, listeners,
and timers. `window.repo` must be ownership-cleared when its repo is disposed so
the debug global cannot pin an evicted WASM graph.

## Measurement and release gates

Extend the switch-cost probe to measure A -> B -> A activation at an explicit
"correct identity rail ready" marker, along with RSS/heap/external memory,
open bridge sockets, and live repos. The LRU cap stays at two unless those
measurements justify three.

Before claiming a latency win, run the focused Lody regression floor, then
`npm run typecheck`, `npm run lint:gate`, and `npm test`. Never enable
`BLITZ_LODY_LIVE_TURN`. A merge still requires explicit user approval because
main deploys canary immediately.

## Upstream/conflict strategy

The client abstraction is generic Lody infrastructure: no Blitz URL, workspace
membership, or relay concept belongs in it. Submit it to the public Lody fork,
then re-pin the subtree rather than carrying a second implementation as a
permanent Blitz patch. Keep IPC isolation, store-cache isolation, and the
Blitz-owned LRU in separate commits so an upstream re-pin can accept or drop
each seam independently.
