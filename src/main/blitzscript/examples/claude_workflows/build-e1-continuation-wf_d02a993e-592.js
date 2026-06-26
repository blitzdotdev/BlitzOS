export const meta = {
  name: 'build-e1-continuation',
  description: 'Build + headless-test E1: the plan.md-gated /goal continuation engine for running Jobs',
  phases: [
    { title: 'Implement', detail: 'plan-doc reader + continuation decision + Stop-hook script + launch wiring' },
    { title: 'Test', detail: 'headless node tests of the reader/decision/hook-script/wiring + typecheck' },
    { title: 'Verify', detail: 'adversarial review (esp. false-confidence / runtime-timing gaps)' },
  ],
}
const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'
const COMMON = `Repo: ${ROOT}, branch blitzos-journey-build. The Job model (src/main/job-model.mjs: status proposed/approved/running, JOB_EXECUTE_DUTY referencing /goal + .blitzos/jobs/<agent-id>/plan.md) and W2 are merged. READ the actual code before editing. NO hacks: a piece that can't be cleanly done -> a precise TODO, never faked/claimed-done. Do NOT touch the renderer or the user WIP (App.tsx, store.ts, PrimarySpace.tsx, styles.css). Cite file:line.`

phase('Implement')
log('Building E1: plan.md reader + continuation decision + Stop-hook + launch wiring')
const IMPL_SCHEMA = { type: 'object', additionalProperties: false, required: ['filesChanged','newFiles','typecheckPass','todos','summary'], properties: {
  filesChanged: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path','what'], properties: { path: { type: 'string' }, what: { type: 'string' } } } },
  newFiles: { type: 'array', items: { type: 'string' } }, typecheckPass: { type: 'boolean' }, typecheckOutput: { type: 'string' }, todos: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } }

const impl = await agent(`${COMMON}

Build E1 (the /goal continuation engine for a RUNNING Job), per plans/blitzos-agent-autonomy-guardrails.md (READ IT — its Phase 2 specs the plan.md-gated Stop hook, the machine-readable stage status, the spin-guard) and plans/blitzos-user-journey.md (E1). The job lifecycle is: a job's status 'running' should EXECUTE the approved plan to completion (do-not-stop-until-done). E1 is the host-side mechanism that keeps a running job agent driving until plan.md is fully done.

READ: src/main/job-model.mjs (the job record, JOB_EXECUTE_DUTY, the .blitzos/jobs/<id>/plan.md path it references, readJob), src/main/agent-runtime.mjs (buildBootstrap duty injection :61, buildClaudeCommand :108 where --settings/tuned is built — this is where a Stop hook attaches, ensureClaudeSessionId, prepareAgentLaunch the single launch path), src/main/onboarding.ts (readInterview/writeInterview + the markdown-parsing helpers profileValue/markdownValue as the pattern for a plan.md parser), src/main/index.ts (the bootTaskProvider wiring + how prepareAgentLaunch is called). Check whether Claude Code supports a session Stop hook via --settings (the guardrails doc says it does: Claude Code 2.1.170, a Stop hook fires on yield).

IMPLEMENT (headless-buildable + testable; the live hook FIRING is runtime/out of scope):
1. NEW src/main/plan-doc.mjs (+ .d.mts): a reader/parser for a job's plan.md at .blitzos/jobs/<agentId>/plan.md. Parse a machine-readable status (front-matter or a header line: status: proposed|approved|running|done|blocked) + per-STAGE status (a checklist: each stage line marked done/todo/blocked). Export readPlan(agentId) -> { status, stages:[{title,status}], complete:boolean, blocked:boolean } (or null if no plan.md). Reuse onboarding's markdown helpers' style; do NOT invent a heavy parser. Also a writer helper if useful for tests. This MUST be a pure headless module (no IPC-bound imports), wired with the same terminalsDir/jobs-dir resolver pattern job-model uses (or reuse job-model's resolver).
2. A pure continuation DECISION function continueDecision({ planStatus, complete, blocked, spinCount, planChangedSinceLastContinue }) -> { continue:boolean, reason:string, message?:string }: continue when status==='approved'-or-'running' AND !complete AND !blocked AND the spin-guard is not tripped; else stop. The SPIN-GUARD: cap consecutive 'continue's that did not change plan.md (planChangedSinceLastContinue===false) at N (e.g. 3) -> then stop + flag 'stuck' (so a stalled agent doesn't loop forever). Pure + unit-testable.
3. The Stop-hook SCRIPT: a small script (shell or node) BlitzOS writes per running-job agent (e.g. .blitzos/jobs/<id>/continue-hook.sh, sibling to wait.sh's writeWaitScript in agent-runtime.mjs) that, on each agent YIELD, reads plan.md, runs the decision, and outputs the Stop-hook continue/stop result in Claude Code's expected hook format. Make the script itself testable (run it against a sample plan.md and assert its stdout/exit). Maintain the spin-guard counter in a file under the job dir.
4. WIRING: in prepareAgentLaunch / buildClaudeCommand (agent-runtime.mjs), INSTALL the continuation Stop hook ONLY for an agent whose job is mode running (status 'running') — read the job (readJob) at launch and, when running, add the Stop hook to the --settings JSON (the same --settings string buildClaudeCommand already builds for effort). A non-running job, a planning job, or a no-job agent installs NO continuation hook (unchanged launch). Keep it behind a clean seam; do not break the existing effort/--settings logic or the bootstrap.
5. Decide + document (a TODO is fine if deferred): the --permission-mode / irreversible-action gate (guardrails Phase 2 separate decision) is OUT of this slice unless trivial — leave a precise TODO.

Run \`npm run typecheck\`. Report filesChanged, newFiles, typecheckPass, every TODO. The actual hook FIRING (a live agent continuing) is runtime — note it as the visual/runtime-test boundary, do not fake an end-to-end.`, { label: 'implement', phase: 'Implement', schema: IMPL_SCHEMA })

