# BlitzOS — Job/Task WorkUnit Model

Status: SPEC FOR REVIEW (no code written). This is the spine for `plans/blitzos-user-journey.md`: first-class Job/Task work-units do not exist in BlitzOS today, and B3 job framing, the J-split, W1's widget binding, W2's steering target, E1 continuation arming, and the A4 Send payload all depend on them. All persistence and primitive additions below are review decisions, not settled implementation, because CLAUDE.md says the agent is swappable policy and BlitzOS supplies content-agnostic loop infrastructure, "perception is dumb-but-rich and the agent decides" (`CLAUDE.md:11`).

## Decisions already made

- W2 uses Option A: BlitzOS only ticks, diffs, and emits the diff as a perception moment. The agent owns all steering judgment. There are zero per-task, stuck, or threshold heuristics in the OS. This follows the doctrine that "No per-task detection" belongs in BlitzOS (`CLAUDE.md:59`).
- A/B entry points share one Raycast-like input component with two shells: a global non-activating NSPanel for A, and an in-app keybind HUD for B. Both expose the same affordances: text prompt, drag-drop files and folders, add-browser-window, and Send. This doc only specifies the WorkUnit payload that Send needs; `plans/blitzos-job-entrypoints.md` owns the shells.

## Current state (verified)

- There is one real persisted lifecycle, and it is onboarding-only. `InterviewState` is binary, `state: 'pending' | 'done'` (`src/main/onboarding.ts:561-562`), `writeInterview` writes only `interview.json` (`src/main/onboarding.ts:578-580`), and `ensureInterviewArtifacts` initializes `pending` when absent (`src/main/onboarding.ts:646`). This is the template to generalize, not a reusable work unit.
- The interview-to-resident handoff is a status-edge watcher, not a generic work lifecycle. `watchInterviewDone` polls `interview.json` (`src/main/onboarding.ts:705-709`) and on `done` calls `osClearBrainContext('0')` (`src/main/onboarding.ts:712-713`). A WorkUnit watcher should reuse this edge-triggered shape.
- Agents are the de facto unit today. Terminal metadata is `<workspace>/.blitzos/terminals/<id>/{meta.json, transcript.jsonl}` (`src/main/terminal-manager.mjs:1-6`), `publicMeta` exposes terminal and agent runtime fields but no work mode or work status (`src/main/terminal-manager.mjs:71-75`), and `spawnTerminal` writes `kind`, `title`, `status`, runtime ids, and timestamps (`src/main/terminal-manager.mjs:156-172`).
- `workspace-host.addAgent` persists only an agent record and an optional orchestrators flag. It writes `{ id, kind:'agent', title, stage: 0, createdAt, orchestrators? }` (`src/main/workspace-host.mjs:641-651`) and launches the visible terminal (`src/main/workspace-host.mjs:655-656`). There is no Job/Task role or supervisor relationship at this layer.
- Multi-peer spawn exists, but the peers are uniform. `newAgentId` returns the next numeric id (`src/main/workspace-host.mjs:625-630`), `osSpawnAgent` mints an id and calls `wsHost.addAgent` (`src/main/osActions.ts:917-925`), and `/spawn_agent` accepts only `{title}` (`src/main/os-tools.mjs:641-648`). This is B3's spawn substrate without the Job wrapper.
- The duty injection seam already exists and is the right hook. `setBootTaskProvider` stores an optional provider (`src/main/agent-runtime.mjs:75-82`), `prepareAgentLaunch` re-reads it on every launch (`src/main/agent-runtime.mjs:225-228`), and `buildBootstrap` injects the returned duty as "one standing task" (`src/main/agent-runtime.mjs:107-109`).
- The current duty mapper is still not a WorkUnit mapper. It checks the per-agent orchestrators flag, then falls through to `String(id) === '0' ? interviewBootTask() : null` (`src/main/index.ts:1059-1063`). This preserves onboarding but leaves all non-orchestrator peers with no structured duty.
- Today's Task-like duty is prose, not structure. `RESIDENT_INITIATIVE_BOOT_TASK` tells the agent to "start one safe reversible initiative immediately" (`src/main/onboarding.ts:680-681`) and to ask only before irreversible outward acts (`src/main/onboarding.ts:681`). It is the closest act-now duty for Tasks, but it is not a record, status, or lifecycle.
- Surface joins already have the needed agent key. `Surface` has `role?` (`src/renderer/src/types.ts:51-53`) and `agentId?: string`, "the agent/thread this surface belongs to" (`src/renderer/src/types.ts:54-55`). `buildAgentSurface` creates `role: 'chat'` with `agentId: String(agentId)` (`src/main/workspace-host.mjs:589-594`). A plan surface can bind through the same key.
- Chat is runtime-only today. `nodeKind` returns null for `role === 'chat'` (`src/main/workspace.mjs:70-73`), while host and renderer have mirrored runtime predicates (`src/main/workspace-host.mjs:124-132`, `src/renderer/src/store.ts:755-763`). A new `role:'plan'` must choose file-backed persistence or runtime-only parity explicitly.
- The single tool registry is the extension point. `makeOsTools(ops)` builds the shared tool registry (`src/main/os-tools.mjs:176-184`), and `/spawn_agent` lives there as the bare peer primitive (`src/main/os-tools.mjs:641-648`). WorkUnit transitions must be registered here so Electron, localhost, and relay share behavior.
- W2's current canvas diff is not a work-status diff. `diffCanvasOps` handles renderer state pushes (`src/main/osActions.ts:678-679`) and emits open, close, move, resize geometry ops (`src/main/osActions.ts:685-702`). WorkUnit status belongs beside W2 as a target and payload input, but W2's decided rule remains Option A: the OS ticks, diffs, and emits perception while the agent owns steering judgment. CLAUDE.md explicitly says "No per-task detection" belongs in BlitzOS (`CLAUDE.md:59`).

