// test-run-workflow-tool.mjs — the run_workflow TOOL handler (os-tools.mjs). In island-only V1 it does NOT
// create a widget surface: it just STARTS the run and returns { ok, runId }. Progress reports in chat / via
// /events. It must mint a fresh runId, hand the SAME runId + the file to the host, and never touch surfaces.
// Mock ops (no Electron) so the start + binding logic is exercised headlessly.
import { makeOsTools } from '../../src/main/os-tools.mjs'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

function mkOps() {
  const cap = {}
  const ops = {
    getState: () => ({ surfaces: [] }),
    workspaceContext: () => ({ workspace: 'w', workspace_path: '/tmp/w', siblings: [] }),
    createSurface: (desc) => { cap.desc = desc; return 'srf-1' }, // present but MUST NOT be called by run_workflow
    runWorkflow: async (spec) => { cap.run = spec; return { ok: true, runId: spec.runId } }
  }
  return { ops, cap }
}
const runTool = (tools) => tools.find((t) => t.path === '/run_workflow')

// ── the happy path: starts the run, binds the file, returns a runId, creates NO surface ──
{
  const { ops, cap } = mkOps()
  const res = await runTool(makeOsTools(ops)).handler({ body: JSON.stringify({ file: '/abs/wf-demo.js' }) })
  ok(cap.run && cap.run.file === '/abs/wf-demo.js', 'host received the workflow file')
  ok(typeof cap.run.runId === 'string' && cap.run.runId.startsWith('wf_'), 'host received a fresh runId')
  ok(cap.run.agentId === '0', 'host received the default agentId 0')
  ok(cap.desc === undefined, 'no surface is created (widgets deferred — progress goes to chat)')
  ok(res.ok === true && res.runId === cap.run.runId, 'tool returns ok + the SAME runId')
  ok(res.surfaceId === undefined, 'tool does not return a surfaceId')
}

// ── args + agent are threaded through to the host ──
{
  const { ops, cap } = mkOps()
  await runTool(makeOsTools(ops)).handler({ body: JSON.stringify({ file: '/x.js', args: { n: 3 }, agent: '7' }) })
  ok(cap.run.args && cap.run.args.n === 3, 'workflow args are passed to the host')
  ok(cap.run.agentId === '7', 'agent id is passed to the host')
}

// ── distinct runIds across calls ──
{
  const { ops } = mkOps()
  const tools = makeOsTools(ops)
  const r1 = await runTool(tools).handler({ body: JSON.stringify({ file: '/x.js' }) })
  const r2 = await runTool(tools).handler({ body: JSON.stringify({ file: '/x.js' }) })
  ok(r1.runId !== r2.runId, 'each run_workflow call mints a distinct runId')
}

// ── 501 when the transport has no runWorkflow op (e.g. server, until wired) ──
{
  const res = await runTool(makeOsTools({ getState: () => ({ surfaces: [] }), workspaceContext: () => ({ workspace: 'w', workspace_path: '/tmp/w', siblings: [] }) })).handler({ body: JSON.stringify({ file: '/x.js' }) })
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