phase('Test')
log('Headless tests: plan.md reader, continuation decision, hook script, launch wiring')
const TEST_SCHEMA = { type: 'object', additionalProperties: false, required: ['testFile','ran','pass','typecheckPass','output'], properties: { testFile: { type: 'string' }, ran: { type: 'boolean' }, pass: { type: 'boolean' }, typecheckPass: { type: 'boolean' }, output: { type: 'string' }, notes: { type: 'string' } } }
const test = await agent(`${COMMON}

E1 was just implemented (src/main/plan-doc.mjs reader, a continuation decision fn, a Stop-hook script, launch wiring in agent-runtime.mjs). Implementer summary: ${JSON.stringify(impl?.summary||'').slice(0,900)}

WRITE scripts/tests/test-plan-continuation.mjs (Node ESM; mirror scripts/test-job-model.mjs / scripts/tests/test-tick-diff.mjs conventions, temp dirs). Test REAL behavior:
- readPlan parses status + per-stage status from a sample plan.md on disk (proposed/approved/running/done/blocked; all-stages-done => complete:true; a blocked marker => blocked:true; missing file => null).
- continueDecision: approved+incomplete+not-blocked => continue; complete => stop; blocked => stop; proposed (not yet approved) => stop (do not execute before approval); spin-guard: N consecutive no-plan-change continues => stop+stuck.
- the Stop-hook SCRIPT: run it against a temp job dir with a sample plan.md and assert it outputs CONTINUE when approved+incomplete, STOP when complete/blocked, and trips the spin-guard after N no-change runs (drive the counter file).
- the launch WIRING: prepareAgentLaunch/buildClaudeCommand installs the continuation Stop hook for a mode running job, and does NOT for a planning job / no-job agent / the onboarding '0' (assert the --settings/command string differs, like the job-model bootstrap test). 
Run \`node scripts/tests/test-plan-continuation.mjs\` + \`npm run typecheck\`. Return ACTUAL output + honest pass/fail. Do NOT write trivially-passing assertions.`, { label: 'test', phase: 'Test', schema: TEST_SCHEMA })

phase('Verify')
log('Adversarial review (false-confidence + runtime-timing hunt)')
const VERIFY_SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict','issues','breaksExisting','hacksFound'], properties: { verdict: { type: 'string', enum: ['clean','needs-fixes','broken'] }, breaksExisting: { type: 'boolean' }, hacksFound: { type: 'boolean' }, issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity','file','problem','fix'], properties: { severity: { type: 'string', enum: ['blocker','major','minor'] }, file: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } } }
const verify = await agent(`${COMMON}

ADVERSARIALLY review E1 on this branch. Run \`git diff 26a824d -- src/main scripts\` + \`git status\`, read the changed files, run \`npm run typecheck\`. Be skeptical; a prior slice shipped a guard whose test passed but whose PRODUCTION timing was broken (a within-window test gave false confidence) — hunt for that class of bug here. Check:
1. FALSE CONFIDENCE: do the tests exercise the REAL path, or only pure helpers while the wiring/hook-firing path is untested? Specifically: is the Stop hook ACTUALLY installed into the launch command for a running job (and ONLY then), or is that wiring untested? Trace prepareAgentLaunch->buildClaudeCommand for a running-job agent vs a planning/no-job agent and confirm the installed --settings differs.
2. Does the continuation engine arm for a NON-running or NO-job agent (it must NOT), and does it leave the onboarding '0' interview launch byte-for-byte unchanged?
3. SPIN-GUARD: is it real (does N no-change continues actually stop), or a no-op? Does it persist its counter correctly across yields (a file), and reset on a real plan.md change?
4. Option-A / no-hacks: is the continuation gated PURELY on plan.md status the AGENT writes (approved/incomplete/blocked), never on OS-side judgment of 'stuck'/progress? (A spin-guard counting plan.md edits is fine; a 'looks stuck' heuristic is not.)
5. plan.md PARSING robustness: malformed/missing file, partial stages, unknown status -> safe defaults (a parse failure must NOT spuriously 'continue' an agent forever).
6. Type errors / breakage of agent-runtime's existing effort/--settings/bootstrap logic.
Return concrete issues (severity+file+problem+fix) + a verdict.`, { label: 'verify', phase: 'Verify', schema: VERIFY_SCHEMA })

return { impl, test, verify }