## What to build

### WorkUnit record and lifecycle

DECISION THAT NEEDS USER SIGN-OFF: add a first-class WorkUnit primitive. This is an architectural core addition.

Proposed record:

```ts
interface WorkUnit {
  id: string
  mode: 'job' | 'task'
  status: 'proposed' | 'approved' | 'running' | 'done' | 'blocked'
  title: string
  goal: string
  agentId: string
  agentIds?: string[]
  planSurfaceId?: string
  chatSurfaceId?: string
  planPath?: string
  contextRefs?: string[]
  createdAt: number
  updatedAt: number
}
```

Lifecycle: `proposed -> approved -> running -> done | blocked`. The lifecycle generalizes `interview.json`'s `pending | done` machine (`src/main/onboarding.ts:561-562`) and its edge watcher (`src/main/onboarding.ts:705-713`) into a reusable unit that BlitzOS can observe and react to.

### Job vs Task

- A Job is a WorkUnit with `mode:'job'`. It arms Planning, the W1 editable plan widget, and E1 continuation after approval. The Job duty should tell the agent to author the plan, bind the plan widget, wait for approval, and execute only after status reaches `running`.
- A Task is a WorkUnit with `mode:'task'`. It skips Planning and runs the act-now duty. Today's resident initiative duty is the closest existing template because it says to start reversible work immediately (`src/main/onboarding.ts:680-681`).
- The only structural difference is duty selection plus continuation arming: Job gets the plan-authoring or execute duty and may arm E1 when `running`; Task gets the act-now duty and never arms plan-gated continuation.
- W2 does not judge progress. It receives a WorkUnit target and emits content-agnostic diffs, matching the doctrine that BlitzOS supplies the loop and the agent is the swappable policy (`CLAUDE.md:11`, `CLAUDE.md:59`).

### Persistence options

DECISION THAT NEEDS USER SIGN-OFF: persistence touches core state.

- Option 1, lighter, recommended for v1: extend the existing per-agent `meta.json` with `workMode`, `workStatus`, `goal`, `planSurfaceId`, `chatSurfaceId`, `planPath`, and `contextRefs`. This reuses the single terminal meta serializer (`src/main/terminal-manager.mjs:24-45`) and the existing agent restore path (`src/main/terminal-manager.mjs:264-280`). It assumes `1:1 agent:work-unit`, which matches v1 B3 and keeps `spawn_agent` as the bare peer primitive.
- Option 2, heavier: create dedicated `.blitzos/work/<id>.json` records with `agentIds[]`. This decouples the WorkUnit from any one terminal and is the cleaner shape for v2 multi-agent jobs. It adds a new persistence path that must hydrate, list, update, and survive restart alongside terminal meta and workspace surfaces.
- Recommendation: sign off Option 1 now, but implement the reader/writer behind `readWorkUnit` and `writeWorkUnit` so Option 2 is a storage migration, not a contract rewrite. Store `agentId` now and reserve `agentIds` for the v2 fan-out shape.

