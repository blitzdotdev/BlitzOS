export const meta = {
  name: 'island-p0b-p0d',
  description: 'Build + verify P0b (/island WS route + bridge + launch/supervise) and P0d (round-trip)',
  phases: [
    { title: 'Research', detail: 'control-server mount + supervise pattern + exact island WS protocol' },
    { title: 'Author', detail: 'island-bridge.mjs + .d.mts, wire control-server + index, write the test' },
    { title: 'Build', detail: 'swiftc + tsc(my files) + node round-trip test loop' },
    { title: 'Review', detail: 'adversarial: protocol / ws-server / launch-supervise / wiring' },
    { title: 'Fix', detail: 'apply confirmed findings, re-verify' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'

const FACTS = `GROUND TRUTH (verified by the lead before this run):
- 'ws' (^8.18.0) IS installed (node_modules/ws). Use it for the server.
- control-server.ts: export function startControlServer() does:
    const token = randomBytes(24).toString('hex')
    const server = createServer((req,res)=>{ ... Authorization: Bearer <token> ... })
    server.listen(0,'127.0.0.1', () => { ... setLocal('http://127.0.0.1:'+port, token) ... })   // setLocal from ./sessionFile writes session.json local.{url,token}
  The 'server' + 'token' are in scope at the END of startControlServer — mount the WS there.
- The island (native/island-helper/main.swift) reads ~/.blitzos/session.json local.url + local.token, builds ws://<host>:<port>/island?token=<token>, and connects.`

const ISLAND_PROTOCOL = `EXACT island WS protocol (read native/island-helper/main.swift to confirm — the bridge MUST match it):
- Transport: message-framed JSON TEXT frames (one JSON object per WS text frame). NOT newline-delimited.
- On open the island sends ONE frame: {"t":"hello","token":<token>,"pid":<int>,"bundleId":"dev.blitz.os.island"}.
- The island's receive loop: {"t":"ping"} -> it replies {"t":"pong"}; {"t":"hello"} -> logs ack; {"t":"process.list"|"process.event"|...} -> logs (P1/P2 render).
- So the SERVER must: accept the upgrade ONLY for path /island; validate the ?token= query param strictly equals the control-server bearer token (else reject/destroy the socket); on a new connection send an initial {"t":"process.list","processes":[]} snapshot (P0b stub) AND send {"t":"ping"}; recognize the island's {"t":"pong"} (liveness) and its {"t":"hello"}.`

const ARCH = `ARCHITECTURE (keep the WS logic Electron-free + testable; match the repo's .mjs + .d.mts convention, e.g. os-tools.mjs/stage-core.mjs):
- NEW src/main/island-bridge.mjs (PLAIN NODE, only 'http'/'ws'/'url'/'child_process'; NO electron import) exporting:
    attachIslandWebSocket(server, token): mounts a WebSocketServer({noServer:true}) + server.on('upgrade', ...) that handles ONLY /island, validates the ?token= query param === token (else socket.write 401 + destroy), wss.handleUpgrade -> onIslandConnection(ws).
    onIslandConnection(ws): on 'message' JSON.parse the text; {t:'hello'} -> log; {t:'pong'} -> mark alive; on connect send {t:'process.list',processes:[]} then {t:'ping'}; clean close/error handling, no leaks.
    launchIslandHelper(appPath): child_process to launch BlitzIsland.app at appPath (use macOS 'open'); supervise = relaunch on exit with a debounce; AVOID duplicate instances (e.g. skip if 'pgrep -x BlitzIsland' already running). Takes the resolved path as an arg so this stays electron-free.
- NEW src/main/island-bridge.d.mts: hand-written declarations for the three exports (typecheck enforces .d.mts siblings).
- EDIT control-server.ts: import { attachIslandWebSocket } from './island-bridge.mjs'; call attachIslandWebSocket(server, token) inside startControlServer (server+token are in scope).
- EDIT index.ts: after the control server is started, resolve the island app path (dev: <ROOT>/native/island-helper/build/BlitzIsland.app; prod: the bundled location next to the computer-use helper — mirror how computer-use-helper.ts resolves its bundle) and call launchIslandHelper(appPath). Wire it where startControlServer / the computer-use helper are wired.
- NEW scripts/test-island-bridge.mjs (PURE NODE, no electron): import attachIslandWebSocket from ../src/main/island-bridge.mjs, start a plain http server on an ephemeral port with a known token, attach it, then use a 'ws' client to assert: (1) wrong token is REJECTED (no upgrade), (2) correct token CONNECTS, (3) the server sends a {t:'process.list'} snapshot on connect, (4) the server sends {t:'ping'} and when the client replies {t:'pong'} the server logs/accepts it, (5) a {t:'hello'} from the client is handled without error. Exit non-zero on any failure (match the test-launcher.mjs ok()/ALL PASS style).
ROOT = ${ROOT}`

const SPEC_SCHEMA = { type:'object', required:['area','spec'], properties:{ area:{type:'string'}, spec:{type:'string', description:'concrete implementation guidance with exact APIs/paths'}, pitfalls:{type:'array', items:{type:'string'}} } }
const AUTHORED_SCHEMA = { type:'object', required:['files','summary'], properties:{ files:{type:'array', items:{type:'string'}}, summary:{type:'string'} } }
const BUILD_SCHEMA = { type:'object', required:['ok','detail'], properties:{ ok:{type:'boolean', description:'true ONLY if swiftc exits 0 AND tsc has NO errors in island-bridge*/control-server.ts/main index.ts AND test-island-bridge.mjs passes AND test-launcher.mjs passes'}, detail:{type:'string', description:'per-check results: swift / tsc(my files) / ws-round-trip / launcher; include the real error text on any failure'} } }
const REVIEW_SCHEMA = { type:'object', required:['findings'], properties:{ findings:{ type:'array', items:{ type:'object', required:['severity','title','detail','fix'], properties:{ severity:{type:'string', enum:['blocker','major','minor']}, title:{type:'string'}, detail:{type:'string'}, file:{type:'string'}, fix:{type:'string'} } } } } }

// ---------- Research ----------
phase('Research')
const r1 = `Produce an implementation SPEC (not code) for MOUNTING the /island WebSocket on the existing control server and the session/token plumbing. Read fully: ${ROOT}/src/main/control-server.ts and ${ROOT}/src/main/sessionFile.ts (how setLocal writes session.json local.{url,token}) and how ${ROOT}/src/main/index.ts wires startControlServer. ${FACTS} ${ARCH} Output exactly where + how to call attachIslandWebSocket(server, token), and confirm the session.json local shape the island depends on.`
const r2 = `Produce an implementation SPEC (not code) for LAUNCH + SUPERVISE of BlitzIsland.app, modeled on the existing native helper. Read fully: ${ROOT}/src/main/computer-use-helper.ts (its app-path resolution dev-vs-bundled, how it spawns via LaunchServices/open, and supervise/relaunch) and ${ROOT}/native/island-helper/build.sh (output path native/island-helper/build/BlitzIsland.app). Specify launchIslandHelper(appPath): resolve dev vs prod path in index.ts, the 'open' invocation, relaunch-on-exit with a debounce, and duplicate-instance avoidance. ${ARCH}`
const r3 = `Produce an implementation SPEC (not code) for the WS PROTOCOL handler + the round-trip test. Read fully: ${ROOT}/native/island-helper/main.swift (confirm the EXACT frames the island sends/expects) and ${ROOT}/scripts/test-launcher.mjs (match its test style: an ok(name,cond) helper + 'ALL PASS' + non-zero exit on failure). ${ISLAND_PROTOCOL} ${ARCH} Specify onIslandConnection's frame handling and the exact assertions test-island-bridge.mjs must make (token reject/accept, snapshot, ping->pong, hello).`
const specs = (await parallel([
  () => agent(r1, { label:'research:mount', phase:'Research', schema: SPEC_SCHEMA }),
  () => agent(r2, { label:'research:supervise', phase:'Research', schema: SPEC_SCHEMA }),
  () => agent(r3, { label:'research:protocol', phase:'Research', schema: SPEC_SCHEMA }),
])).filter(Boolean)
log(`research: ${specs.length}/3 specs`)

// ---------- Author ----------
phase('Author')
const specBlock = specs.map(s => `### ${s.area}\n${s.spec}\nPITFALLS: ${(s.pitfalls||[]).join('; ')}`).join('\n\n')
const authored = await agent(`Implement P0b + the P0d test. Follow these specs EXACTLY:\n\n${specBlock}\n\n${FACTS}\n${ISLAND_PROTOCOL}\n${ARCH}\n\nWrite/edit with the Write/Edit tools:\n- NEW ${ROOT}/src/main/island-bridge.mjs (pure node: attachIslandWebSocket, onIslandConnection, launchIslandHelper)\n- NEW ${ROOT}/src/main/island-bridge.d.mts (declarations for the three exports)\n- EDIT ${ROOT}/src/main/control-server.ts (import + call attachIslandWebSocket(server, token))\n- EDIT ${ROOT}/src/main/index.ts (resolve the island app path + call launchIslandHelper after the control server starts)\n- NEW ${ROOT}/scripts/test-island-bridge.mjs (the pure-node WS round-trip test)\nDo NOT run the Electron app or 'npm run build' (the renderer is mid-refactor by the user and fails to build — that is NOT your concern; never touch src/renderer). Return the files you wrote.`, { label:'author', phase:'Author', schema: AUTHORED_SCHEMA })
log(`authored: ${(authored && authored.files || []).join(', ')}`)

// ---------- Build (verify loop) ----------
phase('Build')
const buildCmd = `Verify P0b honestly. Run from ${ROOT}:
1) bash native/island-helper/build.sh >/tmp/p0b-swift.log 2>&1; echo "swift_exit=$?"   (island must still compile)
2) npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "island-bridge|control-server\\.ts|main/index\\.ts" ; echo "tsc_my_files_above (empty = clean)"   (IGNORE all src/renderer errors — that is the user's WIP)
3) node scripts/test-island-bridge.mjs 2>&1 | tail -20; echo "wsrt_exit=$?"
4) node scripts/test-launcher.mjs 2>&1 | tail -3; echo "launcher_exit=$?"
Set ok=true ONLY if swift_exit=0 AND step 2 printed NO lines about my files AND wsrt_exit=0 AND launcher_exit=0. Put each check's result + any real error text in 'detail'. Do not edit files; only verify.`
let build = await agent(buildCmd, { label:'build:1', phase:'Build', schema: BUILD_SCHEMA })
let tries = 1
while (build && !build.ok && tries < 4) {
  await agent(`P0b verification FAILED:\n\n${build.detail}\n\nFix the REAL cause in the P0b files under ${ROOT}/src/main (island-bridge.mjs/.d.mts, control-server.ts, index.ts) or scripts/test-island-bridge.mjs. Never touch src/renderer. Keep the island protocol + the pure-node/testable architecture intact. ${ISLAND_PROTOCOL} ${ARCH} Return the files you changed.`, { label:`buildfix:${tries}`, phase:'Build', schema: AUTHORED_SCHEMA })
  build = await agent(buildCmd, { label:`build:${tries+1}`, phase:'Build', schema: BUILD_SCHEMA })
  tries++
}
log(`build after ${tries} attempt(s): ok=${build && build.ok}`)

// ---------- Review ----------
phase('Review')
const LENSES = [
  { key:'protocol', prompt:`Does the bridge speak EXACTLY the island's protocol over WS text frames (read native/island-helper/main.swift): accepts the island's {t:'hello'}, sends a {t:'process.list'} snapshot + {t:'ping'}, recognizes {t:'pong'}? Any frame-shape or t-key mismatch is a blocker (the round-trip would silently fail).` },
  { key:'ws-server', prompt:`WS server correctness in island-bridge.mjs: upgrade handling only for /island; STRICT token validation on the ?token= query (wrong/missing token rejected, socket destroyed, no hang); wss({noServer:true}) + handleUpgrade used right; per-connection error/close cleanup, no listener/socket leaks; safe against malformed/non-JSON frames.` },
  { key:'supervise', prompt:`launchIslandHelper(appPath): correct dev path (native/island-helper/build/BlitzIsland.app) and a sane prod/bundled fallback; the 'open' invocation; relaunch-on-exit is DEBOUNCED (no tight respawn loop if the app is missing/crashes); duplicate-instance avoidance; never throws on a missing bundle. And island-bridge.mjs stays electron-free (the test imports it).` },
  { key:'wiring', prompt:`Wiring: control-server.ts calls attachIslandWebSocket(server, token) with the in-scope server+token; index.ts calls launchIslandHelper AFTER the control server is listening (so session.json exists) and resolves the app path correctly; the .d.mts matches the .mjs exports; nothing in src/renderer was touched.` },
]
let findings = []
if (build && build.ok) {
  const reviews = (await parallel(LENSES.map(L => () =>
    agent(`Adversarial review of the P0b implementation under ${ROOT}/src/main (island-bridge.mjs/.d.mts, control-server.ts, index.ts) + scripts/test-island-bridge.mjs. ${L.prompt} Return concrete findings; prefer few real ones; default to none if correct.`,
      { label:`review:${L.key}`, phase:'Review', schema: REVIEW_SCHEMA })
  ))).filter(Boolean)
  findings = reviews.flatMap(r => r.findings||[]).filter(f => f.severity==='blocker' || f.severity==='major')
}
log(`review: ${findings.length} blocker/major findings`)

// ---------- Fix ----------
phase('Fix')
let note = 'no blocker/major findings'
if (findings.length) {
  const list = findings.map((f,i)=>`${i+1}. [${f.severity}] ${f.title} (${f.file||''}): ${f.detail}\n   FIX: ${f.fix}`).join('\n')
  await agent(`Apply these confirmed findings to the P0b files under ${ROOT} (never touch src/renderer), then it must still pass verification:\n\n${list}\n\n${ISLAND_PROTOCOL} ${ARCH} Return the files you changed.`, { label:'fix', phase:'Fix', schema: AUTHORED_SCHEMA })
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