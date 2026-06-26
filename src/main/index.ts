import { app, BrowserWindow, protocol, ipcMain, crashReporter, Menu, globalShortcut, screen, nativeImage, shell, webFrameMain } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { execFile, execFileSync } from 'node:child_process'
import { startControlServer } from './control-server'
import { initOsActions, osCreateSurface, osReadThumb, osReadWorkspaceFile, osFlushWorkspace, osGroupIntoFolder, osIngestPaths, osNewFolder, osRenameFolder, osMoveIntoFolder, osMoveOutOfFolder, osOpenFolderEntry, osListDir, osCloseSurfaceFile, osWorkspaceContext, osWorkspacesRoot, osSay, osSurfaceIdForWebContents, osActiveWorkspaceDir, setLaunchAgent, setPauseAgent, setRestartAgent, setStopAgent, setClearBrainContext, osResumeAgentsOnBoot, osSetRelayUrl, osSpawnAgent, osCloseAgent, osArchiveAgent, osUnarchiveAgent, osRenameAgent, osSetOrchestrators, osKickBrain, setOnUserMessage, setActionItemsProvider, setTerminalStatusProvider, osRadialPhase, osGetState, osAgentStatus, osDebugSetChatStatus, osSurfaceChatError, osAgentsSnapshot, osAgentDetails, osAgentClaudeSid, setMilestonesProvider, osBroadcast, osReadLeaf, osWfRunMemDir, osLoadAgentRuns, osNoteTabViewed, osWfHydrateIfCold, osSweepWfMemory } from './osActions'
import { emitSystemMoment, emitWorkflowMoment, setMomentTap, setUndeliveredWakeHook, lastPollAt } from './events'
import { createWakeWatchdog } from './agent-wake-watchdog.mjs'
import { openBootJournal, chatFileName } from './workspace.mjs'
import type { BootJournal } from './workspace.mjs'
import { installGuestSessionPolicy, resolvePermissionPrompt, attachGuestWindowPolicy } from './guest-capabilities'
import { startAgentSocket, getAgentSocketUrl } from './agentSocket'
import { electronTerminalOps, electronActionItems, electronOps, electronConnections, setTerminalGetUrl, setTerminalAgentRuntime } from './electron-os-tools'
import { makeWindowLink } from './connection-window-link'
import { permissionFromError, grantForConnection, grantForBrowserState } from './connection-grants.mjs'
import { makeAttachmentStore } from './attachment-store.mjs'
import { makeSafariLink } from './connection-safari-link.mjs'
import { makeChromeAppleScriptLink } from './connection-chrome-applescript-link.mjs'
import { resolveFavicon } from './favicon-resolver.mjs'
import { blitzChrome } from './blitz-chrome'
import { wireLauncher, registerLauncher } from './launcher'
import { wireWorkflowHost, subscribe as wfSubscribe, snapshot as wfSnapshot } from './workflow-host.mjs'
import { wireEnrichment, spawnWorkflowEnrichment } from './workflow-enrichment.mjs'
// The standalone island.ts window is RETIRED — the notch is now the real UI window itself (sandwich overlay mode);
// the notch IPC is wired inline below. (island.ts stays on disk but is no longer imported.)
import { AGENT_RUNTIME_CLAUDE, AGENT_RUNTIME_CODEX_SERVERLESS, DEFAULT_AGENT_RUNTIME, normalizeAgentRuntime, prepareAgentLaunch, setBootTaskProvider, setUserInstructionsProvider, orchestratorBootTask } from './agent-runtime.mjs'
import { startNarrator } from './agent-narrator.mjs'
import { readTerminalMeta } from './terminal-manager.mjs'
import { wasInterrupted } from './agent-interrupt.mjs'
import type { ActionStatus } from './action-items.mjs'
import { initCdp } from './cdp'
import { registerWidgets } from './widgets'
// Keep web surfaces logged in across quit/relaunch (cookie/localStorage flush + unload).
import { startSessionPersistence } from './persistence'
import { initTelemetry } from './telemetry'
import { flushActivityLogging, initActivityLogging, trackActivity, trackToolActivity } from './activity-logging.mjs'
import { makeSessionTape } from './session-tape.mjs'
import { setToolTap } from './os-tools.mjs'
import { registerOnboarding, interviewBootTask, claudeCliPath, codexCliPath, setInterviewAgentAvailable } from './onboarding'
import { initUpdater, openBuildPicker, isDevMachine } from './update'
import { resolveTmuxBin } from './tmux-host.mjs'
import { computerUseHelper } from './computer-use-helper'
import { launchIslandHelper, setIslandDeps } from './island-bridge.mjs'
import type { IslandHelperHandle } from './island-bridge.mjs'
// The island isolation boundary (the ONE shared membership core, pure-node so a node test imports the REAL
// filter): only ids the island itself spawned (recordIslandId) are ever listed/tailed (islandLiveIds), so the
// HUD never mirrors the user's main canvas chat ('0') or a sibling peer agent. See island-membership.mjs.
import { recordIslandId, islandLiveIds, pruneIslandIds } from './island-membership.mjs'
// The notch (dynamic island) overlay — the notch-essential bits extracted from the retired sandwich compositor
// (web surfaces are now in-DOM <webview>, so the two-window sandwich is gone): the single window is reconfigured
// as a transparent, all-Spaces, full-display island, with a click-through toggle the renderer drives on hover.
import { notchOverlayWindowOptions, configureNotchOverlay, showNotchOverlay, setNotchInteractive, readNotchGeometry, notchHitRect, notchHitWindowOptions, NOTCH_HIT_HTML, type NotchGeometry } from './notch-overlay'

// Harden the log pipes FIRST: if the launching terminal or parent is severed (e.g. a killed duplicate instance),
// the next console write throws `write EIO` on stdout/stderr, which — unhandled — crashes the main process with
// the "A JavaScript error occurred in the main process" dialog. Swallow stream errors so a dead log pipe can't
// crash BlitzOS.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

// HOME is frequently itself a git repo (~/.git for dotfiles). Agents run in ~/Blitz/<workspace>, INSIDE that
// repo, so a tool's startup `git status` (Claude Code does this) resolves the repo root to ~ and walks the
// ENTIRE home dir — ~/Pictures (Photos), ~/Library/Calendars, ~/Library/.../AddressBook, Desktop/Documents/
// Downloads — each one a macOS TCC prompt attributed to BlitzOS (the responsible process). Tell every child
// git to NOT chdir up INTO ~ while searching for a repo: a workspace under ~ becomes "not a repo" (no tree
// walk, no prompts), while git AT ~ or in a real nested repo still works. Set before any terminal/agent spawns.
if (process.platform === 'darwin' && process.env.HOME && !process.env.GIT_CEILING_DIRECTORIES) {
  process.env.GIT_CEILING_DIRECTORIES = process.env.HOME
}

// "Open in Terminal": hand a LIVE terminal off to a real terminal window (macOS Terminal.app) so TUIs
// (claude/codex, full-screen curses) render correctly — the embedded DEBUG pane strips ANSI and garbles them.
// A terminal is a real tmux window, so this is just `tmux attach` in a Terminal window. Every decision below
// was verified against the live tmux 3.5a server:
//   • Target the window by its tmux window-id (@N), NEVER session:name — blitz ids are numeric and a numeric
//     tmux target is read as a window INDEX, so `blitz:0` hits __blitzroot__, not the agent window named '0'.
//   • Attach through a per-id GROUPED session (view-<id>) that shares blitz's windows but keeps its OWN
//     current-window, so opening one (or several) watchers never moves BlitzOS's control client or a manual
//     `tmux attach -t blitz` the user has open.
//   • Interactive + mouse on (view session ONLY): the wheel scrolls. tmux read-only (-r) disables copy-mode
//     and scrolling outright — "only keys bound to detach-client/switch-client have any effect" (man tmux) —
//     so a read-only watch literally cannot scroll. `mouse on` is set on the view session, not blitz, so the
//     agent's session is untouched. Tradeoff: keystrokes now reach the agent's session, so this is a
//     watch-and-optionally-step-in view.
//   • LAUNCH by writing a .command launcher and `open`ing it — opens in whatever app is REGISTERED to handle
//     .command files (Terminal.app by default; the user can remap it in Finder → Get Info → Open with → Change All).
//     NO app is hardcoded by us. The OLD path used AppleScript (`osascript … tell application "Terminal" to do
//     script`), which requires macOS Automation (TCC) permission the app does not hold — so the AppleEvent
//     failed/timed out (-1712), and because the launch was fire-and-forget returning ok:true, the button SILENTLY
//     did nothing. `open` uses LaunchServices, not AppleEvents, so it needs no Automation grant. The launch is now
//     CHECKED (a missing/failed open surfaces a real error to the button instead of a fake success).
//   • Use the SAME bundled tmux the host runs (spec.bin) so client/server protocol versions match.
// KNOWN: a tmux window is shared across clients, so the Terminal client contributes to that window's size
// negotiation (window-size 'latest') — watching can reflow the agent's pane to the Terminal window's size.
// TODO(view-cleanup): the detached view-<id> grouped sessions linger until the workspace tmux server dies;
// reap them on terminal close/remove if they ever accumulate.
const shq = (s: string): string => `'` + String(s).replace(/'/g, `'\\''`) + `'`
type TerminalRecordLike = {
  kind?: string | null
  title?: string | null
  command?: unknown
  status?: string | null
  agentRuntime?: unknown
  agentSessionId?: unknown
}
let reviveAgentBackend: ((id: string, title?: string | null) => void) | null = null
const isRestartableAgentTerminal = (terminal: TerminalRecordLike | null | undefined): boolean =>
  !!terminal && terminal.kind === 'agent' && !!(terminal.command || terminal.agentRuntime || terminal.agentSessionId)
const isRecoverableAgentPane = (id: string): boolean => {
  const terminal = electronTerminalOps.getTerminal(id) as TerminalRecordLike | null
  return electronTerminalOps.isTerminalLive(id) && isRestartableAgentTerminal(terminal)
}
function reviveOrRestartAgentBackend(id: string, terminal?: TerminalRecordLike | null): void {
  const current = terminal || (electronTerminalOps.getTerminal(id) as TerminalRecordLike | null)
  if (isRestartableAgentTerminal(current)) void electronTerminalOps.restartTerminal(id)
  else if (reviveAgentBackend) reviveAgentBackend(id, current?.title || undefined)
  else osKickBrain(id)
}
function openTerminalExternal(id: string): { ok: boolean; error?: string } {
  if (process.platform !== 'darwin') return { ok: false, error: 'Open in Terminal is macOS-only' }
  const terminal = electronTerminalOps.getTerminal(id) as TerminalRecordLike | null
  if (terminal?.kind === 'agent' && terminal.status !== 'stopped' && !isRestartableAgentTerminal(terminal)) {
    reviveOrRestartAgentBackend(id, terminal)
    return { ok: false, error: 'agent terminal is starting; try again in a moment' }
  }
  const spec = electronTerminalOps.attachSpec(id)
  if (!spec) {
    if (terminal?.kind === 'agent' && terminal.status !== 'stopped') {
      reviveOrRestartAgentBackend(id, terminal)
      return { ok: false, error: 'agent terminal is starting; try again in a moment' }
    }
    return { ok: false, error: 'terminal is not a live tmux window' }
  }
  const grp = `view-${id}`
  const t = (...a: string[]): string[] => ['-S', spec.socket, ...a]
  try {
    // Idempotently ensure the per-id grouped session, then point IT (not blitz) at this window by @id.
    let exists = true
    try { execFileSync(spec.bin, t('has-session', '-t', grp), { stdio: 'ignore' }) } catch { exists = false }
    if (!exists) execFileSync(spec.bin, t('new-session', '-d', '-s', grp, '-t', spec.session), { stdio: 'ignore' })
    execFileSync(spec.bin, t('select-window', '-t', `${grp}:${spec.window}`), { stdio: 'ignore' })
    // Mouse on for THIS view session only (idempotent every open) so the wheel scrolls — blitz keeps its own.
    execFileSync(spec.bin, t('set-option', '-t', grp, 'mouse', 'on'), { stdio: 'ignore' })
    // Write a .command launcher next to the tmux socket (always workspace-writable) and `open` it → the user's
    // DEFAULT terminal opens a fresh window running the attach. The script is shell, so paths are shq-quoted.
    const launcher = join(spec.socket, '..', '..', `open-external-${id}.command`)
    try {
      writeFileSync(launcher, `#!/bin/sh\nexec ${shq(spec.bin)} -S ${shq(spec.socket)} attach -t ${shq(grp)}\n`, { mode: 0o755 })
      execFileSync('open', [launcher], { stdio: 'ignore', timeout: 8000 })
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'failed to open terminal' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'failed to open Terminal' }
  }
}

function activityBuildMeta(): { branch: string; run: number; channel: 'production' | 'preview' | 'development' } {
  let branch = process.env.BLITZ_BUILD_BRANCH || ''
  let run = Number(process.env.BLITZ_BUILD_RUN) || 0
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { buildBranch?: string; buildRun?: number }
    if (pkg.buildBranch) branch = String(pkg.buildBranch)
    if (pkg.buildRun) run = Number(pkg.buildRun) || run
  } catch {
    /* dev run / pre-CI build */
  }
  if (!branch) branch = app.isPackaged ? 'unknown' : 'dev'
  const normalized = branch.toLowerCase()
  const channel = !app.isPackaged ? 'development' : (normalized === 'main' || normalized === 'master' || normalized === 'production' ? 'production' : 'preview')
  return { branch, run, channel }
}

// The widget library lives in <appRoot>/widgets; tell the shared catalog where it
// is (main is bundled to out/, so import.meta-relative resolution there is wrong).
process.env.BLITZ_WIDGETS_DIR = process.env.BLITZ_WIDGETS_DIR || join(app.getAppPath(), 'widgets')
// Per-leaf capture for the island kanban drill-in drawer: writes <memDir>/leaves/<nodeId>.json
// (prompt + result + summary + sessionId) for every terminal leaf. Best-effort + guarded + cheap
// (agent.mjs:captureLeaf). Default ON; set BLITZ_CAPTURE_LEAVES=0 (or '' / 'false') to disable. Uses ??, NOT
// ||, so an explicit '0'/'' the operator set is preserved instead of being coerced back to '1'.
process.env.BLITZ_CAPTURE_LEAVES = process.env.BLITZ_CAPTURE_LEAVES ?? '1'

// In dev (`npm run dev`) the running binary is Electron, so the menu-bar app-menu (role:'appMenu'), the
// app name, and the userData dir would read "Electron". Force it to "BlitzOS" — matches the packaged
// build (productName in electron-builder.yml), so dev + packaged share the same menu name AND the same
// userData dir (~/Library/Application Support/BlitzOS). Must run before any getPath('userData')/
// installAppMenu(). Note: switching dev's userData to BlitzOS means existing dev cookies/sessions
// under the old Electron dir are not carried over (re-login once in dev).
app.setName('BlitzOS')

// ONE BlitzOS per machine: a second launch focuses the first instead of fighting it for the browser
// partition + the workspace watchers (observed live: partition LOCK errors, two hosts persisting over
// each other, "Object has been destroyed" 500s). app.exit is immediate — the duplicate runs no
// before-quit handlers, so it can never mark the journal clean or flush state over the owner's.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  const w = mainWindow
  if (!w || w.isDestroyed()) return // a closed-but-not-nulled window would throw "Object has been destroyed"
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
})

// Retain local minidumps for renderer/GPU/browser-process crashes (forensics only, never uploaded).
// PACKAGED ONLY: in `electron-vite dev` the Crashpad handler wedges in a FATAL loop on a renderer/GPU
// crash ("Check failed: kr == KERN_SUCCESS. mach_port_request_notification: invalid capability"), which
// turns a RECOVERABLE renderer crash (Electron would just respawn it) into a dead, frozen UI window. So
// only start it in a packaged build, where the minidumps are actually useful and the wedge does not occur.
if (app.isPackaged) crashReporter.start({ uploadToServer: false })

// GPU memory headroom: a dogfooding desktop accumulates many LIVE web surfaces (the onboarding Chrome
// import alone opens ~30 tabs, plus tool browsers + the agent's research tabs), and the view host keeps
// them all composited (parked offscreen, backgroundThrottling:false). That exhausts the GPU tile-memory
// budget and crashes the GPU + renderer. Raise the reported GPU memory so the tile manager has headroom
// (M-series share unified memory, so this is real). NOT disableHardwareAcceleration — that fails GL
// context creation here (kFatalFailure) and leaves the renderer dead. The real fix — culling offscreen
// tab views so they don't composite — is a view-host TODO; the render-process-gone reload above is the
// safety net until then.
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '6144')
app.commandLine.appendSwitch('disable-gpu-process-crash-limit') // let the GPU recover instead of being permanently disabled after N crashes

// Serve workspace thumbnails (rendered board snapshots, written by capturePage) to the renderer's
// <img> over a custom protocol — main owns the bytes; the renderer just references blitz-thumb://…
protocol.registerSchemesAsPrivileged([
  { scheme: 'blitz-thumb', privileges: { standard: true, supportFetchAPI: true, bypassCSP: true } },
  { scheme: 'blitz-file', privileges: { standard: true, supportFetchAPI: true, bypassCSP: true } }
])

