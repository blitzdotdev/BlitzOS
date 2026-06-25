// test-launcher.mjs — prove the standalone Launcher (Shell A, src/main/launcher.ts) does the ONE thing
// that is headless-testable: its Send IPC handler turns a typed prompt into a REAL start_workflow — i.e. it
// spawns a FRESH agent with the ORCHESTRATORS (dynamic-workflows) capability ON, then seeds the typed prompt
// (+ any dropped context refs) as that agent's first directive. The window / global hotkey / visual are
// runtime-only (Electron BrowserWindow + vibrancy) and OUT OF SCOPE here; the user verifies the bar appearing.
// This test covers the data path under that UI, plus a structural audit of the electron-bound wiring that can't
// execute in a node sandbox (the handler guards, the index.ts → start_workflow seam, the preload bridge). Run
// with `node scripts/test-launcher.mjs`.
//
// NOTE — the Job model was RETIRED on this branch (start_job → start_workflow; src/main/job-model.mjs is gone).
// The launcher's injected seam is `startWorkflow`, backed by electronOps.startWorkflow: a Send spawns an
// orchestrator agent (osSpawnAgent(title, false, true) →
// addAgent stamps `orchestrators:true` onto meta.json BEFORE the terminal launches, so the first bootstrap
// carries the orchestrator duty) and seeds the task via osUserMessage (the task lands in chat.md, read on boot).
// There is NO Job object / `proposed` status / makeJob anymore — this test asserts the new contract.
//
// WHY the handler is REPRODUCED, not imported: launcher.ts is Electron-main TypeScript — it imports `electron`
// (app/BrowserWindow/ipcMain/screen) at module top, so it cannot be loaded by `node` (no electron runtime, no
// TS loader). So Part A wires the launcher's EXACT production chain out of its REAL pieces — a stand-in wsHost
// whose addAgent stamps `orchestrators` onto meta.json byte-for-byte as workspace-host.mjs:651 does (via the
// SAME terminal-manager serializer the three-serializer rule governs) + an appendChat that records the seeded
// task as osUserMessage(osActions.ts:835) does — then runs the handler's literal body (launcher.ts:396-415) and
// electronOps.startWorkflow's literal body (electron-os-tools.ts:84-90) over it. Part B then reads launcher.ts /
// index.ts / electron-os-tools.ts / preload off disk and asserts the load-bearing lines are actually present, so
// a future edit that breaks the contract fails here even though the window itself never runs.
import { writeTerminalMeta, readTerminalMeta } from '../src/main/terminal-manager.mjs'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}

// ===========================================================================================================
// Part A — the Send IPC handler maps a prompt to a REAL start_workflow (the data path under the bar).
// ===========================================================================================================
console.log('Launcher Send handler → real start_workflow (src/main/launcher.ts):')

// One temp `.blitzos/terminals` dir; the stand-in wsHost writes each agent's meta.json under it (mkdir handled
// by the real writeTerminalMeta serializer).
const terminalsDir = mkdtempSync(join(tmpdir(), 'aos-launcher-'))

// A faithful stand-in for the production workspace host. newAgentId + addAgent mirror workspace-host.mjs
// (newAgentId = max numeric id + 1; addAgent stamps `orchestrators:true` onto meta.json — the SAME write as
// line 651 that makes the agent's first bootstrap carry the orchestrator duty). appendChat mirrors osActions
// osUserMessage's wsHost.appendChat('user', text, id): it records the seeded task per agent. We record every
// spawned id so we can prove each start_workflow lands on a DISTINCT, NEW agent (a workflow entrypoint must
// never clobber an existing agent).
const spawned = []
const chatById = {}
const wsHost = {
  newAgentId() {
    let max = 0
    for (const e of spawned) { const n = Number(e.id); if (Number.isInteger(n) && n > max) max = n }
    return String(max + 1)
  },
  addAgent(id, title, opts = {}) {
    // Byte-for-byte the meta write of workspace-host.mjs:651 (the seam that stamps the orchestrators flag
    // pre-launch), via the SAME terminal-manager serializer the three-serializer rule governs — NO terminal is
    // actually launched. The orchestrators flag rides ON meta.json (the dynamic-workflows capability).
    writeTerminalMeta(terminalsDir, id, {
      id, kind: 'agent', title: title || `Chat ${id}`, stage: 0, createdAt: Date.now(),
      ...(opts.orchestrators ? { orchestrators: true } : {})
    })
    return { id, title: title || `Chat ${id}`, focus: !!opts.focus }
  },
  // osUserMessage(osActions.ts:835) → wsHost.appendChat('user', text, aid). The launcher seeds the task this way.
  appendChat(role, text, agentId = '0') {
    (chatById[String(agentId)] ||= []).push({ role, text })
  }
}

