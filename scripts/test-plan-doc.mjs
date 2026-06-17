// test-plan-doc.mjs — the E1 plan.md reader/parser + continuation decision (src/main/plan-doc.mjs):
//   (1) parsePlanStatus: front-matter + bare-header `status:`, case-insensitive, invalid → null.
//   (2) parsePlanStages: GitHub task-list checkboxes (-, *, N.), done/todo/blocked marks + (blocked) tags.
//   (3) readPlan round-trips a real plan.md off disk via the wired jobs-dir resolver, deriving complete/blocked.
//   (4) continueDecision: the pure continue-vs-stop rule + the spin-guard (every branch).
//   (5) the spin-counter file helpers (readSpin/writeSpin) round-trip in the job dir.
// Run with `node scripts/test-plan-doc.mjs`.
import {
  PLAN_STATUSES, SPIN_GUARD_LIMIT,
  wirePlanDoc, planPath, parsePlanStatus, parsePlanStages, readPlan, writePlan,
  spinPath, readSpin, writeSpin, continueDecision
} from '../src/main/plan-doc.mjs'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, dirname } from 'node:path'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '') }
}

// A temp `.blitzos/jobs` dir for the disk-backed tests; wire plan-doc's resolver at it (the same DI seam the
// transport uses via wirePlanDoc({ getJobsDir })).
const jobsDir = mkdtempSync(join(tmpdir(), 'aos-plan-'))
wirePlanDoc({ getJobsDir: () => jobsDir })

console.log('E1 plan-doc (src/main/plan-doc.mjs):')

// ---- (1) parsePlanStatus -------------------------------------------------------------------------------------
{
  ok('front-matter status', parsePlanStatus('---\nstatus: running\ntitle: x\n---\n# Plan\n') === 'running')
  ok('bare-header status (anywhere)', parsePlanStatus('# Plan\n\nstatus: approved\n\n- [ ] a') === 'approved')
  ok('status is case-insensitive', parsePlanStatus('status: RUNNING') === 'running')
  ok('first status wins', parsePlanStatus('status: proposed\nstatus: running') === 'proposed')
  ok('an invalid status word → null', parsePlanStatus('status: cooking') === null)
  ok('no status line → null', parsePlanStatus('# Plan\n- [ ] a') === null)
  ok('a status: with trailing prose is NOT matched (strict single-word line)',
    parsePlanStatus('status: running because reasons') === null)
  ok('empty / non-string → null', parsePlanStatus('') === null && parsePlanStatus(null) === null)
  ok('PLAN_STATUSES is the canonical set',
    JSON.stringify(PLAN_STATUSES) === JSON.stringify(['proposed', 'approved', 'running', 'done', 'blocked']))
}

// ---- (2) parsePlanStages -------------------------------------------------------------------------------------
{
  const md = [
    '# Plan',
    '- [ ] First stage',
    '- [x] Second stage done',
    '* [X] Third (capital X) done',
    '1. [ ] Fourth ordered',
    '  - [ ] Indented fifth',
    '- [b] Sixth explicitly blocked',
    '- [ ] Seventh (blocked) by a dep',
    'not a stage line',
    '- plain bullet, no checkbox'
  ].join('\n')
  const stages = parsePlanStages(md)
  ok('counts exactly the 7 checkbox lines', stages.length === 7, stages.map((s) => s.title))
  ok('todo / done / done(X) parsed', stages[0].status === 'todo' && stages[1].status === 'done' && stages[2].status === 'done', stages)
  ok('ordered (1.) + indented bullets count as stages', stages[3].title === 'Fourth ordered' && stages[4].title === 'Indented fifth')
  ok('[b] box → blocked', stages[5].status === 'blocked', stages[5])
  ok('an unchecked box tagged (blocked) → blocked', stages[6].status === 'blocked', stages[6])
  ok('a plain bullet without a checkbox is NOT a stage', !stages.some((s) => s.title.includes('plain bullet')))
  ok('non-array text → []', parsePlanStages(null).length === 0)
}

