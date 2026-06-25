export const meta = {
  name: 'build-job-model',
  description: 'Build + headless-test the Job model (Option 1: extend agent meta.json), the spine of the user-journey refactor',
  phases: [
    { title: 'Implement', detail: 'one Opus agent reads the real code + implements the Job model' },
    { title: 'Test', detail: 'write + run a headless node test + typecheck' },
    { title: 'Verify', detail: 'adversarial review of the diff for hacks / breakage' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'

const COMMON = `Repo: ${ROOT}. You are on git branch blitzos-journey-build. Read the ACTUAL current code before editing (do not work from memory). NO hacks: if a piece cannot be done cleanly this turn, leave a precise TODO comment explaining what + why, and say so in your report (never fake it or claim done when it is not). Do NOT touch the renderer, the user's uncommitted WIP (src/renderer/src/components/PrimarySpace.tsx, src/renderer/src/styles.css), or unrelated files. This is the BlitzOS Electron app; main process is .ts + .mjs. Cite file:line in your report.`

phase('Implement')
log('Implementing the Job model (Option 1: extend agent meta.json, single-Job)')

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['filesChanged', 'newFiles', 'typecheckPass', 'todos', 'summary'],
  properties: {
    filesChanged: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'what'], properties: { path: { type: 'string' }, what: { type: 'string' } } } },
    newFiles: { type: 'array', items: { type: 'string' } },
    typecheckPass: { type: 'boolean', description: 'did `npm run typecheck` pass with no NEW errors' },
    typecheckOutput: { type: 'string', description: 'relevant tail of typecheck output if it failed' },
    todos: { type: 'array', items: { type: 'string', description: 'anything intentionally left as a TODO + why' } },
    summary: { type: 'string' },
  },
}

const impl = await agent(`${COMMON}

You are implementing the FIRST build slice of the BlitzOS user-journey refactor: the JOB MODEL (the spine). FIRST read plans/blitzos-job-task-model.md and plans/blitzos-user-journey.md (the spec). The persistence decision is DECIDED by the user: Option 1 (extend the existing per-agent meta.json; one Job per agent). SINGLE-Job model: there is NO 'mode' field. An agent either HAS a job (it is a job agent) or it does not (a plain peer = a "normal request" the agent just handles).

READ these real files before editing: src/main/terminal-manager.mjs (the meta.json shape, publicMeta serializer, spawnTerminal, listTerminals, how agentRuntime/claudeSessionId are persisted), src/main/onboarding.ts (readInterview/writeInterview/InterviewState, INTERVIEW_BOOT_TASK, RESIDENT_INITIATIVE_BOOT_TASK, interviewBootTask, watchInterviewDone, osClearBrainContext usage), src/main/agent-runtime.mjs (setBootTaskProvider/bootTaskProvider, prepareAgentLaunch duty injection, buildBootstrap), src/main/index.ts (the setBootTaskProvider wiring around :654, launchAgent, osSpawnAgent IPC), src/main/os-tools.mjs (makeOsTools structure, how a tool is defined: path/description/input_schema/handler, the spawn_agent tool ~:629), src/main/electron-os-tools.ts (electronOps binding of spawnAgent), src/main/osActions.ts (osSpawnAgent ~:880), src/main/workspace-host.mjs (addAgent ~:641, chatStatus ~:472).

IMPLEMENT, handling edge cases:
1. NEW module src/main/job-model.mjs: export JOB_STATUSES = ['proposed','approved','running','done','blocked']; readJob(agentId)/writeJob(agentId, patch)/setJobStatus(agentId, status) that store a \`job\` object on the per-agent meta.json (reuse terminal-manager's meta read/write helpers — do NOT invent a parallel store). Job shape: { status, goal, planSurfaceId?, planPath?, contextRefs?, createdAt, updatedAt }. Mirror the structure of onboarding's readInterview/writeInterview.
2. src/main/terminal-manager.mjs: ensure the optional \`job\` field round-trips through meta.json read+write (and publicMeta if other persisted fields like agentRuntime are exposed there) — the three-serializer rule: a new persisted field must survive a restart.
3. Duty constants: JOB_PLAN_DUTY (for status proposed/approved: "author an editable plan widget + write a staged plan to plan.md, present it for approval, do NOT execute yet") and JOB_EXECUTE_DUTY (for status running: "execute the approved plan under /goal until the written plan is fully done"). Named constants near onboarding's two, or in job-model.mjs. They may reference the W1 plan widget conceptually (it does not exist yet).
4. Generalize the boot-task mapper where setBootTaskProvider is wired (index.ts ~:654): map agentId -> its job -> duty by status (proposed/approved -> JOB_PLAN_DUTY; running -> JOB_EXECUTE_DUTY; done/blocked -> null). If the agent has NO job, FALL THROUGH UNCHANGED: id==='0' -> interviewBootTask(), else null. The onboarding interview path MUST be byte-for-byte preserved (verify interviewBootTask still drives agent '0').
5. src/main/os-tools.mjs: add tool \`start_job {title, goal, contextRefs?}\` = spawn an agent via the EXISTING spawnAgent op, then set its meta.job {status:'proposed', goal, contextRefs, createdAt, updatedAt}; and \`set_job_status {agent, status}\` = validate status in JOB_STATUSES, write meta.job.status, and on the approved->running edge trigger a re-exec into the execute duty (reuse the interview->resident re-exec path, e.g. osClearBrainContext, if wiring it is clean; otherwise a precise TODO). Keep spawn_agent UNCHANGED (it stays the bare-peer primitive). Define the tools with the SAME shape as neighboring tools.
6. Bind the new ops (startJob, setJobStatus) in src/main/electron-os-tools.ts (electronOps), reusing osSpawnAgent + the job-model helpers. If preview/backend.mjs serverOps binding is trivial, add it; else a clear TODO (do not fake parity).
7. A job-status watcher generalizing watchInterviewDone, OR (if a full watcher is risky this turn) rely on the per-launch duty mapper (step 4) producing the right duty + a TODO for the active re-exec. State which you did.

Run \`npm run typecheck\` and fix all NEW type errors you introduce. Only touch the files above + the new module. Report filesChanged, newFiles, typecheckPass, and every TODO you left.`, { label: 'implement', phase: 'Implement', schema: IMPL_SCHEMA })

