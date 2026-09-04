# Lody workspace keep-alive (Tier 2)

> **Historical design record.** As of 2026-09-04, use
> `docs/LODY-MERGE.md` for upstream procedure and
> `plans/LODY-DAEMON-FROM-TREE.md` for the source-built daemon migration.
> Conflict footprints and measurements below remain dated design evidence.

Status: Phases A-C are implemented with behavioral gates. The keep-alive pool
is enabled by default and the attributed two-daemon activation gate is green:
the final correctness-pass confirmation measured 55.3 ms p50 / 67.3 ms p95 to
ready (`/tmp/codex/perf-run-6.json`).

## Goal and measured budget

An already-visited workspace should return without rebuilding its Lody
renderer, IndexedDB-backed `LoroRepo`, WASM state, data-plane WebSocket, room
subscriptions, router, drafts, selection, or scroll position.

Retaining the tree removes provider, router, store and route reconstruction.
The release target is a retained-ready p95 below 200 ms. The current attributed
two-daemon result is 67.3 ms p95 in `/tmp/codex/perf-run-6.json`; the detailed
artifact-backed comparison is recorded under Measurement and release gates.

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
| Global Sonner store / per-surface toaster | **Accepted limitation.** Sonner 2.0.8 supports toaster IDs, but Lody's vendor producers use its global `toast` singleton without an ID. Handoff dismisses the outgoing global queue before the next active toaster mounts, which is tested with simultaneous A/B surfaces. A hidden surface's late asynchronous toast can still render in the active toaster. |
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
continuous, identity-known hidden entries; they are never cache keys. Before a
`RuntimeProvider` mounts, the provisional surface must acquire that identity's
claim. A known continuous retained holder defeats a duplicate provisional
surface. Otherwise claims serialize runtime creation behind the previous
holder's completed `disposed` event, including immediate reopen after
invalidation. Activation also performs a platform-snapshot identity check; a
mismatch evicts the retained entry and mounts the target fresh after the claim
barrier clears.

`LodySurfacePool.tsx` keeps the React side to ownership and rendering. Every
entry has a stable React key and retains its bridge, bound IPC client, Jotai
store, runtime providers, runtime, repo, router and route DOM. Owned entries use
LRU eviction. A shared/foreign-grant surface is transient and can coexist only
with the most recently used owned surface. Capability probing temporarily
deactivates the current entry rather than losing the cache.

Inactive route trees (`RouterProvider` and the mobile stack below it) are inside
React 19.2 `<Activity mode="hidden">`; the store, platform, bridge,
`RuntimeProvider`, and agent-config gate stay live above it. The route's own
workspace-context cleanup is countered by a surface owner above Activity, so it
cannot tear down the retained runtime. The outer surface is also `hidden`,
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

Activation measurement is inert unless the probe has begun a trace for the
target. Normal reveals mount no marker components and schedule no
`effects-settled` timer.

The data-plane reports every non-disposal physical socket loss, including a
failure before the first open, plus redial; the bridge forwards explicit
identity-change notices it observes. A discontinuous hidden entry is evicted immediately. An active entry
becomes non-reusable and re-fetches `/lody/platform`; matching identity restores
continuity and mismatching identity remounts fresh. Surface teardown follows
actual constructor attempts, never wrapper mounts. `RuntimeProvider` emits
`starting` immediately before each `createWorkspaceRuntime()` call and carries
one unique attempt id through `created`, `failed`, and `disposed`. Blitz holds
one completion promise per attempt. A 10-second bound logs one structured
slow-construction warning but never releases authority; `created` attempts wait
for `disposed`, and `failed` is emitted only after constructor rollback has
destroyed the partial repo and detached any transport/listener already
installed. If missing slug/workspace id means no attempt starts, teardown has
nothing to await and releases immediately.

The runtime kill switch is `localStorage["blitz.lody.keepalive"] = "off"`.
It defaults **on** because `/tmp/codex/perf-run-6.json` clears the retained-ready
p95 gate. The pool listens to cross-document `storage` events and an exported
same-page policy signal; turning it off immediately shrinks a mounted pool to
one entry, evicts the hidden neighbor, and restores exact single-surface
replacement behavior without a target change.

## Measurement and release gates

