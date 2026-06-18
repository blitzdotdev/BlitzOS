// test-island-window.mjs — prove the Notch-spill Island (src/main/island.ts) does the ONE thing that is
// headless-testable: its Send IPC handler turns a typed prompt + a Deep toggle into a REAL spawn. Deep ON →
// startWorkflow (a FRESH agent with the ORCHESTRATORS capability ON, seeded with the prompt). Deep OFF → a PLAIN
// agent (orchestrators OFF) seeded with the prompt via userMessage. The window / global hotkey / clip-path spill /
// fill handoff are runtime-only (an Electron BrowserWindow covering the notch, sandwich.setFullScreen) and OUT OF
// SCOPE here; the user verifies the island appearing + the seamless #e9e9e7 handoff. This test covers the data path
// under that UI, plus a structural audit of the electron-bound wiring that can't execute in a node sandbox (the
// handler guards, the index.ts → spawn seam, the fill seam, the preload bridge, the globalShortcut). Run with
// `node scripts/test-island-window.mjs`.
//
// WHY the handler is REPRODUCED, not imported: island.ts is Electron-main TypeScript — it imports `electron`
// (BrowserWindow/ipcMain/screen) at module top, so it cannot be loaded by `node` (no electron runtime, no TS
// loader). So Part A wires the island's EXACT production chain out of its REAL pieces — a stand-in wsHost whose
// addAgent stamps `orchestrators` onto meta.json byte-for-byte as workspace-host.mjs does (via the SAME
// terminal-manager serializer the three-serializer rule governs) + an appendChat that records the seeded prompt as
// osUserMessage(osActions.ts:832) does — then runs the handler's literal body (island.ts registerIsland) over the
// index.ts wireIsland({ send }) seam body (Deep ON startWorkflow / Deep OFF spawnAgent+userMessage). Part B then
// reads island.ts / index.ts / preload off disk and asserts the load-bearing lines are present, so a future edit
// that breaks the contract fails here even though the window itself never runs.
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
// Part A — the Send IPC handler maps {prompt, deep} to a REAL spawn (the data path under the island).
// ===========================================================================================================
console.log('Island Send handler → real spawn (src/main/island.ts):')

// One temp `.blitzos/terminals` dir; the stand-in wsHost writes each agent's meta.json under it (mkdir handled
// by the real writeTerminalMeta serializer).
const terminalsDir = mkdtempSync(join(tmpdir(), 'aos-island-'))

// A faithful stand-in for the production workspace host. newAgentId + addAgent mirror workspace-host.mjs
// (newAgentId = max numeric id + 1; addAgent stamps `orchestrators:true` onto meta.json ONLY when asked — the
// SAME write that makes a workflow agent's first bootstrap carry the orchestrator duty). appendChat mirrors
// osActions osUserMessage's wsHost.appendChat('user', text, id): it records the seeded prompt per agent. We
// record every spawned id so we can prove each Send lands on a DISTINCT, NEW agent (no clobber).
const spawned = []
const chatById = {}
const wsHost = {
  newAgentId() {
    let max = 0
    for (const e of spawned) { const n = Number(e.id); if (Number.isInteger(n) && n > max) max = n }
    return String(max + 1)
  },
  addAgent(id, title, opts = {}) {
    writeTerminalMeta(terminalsDir, id, {
      id, kind: 'agent', title: title || `Chat ${id}`, stage: 0, createdAt: Date.now(),
      ...(opts.orchestrators ? { orchestrators: true } : {})
    })
    return { id, title: title || `Chat ${id}`, focus: !!opts.focus }
  },
  appendChat(role, text, agentId = '0') {
    (chatById[String(agentId)] ||= []).push({ role, text })
  }
}

// osSpawnAgent (osActions.ts:917) core — reproduced: newAgentId + addAgent(id, title, {focus, orchestrators}).
// osSpawnAgent(title?, focus=false, orchestrators=false): the 3rd arg is true ONLY for a workflow spawn.
function osSpawnAgentCore(title, focus = false, orchestrators = false) {
  const id = wsHost.newAgentId()
  const opts = { focus }
  if (orchestrators) opts.orchestrators = true
  wsHost.addAgent(id, title, opts)
  const agent = { id, title: title || `Chat ${id}` }
  spawned.push(agent)
  return agent
}
// osUserMessage (osActions.ts:832) core — reproduced: appendChat('user', text, id) when text is non-empty.
function osUserMessageCore(text, agentId = '0') {
  if (!String(text).trim()) return
  wsHost.appendChat('user', text, String(agentId))
}

