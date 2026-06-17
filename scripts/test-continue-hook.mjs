// test-continue-hook.mjs — the E1 continuation Stop-hook SCRIPT end-to-end (agent-runtime.mjs CONTINUE_HOOK_SCRIPT
// / writeContinueHook). This is the DRIFT GUARD: the script is a self-contained POSIX sh that must parse the SAME
// plan.md grammar plan-doc.mjs does. We run the REAL script (via `sh`) against fixtures and assert:
//   (1) its stdout is Claude Code's Stop-hook JSON — `{"decision":"block",...}` to continue, EMPTY to allow stop —
//       and it always exits 0;
//   (2) its continue/stop decision AGREES with plan-doc's pure continueDecision(readPlan(...)) for every fixture
//       (so the shell parser and the JS parser can never silently drift);
//   (3) the SPIN-GUARD actually trips across repeated no-change invocations and resets when plan.md changes.
//
// The LIVE-FIRING boundary: this proves the script's logic + output bytes. It does NOT prove Claude Code actually
// fires the hook on yield and obeys the block (that is runtime, requires a live agent + the GUI, and is out of
// scope for a headless test). Run with `node scripts/test-continue-hook.mjs`.
import { writeContinueHook, continuationHookSettings } from '../src/main/agent-runtime.mjs'
import { wirePlanDoc, writePlan, planPath, readPlan, continueDecision, SPIN_GUARD_LIMIT } from '../src/main/plan-doc.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '') }
}

const jobsDir = mkdtempSync(join(tmpdir(), 'aos-hook-'))
wirePlanDoc({ getJobsDir: () => jobsDir })

// Run the per-agent hook script once, feeding it a stop-hook stdin payload. Returns { out, code, blocked }.
const runHook = (agentId, stdin = '{"stop_hook_active":false}') => {
  const script = writeContinueHook(planPath(agentId))
  let out = '', code = 0
  try {
    out = execFileSync('sh', [script], { input: stdin, encoding: 'utf8' })
  } catch (e) {
    code = e.status ?? 1
    out = (e.stdout || '').toString()
  }
  let parsed = null
  try { parsed = out.trim() ? JSON.parse(out) : null } catch { /* non-JSON */ }
  return { out: out.trim(), code, blocked: !!(parsed && parsed.decision === 'block'), parsed }
}

console.log('E1 continuation Stop-hook script (agent-runtime.mjs CONTINUE_HOOK_SCRIPT):')

// ---- the settings object the launch installs ----------------------------------------------------------------
{
  const s = continuationHookSettings('/abs/continue-hook.sh')
  ok('continuationHookSettings shapes a Claude Code Stop hook',
    !!s && Array.isArray(s.hooks?.Stop) && s.hooks.Stop[0].hooks[0].type === 'command' &&
    s.hooks.Stop[0].hooks[0].command.includes('continue-hook.sh'), s)
  ok('continuationHookSettings(null) → null (no script ⇒ no hook)', continuationHookSettings(null) === null)
  ok('writeContinueHook(null) → null', writeContinueHook(null) === null)
}