### Duty selection by mode

Generalize the current provider from `orchestrators -> agent '0' interview -> null` (`src/main/index.ts:1059-1063`) to:

1. Resolve `agentId -> WorkUnit`.
2. If no WorkUnit, preserve current behavior exactly: existing orchestrators flag if present, then `agent '0' -> interviewBootTask()`, else null.
3. If `mode:'task'` and status is `proposed | approved | running`, return the act-now Task duty.
4. If `mode:'job'` and status is `proposed | approved`, return the W1 plan-authoring duty.
5. If `mode:'job'` and status is `running`, return the E1 execute duty.
6. If status is `done | blocked`, return null.

This uses the existing launch seam: `prepareAgentLaunch` already re-reads the provider per launch (`src/main/agent-runtime.mjs:225-228`) and injects the duty into the bootstrap (`src/main/agent-runtime.mjs:107-109`).

### Status transition tools

Add transition tools to the one `makeOsTools` registry (`src/main/os-tools.mjs:176-184`), not to one transport only:

- `start_work_unit {mode,title?,goal,contextRefs?}` or two thin aliases `start_job` and `start_task`.
- `propose_plan {workUnitId, planSurfaceId?, planPath?}` for W1 binding and plan publication.
- `set_work_status {workUnitId, status}` for `approved`, `running`, `done`, and `blocked` transitions.

These tools must write the WorkUnit record and let BlitzOS react. Examples: on `approved -> running`, re-exec or clear context like the interview handoff (`src/main/onboarding.ts:712-713`); on `running -> done | blocked`, disarm E1 and surface completion; on `proposed -> approved`, keep the plan widget and chat target bound.

### WorkUnit to surfaces join

- `agentId` is the current surface-to-thread join (`src/renderer/src/types.ts:54-55`), and chat already uses `role:'chat'` plus `agentId` (`src/main/workspace-host.mjs:589-594`).
- `chatSurfaceId` can be derived from the existing chat convention, `chat` for agent `0` and `chat-<id>` for peers (`src/main/workspace-host.mjs:392`).
- `planSurfaceId` is new and belongs on the WorkUnit. W1 owns widget mechanics in `plans/blitzos-plan-widget.md`; this doc only requires that the plan widget bind back to the WorkUnit and agent.
- DECISION THAT NEEDS USER SIGN-OFF: adding `role:'plan'` is a new surface primitive. If it is file-backed, thread the field through surface descriptors and workspace persistence. If it is runtime-only, update both runtime predicates together (`src/main/workspace-host.mjs:124-132`, `src/renderer/src/store.ts:755-763`).

### B3 and J-agents semantics

B3 becomes "spawn an agent wrapped by a WorkUnit", not "spawn a special agent kind". The spawn substrate is already present: `/spawn_agent` starts a peer with its own thread (`src/main/os-tools.mjs:641-648`), `osSpawnAgent` mints the id (`src/main/osActions.ts:917-925`), and `addAgent` writes the agent record (`src/main/workspace-host.mjs:641-651`). The missing layer is WorkUnit role, lifecycle, and target binding.

J-agents v1 can remain one WorkUnit to one agent. J-agents v2 needs Option 2 or an Option 1 migration path where one Job has `agentIds[]`, one supervisor relationship, and one shared status surface. Multi-peer spawn is not the blocker; coordinated roles and supervisor ownership are.

## Sequencing

1. Get sign-off on WorkUnit as an architectural primitive and on persistence Option 1 vs Option 2.
2. Add the WorkUnit reader/writer and status enum, with tests around malformed, missing, and status-transition records.
3. Generalize the boot-task provider, preserving the existing orchestrators path and `agent '0' -> interviewBootTask()` fall-through.
4. Add `start_work_unit` or `start_job` plus `start_task`, then add `propose_plan` and `set_work_status` to `makeOsTools`.
5. Wire status-edge reactions: approved to running handoff, E1 arm/disarm for Jobs only, completion and blocked surfaces.
6. Add the WorkUnit to surface joins: `chatSurfaceId`, `planSurfaceId`, and the `role:'plan'` decision needed by W1.
7. Hand off to sibling specs: W1 plan widget, W2 tick/diff/steer, E1 continuation, and A/B entry points.

