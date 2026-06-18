// test-launcher.mjs — prove the standalone Job Launcher (Shell A, src/main/launcher.ts) does the ONE thing
// that is headless-testable: its Send IPC handler turns a typed prompt into a REAL start_job — i.e. mints a
// 'proposed' Job, with the prompt as the goal, on a freshly-spawned agent. The window / global hotkey / visual
// are runtime-only (Electron NSPanel + globalShortcut) and OUT OF SCOPE here; the user verifies the bar
// appearing on ⌥Space. This test covers the data path under that UI, plus a structural audit of the electron-
// bound wiring that can't execute in a node sandbox (the globalShortcut registration + teardown, the handler
// guards). Run with `node scripts/test-launcher.mjs`.
//
// WHY the handler is REPRODUCED, not imported: launcher.ts is Electron-main TypeScript — it imports `electron`
// (app/BrowserWindow/globalShortcut/ipcMain/screen) at module top, so it cannot be loaded by `node` (no electron
// runtime, no TS loader). Same reason test-job-model.mjs reproduces index.ts's boot-task closure. So Part A wires
// the launcher's EXACT production chain out of its REAL pieces — makeJob (job-model.mjs) + a wsHost.addAgent that
// stamps the job onto meta.json byte-for-byte as workspace-host.mjs:667 does, then readJob to confirm durability
// — and runs the handler's literal body (launcher.ts:187-200) over it. Part B then reads launcher.ts off disk and
// asserts the load-bearing lines are actually present (the prompt→goal map, the empty/unwired guards, the
// Alt+Space default, globalShortcut.register, unregisterAll on will-quit), so a future edit that breaks the
// contract fails here even though the window itself never runs.
import { makeJob, readJob, wireJobModel } from '../src/main/job-model.mjs'
import { writeTerminalMeta } from '../src/main/terminal-manager.mjs'
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
// Part A — the Send IPC handler maps a prompt to a REAL start_job (the data path under the bar).
// ===========================================================================================================
console.log('Launcher Send handler → real start_job (src/main/launcher.ts):')

// One temp `.blitzos/terminals` dir; point job-model's resolver at it via the same DI seam index.ts uses.
const terminalsDir = mkdtempSync(join(tmpdir(), 'aos-launcher-'))
wireJobModel({ getTerminalsDir: () => terminalsDir })

// A faithful stand-in for the production workspace host. newAgentId + addAgent mirror workspace-host.mjs
// (newAgentId = max numeric id + 1; addAgent stamps opts.job onto meta.json — the SAME write as line 667 that
// makes the agent's first bootstrap carry the planning duty). We record every spawned id so we can prove each
// start_job lands on a DISTINCT, NEW agent (a job entrypoint must never clobber an existing agent).
let lastSpawnArgs = null
const spawned = []
const wsHost = {
  newAgentId() {
    let max = 0
    for (const e of spawned) { const n = Number(e.id); if (Number.isInteger(n) && n > max) max = n }
    return String(max + 1)
  },
  addAgent(id, title, opts = {}) {
    // Byte-for-byte the meta write of workspace-host.mjs:667 (the seam that stamps the job pre-launch), via the
    // SAME terminal-manager serializer the three-serializer rule governs — NO terminal is actually launched.
    writeTerminalMeta(terminalsDir, id, {
      id, kind: 'agent', title: title || `Chat ${id}`, createdAt: Date.now(),
      ...(opts.job && typeof opts.job === 'object' ? { job: opts.job } : {})
    })
    return { id, title: title || `Chat ${id}`, focus: !!opts.focus }
  }
}

// electronOps.startJob (electron-os-tools.ts:84-88) — reproduced from its REAL pieces: makeJob (real import) +
// osSpawnAgent's core (newAgentId + addAgent(..., {focus,job}), osActions.ts:925-932). Returns the same
// { ok, agent, job } shape the launcher's wiring expects.
const startJobOp = (spec) => {
  const job = makeJob({ goal: spec.goal, title: spec.title, contextRefs: spec.contextRefs })
  const id = wsHost.newAgentId()
  lastSpawnArgs = { id, title: spec.title, job }
  const r = wsHost.addAgent(id, spec.title, { focus: false, job })
  const agent = { id: r.id, title: r.title }
  spawned.push(agent)
  return { ok: true, agent, job }
}