// ---- (1)+(2) per-fixture: stdout shape + AGREEMENT with the JS decision --------------------------------------
// Each fixture: a plan.md + the EXPECTED continue (block) vs stop. The script's decision is checked against BOTH
// the literal expectation AND plan-doc's continueDecision(readPlan) — they must all agree.
const FIXTURES = [
  ['running + incomplete', 'status: running\n- [x] a\n- [ ] b\n', true],
  ['approved + incomplete', '---\nstatus: approved\n---\n- [ ] a\n- [ ] b\n', true],
  ['running + all stages done → stop', 'status: running\n- [x] a\n- [x] b\n', false],
  ['status:done → stop', 'status: done\n- [x] a\n', false],
  ['a blocked stage → stop', 'status: running\n- [x] a\n- [b] b\n', false],
  ['status:blocked → stop', 'status: blocked\n- [ ] a\n', false],
  ['proposed (not executing) → stop', 'status: proposed\n- [ ] a\n', false],
  ['no status line → stop', '# Plan\n- [ ] a\n', false],
  // A running plan with zero parseable stages is incomplete + unblocked + in-execution → CONTINUE (then the
  // spin-guard catches it: an unchanging empty plan stops as 'stuck' after the cap). This is the safe default —
  // a running job with a malformed plan keeps driving rather than silently quitting. Shell + JS agree on this.
  ['running + zero stages → continue (then spin-guard catches a stalled plan)', 'status: running\nprose only\n', true],
  ['an unchecked (blocked)-tagged stage → stop', 'status: running\n- [ ] a (blocked) waiting\n', false]
]
for (const [name, md, expectContinue] of FIXTURES) {
  const id = 'F' + name.replace(/\W+/g, '').slice(0, 12)
  writePlan(id, md)
  const r = runHook(id)
  // pure JS decision for the same plan (the source of truth the shell must mirror)
  const plan = readPlan(id)
  const js = continueDecision({ planStatus: plan.status, complete: plan.complete, blocked: plan.blocked, spinCount: 0, planChangedSinceLastContinue: true })
  ok(`${name}: exit 0`, r.code === 0, { code: r.code, out: r.out })
  ok(`${name}: shell block=${r.blocked} matches expectation ${expectContinue}`, r.blocked === expectContinue, r.out)
  ok(`${name}: shell agrees with JS continueDecision (${js.continue})`, r.blocked === js.continue, { shell: r.blocked, js: js.continue })
  if (!expectContinue) ok(`${name}: a stop prints NOTHING`, r.out === '', r.out)
  if (expectContinue) ok(`${name}: a continue emits decision:block + a reason`, r.parsed?.decision === 'block' && typeof r.parsed?.reason === 'string', r.parsed)
}

// ---- (3) the spin-guard across repeated no-change invocations ------------------------------------------------
{
  const id = 'SPIN'
  writePlan(id, 'status: running\n- [x] a\n- [ ] b\n') // a real driving plan that never advances
  // Run #1 establishes the plan fingerprint (a free first continue — no prior to compare). Then SPIN_GUARD_LIMIT
  // consecutive NO-CHANGE continues accumulate; the (LIMIT+1)-th invocation reaches the cap → stop + stuck. (The
  // pure continueDecision agrees: its spinCount is "no-change continues so far", tripping when count+1 >= LIMIT.)
  const TRIP_AT = SPIN_GUARD_LIMIT + 1
  let trippedAt = 0
  for (let i = 1; i <= TRIP_AT; i++) {
    const r = runHook(id)
    const stuck = r.blocked && /spin-guard/i.test(r.parsed?.reason || '')
    if (stuck && !trippedAt) trippedAt = i
    if (i < TRIP_AT) ok(`spin-guard run #${i}: still continue (under cap)`, r.blocked === true && !stuck, r.out)
    else ok(`spin-guard run #${i} (==cap+1): STOPS the loop with a spin-guard reason`, stuck, r.parsed)
  }
  ok(`spin-guard trips exactly at run #${TRIP_AT} (first run is the free baseline)`, trippedAt === TRIP_AT, { trippedAt })
  // After tripping, the spin state is cleared, so a fresh unchanged run starts the count over (continues again).
  const after = runHook(id)
  ok('after a trip the counter resets → the next run continues again', after.blocked === true && !/spin-guard/i.test(after.parsed?.reason || ''), after.out)

  // A plan CHANGE between runs resets the guard: change the plan each time → never trips.
  const id2 = 'SPIN2'
  let tripped2 = false
  for (let i = 1; i <= SPIN_GUARD_LIMIT + 2; i++) {
    writePlan(id2, `status: running\n- [x] a\n- [ ] b\n<!-- progress note ${i} -->\n`) // plan.md content differs each run
    const r = runHook(id2)
    if (!r.blocked || /spin-guard/i.test(r.parsed?.reason || '')) tripped2 = tripped2 || /spin-guard/i.test(r.parsed?.reason || '')
  }
  ok('a plan that changes every run NEVER trips the spin-guard', tripped2 === false)
}

// ---- the script + counter live in the job dir ---------------------------------------------------------------
{
  ok('the hook script is written into the job dir (sibling of plan.md)', existsSync(join(jobsDir, 'SPIN', 'continue-hook.sh')))
}

rmSync(jobsDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