// osSpawnAgent (osActions.ts:917-927) core — reproduced: newAgentId + addAgent(id, title, {focus, orchestrators}).
// The 3rd arg (orchestrators) is true for a workflow spawn, so addAgent stamps the durable flag.
function osSpawnAgentCore(title, focus = false, orchestrators = false) {
  const id = wsHost.newAgentId()
  const opts = { focus }
  if (orchestrators) opts.orchestrators = true
  wsHost.addAgent(id, title, opts)
  const agent = { id, title: title || `Chat ${id}` }
  spawned.push(agent)
  return agent
}
// osUserMessage (osActions.ts:832-838) core — reproduced: appendChat('user', text, id) when text is non-empty.
function osUserMessageCore(text, agentId = '0') {
  if (!String(text).trim()) return
  wsHost.appendChat('user', text, String(agentId))
}

// electronOps.startWorkflow (electron-os-tools.ts:84-90) — reproduced from its REAL chain: osSpawnAgent core
// (orchestrators ON) + the contextRefs footer + osUserMessage core seeding the task. Returns the SAME
// { ok, agent } shape the launcher's wiring expects. We record the seeded task so we can assert it verbatim.
let lastSeedArgs = null
const startWorkflowOp = (spec) => {
  const agent = osSpawnAgentCore(spec.title, false, true)
  const refs = Array.isArray(spec.contextRefs) && spec.contextRefs.length
    ? `\n\nContext (dropped onto the launcher):\n${spec.contextRefs.map((r) => `- ${r}`).join('\n')}` : ''
  const seeded = `${spec.task || ''}${refs}`
  lastSeedArgs = { id: agent.id, task: spec.task, contextRefs: spec.contextRefs, seeded }
  osUserMessageCore(seeded, agent.id)
  return { ok: true, agent }
}

// The index.ts seam (index.ts:530-536): wireLauncher's injected `startWorkflow` forwards the bar's
// { task, contextRefs } onto electronOps.startWorkflow. Reproduced so the handler runs the real chain.
const startWorkflowSeam = (spec) => startWorkflowOp({ task: spec.task, contextRefs: spec.contextRefs })

// ---- The launcher's Send IPC handler, LITERAL body (launcher.ts:396-415), parameterised on startWorkflowFn. --
// This is exactly what ipcMain.handle('launcher:start-workflow', ...) runs; we exercise it directly (ipcMain
// itself is electron-only). startWorkflowFn is the DI seam wireLauncher() fills (index.ts → electronOps.startWorkflow).
const hideCalls = { n: 0 }, focusCalls = { n: 0 }
function makeHandler(startWorkflowFn) {
  // The launcher accepts { prompt, attachments } (attachments = dropped absolute paths → contextRefs); a bare
  // string prompt stays valid (back-compat). Mirrors launcher.ts:396-415.
  return (payload) => {
    const obj = (payload && typeof payload === 'object') ? payload : { prompt: payload, attachments: [] }
    const task = String(obj.prompt ?? '').trim()
    if (!task) return { ok: false, error: 'empty prompt' }
    if (!startWorkflowFn) return { ok: false, error: 'launcher not wired (no workspace host yet)' }
    const contextRefs = Array.isArray(obj.attachments) ? obj.attachments.filter((p) => typeof p === 'string' && p.length > 0) : []
    try {
      const r = startWorkflowFn({ task, contextRefs })
      if (r && r.ok === false) return { ok: false, error: r.error || 'start_workflow failed' }
      hideCalls.n++            // hideLauncher()
      focusCalls.n++           // focusMainFn?.()
      return { ok: true, agentId: r?.agent?.id ?? null }
    } catch (e) {
      return { ok: false, error: e?.message || 'start_workflow threw' }
    }
  }
}

const handler = makeHandler(startWorkflowSeam)

