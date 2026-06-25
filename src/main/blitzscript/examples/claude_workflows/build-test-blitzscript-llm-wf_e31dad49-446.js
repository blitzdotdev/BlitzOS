export const meta = {
  name: 'build-test-blitzscript-llm',
  description: 'Build the thin blitzscript llm() chokepoint (harness/model/effort; claude + codex, pi/opencode extensible) and validate it live against real claude -p + codex exec with realistic user-style example workflows',
  phases: [
    { title: 'Build', detail: 'src/main/blitz: llm() + pluggable harness registry + runner + headless unit tests' },
    { title: 'Live', detail: 'call llm() against REAL claude -p and codex exec' },
    { title: 'Examples', detail: 'realistic user-style blitzscripts: naming tournament + workflow-patterns research' },
    { title: 'Verify', detail: 'adversarially confirm it really ran, nothing stubbed/hardcoded' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'

const BUILD_SCHEMA = { type: 'object', additionalProperties: false, required: ['filesCreated','api','harnesses','unitTestsPass','notes'], properties: {
  filesCreated: { type: 'array', items: { type: 'string' } },
  api: { type: 'string', description: 'the exact llm() signature + opts' },
  harnesses: { type: 'array', items: { type: 'string' } },
  unitTestsPass: { type: 'boolean' },
  notes: { type: 'string' } } }

const LIVE_SCHEMA = { type: 'object', additionalProperties: false, required: ['harness','ran','ok','command','response','notes'], properties: {
  harness: { type: 'string' }, ran: { type: 'boolean' }, ok: { type: 'boolean' },
  command: { type: 'string', description: 'the exact CLI command llm() spawned' },
  response: { type: 'string', description: 'the raw response text the harness returned' },
  notes: { type: 'string' } } }

const EX_SCHEMA = { type: 'object', additionalProperties: false, required: ['example','scriptPath','ran','ok','llmCalls','harness','output','notes'], properties: {
  example: { type: 'string' }, scriptPath: { type: 'string' }, ran: { type: 'boolean' }, ok: { type: 'boolean' },
  llmCalls: { type: 'number' }, harness: { type: 'string' },
  output: { type: 'string', description: 'the actual result the workflow produced (top-3 names / synthesized knobs)' },
  notes: { type: 'string' } } }

const VERIFY_SCHEMA = { type: 'object', additionalProperties: false, required: ['realNotFaked','claudeWorks','codexWorks','examplesReal','issues','verdict'], properties: {
  realNotFaked: { type: 'boolean' }, claudeWorks: { type: 'boolean' }, codexWorks: { type: 'boolean' }, examplesReal: { type: 'boolean' },
  issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity','what'], properties: { severity: { type: 'string' }, what: { type: 'string' } } } },
  verdict: { type: 'string' } } }

phase('Build')
const build = await agent(
`Build the THIN \`blitz\` runtime for blitzscript (BlitzOS agent-authored workflows). Repo root = ${ROOT} (your cwd). FIRST read plans/blitzos-blitzscript.md for the design: an agent writes plain-Node JS, llm() shells out to a LOCAL agent CLI on this machine, memory = fs, NO sandbox, depth is TOLD to the leaf via appended prompt metadata (NOT gated by main).

BUILD (plain Node, NO electron imports, runnable with bare \`node\`), new files only under src/main/blitz/ :
- llm.mjs — the ONLY export a workflow imports: \`export async function llm(prompt, opts = {})\`.
  * opts THIN, exactly: { harness?: string (default 'claude'), model?: string, effort?: string }. Comment that maxTokens/schema/files are FUTURE, not now.
  * Builds the command for the chosen harness, SPAWNS it on this machine (node:child_process), captures stdout, returns the harness's final assistant text as a string.
  * APPENDS a metadata block to the prompt before sending: the leaf depth (Number(process.env.BLITZ_DEPTH||0)+1), an explicit 'You are a leaf agent inside a blitzscript workflow. Do NOT recurse: no blitz run, no spawning sub-agents. Answer the task directly.', and the act-vs-ask boundary (do reversible work; ask before irreversible outward acts). Set BLITZ_DEPTH=<leaf depth> on the CHILD env (propagation/labeling only; do NOT gate or refuse).
  * Self-caps concurrency with an internal async semaphore (default max(2, os.cpus().length-2)) so a wide Promise.all of llm() calls never spawns unbounded processes. Keep a simple call counter.
  * The spawner must be INJECTABLE (e.g. an internal _spawn you can override) so unit tests never hit a real LLM.
- harnesses.mjs — a pluggable registry. Implement 'claude' and 'codex'; add 'pi' and 'opencode' as STUB entries with a // TODO so the extension point is obvious. Shape: { claude: { build(prompt, opts) -> {cmd, args, env}, parse(stdout) -> text }, codex: {...} }.
  * claude: confirm exact flags by running \`claude --help\` and \`claude -p --help\`. Use print mode -p so the final text lands on stdout. Map opts.model -> --model; opts.effort -> the correct flag (claude supports --effort low|medium|high|xhigh|max — confirm). Add --dangerously-skip-permissions so a leaf that needs tools is not blocked. Pick --output-format that cleanly yields the final text (text vs json) and parse accordingly.
  * codex: confirm flags via \`codex exec --help\`. Command base: \`codex exec [PROMPT]\` with \`-c model="<model>"\` and \`-c model_reasoning_effort="<effort>"\` and \`--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check\`. codex exec prints the agent output to stdout; if plain stdout is noisy, use \`--json\` and extract the final agent_message/message event. GET THIS RIGHT against real codex output (run a tiny real codex exec to see its output shape).
- run.mjs — \`blitz run <workflow.mjs>\`: set BLITZ_WS (workspace root, default cwd), BLITZ_MEM_DIR (<ws>/.blitzos/workflows/<id>/, mkdir -p), BLITZ_DEPTH=0, then run the workflow file with node and stream its stdout (that's the result). NO depth gate. ~30 lines.

UNIT TESTS (headless, NO real LLM): scripts/tests/test-blitz-llm.mjs — inject a fake spawner and assert: (1) the metadata block (depth + no-recurse + act-vs-ask) is present in the prompt actually sent; (2) BLITZ_DEPTH is set + incremented on the child env; (3) the claude vs codex command+flags are built correctly for given {harness, model, effort}; (4) the concurrency semaphore bounds parallelism; (5) parse() extracts text from a sample stdout for each harness. Run \`node scripts/tests/test-blitz-llm.mjs\` and confirm it PASSES.

CONSTRAINTS: plain Node only. Add NEW files only; do NOT touch src/renderer/* or any pre-existing file. Return the schema (filesCreated, the api signature, harnesses implemented, unitTestsPass, notes).`,
  { label: 'build:blitz-llm', schema: BUILD_SCHEMA })

const livePrompt = (h) =>
`Live-test the just-built blitz llm() against the REAL \`${h}\` CLI on this machine. Repo root = ${ROOT} (cwd). The lib is at src/main/blitz/llm.mjs + harnesses.mjs — READ them for the exact API/flags.
1. Confirm the CLI: \`${h === 'claude' ? 'claude --version' : 'codex --version'}\`.
2. Write a throwaway script /tmp/blitz-live-${h}.mjs:  import { llm } from '${ROOT}/src/main/blitz/llm.mjs'; then call llm() TWICE with harness:'${h}' and a CHEAP/FAST model:
   (a) llm('Reply with exactly the word PONG and nothing else.', { harness:'${h}', model:<a cheap model the CLI accepts> }) -> expect a response containing PONG.
   (b) llm('What is 17*23? Reply with ONLY the number.', { harness:'${h}' }) -> expect 391.
   Run it with \`node /tmp/blitz-live-${h}.mjs\`.
3. If the harness needs different flags/parse than the lib uses, FIX src/main/blitz/harnesses.mjs minimally so the live call works, and say exactly what you changed.
4. HARD CAP: <= 3 real ${h} calls total. If ${h} is not installed/authed, set ok:false and put the real error in notes (do NOT fail loudly — just report).
Return the schema: harness='${h}', ran, ok, the EXACT command llm() spawned, the raw response(s), notes.`

phase('Live')
const live = (await parallel([
  () => agent(livePrompt('claude'), { label: 'live:claude', phase: 'Live', schema: LIVE_SCHEMA }),
  () => agent(livePrompt('codex'),  { label: 'live:codex',  phase: 'Live', schema: LIVE_SCHEMA }),
])).filter(Boolean)
const okHarnesses = live.filter(l => l && l.ok).map(l => l.harness)
log(`live harnesses working: ${okHarnesses.join(', ') || 'NONE'}`)

let examples = []
if (okHarnesses.length) {
  const H = okHarnesses[0] // use a confirmed-working harness for the examples
  phase('Examples')
  examples = (await parallel([
    () => agent(
`Write and RUN a realistic blitzscript example mirroring a REAL BlitzOS user request: "Read plans/blitzos-blitzscript.md. I need a better name than 'workflows'. Brainstorm a bunch of options and run a tournament to pick the top 3." Repo root = ${ROOT} (cwd). The lib is at src/main/blitz/llm.mjs.
Write src/main/blitz/examples/naming-tournament.mjs as PLAIN NODE the way a real user's orchestrator agent would (import { llm } from the abs path, node:fs, Promise.all):
- read plans/blitzos-blitzscript.md
- fan out 2-3 PARALLEL llm() calls (harness:'${H}', a cheap model), each brainstorming ~5 candidate names given the doc; collect + DEDUP in code (~12 candidates)
- tournament: a few llm() JUDGE calls that score/compare candidates; do the bracket/scoring in CODE, llm() only for judgments; pick the top 3
- console.log the top 3, each with a one-line rationale
HARD CAP: <= 8 total llm() calls, cheap/fast leaves. RUN it via \`node src/main/blitz/run.mjs src/main/blitz/examples/naming-tournament.mjs\` (exercise the runner). Confirm the 3 names are REAL llm() output, not hardcoded. Return the schema (example='naming-tournament', scriptPath, ran, ok, llmCalls, harness, output=the actual top-3, notes).`,
      { label: 'ex:naming', phase: 'Examples', schema: EX_SCHEMA }),
    () => agent(
`Write and RUN a bounded realistic blitzscript example mirroring: "Research workflow patterns (fan-out/fan-in, actor-critic, etc.) and identify the principal components (depth, breadth, loop count, ...) that explain variance across all workflows, so we can give users better control knobs." Repo root = ${ROOT} (cwd). The lib is at src/main/blitz/llm.mjs.
Write src/main/blitz/examples/workflow-patterns.mjs (plain Node, import { llm }, Promise.all):
- fan out 3-4 PARALLEL llm() calls (harness:'${H}', cheap model), each enumerating + describing a family of workflow patterns FROM ITS OWN KNOWLEDGE (no web dependency, so the test is deterministic)
- a fan-in SYNTHESIS llm() call that extracts the PRINCIPAL DIMENSIONS (depth, breadth, loop/iteration count, parallelism, critic/feedback presence, ...) that explain variance across the patterns, and proposes a small set of user CONTROL KNOBS
- console.log the synthesized dimensions + proposed knobs
HARD CAP: <= 6 total llm() calls, cheap/fast leaves. RUN it via \`node src/main/blitz/run.mjs src/main/blitz/examples/workflow-patterns.mjs\`. Confirm REAL llm() output drove the result. Return the schema (example='workflow-patterns', scriptPath, ran, ok, llmCalls, harness, output=the synthesized knobs, notes).`,
      { label: 'ex:research', phase: 'Examples', schema: EX_SCHEMA }),
  ])).filter(Boolean)
} else {
  log('skipping examples: no harness worked in the live phase')
}

phase('Verify')
const verdict = await agent(
`Adversarially verify the blitz llm() build + tests are REAL, not faked. Repo root = ${ROOT} (cwd). Be skeptical: if anything is stubbed, hardcoded, or mocked-and-reported-as-real, CALL IT OUT.
- Read src/main/blitz/{llm.mjs,harnesses.mjs,run.mjs} + scripts/tests/test-blitz-llm.mjs. Confirm they match plans/blitzos-blitzscript.md: thin opts {harness,model,effort}; metadata-append (depth + no-recurse + act-vs-ask) actually in the sent prompt; concurrency semaphore; NO depth gate (depth only TAGGED); pluggable registry with claude+codex implemented and pi/opencode extension stubs.
- Run \`node scripts/tests/test-blitz-llm.mjs\` yourself; confirm PASS (paste the tail).
- Confirm the LIVE tests hit REAL CLIs: the live agents reported exact commands + raw responses (PONG / 391) — sanity check those are plausible real claude/codex output, not fabricated. If cheap, run ONE more real llm() call yourself (e.g. via a 2-line node script importing llm.mjs) for whichever harness(es) the live phase said worked.
- Confirm the example workflows produced REAL output from REAL llm() calls: inspect src/main/blitz/examples/*.mjs (are names/knobs computed from llm() output, or hardcoded?) and their reported output. Re-run ONE example if cheap.
Return the schema: realNotFaked, claudeWorks, codexWorks, examplesReal, issues[{severity,what}], a 2-line verdict.`,
  { label: 'verify', schema: VERIFY_SCHEMA })

return { build, live, examples, verdict }