// ---- (3) readPlan off disk (complete / blocked derivation) ---------------------------------------------------
{
  ok('readPlan with no plan.md → null', readPlan('NOPE') === null)

  // approved + partial → not complete, not blocked
  const p1 = writePlan('J1', '---\nstatus: approved\n---\n# Plan\n- [x] one\n- [ ] two\n')
  ok('writePlan created the plan.md at <jobsDir>/<id>/plan.md',
    p1 && p1 === join(jobsDir, 'J1', 'plan.md') && existsSync(p1), p1)
  const r1 = readPlan('J1')
  ok('readPlan: approved + 1/2 done → {status:approved, complete:false, blocked:false}',
    r1 && r1.status === 'approved' && r1.complete === false && r1.blocked === false && r1.stages.length === 2, r1)

  // all stages done → complete (even though status still says running)
  writePlan('J2', 'status: running\n- [x] a\n- [x] b\n')
  const r2 = readPlan('J2')
  ok('readPlan: all stages done → complete:true', r2 && r2.complete === true && r2.blocked === false, r2)

  // top-level status:done with NO stages → complete
  writePlan('J3', 'status: done\n# nothing else')
  ok('readPlan: status:done with no stages → complete:true', readPlan('J3').complete === true)

  // a blocked stage → blocked:true (and not complete)
  writePlan('J4', 'status: running\n- [x] a\n- [b] b\n')
  const r4 = readPlan('J4')
  ok('readPlan: a [b] stage → blocked:true, complete:false', r4 && r4.blocked === true && r4.complete === false, r4)

  // top-level status:blocked → blocked even if stages look fine
  writePlan('J5', 'status: blocked\n- [ ] a\n')
  ok('readPlan: status:blocked → blocked:true', readPlan('J5').blocked === true)

  // zero stages + no done status → not complete (an empty checklist is not "done")
  writePlan('J6', 'status: running\njust prose, no checkboxes')
  ok('readPlan: running with zero stages → complete:false', readPlan('J6').complete === false)
}

// ---- (4) continueDecision: the pure rule + spin-guard --------------------------------------------------------
{
  // continue: approved/running + incomplete + not blocked + not stuck
  const c1 = continueDecision({ planStatus: 'running', complete: false, blocked: false, spinCount: 0, planChangedSinceLastContinue: true })
  ok('running + incomplete → continue, with a next-step message', c1.continue === true && typeof c1.message === 'string' && c1.reason === 'continue', c1)
  ok('approved + incomplete → continue', continueDecision({ planStatus: 'approved', complete: false, blocked: false }).continue === true)

  // stop: complete / blocked / non-execution statuses
  ok('complete → stop (reason complete)', continueDecision({ planStatus: 'running', complete: true, blocked: false }).continue === false)
  ok('blocked → stop (reason blocked)', continueDecision({ planStatus: 'running', complete: false, blocked: true }).reason === 'blocked')
  ok('status proposed → stop (not executing yet)', continueDecision({ planStatus: 'proposed', complete: false, blocked: false }).continue === false)
  ok('status done → stop', continueDecision({ planStatus: 'done', complete: false, blocked: false }).reason === 'status:done')
  ok('no plan status → stop (no-plan)', continueDecision({ planStatus: null, complete: false, blocked: false }).reason === 'no-plan')

  // spin-guard: with NO plan change, the SPIN_GUARD_LIMIT-th consecutive continue trips → stop+stuck.
  // spinCount is the count SO FAR (pre-this-decision); nextSpin = spinCount+1 when unchanged.
  for (let prior = 0; prior < SPIN_GUARD_LIMIT - 1; prior++) {
    const d = continueDecision({ planStatus: 'running', complete: false, blocked: false, spinCount: prior, planChangedSinceLastContinue: false })
    ok(`spin-guard: prior=${prior} no-change → still continue (under cap)`, d.continue === true, d)
  }
  const tripped = continueDecision({ planStatus: 'running', complete: false, blocked: false, spinCount: SPIN_GUARD_LIMIT - 1, planChangedSinceLastContinue: false })
  ok(`spin-guard: prior=${SPIN_GUARD_LIMIT - 1} no-change → STOP + reason 'stuck'`, tripped.continue === false && tripped.reason === 'stuck' && typeof tripped.message === 'string', tripped)

  // a plan change resets the guard: even at a high spinCount, planChanged=true → continue (nextSpin=0).
  const reset = continueDecision({ planStatus: 'running', complete: false, blocked: false, spinCount: 99, planChangedSinceLastContinue: true })
  ok('spin-guard: a plan change resets the counter → continue despite a high spinCount', reset.continue === true, reset)

  // complete/blocked take precedence over the spin-guard (a finished plan stops cleanly even mid-spin).
  ok('complete beats the spin-guard',
    continueDecision({ planStatus: 'running', complete: true, blocked: false, spinCount: 99, planChangedSinceLastContinue: false }).reason === 'complete')
}

// ---- (5) spin-counter file helpers ---------------------------------------------------------------------------
{
  ok('readSpin with no file → 0', readSpin('S1') === 0)
  writeSpin('S1', 2)
  const sp = spinPath('S1')
  ok('spinPath is the .continue-spin sibling of plan.md',
    sp && basename(sp) === '.continue-spin' && dirname(sp) === join(jobsDir, 'S1'), sp)
  ok('writeSpin/readSpin round-trip', readSpin('S1') === 2)
  ok('the counter is stored as a plain integer', readFileSync(sp, 'utf8').trim() === '2')
  writeSpin('S1', 0)
  ok('writeSpin(0) → readSpin 0', readSpin('S1') === 0)
}

rmSync(jobsDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