`lody-keepalive-activation.probe.test.tsx` uses two independently booted daemon
harnesses and seeded session titles as identity markers. `performance.now()` is
captured immediately before the root update. A `MutationObserver` validates the
target's active/non-hidden root and then the conjunction of its composer plus
the active rail wrapper's identity-specific session. Layout-effect marks give
the exact commit time; this avoids charging the endpoint for Vitest `act()`
delaying MutationObserver delivery until after passive effects. The artifact
also retains that later observer-delivery time for audit. A zero-delay
act/microtask loop drives React without quantizing either endpoint.

Five A -> B -> A cycles produce ten retained activation samples. Every sample
collects active flip, Activity reveal, opt-in next-macrotask effects settled, rail
commit, address reconciliation plus its navigation decision, identity
revalidation start/end, surface reveal, and focus restore. The probe records
`process.memoryUsage()` and live bridge-socket/runtime-handle counters before B, with both
entries, and after stopping A evicts it. Every execution writes a new exclusive
`/tmp/codex/perf-run-<n>.json` and prints its tables to stdout.

The earlier uncorroborated latency claim is withdrawn. The surviving fixed-path
artifact `/tmp/lody-keepalive-activation.json` showed 357.3 ms p50 / 414.6 ms
p95. The first newly attributed pre-optimization run is
`/tmp/codex/perf-run-1.json`; its shared-box p95 includes a multi-second stall,
but its phase marks still locate the synchronous work:

| Pre-optimization milestone (10 retained samples) | Median ms from activation |
|---|---:|
| Rail portal mount/commit | 52.6 |
| Activity reveal commit | 52.9 |
| Surface visible commit | 53.8 |
| Active-flip commit | 53.8 |
| Address reconciliation (0/10 navigated) | 53.9 |
| Identity revalidation start / end | 90.9 / 238.7 |
| Focus restore | 199.3 |
| Effects re-run settled | 202.4 |
| Observer-ready p50 / p95 | 195.3 / 10,547.6 |

The rail retention and active-context/memo split paid: in the final run the
rail commit fell from 52.6 to 6.0 ms median and the active-flip commit from 53.8
to 6.9 ms. Moving identity validation to its leaf made its 153.3 ms median end
occur well after ready instead of gating any ownership or DOM. Address compare
already paid before this pass—both runs navigated 0/10 times—so no router change
was needed. The agent-config gate also needed no change: it remains mounted
above Activity, its ready state persists, and no bootstrap await occurs during
activation. Every retained timing optimization is reflected in the phase-mark
comparison above; target canonicalization is separately pinned as a production
path correctness condition.

Final clean run on 2026-09-03, two independent daemons, artifact
`/tmp/codex/perf-run-3.json`:

| Measurement | Result |
|---|---:|
| Cold B visible / ready | 35.4 / 340.4 ms |
| Retained visible p50 / p95 (10 samples) | **6.9 / 14.3 ms** |
| Retained ready p50 / p95 (10 samples) | **6.9 / 14.3 ms** |
| Full A -> B -> A cycle p50 / p95 | 14.8 / 20.6 ms |
| Observer delivery p50 / p95 (audit only) | 111.4 / 144.5 ms |
| Before B | RSS 692.2 MiB; heap 531.4 MiB; external 11.6 MiB; 1 socket; 1 runtime handle |
| Two live | RSS 702.1 MiB; heap 545.0 MiB; external 11.6 MiB; 2 sockets; 2 runtime handles |
| After hidden A eviction | RSS 739.7 MiB; heap 578.3 MiB; external 12.1 MiB; 1 socket; 1 runtime handle |

The first correctness-pass candidate exposed a scroll-capture regression:
`/tmp/codex/perf-run-4.json` measured 113.7 ms p50 / 157.0 ms p95 after the
capture walked every descendant and forced style resolution during handoff.
That implementation was not retained. Restricting capture to the known
conversation/Radix viewports removed the DOM-size cost. Final post-correction
run on 2026-09-03, artifact `/tmp/codex/perf-run-5.json`:

| Measurement | Result |
|---|---:|
| Cold B visible / ready | 53.8 / 356.0 ms |
| Retained visible p50 / p95 (10 samples) | **18.1 / 23.8 ms** |
| Retained ready p50 / p95 (10 samples) | **18.1 / 23.8 ms** |
| Full A -> B -> A cycle p50 / p95 | 39.4 / 43.4 ms |
| Before B / two live / after eviction | 1 / 2 / 1 sockets; 1 / 2 / 1 runtime handles |

