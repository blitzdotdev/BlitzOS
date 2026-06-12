# Onboarding board oversubscribes small stages → permanent stage_full lockout

**Found:** 2026-06-11, live on the VM test rig (the first catch of the host↔VM agent test loop).
**Build:** v0.0.1-10 (`build-agent-runtime-moments-10`), fresh install, onboarding ran on first boot.

## Observed (verbatim from the live system)

`list_state` on the VM after onboarding seeded the case-file board:

```
stage.budget: {"used": 19, "total": 16, "remaining": 0}
place_widget → {"error":"stage_full","reason":"attention budget","stage":0,
                "grid":{"cols":7,"rows":3,"tile":180},"occupied_cells":25,"free_cells":-4}
```

The VM's stage lattice is **7×3 = 21 cells**, but the seeded board occupies **25 cells**
(`free_cells: -4`) and uses **19/16 budget units**. Every subsequent `place_widget` /
`bring_to_stage` fails with `stage_full` — the desktop is permanently locked for agents until
tiles are manually removed.

## Likely mechanism (unverified)

The onboarding director seeds at boot, possibly before the renderer pushes the REAL viewport —
the planner's `findSlot` would then resolve against `DEFAULT_VP` (1600×1000 → an 8×4+ grid) and
mint slots (e.g. col 7) that don't exist on the smaller live lattice. `occupancy()` counts cells
without clamping to lattice bounds, so out-of-bounds tiles still consume budget/cells. The
planner's shrink/park fallback can't help if it ran against the wrong lattice.

## Suggested fixes (pick at least 1+3)

1. Director waits for the first real `os:state` viewport before seeding (or re-derives slots once
   it arrives — slots are re-derived on viewport change already; the PLACER decision is what ran
   against the wrong grid).
2. Planner caps total seeded cells at `min(STAGE_BUDGET, cols*rows - chatCells)` for the LIVE
   lattice, parking the remainder off-stage.
3. `occupancy()`/`budgetUsed()` ignore (or clamp) slots outside the current lattice bounds so an
   oversized persisted board can never hard-lock placement (self-healing on smaller screens).

## Repro

Confirmed display: 1336×835 logical points (@2x, UTM VM) → lattice 7×3 = 21 cells; board seeds 25.
Any display in that class + a fresh onboarding run reproduces. The VM rig reproduces on demand.

## Update 2026-06-11 (build #11, VM): `offstage:true` does NOT bypass the budget gate

The VM agent retested on v0.0.1-11: `place_widget {kind:'native', component:'timeline', offstage:true}`
still returns `{error:'stage_full', reason:'attention budget', occupied_cells:25, free_cells:-3,
used:18/16}` — even after closing two stage tiles. Two additional wrinkles beyond the original
oversubscription: (1) an explicitly OFF-stage placement should not consume on-stage attention
budget at all; (2) closing tiles did not free the tracked budget (used stayed over), suggesting
the budget/occupancy is derived from the persisted oversubscribed slots rather than live state.
Fix 3 (occupancy clamps out-of-bounds slots) likely cures both symptoms with the original cause.