## Risks

- Three-serializer footgun: adding a Surface field like `workUnitId` or `role:'plan'` must be carried through the renderer type (`src/renderer/src/types.ts:31-55`), main descriptor (`src/main/osActions.ts:23-43`), store update paths (`src/renderer/src/store.ts:224-225`), and workspace persistence where applicable (`src/main/workspace.mjs:70-78`). Silent drops on restart are likely if this is partial.
- Runtime parity guard: if the plan surface is runtime-only, host and renderer predicates must stay in lockstep. The host comment says they "MUST match" (`src/main/workspace-host.mjs:124-126`), and the renderer keeps runtime surfaces separately during reconcile (`src/renderer/src/store.ts:755-763`).
- Provider regression: `setBootTaskProvider` must keep onboarding unchanged. Agent `0` still needs `interviewBootTask()` while no WorkUnit exists (`src/main/index.ts:1059-1063`), and `watchInterviewDone` must still fire the current handoff (`src/main/onboarding.ts:705-713`).
- Task heuristic leakage: the OS must not infer stuckness, success, or task semantics. W2 Option A is decided: BlitzOS emits ticks and diffs, the agent judges. CLAUDE.md forbids per-task detection in BlitzOS (`CLAUDE.md:59`).
- Option 1 migration pressure: `1:1 agent:work-unit` is the smallest v1, but v2 multi-agent jobs need `agentIds[]`. Keep the public WorkUnit shape decoupled from storage so Option 2 can replace the backing store.
- Existing orchestrators flag: current duty routing already reserves a per-agent meta flag for orchestrator mode (`src/main/index.ts:1060-1062`). WorkUnit precedence with orchestrators must be explicit before implementation.

## Open decisions

1. DECISION THAT NEEDS USER SIGN-OFF: add WorkUnit as a core architectural primitive with the lifecycle `proposed -> approved -> running -> done | blocked`.
2. DECISION THAT NEEDS USER SIGN-OFF: persistence Option 1 on per-agent `meta.json` vs Option 2 dedicated `.blitzos/work/<id>.json`. Recommendation: Option 1 for v1, storage abstraction ready for Option 2.
3. DECISION THAT NEEDS USER SIGN-OFF: expose one `start_work_unit` tool or separate `start_job` and `start_task` tools. Recommendation: separate aliases for user-facing clarity, shared implementation internally.
4. DECISION THAT NEEDS USER SIGN-OFF: add `role:'plan'` as file-backed or runtime-only. Recommendation: file-backed or WorkUnit-owned `planSurfaceId` plus persisted plan content, avoiding runtime-only loss unless W1 explicitly wants ephemeral UI.
5. DECISION THAT NEEDS USER SIGN-OFF: onboarding as the first WorkUnit vs special path. Recommendation: preserve the special path first, then unify after WorkUnit behavior is stable.
6. DECISION THAT NEEDS USER SIGN-OFF: precedence between existing orchestrator duty and WorkUnit duty for agents with both flags.
7. DECISION THAT NEEDS USER SIGN-OFF: Option 2 timing for v2 J-agents. Recommendation: do not block v1, but keep `agentIds[]` in the schema.

## Cross-references

- `plans/blitzos-user-journey.md`: journey index and sequencing.
- `plans/blitzos-job-task-model.md`: this spine document, owns WorkUnit.
- `plans/blitzos-plan-widget.md`: W1 editable plan widget and E3 status surface.
- `plans/blitzos-tick-diff-steer.md`: W2 supervisor heartbeat, Option A.
- `plans/blitzos-job-entrypoints.md`: Phase 2 A/B shared input, A4 Send payload, A5 menubar, and notifications.
- `plans/blitzos-agent-autonomy-guardrails.md`: E1 continuation engine and the agent's Phase-1 plan-authoring duty.
- `plans/onboarding-case-file.md`: Phase 1 onboarding and the current interview lifecycle.
