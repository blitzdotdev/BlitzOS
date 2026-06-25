export const meta = {
  name: 'test-blitz-comprehensive',
  description: 'Comprehensively test the blitz/blitzscript runtime: live harness×model×effort matrix + fail-loud errors, blitzcheck (syntax/runtime/loop/timeout), dry-run+fallback semantics, live metadata+depth, capabilities enumeration, persistence+recovery across an interrupt, and unit/regression/isolation; then adversarially verify nothing is faked',
  phases: [
    { title: 'Test', detail: '7 parallel categories: harness-matrix(live), blitzcheck, dry-run-fallback, metadata-depth(live), capabilities, persistence-recovery, unit-regression' },
    { title: 'Verify', detail: 'adversarially re-run the riskiest claims + flag built-but-untested gaps' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'
const LLM = ROOT + '/src/main/blitz/llm.mjs'

const CASE = { type: 'object', additionalProperties: false, required: ['name', 'ok', 'detail'], properties: {
  name: { type: 'string' }, ok: { type: 'boolean' }, detail: { type: 'string', description: 'expected vs got, the command/output evidence' } } }
const CAT = { type: 'object', additionalProperties: false, required: ['category', 'ran', 'pass', 'cases', 'realLlmCalls', 'savedTest', 'notes'], properties: {
  category: { type: 'string' }, ran: { type: 'boolean' }, pass: { type: 'boolean' },
  cases: { type: 'array', items: CASE }, realLlmCalls: { type: 'number' },
  savedTest: { type: ['string', 'null'], description: 'repo path if you saved a reusable test, else null' },
  notes: { type: 'string' } } }
const VERIFY = { type: 'object', additionalProperties: false, required: ['realNotFaked', 'allPass', 'perCategory', 'failures', 'coverageGaps', 'verdict'], properties: {
  realNotFaked: { type: 'boolean' }, allPass: { type: 'boolean' },
  perCategory: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['category', 'pass'], properties: { category: { type: 'string' }, pass: { type: 'boolean' } } } },
  failures: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['category', 'what'], properties: { category: { type: 'string' }, what: { type: 'string' } } } },
  coverageGaps: { type: 'array', items: { type: 'string' } },
  verdict: { type: 'string' } } }

const COMMON = `Repo root = ${ROOT} (your cwd). The blitz lib is at src/main/blitz/{llm.mjs,harnesses.mjs,run.mjs,capabilities.mjs,check.mjs}; import llm from '${LLM}'. Runner: \`node src/main/blitz/run.mjs <run|check|capabilities> …\`. Cheap accessible models: claude 'haiku'/'sonnet' (NOT 'fable' — it 404s on this account), codex 'gpt-5.3-codex-spark'/'gpt-5.3-codex'. Do NOT touch the user's WIP (src/renderer/*). Put throwaway fixtures in /tmp with a category-unique prefix. Return the CAT schema (set pass=false if ANY case fails; realLlmCalls = count of REAL claude/codex spawns you caused).`

