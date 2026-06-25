export const meta = {
  name: 'build-job-launcher',
  description: 'Build the standalone macOS-helper job launcher (global Raycast-style bar): NSPanel + global hotkey + Send -> start_job',
  phases: [
    { title: 'Implement', detail: 'NSPanel launcher window + globalShortcut + minimal UI + Send -> start_job (isolated from App.tsx)' },
    { title: 'Test', detail: 'headless-test the Send->start_job wiring + typecheck + build' },
    { title: 'Verify', detail: 'adversarial: Send mints a REAL job, shortcut lifecycle, no WIP touch' },
  ],
}
const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'
const COMMON = `Repo: ${ROOT}, branch blitzos-journey-build. The Job model + start_job tool are merged (electronOps.startJob({goal}) -> mints a job whose planning agent authors the W1 plan widget). READ the actual code first. NO hacks; precise TODO over fakery. CRITICAL: do NOT touch the user's uncommitted WIP — src/renderer/src/App.tsx, store.ts, components/PrimarySpace.tsx, styles.css (their single-canvas-navigation work). The launcher MUST be isolated (its own window + self-contained UI), NOT wired into App.tsx. Cite file:line.`

phase('Implement')
log('Building the standalone job launcher: NSPanel + global hotkey + Send -> start_job')
const IMPL_SCHEMA = { type: 'object', additionalProperties: false, required: ['filesChanged','newFiles','typecheckPass','buildPass','keybind','todos','summary'], properties: {
  filesChanged: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path','what'], properties: { path: { type: 'string' }, what: { type: 'string' } } } },
  newFiles: { type: 'array', items: { type: 'string' } }, typecheckPass: { type: 'boolean' }, buildPass: { type: 'boolean' }, keybind: { type: 'string' }, todos: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } }

const impl = await agent(`${COMMON}

Build the STANDALONE macOS-helper JOB LAUNCHER — the global "Raycast bar" (Shell A of plans/blitzos-job-entrypoints.md): a global hotkey opens a small always-on-top bar; the user types a prompt; Send -> start_job (which mints a job whose planning agent authors the editable plan widget). v1 is JUST prompt + Send; drag-drop files (A2) and add-browser-tab (A3) are LATER (precise TODOs).

READ: src/main/onboarding.ts (the dragHelper NSPanel recipe ~:230-264 — new BrowserWindow{type:'panel',frame:false,transparent:true,focusable:false,skipTaskbar:true,hasShadow:false,preload}, setAlwaysOnTop(true,'floating'), setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}), showInactive() — CLONE this construction), src/main/index.ts (app.whenReady block where windows are created + where to register the global hotkey + the existing os:agent-spawn / start_job IPC wiring; how the launcher Send reaches electronOps.startJob), src/main/electron-os-tools.ts (electronOps.startJob signature), src/main/osActions.ts (osSpawnAgent / the start_job path), src/preload/index.ts (the contextBridge pattern — add a tiny launcher bridge), electron.vite.config.ts (renderer-entry layout — but PREFER a self-contained inline HTML over adding a new vite entry, to avoid build-config churn). Check whether electron globalShortcut is used anywhere (it is NOT today — this is the first one).

IMPLEMENT (ISOLATED — no App.tsx/store.ts/PrimarySpace.tsx/styles.css):
1. NEW src/main/launcher.ts: createLauncherWindow() that builds the NSPanel exactly like the dragHelper (frameless, transparent, non-activating, always-on-top, all-Spaces, showInactive — but focusable:true so the user can TYPE, unlike the drag helper). Load a SELF-CONTAINED minimal launcher UI: a small inline HTML string (loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html)) or a tiny dedicated .html file loaded via loadFile) with ONE text input + a Send affordance (Enter submits, Esc hides), styled minimally (a centered rounded bar). It uses a preload bridge to post the typed text to main and to close/hide. Register a GLOBAL hotkey via electron globalShortcut (DEFAULT 'Alt+Space' = ⌥Space, overridable by env BLITZ_LAUNCHER_HOTKEY) that TOGGLES the launcher (show+focus / hide); unregister on app quit ('will-quit' globalShortcut.unregisterAll or the specific accelerator). The window starts hidden.
2. WIRE Send: a new IPC (e.g. ipcMain.handle('launcher:start-job', (e, prompt) => electronOps.startJob({ goal: String(prompt||'') }))) in index.ts (import electronOps or call the same start_job path the relay uses). On success, hide the launcher and (best-effort) focus/raise the main BlitzOS window so the user sees the new job agent. Return the agent id.
3. NEW (or extend) the launcher preload: a minimal contextBridge — window.launcher.startJob(prompt) -> ipcRenderer.invoke('launcher:start-job', prompt), window.launcher.hide(). If a separate preload is needed for the launcher window, add a tiny one; otherwise reuse src/preload with a guarded addition (do NOT break the main preload).
4. In index.ts app.whenReady: createLauncherWindow() + register the global hotkey. Clean up on quit.

Run \`npm run typecheck\` AND \`npm run build\` (the main + preload must compile; this is Electron main, headless-buildable). Report the keybind, filesChanged, newFiles, typecheckPass, buildPass, and TODOs. Be explicit: the Send->start_job wiring is headless-testable; the WINDOW actually showing on the hotkey + its look is RUNTIME/visual (the user's test) — do NOT fake an end-to-end.`, { label: 'implement', phase: 'Implement', schema: IMPL_SCHEMA })

