// test-job-model.mjs — prove the JOB model (src/main/job-model.mjs), the spine of the user-journey refactor:
//   (1) readJob/writeJob round-trip a `job` on a temp agent meta.json — the field survives a fresh re-read
//       through terminal-manager's SINGLE meta serializer (the three-serializer rule: a Job rides the SAME
//       meta.json the terminal owns, so it must survive read→write→read with nothing else clobbered).
//   (2) setJobStatus walks proposed→approved→running→done and REJECTS an invalid status (validated against
//       JOB_STATUSES), and refuses an agent with no job.
//   (3) the boot-task DUTY mapper: dutyForJobStatus returns the PLAN duty for proposed/approved, the EXECUTE
//       duty for running, and null for done/blocked/unknown; AND the index.ts boot-task closure
//       (index.ts:663-667) routes job→dutyForJobStatus while a NO-job agent '0' falls through to
//       interviewBootTask (onboarding path unaffected) and any other no-job peer gets null.
//
// WHY the mapper is reproduced here rather than imported: the boot-task closure lives in index.ts (Electron
// main, not a headless module) and its onboarding half is `interviewBootTask()` in onboarding.ts — a .ts file
// that calls the IPC-bound osActions (`osWorkspaceContext()`), so it cannot be imported into a Node ESM test
// and has its OWN coverage (scripts/test-onboarding-seed.mjs + the interview integration test). job-model owns
// ONLY the job half (readJob + dutyForJobStatus + the fall-through decision); we test THAT against real
// meta.json on disk, reproducing index.ts's exact 3-line routing with a sentinel interviewBootTask stub so the
// fall-through edge (job present → job duty regardless of id; no job + '0' → interview seam; no job + other →
// null) is asserted without faking the job resolution. Run with `node scripts/test-job-model.mjs`.
import {
  JOB_STATUSES, JOB_PLAN_DUTY, JOB_EXECUTE_DUTY,
  readJob, writeJob, setJobStatus, createJob, makeJob, dutyForJobStatus, wireJobModel
} from '../src/main/job-model.mjs'
import { writeTerminalMeta, readTerminalMeta } from '../src/main/terminal-manager.mjs'
import { buildBootstrap } from '../src/main/agent-runtime.mjs'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}

// One temp `.blitzos/terminals` dir for the whole run; wireJobModel points job-model's resolver at it (the
// same DI seam index.ts uses via wireJobModel({ getTerminalsDir })).
const terminalsDir = mkdtempSync(join(tmpdir(), 'aos-job-'))
wireJobModel({ getTerminalsDir: () => terminalsDir })

// Seed a minimal agent meta.json (writeJob requires a pre-existing terminal record — it attaches a job onto an
// agent that already exists; it returns null otherwise). Mirrors a real spawned agent's meta.
const seedAgent = (id) => writeTerminalMeta(terminalsDir, id, { id, kind: 'agent', title: `agent ${id}`, status: 'running' })

console.log('JOB model (src/main/job-model.mjs):')

