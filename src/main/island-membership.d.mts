// Hand-written declarations for island-membership.mjs (typecheck enforces a .d.mts sibling for every .mjs that
// a .ts file imports — same mechanism as island-bridge.mjs/island-bridge.d.mts and os-tools.mjs/os-tools.d.mts).
// Pure-node, no electron types. The ONE shared isolation core: a per-workspace in-memory Map<wsName,Set<id>>
// intersected with the live agent-status map at read time. See island-membership.mjs for the full model.

/** The island-id Set for a workspace NAME (created on first touch). */
export function islandSetFor(ws: string): Set<string>

/** Record an island-spawned id into a workspace's set ({id:''} failed-spawn is a no-op). */
export function recordIslandId(ws: string, id: string): void

/** The READ gate: a workspace's island ids that are ALSO live in statusObj (with a hard id!=='0' exclusion). */
export function islandLiveIds(ws: string, statusObj: Record<string, string>): string[]

/** Prune island ids absent from statusObj. Call ONLY for the ACTIVE workspace (closes the id-reuse hole). */
export function pruneIslandIds(ws: string, statusObj: Record<string, string>): void

/** Test-only: how many workspaces have an island set. */
export function islandWorkspaceCount(): number
