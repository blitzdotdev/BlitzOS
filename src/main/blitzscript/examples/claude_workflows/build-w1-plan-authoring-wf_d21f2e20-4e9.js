export const meta = {
  name: 'build-w1-plan-authoring',
  description: 'Build W1: the editable-plan-widget authoring prompt + the return channel + reconcile-to-plan.md wiring',
  phases: [
    { title: 'Implement', detail: 'editable-plan idiom in the widget authoring guide + duty + optional kit elements + plan.md reconcile' },
    { title: 'Test', detail: 'kit compiles + the widget->agent return-channel data-path + typecheck' },
    { title: 'Verify', detail: 'adversarial review (data-path real, no hacks, no design overreach)' },
  ],
}
const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'
const COMMON = `Repo: ${ROOT}, branch blitzos-journey-build. Job model (src/main/job-model.mjs: JOB_PLAN_DUTY references "an editable plan widget" + .blitzos/jobs/<id>/plan.md), E1 (src/main/plan-doc.mjs: readPlan/writePlan over that plan.md), and W2 (the tick already diffs surface props) are merged. READ the actual code first. NO hacks; precise TODO over fakery. Do NOT touch the user WIP (App.tsx, store.ts, PrimarySpace.tsx, styles.css) or the canvas/navigation renderer. Cite file:line.`

phase('Implement')
log('Building W1: the editable-plan authoring prompt + return channel + plan.md reconcile')
const IMPL_SCHEMA = { type: 'object', additionalProperties: false, required: ['filesChanged','newFiles','typecheckPass','todos','summary'], properties: {
  filesChanged: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path','what'], properties: { path: { type: 'string' }, what: { type: 'string' } } } },
  newFiles: { type: 'array', items: { type: 'string' } }, typecheckPass: { type: 'boolean' }, typecheckOutput: { type: 'string' }, todos: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } }

const impl = await agent(`${COMMON}

Build W1 per plans/blitzos-plan-widget.md (READ IT) + plans/blitzos-user-journey.md (W1). W1 is the GUIDANCE that makes a job agent author a GOOD interactive, user-editable plan widget (inline-editable stages, per-decision toggles, reorder/remove, a comments box, Submit/Reject) AND the RETURN CHANNEL that round-trips the user's edits back to the agent, which reconciles them into the job's plan.md (the SAME plan.md E1's plan-doc reads). The agent CREATES the widget at runtime guided by this; you are NOT shipping a pre-rendered widget (its visual is the user's design). 

CRITICAL verified facts to build on (from the widgets map): the widget<->agent callback plumbing ALREADY EXISTS in three forms — blitz.sendMessage -> a private trigger:'message' moment (widget-bridge.ts), __blitz:'action' postMessage -> trigger:'action' (App.tsx, capped 4000 BYTES so a big edited plan can be DROPPED), blitz.setProps for durable own-state — and the agent->widget update path (update_surface{props}) + get_surface{id} (returns a widget's full props) are built. So the RECOMMENDED return channel is the no-core-edit two-step: the widget setProps the full edited plan into its own props, then a tiny blitz.sendMessage('plan submitted', agentId) wakes the agent, which calls get_surface{id} to read the full edited plan (sidestepping the 4000-byte __blitz:'action' cap), reconciles into the job's plan.md, and (on approve) set_job_status running.

READ: src/main/widget-catalog.mjs (WIDGET_AUTHORING_MD — the guide the agent fetches via get_widget_authoring; this is where the editable-plan idiom goes), src/renderer/src/widget-bridge.ts (the BRIDGE_SHIM: blitz.setProps/sendMessage/onProps already exist), src/renderer/src/widget-ui-kit.ts (the <blitz-input>/<blitz-button> kit — where optional <blitz-edit>/<blitz-toggle> would go), src/main/job-model.mjs (JOB_PLAN_DUTY — refine its plan-widget instructions), src/main/plan-doc.mjs (writePlan — the agent writes the job plan.md through this grammar so E1 reads it), src/main/os-tools.mjs (get_surface, set_job_status, spawn_widget).

IMPLEMENT (headless content + thin wiring; the rendered widget is the user's visual/design):
1. Extend WIDGET_AUTHORING_MD (widget-catalog.mjs) with an EDITABLE-PLAN / interactive-form IDIOM: how to author a jsx widget with controlled inputs for editable stage rows, per-decision toggles, reorder/remove a stage, a comments box, and Submit/Reject buttons; how to persist in-progress edits via blitz.setProps (so an edit survives reload); and the RETURN CHANNEL: on Submit/Reject, setProps the full {stages, decisions, comments, decision} then blitz.sendMessage('plan '+decision, agentId). Also DOCUMENT the currently-undocumented __blitz:'action' channel + its 4000-byte cap so authors don't hit the silent drop. Keep the design-language guidance consistent with the existing WIDGET_AUTHORING_MD (do NOT prescribe a fixed visual; give the idiom + the data contract).
2. Refine JOB_PLAN_DUTY (job-model.mjs) so the planning agent: authors that editable plan widget (bind it to the job via planSurfaceId — set the job's planSurfaceId to the spawned widget's surface id), writes the staged plan to the job's plan.md in the grammar plan-doc.mjs parses (so E1's continuation reads it), presents + asks approve/edit/reject, and on a user edit (the sendMessage round-trip) reads the edited plan via get_surface, reconciles BOTH the widget props and plan.md, and re-presents. The agent must NOT mark the job running itself — the user approves.
3. OPTIONAL but recommended: add <blitz-edit> (an inline contenteditable row firing a change event) and <blitz-toggle> kit elements to widget-ui-kit.ts beside <blitz-input>/<blitz-button>, so "BlitzOS supplies generic interaction patterns" is literally true. Keep them minimal + consistent with the existing kit.
4. If a reusable plan widget TEMPLATE in widgets/ is warranted, add a minimal FUNCTIONAL one (compiles, correct data contract) + register in widgets/widgets.json — but flag that its visual/design is the user's and keep it lean; do NOT over-style.

Run \`npm run typecheck\`. Report filesChanged, newFiles, typecheckPass, every TODO. Flag clearly what is visual/design (the user's) vs what you built (the idiom + data contract + wiring).`, { label: 'implement', phase: 'Implement', schema: IMPL_SCHEMA })