// ---- The launcher's Send IPC handler, LITERAL body (launcher.ts:187-200), parameterised on startJobFn. -----
// This is exactly what ipcMain.handle('launcher:start-job', ...) runs; we exercise it directly (ipcMain itself
// is electron-only). startJobFn is the DI seam wireLauncher() fills (index.ts:527 → electronOps.startJob).
const hideCalls = { n: 0 }, focusCalls = { n: 0 }
function makeHandler(startJobFn) {
  // The launcher accepts { prompt, attachments } (attachments = dropped absolute paths → contextRefs); a bare
  // string prompt stays valid (back-compat). Mirrors launcher.ts:187-208.
  return (payload) => {
    const obj = (payload && typeof payload === 'object') ? payload : { prompt: payload, attachments: [] }
    const goal = String(obj.prompt ?? '').trim()
    if (!goal) return { ok: false, error: 'empty prompt' }
    if (!startJobFn) return { ok: false, error: 'launcher not wired (no workspace host yet)' }
    const contextRefs = Array.isArray(obj.attachments) ? obj.attachments.filter((p) => typeof p === 'string' && p.length > 0) : []
    try {
      const r = startJobFn({ goal, contextRefs })
      if (r && r.ok === false) return { ok: false, error: r.error || 'start_job failed' }
      hideCalls.n++            // hideLauncher()
      focusCalls.n++           // focusMainFn?.()
      return { ok: true, agentId: r?.agent?.id ?? null }
    } catch (e) {
      return { ok: false, error: e?.message || 'start_job threw' }
    }
  }
}

const handler = makeHandler(startJobOp)

// (A1) A normal prompt → ok:true, a NEW agent id, the bar is dismissed + main refocused.
{
  const PROMPT = '  organize my downloads folder and email me a summary  ' // padded: the handler must trim
  const res = handler(PROMPT)
  ok('Send(prompt) → { ok:true } with a spawned agentId', res.ok === true && typeof res.agentId === 'string' && res.agentId.length > 0, res)
  ok('Send dismisses the bar (hideLauncher) and raises main (focusMain) on success', hideCalls.n === 1 && focusCalls.n === 1, { hide: hideCalls.n, focus: focusCalls.n })

  // The load-bearing assertion: a REAL proposed Job, with the trimmed prompt as its goal, is now durable on the
  // freshly-spawned agent's meta.json — read back fresh (not from the return value).
  const job = readJob(res.agentId)
  ok('a REAL job is minted on the spawned agent (status "proposed")', !!job && job.status === 'proposed', job)
  ok('the job goal IS the prompt (trimmed, verbatim)', !!job && job.goal === PROMPT.trim(), job && job.goal)
  ok('makeJob stamped createdAt/updatedAt timestamps', !!job && typeof job.createdAt === 'number' && typeof job.updatedAt === 'number', job)

  // It is a real `job` object on meta.json (the three-serializer rule), not a parallel store.
  const meta = JSON.parse(readFileSync(join(terminalsDir, res.agentId, 'meta.json'), 'utf8'))
  ok('the job rides ON meta.json as `job` (kind:agent intact)', !!meta.job && meta.job.goal === PROMPT.trim() && meta.kind === 'agent', meta.job)

  // The handler passed the prompt through as { goal, contextRefs }; with NO files dropped the contextRefs is an
  // empty array (guards the wiring at index.ts → electronOps.startJob({ goal: spec.goal, contextRefs: ... })).
  ok('startJob received { goal: <prompt> }, contextRefs empty when nothing is attached',
    lastSpawnArgs && lastSpawnArgs.job.goal === PROMPT.trim() && lastSpawnArgs.title === undefined &&
      (!lastSpawnArgs.job.contextRefs || lastSpawnArgs.job.contextRefs.length === 0), lastSpawnArgs)
}

