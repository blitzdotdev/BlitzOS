# BlitzOS — The Job/Task WorkUnit (the spine of the user-journey refactor)

Status: SPEC FOR REVIEW (no code written). Terse companion to `plans/blitzos-user-journey.md` (the fuller index). Core finding: there is NO first-class Job/Task object today; agents are uniform peers. This WorkUnit is the linchpin the J-split / B3 / W1 / W2 / E1 all reference. Decisions touching core persistence or new primitives need sign-off (CLAUDE.md).

## Verified hooks

- Boot-task seam: `setBootTaskProvider`, `index.ts:654` special-cases agent `'0'` only.
- Duty re-read per (re)launch: `agent-runtime.mjs:190`.
- `interview.json` 2-state machine to generalize: `onboarding.ts:561`.
- `RESIDENT_INITIATIVE_BOOT_TASK` `onboarding.ts:680` = today's Task duty (acts now, no plan gate).
- `spawn_agent` `os-tools.mjs:629` takes only `{title}`.
- Per-agent meta.json: `terminal-manager.mjs:120`.
- `watchInterviewDone` `onboarding.ts:705` = the handoff pattern to generalize (fires on a status edge).
- `Surface.agentId` `types.ts:55` = the surface↔thread join key.

## The WorkUnit record + lifecycle

```
interface WorkUnit {
  id: string
  mode: 'job' | 'task'         // job arms planning + continuation; task acts now
  status: 'proposed' | 'approved' | 'running' | 'done' | 'blocked'
  title: string; goal: string
  agentId: string              // owner/executor (1:1 for v1)
  planSurfaceId?: string; chatSurfaceId?: string; planPath?: string
  contextRefs?: string[]; createdAt: number; updatedAt: number
}
```

Lifecycle: `proposed -> approved -> running -> done | blocked` (a Task skips approval: `proposed -> running -> done`). Agent advances via tools; BlitzOS reacts to each edge (like `watchInterviewDone`).

## Job vs Task (the ONLY structural difference)

(1) which boot-task duty string is injected, and (2) whether the plan-gated E1 continuation arms (a Task NEVER arms it). Nothing else: both are agent + chat + terminal (+ plan widget for a Job).

## Sign-off decisions

1. Persistence: Option 1 (extend agent meta.json, 1:1, RECOMMENDED, migration-ready superset) vs Option 2 (dedicated `.blitzos/work/<id>.json`, `agentIds[]`, v2 multi-agent). Needs sign-off (core persistence).
2. Add `start_job`/`start_task` tools (RECOMMENDED, keeps `spawn_agent` the bare-peer primitive) vs extend `spawn_agent`.
3. Add a `role:'plan'` surface primitive for the W1 plan widget. Needs sign-off (new architectural primitive).
4. Generalize the boot-task mapper, keeping the `'0' -> interviewBootTask()` fall-through intact (then map other agentIds).
5. Per-WorkUnit `planPath` (RECOMMENDED) so E1 reads job-scoped plan.md.
6. Unify onboarding as the first WorkUnit (unifies the two duty strings) vs keep it special. Needs sign-off; ship the mapper fall-through first, unify later.

**Sequencing:** decide persistence -> land `readWork`/`writeWork` -> generalize the mapper (verify '0' unchanged) -> add transition tools + work-status watcher -> add `role:'plan'` join -> hand off to W1/W2/E1.

Risks: the three-serializer footgun (every new persisted field must ride all serializers) + isRuntime parity (a runtime-only surface must be in BOTH predicates: `workspace-host.mjs:124` and `store.ts:1027`).

Cross-refs: `plans/blitzos-user-journey.md`, `plans/blitzos-plan-widget.md` (W1), `plans/blitzos-tick-diff-steer.md` (W2), `plans/blitzos-job-entrypoints.md` (A4/A5), `plans/blitzos-agent-autonomy-guardrails.md` (E1 + plan-authoring duty), `plans/onboarding-case-file.md`.
