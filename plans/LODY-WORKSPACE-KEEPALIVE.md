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
renderer, `LoroRepo`, WASM state, socket, subscriptions, or router. It should
also retain drafts, selection, and scroll position.

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
- `window.repo` had one assignment and no readers. Runtime disposal deletes it
  only while it owns the value. The debug handle cannot retain an evicted repo.
  An older runtime cannot clear a newer runtime's handle.
- Runtime, platform, data-plane, presence, RPC, and session-control paths carry
  `ipcClient` explicitly. Asynchronous file and history paths do too.
- Ambient helper calls remain in Electron-only roots and features. These cover
  onboarding, native windows, terminals, desktop launch, shortcuts, browsers,
  and exports. Blitz does not set `__LODY_ELECTRON__` or mount upstream's root.
  Those paths retain the default client and Electron behavior.
- Shared state was confirmed in `doc-meta.ts`, `machines.ts`, `presence.ts`, and
  `use-machine-flock-rows.ts`. The specific state is `_prevSessionList`,
  `_prevArchivedSessionList`, `_prevAllActiveSessions`, `_prevMachineMetaMap`,
  `_prevOnlineMachineIds`, and workspace-keyed listener maps.
  `auth-client-singleton.ts` and `time-sync.ts` are also module singletons. Each
  needs an explicit keep-alive disposition.
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
  creates one bound client per `SessionSurface`. Terminal disposal aborts its
  signal and drains its listeners idempotently.

The existing helpers take an optional final client argument and delegate to it.
No current Electron caller changes. Do not introduce parallel helpers such as
`sendSurfaceIpc`; one IPC vocabulary makes missed conversions auditable.

Add `IpcClientProvider` with `windowIpcClient` as its context default. React
components use `useIpcClient`. `RuntimeProvider` reads the same context and
passes it to runtime, data-plane, RPC, control, and presence code.
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
   with Rolldown's Oxc TS/TSX AST. It derives `@lody/*` mappings from
   `vendor-bridge.ts` and rejects unresolved imports. Allowances name exact
   helper and enclosing-function pairs, not whole files.

The test must be run once with the client threading neutered and observed
failing before the implementation is accepted.

Mutation checks cover both layers. Replacing `createBoundIpcClient(bridge)`
with the window client produced three routing failures. Removing the client
from `getPublicBrowserBridge(ipcClient)` failed the source audit at its line.
Restoring each mutation made the gate pass.

### Phase A + non-effect Phase B validation record (2026-09-02)

- IPC isolation gate: 10/10 passed, including two real provider trees, disposal,
  import-closure inventory and an actual cloud-mode runtime.
- Focused required Lody floor: 11 files, 79 tests passed, 2 skipped. Two
  concurrent renderer imports exhausted the first aggregate run's hook budget.
  Both files then passed serially with 17 passed and 2 skipped.
- `npm run typecheck`: passed across all workspaces.
- `npm run lint:gate`: passed at 66 anti-slop, 0 house, 8 unchanged max-lines
  warnings.
- `git diff --check`: passed. The temporary Vite filesystem allowlist needed
  for the shared icon dependency was reverted.

### Upstream conflict footprint

Seam 18 touches 21 vendor source files. Seven are central client, provider, or
runtime files. Fourteen are mounted callers. The repetitive caller changes add
one hook, optional client argument, and dependency entries. They do not
restructure components. A pull conflicts only when upstream edits those lines.
The central seam can disappear when the fork PR lands. Keep this phase in its
own commit. A subtree re-pin should not mix it with cache isolation or the LRU.

## Phase B: non-effect shared-state disposition

`packages/webapp/test/lody-two-store-memos.test.ts` interleaves two Jotai
stores. It replaces their inputs with equal values, invalidates derived atoms,
and then diverges one store. Doc-meta, machine
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

`keepalive-pool.ts` is the pure state machine. It exports the capacity of **2
total live surfaces** and an explicit device policy. Capacity is two when
`navigator.deviceMemory >= 4`. Without that hint, desktop-class devices also
use two. Their pointer is fine and `MOBILE_WEBAPP_QUERY` does not match. Every
other device uses one. Entries are
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
entry has a stable React key. It retains its bridge, IPC client, Jotai store,
providers, runtime, repo, router, and route DOM. Owned entries use
LRU eviction. A shared/foreign-grant surface is transient and can coexist only
with the most recently used owned surface. Capability probing temporarily
deactivates the current entry rather than losing the cache.