let mainWindow: BrowserWindow | null = null
// The boot journal (crash dirty-bit + root lease) — opened once the workspace host exists, marked
// clean as the LAST step of a graceful quit ("clean" = state was flushed first).
let bootJournal: BootJournal | null = null
// The session-tape spool (plans/blitzos-logging.md), hoisted so launchAgent (agent.spawn) and the
// client-error IPC can reach it. Null until the BLITZ_TAPE init block runs.
let sessionTape: ReturnType<typeof makeSessionTape> | null = null
// The native dynamic-island helper (BlitzIsland.app) supervisor handle, hoisted so before-quit can stop its
// relaunch supervision. Null until startControlServer + launchIslandHelper run. The island's ISOLATION
// boundary (which agent ids the HUD may ever list/tail) lives in island-membership.mjs — realDeps records
// island-spawned ids there and the tail/list gate every read through islandLiveIds.
let islandHelper: IslandHelperHandle | null = null
// The currently-registered global show/hide-island accelerator (rebindable in Settings, persisted in
// userData/keybinds.json). Tracked so re-binds and the before-quit release target the live chord.
let notchToggleAccel = 'Alt+Space'

// SYNTHETIC (VM) MODE. A notch-less display (every VM, and any external/pre-notch Mac) has no physical notch, so the
// hit-window can't be placed and hover-to-open is impossible — the island opens once, retracts, and is unreachable.
// When we detect a hypervisor guest we tell the renderer to pin the island OPEN + interactive with retraction
// disabled, so BlitzOS is actually usable in a VM. BLITZ_SYNTHETIC=1 forces it on (any machine); =0 forces it off.
let _syntheticMode: boolean | null = null
function isSyntheticMode(): boolean {
  if (_syntheticMode !== null) return _syntheticMode
  const env = process.env.BLITZ_SYNTHETIC
  if (env === '1' || env === 'true') return (_syntheticMode = true)
  if (env === '0' || env === 'false') return (_syntheticMode = false)
  let vm = false
  try {
    // kern.hv_vmm_present = 1 when running as a guest under a hypervisor (Apple VZ, Parallels, VMware on Apple Silicon).
    // Bare metal returns 0, so a real Mac is never affected.
    if (execFileSync('sysctl', ['-n', 'kern.hv_vmm_present'], { timeout: 2000 }).toString().trim() === '1') vm = true
  } catch { /* sysctl missing or not macOS — fall through to the model check */ }
  if (!vm) {
    try {
      const model = execFileSync('sysctl', ['-n', 'hw.model'], { timeout: 2000 }).toString().trim()
      if (/Virtual|VMware|Parallels|VirtualBox|QEMU/i.test(model)) vm = true
    } catch { /* ignore — default to not-synthetic */ }
  }
  return (_syntheticMode = vm)
}

function safeExternalUrl(raw: unknown): string | null {
  const value = String(raw || '').trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null
  } catch {
    return null
  }
}

// A Blitz app preview is served from *.app.blitz.dev. Navigation that STAYS on that host is the app
// routing itself and belongs in the preview iframe; anything leaving it is an outbound link the user
// clicked and must open in the real browser (see the will-frame-navigate handler below).
function isBlitzAppHost(raw: string): boolean {
  try {
    return new URL(raw).hostname.endsWith('.app.blitz.dev')
  } catch {
    return false
  }
}

// Gather the user's small durable app state for a state.snapshot: workspace.json + content/memory files +
// onboarding + the root journal's permissions/bookmarks. All small text; the tape content-addresses each so
// unchanged files dedupe. Never the heavy stuff, never tokens (the tape scrubs on write).
function gatherDurableState(): { files: Record<string, string>; permissions?: unknown; bookmarks?: unknown } | null {
  try {
    const ws = osWorkspaceContext().workspace_path
    if (!ws) return null
    const files: Record<string, string> = {}
    const add = (rel: string, abs: string): void => {
      try { const st = statSync(abs); if (st.isFile() && st.size < 512 * 1024) files[rel] = readFileSync(abs, 'utf8') } catch { /* skip */ }
    }
    add('.blitzos/workspace.json', join(ws, '.blitzos', 'workspace.json'))
    try { for (const f of readdirSync(ws)) if (/\.(md|html|weblink|jsx|tsx)$/.test(f)) add(f, join(ws, f)) } catch { /* skip */ }
    for (const f of ['profile.md', 'board.json', 'interview.json']) add(`.blitzos/onboarding/${f}`, join(ws, '.blitzos', 'onboarding', f))
    let permissions: unknown
    let bookmarks: unknown
    try {
      const rs = JSON.parse(readFileSync(join(osWorkspacesRoot(), '.blitzos', 'state.json'), 'utf8')) as { permissions?: unknown; bookmarks?: unknown }
      permissions = rs.permissions
      bookmarks = rs.bookmarks
    } catch { /* skip */ }
    return { files, permissions, bookmarks }
  } catch {
    return null
  }
}

// Fullscreen "video-game" mode: NATIVE macOS fullscreen (its own Space), opt-in via `BLITZ_FULLSCREEN=1`
// (default windowed so a relaunch never traps you). Stays fully escapable — Ctrl+← / Ctrl+→ swap to your
// real macOS desktops, plus four-finger swipe, ⌘Tab and ⌃⌘F all work. We deliberately do NOT use kiosk:
// suppressing ⌘Tab is the same presentation lock that kills desktop-switching, which is what trapped you.
const FULLSCREEN = process.env.BLITZ_FULLSCREEN === '1'

// Notch-gated launch (the dynamic-island model): on macOS with the Electron notch island active (NOT the legacy
// native helper) and not video-game fullscreen, BlitzOS starts HIDDEN and the notch is the entry — clicking it
// brings the real canvas onto the user's CURRENT Space + fake-fullscreen covers it (sandwich.setSpillCover via the
// island fill seam). The window still loads while hidden, so the first reveal paints the real canvas at once.
// Escape hatch: BLITZ_NO_NOTCH_GATE=1 forces BlitzOS to show normally on launch (recover if hidden-on-launch
// ever traps you), e.g. `BLITZ_NO_NOTCH_GATE=1 npm run dev`.
const notchGated =
  process.platform === 'darwin' &&
  process.env.BLITZ_NATIVE_ISLAND !== '1' &&
  process.env.BLITZ_NO_NOTCH_GATE !== '1' &&
  !FULLSCREEN

// App fullscreen is a PAIR operation (sandwich.ts): fullscreen the PARENT pages window and the
// attached UI child rides into its Space. The default menu's "Toggle Full Screen" role targets the
// FOCUSED window — the UI child, which is deliberately fullscreenable:false (native fullscreen on a
// macOS child window detaches it from the parent) — so the role item sits permanently disabled.
// This menu keeps every standard role but wires that one item to the pair toggle. The NATIVE traffic
// lights are hidden (sandwich.ts) and the renderer draws its own (App.tsx); their green light drives
// this same pair fullscreen via os:shell-fullscreen (handled below), so the button is live now.
// Ask the island to show Settings: open the island (App pins it) + navigate to the settings view, restoring the
// chat tab + the half-typed draft on exit (renderer side). The menu is only reachable while BlitzOS is frontmost,
// so no focus juggling is needed here.
function showIslandSettings(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('os:notch-show-settings')
}