// (A1) A normal prompt → ok:true, a NEW agent id, the bar is dismissed + main refocused.
{
  const PROMPT = '  organize my downloads folder and email me a summary  ' // padded: the handler must trim
  const res = handler(PROMPT)
  ok('Send(prompt) → { ok:true } with a spawned agentId', res.ok === true && typeof res.agentId === 'string' && res.agentId.length > 0, res)
  ok('Send dismisses the bar (hideLauncher) and raises main (focusMain) on success', hideCalls.n === 1 && focusCalls.n === 1, { hide: hideCalls.n, focus: focusCalls.n })

  // The load-bearing assertion: a REAL orchestrator agent is now on disk — its meta.json carries
  // `orchestrators:true` (the dynamic-workflows capability stamped pre-launch), kind:agent intact.
  const meta = readTerminalMeta(terminalsDir, res.agentId)
  ok('the spawned agent has the ORCHESTRATORS capability on its meta.json (kind:agent intact)',
    !!meta && meta.orchestrators === true && meta.kind === 'agent', meta)
  ok('the meta.json was actually written to disk', existsSync(join(terminalsDir, res.agentId, 'meta.json')))

  // The typed prompt was SEEDED into the agent (osUserMessage → appendChat('user', task, id)), trimmed, as the
  // first directive the agent reads on boot.
  const chat = chatById[res.agentId] || []
  ok('the typed prompt is SEEDED as the agent\'s first user message (trimmed, verbatim)',
    chat.length === 1 && chat[0].role === 'user' && chat[0].text === PROMPT.trim(), chat)

  // The handler passed the prompt through as { task, contextRefs }; with NO files dropped the contextRefs is
  // empty so the seeded text is the bare task (no Context footer).
  ok('start_workflow received task=<prompt>, no title, contextRefs empty when nothing is attached',
    lastSeedArgs && lastSeedArgs.task === PROMPT.trim() &&
      (!lastSeedArgs.contextRefs || lastSeedArgs.contextRefs.length === 0) &&
      lastSeedArgs.seeded === PROMPT.trim(), lastSeedArgs)
}

// (A2) A SECOND Send → a SECOND, DISTINCT agent (a workflow entrypoint never reuses/clobbers an existing agent).
{
  const firstId = spawned[0].id
  const res = handler('draft a reply to the landlord')
  ok('a second Send spawns a DISTINCT new agent (no clobber)', res.ok === true && res.agentId !== firstId, { firstId, second: res.agentId })
  ok('the second agent is ALSO an orchestrator (its own meta orchestrators:true)',
    readTerminalMeta(terminalsDir, res.agentId)?.orchestrators === true, readTerminalMeta(terminalsDir, res.agentId))
  ok('the second agent is seeded with ITS OWN task', (chatById[res.agentId] || [])[0]?.text === 'draft a reply to the landlord', chatById[res.agentId])
  ok('two agents now exist on disk', spawned.length === 2 && existsSync(join(terminalsDir, firstId, 'meta.json')) && existsSync(join(terminalsDir, res.agentId, 'meta.json')))
}

// (A3) Empty / whitespace prompt → a clean error, NO spawn (the bar's Send is disabled on empty, but the
// handler must not trust the renderer).
{
  const countBefore = spawned.length
  const r1 = handler('')
  const r2 = handler('   ')
  const r3 = handler(null)
  const r4 = handler(undefined)
  ok('empty/whitespace/null/undefined prompt → { ok:false, error:"empty prompt" }, no spawn',
    r1.ok === false && r1.error === 'empty prompt' && r2.ok === false && r3.ok === false && r4.ok === false && spawned.length === countBefore,
    { r1, r2, r3, r4, spawnedDelta: spawned.length - countBefore })
}

// (A4) Not-yet-wired (no workspace host) → the documented guard, no throw, no spawn.
{
  const unwired = makeHandler(null) // startWorkflowFn === null (before wireLauncher / before a workspace exists)
  const r = unwired('do the thing')
  ok('Send before wiring → { ok:false, error:"launcher not wired..." } (no crash)',
    r.ok === false && /not wired/.test(r.error || ''), r)
}

// (A5) start_workflow itself failing (e.g. host returns ok:false) → the error is surfaced, the bar is NOT
// dismissed. (Production: osSpawnAgent throws 'no workspace host' before a host exists — the try/catch path.)
{
  const hBefore = hideCalls.n
  const failing = makeHandler(() => ({ ok: false, error: 'no workspace host' }))
  const r = failing('whatever')
  ok('a failing start_workflow → { ok:false } surfaced and the bar stays open (no hide)',
    r.ok === false && r.error === 'no workspace host' && hideCalls.n === hBefore, { r, hideUnchanged: hideCalls.n === hBefore })
  // And a THROW is caught, not propagated (osSpawnAgent('no workspace host') is the real-world throw).
  const thrower = makeHandler(() => { throw new Error('no workspace host') })
  const rt = thrower('x')
  ok('a throwing start_workflow is caught → { ok:false, error:<message> }', rt.ok === false && rt.error === 'no workspace host', rt)
}

