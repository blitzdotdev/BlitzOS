// workflow-enrichment.mjs — DISABLED in V1 (island-only).
//
// This used to spawn a short-lived `claude -p` whose duty (the now-deleted blitzos-externalize.md) was to
// rewrite a live workflow widget into a bespoke live view on the canvas. V1 has no canvas widgets and
// reports workflow progress IN CHAT, so the live-viz enrichment is deferred with widgets / island-native
// surfaces (see plans/blitzos-v1-cut-plan.md). The exports stay as no-ops so callers (index.ts,
// workflow-host.mjs) keep their signatures; restore the real implementation from branch history when the
// experimental surfaces (and the wf-graph/wf-kanban live widgets) return.

let _deps = null
/** deps: { repoRoot:string, claudeCmd?:string, getWorkspacePath?():string|null } — recorded but unused in V1. */
export function wireEnrichment(deps) { _deps = deps || null }

/** No-op in V1: workflow progress is reported in chat, there is no live widget to enrich. */
export function spawnWorkflowEnrichment(_info) { /* deferred — see file header */ }