phase('Test')
log('Test: kit compiles + the return-channel data-path + typecheck')
const TEST_SCHEMA = { type: 'object', additionalProperties: false, required: ['testFile','ran','pass','typecheckPass','output'], properties: { testFile: { type: 'string' }, ran: { type: 'boolean' }, pass: { type: 'boolean' }, typecheckPass: { type: 'boolean' }, output: { type: 'string' }, notes: { type: 'string' } } }
const test = await agent(`${COMMON}

W1 was just implemented (WIDGET_AUTHORING_MD editable-plan idiom + return-channel docs, JOB_PLAN_DUTY refinement, optional kit elements, maybe a plan widget template). Implementer summary: ${JSON.stringify(impl?.summary||'').slice(0,800)}

WRITE/EXTEND a headless test (scripts/tests/test-plan-widget.mjs or extend an existing widget test — READ scripts/test-widget-jsx.mjs for how jsx widgets are compiled+tested headlessly). Test what is HEADLESS-testable:
- If kit elements (<blitz-edit>/<blitz-toggle>) were added: they are present in the kit string + a widget using them COMPILES through the jsx pipeline without error.
- If a plan widget template was added to widgets/: it is in widgets.json and COMPILES.
- The RETURN-CHANNEL data-path contract: simulate the two-step — a widget's setProps lands in surface props, and get_surface{id} returns those props (so the agent can read the full edited plan); assert the path that avoids the 4000-byte __blitz:'action' cap. (Test against the os-tools get_surface / the bridge setprops handling that already exists.)
- WIDGET_AUTHORING_MD now contains the editable-plan idiom + the return-channel + the __blitz:'action' cap warning (string assertions).
Run the test + \`npm run typecheck\` + the existing widget tests (test-widget-jsx.mjs, test-workspace-jsx.mjs) for no regression. Return ACTUAL output + honest pass/fail. The rendered widget's VISUAL is out of headless scope (note it).`, { label: 'test', phase: 'Test', schema: TEST_SCHEMA })

phase('Verify')
log('Adversarial review of W1')
const VERIFY_SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict','issues','breaksExisting','hacksFound'], properties: { verdict: { type: 'string', enum: ['clean','needs-fixes','broken'] }, breaksExisting: { type: 'boolean' }, hacksFound: { type: 'boolean' }, issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity','file','problem','fix'], properties: { severity: { type: 'string', enum: ['blocker','major','minor'] }, file: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } } }
const verify = await agent(`${COMMON}

ADVERSARIALLY review W1 on this branch. Run \`git diff c08e069 -- src/main src/renderer/src/widget-ui-kit.ts src/renderer/src/widget-bridge.ts widgets scripts\` + \`git status\`; read the changes; run \`npm run typecheck\`. Be skeptical. Check:
1. RETURN CHANNEL correctness: does the documented two-step actually avoid the 4000-byte __blitz:'action' cap (does get_surface really return the widget's full props, and does the duty tell the agent to USE get_surface, not the capped action channel)? A plan that silently truncates is a blocker.
2. The plan.md reconcile: does JOB_PLAN_DUTY tell the agent to write the plan in the grammar plan-doc.mjs PARSES (so E1's continuation reads it)? A mismatch means E1 never sees the plan -> the running job never continues.
3. planSurfaceId binding: is the job's planSurfaceId actually set to the plan widget's surface (so the supervisor/E3 can find it)? Or just described in prose with no mechanism?
4. Kit elements / template: do they COMPILE and not break the existing widget pipeline? Any over-styling that presumes a visual the user owns?
5. Did it touch the user WIP / canvas-navigation renderer? (must not).
6. Type errors / regression of the widget tests. Return concrete issues + a verdict. Distinguish a real DEFECT from "the rendered widget visual is the user's design" (the latter is expected scope, not an issue).`, { label: 'verify', phase: 'Verify', schema: VERIFY_SCHEMA })

return { impl, test, verify }