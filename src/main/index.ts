import { app, BrowserWindow, protocol, ipcMain, crashReporter, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { startControlServer } from './control-server'
import { registerIntegrations } from './integrations'
import { setProviderBroadcast, resolveProviderApproval, denyProviderApproval, grantProviderConsent, setProviderConsentPersist, loadProviderConsent } from './provider-bridge'
import { initOsActions, osCreateSurface, osReadThumb, osReadWorkspaceFile, osFlushWorkspace, osGroupIntoFolder, osIngestPaths, osNewFolder, osRenameFolder, osMoveIntoFolder, osMoveOutOfFolder, osOpenFolderEntry, osListDir, osCloseSurfaceFile, osLoadConsent, osPersistConsent, osWorkspaceContext, osWorkspacesRoot, osSay, osSurfaceIdForWebContents, osActiveWorkspaceDir, setLaunchAgent, setStopAgent, setRestartAgent, osResumeAgentsOnBoot, osSetRelayUrl, osSpawnAgent, osCloseAgent, osRenameAgent, setOnUserMessage, setActionItemsProvider, osRadialPhase } from './osActions'
import { emitSystemMoment } from './events'
import { openBootJournal } from './workspace.mjs'
import type { BootJournal } from './workspace.mjs'
import { installGuestSessionPolicy, resolvePermissionPrompt } from './guest-capabilities'
import { startAgentSocket, getAgentSocketUrl } from './agentSocket'
import { electronTerminalOps, electronActionItems, setTerminalGetUrl, setTerminalAgentRuntime } from './electron-os-tools'
import { AGENT_RUNTIME_CLAUDE, AGENT_RUNTIME_CODEX_SERVERLESS, DEFAULT_AGENT_RUNTIME, normalizeAgentRuntime, prepareAgentLaunch, setBootTaskProvider } from './agent-runtime.mjs'
import type { ActionStatus } from './action-items.mjs'
import { initCdp } from './cdp'
import { registerWidgets } from './widgets'
// Keep web surfaces logged in across quit/relaunch (cookie/localStorage flush + unload).
import { startSessionPersistence } from './persistence'
import { initTelemetry } from './telemetry'
import { registerWallpaperIpc } from './wallpaper'
import { registerOnboarding, interviewBootTask, claudeCliPath, codexCliPath, setInterviewAgentAvailable } from './onboarding'
import { initUpdater, openBuildPicker, isDevMachine } from './update'
import { resolveTmuxBin } from './tmux-host.mjs'
import { setWebContentsViewInputForwarder } from './webcontents-view-host'
import { createSandwich, type Sandwich } from './sandwich'

// The widget library lives in <appRoot>/widgets; tell the shared catalog where it
// is (main is bundled to out/, so import.meta-relative resolution there is wrong).
process.env.BLITZ_WIDGETS_DIR = process.env.BLITZ_WIDGETS_DIR || join(app.getAppPath(), 'widgets')

// ONE BlitzOS per machine: a second launch focuses the first instead of fighting it for the browser
// partition + the workspace watchers (observed live: partition LOCK errors, two hosts persisting over
// each other, "Object has been destroyed" 500s). app.exit is immediate — the duplicate runs no
// before-quit handlers, so it can never mark the journal clean or flush state over the owner's.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  const w = mainWindow
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
})

// Retain local minidumps for renderer/GPU/browser-process crashes (forensics only, never uploaded).
crashReporter.start({ uploadToServer: false })

// Serve workspace thumbnails (rendered board snapshots, written by capturePage) to the renderer's
// <img> over a custom protocol — main owns the bytes; the renderer just references blitz-thumb://…
protocol.registerSchemesAsPrivileged([
  { scheme: 'blitz-thumb', privileges: { standard: true, supportFetchAPI: true, bypassCSP: true } },
  { scheme: 'blitz-file', privileges: { standard: true, supportFetchAPI: true, bypassCSP: true } }
])

