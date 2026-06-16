# Onboarding fixes — staged drafts (DRAFT, nothing applied)

_Drafted by the resident agent 2026-06-14, follows onboarding-dogfood-2026-06-14.md. Two HIGH findings turned into concrete edits. Review, then I apply on your ok._

---

## Fix A — stop the first-task pointing at an empty leftover doc (findings #1 + #3)

**Where:** `src/main/blitzos-interview.md`, Finish step 2 (the "First task for the resident" instruction). Pure prompt edit, no code.

**Why:** the sign-in beat already says "a leftover open tab is not a workflow," but the first-task instruction does not carry that rule, so the interviewer wrote _"the background agent Google Doc is open and is the live spec"_ for a doc that was empty. It also conflated "Google Docs is in scope" with "this specific open doc is the task."

**Current (step 2, end):**
> End the file with a **"First task for the resident"** line pointing it at those live tools: explore each to discover the relevant workflow, then start the most useful REVERSIBLE one ...

**Proposed addition (append to step 2):**
> The first task names a TOOL and an action ("explore Gmail, triage the inbox"), never a specific open document as "the spec." An open tab or doc is a starting point to look at, not the work: do not call any file "the live spec" unless you opened it and confirmed it has real content. If a tool's open artifact is empty or clearly leftover, say so and point the resident at discovering the workflow instead. Tool-in-scope (the checklist) is not the same as artifact-is-the-task (what is actually in the tool).

**Also (one line, same file, "Get them signed in" section):** when confirming each tab, note empty/leftover tabs explicitly so the first-task step does not treat them as work.

---

## Fix B — the board hands off saturated, blocking the resident's first surface (finding #2)

**Root cause (confirmed in code):** the seed is a FIXED layout that deliberately fills the stage (`src/main/onboarding-board.mjs` line ~16: _"stage past the agents' soft STAGE_BUDGET (it IS the user's first desktop)"_). `STAGE_BUDGET = 16` (`stage-core.mjs`). On handoff the stage sits at 15/16, and `placeOnStage` in `src/main/os-tools.mjs` HARD-FAILS when `budgetUsed + span > STAGE_BUDGET`:

```js
if (!pinned && budgetUsed(surfaces, stage) + sp.c * sp.r > STAGE_BUDGET) {
  return { full: { error: 'stage_full', reason: 'attention budget', ...stageSummary(...) } }
}
```

The comment says it returns occupants "so the agent can evict," but the fresh resident is never told to evict, so its first `place_widget` just fails. Two-part fix:

### B1 (systemic, preferred) — auto-evict the lowest-value tile instead of hard-failing
In `os-tools.mjs`, when the budget check trips, pick the lowest-value evictable tile (non-pinned, board-seeded, smallest attention contribution / lowest z), park it off-stage via the existing `parkOffstage` path, and retry the placement once. Only return `stage_full` if nothing is evictable. Sketch at the budget-check site:

```js
if (!pinned && budgetUsed(surfaces, stage) + sp.c * sp.r > STAGE_BUDGET) {
  const victim = lowestValueEvictable(surfaces, stage) // non-pinned, has .slot, lowest z
  if (victim) { ops.sendBackstage?.(victim.id); return placeOnStage(sizeArg, near, agentId, dims, pinned) }
  return { full: { error: 'stage_full', reason: 'attention budget', ...stageSummary(...) } }
}
```

This makes the resident's first act never hit a wall; the least important card yields and stays alive off-stage (zoom-out visible, `bring_to_stage`-able). Add a one-line `say` so the user sees which card was parked.

### B2 (cheap mitigation) — leave headroom on handoff
In `blitzos-interview.md` Finish, before step 3 (mark done): park the 2 lowest-value seeded cards off-stage (`send_backstage`) so the stage hands off at ~12/16. Preserves a rich first desktop during onboarding while giving the resident room to show its first work without reshuffling the user's view.

**Recommendation:** ship B2 now (one prompt line, zero code risk) and B1 as the durable systemic fix. B1 also closes the standalone issue `onboarding-board-overflows-small-stage.md`.

---

## Apply order
1. Fix A (prompt edit, blitzos-interview.md) — smallest, highest clarity.
2. Fix B2 (prompt edit, handoff headroom).
3. Fix B1 (code, os-tools.mjs auto-evict) — needs a quick review of `lowestValueEvictable` + a `sendBackstage` op on `ops`.