// (A2) A SECOND Send → a SECOND, DISTINCT agent (a job entrypoint never reuses/clobbers an existing agent).
{
  const firstId = spawned[0].id
  const res = handler('draft a reply to the landlord')
  ok('a second Send spawns a DISTINCT new agent (no clobber)', res.ok === true && res.agentId !== firstId, { firstId, second: res.agentId })
  ok('the second agent carries ITS OWN proposed job', readJob(res.agentId)?.goal === 'draft a reply to the landlord', readJob(res.agentId))
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
  const unwired = makeHandler(null) // startJobFn === null (before wireLauncher / before a workspace exists)
  const r = unwired('do the thing')
  ok('Send before wiring → { ok:false, error:"launcher not wired..." } (no crash)',
    r.ok === false && /not wired/.test(r.error || ''), r)
}

// (A5) startJob itself failing (e.g. host returns ok:false) → the error is surfaced, the bar is NOT dismissed.
{
  const hBefore = hideCalls.n
  const failing = makeHandler(() => ({ ok: false, error: 'no workspace host' }))
  const r = failing('whatever')
  ok('a failing startJob → { ok:false } surfaced and the bar stays open (no hide)',
    r.ok === false && r.error === 'no workspace host' && hideCalls.n === hBefore, { r, hideUnchanged: hideCalls.n === hBefore })
  // And a THROW is caught, not propagated.
  const thrower = makeHandler(() => { throw new Error('spawn blew up') })
  const rt = thrower('x')
  ok('a throwing startJob is caught → { ok:false, error:<message> }', rt.ok === false && rt.error === 'spawn blew up', rt)
}

// (A6) Dropped attachments → the bar passes them as contextRefs; they land on the minted Job (the A2 path:
// the user drops files/folders, the chips' paths ride start_job into the planning context).
{
  const ATTACH = ['/Users/me/Downloads/report.pdf', '/Users/me/Projects/site']
  const res = handler({ prompt: 'summarize these and build a status page', attachments: ATTACH })
  ok('Send WITH attachments → ok:true on a new agent', res.ok === true && typeof res.agentId === 'string', res)
  const job = readJob(res.agentId)
  ok('the dropped paths are stored on the job as contextRefs (verbatim, in order)',
    !!job && Array.isArray(job.contextRefs) && job.contextRefs.length === 2 &&
      job.contextRefs[0] === ATTACH[0] && job.contextRefs[1] === ATTACH[1], job && job.contextRefs)
  ok('the goal is still the typed prompt (attachments augment, not replace)',
    !!job && job.goal === 'summarize these and build a status page', job && job.goal)
  // The handler must not trust the renderer payload: non-string / empty entries are filtered.
  const res2 = handler({ prompt: 'x', attachments: ['/a/b.txt', '', null, 42, '/c/d'] })
  const job2 = readJob(res2.agentId)
  ok('non-string / empty attachment entries are filtered out',
    !!job2 && Array.isArray(job2.contextRefs) && job2.contextRefs.length === 2 &&
      job2.contextRefs[0] === '/a/b.txt' && job2.contextRefs[1] === '/c/d', job2 && job2.contextRefs)
  // A bare-string payload (back-compat) still works and yields empty contextRefs.
  const res3 = handler('plain string still works')
  ok('a bare-string prompt (back-compat) still mints a job with empty contextRefs',
    res3.ok === true && (readJob(res3.agentId)?.contextRefs || []).length === 0, readJob(res3.agentId))
}

rmSync(terminalsDir, { recursive: true, force: true })

// ===========================================================================================================
// Part B — structural audit of the electron-bound wiring (the parts that can't execute under node):
//   the global hotkey registration + its teardown, the default accelerator, the handler guards, the preload
//   bridge. Read the ACTUAL source off disk and assert the load-bearing lines are present, so a regression in
//   the real file (not this reproduction) is caught here.
// ===========================================================================================================
console.log('\nLauncher electron wiring (structural — source audit of the runtime-only parts):')

const launcherSrc = readFileSync(join(repoRoot, 'src/main/launcher.ts'), 'utf8')
const indexSrc = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
const preloadSrc = readFileSync(join(repoRoot, 'src/preload/index.ts'), 'utf8')
const elOpsSrc = readFileSync(join(repoRoot, 'src/main/electron-os-tools.ts'), 'utf8')