Inactive route trees sit inside React 19.2 `<Activity mode="hidden">`. This
includes `RouterProvider` and the mobile stack. The store, platform, bridge,
runtime, and agent-config gate stay live above it. One surface owner
above Activity holds the workspace context until eviction. The outer surface is also `hidden`,
`inert`, and `aria-hidden`. Address subscriptions, project backfill, and the
auth-notice two-second poll
also remain live above Activity; they are accepted per-runtime background work.
Reveal restores the last connected focused element. It falls back to the
composer or surface root. jsdom preserves `scrollTop` only as a property-level
approximation. The surface captures known conversation and Radix viewport
offsets before hiding. Its reveal layout effect reapplies them. The jsdom gate
pins this restore. Virtualizer and layout behavior still need manual
Chromium verification.

Ownership tokens accept API publication, router mirroring, the visible rail
wrapper and `window.ipc` only from the active entry. The active toaster is the
sole renderer. Handoff dismisses the global queue, subject to the late-producer
bug above. Every surface keeps its rail mounted in a hidden and inert wrapper.
A matching Activity boundary reveals existing rows without rebuilding their
projections. Reactivation publishes the cached API and compares the shell
address. It navigates only on a real difference. It does not remount the surface.

The active/hidden values live in a small context consumed only by the ownership,
Activity, rail-wrapper, toaster, identity-validation and focus leaves. The
provider/router body is memoized, so flipping ownership does not re-render the
whole runtime tree. Identity revalidation remains fire-and-forget, and the
agent-config gate remains mounted and ready above Activity.

The pool canonicalizes every mount-only target value. These values include the
bridge's `fetchImpl` and `webSocketConstructor` functions. The shell memoizes
its rail binding. This matters outside the probe. `LodySessionsRegion` creates
target descriptions while rendering. Equivalent endpoint objects must not
pierce the retained body's shallow memo comparison.
The surface-pool adapter test pins endpoint-object reuse across reactivation.

The data-plane reports every non-disposal socket loss. That includes failures
before first open and later redials. The bridge forwards explicit identity
changes. A discontinuous hidden entry is evicted immediately. An active entry
becomes non-reusable and re-fetches `/lody/platform`; matching identity restores
continuity and mismatching identity remounts fresh. Surface teardown follows
actual constructor attempts, never wrapper mounts. `RuntimeProvider` emits
`starting` immediately before each `createWorkspaceRuntime()` call and carries
one unique attempt id through `created`, `failed`, and `disposed`. Blitz holds
one completion promise per attempt. Created attempts wait for `disposed`.
`failed` follows constructor rollback. Rollback destroys the partial repo and
detaches installed transports and listeners. If missing slug/workspace id means no attempt starts, teardown has
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

The 2026-09-04 run on a quiet box produced these observable-boundary results.
"Visible" waits for the ownership handoff commit. It includes every reveal
effect and the renders they schedule. `act()` flushes all that work. A browser
paints the revealed DOM earlier. The number is therefore an upper bound on
first paint, not a layout-effect mark. An earlier
run beside two other test jobs measured 149.5 / 238.4 ms for the same rows.

| Measurement | Result |
|---|---:|
| Cold B visible / ready | 154.6 / 323.4 ms |
| Retained visible p50 / p95 (10 samples) | 132.9 / 160.8 ms |
| Retained ready p50 / p95 (10 samples) | 132.9 / 160.8 ms |
| Full A to B to A cycle p50 / p95 | 273.5 / 293.7 ms |
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

The review simplifications are closed. Lifecycle state is one promise per real
attempt. Production has no measurement work. `lodySurfaceIdentityKey` is the
sole identity comparison for the pool, `SessionSurface`, and claim queue.
Previously partial S1-F1, S1-F4, C-F1, C-F2, C-F4, C-F6, C-F7, C-F8, and C-F9
are closed. The Sonner limitation is a known bug with an upstream seam sketch.

## Upstream/conflict strategy

The client abstraction is generic Lody infrastructure. No Blitz URL,
membership, or relay concept belongs in it. Submit it to the public Lody fork.
Then re-pin the subtree instead of carrying a permanent second implementation.
Keep IPC isolation, store isolation, and the Blitz-owned LRU in separate
commits. An upstream re-pin can then accept or drop each seam independently.
