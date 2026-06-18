# B1 patch — placeOnStage auto-evict on home_full (DRAFT, not applied)

_For finding #2 (onboarding-dogfood) / issue onboarding-board-overflows-small-stage. Closes the hard-fail that blocks the resident's first surface when the seed hands off the board saturated. Drafted 2026-06-15, NOT applied._

**File:** `src/main/os-tools.mjs`, inside `makeOsTools(ops)`.

## Idea
`placeOnStage` stays pure (it only computes a slot). Add two helpers next to it, and route the **explicit** stage actions (`place_widget`, `bring_home`) through an evicting wrapper. On budget/space full, park the lowest-value tile (non-pinned, slotted, this stage, not the one being placed; lowest `z` = oldest / most-seeded) just off-stage and retry, up to a few times. `create_surface`'s auto-place is left as park-on-full (unchanged), so only deliberate placements evict. The reply reports what got parked so the agent can tell the user.

## New code — add right after `parkOffstage` is defined (around line 245)

```js
  // Free ONE stage slot for a deliberate placement that must land NOW: park the lowest-value evictable
  // tile (non-pinned, slotted, on THIS stage, not the surface being placed) just off-stage, still alive.
  // Lowest z = oldest / most-seeded = least likely to be the user's active focus. Returns {id,title} or null.
  const evictLowestValue = (stage, exceptId) => {
    const st = ops.getState() || {}
    const victim = (st.surfaces || [])
      .filter((s) => s && s.slot && !s.pinned && (s.slotStage ?? 0) === stage && s.id !== exceptId)
      .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))[0]
    if (!victim) return null
    ops.updateSurface(victim.id, { slot: null, focus: null, ...parkOffstage(victim.agentId) })
    return { id: victim.id, title: victim.title || victim.id }
  }

  // place_widget / bring_home go through this: instead of hard-failing on a saturated stage, park the
  // lowest-value tiles to make room, then retry. Caps evictions so a genuinely un-evictable stage (all
  // pinned) still returns home_full. `evicted` lets the caller tell the user what was parked.
  const placeOnStageEvicting = (sizeArg, near, agentId, dims, pinned, exceptId) => {
    let p = placeOnStage(sizeArg, near, agentId, dims, pinned)
    const evicted = []
    const stage = agentId != null ? stageForAgent(agentId) : 0
    let guard = 0
    while (p.full && guard++ < 6) {
      const parked = evictLowestValue(stage, exceptId)
      if (!parked) break // nothing left to evict — genuinely full
      evicted.push(parked)
      p = placeOnStage(sizeArg, near, agentId, dims, pinned)
    }
    return { ...p, evicted }
  }
```

## Wire the explicit callers

### place_widget — existing-surface path (around line 336)
```diff
-          const p = placeOnStage(a.size, a.near, a.agent ?? cur.agentId, { w: cur.w, h: cur.h }, !!cur.pinned)
-          if (p.full) return { status: 409, body: p.full }
+          const p = placeOnStageEvicting(a.size, a.near, a.agent ?? cur.agentId, { w: cur.w, h: cur.h }, !!cur.pinned, String(cur.id))
+          if (p.full) return { status: 409, body: p.full }
```
...and include `evicted: p.evicted` in that handler's success return so the agent can surface "parked N to make room."

### place_widget — create path (around line 346) and bring_home (around line 362)
Same swap to `placeOnStageEvicting(...)`. For the create path `exceptId` is undefined (the new surface is not in state yet), which is correct. For `bring_home` pass `String(a.id)`.

## Why this is safe
- Only `place_widget` / `bring_home` (explicit "put this on the stage" calls) evict. `create_surface` auto-place and offstage work surfaces are untouched.
- Pinned tiles (the chat hub) are never evicted (`!s.pinned`).
- Evicted tiles are parked, not closed: alive, zoom-out visible, `bring_home`-able. Matches `send_offscreen` semantics exactly (same `ops.updateSurface(... slot:null ... parkOffstage)`).
- Capped at 6 evictions; a stage of all-pinned tiles still returns the honest `home_full`.

## Pairs with B2
B2 (handoff parks 2 low-value cards so the stage opens at ~12/16) is the prompt-side mitigation; B1 is the systemic guarantee that a deliberate placement never hard-fails. Ship B2 for a clean first desktop, B1 so it can never regress.

## Verify after applying
`node --check src/main/os-tools.mjs`, then reproduce: seed a fresh board to 15/16 and confirm a `place_widget l` now lands (parking the lowest-z seeded tile) instead of returning 409, and that the reply lists the parked tile.