// electronOps.startWorkflow (electron-os-tools.ts:84-90) — reproduced from its REAL chain: osSpawnAgent core
// (orchestrators ON) + the contextRefs footer + osUserMessage core seeding the task. Deep ON routes here.
const startWorkflowOp = (spec) => {
  const agent = osSpawnAgentCore(spec.title, false, true)
  const refs = Array.isArray(spec.contextRefs) && spec.contextRefs.length
    ? `\n\nContext (dropped onto the launcher):\n${spec.contextRefs.map((r) => `- ${r}`).join('\n')}` : ''
  osUserMessageCore(`${spec.task || ''}${refs}`, agent.id)
  return { ok: true, agent }
}

// The index.ts wireIsland({ send }) seam body (Deep ON startWorkflow / Deep OFF spawnAgent+userMessage),
// parameterised on the spawn ops. Reproduced literally so the handler runs the real chain.
const sendSeam = ({ prompt, deep }) => {
  try {
    if (deep) {
      const r = startWorkflowOp({ task: prompt, contextRefs: [], title: undefined })
      return r && r.ok !== false ? { ok: true, id: r.agent?.id ?? null } : { ok: false, error: r?.error || 'startWorkflow failed' }
    }
    const a = osSpawnAgentCore(undefined) // PLAIN agent (orchestrators OFF)
    try { osUserMessageCore(prompt, a.id) } catch { /* boots with its duty */ }
    return { ok: true, id: a.id }
  } catch (e) {
    return { ok: false, error: e?.message || 'send threw' }
  }
}

// ---- The island's Send IPC handler, LITERAL body (island.ts registerIsland), parameterised on sendFn. -------
// This is exactly what ipcMain.handle('os:island-send', ...) runs; we exercise it directly (ipcMain is electron-only).
function makeHandler(sendFn) {
  return (payload) => {
    const obj = (payload && typeof payload === 'object') ? payload : { prompt: payload }
    const prompt = String(obj?.prompt ?? '').trim()
    if (!prompt) return { ok: false, error: 'empty prompt' }
    if (!sendFn) return { ok: false, error: 'island not wired (no workspace host yet)' }
    try {
      const r = sendFn({ prompt, deep: !!obj?.deep })
      return r && r.ok !== false ? { ok: true, id: r.id ?? null } : { ok: false, error: r?.error || 'send failed' }
    } catch (e) {
      return { ok: false, error: e?.message || 'send threw' }
    }
  }
}

const handler = makeHandler(sendSeam)

// (A1) Deep ON → ok:true, a NEW orchestrator agent on disk, prompt seeded as its first user message.
{
  const PROMPT = '  organize my downloads folder and email me a summary  ' // padded: the handler must trim
  const res = handler({ prompt: PROMPT, deep: true })
  ok('Send(deep:true) → { ok:true } with a spawned id', res.ok === true && typeof res.id === 'string' && res.id.length > 0, res)

  const meta = readTerminalMeta(terminalsDir, res.id)
  ok('Deep ON spawns an ORCHESTRATOR agent (meta.orchestrators:true, kind:agent intact)',
    !!meta && meta.orchestrators === true && meta.kind === 'agent', meta)
  ok('the meta.json was actually written to disk', existsSync(join(terminalsDir, res.id, 'meta.json')))

  const chat = chatById[res.id] || []
  ok('the typed prompt is SEEDED as the agent\'s first user message (trimmed, verbatim)',
    chat.length === 1 && chat[0].role === 'user' && chat[0].text === PROMPT.trim(), chat)
}

