export const meta = {
  name: 'island-tournament-refactor',
  description: 'Functionality-only island refactor: per-part planner/censor/judge tournaments -> committee report -> builder<->committee loop',
  phases: [
    { title: 'Tournament', detail: 'per sub-part: planner -> censor -> judge, loop until pass' },
    { title: 'Committee report', detail: 'fittest plans -> coherence review -> unified build report' },
    { title: 'Build', detail: 'builder builds -> verify -> committee reviews, loop until approved' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'
const MAX_TOURNEY_ROUNDS = 3
const MAX_BUILD_ROUNDS = 4

const SEAMS = `VERIFIED seams (job-model is GONE; build against THESE, in electron-os-tools.ts/osActions.ts):
- spawn OFF (default chat tab): electronOps.spawnAgent(title) -> {id,title}; then electronOps.userMessage(prompt,id).
- spawn ON (heavy task): electronOps.startWorkflow({task, contextRefs, title}) -> {ok, agent:{id,title}} (orchestrators ON).
- message: electronOps.userMessage(text,id) [NOT emitUserMessage — userMessage writes chat.md AND wakes].
- toggle flip: electronOps.setOrchestrators(id,on) (live, no restart).
- agent state/auto-name: osGetState().agentStatus (= chatStatusSnapshot, {id->status}) + agent titles.
- agent reply lines: TAIL the agent's <ws>/.blitzos/terminals/<id>/chat.md (appendChatMessage writes 'agent'/'user' turns).
- concise "you are in the island, answer concisely" preamble: seed ONCE at spawn, not per message.`

const CONTRACT = `WS frame contract (island <-> bridge, JSON text frames):
island->bridge: {t:'hello',token,pid,bundleId} | {t:'process.spawn',prompt,paths,orchestrators} | {t:'process.message',id,text,paths} | {t:'process.orchestrators',id,on} | {t:'pong'}
bridge->island: {t:'process.list',processes:[{id,title,state}]} | {t:'process.upsert',id,title?,state?} | {t:'process.event',id,line:{at,text}} | {t:'ping'}`

const KNOWN = `CURRENT STATE + THE 3 BUGS TO FIX (verified this session):
- The island (native/island-helper/main.swift) renders + connects + has tab/chat/list UI + a canBecomeKey editing-flag keyboard-focus mechanism. The bridge (src/main/island-bridge.mjs) is pure-node + dependency-injected (setIslandDeps) + mounted by control-server.ts (attachIslandWebSocket). test-island-bridge.mjs passes with STUB deps.
- BUG 1 new-tab-spawn: the island bound to / showed an EXISTING agent instead of: ⌥Space (or '+') = a FRESH tab whose FIRST Send SPAWNS A NEW agent, then switch+auto-name that tab; later sends -> message that agent.
- BUG 2 message LEAK: the bridge listed processes from osGetState().agentStatus and tailed EVERY agent's chat.md INCLUDING the primary agent '0' (the user's main canvas chat), so the island mirrored the primary's whole conversation. FIX: the island tracks ONLY island-spawned agent ids; never list/tail '0' or any non-island agent.
- BUG 3 wiring GONE: src/main/index.ts currently has NO island wiring (setIslandDeps + launchIslandHelper were clobbered). It must be RE-ADDED additively, scoped to island ids.`

const RULES = `RULES (hard):
- FUNCTIONALITY ONLY — no design/visual/aesthetic changes.
- Do NOT edit src/main/osActions.ts, electron-os-tools.ts, launcher.ts, or src/renderer/** (the user is actively editing them). index.ts edits must be ADDITIVE (leave the wireLauncher/start_workflow area alone). island-bridge.mjs MUST stay pure-node (no electron import) so the test runs.
- "Island-spawned" = the set of agent ids the bridge created via process.spawn; isolation means only those ids are ever listed/tailed.`

const PARTS = [
  { key:'newtab',    title:'New-tab spawn semantics', scope:'⌥Space/+ -> fresh chat-bar tab; first Send -> process.spawn -> a NEW agent (ON=startWorkflow / OFF=spawnAgent+userMessage); switch+auto-name that tab; later sends -> process.message to THAT agent; toggle flip -> process.orchestrators->setOrchestrators. Spans main.swift tab/send logic + the bridge spawn handler + the island-ids set.' },
  { key:'isolation', title:'Isolation / no message leak', scope:'island tracks ONLY island-spawned agent ids; bridge listProcesses + chat.md tail scoped to those ids; NEVER the primary 0 or other agents; main.swift never renders a foreign stream. This is the core leak fix.' },
  { key:'wiring',    title:'index.ts re-wire + helper lifecycle', scope:'restore setIslandDeps(realDeps) + launchIslandHelper in index.ts (ADDITIVE); realDeps map to the verified electronOps seams + scoped to island ids; survives BlitzOS restart; keeps tsc 0 on index.ts.' },
  { key:'replies',   title:'Reply/event streaming correctness', scope:'chat.md tail: only NEW agent turns per island-agent, no dup/replay across reconnect, handles missing/created files + per-file byte offset; status + auto-name process.upsert; correct id->tab routing in main.swift.' },
  { key:'conn',      title:'Connection/reconnect robustness', scope:'token auth, reconnect-with-backoff, island survives a BlitzOS restart (re-reads session.json incl. the NEW port), snapshot-on-connect rehydrates the island-owned tabs, NO duplicate/leaked state across reconnects, no thrash.' },
  { key:'focus',     title:'Keyboard-input correctness', scope:'typing in the notch actually receives keystrokes (the canBecomeKey editing-flag + makeKey/resign mechanism); relinquishes on send/close; does NOT break always-on visibility, the non-activating behavior when idle, or the ⌥Space toggle.' },
]

const PLAN_SCHEMA = { type:'object', required:['approach','changes'], properties:{ approach:{type:'string'}, changes:{type:'array', items:{type:'object', required:['file','change','rationale'], properties:{ file:{type:'string'}, change:{type:'string'}, rationale:{type:'string'} }}}, edge_cases_handled:{type:'array', items:{type:'string'}}, future_proofing:{type:'array', items:{type:'string'}}, test_additions:{type:'array', items:{type:'string'}} } }
const CENSOR_SCHEMA = { type:'object', required:['objections','overall'], properties:{ objections:{type:'array', items:{type:'object', required:['severity','issue','scenario'], properties:{ severity:{type:'string', enum:['fatal','major','minor']}, issue:{type:'string'}, scenario:{type:'string'} }}}, overall:{type:'string', enum:['reject','weak','sound']} } }
const JUDGE_SCHEMA = { type:'object', required:['pass','reasoning','guidance_for_next_round'], properties:{ pass:{type:'boolean'}, reasoning:{type:'string'}, guidance_for_next_round:{type:'string', description:'concrete: exactly what the planner must fix next round (empty if pass)'} } }
const REPORT_SCHEMA = { type:'object', required:['unified_spec','build_order','files_touched'], properties:{ unified_spec:{type:'string', description:'the complete functional change set, file by file'}, build_order:{type:'array', items:{type:'string'}}, cross_part_conflicts_resolved:{type:'array', items:{type:'string'}}, files_touched:{type:'array', items:{type:'string'}}, acceptance_tests:{type:'array', items:{type:'string'}} } }
const AUTHORED_SCHEMA = { type:'object', required:['files','summary'], properties:{ files:{type:'array', items:{type:'string'}}, summary:{type:'string'} } }
const BUILD_SCHEMA = { type:'object', required:['ok','detail'], properties:{ ok:{type:'boolean'}, detail:{type:'string'} } }
const COMMITTEE_SCHEMA = { type:'object', required:['approved','feedback'], properties:{ approved:{type:'boolean'}, feedback:{type:'string'}, blocking:{type:'array', items:{type:'string'}} } }

// ---------- Tournament (parallel parts; sequential rounds within each) ----------
phase('Tournament')
const survivors = (await parallel(PARTS.map((part) => async () => {
  let guidance = '(round 1 — no prior feedback yet)'
  let last = null
  for (let r = 1; r <= MAX_TOURNEY_ROUNDS; r++) {
    const plan = await agent(`You are the PLANNER for the island sub-part "${part.title}" (round ${r}/${MAX_TOURNEY_ROUNDS}). Explore the real code (read ${ROOT}/native/island-helper/main.swift, ${ROOT}/src/main/island-bridge.mjs, ${ROOT}/src/main/index.ts, ${ROOT}/src/main/control-server.ts as needed) and propose a CONCRETE functional fix plan for THIS sub-part ONLY.\nSCOPE: ${part.scope}\n${KNOWN}\n${SEAMS}\n${CONTRACT}\n${RULES}\nLAST-ROUND JUDGE FEEDBACK (you MUST address it): ${guidance}\nOutput: approach, exact changes (file/change/rationale), edge_cases_handled, future_proofing, test_additions. Functionality only.`, { schema: PLAN_SCHEMA, phase:'Tournament', label:`plan:${part.key}#${r}` })
    if (!plan) break
    const censor = await agent(`You are the CENSOR (ruthless adversary) for the island sub-part "${part.title}". The planner proposed:\n${JSON.stringify(plan)}\nArgue AGAINST it: every way it fails, breaks an edge case, conflicts with the seams/contract, leaks (esp. the primary agent '0'), regresses always-on/keyboard/reconnect, or is incomplete/not-future-proof. Name the exact scenario for each.\n${KNOWN}\n${SEAMS}\n${CONTRACT}\n${RULES}\nOutput objections (severity/issue/scenario) + overall verdict.`, { schema: CENSOR_SCHEMA, phase:'Tournament', label:`censor:${part.key}#${r}` })
    const judge = await agent(`You are the JUDGE for the island sub-part "${part.title}".\nPLANNER PLAN:\n${JSON.stringify(plan)}\nCENSOR OBJECTIONS:\n${JSON.stringify(censor)}\nDecide PASS only if the plan is correct, complete, future-proof, functionality-only, respects the seams/rules, AND no fatal/major objection stands unaddressed. ${KNOWN}\nOutput pass, reasoning, and guidance_for_next_round (concrete fixes the planner must make next round; empty if pass).`, { schema: JUDGE_SCHEMA, phase:'Tournament', label:`judge:${part.key}#${r}` })
    last = { key: part.key, title: part.title, plan, judge, round: r, passed: !!(judge && judge.pass) }
    if (last.passed) break
    guidance = (judge && judge.guidance_for_next_round) || guidance
  }
  return last
}))).filter(Boolean)
log(`tournament done: ${survivors.filter(s=>s.passed).length}/${survivors.length} parts PASSED; carrying ${survivors.length} fittest plans`)

// ---------- Committee report (coherence) ----------
phase('Committee report')
const fittestBlock = survivors.map(s => `## ${s.title} [${s.passed ? 'PASSED' : 'best-after-' + MAX_TOURNEY_ROUNDS + '-rounds'}] (round ${s.round})\nPLAN: ${JSON.stringify(s.plan)}\nJUDGE: ${s.judge ? s.judge.reasoning : ''}`).join('\n\n')
const report = await agent(`You are the COMMITTEE. Here are the fittest per-part plans for the island functional refactor:\n\n${fittestBlock}\n\nReview how they FIT TOGETHER — they all touch island-bridge.mjs + index.ts + main.swift, so resolve conflicts, dedupe overlaps, set a build ORDER, and ensure new-tab-spawn + isolation + wiring + replies + reconnect + keyboard-focus form ONE coherent functional design. ${KNOWN}\n${SEAMS}\n${CONTRACT}\n${RULES}\nDraft the unified BUILD REPORT: unified_spec (complete change set, file by file), build_order, cross_part_conflicts_resolved, files_touched, acceptance_tests (what the extended scripts/test-island-bridge.mjs + swiftc + tsc must prove — especially: a NEW island tab Send spawns a NEW agent; the bridge never lists/tails non-island ids incl '0'; index.ts re-wired additively).`, { schema: REPORT_SCHEMA, phase:'Committee report', label:'committee:report' })
log(`committee report drafted: ${(report && report.files_touched || []).join(', ')}`)

// ---------- Build (builder <-> committee loop) ----------
phase('Build')
const verifyCmd = `Verify the island refactor from ${ROOT} (report each honestly):
1) bash native/island-helper/build.sh >/tmp/tr-swift.log 2>&1; echo "swift_exit=$?"; tail -2 /tmp/tr-swift.log
2) npx tsc --noEmit -p tsconfig.json > /tmp/tr-tsc.log 2>&1; grep -E "island-bridge|control-server\\.ts|main/index\\.ts" /tmp/tr-tsc.log && echo "TSC_ERR_IN_MY_FILES" || echo "tsc_my_files_CLEAN" (IGNORE renderer/launcher.ts/osActions.ts = user WIP)
3) node scripts/test-island-bridge.mjs > /tmp/tr-ws.log 2>&1; echo "ws_exit=$?"; tail -25 /tmp/tr-ws.log
Set ok=true ONLY if swift_exit=0 AND step 2 = tsc_my_files_CLEAN AND ws_exit=0 (ALL PASS). Put per-check results + real errors in detail.`
let review = '(first build)'
let build = null
let committee = null
let approved = false
let br = 0
for (br = 1; br <= MAX_BUILD_ROUNDS && !approved; br++) {
  await agent(`You are the BUILDER (round ${br}). Implement the island refactor per the committee report:\n${JSON.stringify(report)}\n${br > 1 ? 'COMMITTEE FEEDBACK from the last build (fix these):\n' + review + '\n' : ''}Edit ONLY: ${ROOT}/src/main/island-bridge.mjs + island-bridge.d.mts, ${ROOT}/src/main/index.ts (ADDITIVE — restore setIslandDeps + launchIslandHelper, scoped to island ids), ${ROOT}/native/island-helper/main.swift (+ build.sh only if a framework link is needed), and EXTEND ${ROOT}/scripts/test-island-bridge.mjs for the acceptance tests. NEVER edit osActions.ts/electron-os-tools.ts/launcher.ts/src/renderer. Keep island-bridge.mjs pure-node. ${SEAMS}\n${CONTRACT}\n${RULES} Return files changed.`, { schema: AUTHORED_SCHEMA, phase:'Build', label:`builder#${br}` })
  build = await agent(verifyCmd, { schema: BUILD_SCHEMA, phase:'Build', label:`verify#${br}` })
  committee = await agent(`You are the COMMITTEE reviewing the BUILD against the report. VERIFY RESULT: ${JSON.stringify(build)}\nRead the actual changed files (${ROOT}/src/main/island-bridge.mjs, index.ts, native/island-helper/main.swift, scripts/test-island-bridge.mjs). Does the build faithfully implement the report's unified_spec, FIX ALL 3 BUGS (new-tab-spawn, isolation/no-leak incl. never tailing '0', index.ts re-wire), pass the acceptance_tests, respect the rules (functionality only, no hot-file edits, pure-node bridge), and is it future-proof? ${KNOWN}\nApprove ONLY if the build is correct AND the verify ok is true. Output approved, feedback (concrete required fixes if not), blocking[].`, { schema: COMMITTEE_SCHEMA, phase:'Build', label:`committee#${br}` })
  approved = !!(committee && committee.approved && build && build.ok)
  review = committee ? (committee.feedback + ' BLOCKING: ' + ((committee.blocking||[]).join('; '))) : review
}
log(`build loop: ${approved ? 'APPROVED' : 'NOT approved'} after ${br - 1} round(s)`)

return {
  approved,
  build_ok: !!(build && build.ok),
  build_detail: (build && build.detail) || 'unknown',
  build_rounds: br - 1,
  parts_passed: survivors.filter(s=>s.passed).map(s=>s.title),
  parts_maxed: survivors.filter(s=>!s.passed).map(s=>s.title),
  committee_feedback: committee ? committee.feedback : '',
}