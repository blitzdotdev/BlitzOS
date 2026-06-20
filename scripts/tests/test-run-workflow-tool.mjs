// test-run-workflow-tool.mjs — the run_workflow TOOL handler (os-tools.mjs): it must resolve the generic
// live widget, create it as a transparent srcdoc bound to a fresh runId, and hand the SAME runId + surfaceId
// to the host. Mock ops (no Electron) so the placement + binding logic is exercised headlessly.
import { makeOsTools } from '../../src/main/os-tools.mjs'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

function mkOps() {
  const cap = {}
  const ops = {
    getState: () => ({ surfaces: [] }),
    workspaceContext: () => ({ workspace: 'w', workspace_path: '/tmp/w', siblings: [] }),
    createSurface: (desc) => { cap.desc = desc; return 'srf-1' },
    runWorkflow: async (spec) => { cap.run = spec; return { ok: true, runId: spec.runId, surfaceId: spec.surfaceId } }
  }
  return { ops, cap }
}
const runTool = (tools) => tools.find((t) => t.path === '/run_workflow')

// ── graph view (default) ──
{
  const { ops, cap } = mkOps()
  const res = await runTool(makeOsTools(ops)).handler({ body: JSON.stringify({ file: '/abs/wf-demo.js', view: 'graph' }) })
  ok(cap.desc && cap.desc.kind === 'srcdoc' && cap.desc.lang === 'jsx', 'creates a srcdoc jsx widget')
  ok(cap.desc.props && typeof cap.desc.props.runId === 'string' && cap.desc.props.runId.startsWith('wf_'), 'widget props carry a fresh runId')
  ok(cap.desc.props.transparent === true, 'widget props.transparent = true (frameless)')
  ok(typeof cap.desc.html === 'string' && cap.desc.html.includes('blitz.workflow.subscribe'), 'widget source subscribes to the run')
  ok(cap.desc.html.includes('wfgpulse'), 'graph view loaded wf-graph (its keyframe)')
  ok(cap.run && cap.run.file === '/abs/wf-demo.js', 'host received the workflow file')
  ok(cap.run.runId === cap.desc.props.runId, 'the SAME runId binds the widget and the run')
  ok(cap.run.surfaceId === 'srf-1', 'host received the surfaceId')
  ok(res.ok === true && res.runId === cap.run.runId && res.surfaceId === 'srf-1', 'tool returns ok + runId + surfaceId')
}

// ── kanban view ──
{
  const { ops, cap } = mkOps()
  await runTool(makeOsTools(ops)).handler({ body: JSON.stringify({ file: '/x.js', view: 'kanban' }) })
  ok(cap.desc.html.includes('Queued'), 'kanban view loaded wf-kanban (its Queued column)')
}

// ── distinct runIds across calls ──
{
  const { ops, cap } = mkOps()
  const tools = makeOsTools(ops)
  const r1 = await runTool(tools).handler({ body: JSON.stringify({ file: '/x.js' }) })
  const r2 = await runTool(tools).handler({ body: JSON.stringify({ file: '/x.js' }) })
  ok(r1.runId !== r2.runId, 'each run_workflow call mints a distinct runId')
}

// ── 501 when the transport has no runWorkflow op (e.g. server, until wired) ──
{
  const res = await runTool(makeOsTools({ getState: () => ({ surfaces: [] }), workspaceContext: () => ({ workspace: 'w', workspace_path: '/tmp/w', siblings: [] }), createSurface: () => 'x' })).handler({ body: JSON.stringify({ file: '/x.js' }) })
  ok(res.status === 501, '501 when the transport has no runWorkflow')
}

// ── missing file -> 400 ──
{
  const { ops } = mkOps()
  const res = await runTool(makeOsTools(ops)).handler({ body: JSON.stringify({}) })
  ok(res.status === 400, 'missing file -> 400')
}

console.log(fail === 0 ? '\nPASS — run_workflow tool' : '\nFAIL — run_workflow tool (' + fail + ')')
process.exit(fail === 0 ? 0 : 1)