phase('Test')
const results = (await parallel([
  () => agent(
`Category HARNESS-MATRIX (LIVE — real CLIs). ${COMMON}
Write scripts/tests/live-blitz-matrix.mjs (it makes REAL calls, so name it 'live-'). Import llm. For each combo run a TINY deterministic prompt — use 'What is 17*23? Reply with ONLY the number.' (correct=391) — and assert the answer contains the expected number:
- claude: (model 'haiku'), (model 'sonnet', effort 'low'), (model 'haiku', effort 'high'), (DEFAULT: no model/effort).
- codex: (DEFAULT: no model/effort), (model 'gpt-5.3-codex-spark', effort 'low'), (model 'gpt-5.3-codex', effort 'medium').
FAIL-LOUD error cases (llm() MUST throw, not silently return a wrong answer): (a) claude model 'fable' -> expect a thrown 404-ish error; (b) claude effort 'ultra' -> expect llm() to THROW from build() validation BEFORE any spawn (fast, 0 real calls — verify it's fast); (c) codex model 'nope-not-real-xyz' -> expect a thrown error.
HARD CAP <= 12 real LLM calls. If a model is inaccessible on this account, record that case ok:false with the real error (don't abort the category). category='harness-matrix'.`,
    { label: 'test:harness-matrix', phase: 'Test', schema: CAT }),

  () => agent(
`Category BLITZCHECK (FREE — dry-run, NO real LLM calls). ${COMMON}
Exercise \`node src/main/blitz/run.mjs check <file>\` on fixtures (import llm from '${LLM}', each llm() call gets a fallback 3rd arg):
1. VALID (2-3 llm() with fallbacks) -> expect "syntax: OK", "dry-run: OK", PASS.
2. SYNTAX ERROR (broken paren) -> expect syntax ERROR, FAIL.
3. RUNTIME ERROR (JSON.parse a non-JSON fallback, or read .x of undefined) -> expect dry-run RUNTIME ERROR, FAIL.
4. LLM INFINITE LOOP (while(true){ await llm('x',{harness:'claude'},'fb') }) -> expect dry-run INFINITE LOOP (call cap ~5001), FAIL.
5. PURE-JS INFINITE LOOP (while(true){}) with BLITZ_CHECK_TIMEOUT_MS=3000 -> expect dry-run TIMEOUT, FAIL.
6. The TWO REAL examples (src/main/blitz/examples/naming-tournament.mjs + workflow-patterns.mjs) -> expect PASS for both.
ALSO assert ZERO real spawns: time the VALID case (3 llm() calls) — it must finish < 1s, which is impossible if it spawned real agents; state this as evidence. category='blitzcheck', realLlmCalls must be 0.`,
    { label: 'test:blitzcheck', phase: 'Test', schema: CAT }),

  () => agent(
`Category DRY-RUN-FALLBACK (FREE). ${COMMON}
Verify the llm() 3rd-arg fallback + dry-run semantics. (1) Fixture with 3 llm() calls, distinct fallbacks 'AAA'/'BBB'/'CCC', console.log them joined; run with env BLITZ_DRY_RUN=1 BLITZ_MEM_DIR=/tmp/bdf-mem (node directly) -> assert stdout has AAA,BBB,CCC (control flow used fallbacks, no real calls). (2) An llm() call that OMITS the fallback (2 args) under dry-run -> assert the returned value is the generic placeholder containing 'dry-run fallback'. (3) Prove the dry vs real code paths differ WITHOUT a real call: import { _setSpawn, llm } from the lib, set a stub spawner returning a fake claude json '{"result":"REALPATH"}'; with BLITZ_DRY_RUN unset -> llm() returns the parsed stub ('REALPATH'); with BLITZ_DRY_RUN=1 -> llm() returns the fallback instead (stub NOT called). category='dry-run-fallback', realLlmCalls=0.`,
    { label: 'test:dry-run-fallback', phase: 'Test', schema: CAT }),

  () => agent(
`Category METADATA-DEPTH (LIVE — few real calls). ${COMMON}
Prove the metadata llm() appends actually reaches the REAL leaf. FREE part: import { leafMetadata } from the lib; assert leafMetadata(1) contains 'depth 1', 'do NOT recurse' (or 'no blitz run'), and the act-vs-ask/irreversible line. LIVE part (<= 3 real calls, claude model 'haiku'): (a) llm("In the [blitzscript runtime metadata] appended to this prompt, what depth number is stated? Reply with ONLY that integer.") -> expect '1'. (b) llm("Per the metadata block, are you permitted to spawn sub-agents / run another workflow? Reply only yes or no.") -> expect 'no'. This confirms depth + no-recurse really reach the leaf. category='metadata-depth'.`,
    { label: 'test:metadata-depth', phase: 'Test', schema: CAT }),

  () => agent(
`Category CAPABILITIES (FREE). ${COMMON}
Run \`node src/main/blitz/run.mjs capabilities\` and parse its text. Assert: (1) completes < 3s; (2) claude available with >= 2 models and effort set includes low/medium/high/xhigh/max; (3) codex available with >= 3 models — MUST include more than the config default (expect gpt-5.3-codex, gpt-5.3-codex-spark, and gpt-5.4 and/or gpt-5.5) AND >= 3 effort levels including at least low, medium, high, xhigh (this is the bug just fixed: it previously showed only the default 'high'); (4) pi and opencode show UNAVAILABLE/stub; (5) the cheap=/strong= and the account-access fail-loud note are present. One case per assertion. category='capabilities', realLlmCalls=0.`,
    { label: 'test:capabilities', phase: 'Test', schema: CAT }),

  () => agent(
`Category PERSISTENCE-RECOVERY (FREE — dry-run). ${COMMON}
Automatic journaling/fast-forward resume is DESIGNED but NOT built yet; test the BUILT primitive it will use: BLITZ_MEM_DIR fs state surviving an interrupt + a workflow-authored resume reading it.
Write /tmp/blitz-resume-wf.mjs: read process.env.BLITZ_MEM_DIR; for i in 1..5: if <mem>/step-i.json exists -> console.error('skip '+i); else await llm('step '+i,{harness:'claude'},'OK-'+i) (BLITZ_DRY_RUN will be set so it returns the fallback), writeFileSync(<mem>/step-i.json, result), console.error('did '+i), then await ~250ms. At end console.log('DONE 5/5').
Harness (node/bash): FIXED mem=/tmp/blitz-resume-mem (rm -rf it first). RUN 1: spawn with env BLITZ_DRY_RUN=1 BLITZ_MEM_DIR=/tmp/blitz-resume-mem BLITZ_DEPTH=0; poll until step-3.json exists then SIGKILL the process (interrupt mid-run). Assert: step-1..3.json exist, step-4/5 do NOT, 'DONE' NOT printed. RUN 2: re-run SAME mem dir; assert stderr shows skip 1/2/3 + did 4/5, stdout prints 'DONE 5/5', all 5 files exist.
In notes, state clearly: this validates fs persistence + the resume PATTERN; automatic positional-index+prompt-hash journaling is the unbuilt next slice. category='persistence-recovery', realLlmCalls=0.`,
    { label: 'test:persistence-recovery', phase: 'Test', schema: CAT }),

  () => agent(
`Category UNIT-REGRESSION-ISOLATION (FREE). ${COMMON}
(1) Run \`node scripts/tests/test-blitz-llm.mjs\` -> assert it prints PASS with 0 failures (paste the tail). (2) Import-sanity: confirm each blitz module loads under bare node — \`node --input-type=module -e "await import('${ROOT}/src/main/blitz/llm.mjs'); await import('${ROOT}/src/main/blitz/harnesses.mjs'); await import('${ROOT}/src/main/blitz/capabilities.mjs'); await import('${ROOT}/src/main/blitz/check.mjs'); console.log('imports ok')"\`. (3) ISOLATION: \`git status --short\` — confirm the only blitz-related changes are NEW files under src/main/blitz/ + scripts/tests/ + plans/blitzos-blitzscript.md; and grep src/renderer/src/{App.tsx,store.ts,components/PrimarySpace.tsx,styles.css} for references to our lib (import of llm.mjs / src/main/blitz) -> expect NONE (those M files are the user's pre-existing WIP, untouched by blitz). category='unit-regression-isolation', realLlmCalls=0.`,
    { label: 'test:unit-regression', phase: 'Test', schema: CAT }),
])).filter(Boolean)

