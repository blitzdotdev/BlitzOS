export const meta = {
  name: 'island-port',
  description: 'Port the notch-spill PoC into BlitzOS as a dedicated island window (entry + spawn + opt-space + fill-to-real-canvas)',
  phases: [
    { title: 'Research', detail: 'launcher pattern + PoC port + sandwich/fullscreen/electronOps integration' },
    { title: 'Author', detail: 'island.ts + additive index.ts/preload + test' },
    { title: 'Build', detail: 'tsc(my files) + main/preload bundle + source-assert test' },
    { title: 'Review', detail: 'window-config / UX / spawn / fill-handoff / isolation' },
    { title: 'Fix', detail: 'apply findings, re-verify' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'
const POC = '/Users/minjunes/superapp/notch-spill-poc'

const FACTS = `GROUND TRUTH (scouted by the lead):
- PATTERN: mirror ${ROOT}/src/main/launcher.ts (a self-contained Electron window with INLINE HTML data: URL + a preload bridge agentOS.launcher + wire/register fns called from index.ts). The island is a NEW such window. CREATE src/main/island.ts. DO NOT edit launcher.ts (the user is actively editing it).
- WINDOW CONFIG (PoC-proven, from ${POC}/main.js, replicate EXACTLY, it covers the notch): frame:false, transparent:true, hasShadow:false, resizable:false, skipTaskbar:true, enableLargerThanScreen:true, backgroundColor "#00000000", sized to screen.getPrimaryDisplay().bounds; then setAlwaysOnTop(true,"screen-saver"); setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}); setBounds(display.bounds) covers the menu bar, re-assert after show; setIgnoreMouseEvents(true,{forward:true}) toggled by the renderer (click-through everywhere except the notch, or when filled); showInactive (never steal focus).
- UI: port ${POC}/index.html + styles.css + renderer.js (the notch pill NotchShape clip-path, the closed-to-fullscreen clip-path GROW with ease-out, the live-tuning keys, the click-through region logic). The grow/fill background MUST be #e9e9e7 (the BlitzOS canvas color / sandwich UI_BG) so the handoff to the real canvas is seamless.
- ADD the Blitz ENTRY in the hover-panel: a multiline prompt/chat bar + a "Deep" on/off toggle + a Send. (Deep = the orchestrators/workflow capability.)
- SPAWN (in-process, mirror the launcher start-workflow IPC to electronOps): a preload agentOS.island bridge to ipcMain to electronOps. Deep ON calls electronOps.startWorkflow({task:prompt, contextRefs:[], title}); Deep OFF does a=electronOps.spawnAgent(title) then electronOps.userMessage(prompt, a.id). These seams are verified in electron-os-tools.ts. CALL them; do NOT edit electron-os-tools.ts / osActions.ts.
- FILL handoff: on click-fill, the island grows to fullscreen (bg #e9e9e7) AND a bridge IPC reaches an index.ts handler that calls sandwich.setFullScreen(true) + brings mainWindow to front (the REAL BlitzOS canvas fills the screen). Then the island goes click-through (passthrough) revealing the real canvas behind, leaving the notch pill as the collapse handle on top. On suck: sandwich.setFullScreen(false) + island returns. The sandwich ref and mainWindow are module-level in index.ts (sandwich exposes setFullScreen(on)). Call them from the ADDITIVE index.ts IPC handler. DO NOT edit sandwich.ts.
- OPT-SPACE: register a globalShortcut("Alt+Space") in index.ts (additive) that toggles the island window. The island is all-Spaces, so it serves both "anywhere over macOS" and "in BlitzOS".`

const CONSTRAINTS = `HARD CONSTRAINTS:
- EDIT ONLY: NEW ${ROOT}/src/main/island.ts ; ADDITIVE ${ROOT}/src/main/index.ts (import + register the island + the opt-space globalShortcut + the fill IPC to sandwich.setFullScreen + mainWindow front) ; ADDITIVE ${ROOT}/src/preload/index.ts (an agentOS.island bridge section) ; NEW ${ROOT}/scripts/test-island-window.mjs.
- DO NOT touch: src/renderer/* (the user active WIP), osActions.ts, electron-os-tools.ts, launcher.ts, sandwich.ts (hot/core files, CALL their exports, never edit). The native BlitzIsland.app + island-bridge.mjs (WS) stay LEGACY, untouched.
- island.ts is self-contained inline HTML (no renderer import, no new vite entry). NO new npm deps.
- Do NOT run the Electron GUI. Do NOT gate on the full renderer build (the user renderer is mid-refactor and may fail, not your concern).`

const SPEC_SCHEMA = { type:'object', required:['area','spec'], properties:{ area:{type:'string'}, spec:{type:'string'}, pitfalls:{type:'array', items:{type:'string'}} } }
const AUTHORED_SCHEMA = { type:'object', required:['files','summary'], properties:{ files:{type:'array', items:{type:'string'}}, summary:{type:'string'} } }
const BUILD_SCHEMA = { type:'object', required:['ok','detail'], properties:{ ok:{type:'boolean', description:'true ONLY if tsc has NO errors in island.ts / src/main/index.ts / src/preload/index.ts (ignore src/renderer); AND npm run build emitted out/main/index.js + out/preload/index.js (renderer step may fail = user WIP, ignore); AND node scripts/test-island-window.mjs prints ALL PASS (exit 0).'}, detail:{type:'string'} } }
const REVIEW_SCHEMA = { type:'object', required:['findings'], properties:{ findings:{ type:'array', items:{ type:'object', required:['severity','title','detail','fix'], properties:{ severity:{type:'string', enum:['blocker','major','minor']}, title:{type:'string'}, detail:{type:'string'}, file:{type:'string'}, fix:{type:'string'} } } } } }

phase('Research')
const research = (await parallel([
  () => agent(`Produce the LAUNCHER-PATTERN spec to mirror. Read ${ROOT}/src/main/launcher.ts FULLY (the self-contained window, the inline-HTML data URL, wireLauncher/registerLauncher DI + the ipcMain handlers, the preload agentOS.launcher bridge, show/autosize) and how index.ts wires it. Output exactly how to structure src/main/island.ts (wireIsland/registerIsland + the inline-HTML window + ipc handlers) and the additive index.ts + the preload agentOS.island bridge, same conventions. ${FACTS}`, { label:'research:pattern', phase:'Research', schema: SPEC_SCHEMA }),
  () => agent(`Produce the POC-PORT spec. Read ${POC}/main.js, ${POC}/index.html, ${POC}/styles.css, ${POC}/renderer.js FULLY (the proven window config, the notch NotchShape clip-path, the closed-to-fullscreen clip-path GROW, the click-through region logic, the live-tune keys). Output exactly what to port into src/main/island.ts inline HTML/CSS/JS, the changes (bg #e9e9e7 for the grow; add the Blitz entry = chat bar + Deep toggle + Send in the hover-panel; emit spawn + fill over the preload bridge instead of the PoC standalone logic), keeping the proven window config. ${FACTS}`, { label:'research:poc', phase:'Research', schema: SPEC_SCHEMA }),
  () => agent(`Produce the INTEGRATION spec. Read ${ROOT}/src/main/index.ts (the mainWindow + sandwich refs, how launcher is wired, where to add a globalShortcut + the fill IPC), ${ROOT}/src/main/sandwich.ts (the setFullScreen(on) export), ${ROOT}/src/main/electron-os-tools.ts (electronOps.startWorkflow / spawnAgent / userMessage). Output the exact additive index.ts wiring (register island, the opt-space globalShortcut to toggle, the spawn IPC to electronOps Deep on/off, the fill IPC to sandwich.setFullScreen(true)+mainWindow front, suck to setFullScreen(false)) + the preload agentOS.island bridge shape + confirm #e9e9e7 is the canvas color. ${FACTS} ${CONSTRAINTS}`, { label:'research:integration', phase:'Research', schema: SPEC_SCHEMA }),
])).filter(Boolean)
log(`research: ${research.length}/3`)
const specBlock = research.map(s => `### ${s.area}\n${s.spec}\nPITFALLS: ${(s.pitfalls||[]).join('; ')}`).join('\n\n')

phase('Author')
const authored = await agent(`Implement the island port per these specs:\n\n${specBlock}\n\n${FACTS}\n${CONSTRAINTS}\n\nWrite: src/main/island.ts (the self-contained overlay window + inline HTML UI: notch pill, native-look hover-panel with the Blitz entry [chat bar + Deep on/off toggle + Send], the closed-to-fullscreen clip-path grow with bg #e9e9e7, the click-through region logic, opt-space-toggle support), additive src/main/index.ts (import + register the island; the opt-space globalShortcut toggling it; the spawn IPC to electronOps Deep on/off; the fill IPC to sandwich.setFullScreen + mainWindow front, suck to setFullScreen(false)), additive src/preload/index.ts (agentOS.island bridge), and scripts/test-island-window.mjs (source-assert test, ok()/ALL PASS style like test-launcher.mjs). Add a .d.mts sibling if island.ts exports need it for typecheck. Return files written.`, { label:'author', phase:'Author', schema: AUTHORED_SCHEMA })
log(`authored: ${(authored && authored.files || []).join(', ')}`)

phase('Build')
const buildCmd = `Verify honestly from ${ROOT}:
1) npx tsc --noEmit -p tsconfig.json > /tmp/ip-tsc.log 2>&1; grep -E "src/main/island|src/main/index\\.ts|src/preload/index\\.ts" /tmp/ip-tsc.log && echo "TSC_ERR_MY_FILES" || echo "tsc_my_files_CLEAN"   (IGNORE src/renderer errors = user WIP)
2) npm run build > /tmp/ip-build.log 2>&1; (test -f out/main/index.js && test -f out/preload/index.js && echo "MAIN_PRELOAD_EMIT") || echo "MAIN_PRELOAD_MISSING"; grep -iE "island" /tmp/ip-build.log | grep -iE "error|could not resolve" | head -5 || echo "no island build errors"
3) node scripts/test-island-window.mjs > /tmp/ip-test.log 2>&1; echo "test_exit=$?"; tail -20 /tmp/ip-test.log
ok=true ONLY if step1 printed tsc_my_files_CLEAN AND step2 printed MAIN_PRELOAD_EMIT with no island errors AND step3 is exit 0 (ALL PASS). Put each result + real errors in detail. Do not edit files.`
let build = await agent(buildCmd, { label:'build:1', phase:'Build', schema: BUILD_SCHEMA })
let tries = 1
while (build && !build.ok && tries < 5) {
  await agent(`Verification FAILED:\n\n${build.detail}\n\nFix the REAL cause in island.ts / additive index.ts / additive preload / test-island-window.mjs ONLY. ${CONSTRAINTS}\n${FACTS} Return files changed.`, { label:`buildfix:${tries}`, phase:'Build', schema: AUTHORED_SCHEMA })
  build = await agent(buildCmd, { label:`build:${tries+1}`, phase:'Build', schema: BUILD_SCHEMA })
  tries++
}
log(`build after ${tries}: ok=${build && build.ok}`)

phase('Review')
const LENSES = [
  { key:'window', prompt:'Does src/main/island.ts replicate the PoC-proven window config EXACTLY (transparent, frame false, enableLargerThanScreen, alwaysOnTop screen-saver, visibleOnAllWorkspaces visibleOnFullScreen, setBounds(display.bounds) re-asserted after show, setIgnoreMouseEvents(true,{forward:true}) toggled, showInactive)? Any deviation that would stop it covering the notch is a blocker.' },
  { key:'ux', prompt:'The UI: notch pill (NotchShape clip-path), the closed-to-fullscreen clip-path GROW (ease-out, bg #e9e9e7 for the seamless canvas handoff), the hover-panel with the Blitz entry (chat bar + Deep on/off toggle + Send), and the click-through region logic (collapsed = notch only, filled = passthrough to the canvas).' },
  { key:'spawn', prompt:'Spawn is in-process via the preload agentOS.island bridge to ipcMain to electronOps: Deep ON to startWorkflow({task,contextRefs,title}); Deep OFF to spawnAgent(title)+userMessage(prompt,id). No WebSocket. electron-os-tools.ts/osActions.ts NOT edited (only called).' },
  { key:'fill', prompt:'The fill handoff: click-fill grows the island (bg #e9e9e7) AND the fill IPC in index.ts calls sandwich.setFullScreen(true) + brings mainWindow front (the REAL canvas); island goes passthrough leaving the notch handle; suck calls setFullScreen(false). sandwich.ts NOT edited. The opt-space globalShortcut toggles the island.' },
  { key:'isolation', prompt:'CONSTRAINTS honored: only island.ts (new) + ADDITIVE index.ts + ADDITIVE preload + the new test changed. src/renderer/*, osActions.ts, electron-os-tools.ts, launcher.ts, sandwich.ts, island-bridge.mjs, native/* are UNTOUCHED. island.ts has no renderer import + no new npm deps.' },
]
let findings = []
if (build && build.ok) {
  const reviews = (await parallel(LENSES.map(L => () =>
    agent(`Adversarial review of the island port (${ROOT}/src/main/island.ts + the additive index.ts/preload + scripts/test-island-window.mjs). ${L.prompt} Concrete findings only; default to none if correct.`,
      { label:`review:${L.key}`, phase:'Review', schema: REVIEW_SCHEMA })
  ))).filter(Boolean)
  findings = reviews.flatMap(r => r.findings||[]).filter(f => f.severity==='blocker' || f.severity==='major')
}
log(`review: ${findings.length} blocker/major`)

phase('Fix')
let note = 'no blocker/major findings'
if (findings.length) {
  const list = findings.map((f,i)=>`${i+1}. [${f.severity}] ${f.title} (${f.file||''}): ${f.detail}\n   FIX: ${f.fix}`).join('\n')
  await agent(`Apply these confirmed findings (respect the CONSTRAINTS, never edit renderer/osActions/electron-os-tools/launcher/sandwich), keep it passing verification:\n\n${list}\n\n${FACTS}\n${CONSTRAINTS} Return files changed.`, { label:'fix', phase:'Fix', schema: AUTHORED_SCHEMA })
  build = await agent(buildCmd, { label:'build:final', phase:'Fix', schema: BUILD_SCHEMA })
  note = `applied ${findings.length} findings; re-verify ok=${build && build.ok}`
}

return {
  ok: !!(build && build.ok),
  detail: (build && build.detail) || 'unknown',
  build_attempts: tries,
  findings_applied: findings.length,
  files: (authored && authored.files) || [],
  note,
}