// (A6) Dropped attachments → the bar passes them as contextRefs; they ride into the SEEDED task as a Context
// footer (the user drops files/folders, the chips' paths give the orchestrator agent its scope).
{
  const ATTACH = ['/Users/me/Downloads/report.pdf', '/Users/me/Projects/site']
  const res = handler({ prompt: 'summarize these and build a status page', attachments: ATTACH })
  ok('Send WITH attachments → ok:true on a new agent', res.ok === true && typeof res.agentId === 'string', res)
  ok('the dropped paths ride start_workflow as contextRefs (verbatim, in order)',
    lastSeedArgs && Array.isArray(lastSeedArgs.contextRefs) && lastSeedArgs.contextRefs.length === 2 &&
      lastSeedArgs.contextRefs[0] === ATTACH[0] && lastSeedArgs.contextRefs[1] === ATTACH[1], lastSeedArgs && lastSeedArgs.contextRefs)
  // The seeded first message = the task + a Context footer listing each dropped path (electron-os-tools.ts:86-88).
  const seeded = (chatById[res.agentId] || [])[0]?.text || ''
  ok('the seeded message is the task PLUS a Context footer naming each dropped path',
    seeded.startsWith('summarize these and build a status page') &&
      seeded.includes('Context (dropped onto the launcher):') &&
      seeded.includes(`- ${ATTACH[0]}`) && seeded.includes(`- ${ATTACH[1]}`), seeded)
  // The handler must not trust the renderer payload: non-string / empty entries are filtered before contextRefs.
  const res2 = handler({ prompt: 'x', attachments: ['/a/b.txt', '', null, 42, '/c/d'] })
  ok('non-string / empty attachment entries are filtered out',
    lastSeedArgs && Array.isArray(lastSeedArgs.contextRefs) && lastSeedArgs.contextRefs.length === 2 &&
      lastSeedArgs.contextRefs[0] === '/a/b.txt' && lastSeedArgs.contextRefs[1] === '/c/d', lastSeedArgs && lastSeedArgs.contextRefs)
  // A bare-string payload (back-compat) still works and yields a bare seeded task (no Context footer).
  const res3 = handler('plain string still works')
  ok('a bare-string prompt (back-compat) still spawns an orchestrator agent seeded with just the task',
    res3.ok === true && (chatById[res3.agentId] || [])[0]?.text === 'plain string still works' &&
      readTerminalMeta(terminalsDir, res3.agentId)?.orchestrators === true, chatById[res3.agentId])
}

rmSync(terminalsDir, { recursive: true, force: true })

// ===========================================================================================================
// Part B — structural audit of the electron-bound wiring (the parts that can't execute under node):
//   the Send IPC handler + its guards, the index.ts → start_workflow seam, the start_workflow op itself, the
//   preload bridge. Read the ACTUAL source off disk and assert the load-bearing lines are present, so a
//   regression in the real file (not this reproduction) is caught here.
// ===========================================================================================================
console.log('\nLauncher electron wiring (structural — source audit of the runtime-only parts):')

const launcherSrc = readFileSync(join(repoRoot, 'src/main/launcher.ts'), 'utf8')
const indexSrc = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
const preloadSrc = readFileSync(join(repoRoot, 'src/preload/index.ts'), 'utf8')
const elOpsSrc = readFileSync(join(repoRoot, 'src/main/electron-os-tools.ts'), 'utf8')

// -- ⌥Space ownership moved to the native dynamic island (P0c): the launcher no longer grabs the chord -------
ok('the launcher registers NO Electron globalShortcut (the native island owns ⌥Space — P0c)',
  !/globalShortcut/.test(launcherSrc))