// (A2) Deep OFF → ok:true, a NEW PLAIN agent (orchestrators falsy), prompt seeded via userMessage.
{
  const PROMPT = 'what is on my calendar today'
  const res = handler({ prompt: PROMPT, deep: false })
  ok('Send(deep:false) → { ok:true } with a spawned id', res.ok === true && typeof res.id === 'string' && res.id.length > 0, res)

  const meta = readTerminalMeta(terminalsDir, res.id)
  ok('Deep OFF spawns a PLAIN agent (meta.orchestrators is falsy, kind:agent intact)',
    !!meta && !meta.orchestrators && meta.kind === 'agent', meta)

  const chat = chatById[res.id] || []
  ok('Deep OFF seeds the prompt as the agent\'s first user message (userMessage path)',
    chat.length === 1 && chat[0].role === 'user' && chat[0].text === PROMPT, chat)
}

// (A3) Two sends → two DISTINCT agent ids (a Send never reuses/clobbers an existing agent).
{
  const before = spawned.length
  const r1 = handler({ prompt: 'first task', deep: true })
  const r2 = handler({ prompt: 'second task', deep: false })
  ok('two sends spawn two DISTINCT new agents (no clobber)',
    r1.ok === true && r2.ok === true && r1.id !== r2.id && spawned.length === before + 2, { r1: r1.id, r2: r2.id })
  ok('the first (deep) is an orchestrator, the second (shallow) is plain',
    readTerminalMeta(terminalsDir, r1.id)?.orchestrators === true && !readTerminalMeta(terminalsDir, r2.id)?.orchestrators,
    { r1: readTerminalMeta(terminalsDir, r1.id), r2: readTerminalMeta(terminalsDir, r2.id) })
}

// (A4) Empty / whitespace / null / undefined prompt → a clean error, NO spawn (the panel disables Send on empty,
// but the handler must not trust the renderer).
{
  const countBefore = spawned.length
  const r1 = handler({ prompt: '', deep: false })
  const r2 = handler({ prompt: '   ', deep: true })
  const r3 = handler({ prompt: null, deep: false })
  const r4 = handler({ prompt: undefined, deep: true })
  ok('empty/whitespace/null/undefined prompt → { ok:false, error:"empty prompt" }, no spawn',
    r1.ok === false && r1.error === 'empty prompt' && r2.ok === false && r3.ok === false && r4.ok === false && spawned.length === countBefore,
    { r1, r2, r3, r4, spawnedDelta: spawned.length - countBefore })
}

// (A5) Not-yet-wired (no workspace host) → the documented guard, no throw, no spawn.
{
  const countBefore = spawned.length
  const unwired = makeHandler(null) // sendFn === null (before wireIsland / before a workspace exists)
  const r = unwired({ prompt: 'do the thing', deep: false })
  ok('Send before wiring → { ok:false, error:"island not wired..." } (no crash, no spawn)',
    r.ok === false && /not wired/.test(r.error || '') && spawned.length === countBefore, r)
}

// (A6) A failing / throwing seam → the error is surfaced, no crash (production: osSpawnAgent throws 'no workspace
// host' before a host exists — the try/catch path).
{
  const failing = makeHandler(() => ({ ok: false, error: 'no workspace host' }))
  const r = failing({ prompt: 'whatever', deep: true })
  ok('a failing seam → { ok:false } surfaced', r.ok === false && r.error === 'no workspace host', r)
  const thrower = makeHandler(() => { throw new Error('no workspace host') })
  const rt = thrower({ prompt: 'x', deep: false })
  ok('a throwing seam is caught → { ok:false, error:<message> }', rt.ok === false && rt.error === 'no workspace host', rt)
}

rmSync(terminalsDir, { recursive: true, force: true })

// ===========================================================================================================
// Part B — structural audit of the electron-bound wiring (the parts that can't execute under node):
//   the island window config (the PoC-proven covering-window flags), the Send/fill/interactive IPC + its guards,
//   the index.ts → spawn + fill seams + the ⌥Space globalShortcut, the preload bridge. Read the ACTUAL source off
//   disk and assert the load-bearing lines are present, so a regression in the real file is caught here.
// ===========================================================================================================
console.log('\nIsland electron wiring (structural — source audit of the runtime-only parts):')

const islandSrc = readFileSync(join(repoRoot, 'src/main/island.ts'), 'utf8')
const indexSrc = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
const preloadSrc = readFileSync(join(repoRoot, 'src/preload/index.ts'), 'utf8')

// -- the PoC-proven covering-window config (covers the notch, all-Spaces, click-through, never steals focus) ----
ok("island window floats above the menu bar (setAlwaysOnTop(true, 'screen-saver'))",
  /setAlwaysOnTop\(true,\s*'screen-saver'\)/.test(islandSrc))
