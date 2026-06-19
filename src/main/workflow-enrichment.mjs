// workflow-enrichment.mjs — spawn the fresh ENRICHMENT agent for a live workflow run.
//
// generic-live-first: run_workflow already placed a generic live widget bound to the runId. This spawns a
// short-lived `claude -p --model opus --effort low` whose duty (blitzos-externalize.md) is: read the script
// + the generic widget, rewrite it into a bespoke live view, COMPILE-GATE it (scripts/compile-widget.mjs),
// and only on PASS post it in place via the localhost control API (update_surface). It is NOT a session
// fork — a focused fresh agent with the run's context injected. Best-effort: if claude is absent or it
// fails, the generic widget stands. Disable with BLITZ_WF_ENRICH=0.
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DUTY = fileURLToPath(new URL('./blitzos-externalize.md', import.meta.url))

let _deps = null
/** deps: { repoRoot:string, claudeCmd?:string, getWorkspacePath?():string|null } */
export function wireEnrichment(deps) { _deps = deps || null }

export function spawnWorkflowEnrichment({ runId, surfaceId, file, view = 'graph', memDir } = {}) {
  if (!_deps || process.env.BLITZ_WF_ENRICH === '0') return
  const root = _deps.repoRoot
  if (!root || !surfaceId || !file || !runId) return
  const generic = join(root, 'widgets', view === 'kanban' ? 'wf-kanban.jsx' : 'wf-graph.jsx')
  const compile = join(root, 'scripts', 'compile-widget.mjs')
  if (!existsSync(DUTY) || !existsSync(generic) || !existsSync(compile)) return
  const out = join(memDir || root, 'widget.enriched.jsx')
  try { if (memDir) mkdirSync(memDir, { recursive: true }) } catch { /* best-effort */ }

  let prompt
  try {
    prompt = readFileSync(DUTY, 'utf8')
      .replaceAll('{{RUN_ID}}', String(runId))
      .replaceAll('{{SURFACE_ID}}', String(surfaceId))
      .replaceAll('{{SCRIPT}}', String(file))
      .replaceAll('{{GENERIC}}', generic)
      .replaceAll('{{OUT}}', out)
      .replaceAll('{{COMPILE}}', compile)
  } catch { return }

  const cmd = _deps.claudeCmd || 'claude'
  try {
    const child = spawn(cmd, ['-p', '--model', 'opus', '--effort', 'low', '--dangerously-skip-permissions', prompt], {
      cwd: (_deps.getWorkspacePath && _deps.getWorkspacePath()) || root,
      stdio: 'ignore',
      env: process.env
    })
    child.on('error', () => { /* claude not installed / failed to spawn — the generic widget stands */ })
    if (typeof child.unref === 'function') child.unref()
  } catch { /* never block the run */ }
}
