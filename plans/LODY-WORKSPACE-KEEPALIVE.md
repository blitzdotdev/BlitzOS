# Lody workspace keep-alive (Tier 2)

Status: Phase A and the non-effect Phase B audit are implemented locally with
behavioral gates. Phase C remains the active step: it adds the pool and the
React `Activity` boundary, then proves effect-scoped quiescence while hidden.

## Goal and measured budget

An already-visited workspace should return without rebuilding its Lody
renderer, IndexedDB-backed `LoroRepo`, WASM state, data-plane WebSocket, room
subscriptions, router, drafts, selection, or scroll position.

The measured warm remount is **541.5 ms**. A bootstrap-stubbed warm remount is
**502.1 ms**, so React/router/provider reconstruction accounts for roughly 500
ms; runtime/socket/bootstrap work accounts for roughly **39.5 ms**. Retaining
the tree therefore removes the dominant cost. A retained surface should still
activate in one render frame, targeting 10-50 ms.

One instrumented run (the probe observes its endpoint on a roughly 100 ms
sampling interval; no distribution or confidence interval is claimed):

| Phase | ms | Notes |
|---|---:|---|
| Initial render → first blank React commit | 2.6 | Providers wait for the platform snapshot. |
| First commit → platform snapshot ready | 9.6 | Snapshot ready at 12.2 ms total. |
| Snapshot ready → router created | 91.0 | Includes synchronous memory-router construction. |
| Router created → provider/snapshot commit | 140.0 | Jotai, platform, theme and runtime-provider tree construction. |
| Provider commit → runtime create start | 13.4 | Cache-clear await and effect scheduling. |
| `createWorkspaceRuntime` | 5.8 | LoroRepo/IndexedDB 3.7 ms; local transport 0.9 ms; initial meta sync 0.7 ms; other 0.5 ms. |
| Runtime return → agent bootstrap ready | 26.5 | Bootstrap itself was 24.8 ms. |
| Bootstrap ready → rail/gate commit | 74.0 | Rail ready at 362.85 ms. |
| Gate commit → first non-starting content observed | 178.6 | Heavy route render plus probe polling quantization. |
| **Warm total** | **541.5** | One measured run. |

The data-plane WebSocket opened at 260.67 ms and connected at 268.11 ms: 7.4
ms, overlapping runtime/bootstrap work. Observed totals were 943.186 ms cold,
541.538 ms warm, and 502.086 ms warm with bootstrap stubbed; warm minus stubbed
was 39.452 ms.

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
Jotai stores with distinct daemon-minted session, machine and presence IDs.
Doc-meta, machine and presence derived values remain correct. Cross-store memo
reference churn is allowed; wrong values are not. Phase C must prevent two live
entries for the same daemon identity and add one hidden-surface test for every
item delegated to the `Activity` boundary.

| Item | Disposition |
|---|---|
| Doc-meta `_prev*` and atom-family closure memos | **Accepted.** The two-store gate proves correct values with distinct daemon IDs; only referential churn remains. No vendor edit. |
| Machine-meta `_prevMachineMetaMap` | **Accepted.** Correct under the same two-store gate; wrong only on a daemon-ID collision forbidden by the pool key. |
| Presence `_prevOnlineMachineIds` | **Accepted.** Correct under the same two-store gate; wrong only on a machine-ID collision. |
| Machine-flock sync/listener Maps | **Accepted.** Keys already include workspace and machine; duplicate mounting of one daemon identity is forbidden by Phase C. Entries are otherwise wasted work, not cross-box values. |
| Page-global boot-clear promise | **Accepted.** Distinct daemon identities use distinct database names and the page promise only coordinates boot clearing; no A/B data leak is demonstrated. |
| Auth-client singleton | **Accepted inert.** Blitz supplies its auth client directly in `packages/webapp/src/lody/platform.tsx` and never calls `createLodyAuthClient`. |
| Shared server-time offset | **Accepted inert.** Blitz does not mount `AppInitializer`, the only sync caller. |
| Monaco URI/model/provider ownership | **Deferred to Phase C hidden-surface tests.** The editor controllers/providers live in route-tree effects; React 19.2 `Activity mode="hidden"` cleans those effects while preserving state/DOM, so an inactive box cannot own the path-keyed provider. |
| Global keyboard handlers | **Deferred to Phase C hidden-surface tests.** Their route-tree effects are disconnected by the `Activity` boundary. |
| Session-viewing presence | **Deferred to Phase C hidden-surface tests.** `usePublishSessionViewing` is route-effect scoped; hiding actively runs its cleanup. |
| Global Sonner store / per-surface toaster | **Fixed** in `packages/webapp/src/lody/surface-providers.tsx`: only the `active` surface mounts the toast renderer. |
| Session-mention slug map | **Accepted.** It is wrong only across boxes sharing a slug when a stale draft from the other box is expanded; session IDs remain daemon-minted and Phase C activation replaces the address owner. |
| Managed-preview frame LRU | **Accepted warm-state loss only.** Cross-box eviction can discard a hidden preview iframe, but does not route work to the wrong box; the session's durable browser state remains authoritative. |
| Root theme/CSS-variable ownership | **Fixed** in `packages/webapp/src/lody/SessionSurface.tsx` and `surface-providers.tsx`: one theme provider is hoisted above the keyed surface, and inactive surfaces never own the root. |
| Command registry singleton | **Accepted inert.** Blitz mounts neither `commands.attach(window)` nor `CommandPalette`, so no dispatcher consumes stacked registrations. |
| Unsettled local-platform interval | **Fixed** by seam 18: bound-client disposal aborts the poll, deletes its client state and disables later invokes. |
| Per-runtime page listeners/timers | **Accepted live runtime work.** They are correct per runtime, required for continuity/reconnect, and fully removed by runtime disposal on eviction. |
| Monaco worker/theme one-time registration | **Accepted.** Definitions are page-global, workspace-independent and idempotent. |

## Phase C: identity-keyed keep-alive pool

Implement an LRU in `LodySessionsRegion`, initially capped at two total live
surfaces. Owned surfaces are cacheable. A shared surface is initially transient
and may coexist with only the most-recent owned surface, making the common
shared-to-own return instant without retaining revocable foreign access.

Retain each surface's bridge, store, runtime providers and router. Wrap the
route tree (`RouterProvider` and below) in React 19.2
`<Activity mode="hidden">` while inactive. Only the active surface publishes
shell callbacks, portals its rail, mounts the toaster and installs compatibility
`window.ipc`; the `active` prop added in Phase B already names that ownership.

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