function installAppMenu(): void {
  const isMac = process.platform === 'darwin'
  // The macOS App menu, built MANUALLY (not role:'appMenu') so we can slot in the standard "Settings… ⌘," item
  // between About and Services. macOS forces the first menu's title to the bundle name regardless of `label`
  // (CFBundleName, patched to 'BlitzOS' by scripts/rebrand-dev-electron.mjs in dev / productName when packaged),
  // so the bold app-menu title still reads 'BlitzOS'; the role items below read 'About BlitzOS' / 'Quit BlitzOS'.
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => showIslandSettings() },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // On non-mac there's no App menu, so Settings lives here instead (with the ⌘,/Ctrl+, accelerator).
        ...(!isMac
          ? ([{ label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => showIslandSettings() }, { type: 'separator' }] as MenuItemConstructorOptions[])
          : []),
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        {
          label: 'Toggle Full Screen',
          accelerator: 'Ctrl+Cmd+F',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(!mainWindow.isFullScreen())
          }
        }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  // ONE plain window. Web surfaces are in-DOM <webview> tags (a real guest WebContents embedded in the
  // renderer), so they move/stack with their frame like any other DOM — no sandwich compositor, no clip
  // holes, no geometry sync. webviewTag enables the <webview> element; the guest session/policy is wired
  // per attach below (did-attach-webview) on the shared persist:agentos partition.
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    // Notch (overlay) mode reconfigures this ONE window as a transparent, all-Spaces, full-display island
    // (notch-overlay.ts) — the renderer clips #root-canvas to the notch shape and grows the clip to reveal the
    // real canvas; otherwise it is the normal hiddenInset window. Web surfaces are in-DOM <webview> either way
    // (the two-window sandwich is gone). An all-Spaces overlay must never native-fullscreen (it traps the user).
    ...(notchGated
      ? notchOverlayWindowOptions()
      : { titleBarStyle: 'hiddenInset' as const, backgroundColor: '#e9e9e7' }),
    fullscreen: notchGated ? false : FULLSCREEN,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webviewTag: true
    }
  })
  mainWindow.on('focus', () => trackActivity('app.focused', { source: 'main' }))
  mainWindow.once('ready-to-show', () => {
    if (notchGated && mainWindow) configureNotchOverlay(mainWindow) // show deferred until geometry push
    else mainWindow?.show()
  })
  // Overlay mode draws its OWN traffic lights (App.tsx); re-assert the native ones hidden across dev reloads.
  if (notchGated) mainWindow.webContents.on('did-finish-load', () => mainWindow?.setWindowButtonVisibility?.(false))

  // Stage keybinds must work no matter WHAT has keyboard focus — the host, a srcdoc iframe (the
  // chat hub!), or a WebContentsView guest. DOM keydown dies the moment a guest focuses, so main
  // intercepts at before-input-event (host webContents covers all its iframes; browser guests are
  // hooked by webcontents-view-host.ts) and forwards over IPC. ⌘T = tile toggle, ⇧⌘T = cycle size.
  const forwardTileKeybind = (input: Electron.Input): boolean => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return false
    const cmd = process.platform === 'darwin' ? input.meta : input.control
    if (!cmd) return false
    // ⌥⌘U — the hidden CI-build picker (developer machines only; see update.ts isDevMachine).
    if (input.alt && input.code === 'KeyU') {
      if (isDevMachine()) void openBuildPicker()
      return isDevMachine()
    }
    if (input.alt || input.code !== 'KeyT') return false
    mainWindow?.webContents.send('os:keybind', { id: 'tile', shift: !!input.shift })
    return true
  }
  // Each in-DOM <webview> guest is a separate process: hook its before-input-event so stage keybinds
  // (⌘T etc.) still fire while a web surface holds focus, and attach the popup/download/beforeunload
  // guest policy. (CDP + perception are wired renderer-side via os:register-webview on the guest's id.)
  mainWindow.webContents.on('did-attach-webview', (_e, guest) => {
    guest.on('before-input-event', (ev, input) => {
      if (forwardTileKeybind(input)) ev.preventDefault()
    })
    attachGuestWindowPolicy(guest, { openSurface: () => {}, logPlan: () => {} })
  })
  // Blitz app preview = a sandboxed <iframe> (allow-popups) inside THIS renderer. Outbound links the
  // user clicks in a preview must open in their default browser, never hijack/replace the preview.
  //  - target=_blank / window.open -> the window-open handler (deny + openExternal).
  //  - a plain <a> navigating the preview frame off its own host -> will-frame-navigate.
  // We scope the frame case to the DIRECT app iframe leaving *.app.blitz.dev, so in-app routing and
  // nested embeds (an app embedding e.g. a video iframe) keep loading inline.
  // Hand a URL to the real browser and collapse the island out of the way (the user is leaving for it).
  const mainWc = mainWindow.webContents
  const openExternalAndCollapse = (safe: string): void => {
    void shell.openExternal(safe)
    if (!mainWc.isDestroyed()) mainWc.send('os:notch-close')
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safe = safeExternalUrl(url)
    if (safe) openExternalAndCollapse(safe)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return // never the island UI's own top frame
    const frame = event.frame
    if (!frame?.parent || frame.parent.parent) return // only an iframe directly under the renderer
    if (isBlitzAppHost(event.url)) return // app routing within itself stays in the preview
    const safe = safeExternalUrl(event.url)
    if (!safe) return
    event.preventDefault()
    openExternalAndCollapse(safe)
  })
  // Hide blitz.dev's auto-injected "Make your own" discovery ribbon INSIDE the BlitzOS app viewer: it is redundant
  // here (we ARE BlitzOS) and lives in a cross-origin app frame, so only the privileged main process can reach it.
  // We hide it ONLY in our iframe; the public-web app keeps its ribbon (which is what blitz.dev wants). The ribbon
  // is static in the served HTML, so a one-shot hide on frame-load + one re-hide covers it. TODO: drop this once
  // blitz.dev offers a real embed/ribbon-suppress mode.
  mainWindow.webContents.on('did-frame-finish-load', (_e, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return
    const frame = webFrameMain.fromId(frameProcessId, frameRoutingId)
    if (!frame || !isBlitzAppHost(frame.url)) return
    frame
      .executeJavaScript(
        "(function(){var h=function(){document.querySelectorAll('a.tb-ribbon,.tb-ribbon,[data-ribbon]').forEach(function(e){e.style.setProperty('display','none','important')})};h();setTimeout(h,400)})()"
      )
      .catch(() => {})
  })
  // Bare-Option hold → the radial create menu, same focus-proof route as the keybinds above: the
  // host webContents sees the key even when an app/srcdoc iframe holds focus (the renderer's own
  // DOM keydown does not).
  let altHeld = false
  mainWindow.webContents.on('before-input-event', (ev, input) => {
    if (forwardTileKeybind(input)) {
      ev.preventDefault()
      return
    }
    if (input.type === 'keyDown') {
      if (input.key === 'Alt') {
        if (!input.isAutoRepeat && !input.meta && !input.control && !input.shift) {
          altHeld = true
          osRadialPhase('down')
        }
      } else if (altHeld) {
        altHeld = false
        osRadialPhase('cancel')
      }
    } else if (input.type === 'keyUp' && input.key === 'Alt' && altHeld) {
      altHeld = false
      osRadialPhase('up')
    }
  })

  // (show is owned by sandwich.ts: pages first, then the UI above it, then the z-assert.)

  // Surface real renderer failures (not normal logs) into the terminal.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`)
  })
  // SELF-HEAL: Electron does NOT auto-reload a crashed renderer. In the sandwich compositor the
  // renderer IS the UI window that owns all mouse input, so a crash with no reload = a permanently
  // FROZEN, unclickable window (observed: GPU tile-memory exhaustion under a heavy live-web load took
  // the renderer down and it never came back). Reload it, with a loop-guard so a renderer that crashes
  // on every load doesn't thrash forever.
  let lastRendererCrash = 0
  let rendererCrashes = 0
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer] render-process-gone ${JSON.stringify(details)}`)
    if (details?.reason === 'clean-exit') return
    const now = Date.now()
    if (now - lastRendererCrash > 60_000) rendererCrashes = 0
    lastRendererCrash = now
    if (++rendererCrashes > 4) {
      console.error('[renderer] too many crashes in 60s — not auto-reloading (likely a load-time fault)')
      return
    }
    setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload()
      } catch {
        /* window gone mid-recover */
      }
    }, 500)
  })

  // (The renderer pulls its hydrate via window.agentOS.requestHydrate() once its onAction listener is
  // mounted — race-free; see osActions 'workspace:request-hydrate'. No main-push on did-finish-load.)

  // electron-vite injects ELECTRON_RENDERER_URL in dev; load the built file in prod.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  // Self-test for the renderer-error path: throw in the renderer once loaded so the tape records a
  // diag 'error'. Dev-only, gated by BLITZ_TAPE_SELFTEST=1.
  if (process.env.BLITZ_TAPE_SELFTEST === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        mainWindow?.webContents.executeJavaScript("setTimeout(() => { throw new Error('tape-selftest: renderer error') }, 0)").catch(() => {})
        console.error('[tape-selftest] main-process error marker')
      }, 1500)
    })
  }
}

app.whenReady().then(() => {
  // macOS QOL: in notch mode the window is a faceless overlay (showInactive, never a normal window), so without
  // this there's no Dock icon to right-click → Quit — you'd have to hunt the pid + kill. Brand the Dock with the
  // Blitz app icon. Best-effort (any failure keeps the default icon). Done FIRST so the icon lands before
  // createWindow's work.
  if (process.platform === 'darwin' && notchGated && app.dock) {
    void app.dock.show().catch(() => {})
    try {
      const iconPath = app.isPackaged
        ? join(process.resourcesPath, 'blitz-dock-icon.png')
        : join(__dirname, '..', '..', 'src', 'renderer', 'src', 'assets', 'blitz-dock-icon.png')
      const icon = nativeImage.createFromPath(iconPath)
      if (!icon.isEmpty()) app.dock.setIcon(icon)
    } catch {
      /* keep the default Dock icon */
    }
  }
  installAppMenu() // restores ⌃⌘F / View → Toggle Full Screen (pair-level; see installAppMenu)
  createWindow()

  // Durably flush cookies + localStorage to disk (web surfaces persist their logins;
  // otherwise the freshest auth token is lost on quit and sites log you back out).
  startSessionPersistence()

  // Wire the renderer<->main control channel (shared by control server + agent-socket). Also creates
  // the shared workspace host (hydrate/persist/switch/list/create/thumb) — the SAME module the server
  // backend uses, so workspaces are one feature across both modes.
  initOsActions({
    getWindow: () => mainWindow
  })

  // Session telemetry (plans/blitzos-telemetry.md): events + frames → the replay dashboard. Off unless
  // ~/.blitzos/telemetry.json exists; BLITZ_TELEMETRY=0 kills it. After initOsActions so the taps see
  // a wired control plane; before everything else so boot-time errors are captured.
  initTelemetry(() => mainWindow)
  // Privacy-safe product activity logging: separate from replay/tape, config-gated, and strictly allowlisted.
  initActivityLogging({ userDataDir: app.getPath('userData'), appVersion: app.getVersion(), ...activityBuildMeta() })
  setToolTap((info) => trackToolActivity(info as Record<string, unknown>))
  // Session tape (plans/blitzos-logging.md): the local model-loop spool. Multi-subscriber taps, so it
  // coexists with telemetry. Local-only, never uploads. DEFAULT-OFF (the plan's M0 posture: no config =
  // no capture) because moments can carry typed input + token-bearing URLs — opt in with BLITZ_TAPE=1.
  if (process.env.BLITZ_TAPE === '1') {
    try {
      sessionTape = makeSessionTape({
        getRoot: () => osWorkspacesRoot(),
        getWorkspace: () => osWorkspaceContext().workspace,
        appVersion: app.getVersion(),
        boot: `boot-${Date.now().toString(36)}`
      })
      setToolTap((info) => sessionTape?.toolCall(info))
      setMomentTap((m) => sessionTape?.moment(m))
      console.log('[session-tape] on →', `${osWorkspacesRoot()}/.blitzos/tape`, 'code', sessionTape.codeVersion)
      // World state: snapshot the small durable files once the workspace has settled.
      setTimeout(() => { try { const s = gatherDurableState(); if (s) sessionTape?.snapshot('session-start', s) } catch { /* ignore */ } }, 3000)
      // Main-process errors → the tape's diagnostics stream (renderer errors come via os:client-error).
      const origErr = console.error.bind(console)
      console.error = (...a: unknown[]): void => {
        try { sessionTape?.diagError({ source: 'main', via: 'console', message: a.map((x) => String((x as Error)?.stack || x)).join(' ') }) } catch { /* ignore */ }
        origErr(...a)
      }
      process.on('uncaughtException', (e) => { try { sessionTape?.diagError({ source: 'main', via: 'uncaught', message: String((e as Error)?.stack || e) }) } catch { /* ignore */ } })
      process.on('unhandledRejection', (e) => { try { sessionTape?.diagError({ source: 'main', via: 'rejection', message: String((e as Error)?.stack || e) }) } catch { /* ignore */ } })
      // model.io: discover every agent's TUI transcript and collect new bytes (resumed agents never hit
      // agent.spawn, so we scan the active workspace's terminals each tick; registerTranscript no-ops on dupes).
      const registerWorkspaceTranscripts = (): void => {
        try {
          const ws = osWorkspaceContext().workspace_path
          if (!ws) return
          const tdir = join(ws, '.blitzos', 'terminals')
          for (const id of readdirSync(tdir)) sessionTape?.registerTranscript(id, join(tdir, id, 'transcript.jsonl'))
        } catch { /* ignore */ }
      }
      const tapeTimers: ReturnType<typeof setInterval>[] = []
      // 5s: collect model.io, pick up newly-spawned agents, and snapshot on a workspace switch.
      let tapeWs = osWorkspaceContext().workspace
      tapeTimers.push(setInterval(() => {
        try {
          registerWorkspaceTranscripts()
          sessionTape?.flushTranscripts()
          const ws = osWorkspaceContext().workspace
          if (ws && ws !== tapeWs) { tapeWs = ws; const s = gatherDurableState(); if (s) sessionTape?.snapshot('workspace-switch', s) }
        } catch { /* ignore */ }
      }, 5000))
      // ~4s: the visual frame track. capturePage of the UI window (sandwich L1) shows the desktop chrome,
      // notes and widgets; live web pages are transparent HOLES composited in L0, so page pixels are NOT in
      // the frame (a known sandwich limitation — plans/blitzos-sandwich-compositor.md). Heavy, so deduped via
      // the blob store (idle frames collapse) and gateable with BLITZ_TAPE_FRAMES=0.
      if (process.env.BLITZ_TAPE_FRAMES !== '0') {
        tapeTimers.push(setInterval(() => {
          try {
            const wc = mainWindow?.webContents
            if (!wc || wc.isDestroyed()) return
            void wc.capturePage().then((img) => {
              try {
                // Downscale to ~1280px before JPEG (telemetry does the same): a live desktop frame is never
                // byte-identical to the last, so the blob store can't dedupe it — the per-frame SIZE is the
                // only real lever. Full retina (2880px) is ~257KB/frame; 1280px q40 is ~30-40KB (~7x less).
                const sz = img.getSize()
                const scaled = sz.width > 1280 ? img.resize({ width: 1280 }) : img
                const out = scaled.getSize()
                sessionTape?.frame(scaled.toJPEG(40), { format: 'jpeg', w: out.width, h: out.height })
              } catch { /* ignore */ }
            }).catch(() => {})
          } catch { /* ignore */ }
        }, 4000))
      }
      // 60s heartbeat: re-snapshot the world state (content-addressed, so unchanged files cost nothing).
      tapeTimers.push(setInterval(() => { try { const s = gatherDurableState(); if (s) sessionTape?.snapshot('periodic', s) } catch { /* ignore */ } }, 60000))
      app.on('before-quit', () => { for (const t of tapeTimers) clearInterval(t) })
    } catch (e) {
      console.error('[session-tape] init failed', e)
    }
  }
  // Renderer (and main) client errors → the session tape's diagnostics stream (the failure markers).
  ipcMain.on('os:client-error', (_e, p: { via?: string; message?: string; stack?: string; surface?: string }) => {
    try { sessionTape?.diagError({ ...p, source: 'renderer' }) } catch { /* ignore */ }
  })
  ipcMain.on('os:activity-track', (_e, p: { name?: unknown; props?: unknown }) => {
    const name = String(p?.name || '')
    const props = p?.props && typeof p.props === 'object' ? (p.props as Record<string, unknown>) : {}
    trackActivity(name, props)
  })

  // Claim the root + read the previous run's dirty bit (announced below once the control plane is up,
  // so a watching agent's /events long-poll can actually deliver the moment).
  bootJournal = openBootJournal(osWorkspacesRoot(), 'electron')

  // Guest capability contract (item 3): set the session-level policy ONCE on the shared persist:agentos
  // session — covers every current + future web guest. Downloads land in the active workspace folder (→ a
  // file tile); a sensitive permission request shows the human a real Allow/Block prompt (browser parity),
  // remembered per-origin. Content-agnostic — see guest-capabilities.ts. (Per-guest popup/unload policy is
  // attached by webcontents-view-host.ts via attachGuestWindowPolicy.)
  installGuestSessionPolicy({
    root: osWorkspacesRoot(),
    getDownloadDir: () => osActiveWorkspaceDir(),
    broadcastPermission: (p) => {
      console.log(`[guest] permission prompt: ${p.permission} <- ${p.origin}`)
      try { sessionTape?.guestDecision({ subtype: 'permission', origin: p.origin, permission: p.permission, surfaceId: p.surfaceId || undefined }) } catch { /* ignore */ }
      mainWindow?.webContents.send('os:action', { type: 'permission-request', ...p })
    },
    surfaceIdFor: (wc) => osSurfaceIdForWebContents(wc)
  })
  // The human answered an Allow/Block prompt in the renderer → resolve the held request + remember per-origin.
  ipcMain.handle('os:permission-decide', (_e, id: string, allow: boolean, remember: boolean) => resolvePermissionPrompt(osWorkspacesRoot(), String(id), !!allow, !!remember))

  // Workspace thumbnail protocol (blitz-thumb://t/?name=X&t=ts → the cached jpeg). After initOsActions
  // so the host exists; osReadThumb null-guards anyway. (initOsActions already wired the shared
  // workspace host — hydrate/persist/switch/watch — so there is no separate initWorkspaces.)
  protocol.handle('blitz-thumb', (request) => {
    try {
      const buf = osReadThumb(new URL(request.url).searchParams.get('name') || '')
      return buf
        ? new Response(new Uint8Array(buf), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' } })
        : new Response('', { status: 404 })
    } catch {
      return new Response('', { status: 400 })
    }
  })
  // Image previews for real workspace files in the desktop app (#46): blitz-file://w/<encoded relpath>.
  protocol.handle('blitz-file', (request) => {
    try {
      const rel = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
      const r = osReadWorkspaceFile(rel)
      return r
        ? new Response(new Uint8Array(r.buf), { headers: { 'content-type': r.contentType, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } })
        : new Response('', { status: 404 })
    } catch {
      return new Response('', { status: 400 })
    }
  })

  // Register the IPC for web-surface CDP control (renderer reports guest ids).
  initCdp()

  // Widget bridge: a sandboxed widget calls an OS tool (blitz.tool, CLOSED allowlist).
  registerWidgets()

  // Onboarding director (P1): local scan → Case File workspace → template board → FDA unlock loop.
  registerOnboarding(() => mainWindow)
  initUpdater() // OTA poll (packaged builds only — no-op in dev)

  // #52: group surfaces into a REAL folder (mkdir + mv) — the renderer's Cmd+G in the desktop app.
  // kind:'board' makes a '.board' on-canvas folder (windows/widgets splay live); else a normal file folder.
  ipcMain.handle('os:group', (_e, name: string, ids: string[], kind?: string) =>
    osGroupIntoFolder(String(name), Array.isArray(ids) ? ids : [], undefined, undefined, kind === 'board' ? 'board' : 'folder')
  )
  // Quit BlitzOS from the Settings panel — app.quit() runs the before-quit handlers (workspace flush, markClean).
  // Belt-and-suspenders: if a stray async before-quit ever defers the normal quit, force the process down shortly
  // after (the synchronous cleanup + markClean have already run by then).
  ipcMain.handle('os:quit', () => {
    console.log('[quit] os:quit IPC received — app.quit()')
    app.quit()
    setTimeout(() => {
      try {
        app.exit(0)
      } catch {
        /* already gone */
      }
    }, 600)
    return { ok: true }
  })
  // Drag-drop real files/folders from the OS onto the canvas (folders copy recursively → one tile).
  ipcMain.handle('os:ingest-paths', (_e, paths: string[], x: number, y: number) =>
    osIngestPaths(Array.isArray(paths) ? paths : [], Number(x) || 0, Number(y) || 0)
  )
  // "New Folder" (files) / "New Board" (windows+widgets) from the right-click desktop menu.
  ipcMain.handle('os:new-folder', (_e, name: string, kind: string, x: number, y: number) =>
    osNewFolder(String(name), kind === 'board' ? 'board' : 'folder', Number(x) || 0, Number(y) || 0)
  )
  ipcMain.handle('os:rename-folder', (_e, path: string, name: string) => osRenameFolder(String(path || ''), String(name || '')))
  ipcMain.handle('os:move-into-folder', (_e, folderPath: string, ids: string[]) =>
    osMoveIntoFolder(String(folderPath || ''), Array.isArray(ids) ? ids : [])
  )
  ipcMain.handle('os:move-out-of-folder', (_e, paths: string[], x: number, y: number) =>
    osMoveOutOfFolder(Array.isArray(paths) ? paths : [], Number(x) || 0, Number(y) || 0)
  )
  ipcMain.handle('os:open-folder-entry', (_e, path: string, x: number, y: number) => osOpenFolderEntry(String(path || ''), Number(x) || 0, Number(y) || 0))
  ipcMain.handle('os:open-external-url', async (_e, raw: string) => {
    const url = safeExternalUrl(raw)
    if (!url) return { ok: false, error: 'unsupported url' }
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'open failed' }
    }
  })
  // File-manager listing for a normal folder tile (the Electron counterpart of server /api/os/dir).
  ipcMain.handle('os:dir', (_e, rel: string) => osListDir(String(rel || '')))
  // Close = delete the closed window's backing content file (so it doesn't pop back up on reconcile).
  ipcMain.handle('os:close-surface-file', (_e, id: string) => osCloseSurfaceFile(String(id)))

  // Terminal I/O from a TerminalView in the renderer: keystrokes, resize, scrollback read.
  ipcMain.on('os:terminal-input', (_e, p: { id: string; data: string }) => electronTerminalOps.sendToTerminal(String(p?.id), String(p?.data ?? '')))
  ipcMain.on('os:terminal-resize', (_e, p: { id: string; cols: number; rows: number }) => electronTerminalOps.resizeTerminal(String(p?.id), Number(p?.cols) || 80, Number(p?.rows) || 24))
  ipcMain.handle('os:terminal-read', (_e, id: string) => electronTerminalOps.readTerminal(String(id)))
  // "Open in Ghostty": open this terminal in a real terminal window (read-only) so TUIs render properly,
  // instead of the ANSI-stripped embedded DEBUG pane. See openTerminalExternal (module scope) for the why.
  ipcMain.handle('os:terminal-open-external', (_e, id: string) => openTerminalExternal(String(id)))
  ipcMain.on('os:terminal-spawn', (_e, opts: { command?: string; title?: string }) => { void electronTerminalOps.spawnTerminal(opts || {}) })
  ipcMain.on('os:agent-spawn', (_e, p?: { title?: string }) => {
    try {
      const r = osSpawnAgent(p?.title != null ? String(p.title) : undefined, true) as { id?: unknown; ok?: boolean }
      if (r && r.ok !== false) trackActivity('agent.spawned', { agentId: r.id, source: 'main' })
    } catch { /* no workspace host yet */ }
  })
  ipcMain.handle('os:close-agent', (_e, id: string) => {
    try {
      const r = osCloseAgent(String(id))
      if (r?.ok) trackActivity('agent.deleted', { agentId: id, source: 'main' })
      return r
    } catch (e) { return { ok: false, error: (e as Error)?.message } }
  })
  ipcMain.handle('os:archive-agent', (_e, id: string) => {
    try {
      const r = osArchiveAgent(String(id))
      if (r?.ok) trackActivity('agent.archived', { agentId: id, source: 'main' })
      return r
    } catch (e) { return { ok: false, error: (e as Error)?.message } }
  })
  ipcMain.handle('os:unarchive-agent', (_e, id: string) => {
    try {
      const r = osUnarchiveAgent(String(id))
      if (r?.ok) trackActivity('agent.restored', { agentId: id, source: 'main' })
      return r
    } catch (e) { return { ok: false, error: (e as Error)?.message } }
  })
  ipcMain.handle('os:rename-agent', (_e, p: { id: string; title: string }) => {
    try {
      const r = osRenameAgent(String(p?.id), String(p?.title ?? ''))
      if (r?.ok) trackActivity('agent.renamed', { agentId: p?.id, source: 'main' })
      return r
    } catch (e) { return { ok: false, error: (e as Error)?.message } }
  })
  // Native right-click menu for an agent chat tab (Rename / Archive). The renderer awaits the chosen action and
  // dispatches it (rename → inline edit, archive → osArchiveAgent). Archive is omitted for the primary agent '0'.
  // popup() with no x/y anchors at the cursor (standard macOS); the callback resolves on dismiss → resolve(null).
  ipcMain.handle('os:agent-tab-menu', (e, p: { isPrimary?: boolean }) =>
    new Promise<'rename' | 'archive' | null>((resolve) => {
      try {
        let chosen: 'rename' | 'archive' | null = null
        const items: MenuItemConstructorOptions[] = [{ label: 'Rename', click: () => { chosen = 'rename' } }]
        if (!p?.isPrimary) items.push({ label: 'Archive', click: () => { chosen = 'archive' } })
        const win = BrowserWindow.fromWebContents(e.sender) ?? mainWindow ?? undefined
        Menu.buildFromTemplate(items).popup({ window: win, callback: () => resolve(chosen) })
      } catch {
        resolve(null)
      }
    }))
  // The orchestrators (dynamic-workflows) toggle: flip the durable per-agent flag + wake it live (delivery B).
  ipcMain.handle('os:agent-orchestrators', (_e, p: { id: string; on?: boolean }) => { try { return osSetOrchestrators(String(p?.id), p?.on === undefined ? true : !!p.on) } catch (e) { return { ok: false, error: (e as Error)?.message } } })
  // One-shot snapshot for the dynamic island on open: the session roster + transcripts + status. The island
  // then rides the live `os:action {type:'chat'}` broadcast for updates.
  ipcMain.handle('os:agents-snapshot', () => { try { const s = osAgentsSnapshot(); return { ...s, status: applyWakeOverride(s.status || {}, islandActiveWs()) } } catch { return { sessions: [], archivedSessions: [], threads: {}, status: {}, errors: {}, milestones: {}, runs: {} } } })
  // The island's per-session "Details" expand: the agent's recent raw tool calls (Grep/Edit/Run …), read from
  // its canonical transcript. Deterministic, no LLM.
  ipcMain.handle('os:agent-details', (_e, p: { id?: string }) => { try { return osAgentDetails(String(p?.id ?? '0')) } catch { return { rows: [] } } })
  // blitz.chat (the shared chat hub control): 'new' -> spawn a fresh agent thread (returns its id);
  // 'rename' → retitle an agent. Routes to the SAME osSpawnAgent/osRenameAgent the toolbar uses — the
  // server mirrors this via the shim's chatControl → /api/os/agent-spawn|agent-rename (no divergence).
  ipcMain.handle('os:chat-control', (_e, p: { op?: string; args?: { id?: string; title?: string; focus?: boolean } }) => {
    try {
      const op = String(p?.op || ''); const a = p?.args || {}
      if (op === 'new') return osSpawnAgent(a.title != null ? String(a.title) : undefined, !!a.focus)
      if (op === 'rename') return osRenameAgent(String(a.id ?? ''), String(a.title ?? ''))
      if (op === 'archive') return osArchiveAgent(String(a.id ?? ''))
      if (op === 'unarchive') return osUnarchiveAgent(String(a.id ?? ''))
      // 'clear' → start a FRESH context for this agent (rotate its claude session id + restart). Uniform for
      // every agent incl '0'; the server mirrors it via the shim → /api/os/agent-clear (no divergence).
      if (op === 'clear') return Promise.resolve(electronTerminalOps.clearAgentContext(String(a.id ?? '0'))).then((okv) => ({ ok: !!okv }))
      return { ok: false, error: `unknown chat op: ${op}` }
    } catch (e) { return { ok: false, error: (e as Error)?.message } }
  })
  ipcMain.handle('os:terminal-list', () => electronTerminalOps.listTerminals())
  // Connections — the attach panel lists + connects tabs/windows through the shared registry. `agentId` (the active
  // chat session, '' = the new-session composer) OWNS the connection: it scopes connection_list per chat + targets
  // the attach wake to that agent. The drop path can't see the renderer's active session, so the renderer reports it
  // when it arms the picker (os:pick-start) and we stash it here.
  let pickActiveSession = ''
  ipcMain.handle('os:conn-list-tabs', () => {
    trackActivity('connector.picker_opened', { connectorKind: 'browser_tab', source: 'main' })
    return electronConnections.connectionListTabs()
  })
  ipcMain.handle('os:conn-list-windows', () => {
    trackActivity('connector.picker_opened', { connectorKind: 'mac_window', source: 'main' })
    return electronConnections.connectionListWindows()
  })
  ipcMain.handle('os:conn-connect-tab', async (_e, id: number | string, agentId?: string) => {
    const r = await electronConnections.connectionConnectTab(id, { agentId: agentId != null ? String(agentId) : '' })
    trackActivity('connector.connected', { connectorKind: 'browser_tab', agentId, success: !(r as { error?: unknown })?.error, source: 'main' })
    return r
  })
  ipcMain.handle('os:conn-connect-window', async (_e, id: number, agentId?: string) => {
    const r = await electronConnections.connectionConnectWindow(Number(id), { agentId: agentId != null ? String(agentId) : '' })
    trackActivity('connector.connected', { connectorKind: 'mac_window', agentId, success: !(r as { error?: unknown })?.error, source: 'main' })
    return r
  })
  ipcMain.handle('os:conn-list', (_e, agentId?: string) => electronConnections.connectionList(agentId != null ? String(agentId) : undefined))
  ipcMain.handle('os:conn-drop', async (_e, connId: string) => {
    const r = await electronConnections.connectionDrop(String(connId))
    trackActivity('connector.disconnected', { success: !(r as { error?: unknown })?.error, source: 'main' })
    return r
  })
  // Favicon reliability fallback: the renderer <img> loads `<origin>/favicon.ico` directly (fast), but some sites
  // (Instagram, Threads) serve an HTML wall to any browser request and only a neutral main-process fetch gets the
  // real bytes. The renderer calls this ONLY when its direct <img> errors; we return a data: URL or null. Cached.
  ipcMain.handle('os:conn-favicon', (_e, url: string) => resolveFavicon(String(url)))
  ipcMain.handle('os:blitz-chrome-status', () => blitzChrome().status())
  ipcMain.handle('os:blitz-chrome-open', async (_e, agentId?: string) =>
    blitzChrome().open(agentId != null ? String(agentId) : '', {})
  )
  // Per-message attachment snapshots (the frozen in-chat dropbox), persisted under <ws>/.blitzos/attachments/<chat>.json.
  const attachmentStore = makeAttachmentStore({ getWorkspacePath: () => osWorkspaceContext().workspace_path || null })
  ipcMain.handle('os:attach-get', (_e, chat: string) => attachmentStore.listAttachments(String(chat ?? '')))
  ipcMain.handle('os:attach-record', (_e, chat: string, msgKey: string, groups: unknown) =>
    attachmentStore.recordAttachments(String(chat ?? ''), String(msgKey ?? ''), Array.isArray(groups) ? groups : [])
  )
  // Window picker: arm the CU helper's hover-highlight-and-drag overlay over the user's REAL macOS windows.
  // dropZone is the attach drop-zone's on-screen rect (global, top-left points); dropping a window there connects
  // it (handled by the helper's pick_drop event below). excludePids skips BlitzOS's own window (no self-highlight).
  ipcMain.handle('os:pick-start', async (_e, dropZone: { x: number; y: number; w: number; h: number }, selfRect: { x: number; y: number; w: number; h: number }, activeSessionId?: string) => {
    pickActiveSession = activeSessionId != null ? String(activeSessionId) : '' // the chat that owns whatever gets dropped
    const helper = computerUseHelper()
    const e = await helper.ensure()
    if (!e.ok) {
      const error = e.error || 'computer-use helper unavailable'
      mainWindow?.webContents.send('os:pick-event', { kind: 'error', error, permission: permissionFromError(error) })
      return { ok: false, error: e.error }
    }
    const r = await helper.call('pick_start', { dropZone, selfRect, excludePids: [process.pid] })
    if (r.error || r.ok === false) {
      // P0: do NOT auto-fire the raw prompt here. The "could not create event tap" failure means Accessibility
      // isn't granted; surface it as a permission descriptor so the renderer shows a clear card with an Enable
      // button (which routes through os:request-grant), instead of a bare red string the user can't act on.
      const error = String(r.error || 'could not start the window picker — Accessibility may not be granted')
      mainWindow?.webContents.send('os:pick-event', { kind: 'error', error, permission: permissionFromError(error) || grantForConnection({ type: 'window' }) })
      return { ok: false, error }
    }
    return { ok: true }
  })
  ipcMain.handle('os:pick-stop', () => computerUseHelper().call('pick_stop').catch(() => ({})))
  ipcMain.on('os:terminal-stop', (_e, id: string) => electronTerminalOps.stopTerminal(String(id)))
  ipcMain.on('os:terminal-remove', (_e, id: string) => electronTerminalOps.removeTerminal(String(id)))
  ipcMain.on('os:terminal-restart', (_e, id: string) => { void electronTerminalOps.restartTerminal(String(id)) })

  // Action-items inbox (human side): list / resolve / clear.
  ipcMain.handle('os:action-list', (_e, status?: string) => electronActionItems.listActions(status as ActionStatus | undefined))
  ipcMain.on('os:action-resolve', (_e, p: { id: string; resolution?: string }) => { electronActionItems.resolveAction(String(p?.id), p?.resolution ? String(p.resolution) : 'done') })
  ipcMain.on('os:action-clear', (_e, id: string) => { electronActionItems.clearAction(String(id)) })

  // Custom window controls for NOTCH (overlay) mode: App.tsx draws its OWN macOS traffic lights because the
  // native ones are hidden on the frameless overlay. In the normal hiddenInset window the native lights are used
  // and these go unused. Wired to the single window (the two-window sandwich is gone). Fullscreen is a no-op in
  // overlay (an all-Spaces overlay can't native-fullscreen — it would trap the user; the notch's "fullscreen" is
  // the renderer clip-grow); in the normal window it toggles native fullscreen.
  ipcMain.on('os:shell-fullscreen', () => {
    if (!mainWindow || mainWindow.isDestroyed() || notchGated) return
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
  })
  ipcMain.on('os:shell-minimize', () => { try { mainWindow?.minimize() } catch { /* mid-teardown */ } })
  ipcMain.on('os:shell-close', () => {
    try {
      mainWindow?.close()
    } catch {
      /* already gone */
    }
  })

  // The standalone Launcher (Shell A): an always-on-top NSPanel where the user types a prompt; Send →
  // electronOps.startWorkflow, which spawns an orchestrator agent (ORCHESTRATORS on) seeded with the task.
  // ISOLATED — its own window + self-contained inline UI; nothing here touches the renderer. It binds NO global
  // hotkey (⌥Space belongs to the notch; registerLauncher only wires the Send IPC for a future in-app HUD).
  // Workspace-host-gated: a Send before a host exists surfaces { ok:false } and leaves the bar open.
  wireLauncher({
    // electronOps is typed as a Record<string, (...args:never[])=>unknown>; cast startWorkflow to its real
    // signature at this one call site. The launcher hands us { task, contextRefs }; we forward to the shared
    // start_workflow tool, which spawns an orchestrator agent seeded with the task.
    startWorkflow: (spec) =>
      (electronOps.startWorkflow as unknown as (s: { task: string; contextRefs?: string[] }) => { ok?: boolean; agent?: { id: string; title?: string }; error?: string })({ task: spec.task, contextRefs: spec.contextRefs }),
    focusMain: () => {
      const w = mainWindow
      if (!w || w.isDestroyed()) return
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
  })
  registerLauncher()

  // Live workflow externalization (plans/blitzos-workflow-externalization.md): run_workflow runs a blitzscript
  // IN-PROCESS so its WfEvents stream to the per-run bus and into the live widget. The host needs the active
  // workspace path (each run's memory dir) + the enrichment spawner (a fresh claude -p that rewrites the
  // generic widget into a bespoke live view, compile-gated). repoRoot = cwd in dev (where widgets/ + scripts/
  // live); disable enrichment with BLITZ_WF_ENRICH=0.
  wireEnrichment({ repoRoot: process.cwd(), claudeCmd: process.env.BLITZ_CLAUDE_CMD || 'claude', getWorkspacePath: () => osWorkspaceContext().workspace_path || null })
  wireWorkflowHost({
    getWorkspacePath: () => osWorkspaceContext().workspace_path || null,
    spawnEnrichment: (info) => { try { spawnWorkflowEnrichment(info) } catch { /* enrichment is best-effort; the generic widget stands */ } },
    // The island's kanban board in chat rides these broadcasts (started/done), exactly like {type:'milestone'}.
    broadcast: (action) => { try { osBroadcast(action) } catch { /* best-effort */ } },
    // Wake the launching agent via /events when a hosted run finishes (bugs 2+3), so it stops hand-rolling a
    // result.json poll. Fired next to persistEvents in the host; here we turn it into an agent-private 'workflow'
    // moment. memDir comes straight from the host (result.json is already written under it before this fires).
    onRunComplete: ({ runId, agentId, ok, memDir }) => {
      try { emitWorkflowMoment(String(runId || ''), String(agentId ?? '0'), { ok: ok !== false, resultPath: memDir ? join(String(memDir), 'result.json') : '' }) } catch { /* best-effort */ }
    }
  })

  // The widget-bridge subscribe path: a srcdoc widget calls blitz.workflow.subscribe(runId) -> SurfaceFrame
  // invokes os:wf-subscribe -> main streams the run's backlog + live events back as os:wf-event to that
  // webContents (SurfaceFrame routes each to the right iframe). os:wf-unsubscribe drops it on unmount.
  {
    const wfSubs = new Map<string, () => void>() // key: `${webContentsId}:${runId}` -> unsubscribe
    ipcMain.handle('os:wf-subscribe', (e, runId: string) => {
      const id = String(runId || '')
      if (!id) return { ok: false }
      osWfHydrateIfCold(id) // seed the bus from disk if this is a cold (evicted/post-relaunch) run, so the backlog replays a frozen board
      const wc = e.sender
      const key = `${wc.id}:${id}`
      if (wfSubs.has(key)) return { ok: true } // already streaming to this webContents for this run
      const off = wfSubscribe(id, (ev) => { try { if (!wc.isDestroyed()) wc.send('os:wf-event', { runId: id, ev }) } catch { /* renderer gone */ } })
      wfSubs.set(key, off)
      wc.once('destroyed', () => { try { off() } catch { /* ignore */ }; wfSubs.delete(key) })
      return { ok: true }
    })
    ipcMain.on('os:wf-unsubscribe', (e, runId: string) => {
      const key = `${e.sender.id}:${String(runId || '')}`
      const off = wfSubs.get(key)
      if (off) { try { off() } catch { /* ignore */ }; wfSubs.delete(key) }
    })
    ipcMain.handle('os:wf-snapshot', (_e, runId: string) => { const id = String(runId || ''); osWfHydrateIfCold(id); return wfSnapshot(id) })
    // The island loads an agent's boards on tab-open: the durable disk index merged with the live registry. The
    // renderer also pings os:tab-viewed so the memory-eviction sweep keeps a recently-viewed tab's runs cached.
    ipcMain.handle('os:wf-load-agent-runs', (_e, agentId: string) => { try { return osLoadAgentRuns(String(agentId ?? '0')) } catch { return [] } })
    ipcMain.on('os:tab-viewed', (_e, agentId: string) => { try { osNoteTabViewed(String(agentId ?? '0')) } catch { /* best-effort */ } })
    // The island kanban drill-in drawer: read a terminal leaf's captured record (Asked/Did/Returned).
    // Lazy on-click; returns { leaf } or { ok:false } when capture is off / the leaf hasn't finished. The run's
    // absolute memDir is resolved HERE by runId from the trusted main-side registry (osWfRunMemDir) — the
    // renderer never supplies a filesystem path, so there is no path-traversal surface. It stays correct across
    // workspace switches (the memDir was recorded when the run started); runId/nodeId are also validated.
    ipcMain.handle('os:wf-leaf', (_e, runId: string, nodeId: string) => {
      const memDir = osWfRunMemDir(String(runId || ''))
      const r = osReadLeaf(memDir, String(runId || ''), String(nodeId || ''))
      return r && r.leaf ? { ok: true, leaf: r.leaf } : { ok: false }
    })
    // Memory-eviction sweep: every 5 min, drop DONE workflow runs' in-memory state (registry + bus buffer) for
    // tabs unviewed past the 15-min TTL. Disk (index.json + events.jsonl) is untouched, so re-viewing reloads them.
    const wfSweep = setInterval(() => { try { osSweepWfMemory() } catch { /* best-effort */ } }, 5 * 60_000)
    app.on('before-quit', () => clearInterval(wfSweep))
  }

  // The Notch (dynamic island) — THE MERGE: the real BlitzOS UI window IS the notch. The renderer clips
  // #root-canvas to the notch shape and GROWS the clip to fullscreen, so the LIVE canvas is what expands out of
  // the notch — no separate window, no plate, no handoff (createWindow passed overlay: notchGated). Main only:
  //  - os:notch-interactive → setNotchInteractive (collapsed = click-through except the notch; expanded = full)
  //  - os:notch-send → spawn (Deep ON → startWorkflow; Deep OFF → spawnAgent + userMessage)
  //  - os:notch-geometry → push the menu-bar height (the notch height) to the renderer
  //  - ⌥Space → os:notch-toggle (the renderer toggles expand/collapse)
  // The standalone island.ts window + the native BlitzIsland.app (BLITZ_NATIVE_ISLAND, wired below) are retired/legacy.
  if (notchGated) {
    let notchGeom: NotchGeometry | null = null
    let notchHitWin: BrowserWindow | null = null
    let notchOverlayInteractive = false
    let notchWindowShown = false
    const notchPreload = join(__dirname, '../preload/index.js')
    ipcMain.on('os:notch-interactive', (_e, on: boolean) => {
      notchOverlayInteractive = !!on
      try { setNotchInteractive(mainWindow, notchOverlayInteractive) } catch { /* mid-teardown */ }
      try {
        // When the panel is open the full overlay owns interaction; the tiny notch catcher must become
        // click-through or it can steal hover/clicks from tabs rendered underneath the hardware notch column.
        if (notchHitWin && !notchHitWin.isDestroyed()) notchHitWin.setIgnoreMouseEvents(notchOverlayInteractive, { forward: true })
      } catch { /* mid-teardown */ }
    })
    // Deep ON → an orchestrated workflow (electronOps.startWorkflow). Deep OFF → a conversational peer agent
    // (electronOps.spawnAgent) seeded with the prompt (electronOps.userMessage WRITES chat.md + wakes). electronOps
    // is typed Record<string,(...args:never[])=>unknown>; cast each to its real signature at this one call site.
    ipcMain.handle('os:notch-send', (_e, payload: { prompt?: unknown; deep?: unknown }) => {
      const prompt = String(payload?.prompt ?? '').trim()
      if (!prompt) return { ok: false, error: 'empty prompt' }
      // Sources attached on the new-session composer are owned by '' (the pre-spawn bucket). When the agent spawns,
      // reassign them to it: it now OWNS them (connection_list scopes per chat) and is WOKEN about each (the moments
      // connectionReassign emits) — no need to dump connIds into the user's message; the UI shows them as chips.
      try {
        if (payload?.deep) {
          const r = (electronOps.startWorkflow as unknown as (s: { task: string; contextRefs?: string[]; title?: string }) => { ok?: boolean; agent?: { id: string; title?: string }; error?: string })({ task: prompt, contextRefs: [], title: undefined })
          if (r?.agent?.id) electronConnections.connectionReassign(String(r.agent.id), '')
          if (r?.agent?.id && r.ok !== false) trackActivity('agent.spawned', { agentId: r.agent.id, source: 'main' })
          return r && r.ok !== false ? { ok: true, id: r.agent?.id ?? null } : { ok: false, error: r?.error || 'startWorkflow failed' }
        }
        const a = (electronOps.spawnAgent as unknown as (title?: string) => { id: string; title: string })(undefined)
        electronConnections.connectionReassign(String(a.id), '')
        try { (electronOps.userMessage as unknown as (text: string, agentId?: string) => void)(prompt, a.id) } catch { /* seeds when chat.md is read */ }
        trackActivity('agent.spawned', { agentId: a.id, source: 'main' })
        return { ok: true, id: a.id }
      } catch (e) {
        return { ok: false, error: (e as Error)?.message || 'send threw' }
      }
    })
    // Pen "new session" button: spawn a fresh agent IMMEDIATELY (no prompt seeded) and return its id; the renderer
    // jumps to its tab. The user then types/attaches in the live chat — attachments scope to this agent, so there
    // is no pre-spawn '' bucket to reassign (unlike the retired type-to-spawn composer).
    ipcMain.handle('os:notch-new-agent', () => {
      try {
        const a = (electronOps.spawnAgent as unknown as (title?: string) => { id: string; title: string })(undefined)
        trackActivity('agent.spawned', { agentId: a.id, source: 'main' })
        return { ok: true, id: a.id }
      } catch (e) {
        return { ok: false, error: (e as Error)?.message || 'spawn threw' }
      }
    })
    // Push the notch geometry (the menu-bar height the renderer uses as the notch height) once the renderer is up
    // and on display changes; the renderer already knows the screen size from its own full-display window.
    // The BULLETPROOF notch toggle: a tiny always-interactive transparent window placed EXACTLY over the physical
    // notch (geometry from the native CLI). It owns the click (→ toggle fullscreen) + hover (→ open the panel), so
    // the toggle is constant in every state and has no click-through→arm race. No physical notch → no window
    // (⌥Space only). The overlay still paints the black pill + peek dots UNDER this transparent catcher.
    const pushNotchGeometry = (): void => {
      const w = mainWindow
      if (!w || w.isDestroyed()) return
      const d = screen.getPrimaryDisplay()
      try {
        w.webContents.send('os:notch-geometry', {
          width: d.bounds.width,
          height: d.bounds.height,
          menuBarH: Math.max(0, d.workArea.y - d.bounds.y),
          notchWidth: notchGeom?.hasNotch ? Math.round(notchGeom.notchWidth) : 0,
          hasNotch: !!notchGeom?.hasNotch,
          // VM / notch-less: tell the renderer to pin the island open + interactive (no hit-window can exist here).
          synthetic: isSyntheticMode()
        })
      } catch { /* mid-teardown */ }
    }
    const updateNotchHitWindow = (): void => {
      const d = screen.getPrimaryDisplay()
      const menuBarH = Math.max(0, d.workArea.y - d.bounds.y)
      const rect = notchHitRect(notchGeom, menuBarH)
      if (!rect) {
        if (notchHitWin && !notchHitWin.isDestroyed()) notchHitWin.destroy()
        notchHitWin = null
        return
      }
      if (!notchHitWin || notchHitWin.isDestroyed()) {
        notchHitWin = new BrowserWindow(notchHitWindowOptions(rect, notchPreload))
        // relativeLevel +1 keeps it STRICTLY above the overlay (also 'screen-saver'), so in fullscreen the notch
        // click hits this window and not the interactive canvas beneath — survives the overlay's 700ms re-assert.
        notchHitWin.setAlwaysOnTop(true, 'screen-saver', 1)
        notchHitWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        notchHitWin.webContents.on('will-navigate', (e) => e.preventDefault()) // fixed inline page only
        notchHitWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        notchHitWin.on('closed', () => { notchHitWin = null })
        // Show ONLY after the first transparent paint. Shown before that (the old immediate showInactive), a
        // transparent macOS window keeps its opaque WHITE backing and this empty catcher never repaints over it —
        // that was the persistent "white pill" at the notch. showInactive so it never steals focus from the app under it.
        let hitShown = false
        const showHit = (): void => {
          if (hitShown || !notchHitWin || notchHitWin.isDestroyed()) return
          hitShown = true
          notchHitWin.showInactive()
          // Re-assert the rect AFTER show: macOS clamps a fresh window's y into the work area (below the menu bar),
          // which dropped the catcher ~34px below the physical notch onto the content (it stole clicks from browser
          // tabs). enableLargerThanScreen + this setBounds put it back over the notch; re-assert once more after the
          // clamp settles (matches the main overlay's 700ms re-assert).
          notchHitWin.setBounds(rect)
          notchHitWin.setIgnoreMouseEvents(notchOverlayInteractive, { forward: true })
          setTimeout(() => { try { if (notchHitWin && !notchHitWin.isDestroyed()) notchHitWin.setBounds(rect) } catch { /* destroyed */ } }, 800)
        }
        notchHitWin.once('ready-to-show', showHit)
        setTimeout(showHit, 1500) // fallback: a missed ready-to-show must never leave the click/hover catcher hidden
        notchHitWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(NOTCH_HIT_HTML))
      } else {
        notchHitWin.setBounds(rect)
        notchHitWin.setAlwaysOnTop(true, 'screen-saver', 1)
        notchHitWin.showInactive()
        notchHitWin.setIgnoreMouseEvents(notchOverlayInteractive, { forward: true })
      }
    }
    const refreshNotch = async (): Promise<void> => {
      notchGeom = await readNotchGeometry()
      console.log(`[notch] hasNotch=${!!notchGeom?.hasNotch} synthetic=${isSyntheticMode()}${isSyntheticMode() ? ' (VM / notch-less → island pinned open, no retract)' : ''}`)
      updateNotchHitWindow()
      pushNotchGeometry()
      // Show the window AFTER geometry is pushed (once only — display-change refreshes skip this).
      // The renderer's CSS also hides #root-canvas until notch-mode kicks in (belt-and-suspenders).
      if (!notchWindowShown && mainWindow && !mainWindow.isDestroyed()) {
        notchWindowShown = true
        showNotchOverlay(mainWindow)
      }
    }
    // Forward the hit-window's click/hover to the overlay renderer (click → toggle fullscreen, hover → panel).
    ipcMain.on('os:notch-click', () => { try { mainWindow?.webContents.send('os:notch-handle-click') } catch { /* mid-teardown */ } })
    ipcMain.on('os:notch-hover', (_e, on: boolean) => { try { mainWindow?.webContents.send('os:notch-handle-hover', !!on) } catch { /* mid-teardown */ } })
    if (mainWindow) {
      if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', () => void refreshNotch())
      else void refreshNotch()
      mainWindow.on('closed', () => { mainWindow = null; if (notchHitWin && !notchHitWin.isDestroyed()) notchHitWin.destroy() })
    }
    app.on('before-quit', () => { if (notchHitWin && !notchHitWin.isDestroyed()) notchHitWin.destroy() })
    screen.on('display-metrics-changed', () => void refreshNotch())
    // ⌥Space toggles the notch (expand/collapse), sent to the renderer. The accelerator is rebindable in Settings,
    // persisted in userData/keybinds.json and re-registered live via os:keybind:set. register() returns false only on
    // a collision with another globalShortcut in THIS process (e.g. a leftover dev instance); log + continue.
    const keybindsFile = (): string => join(app.getPath('userData'), 'keybinds.json')
    const readNotchToggleAccel = (): string => {
      try {
        const parsed = JSON.parse(readFileSync(keybindsFile(), 'utf8')) as { notchToggle?: unknown }
        return typeof parsed?.notchToggle === 'string' && parsed.notchToggle.trim() ? parsed.notchToggle : 'Alt+Space'
      } catch {
        return 'Alt+Space'
      }
    }
    const registerNotchToggle = (accel: string): boolean => {
      try { if (notchToggleAccel) globalShortcut.unregister(notchToggleAccel) } catch { /* ignore */ }
      try {
        const ok = globalShortcut.register(accel, () => { try { mainWindow?.webContents.send('os:notch-toggle') } catch { /* mid-teardown */ } })
        if (ok) notchToggleAccel = accel
        return ok
      } catch {
        return false // malformed accelerator
      }
    }
    notchToggleAccel = readNotchToggleAccel()
    if (!registerNotchToggle(notchToggleAccel)) {
      console.error(`[notch] could not register ${notchToggleAccel} — already held by another globalShortcut in this process`)
    }
    ipcMain.handle('os:keybind:get', () => ({ notchToggle: notchToggleAccel }))
    ipcMain.handle('os:keybind:set', (_e, accel: unknown) => {
      if (typeof accel !== 'string' || !accel.trim()) return { ok: false, notchToggle: notchToggleAccel }
      const prev = notchToggleAccel
      if (registerNotchToggle(accel)) {
        try {
          mkdirSync(app.getPath('userData'), { recursive: true })
          writeFileSync(keybindsFile(), JSON.stringify({ notchToggle: accel }, null, 2))
        } catch { /* best-effort — worst case it reverts to the default next launch */ }
        return { ok: true, notchToggle: accel }
      }
      registerNotchToggle(prev) // the new chord failed to bind (collision/invalid) → restore the previous one
      return { ok: false, notchToggle: notchToggleAccel }
    })
    // While Settings is capturing a new combo, release the shortcut so the renderer actually receives the keys
    // (a registered globalShortcut otherwise swallows them OS-wide, including the current ⌥Space). Re-armed on cancel.
    ipcMain.handle('os:keybind:suspend', (_e, on: unknown) => {
      try {
        if (on) { if (notchToggleAccel) globalShortcut.unregister(notchToggleAccel) }
        else registerNotchToggle(notchToggleAccel)
      } catch { /* ignore */ }
      return { ok: true }
    })
  }

  // The legacy native BlitzIsland.app (BLITZ_NATIVE_ISLAND=1) is a SEPARATE path with its OWN Carbon ⌥Space chord +
  // WS bridge (wired below). useNativeIsland gates its launch; it is mutually exclusive with the notch above
  // (notchGated already requires BLITZ_NATIVE_ISLAND !== '1'), so ⌥Space is never double-owned.
  const useNativeIsland = process.platform === 'darwin' && process.env.BLITZ_NATIVE_ISLAND === '1'

  // BlitzIsland ↔ control-server bridge (plans/blitzos-dynamic-island.md): wire the notch HUD's process tabs
  // to the live agents. island-bridge.mjs stays pure-node + dependency-injected; ALL electron/osActions calls
  // live HERE in realDeps. Set BEFORE startControlServer() — control-server's attachIslandWebSocket reads the
  // injected deps lazily at connect time, so they must be in place first (a connect that races ahead degrades
  // to the no-op default, never throws). Do NOT edit osActions.ts/electron-os-tools.ts (CALL the seams only).
  //
  // Status vocabulary: the host CHAT_STATUSES (idle|starting|working|watching|waiting|stopped|error) maps to
  // the island contract (new|working|waiting|idle|stopped|error). Mapping is a runtime concern (keeps the
  // bridge vocabulary-free): starting→new (just spawned, no first reply), watching→idle (the island has no
  // "watching"), the rest pass through.
  const islandStatusToState = (s: unknown): string =>
    ({ starting: 'new', watching: 'idle', working: 'working', waiting: 'waiting', idle: 'idle', stopped: 'stopped', error: 'error' } as Record<string, string>)[String(s || 'idle')] || 'idle'
  // The title for an agent id from the live state: the chat surface carries the agent's title; '0' is 'Blitz'.
  // There is no automatic re-titling in the host today (titles are 'Chat'/'Chat N' or an explicit rename) —
  // titleForAgent reflects the CURRENT title and the tail emits a process.upsert{title} only on an EDGE, so
  // an auto-naming feature would flow through unchanged without inventing a transition the host never emits.
  const titleForAgent = (id: string): string => {
    if (String(id) === '0') return 'Blitz'
    try {
      const s = osGetState().surfaces || []
      const hit = s.find((x) => String(x.agentId ?? '') === String(id) && (x.component === 'chat' || x.id === `chat-${id}`))
      if (hit?.title) return String(hit.title)
    } catch {
      /* fall through */
    }
    return 'New Agent'
  }
  // Prepended ONCE to the SPAWN seed (NOT on every message — context bloat). Concise island persona.
  const ISLAND_PREAMBLE = 'You are running in the BlitzOS notch island. Answer concisely — short status lines the user can read at a glance in a small HUD.'
  const pathsFooter = (paths?: string[]): string =>
    Array.isArray(paths) && paths.length ? `\n\nContext (dropped on the island):\n${paths.map((p) => `- ${p}`).join('\n')}` : ''
  // The active workspace NAME — the key for island-membership's per-workspace set (Map<wsName,Set<id>>). NAME
  // not path: A's '1' and B's '1' must hash to different sets, and the recorder + the read gate must agree on
  // the same bucket. osWorkspaceContext() is already imported (L6); fall back to '' (the global bucket) if the
  // context throws (a connect that races ahead of workspace init degrades to an empty island, never crashes).
  const islandActiveWs = (): string => {
    try {
      return osWorkspaceContext().workspace || ''
    } catch {
      return ''
    }
  }

  // The chat TAIL: a pure-node poller emitting reply LINES + status/auto-name UPSERTS. Chat files live in a
  // PRIVATE per-agent dir, named by chatFileName(id) ('.blitzos/agents/<id>/chat.md' — relocated out of the
  // shared root for cross-agent isolation; see plans/blitzos-agent-chat-isolation.md), written by appendChatMessage
  // (workspace.mjs). NOT under .blitzos/terminals/<id>/ (that's the raw TUI tape, a different stream). Poll
  // (700ms) over fs.watch on purpose: a workspace switch changes the file set + paths wholesale, and the
  // chat file is atomic-created then appendFileSync-grown — both break a single long-lived watch. seed()
  // primes offsets to EOF so boot/reconnect does NOT replay history into the HUD.
  const startChatTail = (cb: (ev: { id?: string; line?: { at: number; text: string }; upsert?: { title?: string; state?: string }; list?: Array<{ id: string; title: string; state: string }> }) => void): (() => void) => {
    const offsets = new Map<string, number>() // file abs path -> bytes already consumed
    const lastStatus = new Map<string, string>() // id -> island-state (emit upsert only on EDGE)
    const lastTitle = new Map<string, string>() // id -> last seen title (auto-name edge)
    let lastIds = '' // sorted, joined id set the island last knows about (membership delta -> {list} re-snapshot)
    let lastWsPath = '' // active-workspace path the last tick observed (a switch must re-snapshot the new set)
    let stopped = false

    // Parse agent turns appended after the consumed offset; emit one HUD line per new agent turn (collapsed
    // to its first non-empty line — the island click-expands the full text). The header regex mirrors
    // readChatMessages (tolerates the optional ` · <ts>` and ` · a:<base64>` annotation). A half-written
    // final block self-heals next poll because blocks are re-keyed by header byte offset >= the consumed one.
    const drainFile = (abs: string, id: string): void => {
      let raw = ''
      try {
        raw = readFileSync(abs, 'utf8')
      } catch {
        return
      }
      // FIRST SIGHT of a chat file = a seed point, NOT a replay: prime the offset to EOF and emit nothing.
      // seed() only primes the files of agents present at subscribe time; a workspace switch points tick() at
      // a DIFFERENT file set (paths include the now-active wsPath) whose offsets were never primed. Treating an
      // unseen file's offset as 0 would parse every historical '### agent' mark and dump the whole history into
      // the HUD on switch. `.has` distinguishes "never seen" (prime) from a real consumed-0 offset (drain).
      if (!offsets.has(abs)) {
        offsets.set(abs, raw.length)
        return
      }
      const prev = offsets.get(abs) || 0
      if (raw.length <= prev) {
        offsets.set(abs, raw.length)
        return
      }
      const re = /^### (user|agent)(?: · (\d+))?(?: · a:[A-Za-z0-9+/=]+)?[ \t]*$/gm
      const marks: Array<{ role: string; ts: number; start: number; end: number }> = []
      let m: RegExpExecArray | null
      while ((m = re.exec(raw))) marks.push({ role: m[1], ts: Number(m[2]) || 0, start: m.index, end: re.lastIndex })
      for (let i = 0; i < marks.length; i++) {
        if (marks[i].start < prev) continue // already emitted on a prior tick
        if (marks[i].role !== 'agent') continue // the island shows REPLIES only (user turns are the human's echoes)
        const body = raw.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : raw.length).replace(/^\n+|\n+$/g, '')
        if (!body) continue
        const at = marks[i].ts || Date.now() // the runtime stamps time; island-bridge stays time-free
        const firstLine = body.split('\n').find((l) => l.trim()) || body
        cb({ id, line: { at, text: firstLine.trim() } })
      }
      offsets.set(abs, raw.length)
    }

    const tick = (): void => {
      if (stopped) return
      let wsPath = ''
      let wsActive = ''
      try {
        const ctx = osWorkspaceContext()
        wsPath = ctx.workspace_path || ''
        wsActive = ctx.workspace || ''
      } catch {
        wsPath = ''
        wsActive = ''
      }
      const statusMap = (() => {
        try {
          return osAgentStatus() || {}
        } catch {
          return {}
        }
      })()
      // Prune island ids no longer live — but ONLY for the ACTIVE workspace (closeAgent operates on the active
      // ws and deletes its agent dir first, so a same-ws close is observable here). This closes the same-ws
      // id-reuse hole (a reissued id won't be falsely owned) WITHOUT dropping an island agent merely sitting in
      // another workspace (intersect-not-prune for those — they reappear on switch-back). statusMap is the
      // workspace-scoped osAgentStatus() (agentIds() = the active ws's terminals + '0').
      pruneIslandIds(wsActive, statusMap)
      // GATE the whole tick through the island set: ids = only island-spawned ids of the active ws that are
      // currently live. Everything downstream — the membership-delta {list}, per-id status/title upserts, and
      // drainFile(join(wsPath, chatFileName(id))) — iterates ONLY these, so the tail never opens '0's chat.md
      // or a sibling's. This also HARDENS the Swift adoption: the {list} now contains ONLY island ids, so the
      // first previously-unseen id main.swift adopts the local draft onto is always the just-spawned island id,
      // never '0'/a sibling. (Honesty wart: a stray process.message/orchestrators for a pruned/closed id still
      // reaches opUserMessage/opSetOrchestrators — a stray chat.md write / no-op on an unknown agent; NOT gated
      // here because a per-message membership check would race a legit just-spawned id. Known, not claimed safe.)
      const ids = islandLiveIds(wsActive, statusMap)
      // MEMBERSHIP delta -> a FULL {list} re-snapshot. osAgentStatus() drops a closed agent's id (closeAgent
      // does chatStatuses.delete) and a workspace switch swaps the whole set wholesale, but per-id upserts can
      // only ADD/edit — they can never tell the island an id VANISHED. Without this, a closed agent's chip, and
      // on a switch the entire previous workspace's agents, linger in the notch HUD forever (the island only GCs
      // stale ids inside applyList, reached ONLY on a process.list frame). Re-snapshot on any add/remove OR a
      // workspace change so the island's applyList prunes the dead chips. The {list} shape mirrors listProcesses.
      const idsKey = ids.slice().sort().join(' ')
      if (idsKey !== lastIds || wsPath !== lastWsPath) {
        lastIds = idsKey
        lastWsPath = wsPath
        cb({ list: ids.map((id) => ({ id, title: titleForAgent(id), state: islandStatusToState(statusMap[id]) })) })
      }
      for (const id of ids) {
        // status edge -> upsert
        const stState = islandStatusToState(statusMap[id])
        if (lastStatus.get(id) !== stState) {
          lastStatus.set(id, stState)
          cb({ id, upsert: { state: stState } })
        }
        // auto-name edge -> upsert
        const tt = titleForAgent(id)
        if (tt && lastTitle.get(id) !== tt) {
          lastTitle.set(id, tt)
          cb({ id, upsert: { title: tt } })
        }
        // reply lines
        if (wsPath) drainFile(join(wsPath, chatFileName(id)), id)
      }
    }

    // Seed offsets to current EOF + prime status/title WITHOUT emitting (the HUD starts from "now").
    const seed = (): void => {
      if (stopped) return
      let wsPath = ''
      let wsActive = ''
      try {
        const ctx = osWorkspaceContext()
        wsPath = ctx.workspace_path || ''
        wsActive = ctx.workspace || ''
      } catch {
        wsPath = ''
        wsActive = ''
      }
      const statusMap = (() => {
        try {
          return osAgentStatus() || {}
        } catch {
          return {}
        }
      })()
      // FILTERED baseline: only island-spawned ids of the active ws. This matches the connect-time
      // listProcesses() snapshot (also islandLiveIds-gated) so the first tick after subscribe emits NO
      // redundant {list}, AND it closes the boot-time half of the leak — no '0' chat.md offset is primed, so
      // the primary conversation's history can never replay into the HUD on subscribe.
      const ids = islandLiveIds(wsActive, statusMap)
      lastIds = ids.slice().sort().join(' ')
      lastWsPath = wsPath
      for (const id of ids) {
        lastStatus.set(id, islandStatusToState(statusMap[id]))
        lastTitle.set(id, titleForAgent(id))
        if (wsPath) {
          try {
            offsets.set(join(wsPath, chatFileName(id)), statSync(join(wsPath, chatFileName(id))).size)
          } catch {
            /* missing → primed lazily on drainFile's first-sight branch; seed primed status so no history replays */
          }
        }
      }
    }
    seed()

    const timer = setInterval(tick, 700)
    timer.unref?.() // never hold the process / a test open
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  // electronOps is typed as Record<string, (...args:never[])=>unknown> (the shared registry erases precise
  // signatures), so cast each method to its real shape at the call site — exactly how wireLauncher casts
  // startWorkflow above. These are the VERIFIED seams (job-model retired): spawnAgent(title)->{id,title};
  // startWorkflow({task,contextRefs,title})->{ok,agent:{id,title}}; userMessage(text,id) WRITES chat.md AND
  // wakes (NOT emitUserMessage); setOrchestrators(id,on) flips live.
  const opSpawnAgent = electronOps.spawnAgent as unknown as (title?: string) => { id: string; title: string }
  const opStartWorkflow = electronOps.startWorkflow as unknown as (s: { task: string; contextRefs?: string[]; title?: string }) => { ok?: boolean; agent?: { id: string; title?: string }; error?: string }
  const opUserMessage = electronOps.userMessage as unknown as (text: string, agentId?: string) => void
  const opSetOrchestrators = electronOps.setOrchestrators as unknown as (id: string, on: boolean) => unknown
  const realDeps = {
    // Send. orchestrators=false (DEFAULT): conversational spawn-OFF; true: heavy task spawn-ON (orchestrators
    // capability). startWorkflow returns {ok, agent:{id,title}} — unwrap .agent; spawnAgent returns {id,title}.
    spawn: ({ prompt, paths, orchestrators }: { prompt: string; paths: string[]; orchestrators: boolean }): { id: string; title: string } => {
      if (orchestrators) {
        const r = opStartWorkflow({ task: `${ISLAND_PREAMBLE}\n\n${prompt || ''}`, contextRefs: paths, title: undefined })
        // RECORD the new id into the ACTIVE workspace's island set so the tail/list will list+tail it (and
        // ONLY it + its island siblings). A failed spawn ({id:''}) is skipped by recordIslandId's own guard.
        const a = r?.agent ? { id: String(r.agent.id), title: String(r.agent.title ?? '') } : { id: '', title: '' }
        if (a.id) recordIslandId(islandActiveWs(), a.id)
        return a
      }
      const a = opSpawnAgent(undefined) // {id, title}; auto-named later
      try {
        opUserMessage(`${ISLAND_PREAMBLE}\n\n${prompt || ''}${pathsFooter(paths)}`, a.id)
      } catch {
        /* boots with its duty; the seed lands when chat.md is read */
      }
      // Record AFTER the seed so ordering is unchanged; the bridge's optimistic upsert (id carried already)
      // shows the chip instantly, and by the next 700ms tick this id is a member and converges via {list}.
      if (a.id) recordIslandId(islandActiveWs(), a.id)
      return a
    },
    // Continue a tab. NO preamble (once-only on spawn). userMessage WRITES chat.md AND wakes (NOT emitUserMessage).
    message: ({ id, text, paths }: { id: string; text: string; paths: string[] }): void => {
      opUserMessage(`${text || ''}${pathsFooter(paths)}`, id)
    },
    // Flip the toggle live (no restart).
    setOrchestrators: (id: string, on: boolean): void => {
      opSetOrchestrators(id, !!on)
    },
    // The list: agentStatus is the authority on WHICH agents exist + their status; titles from the chat surface.
    // GATED through islandLiveIds so the connect-time snapshot lists ONLY island-spawned ids of the active
    // workspace — never '0' (the user's main canvas chat) or a sibling peer. islandLiveIds ⊆ st keys, so
    // st[id] is always defined.
    listProcesses: (): Array<{ id: string; title: string; state: string }> => {
      const st = osAgentStatus() || {}
      return islandLiveIds(islandActiveWs(), st).map((id) => ({ id, title: titleForAgent(id), state: islandStatusToState(st[id]) }))
    },
    // REPLIES + status/auto-name. Tail each agent's chat.md for NEW agent turns; poll agentStatus for upserts.
    subscribeEvents: (cb: (ev: { id?: string; line?: { at: number; text: string }; upsert?: { title?: string; state?: string }; list?: Array<{ id: string; title: string; state: string }> }) => void): (() => void) => startChatTail(cb)
  }
  setIslandDeps(realDeps)

  // ── Self-healing agent wake recovery (plans/blitzos-agent-wake-recovery.md) ───────────────────────────────
  // Agent wake-up is pull-only: each agent must keep a background .blitzos/wait.sh long-polling /events. If its
  // turn dies before relaunching wait.sh (a rate-limit 429, a crash mid-turn), it goes deaf and the user's island
  // messages pile up unread while the island shows a bare "Idle". perception-core flags such an undelivered
  // message; this watchdog confirms the pane is FROZEN (idle, not mid-turn) and types a catch-up nudge into its
  // tmux pane so it self-heals via its own /events ritual — the user never touches tmux. While reviving, the
  // island shows 'reconnecting' (the override self-clears the instant the agent's heartbeat resumes).
  const wakeOverride = new Map<string, { status: string; since: number; ws: string | null }>()
  const wakeKey = (id: string, ws: string | null): string => `${ws == null ? '' : ws}/${id}`
  // Apply the live override to a host-status map for workspace `wsName` (returns the same ref when nothing applies).
  // An override SELF-CLEARS once lastPollAt (the wait-loop heartbeat) advances past when it was set, so a recovered
  // agent shows its real status with no clear-race.
  const applyWakeOverride = (status: Record<string, string>, wsName: string): Record<string, string> => {
    if (wakeOverride.size === 0) return status
    let out: Record<string, string> | null = null
    for (const [k, ov] of [...wakeOverride]) {
      if ((ov.ws == null ? '' : ov.ws) !== wsName) continue
      const id = k.slice(k.indexOf('/') + 1)
      if (lastPollAt(id, ov.ws) >= ov.since) { wakeOverride.delete(k); continue } // heartbeat resumed → drop
      if (!out) out = { ...status }
      out[id] = ov.status
    }
    return out || status
  }
  // A deaf agent emits no chat broadcast of its own, so the watchdog drives the live island status when it flips
  // an agent to 'reconnecting' (or clears it). Sends the full active-ws status map (the island replaces wholesale).
  const pushIslandStatus = (): void => {
    try { osBroadcast({ type: 'chat', status: applyWakeOverride(osAgentStatus() || {}, islandActiveWs()) }) } catch { /* best-effort */ }
  }
  // Set (or clear) an agent's island status OVERRIDE (e.g. 'reconnecting'). Used by the wake-watchdog while it
  // revives a deaf agent, and by the debug status-simulation handler below. Self-clears once the agent's heartbeat
  // advances past `since` (see applyWakeOverride).
  const setWakeStatus = (id: string, ws: string | null, st: string | null): void => {
    const k = wakeKey(String(id), ws)
    if (st) wakeOverride.set(k, { status: st, since: Date.now(), ws })
    else wakeOverride.delete(k)
    pushIslandStatus()
  }
  const wakeWatchdog = createWakeWatchdog({
    lastPollAt,
    sendToTerminal: (id, data) => electronTerminalOps.sendToTerminal(String(id), String(data)),
    captureTerminal: (id) => electronTerminalOps.captureTerminal(String(id)),
    isLive: (id) => isRecoverableAgentPane(String(id)),
    setStatus: setWakeStatus,
    // A terminal-only Claude Code auth 401 (never in the JSONL): drop any stale 'reconnecting' override so the real
    // sticky 'error' shows, then surface the "Not signed in" card via the same setChatStatus path as a JSONL error.
    onAuthError: (id, ws) => { setWakeStatus(String(id), ws, null); osSurfaceChatError(String(id), 'auth') },
    log: (m) => console.log('[wake]', m)
  })
  // DEBUG (Settings → Simulate agent status): inject a fake status onto an agent so the four status surfaces (home
  // card, glance bar, chat chip, inline detail) can be eyeballed without a real failure. A genuine failure
  // ('error') goes through the REAL setChatStatus path (sticky red, clears on the next real user message); a
  // transient throttle ('reconnecting') uses the same wake-override the watchdog drives. No persistence — it's a
  // live status push only, so a relaunch starts clean.
  ipcMain.handle('os:debug-force-status', (_e, payload: { agentId?: unknown; kind?: unknown }) => {
    try {
      const id = String(payload?.agentId ?? '0')
      const kind = String(payload?.kind ?? '') // 'off' | 'reconnecting' | a classifyApiError cause (connection/usage-limit/…)
      const ws = islandActiveWs()
      if (kind === 'reconnecting') {
        setWakeStatus(id, ws, 'reconnecting')
      } else if (kind && kind !== 'off') {
        // any cause → the real sticky 'error' status + that cause's detail (mirrors applyClaudeTurnError).
        setWakeStatus(id, ws, null) // drop any stale override so the real 'error' shows through
        osDebugSetChatStatus(id, 'error', kind)
      } else {
        // 'off' → clear back to a live state
        setWakeStatus(id, ws, null)
        osDebugSetChatStatus(id, 'watching')
      }
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })
  setUndeliveredWakeHook((moment) => { try { wakeWatchdog.onUndelivered(moment) } catch { /* never break perception */ } })
  // PROACTIVE sweep: a usage/session limit an agent hits on its OWN turn surfaces no undelivered message, so the
  // reactive hook above never sees it. Every SWEEP_MS, peek each live agent's pane; a usage-limit-with-reset arms a
  // scheduled resume (parse the reset time → type a resume directive once it lifts). Content-agnostic; the watchdog
  // classifies. Enumerate the active workspace's agents (the same id->status map the island renders).
  const SWEEP_MS = 45_000
  const wakeSweep = setInterval(() => {
    try {
      const ws = islandActiveWs()
      const ids = Object.keys(osAgentStatus() || {})
      if (ids.length) wakeWatchdog.sweep(ids.map((id) => ({ agentId: id, workspace: ws })))
    } catch { /* never break the sweep */ }
  }, SWEEP_MS)
  if (typeof wakeSweep.unref === 'function') wakeSweep.unref()
  app.on('before-quit', () => { try { wakeWatchdog.stop(); clearInterval(wakeSweep) } catch { /* ignore */ } })

  // Local agent path: a localhost HTTP control API.
  startControlServer()

  // Legacy native dynamic island (BlitzIsland.app): the faceless ⌥Space notch HUD. SUPERSEDED by the new
  // Electron notch-spill island (island.ts) per plans/blitzos-dynamic-island.md, so it is OFF by default and
  // launched ONLY when BLITZ_NATIVE_ISLAND=1 (useNativeIsland) — never alongside the Electron island, because
  // both register the SAME ⌥Space chord (this one via Carbon RegisterEventHotKey in main.swift, the Electron one
  // via globalShortcut, independent OS mechanisms that would BOTH fire). Launching it unconditionally was the
  // double-fire bug. When it IS launched, its /island WS is mounted on the control server above; it self-discovers
  // our URL + bearer token FRESH from ~/.blitzos/session.json on every backoff attempt, so launching it right
  // after startControlServer is safe even if the listen callback (which writes session.json) hasn't fired yet —
  // the first connect simply retries. Path resolution lives HERE (electron) so island-bridge.mjs stays
  // electron-free; the resolved string is passed to launchIslandHelper. macOS-only (a no-op handle elsewhere).
  if (useNativeIsland) {
    const islandAppPath = ((): string => {
      const rel = ['native', 'island-helper', 'build', 'BlitzIsland.app']
      const candidates = [
        process.env.BLITZ_ISLAND_APP, // explicit override (mirrors BLITZ_COMPUTER_USE_APP)
        app.isPackaged ? join(process.resourcesPath, 'BlitzIsland.app') : null, // packaged: electron-builder extraResources
        join(app.getAppPath(), ...rel),
        join(__dirname, '..', '..', ...rel), // out/main → repo root in dev
        !app.isPackaged ? join(process.cwd(), ...rel) : null // electron-vite dev runs with cwd = repo root
      ].filter((p): p is string => !!p)
      for (const c of candidates) {
        try {
          if (existsSync(c)) return c
        } catch {
          /* skip */
        }
      }
      return candidates[candidates.length - 1] ?? join(app.getAppPath(), ...rel)
    })()
    islandHelper = launchIslandHelper(islandAppPath)
  }

  // Remote agent path: connect to the agent-socket relay (SHARED self-healing lifecycle in relay.mjs — same
  // module the server uses, so it can't diverge) and mint a paste-able URL so any AI chat can drive BlitzOS.
  // On every URL change we refresh .blitzos/relay-url so the running agent terminals (which re-read it per
  // call) self-heal onto the fresh url — no privileged brain to restart.
  startAgentSocket(() => mainWindow, (url) => osSetRelayUrl(url))
  setTerminalGetUrl(() => getAgentSocketUrl()) // so a dead agent's re-exec rebuilds its command with the live url

  // Connections — the user's browser tabs (Chrome + Safari via Apple Events, extension-free) and macOS windows
  // (via the computer-use helper) each become a per-source tool provider (connection_* tools + a widget).
  // Persisted connections are auto-rebound to their still-open tab/window by the boot-time restore below.
  // The extension-free Blitz Chrome (blitz-chrome.ts) registers each opened window as a first-class TAB connection
  // through this same registry, so the whole connection_* toolset (run_js / read / act / save_tool / registry) drives
  // it with no parallel API and no extension. blitz_chrome_open returns the { connId } the agent then drives.
  blitzChrome().setConnectionOps(electronConnections)
  app.on('before-quit', () => {
    // Blitz Chrome (blitz-chrome.ts, driven over --remote-debugging-port) is lazily launched on the first
    // blitz_chrome_* call; quit it here so a supervised Chrome never outlives the app.
    try {
      blitzChrome().shutdown()
    } catch {
      /* ignore */
    }
  })
  // Restore persisted connections once shortly after boot — re-bind every saved tab (Chrome/Safari via Apple
  // Events) and window (the computer-use helper) connection to its still-open source. The helper is prewarmed.
  setTimeout(() => void electronConnections.connectionRestoreAll().catch(() => {}), 6000)
  // MCP connections have NO representation surface (the token store is their persistence), so connectionRestoreAll
  // (which scans getSurfaces) can't reach them — re-establish each previously-approved MCP source from its kept
  // refresh_token, with no human step. Idempotent; a source whose refresh fails lands 'error'/'reauth'.
  setTimeout(() => void electronConnections.mcpRestoreAll().then((r: { restored: number; total: number }) => r && r.total && console.log(`[blitzos] MCP connections restored: ${r.restored}/${r.total}`)).catch(() => {}), 6500)

  // Window connect (macOS-local only): the BlitzOS helper IS the window adapter (AX + vision +
  // CGEvent). It's ensured lazily on the first window op (it holds the Accessibility + Screen-Recording grants).
  electronConnections.setWindowLink(makeWindowLink({ connectionOps: electronConnections, helper: computerUseHelper() }))
  // Window-picker drops: route by WHAT landed (browser-ness by bundleId), not just by whether bounds matched.
  // A Google Chrome window resolves to its ACTIVE TAB (Apple Events, matched by on-screen BOUNDS — see
  // matchChromeTabByBounds below), so the agent gets the real page. A NON-Chrome window (another browser or a plain
  // app) connects as a native WINDOW through the computer-use helper (AX tree + screenshot + coordinate clicks).
  // Google Chrome is driven EXTENSION-FREE: its tabs come via Apple Events (connection-chrome-applescript-link →
  // connection_list_tabs as browser:'chrome', ids `chrome:<window>:<tab>`). A dropped Chrome window has only a
  // CGWindowID + on-screen bounds; we bridge to Chrome's tab vocabulary by BOUNDS. Ask Chrome (osascript) for each
  // window's bounds + active tab index, pick the window whose on-screen rect matches the drop, and return that
  // window's ACTIVE tab as `chrome:W:T`. The drop then connects through connectionConnectTab (which routes `chrome:`
  // ids to the Apple-Events adapter), so the agent gets the REAL page, not a whole-window AX grab. Returns null if
  // Chrome isn't scriptable yet (Automation not granted) or no window matches, in which case the caller falls back to
  // a window connect. Scoped to Google Chrome only: the AppleScript targets "Google Chrome"; other Chromium browsers
  // (Brave/Edge/Arc) have no Apple-Events tab adapter, so they connect as a window instead.
  // TODO(blitzos-chrome-pid-targeting): this still uses `tell application "Google Chrome"`, so it shares the
  // Blitz-Chrome bundle-id collision (it can match against the wrong instance). Lower stakes than the live tab path
  // (drop-time, user-initiated, transient) — fold it onto a PID-pinned helper RPC as a follow-up.
  const matchChromeTabByBounds = async (b: { x: number; y: number; w: number; h: number }): Promise<string | null> => {
    const osaArgs = [
      '-e', 'on run',
      '-e', 'tell application "Google Chrome"',
      '-e', 'if (count of windows) is 0 then return ""',
      '-e', 'set out to ""',
      '-e', 'repeat with w from 1 to count of windows',
      '-e', 'try',
      '-e', 'set bnds to bounds of window w',
      '-e', 'set out to out & w & "|" & (item 1 of bnds) & "|" & (item 2 of bnds) & "|" & (item 3 of bnds) & "|" & (item 4 of bnds) & "|" & (active tab index of window w) & linefeed',
      '-e', 'end try',
      '-e', 'end repeat',
      '-e', 'return out',
      '-e', 'end tell',
      '-e', 'end run'
    ]
    // Route the Chrome AppleScript THROUGH the helper so the "control Google Chrome" Automation grant stays on the
    // helper (granted in onboarding). A direct Electron osascript here runs as BlitzOS and RE-PROMPTS. There is NO
    // direct-osascript fallback: if the helper can't run it, return '' → the caller connects the dropped window as a
    // plain window (computer-use helper AX, no Apple Event), so a missing helper never raises a BlitzOS TCC prompt.
    const helper = computerUseHelper()
    if (helper.available() && !helper.connected()) await helper.ensure().catch(() => {})
    const run = async (): Promise<string> => {
      if (!helper.connected()) return ''
      const r = await helper.call('osa', { args: osaArgs }, 10000)
      return r.error ? '' : String(r.stdout || '')
    }
    const matchOnce = async (): Promise<string | null> => {
      const out = await run()
      let best: { id: string; score: number } | null = null
      for (const line of out.split('\n')) {
        // windowIndex|left|top|right|bottom|activeTabIndex (Chrome bounds are top-left-origin points, same frame as the drop).
        const p = line.split('|')
        if (p.length < 6) continue
        const wIdx = Number(p[0]); const left = Number(p[1]); const top = Number(p[2]); const right = Number(p[3]); const bottom = Number(p[4]); const tIdx = Number(p[5])
        if (!Number.isFinite(wIdx) || !Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom) || !Number.isFinite(tIdx)) continue
        const score = Math.abs(left - b.x) + Math.abs(top - b.y) + Math.abs(right - left - b.w) + Math.abs(bottom - top - b.h)
        if (!best || score < best.score) best = { id: `chrome:${wIdx}:${tIdx}`, score }
      }
      return best && best.score <= 120 ? best.id : null // ~120pt total slack covers the title bar + rounding (same as the extension match)
    }
    // Brief retry: Chrome's window list can lag a just-finished drag for a beat.
    for (let i = 0; i < 3; i++) {
      const id = await matchOnce()
      if (id) return id
      if (i < 2) await new Promise((r) => setTimeout(r, 300))
    }
    return null
  }
  // A dropped Google Chrome window (the extension-free path). bundleId is authoritative; the app-name backstop only
  // fires when the helper couldn't read a bundleId. Other Chromium browsers are intentionally excluded (the
  // Apple-Events adapter only scripts "Google Chrome").
  const isGoogleChrome = (bundleId: string, app: string): boolean => {
    const b = bundleId.toLowerCase()
    if (b) return b === 'com.google.chrome' || b.startsWith('com.google.chrome.')
    return /\bgoogle chrome\b/.test(app.toLowerCase())
  }
  const isSafariApp = (bundleId: string, app: string): boolean => {
    const b = bundleId.toLowerCase()
    if (b) return b === 'com.apple.safari'
    return app.toLowerCase() === 'safari'
  }
  const droppedBrowser = (bundleId: string, app: string): 'chrome' | 'safari' | undefined =>
    isGoogleChrome(bundleId, app) ? 'chrome' : isSafariApp(bundleId, app) ? 'safari' : undefined
  computerUseHelper().onEvent((m) => {
    const kind = m?.kind
    if (kind === 'pick_drop' && typeof m.windowId === 'number') {
      const bounds = { x: Number(m.x) || 0, y: Number(m.y) || 0, w: Number(m.w) || 0, h: Number(m.h) || 0 }
      const app = String(m.app || '')
      const bundleId = String(m.bundleId || '')
      // Show the dropped app's icon in the dropbox INSTANTLY (optimistic), before the async tab-resolve + connect
      // (a Chrome bounds-match can take a beat). The `connected` event below firms up the real connId.
      mainWindow?.webContents.send('os:pick-event', { kind: 'dropped', windowId: m.windowId, app, icon: m.icon, title: String(m.title || '') })
      // ONE terminal-event emit point: it ALWAYS stamps windowId (+ the drop's identity), so the renderer can clear
      // its optimistic placeholder no matter which branch ends the drop (success, loud error, or a thrown connect).
      const finish = (extra: Record<string, unknown>): void => {
        // P0: a FAILED drop carries the permission it needs (Accessibility for a window, control-<browser> for a
        // browser tab) so the dropbox can show the inline grant screen (Give permission / Don't) instead of just a
        // red error. permissionFromError maps the raw failure; grantForConnection is the up-front fallback.
        const browser = droppedBrowser(bundleId, app)
        const permission =
          extra.permission !== undefined
            ? extra.permission
            : extra.ok === false
              ? permissionFromError(extra.error, browser) || grantForConnection({ type: browser ? 'tab' : 'window', browser })
              : null
        mainWindow?.webContents.send('os:pick-event', { kind: 'connected', windowId: m.windowId, pid: m.pid, app, bundleId, title: String(m.title || ''), icon: m.icon, permission, ...extra })
      }
      void (async () => {
        // A browser drop (Chrome/Safari) connects a TAB (Apple Events) so the agent gets the real page. If the
        // browser's Automation isn't granted, show the inline grant card in the dropbox — NEVER silently fall back to
        // a window connect (the confusing bug the user hit). A plain app connects as a window via the helper (AX).
        const browser = droppedBrowser(bundleId, app)
        let res: { error?: string; connId?: string } | undefined
        let action: 'tab' | 'window' | 'grant' = 'window'
        if (browser) {
          // STOP the picker overlay FIRST (awaited — it was intercepting clicks). We do NOT veil here: connectionListTabs
          // is now gated to NEVER raise a prompt (a not-granted browser returns a state with no Apple Event), so an
          // ungranted drop just shows the onboarding card (which owns its own veil) and a FULLY-GRANTED drop connects
          // silently. Veiling here flashed the island on→off within ~1s on every granted browser drop (the regression).
          await computerUseHelper().call('pick_stop').catch(() => {})
          const tabsRes = (await (electronConnections.connectionListTabs as (only?: string) => Promise<unknown>)(browser).catch(() => ({}))) as {
            tabs?: Array<{ tabId: string; browser?: string }>
            browsers?: Record<string, string>
          }
          const state = (tabsRes.browsers || {})[browser]
          if (state && state !== 'ok') {
            const grant = grantForBrowserState(browser, state) || grantForConnection({ type: 'tab', browser })
            finish({ ok: false, error: `${browser} needs permission`, permission: grant })
            return
          }
          action = 'tab'
          const tabId =
            browser === 'chrome'
              ? await matchChromeTabByBounds(bounds)
              : (tabsRes.tabs || []).find((t) => t.browser === 'safari')?.tabId || null
          res = tabId
            ? await electronConnections.connectionConnectTab(tabId, { agentId: pickActiveSession })
            : ((action = 'window'), await electronConnections.connectionConnectWindow(Number(m.windowId), { agentId: pickActiveSession }))
        } else {
          res = await electronConnections.connectionConnectWindow(Number(m.windowId), { agentId: pickActiveSession })
        }
        const ok = !!res && !res.error
        const connId = typeof res?.connId === 'string' ? res.connId : ''
        console.log(`[blitzos] drop → ${action} ok=${ok} (${app || bundleId})`)
        finish({ ok, connId, error: res?.error })
      })().catch((err) => finish({ ok: false, error: String(err) }))
    } else if (kind === 'pick_over' || kind === 'pick_hover' || kind === 'pick_cancel') {
      mainWindow?.webContents.send('os:pick-event', m)
    }
  })
  // Safari tabs via Apple Events `do JavaScript` (merged into connection_list_tabs as browser:'safari').
  electronConnections.setSafariLink(makeSafariLink({ connectionOps: electronConnections, helper: computerUseHelper() }))
  // Chrome tabs via Apple Events `execute … javascript` (browser:'chrome') — the connector extension is deprecated,
  // so this is the Chrome tab path. Focus-safe: it drives Chrome only through executed JS, never `set URL`. The
  // helper routes the AppleScript so the "control Chrome" Automation grant stays on the helper (granted in onboarding).
  // blitzPid EXCLUDES the agent's own Blitz Chrome (a second com.google.Chrome instance) from the user-Chrome
  // enumeration, so it can never shadow the user's tabs over Apple Events. See plans/blitzos-chrome-pid-targeting.md.
  electronConnections.setChromeAsLink(makeChromeAppleScriptLink({ connectionOps: electronConnections, helper: computerUseHelper(), blitzPid: () => blitzChrome().browserPid() }))
  // Chrome is connectable out of the box via Apple Events (setChromeAsLink above; one-time "Allow JavaScript
  // from Apple Events" in View ▸ Developer). There is no connector extension.

  // Agents run as managed tmux terminals. The backend is pluggable: Claude Code (`claude`) is the default
  // when available (the visible TUI/resume path), while Codex serverless (`codex exec`) stays selectable.
  // BLITZ_AGENT_BACKEND/BLITZ_AGENT_RUNTIME can force `codex`, `codex-serverless`, or `claude`.
  // BLITZ_AGENT remains the command override; `BLITZ_AGENT=1` preserves the old "force claude" meaning
  // unless a backend env var is also set.
  type AgentRuntimeSpec = { runtime: string; cmd: string; label: string }
  // ! DEBUG: temporary app-level runtime picker support. Keep this visually marked in the UI so
  // ! DEBUG: maintainers know it is not production product surface yet.
  const selectableAgentRuntime = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const runtime = normalizeAgentRuntime(value)
    return runtime === AGENT_RUNTIME_CODEX_SERVERLESS || runtime === AGENT_RUNTIME_CLAUDE ? runtime : null
  }
  const agentRuntimePrefsFile = (): string => join(app.getPath('userData'), 'agent-runtime.json')
  const readPreferredAgentRuntime = (): string | null => {
    try {
      const parsed = JSON.parse(readFileSync(agentRuntimePrefsFile(), 'utf8')) as { runtime?: unknown }
      return selectableAgentRuntime(parsed?.runtime)
    } catch {
      return null
    }
  }
  const writePreferredAgentRuntime = (runtime: string): void => {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(agentRuntimePrefsFile(), JSON.stringify({ runtime }, null, 2))
  }
  // App-level custom instructions: prose the user sets once in Settings, injected into EVERY agent
  // session's first message (via the setUserInstructionsProvider seam below). Persisted as a small JSON
  // file in userData, read fresh on each agent (re)launch so edits apply to new/restarted sessions.
  const customInstructionsFile = (): string => join(app.getPath('userData'), 'custom-instructions.json')
  const readCustomInstructions = (): string => {
    try {
      const parsed = JSON.parse(readFileSync(customInstructionsFile(), 'utf8')) as { text?: unknown }
      return typeof parsed?.text === 'string' ? parsed.text : ''
    } catch {
      return ''
    }
  }
  const writeCustomInstructions = (text: string): void => {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(customInstructionsFile(), JSON.stringify({ text }, null, 2))
  }
  const resolveSelectedAgentRuntime = (runtime: string): AgentRuntimeSpec | null => {
    const selected = selectableAgentRuntime(runtime)
    if (selected === AGENT_RUNTIME_CODEX_SERVERLESS) {
      const cmd = codexCliPath()
      return cmd ? { runtime: AGENT_RUNTIME_CODEX_SERVERLESS, cmd, label: 'Codex CLI (`codex`)' } : null
    }
    if (selected === AGENT_RUNTIME_CLAUDE) {
      const cmd = claudeCliPath()
      return cmd ? { runtime: AGENT_RUNTIME_CLAUDE, cmd, label: 'Claude Code CLI (`claude`)' } : null
    }
    return null
  }
  const resolveAgentRuntime = (preferredRuntime?: string | null): AgentRuntimeSpec | null => {
    const rawBackend = process.env.BLITZ_AGENT_BACKEND || process.env.BLITZ_AGENT_RUNTIME || ''
    const rawAgent = process.env.BLITZ_AGENT || ''
    const rawAgentRuntime = rawAgent && rawAgent !== '1' ? normalizeAgentRuntime(rawAgent) : ''
    const rawAgentIsRuntime = rawAgentRuntime === AGENT_RUNTIME_CODEX_SERVERLESS || rawAgentRuntime === AGENT_RUNTIME_CLAUDE
    const customAgentCmd = rawAgent && rawAgent !== '1' && !rawAgentIsRuntime ? rawAgent : ''
    const explicitRuntime = rawBackend ? normalizeAgentRuntime(rawBackend) : rawAgentIsRuntime ? rawAgentRuntime : ''
    const preferred = selectableAgentRuntime(preferredRuntime)
    const wanted = explicitRuntime || preferred || (customAgentCmd || rawAgent === '1' ? AGENT_RUNTIME_CLAUDE : DEFAULT_AGENT_RUNTIME)
    if (wanted === AGENT_RUNTIME_CODEX_SERVERLESS) {
      const cmd = customAgentCmd || codexCliPath()
      if (cmd) return { runtime: AGENT_RUNTIME_CODEX_SERVERLESS, cmd, label: 'Codex CLI (`codex`)' }
      if (explicitRuntime) return null
    }
    if (wanted === AGENT_RUNTIME_CLAUDE) {
      const cmd = customAgentCmd || claudeCliPath() || (rawAgent === '1' ? 'claude' : null)
      if (cmd) return { runtime: AGENT_RUNTIME_CLAUDE, cmd, label: 'Claude Code CLI (`claude`)' }
      if (explicitRuntime || rawAgent === '1') return null
    }
    const codex = codexCliPath()
    if (codex) return { runtime: AGENT_RUNTIME_CODEX_SERVERLESS, cmd: codex, label: 'Codex CLI (`codex`)' }
    const claude = claudeCliPath()
    if (claude) return { runtime: AGENT_RUNTIME_CLAUDE, cmd: claude, label: 'Claude Code CLI (`claude`)' }
    return null
  }
  // ! DEBUG: mutable runtime override used by the bottom-right debug switch. Existing agents are
  // ! DEBUG: not hot-swapped; new launches/restarts read this current value.
  let currentAgentRuntime: AgentRuntimeSpec | null = null
  const applyAgentRuntime = (runtime: AgentRuntimeSpec | null): void => {
    currentAgentRuntime = runtime
    setInterviewAgentAvailable(!!runtime)
    setTerminalAgentRuntime(runtime ? { runtime: runtime.runtime, cmd: runtime.cmd } : null)
  }
  const agentRuntimeStatus = (): {
    ok: boolean
    runtime: string | null
    label: string | null
    available: { codex: boolean; claude: boolean }
    error?: string
  } => ({
    ok: true,
    runtime: currentAgentRuntime?.runtime || null,
    label: currentAgentRuntime?.label || null,
    available: { codex: !!codexCliPath(), claude: !!claudeCliPath() }
  })
  applyAgentRuntime(resolveAgentRuntime(readPreferredAgentRuntime()))
  // ! DEBUG: IPC backing for the temporary runtime selector.
  ipcMain.handle('os:agent-runtime:get', () => agentRuntimeStatus())
  ipcMain.handle('os:agent-runtime:set', (_e, value: string) => {
    const selected = selectableAgentRuntime(value)
    if (!selected) return { ...agentRuntimeStatus(), ok: false, error: 'Unknown agent backend' }
    const next = resolveSelectedAgentRuntime(selected)
    if (!next) {
      const label = selected === AGENT_RUNTIME_CODEX_SERVERLESS ? 'Codex CLI (`codex`)' : 'Claude Code CLI (`claude`)'
      return { ...agentRuntimeStatus(), ok: false, error: `${label} is not available on this Mac` }
    }
    writePreferredAgentRuntime(selected)
    applyAgentRuntime(next)
    return agentRuntimeStatus()
  })
  // Custom-instructions: the provider feeds buildBootstrap on every (re)launch; the IPC pair backs the
  // Settings text field (get on open, set on edit). Same text for every agent (sessionId is ignored today).
  setUserInstructionsProvider(() => readCustomInstructions() || null)
  ipcMain.handle('os:custom-instructions:get', () => ({ text: readCustomInstructions() }))
  ipcMain.handle('os:custom-instructions:set', (_e, value: string) => {
    const text = typeof value === 'string' ? value : ''
    writeCustomInstructions(text)
    return { ok: true, text }
  })
  // PRE-FLIGHT: the brain = a managed agent backend inside a tmux terminal. If either is missing on this
  // Mac (fresh VM; packaged GUI apps also don't get homebrew's PATH — both resolvers use the login shell),
  // the worst failure mode is SILENCE. Say what's missing in chat at boot and on messages while broken.
  const missingRuntime = (): string[] => {
    const m: string[] = []
    if (!currentAgentRuntime) m.push('an agent backend (`codex` or `claude`) — install/fix Codex or Claude Code, and make sure the command works in your terminal')
    if (!resolveTmuxBin()) m.push('tmux — run `brew install tmux` (my agent terminals run inside it)')
    return m
  }
  const lastRuntimeNotice = new Map<string, number>()
  const runtimeNotice = (sid: string): void => {
    const missing = missingRuntime()
    if (!missing.length) return
    const now = Date.now()
    if (now - (lastRuntimeNotice.get(sid) || 0) < 60_000) return
    lastRuntimeNotice.set(sid, now)
    setTimeout(() => {
      osSay(`I can't respond yet — this Mac is missing what my brain runs on:\n${missing.map((x) => `- ${x}`).join('\n')}\n\nInstall the above, then relaunch BlitzOS and I'll pick your messages up.`, sid)
    }, 400) // after their message lands in the thread
  }
  {
    const missing = missingRuntime()
    if (missing.length) {
      console.error('[brain] runtime prerequisites missing:', missing.join(' | '))
      setTimeout(() => runtimeNotice('0'), 7000) // after the workspace + chat hub hydrate
    }
  }
  {
    const terminalsDirOf = (): string | null => { const ws = osWorkspaceContext().workspace_path; return ws ? join(ws, '.blitzos', 'terminals') : null }
    // The per-(re)launch standing-duty mapper (prepareAgentLaunch re-reads it + rewrites bootstrap.txt, so a duty
    // changes as workspace state changes). An agent with the ORCHESTRATORS flag gets the duty to author + run
    // blitzscript workflows; agent '0' carries the onboarding standing duty (pending interview -> interview duty,
    // finished -> resident initiative duty); every other bare peer gets null. (The Job model is retired.)
    // Handed to an agent that a restart cut off MID-TURN, so it picks its unfinished work back up with no user
    // nudge. Gated by the backend-agnostic wasInterrupted seam (claude=stop_reason, codex=exit-code): a cleanly
    // idle agent (e.g. a chat agent waiting for the user) or an unknown backend never gets it and never acts.
    const RESUME_CLAUSE =
      'You were interrupted mid-task by an app restart (your last step did not finish). Pick your unfinished work back up from where you left off, without waiting for the user, and stay within the act-vs-ask boundary (reversible work freely, ask before any irreversible outward act).'
    setBootTaskProvider((id: string) => {
      const td = terminalsDirOf()
      let meta: ReturnType<typeof readTerminalMeta> = null
      try {
        meta = td ? readTerminalMeta(td, String(id)) : null
      } catch {
        meta = null
      }
      // HARDCODE (per request): EVERY non-primary agent session is an orchestrator — it boots able + primed to
      // author and run blitzscript workflows (via the run_workflow syscall, which shows the live board in chat).
      // Agent '0' keeps its onboarding/resident duty (it still learns run_workflow from the served doctrine).
      // The per-agent meta.orchestrators flag is superseded by this floor (all peers are orchestrators). meta is
      // still read below for the interrupt check.
      let duty: string | null = String(id) === '0' ? interviewBootTask() : orchestratorBootTask()
      // AUTO-CONTINUE: if this agent was cut off mid-turn, prepend the resume clause to whatever duty it has (or
      // make it the duty). Clean/idle agent or unknown backend → wasInterrupted is false/null → no clause added.
      let interrupted: boolean | null = null
      try {
        interrupted = meta ? wasInterrupted(meta, { wsRoot: osActiveWorkspaceDir() }) : null
      } catch {
        interrupted = null
      }
      if (interrupted) return duty ? `${RESUME_CLAUSE} ${duty}` : RESUME_CLAUSE
      return duty
    })
    const launchAgent = (id: string, stage: number, title?: string): void => {
      const ws = osWorkspaceContext().workspace_path
      const terminalsDir = terminalsDirOf()
      const url = getAgentSocketUrl()
      if (!ws || !terminalsDir || !url) return // not ready (no workspace / relay url yet) — boot resume retries
      const agentRuntime = currentAgentRuntime
      if (!agentRuntime) return
      const persistedTitle = (() => {
        try {
          const value = readTerminalMeta(terminalsDir, String(id))?.title
          return typeof value === 'string' && value.trim() ? value.trim() : null
        } catch {
          return null
        }
      })()
      const launchTitle = title || persistedTitle || (id === '0' ? 'Blitz' : 'New Agent')
      const existing = electronTerminalOps.getTerminal(String(id))
      if (existing?.kind === 'agent' && existing.status === 'stopped') return // user intentionally stopped it; Resume restarts it
      // `sessionsDir` is the agent-runtime contract for persisted backend metadata; we point it at
      // our .blitzos/terminals migration.
      const launch = prepareAgentLaunch({ sessionsDir: terminalsDir, id, url, cmd: agentRuntime.cmd, runtime: agentRuntime.runtime })
      void electronTerminalOps.spawnTerminal({
        id,
        kind: 'agent',
        command: launch.command,
        cwd: ws,
        stage,
        title: launchTitle,
        agentRuntime: launch.agentRuntime,
        agentSessionId: launch.agentSessionId,
        claudeSessionId: launch.claudeSessionId,
        claudeEstablished: launch.established
      })
      // agent.spawn: the launch context (bootstrap text + backend/command + session ids + conversation refs).
      try {
        const bootstrap = (() => { try { return readFileSync(join(terminalsDir, String(id), 'bootstrap.txt'), 'utf8') } catch { return null } })()
        sessionTape?.agentSpawn({
          agent: id,
          backend: launch.agentRuntime,
          command: launch.command,
          cwd: ws,
          claudeSessionId: launch.claudeSessionId,
          agentSessionId: launch.agentSessionId,
          bootstrap,
          transcriptPath: join(terminalsDir, String(id), 'transcript.jsonl')
        })
      } catch {
        /* tape best-effort */
      }
    }
    reviveAgentBackend = (id, title) => launchAgent(String(id), 0, title || undefined)
    setLaunchAgent(launchAgent)
    setPauseAgent((id) => { electronTerminalOps.stopTerminal(id) }) // archive parks the agent but keeps meta/transcript for restore
    setRestartAgent((id) => { void electronTerminalOps.restartTerminal(id).then((t) => { if (!t) launchAgent(String(id), 0) }) }) // restore wakes the parked agent from its preserved terminal record
    setStopAgent((id) => { electronTerminalOps.removeTerminal(id) }) // closing an agent fully removes its terminal record (no auto-restart, no exited ghost)
    setClearBrainContext((id) => { void electronTerminalOps.clearAgentContext(id) }) // interview→resident HANDOFF: rotate the session (fresh context) so the resident rebuilds from the .md files + chat.md at resident (xhigh) effort
    setActionItemsProvider(() => electronActionItems.listActions()) // host reconciles the inbox surface against the authoritative store
    // W2 supervisor tick: feed it the live terminal list (id/status/exitCode) so the heartbeat can diff
    // terminal exits + agent add/close. osActions can't import electronTerminalOps (terminal-ops lives here,
    // and it imports osActions); this DI seam mirrors setActionItemsProvider / setLaunchAgent.
    setTerminalStatusProvider(() => electronTerminalOps.listTerminals().map((t) => ({ id: String(t.id), status: t.status, exitCode: t.exitCode ?? null })))
    // A real user message is the strongest signal that this specific chat needs a live backend now. Claude Code
    // can cleanly exit after a bootstrap/listener turn on newer CLIs, leaving the supervisor in backoff; without
    // this nudge the island briefly shows Working, then settles with no reply because no tmux pane is listening.
    const lastMessageRevive = new Map<string, number>()
    setOnUserMessage((sid) => {
      const id = String(sid || '0')
      if (missingRuntime().length) {
        runtimeNotice(id)
        return
      }
      if (isRecoverableAgentPane(id)) return
      const now = Date.now()
      if (now - (lastMessageRevive.get(id) || 0) < 2500) return
      lastMessageRevive.set(id, now)
      console.warn(`[brain] agent ${id} was not live on user message; restarting`)
      const terminal = electronTerminalOps.getTerminal(id)
      if (terminal?.kind === 'agent') reviveOrRestartAgentBackend(id, terminal)
      else osKickBrain(id)
    })
    // Resume/reattach all agents — SELF-HEALING, not a fragile one-shot. The old code fired resume exactly once
    // when the relay URL appeared; if it missed an agent (relay URL lagged past the window, terminal adoption
    // raced, or a single launch threw) that agent had NO terminal record and stayed DEAD forever — revivable only
    // by a user message or the watchdog. That was the "agents go dead after relaunch" bug. Now: the initial batch
    // still sets each agent 'starting' and launches it, then a periodic reconciler ENSURES every active on-disk
    // agent has a backend — relaunching any with no record, retried until it is actually up. Once an agent has a
    // record, terminal-manager owns its lifecycle (auto-restart on exit), so the reconciler skips it (no
    // double-launch); the per-agent cooldown also covers the async spawn window before the record registers.
    let initialResumeDone = false
    const resumeAttempt = new Map<string, number>() // id -> last (re)launch tick (anti-double-launch + flap backoff)
    const RECONCILE_COOLDOWN_MS = 30_000
    const reconcileAgentBackends = async (): Promise<void> => {
      if (!getAgentSocketUrl()) return // agents need the relay URL to function — retry on the next tick
      const now = Date.now()
      if (!initialResumeDone) {
        initialResumeDone = true
        try { await electronTerminalOps.whenRestored() } catch { /* ignore */ }
        // Seed the cooldown for every agent the initial batch is about to launch, so the reconciler does not
        // re-launch them before their records register (spawnTerminal is async).
        try { for (const id of Object.keys(osAgentStatus() || {})) resumeAttempt.set(id, now) } catch { /* ignore */ }
        osResumeAgentsOnBoot() // initial batch: sets 'starting' + launches every on-disk agent
        return
      }
      let ids: string[] = []
      try { ids = Object.keys(osAgentStatus() || {}) } catch { return } // authoritative active set (excludes archived/stopped)
      for (const id of ids) {
        // isTerminalLive = terminal-manager has an in-memory record (live.has) — true while it OWNS the lifecycle:
        // running, OR exited-and-pending-auto-restart (the record survives the backoff window). False only when
        // nobody is supervising it (never launched this session, or a launch that returned before spawnTerminal
        // registered). MUST NOT use getTerminal here: it falls back to the on-disk meta, which exists for every
        // agent ever launched, so it would skip even a truly-dead agent — defeating the self-heal.
        if (electronTerminalOps.isTerminalLive(id)) continue
        if (now - (resumeAttempt.get(id) || 0) < RECONCILE_COOLDOWN_MS) continue // just (re)launched — let it settle
        resumeAttempt.set(id, now)
        console.warn(`[resume] agent ${id} has no backend; (re)launching`)
        launchAgent(id, 0)
      }
    }
    // Tick periodically: covers a late-appearing relay URL AND any agent the initial batch missed. Cheap (a
    // readdir + map checks); a no-op once every agent has a record. Runs for the life of the app — self-healing.
    const t = setInterval(() => { void reconcileAgentBackends() }, 4000)
    app.on('before-quit', () => clearInterval(t))
    // The milestone NARRATOR: every ~60s, summarize each agent's NEW transcript activity into one plain step
    // (Haiku, strict JSON) and broadcast it (os:action {type:'milestone'}). Idle agents make no call. The island
    // reads the timeline from osAgentsSnapshot + these live broadcasts.
    const narrator = startNarrator({
      listAgents: () => Object.keys(osAgentStatus() || {}),
      wsRoot: () => osActiveWorkspaceDir(),
      claudeSidFor: (id: string) => osAgentClaudeSid(String(id)),
      broadcast: (ev: Record<string, unknown>) => osBroadcast(ev),
      intervalMs: 60000
    })
    setMilestonesProvider((id: string) => narrator.milestones(id))
    app.on('before-quit', () => { try { narrator.stop() } catch { /* ignore */ } })
  }

  // Kernel fault model: tell BOTH inhabitants when the previous run died without a clean shutdown.
  // The dirty bit is the truth source (covers SIGSEGV / SIGKILL / power loss); the DiagnosticReports
  // scan adds the WHY on macOS when it can. `concurrent` means the previous record's pid is still
  // alive — that's another BlitzOS on this root (not a crash): warn loudly, never false-report. The
  // agent gets a trigger:'system' moment (it decides significance); the human gets a chat line, which
  // also lands in chat.md — the brains' boot memory.
  if (bootJournal?.concurrent) {
    console.error(
      `[boot] another BlitzOS (pid ${bootJournal.prev?.pid}, mode ${bootJournal.prev?.mode}) appears to be running on this workspaces root — two hosts on one root WILL fight over files. Close one of them.`
    )
    try { sessionTape?.crash({ concurrent: true, pid: bootJournal.prev?.pid, mode: bootJournal.prev?.mode }) } catch { /* ignore */ }
  } else if (bootJournal?.dirty) {
    const upTo = bootJournal.lastAliveAt || Date.now()
    const report = scanCrashReports(upTo, Date.now(), bootJournal.prev?.pid)
    const when = new Date(report?.at || upTo).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const why = report ? ` (${report.detail})` : ''
    const line = `Recovered from a crash: the previous BlitzOS process died around ${when}${why} without a clean shutdown. Workspaces were restored from disk; edits made in the last moments before the crash may have been lost.`
    console.error('[boot] ' + line)
    try { sessionTape?.crash({ dirty: true, at: report?.at || upTo, detail: report?.detail, pid: bootJournal.prev?.pid, mode: bootJournal.prev?.mode }) } catch { /* ignore */ }
    emitSystemMoment('crash', line, { at: report?.at || upTo, ...(report ? { detail: report.detail } : {}) })
    osSay(line)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Flush a pending workspace write + stop the folder watchers before quit (so the last edit persists).
app.on('before-quit', () => {
  trackActivity('app.quit', { source: 'main' })
  void flushActivityLogging()
  osFlushWorkspace()
  try { electronTerminalOps.stopHosts() } catch { /* ignore */ } // flush terminal scrollback + close tmux control clients (terminals survive)
  try { computerUseHelper().shutdown() } catch { /* ignore */ } // quit the CU helper + close its socket
  try { islandHelper?.stop() } catch { /* ignore */ } // stop relaunch-supervision only; the island is a separate LSUIElement that may keep running (it reconnects with backoff)
  try { globalShortcut.unregister(notchToggleAccel) } catch { /* ignore */ } // release the live show/hide-island chord (scoped, so other consumers are untouched)
  bootJournal?.markClean() // LAST: "clean shutdown" means everything above flushed first
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Best-effort macOS crash-report scan: find the Electron .ips in ~/Library/Logs/DiagnosticReports
// whose header timestamp falls inside the previous run's death window. The .ips is two JSON docs —
// a one-line header {timestamp, app_name} then the body {pid, termination, exception} — so we can
// match OUR pid strictly when the body parses (another Electron app crashing in the window must not
// be blamed). Returns the most recent match or null; every step is failure-tolerant by design.
function scanCrashReports(fromTs: number, toTs: number, pid?: number): { at: number; detail: string } | null {
  try {
    const dir = join(app.getPath('home'), 'Library', 'Logs', 'DiagnosticReports')
    let best: { at: number; detail: string } | null = null
    for (const name of readdirSync(dir)) {
      if (!/^Electron-.*\.ips$/.test(name)) continue
      try {
        const file = join(dir, name)
        const st = statSync(file)
        if (st.size > 8 * 1024 * 1024 || st.mtimeMs < fromTs - 120_000) continue
        const raw = readFileSync(file, 'utf8')
        const nl = raw.indexOf('\n')
        if (nl <= 0) continue
        const head = JSON.parse(raw.slice(0, nl)) as { timestamp?: string }
        const at = Date.parse(String(head.timestamp || ''))
        if (!Number.isFinite(at) || at < fromTs - 90_000 || at > toTs + 5_000) continue
        let detail = 'native crash'
        try {
          const body = JSON.parse(raw.slice(nl + 1)) as { pid?: number; termination?: { indicator?: string; signal?: number }; exception?: { type?: string } }
          if (pid != null && body.pid != null && body.pid !== pid) continue // someone else's Electron
          const term = body.termination || {}
          detail = [body.exception?.type, term.indicator || (term.signal != null ? `signal ${term.signal}` : '')].filter(Boolean).join(', ') || detail
        } catch {
          /* header-only match is still useful */
        }
        if (!best || at > best.at) best = { at, detail }
      } catch {
        /* unreadable report — skip */
      }
    }
    return best
  } catch {
    return null
  }
}