ok('the launcher window + Send IPC stay wired (kept dormant for a future in-app HUD)',
  /function ensureWindow/.test(launcherSrc) && /ipcMain\.handle\(\s*'launcher:start-workflow'/.test(launcherSrc))

// -- the Send IPC handler: the prompt+attachments → start_workflow mapping + the guards (the contract Part A ran) -
ok("the Send IPC channel is 'launcher:start-workflow'", /ipcMain\.handle\(\s*'launcher:start-workflow'/.test(launcherSrc))
ok('the handler trims the prompt and guards empty', /String\(obj\.prompt[^)]*\)\.trim\(\)/.test(launcherSrc) && /if\s*\(!task\)\s*return\s*\{\s*ok:\s*false/.test(launcherSrc))
ok('the handler guards the not-wired case (no startWorkflowFn)', /if\s*\(!startWorkflowFn\)\s*return\s*\{\s*ok:\s*false/.test(launcherSrc))
ok('the handler maps dropped attachments → contextRefs (string-filtered)',
  /Array\.isArray\(obj\.attachments\)/.test(launcherSrc) && /\.filter\(/.test(launcherSrc) && /typeof p === 'string'/.test(launcherSrc))
ok('the handler calls startWorkflowFn({ task, contextRefs }) — prompt→task, drops→context',
  /startWorkflowFn\(\s*\{\s*task\s*,\s*contextRefs\s*\}\s*\)/.test(launcherSrc))
ok('on success the handler hides the bar + focuses main', /hideLauncher\(\)/.test(launcherSrc) && /focusMainFn\?\.\(\)/.test(launcherSrc))

// -- the reported-bug fix + the new attachment affordances (keep-open, drag-drop, autosize) ------------------
ok('NO hide-on-blur (the bar STAYS OPEN while gathering attachments — the reported bug)', !/\.on\(\s*'blur'\s*,/.test(launcherSrc))
ok('drag-drop resolves files via the shared agentOS.dropPaths helper', /agentOS\.dropPaths\(/.test(launcherSrc))
ok('a dragged browser tab / link (URL) is accepted too (uri-list/plain → contextRef)',
  /text\/uri-list/.test(launcherSrc) && /isUrl\(/.test(launcherSrc))
ok('window drop is preventDefaulted (no navigate-to-file that would destroy the UI)',
  /addEventListener\(\s*'drop'/.test(launcherSrc) && /preventDefault\(\)/.test(launcherSrc))
ok('the bar autosizes the window (launcher:autosize → setBounds, width locked to LAUNCHER_W)',
  /ipcMain\.on\(\s*'launcher:autosize'/.test(launcherSrc) && /setBounds\(\{\s*x:\s*b\.x[\s\S]*?width:\s*LAUNCHER_W/.test(launcherSrc))
ok('the window is resizable with width locked via min/max (so autosize setBounds works on macOS)',
  /resizable:\s*true/.test(launcherSrc) && /minWidth:\s*LAUNCHER_W/.test(launcherSrc) && /maxWidth:\s*LAUNCHER_W/.test(launcherSrc))

// -- the auto-hide fix + the native vibrancy redesign --------------------------------------------------------
ok('the window is NOT a macOS panel (NSPanel hidesOnDeactivate=YES auto-hid the bar — the drag-drop blocker)',
  !/type:\s*['"]panel['"]/.test(launcherSrc) && !/\?\s*['"]panel['"]/.test(launcherSrc))
ok('native macOS vibrancy provides the glass (a standalone window cannot frost the desktop via CSS backdrop-filter)',
  /vibrancy:\s*launcherVibrancy\(\)/.test(launcherSrc) && /visualEffectState:\s*['"]active['"]/.test(launcherSrc))
ok('BLITZ_LAUNCHER_VIBRANCY env override is honored (tune the material without a rebuild)',
  /process\.env\.BLITZ_LAUNCHER_VIBRANCY/.test(launcherSrc))
ok('the bolt mark uses the Blitz-red accent token value, not a generic emoji glyph',
  /#e31c30/.test(launcherSrc) && !/&#9889;/.test(launcherSrc))

// -- message / tray toggle (the self-hosted "dynamic island" tray POC) ---------------------------------------
ok('there is a message <-> tray mode toggle (setMode + a tray-mode body class)',
  /function setMode\(/.test(launcherSrc) && /tray-mode/.test(launcherSrc) && /trayBtn|backBtn/.test(launcherSrc))
ok('the message prompt is a multiline textarea (Shift+Enter = newline, Enter = send)',
  /<textarea id="q"/.test(launcherSrc) && /e\.key === 'Enter' && !e\.shiftKey/.test(launcherSrc))
ok('message mode shows the tray item count (a badge / summary), not the previews',
  /badge\.textContent\s*=\s*n/.test(launcherSrc) && /trayCount\.textContent/.test(launcherSrc))
ok('tray mode renders a drop zone with proper Finder-icon previews (grid of tiles)',
  /id="drop"/.test(launcherSrc) && /function renderTray\(/.test(launcherSrc) && /function tileFor\(/.test(launcherSrc))
ok('dragging over the bar AUTO-EXPANDS it into tray mode (a big drop target — the small bar was too short)',
  /addEventListener\('dragenter'[\s\S]*?setMode\('tray'\)/.test(launcherSrc))
ok('tray previews use real Finder icons via the launcher.fileIcon bridge (main app.getFileIcon)',
  /launcher\.fileIcon\(/.test(launcherSrc) && /launcher:file-icon/.test(launcherSrc) && /app\.getFileIcon\(/.test(launcherSrc))
ok('preload exposes launcher.fileIcon -> launcher:file-icon (path -> data URL)',
  /fileIcon\(path:\s*string\)/.test(preloadSrc) && /invoke\('launcher:file-icon'/.test(preloadSrc))

// -- wireLauncher is called from index.ts, and its injected startWorkflow seam is backed by start_workflow -----
//    (the Job model is retired; the seam forwards { task, contextRefs } onto electronOps.startWorkflow).
ok('index.ts wires the launcher seam to electronOps.startWorkflow (task, drops→contextRefs)',
  /wireLauncher\(\{/.test(indexSrc) &&
    /startWorkflow:\s*\(spec\)\s*=>[\s\S]*?electronOps\.startWorkflow[\s\S]*?task:\s*spec\.task[\s\S]*?contextRefs:\s*spec\.contextRefs/.test(indexSrc))
ok('index.ts calls registerLauncher() (the Send IPC install)', /registerLauncher\(\)/.test(indexSrc))
// The retired Job model must be GONE from the runtime wiring — no resurrected start_job / job-model import.
ok('the Job model is retired: index.ts no longer imports job-model / calls start_job',
  !/from '\.\/job-model\.mjs'/.test(indexSrc) && !/electronOps\.startJob\b/.test(indexSrc), 'index.ts still references the retired job-model')

// -- electronOps.startWorkflow is the real start_workflow (osSpawnAgent with orchestrators ON + seed the task) -
ok('electronOps.startWorkflow spawns an orchestrator agent (osSpawnAgent(..., true)) and seeds the task',
  /startWorkflow:\s*\(spec[\s\S]*?osSpawnAgent\(\s*spec\.title\s*,\s*false\s*,\s*true\s*\)[\s\S]*?osUserMessage\(/.test(elOpsSrc))
ok('start_workflow appends the dropped contextRefs to the seeded task (a Context footer)',
  /spec\.contextRefs[\s\S]*?Context \(dropped onto the launcher\):/.test(elOpsSrc))

// -- the preload bridge is namespaced under agentOS.launcher (isolated; the renderer never sees it) ----------
ok('preload exposes the guarded launcher bridge (agentOS.launcher.startWorkflow → launcher:start-workflow)',
  /launcher:\s*\{[\s\S]*?ipcRenderer\.invoke\(\s*'launcher:start-workflow'/.test(preloadSrc))
ok('preload startWorkflow forwards { prompt, attachments } to launcher:start-workflow',
  /startWorkflow\(prompt[\s\S]*?attachments[\s\S]*?ipcRenderer\.invoke\(\s*'launcher:start-workflow',\s*\{\s*prompt,\s*attachments/.test(preloadSrc))
ok('preload exposes launcher.autosize → launcher:autosize (window grows to fit chips)',
  /autosize\(height[\s\S]*?ipcRenderer\.send\(\s*'launcher:autosize'/.test(preloadSrc))

// -- ISOLATION guard: launcher.ts never IMPORTS the renderer WIP files (App/store/PrimarySpace/styles). The
//    only references to those names live in a documentation comment ("NOT wired into ... App.tsx/store/..."),
//    so we scan import/from statements specifically, not comment prose. The launcher being its own window with
//    self-contained inline HTML is exactly why the user's single-canvas WIP stays untouched.
{
  const importLines = launcherSrc.split('\n').filter((l) => /^\s*import\b|\bfrom\s+['"]/.test(l) && !/^\s*\/\//.test(l))
  const touchesWip = importLines.some((l) => /(App\.tsx|App['"]|\/store['"]|store\.tsx?|PrimarySpace|styles\.css)/.test(l))
  ok('launcher.ts does NOT import App.tsx / store.ts / PrimarySpace / styles (the user WIP is untouched)',
    !touchesWip, importLines.filter((l) => /App|store|PrimarySpace|styles/.test(l)))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
