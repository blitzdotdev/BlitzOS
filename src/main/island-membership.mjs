// island-membership.mjs — the ONE shared isolation core for BlitzIsland (the notch HUD).
//
// Electron-FREE on purpose (no imports at all): scripts/test-island-bridge.mjs imports these REAL helpers
// under plain `node` to prove the leak guard, exactly the os-tools.mjs / stage-core.mjs pure-core split.
// index.ts (which has electron) RECORDS island-spawned ids here and GATES every list/tail/snapshot through
// islandLiveIds, so the HUD only ever shows tabs the island itself spawned — never the user's main canvas
// chat ('0') nor a sibling peer agent (the BUG-2 "mirrors the primary conversation" leak).
//
// MEMBERSHIP MODEL (the cross-part decision — see plans/blitzos-dynamic-island.md). A per-workspace
// IN-MEMORY Map<wsName, Set<id-string>>, INTERSECTED with the (workspace-scoped) live osAgentStatus() at
// READ time, with a SAME-WORKSPACE-ACTIVE-ONLY prune:
//   - cross-workspace id COLLISION solved: keyed by ws NAME, so A's '1' and B's '1' live in different sets;
//     the active-ws read never sees the other workspace's set.
//   - disappear-then-REAPPEAR on a workspace switch solved: a set is NEVER pruned merely on absence — only
//     INTERSECTED at read. Switch away → the id isn't in the active osAgentStatus → not listed; switch back →
//     it's live again AND still in its set → re-listed. No loss.
//   - same-workspace id-REUSE solved: prune an island id from its set ONLY when it is absent from
//     osAgentStatus() AND that workspace is the ACTIVE one (a close is only observable while its ws is active,
//     since closeAgent deletes the agent dir of the active ws). A cross-ws absence never touches another set.
//   - RESTART: the Map empties on a full BlitzOS restart — the ACCEPTED trade. Island agents still resume AS
//     agents (resume-on-boot); only the HUD chip membership resets (a visibility reset, not data loss). The 3
//     bugs do not require restart-survival, and we deliberately do NOT couple readiness to the relay-gated
//     `resumed` flag (that would black out the HUD forever when offline). Documented honestly.
//
// All exports are pure, import-free, and NEVER throw.

// wsName (string) -> Set<id-string>. Module-scoped so the membership survives across reconnects within one
// BlitzOS process (a reconnect re-subscribes; the set is unchanged) but resets on a full restart (the trade).
const islandIdsByWorkspace = new Map()

// TODO(island): no workspace:delete prune — deleting a workspace leaks its (handful of short) id strings in
// the Map until the process exits. Bounded + intentional; a future forgetIslandWorkspace(name) hook can clear
// it. Not worth a workspace-lifecycle subscription for a few bytes per deleted workspace.

/** The island-id Set for a workspace NAME (created on first touch). Keyed by name (not path) so the read gate
 *  and the recorder agree on the same bucket regardless of how the caller resolved the ws. */
export function islandSetFor(ws) {
  const k = String(ws || '')
  let s = islandIdsByWorkspace.get(k)
  if (!s) {
    s = new Set()
    islandIdsByWorkspace.set(k, s)
  }
  return s
}

/** Record an island-spawned id into a workspace's set. The {id:''} failed-spawn guard lives HERE so callers
 *  can record unconditionally — an empty/nullish id is a no-op (a failed spawn never becomes a member). */
export function recordIslandId(ws, id) {
  const s = String(id ?? '')
  if (!s) return
  islandSetFor(ws).add(s)
}

/** The READ gate: the island ids of a workspace that are ALSO currently live in statusObj (the workspace-
 *  scoped osAgentStatus() map). This is the ONE filter every list/tail/snapshot runs through. The id!=='0'
 *  belt-and-suspenders means '0' (the user's main canvas chat) can never leak even if a future stray add put
 *  it in a set. islandLiveIds ⊆ Object.keys(statusObj), so statusObj[id] is always defined for the caller. */
export function islandLiveIds(ws, statusObj) {
  const mine = islandSetFor(ws)
  return Object.keys(statusObj || {}).filter((id) => id !== '0' && mine.has(String(id)))
}

/** Prune island ids no longer present in statusObj. Call ONLY for the ACTIVE workspace — a close is only
 *  observable while its ws is active (closeAgent deletes the active ws's agent dir first), so pruning on the
 *  active ws closes the same-ws id-reuse hole WITHOUT ever dropping an island agent that is merely sitting in
 *  another (inactive) workspace. NEVER call this for a non-active ws (that would re-introduce the loss the
 *  intersect-not-prune model exists to avoid). */
export function pruneIslandIds(ws, statusObj) {
  const mine = islandSetFor(ws)
  const live = statusObj || {}
  for (const id of [...mine]) if (live[id] == null) mine.delete(id)
}

/** Test-only visibility: how many workspaces have an island set (lets a test assert isolation buckets exist
 *  without reaching into the module-private Map). */
export function islandWorkspaceCount() {
  return islandIdsByWorkspace.size
}