Final second-pass verification run on 2026-09-03, artifact
`/tmp/codex/perf-run-6.json`:

| Measurement | Result |
|---|---:|
| Cold B visible / ready | 97.9 / 830.5 ms |
| Retained visible p50 / p95 (10 samples) | **55.3 / 67.3 ms** |
| Retained ready p50 / p95 (10 samples) | **55.3 / 67.3 ms** |
| Full A -> B -> A cycle p50 / p95 | 118.0 / 122.2 ms |
| Before B / two live / after eviction | 1 / 2 / 1 sockets; 1 / 2 / 1 runtime handles |

Vitest did not expose `global.gc`, so RSS and heap are allocator high-water
samples. Socket counts are physical bridge state. The
`lodyLiveRuntimeHandleCount` metric increments on `created` and decrements only
after the awaited `disposed` event, so it is explicitly a handle counter rather
than repo-allocation evidence. Constructor rollback now makes the old blind
spot impossible: after `LoroRepo.create()` succeeds, every later throw awaits
transport/listener teardown and `repo.destroy()` before `failed`, so a leaked
pre-handle repo cannot survive claim release. Capacity remains two and must not
be raised. The jsdom margin gates are p50 < 100 ms and p95 < 150 ms;
both pass. A real browser still adds layout and paint for the revealed DOM, so
release verification should retain a browser trace. Never enable
`BLITZ_LODY_LIVE_TURN`. A merge still requires explicit user approval because
main deploys canary immediately.

## Final correctness closure (2026-09-03)

| Finding | Status | Closure |
|---|---|---|
| F1 | **Closed** | Attempt-ID lifecycle promises replace wrapper counters; the 10-second diagnostic never releases a claim. Construction eviction, two StrictMode attempts, and the no-attempt early return are gated. |
| F2 | **Closed** | `createWorkspaceRuntime` rolls attached resources and the repo back before rejection; the fake-repo gate proves destroy-before-`failed`, claim release ordering, and same-identity recreation. |
| F3 | **Closed** | Storage and same-page policy notifications resize a mounted pool immediately. |
| F4 | **Closed** | Memory-present and memory-absent desktop/mobile branches are explicit and unit tested against the shell's shared breakpoint. |
| F5 | **Closed** | Ambient IPC is allowlisted by helper plus enclosing function; the equal-count guarded-to-unguarded mutation fails. |
| F6 | **Closed** | The metric is renamed `lodyLiveRuntimeHandleCount`; constructor rollback, not the metric, excludes pre-handle repo leaks. |
| F7 | **Closed** | Conversation and Radix offsets use selector/index semantic keys and re-resolve replacement nodes. Real Chromium layout/virtualizer verification remains a manual release check. |
| F8 | **Closed** | Bridge-construction function identities participate in the mount token, forcing serialized remount instead of partial prop update. |
| F9 | **Closed** | Reveal markers and the `effects-settled` timer exist only for an active probe trace. |
| F10 | **Closed** | Seam 18 is labeled as a cumulative upstream inventory and the branch aggregate is recorded in `BLITZ-PATCHES.md`. |
| F11 | **Closed** | The discarded pure pool-disposal call was deleted; React child unmount remains the real teardown path. |

The three review simplifications are also closed: lifecycle state is one promise
per real attempt, production measurement work is opt-in, and
`lodySurfaceIdentityKey` is the sole identity key/equality implementation used
by the pool, `SessionSurface`, and the claim queue. Previously partial S1-F1,
S1-F4, C-F1, C-F2, C-F4, C-F6, C-F7, C-F8, and C-F9 are therefore closed; the
previously closed or explicitly accepted Sonner limitation remains unchanged.

## Upstream/conflict strategy

The client abstraction is generic Lody infrastructure: no Blitz URL, workspace
membership, or relay concept belongs in it. Submit it to the public Lody fork,
then re-pin the subtree rather than carrying a second implementation as a
permanent Blitz patch. Keep IPC isolation, store-cache isolation, and the
Blitz-owned LRU in separate commits so an upstream re-pin can accept or drop
each seam independently.