// ---- (1) readJob/writeJob round-trip on a temp agent meta.json (three-serializer rule) ----------------------
{
  const id = 'A1'
  seedAgent(id)
  ok('readJob on an agent with no job yet → null', readJob(id) === null, readJob(id))

  const created = createJob(id, { goal: 'ship the thing', title: 'Ship', contextRefs: ['/p/x.md', 'surf-7'] })
  ok('createJob returns a proposed job with goal/title/contextRefs + timestamps',
    !!created && created.status === 'proposed' && created.goal === 'ship the thing' &&
    created.title === 'Ship' && Array.isArray(created.contextRefs) && created.contextRefs.length === 2 &&
    typeof created.createdAt === 'number' && typeof created.updatedAt === 'number',
    created)

  // The load-bearing assertion: re-READ from disk (not the returned object) — the job must survive the round
  // trip through terminal-manager's serializer, and the rest of the meta must be untouched.
  const reread = readJob(id)
  ok('readJob after createJob → the job survives a fresh re-read from meta.json',
    !!reread && reread.status === 'proposed' && reread.goal === 'ship the thing' &&
    reread.title === 'Ship' && reread.contextRefs[0] === '/p/x.md' && reread.contextRefs[1] === 'surf-7',
    reread)
  const metaOnDisk = JSON.parse(readFileSync(join(terminalsDir, id, 'meta.json'), 'utf8'))
  ok('the job is stored as a `job` object ON meta.json, NOT a parallel store',
    !!metaOnDisk.job && metaOnDisk.job.goal === 'ship the thing', metaOnDisk.job)
  ok('writeJob did not clobber the rest of the meta (kind/title/status intact)',
    metaOnDisk.kind === 'agent' && metaOnDisk.title === 'agent A1' && metaOnDisk.status === 'running',
    { kind: metaOnDisk.kind, title: metaOnDisk.title, status: metaOnDisk.status })

  // writeJob MERGES a patch (preserves goal/createdAt) and bumps updatedAt.
  const firstUpdatedAt = reread.updatedAt
  const firstCreatedAt = reread.createdAt
  const patched = writeJob(id, { planSurfaceId: 'surf-plan-1' })
  ok('writeJob merges a patch (goal preserved, new field added)',
    !!patched && patched.goal === 'ship the thing' && patched.planSurfaceId === 'surf-plan-1', patched)
  ok('writeJob preserves createdAt and bumps updatedAt (>=)',
    patched.createdAt === firstCreatedAt && patched.updatedAt >= firstUpdatedAt,
    { createdAt: patched.createdAt, firstCreatedAt, updatedAt: patched.updatedAt, firstUpdatedAt })
  const rereadPatched = readJob(id)
  ok('the merged planSurfaceId survives a re-read too',
    !!rereadPatched && rereadPatched.planSurfaceId === 'surf-plan-1' && rereadPatched.goal === 'ship the thing',
    rereadPatched)
}

// ---- writeJob/readJob on a NON-existent agent → null (no meta to attach to) ---------------------------------
{
  ok('writeJob on an unknown agent id → null (no terminal record)', writeJob('GHOST', { goal: 'x' }) === null)
  ok('readJob on an unknown agent id → null', readJob('GHOST') === null)
}

// ---- (2) setJobStatus walks proposed→approved→running→done and rejects invalid ------------------------------
{
  const id = 'A2'
  seedAgent(id)
  createJob(id, { goal: 'walk the lifecycle' })
  ok('fresh job starts proposed', readJob(id).status === 'proposed', readJob(id).status)

  for (const next of ['approved', 'running', 'done']) {
    const r = setJobStatus(id, next)
    ok(`setJobStatus → ${next} (ok:true) and persists`,
      r.ok === true && r.job.status === next && readJob(id).status === next, r)
  }

  // Invalid status is rejected and does NOT mutate the persisted status (still 'done' from the walk above).
  const bad = setJobStatus(id, 'frozen')
  ok('setJobStatus with an invalid status → { ok:false } and lists the valid set',
    bad.ok === false && typeof bad.error === 'string' && bad.error.includes('proposed'), bad)
  ok('an invalid setJobStatus leaves the persisted status unchanged (still done)',
    readJob(id).status === 'done', readJob(id).status)

  // setJobStatus on an agent with no job at all → ok:false 'agent has no job'.
  const noJobId = 'A3'
  seedAgent(noJobId)
  const noJob = setJobStatus(noJobId, 'approved')
  ok('setJobStatus on an agent with no job → { ok:false, error:"agent has no job" }',
    noJob.ok === false && noJob.error === 'agent has no job', noJob)
}

// ---- (2b) W1: setJobStatus binds planSurfaceId (status-less and alongside a status) -------------------------
{
  const id = 'A2b'
  seedAgent(id)
  createJob(id, { goal: 'bind the plan widget' })
  // Status-LESS bind: the planning agent records the editable plan widget id without changing status.
  const bind = setJobStatus(id, '', { planSurfaceId: 'srf-99' })
  ok('setJobStatus({planSurfaceId} only) → ok:true, persists planSurfaceId, leaves status proposed',
    bind.ok === true && bind.job.planSurfaceId === 'srf-99' && readJob(id).planSurfaceId === 'srf-99' && readJob(id).status === 'proposed', bind)
  // Bind + status together (and a non-whitelisted field is ignored, never clobbering goal/timestamps).
  const both = setJobStatus(id, 'approved', { planSurfaceId: 'srf-100', goal: 'HACKED' })
  ok('setJobStatus(status + planSurfaceId) → applies both; an out-of-band field (goal) is ignored',
    both.ok === true && both.job.status === 'approved' && both.job.planSurfaceId === 'srf-100' && both.job.goal === 'bind the plan widget', both)
  // An empty call (no status, no fields) is a clear error, not a silent no-op write.
  const empty = setJobStatus(id, '', {})
  ok('setJobStatus with neither status nor planSurfaceId → { ok:false }',
    empty.ok === false && typeof empty.error === 'string', empty)
}

