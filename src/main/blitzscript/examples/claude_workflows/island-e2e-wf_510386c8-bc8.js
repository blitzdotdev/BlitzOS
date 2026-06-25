export const meta = {
  name: 'island-e2e',
  description: 'Build + verify the island end-to-end: bridge A+B (DI, spawn/message/toggle, reply tail) + UI C+D (SwiftUI tabs/chat/list + keyboard focus)',
  phases: [
    { title: 'Research', detail: 'keyboard-focus RE + bridge DI spec + SwiftUI UI spec' },
    { title: 'Author', detail: 'bridge (mjs/index/test) + island (main.swift) in parallel' },
    { title: 'Build', detail: 'swiftc + tsc(my files) + ws round-trip loop' },
    { title: 'Review', detail: 'protocol / bridge / swift-ui / keyboard-focus' },
    { title: 'Fix', detail: 'apply findings, re-verify' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'
const REF = '/Users/minjunes/superapp/teenybase/.repos/boring.notch'

const SEAMS = `VERIFIED electronOps/osActions seams (job-model is GONE; build against THESE, confirmed in src/main/electron-os-tools.ts + osActions.ts):
- Spawn OFF (DEFAULT for a conversational chat tab): electronOps.spawnAgent(title) -> {id,title}; then electronOps.userMessage(prompt, id) to seed.
- Spawn ON (heavy task only): electronOps.startWorkflow({task, contextRefs, title}) -> {ok, agent:{id,title}} (orchestrators capability ON).
- Message (continue a tab): electronOps.userMessage(text, id)  [NOT emitUserMessage — userMessage writes the agent's chat.md AND wakes it; emitUserMessage skips the chat.md write].
- Toggle flip on an existing tab: electronOps.setOrchestrators(id, on)  (live, no restart).
- Per-agent state + the new->working auto-name: osGetState().agentStatus (= wsHost.chatStatusSnapshot(), an {id->status} map) + agent titles (from the agents/terminals in osGetState / terminal list).
- Concise "you are in the BlitzOS island, answer concisely / short status lines" preamble: prepend it ONCE to the SPAWN seed prompt, NOT on every message (context bloat).
- DO NOT edit osActions.ts / electron-os-tools.ts / launcher.ts — the user is actively editing them this session. Only CALL the exported seams.`

const CONTRACT = `WS frame contract (island <-> bridge; JSON text frames; BOTH sides must match exactly):
island -> bridge:
  {t:'hello', token, pid, bundleId}
  {t:'process.spawn', prompt, paths:[], orchestrators:<bool>}   // chat-bar Send (orchestrators = the tab toggle, default false)
  {t:'process.message', id, text, paths:[]}                      // continue an existing tab
  {t:'process.orchestrators', id, on:<bool>}                     // flip the toggle on an existing tab
  {t:'pong'}
bridge -> island:
  {t:'process.list', processes:[{id,title,state}]}               // FULL snapshot on connect + on any change
  {t:'process.upsert', id, title?, state?}                       // incremental (status change / auto-name)
  {t:'process.event', id, line:{at:<ms-number>, text:<string>}}  // one reply/activity line to append (island truncates to 1 line + click-expand)
  {t:'ping'}
state in {new|working|waiting|idle|stopped|error}.`

const ARCH = `Bridge must stay PURE-NODE + DEPENDENCY-INJECTED so A+B are testable headlessly (no electron import in island-bridge.mjs):
- island-bridge.mjs: add module-level deps via setIslandDeps(deps); attachIslandWebSocket(server, token) uses the current deps. deps = {
    spawn({prompt, paths, orchestrators}) -> {id, title},
    message({id, text, paths}),
    setOrchestrators(id, on),
    listProcesses() -> [{id, title, state}],
    subscribeEvents(cb) -> unsubscribe,   // cb({id, line:{at,text}}) for agent reply lines; status changes -> the bridge emits process.upsert/list
  }. onIslandConnection: on connect send process.list (deps.listProcesses) then a ping; on inbound process.spawn/message/orchestrators call the matching dep; forward subscribeEvents callbacks out as process.event/upsert. Keep token gating + handshake.
- index.ts (ADDITIVE only — do not disturb the wireLauncher/start_workflow area): build realDeps from electronOps + osGetState + a chat.md TAIL, call setIslandDeps(realDeps) BEFORE startControlServer(), keep launchIslandHelper as is.
    spawn: if orchestrators -> electronOps.startWorkflow({task: preambleOncePrompt, contextRefs: paths, title}); else { const a = electronOps.spawnAgent(title); electronOps.userMessage(preambleOncePrompt + pathsFooter(paths), a.id); return a }.
    message: ({id,text,paths}) => electronOps.userMessage(text + pathsFooter(paths), id).
    setOrchestrators: electronOps.setOrchestrators.
    listProcesses: derive from osGetState().agentStatus (+ titles) -> [{id,title,state}].
    subscribeEvents (REPLIES): TAIL each active agent's chat.md (<workspace>/.blitzos/terminals/<id>/chat.md) — track a per-file byte offset, fs.watch or poll, parse only NEWLY-appended AGENT turns, emit cb({id, line:{at: a current-ms timestamp passed IN from index (the runtime stamps it; do NOT compute time inside island-bridge.mjs's pure logic if you can avoid it), text}}). PURE NODE. Read how appendChatMessage writes chat.md (osActions.ts / workspace-host.mjs) to parse agent-vs-user turns. Also poll osGetState().agentStatus to emit status/auto-name upserts. (A say-tap in osActions is the cleaner long-term path but osActions is being actively edited, so v1 TAILS chat.md instead — do NOT edit osActions.ts.)
- control-server.ts already calls attachIslandWebSocket(server, token); leave it.
- scripts/test-island-bridge.mjs: EXTEND it — call setIslandDeps(stubDeps), attach, connect a ws client, and assert: process.spawn{orchestrators:true} -> stub.spawn called with orchestrators true; {false} -> false; process.message -> stub.message; process.orchestrators -> stub.setOrchestrators; connect -> process.list from stub.listProcesses; a stub event via subscribeEvents -> a process.event frame reaches the client. Keep the existing token/handshake/ping asserts.`

const ISLAND_UI = `Extend ${ROOT}/native/island-helper/main.swift (KEEP the working shell: the fixed-window NotchShape, open/close springs, hover, optionspace toggle, the WS client, launch). REPLACE IslandContentPlaceholder + route frames into a model:
- IslandModel additions (ObservableObject): processes:[Proc{id,title,state}], currentTabId:String?, messagesByTab:[String:[Line{at,text}]], draftByTab, orchestratorsByTab:Bool (default false), attachedPathsByTab. Fed by incoming frames.
- WS client handleText: ROUTE process.list/upsert/event into the model (today it only NSLogs). Send process.spawn/message/orchestrators OUT on user actions (encode JSON, ws send).
- SwiftUI inside the OPEN island (closed stays the bare notch):
  - Tab strip: one chip per process + a '+' new-tab; click a chip to switch; a horizontal drag (swipe) switches prev/next. Tab label = process.title (auto-renames new->working via process.upsert); a small state dot.
  - Per current tab: if state=='new' (or a fresh '+' tab) -> a CHAT BAR: a multiline text field + a workflow on/off toggle (default OFF) + a Send button -> emit process.spawn{prompt, paths, orchestrators}. If working -> a concise MESSAGE LIST: rows from messagesByTab truncated to ONE line, tap a row to expand to full text; plus the same input at the bottom to continue (-> process.message{id,text}). Flipping the toggle on an existing working tab -> process.orchestrators{id,on}.
  - Drag files onto the island -> add to the current tab's attachedPaths (keep the existing drag visuals); they ride the next spawn/message as paths, shown as small chips.
- KEYBOARD FOCUS (the hard part): the panel is canBecomeKey=false so the text field can't receive keys. Implement the approach the Research phase RE'd from the reference: let the chat field take key input while editing, then relinquish, WITHOUT breaking the always-on non-activating behavior (e.g. make canBecomeKey return true only while an editing flag is set + makeKey/activate when the field opens, resign on send/close). Must not regress: the island still shows over other apps and the optionspace toggle still works.
- Keep it SwiftUI-faithful + clean; no new deps; single-file swiftc build (build.sh already links SwiftUI).`

const CLEANROOM = `CLEAN ROOM: the reference at ${REF} (GPL-3.0) is for STUDYING the TECHNIQUE only (how a notch panel takes text input). Reimplement independently; do NOT copy its source into BlitzOS.`

const SPEC_SCHEMA = { type:'object', required:['area','spec'], properties:{ area:{type:'string'}, spec:{type:'string'}, pitfalls:{type:'array', items:{type:'string'}} } }
const AUTHORED_SCHEMA = { type:'object', required:['files','summary'], properties:{ files:{type:'array', items:{type:'string'}}, summary:{type:'string'} } }
const BUILD_SCHEMA = { type:'object', required:['ok','detail'], properties:{ ok:{type:'boolean', description:'true ONLY if swiftc exits 0 AND tsc has NO errors in island-bridge*/control-server.ts/main index.ts AND scripts/test-island-bridge.mjs prints ALL PASS (exit 0). IGNORE renderer + launcher.ts + osActions.ts errors (user WIP).'}, detail:{type:'string'} } }
const REVIEW_SCHEMA = { type:'object', required:['findings'], properties:{ findings:{ type:'array', items:{ type:'object', required:['severity','title','detail','fix'], properties:{ severity:{type:'string', enum:['blocker','major','minor']}, title:{type:'string'}, detail:{type:'string'}, file:{type:'string'}, fix:{type:'string'} } } } } }

phase('Research')
const research = (await parallel([
  () => agent(`RE the KEYBOARD-FOCUS technique for typing into a non-activating notch panel. ${CLEANROOM} Study the reference at ${REF}: grep its Swift for canBecomeKey overrides, NSApp.activate, makeKey/makeKeyAndOrderFront, becomeFirstResponder, .focused/.focusable, and its search/notes/TextField input components. Output the EXACT clean reimplementation approach for BlitzIsland: how to let the chat TextField receive keystrokes while editing and relinquish after, WITHOUT breaking canBecomeKey=false always-on/non-activating behavior or the optionspace toggle. Be concrete (which property to toggle, when to makeKey/resign).`, { label:'research:focus', phase:'Research', schema: SPEC_SCHEMA }),
  () => agent(`Produce the BRIDGE implementation SPEC (A+B). Read ${ROOT}/src/main/island-bridge.mjs (current stub), ${ROOT}/src/main/control-server.ts, ${ROOT}/src/main/index.ts (where launchIslandHelper + startControlServer wire; and electronOps), ${ROOT}/src/main/electron-os-tools.ts (the seams), and how chat.md is written (appendChatMessage in osActions.ts / workspace-host.mjs) so the chat.md TAIL parses agent turns correctly. ${SEAMS}\n${CONTRACT}\n${ARCH} Output the concrete island-bridge.mjs deps shape + the index.ts realDeps wiring (additive) + the chat.md tail parsing + the extended test plan.`, { label:'research:bridge', phase:'Research', schema: SPEC_SCHEMA }),
  () => agent(`Produce the SwiftUI UI implementation SPEC (C). Read ${ROOT}/native/island-helper/main.swift fully (the shell to extend + the WS client to route). ${CONTRACT}\n${ISLAND_UI} Output the concrete model fields, the frame->model routing, the tab strip + per-tab state machine + message list + chat bar + drag-attach view code shape, and how it sends process.spawn/message/orchestrators. Defer the keyboard-focus mechanism to the focus-research spec but say where it plugs in.`, { label:'research:ui', phase:'Research', schema: SPEC_SCHEMA }),
])).filter(Boolean)
log(`research: ${research.length}/3 specs`)
const specBlock = research.map(s => `### ${s.area}\n${s.spec}\nPITFALLS: ${(s.pitfalls||[]).join('; ')}`).join('\n\n')

phase('Author')
const authored = (await parallel([
  () => agent(`Implement the BRIDGE side (A+B) per these specs:\n\n${specBlock}\n\n${SEAMS}\n${CONTRACT}\n${ARCH}\nEdit ONLY: ${ROOT}/src/main/island-bridge.mjs, ${ROOT}/src/main/island-bridge.d.mts, ${ROOT}/src/main/index.ts (ADDITIVE — do not disturb the wireLauncher/start_workflow lines), and ${ROOT}/scripts/test-island-bridge.mjs. Do NOT edit osActions.ts / electron-os-tools.ts / launcher.ts / src/renderer. Keep island-bridge.mjs pure-node (no electron import). Return files written.`, { label:'author:bridge', phase:'Author', schema: AUTHORED_SCHEMA }),
  () => agent(`Implement the ISLAND UI side (C+D) per these specs:\n\n${specBlock}\n\n${CONTRACT}\n${ISLAND_UI}\n${CLEANROOM}\nEdit ONLY ${ROOT}/native/island-helper/main.swift (and ${ROOT}/native/island-helper/build.sh ONLY if a new framework link is required). Keep the working shell intact; replace the placeholder; route WS frames into the model; implement the keyboard-focus approach from the focus spec. Do not run the GUI. Return files written.`, { label:'author:island', phase:'Author', schema: AUTHORED_SCHEMA }),
])).filter(Boolean)
log(`authored: ${authored.flatMap(a => a.files||[]).join(', ')}`)

phase('Build')
const buildCmd = `Verify honestly from ${ROOT}:
1) bash native/island-helper/build.sh >/tmp/e2e-swift.log 2>&1; echo "swift_exit=$?" ; tail -3 /tmp/e2e-swift.log
2) npx tsc --noEmit -p tsconfig.json > /tmp/e2e-tsc.log 2>&1; grep -E "island-bridge|control-server\\.ts|main/index\\.ts" /tmp/e2e-tsc.log && echo "TSC_ERR_IN_MY_FILES" || echo "tsc_my_files_CLEAN"   (IGNORE renderer/launcher.ts/osActions.ts errors = user WIP)
3) node scripts/test-island-bridge.mjs > /tmp/e2e-ws.log 2>&1; echo "ws_exit=$?"; tail -20 /tmp/e2e-ws.log
Set ok=true ONLY if swift_exit=0 AND step 2 printed tsc_my_files_CLEAN AND ws_exit=0 (ALL PASS). Put each result + real error text in detail. Do not edit files.`
let build = await agent(buildCmd, { label:'build:1', phase:'Build', schema: BUILD_SCHEMA })
let tries = 1
while (build && !build.ok && tries < 5) {
  await agent(`Verification FAILED:\n\n${build.detail}\n\nFix the REAL cause. Bridge issues -> island-bridge.mjs/.d.mts/index.ts(additive)/test-island-bridge.mjs. Island issues -> native/island-helper/main.swift (+ build.sh if a framework link is missing). NEVER edit osActions.ts/electron-os-tools.ts/launcher.ts/src/renderer. Keep the contract + pure-node bridge intact. ${CONTRACT} Return files changed.`, { label:`buildfix:${tries}`, phase:'Build', schema: AUTHORED_SCHEMA })
  build = await agent(buildCmd, { label:`build:${tries+1}`, phase:'Build', schema: BUILD_SCHEMA })
  tries++
}
log(`build after ${tries} attempt(s): ok=${build && build.ok}`)

phase('Review')
const LENSES = [
  { key:'protocol', prompt:`Do the bridge (island-bridge.mjs) and the island (native/island-helper/main.swift) speak the EXACT SAME frames per the contract: island sends process.spawn/message/orchestrators with the right keys; bridge sends process.list/upsert/event with the right shapes; island routes them into its model (not just logs)? Any key/shape mismatch is a blocker.\n${CONTRACT}` },
  { key:'bridge', prompt:`Bridge correctness: spawn ON->startWorkflow, OFF->spawnAgent+userMessage; message->userMessage (NOT emitUserMessage); toggle->setOrchestrators; concise preamble seeded ONCE at spawn not per message; chat.md tail parses only NEW agent turns (per-file offset, no re-emit, handles missing file); island-bridge.mjs stays pure-node (no electron import); index.ts edits are additive (wireLauncher untouched); osActions.ts NOT edited.\n${SEAMS}` },
  { key:'swift-ui', prompt:`SwiftUI correctness: the working shell (fixed window, NotchShape, springs, hover, optionspace) is intact; frames route into the model and the tabs/message-list/chat-bar render; sends are well-formed; no force-unwrap crashes; UI on main thread; drag-attach works. The closed island is still the bare notch.` },
  { key:'focus', prompt:`The KEYBOARD-FOCUS solution: can the chat TextField actually receive keystrokes (the panel was canBecomeKey=false)? Verify the editing-flag/makeKey/resign approach is sound and does NOT break: (a) always-on visibility over other apps, (b) the non-activating behavior when NOT editing, (c) the optionspace toggle. This is the riskiest piece — be specific about whether it will actually let the user type.` },
]
let findings = []
if (build && build.ok) {
  const reviews = (await parallel(LENSES.map(L => () =>
    agent(`Adversarial review of the island end-to-end build (${ROOT}/src/main/island-bridge.mjs + index.ts + scripts/test-island-bridge.mjs + ${ROOT}/native/island-helper/main.swift). ${L.prompt} Concrete findings only; default to none if correct.`,
      { label:`review:${L.key}`, phase:'Review', schema: REVIEW_SCHEMA })
  ))).filter(Boolean)
  findings = reviews.flatMap(r => r.findings||[]).filter(f => f.severity==='blocker' || f.severity==='major')
}
log(`review: ${findings.length} blocker/major findings`)

phase('Fix')
let note = 'no blocker/major findings'
if (findings.length) {
  const list = findings.map((f,i)=>`${i+1}. [${f.severity}] ${f.title} (${f.file||''}): ${f.detail}\n   FIX: ${f.fix}`).join('\n')
  await agent(`Apply these confirmed findings (never edit osActions.ts/electron-os-tools.ts/launcher.ts/src/renderer), keep it passing verification:\n\n${list}\n\n${CONTRACT} Return files changed.`, { label:'fix', phase:'Fix', schema: AUTHORED_SCHEMA })
  build = await agent(buildCmd, { label:'build:final', phase:'Fix', schema: BUILD_SCHEMA })
  note = `applied ${findings.length} findings; re-verify ok=${build && build.ok}`
}

return {
  ok: !!(build && build.ok),
  detail: (build && build.detail) || 'unknown',
  build_attempts: tries,
  findings_applied: findings.length,
  files: authored.flatMap(a => a.files||[]),
  note,
}