phase('Test')
log('Headless test: Send -> start_job wiring + typecheck + build')
const TEST_SCHEMA = { type: 'object', additionalProperties: false, required: ['testFile','ran','pass','typecheckPass','buildPass','output'], properties: { testFile: { type: 'string' }, ran: { type: 'boolean' }, pass: { type: 'boolean' }, typecheckPass: { type: 'boolean' }, buildPass: { type: 'boolean' }, output: { type: 'string' }, notes: { type: 'string' } } }
const test = await agent(`${COMMON}

The job launcher was just implemented (src/main/launcher.ts + an index.ts IPC + a preload bridge + a global hotkey). Implementer: ${JSON.stringify(impl?.summary||'').slice(0,700)}

Test what is HEADLESS-testable (the window/hotkey/visual is runtime — out of scope):
- The Send IPC handler maps a prompt to a REAL start_job call: drive the same op the IPC calls (electronOps.startJob or the launcher handler's target) with a temp workspace/wsHost (reuse the setup from scripts/test-job-model.mjs — wireJobModel etc.) and assert it mints a job (status 'proposed') on a new agent with the prompt as the goal. If electronOps.startJob can't be unit-driven (IPC-bound osActions), test the closest seam (osSpawnAgent+createJob/makeJob) OR assert the handler calls startJob with the right args via a small structural check. Do NOT write a trivially-passing test.
- npm run typecheck (exit 0) and npm run build (exit 0) — the launcher window + globalShortcut + preload must COMPILE.
- Confirm globalShortcut is registered with the default Alt+Space accelerator and unregistered on quit (grep/structural).
Return ACTUAL output + honest pass/fail + the keybind. Note clearly: the window appearing on the hotkey is the user's visual test.`, { label: 'test', phase: 'Test', schema: TEST_SCHEMA })

phase('Verify')
log('Adversarial review of the launcher')
const VERIFY_SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict','issues','breaksExisting','hacksFound','keybind'], properties: { verdict: { type: 'string', enum: ['clean','needs-fixes','broken'] }, breaksExisting: { type: 'boolean' }, hacksFound: { type: 'boolean' }, keybind: { type: 'string' }, issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity','file','problem','fix'], properties: { severity: { type: 'string', enum: ['blocker','major','minor'] }, file: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } } }
const verify = await agent(`${COMMON}

ADVERSARIALLY review the job launcher on this branch. Run \`git diff c74787f\` + \`git status\`, read the changes, run \`npm run typecheck\` + \`npm run build\`. Check:
1. Does Send ACTUALLY call start_job (mint a real job), or is it a stub / a TODO masquerading as done? Trace launcher input -> IPC -> electronOps.startJob -> a real job. A no-op Send is a blocker.
2. globalShortcut: registered with a real accelerator (default Alt+Space)? Unregistered on quit (no leaked global hotkey after the app closes)? Does it conflict with an existing app keybind?
3. NSPanel: focusable enough to TYPE (the dragHelper is focusable:false for drag — the launcher needs to accept text), non-activating toggle correct, starts hidden, hides on Send/Esc?
4. ISOLATION: did it touch App.tsx/store.ts/PrimarySpace.tsx/styles.css (the user WIP)? It MUST NOT. Is the launcher UI self-contained (not wired into the main canvas renderer)?
5. The sandwich/parented-window model: BlitzOS runs as a parented L0/L1 pair (plans/blitzos-sandwich-compositor.md) — does a new top-level always-on-top window interfere with that pair, or is it independent + safe? Flag any focus/parenting risk.
6. typecheck/build pass? Report concrete issues (severity+file+problem+fix), the keybind, and a verdict. Distinguish a real DEFECT from "the window rendering is the user's visual test" (expected scope).`, { label: 'verify', phase: 'Verify', schema: VERIFY_SCHEMA })

return { impl, test, verify }