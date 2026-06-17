# BlitzOS — The Job model (the spine of the user-journey refactor)

Status: SPEC FOR REVIEW (no code written). Terse companion to `plans/blitzos-user-journey.md` (the fuller index). Core finding: there is NO first-class Job object today; agents are uniform peers. A **Job** is the ONE formalized unit of work (it triggers Planning + Execution + steering). **Everything else is a normal request** (a plain user message the agent just handles, no Job record, no plan, no continuation). The OS only formalizes Jobs. B3 / W1 / W2 / E1 all reference the Job object. Decisions touching core persistence or new primitives need sign-off (CLAUDE.md).

## Verified hooks

- Boot-task seam: `setBootTaskProvider`, `index.ts:654` special-cases agent `'0'` only.
- Duty re-read per (re)launch: `agent-runtime.mjs:190`.
- `interview.json` 2-state machine to generalize: `onboarding.ts:561`.
- `RESIDENT_INITIATIVE_BOOT_TASK` `onboarding.ts:680` = today's proactive act-now duty (closest existing self-driven behavior; NOT a formalized Job).
- `spawn_agent` `os-tools.mjs:629` takes only `{title}` = a bare peer (a normal-request agent).
- Per-agent meta.json (`.blitzos/terminals/<id>/meta.json`): `terminal-manager.mjs:120`.
- `watchInterviewDone` `onboarding.ts:705` = the handoff pattern to generalize (fires on a status edge).
- `Surface.agentId` `types.ts:55` = the surface↔thread join key.

## The Job record + lifecycle

```
interface Job {
  id: string
  status: 'proposed' | 'approved' | 'running' | 'done' | 'blocked'
  title: string; goal: string
  agentId: string              // owner/executor (1:1 for v1)
  planSurfaceId?: string; chatSurfaceId?: string; planPath?: string
  contextRefs?: string[]; createdAt: number; updatedAt: number
}
```

Lifecycle: `proposed -> approved -> running -> done | blocked`. A Job ALWAYS plans first (the W1 editable plan widget), gets user approval, then enters `running`: it executes the approved plan under Claude Code `/goal` (the E1 continuation engine), which does NOT stop until the written plan is fully executed, with W2 steering throughout. The agent advances status via tools; BlitzOS reacts to each edge (like `watchInterviewDone`).

## Job vs normal request (what makes it a Job)

A **Job** = a Job record exists: it arms (1) the Planning phase (W1 plan widget + the plan-authoring boot duty) and (2) the E1 `/goal`-gated continuation ("do not stop until the plan is done") + W2 steering. A **normal request** = no Job record: a plain message to an agent (the existing chat, primary `'0'` or a bare `spawn_agent` peer), handled directly, no plan, no continuation. Nothing new is built for normal requests; they are the status quo. A Job is created explicitly via `start_job` (from the Phase-2 entry points, or whenever work is substantial enough to warrant a plan); the "is this a Job" call is the user's/agent's, never OS-baked.

## Sign-off decisions

1. Persistence: Option 1 (extend agent meta.json, 1:1 agent:Job, RECOMMENDED, migration-ready superset) vs Option 2 (dedicated `.blitzos/jobs/<id>.json`, `agentIds[]`, v2 multi-agent). Needs sign-off (core persistence).
2. Add a `start_job` tool (RECOMMENDED, keeps `spawn_agent` the bare-peer / normal-request primitive) vs extend `spawn_agent`.
3. Add a `role:'plan'` surface primitive for the W1 plan widget. Needs sign-off (new architectural primitive).
4. Generalize the boot-task mapper: agentId -> Job -> duty by status (proposed/approved = author plan; running = execute under `/goal`), keeping the `'0' -> interviewBootTask()` fall-through intact.
5. Per-Job `planPath` (RECOMMENDED) so E1's `/goal` reads job-scoped plan.md.
6. Onboarding interview as the FIRST Job (a degenerate plan) vs keep it special. Needs sign-off; ship the mapper fall-through first, unify later.

**Sequencing:** decide persistence -> land `readJob`/`writeJob` -> generalize the mapper (verify '0' unchanged) -> add `start_job` + a status-edge watcher -> add `role:'plan'` join -> hand off to W1/W2/E1.

Risks: the three-serializer footgun (every new persisted field must ride all serializers) + isRuntime parity (a runtime-only surface must be in BOTH predicates: `workspace-host.mjs:124` and `store.ts:1027`).

Cross-refs: `plans/blitzos-user-journey.md`, `plans/blitzos-plan-widget.md` (W1), `plans/blitzos-tick-diff-steer.md` (W2), `plans/blitzos-job-entrypoints.md` (A4/A5), `plans/blitzos-agent-autonomy-guardrails.md` (E1 `/goal` + plan-authoring duty), `plans/onboarding-case-file.md`.