// ---- (3a) dutyForJobStatus: the pure status→duty mapper -----------------------------------------------------
{
  ok('dutyForJobStatus(proposed) === JOB_PLAN_DUTY', dutyForJobStatus('proposed') === JOB_PLAN_DUTY)
  ok('dutyForJobStatus(approved) === JOB_PLAN_DUTY', dutyForJobStatus('approved') === JOB_PLAN_DUTY)
  ok('dutyForJobStatus(running) === JOB_EXECUTE_DUTY', dutyForJobStatus('running') === JOB_EXECUTE_DUTY)
  ok('dutyForJobStatus(done) === null', dutyForJobStatus('done') === null)
  ok('dutyForJobStatus(blocked) === null', dutyForJobStatus('blocked') === null)
  ok('dutyForJobStatus(unknown garbage) === null', dutyForJobStatus('nonsense') === null)
  ok('dutyForJobStatus(null/undefined) === null', dutyForJobStatus(null) === null && dutyForJobStatus(undefined) === null)
  // Guard against the two duties being accidentally identical (would make proposed vs running indistinguishable).
  ok('the PLAN duty and EXECUTE duty are distinct, non-empty strings',
    typeof JOB_PLAN_DUTY === 'string' && typeof JOB_EXECUTE_DUTY === 'string' &&
    JOB_PLAN_DUTY.length > 0 && JOB_EXECUTE_DUTY.length > 0 && JOB_PLAN_DUTY !== JOB_EXECUTE_DUTY)
  // JOB_STATUSES is the canonical lifecycle set, and every status either maps to a duty or to null (total).
  ok('JOB_STATUSES === [proposed,approved,running,done,blocked]',
    JSON.stringify(JOB_STATUSES) === JSON.stringify(['proposed', 'approved', 'running', 'done', 'blocked']), JOB_STATUSES)
}

// ---- (3b) the index.ts boot-task closure (index.ts:663-667): job routing + the onboarding fall-through ------
// Reproduce index.ts's exact 3-line routing. The REAL job half (readJob + dutyForJobStatus) runs against the
// real meta.json on disk seeded above; interviewBootTask is a sentinel stub (it is TS + IPC-bound, tested
// elsewhere) so we assert ONLY the routing decision: a job present → that job's duty regardless of agent id;
// no job + id '0' → the interview seam; no job + any other id → null.
{
  const INTERVIEW_SENTINEL = '<<interview-boot-task>>'
  const interviewBootTask = () => INTERVIEW_SENTINEL // stands in for onboarding.ts's interviewBootTask()
  const bootTaskFor = (id) => {
    const job = readJob(id)
    if (job) return dutyForJobStatus(job.status)
    return String(id) === '0' ? interviewBootTask() : null
  }

  // A1 has a job (currently 'proposed'/edited to running via patches above is A1? — A1 ended at proposed+planSurfaceId,
  // status still 'proposed'). Verify a job agent gets the job duty, NEVER the interview seam — even if its id were '0'.
  ok('boot-task for a job agent (A1, proposed) → the PLAN duty (job wins, not interview)',
    bootTaskFor('A1') === JOB_PLAN_DUTY, bootTaskFor('A1'))

  // A2 walked to 'done' → a finished job yields NO duty (null), and still does NOT fall through to interview.
  ok('boot-task for a done job agent (A2) → null (no duty, NOT the interview seam)',
    bootTaskFor('A2') === null, bootTaskFor('A2'))

  // Drive A1 to running and re-check: same agent, status now drives the EXECUTE duty (the re-read reflects state).
  setJobStatus('A1', 'approved')
  ok('boot-task for A1 after →approved → still the PLAN duty', bootTaskFor('A1') === JOB_PLAN_DUTY, bootTaskFor('A1'))
  setJobStatus('A1', 'running')
  ok('boot-task for A1 after →running → the EXECUTE duty', bootTaskFor('A1') === JOB_EXECUTE_DUTY, bootTaskFor('A1'))

  // The onboarding fall-through: agent '0' with NO job → the interview seam (byte-for-byte preserved path).
  seedAgent('0') // a real agent-0 meta exists, but no `job` attached (single-Job model: start_job never targets '0')
  ok('agent 0 has no job', readJob('0') === null)
  ok('boot-task for agent 0 with NO job → the interview seam (onboarding path unaffected)',
    bootTaskFor('0') === INTERVIEW_SENTINEL, bootTaskFor('0'))

  // Any OTHER bare peer with no job → null (a plain spawn_agent peer / normal request, no standing duty).
  seedAgent('7')
  ok('boot-task for a bare peer (id 7, no job) → null', bootTaskFor('7') === null, bootTaskFor('7'))

  // And if agent 0 DID acquire a job, the job would win over the interview seam (proves the branch order).
  createJob('0', { goal: 'hypothetical job on 0' })
  ok('boot-task for agent 0 WITH a job → the job duty (job branch precedes the id===0 interview branch)',
    bootTaskFor('0') === JOB_PLAN_DUTY, bootTaskFor('0'))
}