// -- the global hotkey: default Alt+Space, registered to toggle, torn down on quit ----------------------------
ok("default hotkey is 'Alt+Space' (⌥Space)", /const\s+DEFAULT_HOTKEY\s*=\s*'Alt\+Space'/.test(launcherSrc), launcherSrc.match(/DEFAULT_HOTKEY\s*=\s*'[^']*'/)?.[0])
ok('BLITZ_LAUNCHER_HOTKEY env override is honored', /process\.env\.BLITZ_LAUNCHER_HOTKEY/.test(launcherSrc))
ok('globalShortcut.register(<accel>, …) wires the hotkey to toggleLauncher',
  /globalShortcut\.register\(\s*accel\s*,\s*\(\)\s*=>\s*toggleLauncher\(\)\s*\)/.test(launcherSrc))
ok('the hotkey is unregistered on quit (will-quit → globalShortcut.unregisterAll)',
  /app\.on\(\s*'will-quit'[\s\S]*?globalShortcut\.unregisterAll\(\)/.test(launcherSrc))
ok('a failed registration is logged, not fatal (no throw on a taken chord)',
  /FAILED to register global hotkey/.test(launcherSrc) && !/throw/.test(launcherSrc.split('will-quit')[0].split('globalShortcut.register')[1] || ''))

// -- the Send IPC handler: the prompt+attachments → start_job mapping + the guards (the contract Part A ran) ---
ok("the Send IPC channel is 'launcher:start-job'", /ipcMain\.handle\(\s*'launcher:start-job'/.test(launcherSrc))
ok('the handler trims the prompt and guards empty', /String\(obj\.prompt[^)]*\)\.trim\(\)/.test(launcherSrc) && /if\s*\(!goal\)\s*return\s*\{\s*ok:\s*false/.test(launcherSrc))
ok('the handler guards the not-wired case (no startJobFn)', /if\s*\(!startJobFn\)\s*return\s*\{\s*ok:\s*false/.test(launcherSrc))
ok('the handler maps dropped attachments → contextRefs (string-filtered)',
  /Array\.isArray\(obj\.attachments\)/.test(launcherSrc) && /\.filter\(/.test(launcherSrc) && /typeof p === 'string'/.test(launcherSrc))
ok('the handler calls startJobFn({ goal, contextRefs }) — prompt→goal, drops→context',
  /startJobFn\(\s*\{\s*goal\s*,\s*contextRefs\s*\}\s*\)/.test(launcherSrc))
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

// -- wireLauncher is called from index.ts with electronOps.startJob({ goal }) as the seam --------------------
ok('index.ts wires the launcher to electronOps.startJob({ goal, contextRefs })',
  /wireLauncher\(\{/.test(indexSrc) && /electronOps\.startJob[\s\S]*?goal:\s*spec\.goal[\s\S]*?contextRefs:\s*spec\.contextRefs/.test(indexSrc))
ok('index.ts calls registerLauncher() (the hotkey + handler install)', /registerLauncher\(\)/.test(indexSrc))

// -- electronOps.startJob is the real start_job (makeJob + osSpawnAgent with the job stamped) ----------------
ok('electronOps.startJob mints a job via makeJob and spawns an agent WITH it',
  /startJob:\s*\(spec[\s\S]*?makeJob\(\{[\s\S]*?osSpawnAgent\([^)]*job[^)]*\)/.test(elOpsSrc))

// -- the preload bridge is namespaced under agentOS.launcher (isolated; the renderer never sees it) ----------
ok('preload exposes the guarded launcher bridge (agentOS.launcher.startJob → launcher:start-job)',
  /launcher:\s*\{[\s\S]*?ipcRenderer\.invoke\(\s*'launcher:start-job'/.test(preloadSrc))
ok('preload startJob forwards { prompt, attachments } to launcher:start-job',
  /startJob\(prompt[\s\S]*?attachments[\s\S]*?ipcRenderer\.invoke\(\s*'launcher:start-job',\s*\{\s*prompt,\s*attachments/.test(preloadSrc))
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