phase('Verify')
const verdict = await agent(
`Adversarially verify the blitz test suite is REAL, not faked, and aggregate. ${COMMON}
Here are the 7 category results (JSON):\n${JSON.stringify(results, null, 1)}\n
Re-run the RISKIEST claims yourself, do not trust the reports:
- harness-matrix really hit REAL CLIs: run ONE real llm() (import from '${LLM}', claude 'haiku', 'What is 6*7? Reply with ONLY the number.' -> expect 42) and ONE real \`codex exec\` (tiny), confirm real answers; check a fresh rollout exists (~/.claude/projects/**/*.jsonl or ~/.codex/sessions modified in the last ~10 min).
- blitzcheck really spent ZERO real calls: re-run \`blitz check\` on a fresh 3-llm()-call valid fixture; confirm it finishes < 1s (impossible with real spawns).
- persistence-recovery really recovered: inspect /tmp/blitz-resume-mem (should have step-1..5.json) or re-run the recovery harness.
Then AGGREGATE: perCategory pass/fail; FAILURES with specifics; and COVERAGE GAPS — call out any feature we BUILT that went untested, and confirm the correctly-untested designed-but-unbuilt items (cwd/worktree opt, automatic journaling, the orchestrators toggle + duty injection) are noted as gaps not as passing. Be skeptical: if any 'pass' looks stubbed or hardcoded, say so. Return the VERIFY schema.`,
  { label: 'verify', schema: VERIFY })

return { results, verdict }