// ---- (4) makeJob (pure) + the job DUTY actually reaches the agent's FIRST bootstrap (the blocker the fix closes) -
// The blocker (caught in adversarial review): start_job's job must be stamped onto the agent meta BEFORE the
// terminal launches, so prepareAgentLaunch's bootTaskProvider read sees it and buildBootstrap injects the duty.
// The original impl wrote the job AFTER the synchronous launch + relied on a re-exec that no-op'd (clearAgentContext's
// claudeSessionId guard), so the first bootstrap carried NO duty. We prove the integration link the fix depends on:
// a meta carrying a job → the mapper → buildBootstrap → the duty TEXT is present in the bootstrap. (addAgent now
// writes opts.job into the meta BEFORE launchAgent — a synchronous code-order guarantee covered by code review.)
{
  // makeJob: a fresh proposed job object, written NOWHERE (start_job hands this to addAgent to stamp pre-launch).
  const mj = makeJob({ goal: 'g', title: 't', contextRefs: ['r'] })
  ok('makeJob → a proposed job object with goal/title/contextRefs + timestamps',
    mj.status === 'proposed' && mj.goal === 'g' && mj.title === 't' && mj.contextRefs[0] === 'r' &&
    typeof mj.createdAt === 'number' && typeof mj.updatedAt === 'number', mj)
  ok('makeJob did NOT touch disk (a never-seeded id still has no job)', readJob('NEVER') === null)

  const INTERVIEW_SENTINEL = '<<interview-boot-task>>'
  const bootTaskFor = (id) => { const j = readJob(id); if (j) return dutyForJobStatus(j.status); return String(id) === '0' ? INTERVIEW_SENTINEL : null }
  const bootstrapFor = (id) => buildBootstrap('http://127.0.0.1:0', id, bootTaskFor(id), null)

  // A freshly-stamped proposed job (exactly what addAgent now writes pre-launch) → the PLAN duty is IN the bootstrap.
  const j1 = 'J1'; seedAgent(j1); writeJob(j1, makeJob({ goal: 'plan me' }))
  const bp = bootstrapFor(j1)
  ok('a proposed job agent\'s first bootstrap CONTAINS the PLAN duty (blocker closed)', bp.includes(JOB_PLAN_DUTY), bp.slice(0, 120))
  ok('that bootstrap uses the standing-duty framing', bp.includes('standing task'))

  // → running: the bootstrap now carries the EXECUTE duty, not the PLAN duty.
  setJobStatus(j1, 'approved'); setJobStatus(j1, 'running')
  const be = bootstrapFor(j1)
  ok('a running job agent\'s bootstrap CONTAINS the EXECUTE duty and NOT the PLAN duty',
    be.includes(JOB_EXECUTE_DUTY) && !be.includes(JOB_PLAN_DUTY))

  // A bare no-job peer → the bootstrap has NO standing-duty fragment at all (a normal-request agent).
  const j2 = 'J2'; seedAgent(j2)
  ok('a bare no-job peer\'s bootstrap has NO standing-duty fragment', !bootstrapFor(j2).includes('standing task'))
}

rmSync(terminalsDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