phase('Test')
log('Writing + running a headless node test + typecheck')
const TEST_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['testFile', 'ran', 'pass', 'typecheckPass', 'output'],
  properties: {
    testFile: { type: 'string' },
    ran: { type: 'boolean' }, pass: { type: 'boolean' }, typecheckPass: { type: 'boolean' },
    output: { type: 'string', description: 'actual test + typecheck output (tail)' },
    notes: { type: 'string' },
  },
}
const test = await agent(`${COMMON}

The Job model was just implemented (src/main/job-model.mjs + edits to terminal-manager.mjs, os-tools.mjs, electron-os-tools.ts, index.ts). Implementer summary: ${JSON.stringify(impl?.summary || '').slice(0, 800)}

WRITE a headless test scripts/test-job-model.mjs (Node ESM). First READ an existing test for conventions (e.g. scripts/test-workspace-stage.mjs or another scripts/test-*.mjs) — match how they set up a temp dir/workspace and assert. Test REAL behavior:
- readJob/writeJob round-trip a job on a temp agent meta.json (the field survives re-read = the three-serializer rule);
- setJobStatus walks proposed->approved->running->done and rejects an invalid status;
- the boot-task duty mapper returns JOB_PLAN_DUTY for proposed/approved, JOB_EXECUTE_DUTY for running, null for done/blocked, AND falls through to interviewBootTask for agent '0' with no job (the onboarding path is unaffected). If the mapper is not exported/testable in isolation, refactor it minimally so it is, or test via the closest exported seam (note which).
Do NOT write assertions that trivially pass. Then run \`node scripts/test-job-model.mjs\` and \`npm run typecheck\`. Return the ACTUAL output and honest pass/fail (if it fails, say so and quote the failure — do not claim pass).`, { label: 'test', phase: 'Test', schema: TEST_SCHEMA })

phase('Verify')
log('Adversarial review of the diff')
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'issues', 'breaksExisting', 'hacksFound'],
  properties: {
    verdict: { type: 'string', enum: ['clean', 'needs-fixes', 'broken'] },
    breaksExisting: { type: 'boolean', description: 'does it break the onboarding interview path or spawn_agent?' },
    hacksFound: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'file', 'problem', 'fix'], properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } },
  },
}
const verify = await agent(`${COMMON}

ADVERSARIALLY review the Job-model implementation just made on this branch. Run \`git diff 52b8001 -- src/main scripts\` (and \`git status\`) to see exactly what changed, and read the changed files. Run \`npm run typecheck\` yourself. Be skeptical; assume the implementer cut corners. Check:
1. Does it BREAK existing behavior? The agent-'0' -> interviewBootTask() fallthrough MUST be intact (a job-less agent must behave exactly as before); spawn_agent must be unchanged.
2. Hacks / fakes / stubs claimed as done? Any function that returns a constant instead of doing the work? Any "TODO" that is actually load-bearing?
3. The three-serializer rule: does \`job\` actually survive a meta.json write+read (persisted, not just in-memory)?
4. Edge cases: missing/malformed job, invalid status, set_job_status on approved->running actually triggering the re-exec (or an honest TODO).
5. Type errors / typecheck.
Return a concrete issue list (severity + file + problem + the fix) and a verdict.`, { label: 'verify', phase: 'Verify', schema: VERIFY_SCHEMA })

return { impl, test, verify }