let mainWindow: BrowserWindow | null = null
// The window pair (sandwich compositor) — mainWindow above is its UI layer; sandwich.pages hosts
// the browser WebContentsViews underneath it.
let sandwich: Sandwich | null = null
// The boot journal (crash dirty-bit + root lease) — opened once the workspace host exists, marked
// clean as the LAST step of a graceful quit ("clean" = state was flushed first).
let bootJournal: BootJournal | null = null

// Fullscreen "video-game" mode: NATIVE macOS fullscreen (its own Space), opt-in via `BLITZ_FULLSCREEN=1`
// (default windowed so a relaunch never traps you). Stays fully escapable — Ctrl+← / Ctrl+→ swap to your
// real macOS desktops, plus four-finger swipe, ⌘Tab and ⌃⌘F all work. We deliberately do NOT use kiosk:
// suppressing ⌘Tab is the same presentation lock that kills desktop-switching, which is what trapped you.
const FULLSCREEN = process.env.BLITZ_FULLSCREEN === '1'

// App fullscreen is a PAIR operation (sandwich.ts): fullscreen the PARENT pages window and the
// attached UI child rides into its Space. The default menu's "Toggle Full Screen" role targets the
// FOCUSED window — the UI child, which is deliberately fullscreenable:false (native fullscreen on a
// macOS child window detaches it from the parent) — so the role item sits permanently disabled.
// This menu keeps every standard role but wires that one item to the pair toggle. (The green
// traffic light stays inert on the child for the same macOS constraint as its yellow sibling.)
function installAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
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
            const s = sandwich
            if (!s || s.pages.isDestroyed()) return
            s.setFullScreen(!s.pages.isFullScreen())
          }
        }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  // The sandwich compositor (plans/blitzos-sandwich-compositor.md): two congruent windows — L0
  // hosts the page WebContentsViews, L1 (transparent) hosts the entire renderer with a hole per
  // browser body. `mainWindow` stays the UI window: every renderer-facing reference is unchanged.
  sandwich = createSandwich({
    width: 1440,
    height: 900,
    fullscreen: FULLSCREEN,
    preload: join(__dirname, '../preload/index.js')
  })
  mainWindow = sandwich.ui

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
  setWebContentsViewInputForwarder(forwardTileKeybind)
  // Bare-Option hold → the radial create menu, same focus-proof route as the keybinds above: the
  // host webContents sees the key even when an app/srcdoc iframe holds focus (the renderer's own
  // DOM keydown does not). Browser guests get the mirror tracker in webcontents-view-host.ts.
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
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer] render-process-gone ${JSON.stringify(details)}`)
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
}

app.whenReady().then(() => {
  installAppMenu() // restores ⌃⌘F / View → Toggle Full Screen (pair-level; see installAppMenu)
  createWindow()

  // Durably flush cookies + localStorage to disk (web surfaces persist their logins;
  // otherwise the freshest auth token is lost on quit and sites log you back out).
  startSessionPersistence()

  // Wire the renderer<->main control channel (shared by control server + agent-socket). Also creates
  // the shared workspace host (hydrate/persist/switch/list/create/thumb) — the SAME module the server
  // backend uses, so workspaces are one feature across both modes.
  initOsActions({
    getWindow: () => mainWindow,
    getPagesWindow: () => sandwich?.pages ?? null,
    focusPages: () => sandwich?.focusPages(),
    focusUi: () => sandwich?.focusUi(),
    dragShell: (op, dx, dy) => sandwich?.dragShell(op, dx, dy)
  })

  // Session telemetry (plans/blitzos-telemetry.md): events + frames → the replay dashboard. Off unless
  // ~/.blitzos/telemetry.json exists; BLITZ_TELEMETRY=0 kills it. After initOsActions so the taps see
  // a wired control plane; before everything else so boot-time errors are captured.
  initTelemetry(() => mainWindow)

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

  // Real integration auth (loopback OAuth SSO), tokens in Keychain.
  registerIntegrations(() => mainWindow)

  // Widget data bridge: relays sandboxed widgets' integration-data requests (consented).
  registerWidgets()

  // Onboarding/boot frosted backdrop: serve the user's macOS wallpaper to the renderer.
  registerWallpaperIpc()

  // Onboarding director (P1): local scan → Case File workspace → template board → FDA unlock loop.
  registerOnboarding(() => mainWindow)
  initUpdater() // OTA poll (packaged builds only — no-op in dev)

  // #51 general provider-access substrate: route write-approval cards to the renderer, and accept the
  // human's approve/deny/consent back. Reads need none of this; only WRITES surface a card.
  setProviderBroadcast((a) => mainWindow?.webContents.send('os:action', a))
  ipcMain.handle('os:provider-approve', (_e, id: string) => {
    resolveProviderApproval(String(id))
    return { ok: true }
  })
  ipcMain.handle('os:provider-deny', (_e, id: string) => {
    denyProviderApproval(String(id))
    return { ok: true }
  })
  ipcMain.handle('os:provider-consent', (_e, provider: string, allow: boolean) => {
    grantProviderConsent(String(provider), allow !== false)
    return { ok: true }
  })
  // #53: restore the active workspace's sensitive-read provider grants + persist future ones (the host
  // exists now). The widget-grant slice is restored inside registerWidgets() above.
  loadProviderConsent(osLoadConsent().providers)
  setProviderConsentPersist((providers) => osPersistConsent({ providers }))
  // #52: group surfaces into a REAL folder (mkdir + mv) — the renderer's Cmd+G in the desktop app.
  // kind:'board' makes a '.board' on-canvas folder (windows/widgets splay live); else a normal file folder.
  ipcMain.handle('os:group', (_e, name: string, ids: string[], kind?: string) =>
    osGroupIntoFolder(String(name), Array.isArray(ids) ? ids : [], undefined, undefined, kind === 'board' ? 'board' : 'folder')
  )
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
  // File-manager listing for a normal folder tile (the Electron counterpart of server /api/os/dir).
  ipcMain.handle('os:dir', (_e, rel: string) => osListDir(String(rel || '')))
  // Close = delete the closed window's backing content file (so it doesn't pop back up on reconcile).
  ipcMain.handle('os:close-surface-file', (_e, id: string) => osCloseSurfaceFile(String(id)))

  // Terminal I/O from a TerminalView in the renderer: keystrokes, resize, scrollback read.
  ipcMain.on('os:terminal-input', (_e, p: { id: string; data: string }) => electronTerminalOps.sendToTerminal(String(p?.id), String(p?.data ?? '')))
  ipcMain.on('os:terminal-resize', (_e, p: { id: string; cols: number; rows: number }) => electronTerminalOps.resizeTerminal(String(p?.id), Number(p?.cols) || 80, Number(p?.rows) || 24))
  ipcMain.handle('os:terminal-read', (_e, id: string) => electronTerminalOps.readTerminal(String(id)))
  ipcMain.on('os:terminal-spawn', (_e, opts: { command?: string; title?: string }) => { void electronTerminalOps.spawnTerminal(opts || {}) })
  ipcMain.on('os:agent-spawn', (_e, p?: { title?: string }) => { try { osSpawnAgent(p?.title != null ? String(p.title) : undefined, true) } catch { /* no workspace host yet */ } })
  ipcMain.handle('os:close-agent', (_e, id: string) => { try { return osCloseAgent(String(id)) } catch (e) { return { ok: false, error: (e as Error)?.message } } })
  ipcMain.handle('os:rename-agent', (_e, p: { id: string; title: string }) => { try { return osRenameAgent(String(p?.id), String(p?.title ?? '')) } catch (e) { return { ok: false, error: (e as Error)?.message } } })
  // blitz.chat (the shared chat hub control): 'new' -> spawn a fresh agent thread (returns its id);
  // 'rename' → retitle an agent. Routes to the SAME osSpawnAgent/osRenameAgent the toolbar uses — the
  // server mirrors this via the shim's chatControl → /api/os/agent-spawn|agent-rename (no divergence).
  ipcMain.handle('os:chat-control', (_e, p: { op?: string; args?: { id?: string; title?: string; focus?: boolean } }) => {
    try {
      const op = String(p?.op || ''); const a = p?.args || {}
      if (op === 'new') return osSpawnAgent(a.title != null ? String(a.title) : undefined, !!a.focus)
      if (op === 'rename') return osRenameAgent(String(a.id ?? ''), String(a.title ?? ''))
      // 'clear' → start a FRESH context for this agent (rotate its claude session id + restart). Uniform for
      // every agent incl '0'; the server mirrors it via the shim → /api/os/agent-clear (no divergence).
      if (op === 'clear') return Promise.resolve(electronTerminalOps.clearAgentContext(String(a.id ?? '0'))).then((okv) => ({ ok: !!okv }))
      return { ok: false, error: `unknown chat op: ${op}` }
    } catch (e) { return { ok: false, error: (e as Error)?.message } }
  })
  ipcMain.handle('os:terminal-list', () => electronTerminalOps.listTerminals())
  ipcMain.on('os:terminal-stop', (_e, id: string) => electronTerminalOps.stopTerminal(String(id)))
  ipcMain.on('os:terminal-remove', (_e, id: string) => electronTerminalOps.removeTerminal(String(id)))
  ipcMain.on('os:terminal-restart', (_e, id: string) => { void electronTerminalOps.restartTerminal(String(id)) })

  // Action-items inbox (human side): list / resolve / clear.
  ipcMain.handle('os:action-list', (_e, status?: string) => electronActionItems.listActions(status as ActionStatus | undefined))
  ipcMain.on('os:action-resolve', (_e, p: { id: string; resolution?: string }) => { electronActionItems.resolveAction(String(p?.id), p?.resolution ? String(p.resolution) : 'done') })
  ipcMain.on('os:action-clear', (_e, id: string) => { electronActionItems.clearAction(String(id)) })

  // Local agent path: a localhost HTTP control API.
  startControlServer()

  // Remote agent path: connect to the agent-socket relay (SHARED self-healing lifecycle in relay.mjs — same
  // module the server uses, so it can't diverge) and mint a paste-able URL so any AI chat can drive BlitzOS.
  // On every URL change we refresh .blitzos/relay-url so the running agent terminals (which re-read it per
  // call) self-heal onto the fresh url — no privileged brain to restart.
  startAgentSocket(() => mainWindow, (url) => osSetRelayUrl(url))
  setTerminalGetUrl(() => getAgentSocketUrl()) // so a dead agent's re-exec rebuilds its command with the live url

  // Agents run as managed tmux terminals. The backend is pluggable: Codex serverless (`codex exec`) is
  // the default when available, while Claude Code stays selectable for the visible TUI/resume path.
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
  // PRE-FLIGHT: the brain = a managed agent backend inside a tmux terminal. If either is missing on this
  // Mac (fresh VM; packaged GUI apps also don't get homebrew's PATH — both resolvers use the login shell),
  // the worst failure mode is SILENCE. Say what's missing in chat at boot and on messages while broken.
  const missingRuntime = (): string[] => {
    const m: string[] = []
    if (!currentAgentRuntime) m.push('an agent backend (`codex` or `claude`) — install/fix Codex or Claude Code, and make sure the command works in your terminal')
    if (!resolveTmuxBin()) m.push('tmux — run `brew install tmux` (my agent terminals run inside it)')
    return m
  }
  {
    const missing = missingRuntime()
    if (missing.length) {
      console.error('[brain] runtime prerequisites missing:', missing.join(' | '))
      const notice = (sid: string): void =>
        osSay(`I can't respond yet — this Mac is missing what my brain runs on:\n${missing.map((x) => `- ${x}`).join('\n')}\n\nInstall the above, then relaunch BlitzOS and I'll pick your messages up.`, sid)
      setTimeout(() => notice('0'), 7000) // after the workspace + chat hub hydrate
      // Answer (throttled) every message sent while broken — silence is never an acceptable reply.
      const lastNotice = new Map<string, number>()
      setOnUserMessage((sid) => {
        const now = Date.now()
        if (now - (lastNotice.get(sid) || 0) < 60_000) return
        lastNotice.set(sid, now)
        setTimeout(() => notice(sid), 400) // after their message lands in the thread
      })
    }
  }
  {
    // Agent '0' carries the onboarding standing duty. The provider is re-read on EVERY (re)launch
    // (prepareAgentLaunch rewrites bootstrap.txt): pending interview becomes the interview duty,
    // then a finished interview becomes the resident initiative duty.
    setBootTaskProvider((id: string) => (String(id) === '0' ? interviewBootTask() : null))
    const terminalsDirOf = (): string | null => { const ws = osWorkspaceContext().workspace_path; return ws ? join(ws, '.blitzos', 'terminals') : null }
    const launchAgent = (id: string, stage: number, title?: string): void => {
      const ws = osWorkspaceContext().workspace_path
      const terminalsDir = terminalsDirOf()
      const url = getAgentSocketUrl()
      if (!ws || !terminalsDir || !url) return // not ready (no workspace / relay url yet) — boot resume retries
      const agentRuntime = currentAgentRuntime
      if (!agentRuntime) return
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
        title: title || (id === '0' ? 'Agent' : `Agent ${id}`),
        agentRuntime: launch.agentRuntime,
        agentSessionId: launch.agentSessionId,
        claudeSessionId: launch.claudeSessionId,
        claudeEstablished: launch.established
      })
    }
    setLaunchAgent(launchAgent)
    setStopAgent((id) => { electronTerminalOps.removeTerminal(id) }) // closing an agent fully removes its terminal record (no auto-restart, no exited ghost)
    setRestartAgent((id) => { void electronTerminalOps.restartTerminal(id) }) // re-exec in place (onboarding: restore full effort once the interview is done)
    setActionItemsProvider(() => electronActionItems.listActions()) // host reconciles the inbox surface against the authoritative store
    // Resume/reattach all agents once the relay URL is live + survivors adopted. Fire once.
    let resumed = false
    const resumeAll = async (): Promise<void> => {
      if (resumed || !getAgentSocketUrl()) return
      resumed = true
      try { await electronTerminalOps.whenRestored() } catch { /* ignore */ }
      osResumeAgentsOnBoot()
    }
    // The URL is minted async after the relay connects; poll until it's up (capped ~2min), then resume once.
    let tries = 0
    const t = setInterval(() => { if (getAgentSocketUrl()) { clearInterval(t); void resumeAll() } else if (++tries > 150) clearInterval(t) }, 800)
    app.on('before-quit', () => clearInterval(t))
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
  } else if (bootJournal?.dirty) {
    const upTo = bootJournal.lastAliveAt || Date.now()
    const report = scanCrashReports(upTo, Date.now(), bootJournal.prev?.pid)
    const when = new Date(report?.at || upTo).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const why = report ? ` (${report.detail})` : ''
    const line = `Recovered from a crash: the previous BlitzOS process died around ${when}${why} without a clean shutdown. Workspaces were restored from disk; edits made in the last moments before the crash may have been lost.`
    console.error('[boot] ' + line)
    emitSystemMoment('crash', line, { at: report?.at || upTo, ...(report ? { detail: report.detail } : {}) })
    osSay(line)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Flush a pending workspace write + stop the folder watchers before quit (so the last edit persists).
app.on('before-quit', () => {
  osFlushWorkspace()
  try { electronTerminalOps.stopHosts() } catch { /* ignore */ } // flush terminal scrollback + close tmux control clients (terminals survive)
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