ok('island window rides every Space incl. fullscreen (setVisibleOnAllWorkspaces visibleOnFullScreen:true)',
  /setVisibleOnAllWorkspaces\(true,\s*\{\s*visibleOnFullScreen:\s*true\s*\}\)/.test(islandSrc))
ok('island window may cover the full display incl. the menu-bar band (enableLargerThanScreen:true)',
  /enableLargerThanScreen:\s*true/.test(islandSrc))
ok('island window is transparent (NOT the launcher vibrancy panel — must show the canvas/desktop through)',
  /transparent:\s*true/.test(islandSrc) && /hasShadow:\s*false/.test(islandSrc) && !/vibrancy:/.test(islandSrc))
ok('island window starts CLICK-THROUGH (setIgnoreMouseEvents(true,{forward:true}))',
  /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/.test(islandSrc))
ok('island window is shown WITHOUT stealing focus (showInactive, never show()+focus())',
  /showInactive\(/.test(islandSrc) && !/\.focus\(\)/.test(islandSrc))
ok('the grow/fill plate is the BlitzOS canvas color #e9e9e7 (seamless handoff — tokens --canvas / sandwich UI_BG)',
  /#e9e9e7/.test(islandSrc))
ok('island bounds are re-asserted after show + at ~700ms (defeat the workArea y-clamp so the pill lands on the notch)',
  /setTimeout\([\s\S]*?setBounds\(\{\s*x:\s*b\.x/.test(islandSrc))

// -- the IPC surface (the contract Part A ran + the runtime-only fill/interactive) ----------------------------
ok("the Send IPC channel is 'os:island-send' (invoke)", /ipcMain\.handle\(\s*'os:island-send'/.test(islandSrc))
ok('the handler trims the prompt and guards empty', /String\(payload\?\.prompt[^)]*\)\.trim\(\)/.test(islandSrc) && /if\s*\(!prompt\)\s*return\s*\{\s*ok:\s*false/.test(islandSrc))
ok('the handler guards the not-wired case (no sendFn)', /if\s*\(!sendFn\)\s*return\s*\{\s*ok:\s*false/.test(islandSrc))
ok("the click-through toggle IPC is 'os:island-interactive' → setIgnoreMouseEvents",
  /ipcMain\.on\(\s*'os:island-interactive'/.test(islandSrc) && /setIgnoreMouseEvents\(!on,\s*\{\s*forward:\s*true\s*\}\)/.test(islandSrc))
ok("the fill/suck IPC is 'os:island-fill' → the injected fillFn", /ipcMain\.on\(\s*'os:island-fill'/.test(islandSrc) && /fillFn\?\.\(/.test(islandSrc))
ok('island.ts exports wireIsland / registerIsland / toggleIsland',
  /export function wireIsland\(/.test(islandSrc) && /export function registerIsland\(/.test(islandSrc) && /export function toggleIsland\(/.test(islandSrc))
ok('island.ts pushes geometry on the island:geometry channel', /webContents\.send\(\s*'island:geometry'/.test(islandSrc))

// -- the renderer-side spill + click-through region logic (the PoC behaviour + the KEY correction) ------------
ok('the renderer grows the clip-path to fullscreen and calls fill(true); shrink reverses with fill(false)',
  /agentOS\.island\.fill\(true\)/.test(islandSrc) && /agentOS\.island\.fill\(false\)/.test(islandSrc))
ok('the click-through region is collapsed=notch∪panel, spilled=notch-pill-ONLY (passthrough to the real canvas)',
  /if\(open\)\{[^}]*setI\(overNotch\);\s*return;/.test(islandSrc))
ok('the Blitz entry has a multiline prompt, a Deep toggle, and a Send (Enter sends, Shift+Enter = newline)',
  /<textarea id="pq"/.test(islandSrc) && /id="deep"/.test(islandSrc) && /id="send"/.test(islandSrc) &&
    /e\.key==='Enter'&&!e\.shiftKey/.test(islandSrc))
ok('Send routes through agentOS.island.send(prompt, deepOn)', /agentOS\.island\.send\(prompt,\s*deepOn\)/.test(islandSrc))

// -- island.ts is INDEPENDENT of the legacy native island bridge (distinct module, no import) -----------------
{
  const importLines = islandSrc.split('\n').filter((l) => /^\s*import\b|\bfrom\s+['"]/.test(l) && !/^\s*\/\//.test(l))
  const touchesLegacy = importLines.some((l) => /island-bridge|island-membership|osActions|electron-os-tools|sandwich/.test(l))
  ok('island.ts does NOT import island-bridge / island-membership / osActions / electron-os-tools / sandwich (DI seam)',
    !touchesLegacy, importLines.filter((l) => /island|osActions|electron-os-tools|sandwich/.test(l)))
}

// -- index.ts wires the island: import, the spawn seam (Deep ON/OFF), the fill seam, registerIsland, ⌥Space -----
ok("index.ts imports the island module (wireIsland/registerIsland/toggleIsland/pushIslandFullscreen from './island')",
  /import\s*\{[^}]*\bwireIsland\b[^}]*\bregisterIsland\b[^}]*\btoggleIsland\b[^}]*\}\s*from\s*'\.\/island'/.test(indexSrc) &&
    /\bpushIslandFullscreen\b/.test(indexSrc))
ok('index.ts adds globalShortcut to the electron import (line 1)',
  /import\s*\{[^}]*\bglobalShortcut\b[^}]*\}\s*from\s*'electron'/.test(indexSrc))
ok('index.ts calls wireIsland({ ... }) and registerIsland()', /wireIsland\(\{/.test(indexSrc) && /registerIsland\(\)/.test(indexSrc))
ok('the index.ts send seam routes Deep ON → electronOps.startWorkflow',
  /if\s*\(deep\)\s*\{[\s\S]*?electronOps\.startWorkflow/.test(indexSrc))
ok('the index.ts send seam routes Deep OFF → electronOps.spawnAgent + electronOps.userMessage',
  /electronOps\.spawnAgent/.test(indexSrc) && /electronOps\.userMessage/.test(indexSrc))
ok('the index.ts fill seam enters fullscreen + raises mainWindow (on=true) and restores on suck (on=false)',
  /s\.setFullScreen\(true\)/.test(indexSrc) && /s\.setFullScreen\(false\)/.test(indexSrc) && /wireIsland\(\{[\s\S]*?mainWindow[\s\S]*?\}\)/.test(indexSrc))
// The island only EXITS the fullscreen IT entered (finding 9): fill(true) captures whether the user was already
// fullscreen; fill(false) exits only when islandEnteredFullscreen — never yanks the user out of a green-light /
// Ctrl+Cmd+F fullscreen.
ok('the fill seam captures pre-spill fullscreen + only exits what the island entered (no clobber of user fullscreen)',
  /islandEnteredFullscreen\s*=\s*!s\.pages\.isFullScreen\(\)/.test(indexSrc) &&
    /if\s*\(islandEnteredFullscreen[\s\S]*?s\.setFullScreen\(false\)/.test(indexSrc))
// The island FOLLOWS the sandwich's real fullscreen (finding 6): index.ts forwards pages enter/leave-full-screen
// on island:fullscreen so an external exit collapses the spilled plate; island.ts reconciles + clears its flag.
ok('index.ts forwards the sandwich pages fullscreen to the island (pushIslandFullscreen on enter/leave-full-screen)',
  /sandwich\.pages\.on\(\s*'enter-full-screen'[\s\S]*?pushIslandFullscreen\(true\)/.test(indexSrc) &&
    /sandwich\.pages\.on\(\s*'leave-full-screen'[\s\S]*?pushIslandFullscreen\(false\)/.test(indexSrc))
ok('island.ts exports pushIslandFullscreen → island:fullscreen channel, and follows it in the renderer',
  /export function pushIslandFullscreen\(/.test(islandSrc) && /webContents\.send\(\s*'island:fullscreen'/.test(islandSrc) &&
    /agentOS\.island\.onFullscreen\(/.test(islandSrc))
// Hiding while spilled sucks back FIRST (findings 4): hideIsland fires island:hide → the renderer runs shrink →
// fill(false) before the window hides, so the sandwich never strands in fullscreen with the pill gone.
ok('hideIsland sucks back before hiding (island:hide → renderer shrink), the renderer wires onHide',
  /webContents\.send\(\s*'island:hide'/.test(islandSrc) && /agentOS\.island\.onHide\(/.test(islandSrc))
// The spilled plate REVEALS the live canvas (finding 7): it is canvas-colored during the morph, then transparent
// once spilled (body.spilled #home { background:transparent }) so the real BlitzOS desktop shows through — not a
// flat opaque plate.
ok('the spilled plate goes TRANSPARENT after the grow (body.spilled #home transparent — reveals the live canvas)',
  /#e9e9e7|var\(--canvas\)/.test(islandSrc) && /body\.spilled\s+#home\s*\{\s*background:transparent/.test(islandSrc) &&
    /transitionend/.test(islandSrc))
// Arrow-key live-tuning is DEV-ONLY and never hijacks the textarea cursor (finding 3): gated on ?tune=1 AND it
// returns early when an editable element (the prompt) is focused.
ok('the live-tuning arrow handler is dev-gated (?tune=1) and bails when an editable is focused (no cursor hijack)',
  /if\(!TUNE\)\s*return/.test(islandSrc) && /activeElement[\s\S]*?(isContentEditable|TEXTAREA)/.test(islandSrc))

ok("index.ts registers ⌥Space (globalShortcut.register('Alt+Space', ...) → toggleIsland) ONLY when the native island is off",
  /if\s*\(!useNativeIsland\)\s*\{[\s\S]*?globalShortcut\.register\(\s*'Alt\+Space'[\s\S]*?toggleIsland\(\)/.test(indexSrc))
ok('index.ts handles a failed register (logs, never throws)', /could not register ⌥Space/.test(indexSrc))
ok('index.ts unregisters ⌥Space in before-quit', /globalShortcut\.unregister\(\s*'Alt\+Space'\s*\)/.test(indexSrc))
// ONE Carbon owner of ⌥Space (findings 1/5/8/10): the legacy native BlitzIsland.app is launched ONLY under
// BLITZ_NATIVE_ISLAND (useNativeIsland) — never alongside the Electron island that registered the chord above.
ok('the legacy native BlitzIsland.app is launched ONLY when useNativeIsland (no double ⌥Space Carbon owner)',
  /const useNativeIsland\s*=\s*process\.platform === 'darwin' && process\.env\.BLITZ_NATIVE_ISLAND === '1'/.test(indexSrc) &&
    /if\s*\(useNativeIsland\)\s*\{[\s\S]*?launchIslandHelper/.test(indexSrc))
// Guard the inverse: launchIslandHelper must NOT be called unconditionally at top level of whenReady anymore
// (the original double-fire bug). The only call site is inside the useNativeIsland branch.
{
  const helperCalls = (indexSrc.match(/islandHelper\s*=\s*launchIslandHelper\(/g) || []).length
  const guarded = /if\s*\(useNativeIsland\)\s*\{[\s\S]*?islandHelper\s*=\s*launchIslandHelper\([\s\S]*?\n\s*\}/.test(indexSrc)
  ok('launchIslandHelper has a single, gated call site (not unconditional)', helperCalls === 1 && guarded, { helperCalls, guarded })
}

// -- the preload bridge is namespaced under agentOS.island (isolated; the renderer never uses it) -------------
ok('preload exposes the island bridge (agentOS.island.send → os:island-send)',
  /island:\s*\{[\s\S]*?ipcRenderer\.invoke\(\s*'os:island-send'/.test(preloadSrc))
ok('preload exposes island.setInteractive → os:island-interactive', /ipcRenderer\.send\(\s*'os:island-interactive'/.test(preloadSrc))
ok('preload exposes island.fill → os:island-fill', /ipcRenderer\.send\(\s*'os:island-fill'/.test(preloadSrc))
ok('preload exposes island.onGeometry ← island:geometry', /ipcRenderer\.on\(\s*'island:geometry'/.test(preloadSrc))
ok('preload exposes island.onFullscreen ← island:fullscreen (the follower channel)', /ipcRenderer\.on\(\s*'island:fullscreen'/.test(preloadSrc))
ok('preload exposes island.onHide ← island:hide (suck-back before hide)', /ipcRenderer\.on\(\s*'island:hide'/.test(preloadSrc))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
