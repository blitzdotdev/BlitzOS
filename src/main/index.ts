import { app, BrowserWindow, protocol, ipcMain } from 'electron'
import { join } from 'path'
import { startControlServer } from './control-server'
import { registerIntegrations } from './integrations'
import { setProviderBroadcast, resolveProviderApproval, denyProviderApproval, grantProviderConsent, setProviderConsentPersist, loadProviderConsent } from './provider-bridge'
import { initOsActions, osReadThumb, osReadWorkspaceFile, osFlushWorkspace, osGroupIntoFolder, osIngestPaths, osNewFolder, osListDir, osCloseSurfaceFile, osLoadConsent, osPersistConsent, osWorkspaceContext, setSpawnChatAgent, osChatSessionIds, osSpawnChatSession } from './osActions'
import { startAgentSocket, getAgentSocketUrl } from './agentSocket'
import { electronSessionOps, electronActionItems } from './electron-os-tools'
import type { ActionStatus } from './action-items.mjs'
import { initCdp } from './cdp'
import { registerWidgets } from './widgets'
import { startAgentRunner } from './agent-runner.mjs'
// Keep web surfaces logged in across quit/relaunch (cookie/localStorage flush + unload).
import { startSessionPersistence } from './persistence'
import { registerWallpaperIpc } from './wallpaper'

// The widget library lives in <appRoot>/widgets; tell the shared catalog where it
// is (main is bundled to out/, so import.meta-relative resolution there is wrong).
process.env.BLITZ_WIDGETS_DIR = process.env.BLITZ_WIDGETS_DIR || join(app.getAppPath(), 'widgets')

// Serve workspace thumbnails (rendered board snapshots, written by capturePage) to the renderer's
// <img> over a custom protocol — main owns the bytes; the renderer just references blitz-thumb://…
protocol.registerSchemesAsPrivileged([
  { scheme: 'blitz-thumb', privileges: { standard: true, supportFetchAPI: true, bypassCSP: true } },
  { scheme: 'blitz-file', privileges: { standard: true, supportFetchAPI: true, bypassCSP: true } }
])

let mainWindow: BrowserWindow | null = null

// Fullscreen "video-game" mode: NATIVE macOS fullscreen (its own Space), opt-in via `BLITZ_FULLSCREEN=1`
// (default windowed so a relaunch never traps you). Stays fully escapable — Ctrl+← / Ctrl+→ swap to your
// real macOS desktops, plus four-finger swipe, ⌘Tab and ⌃⌘F all work. We deliberately do NOT use kiosk:
// suppressing ⌘Tab is the same presentation lock that kills desktop-switching, which is what trapped you.
const FULLSCREEN = process.env.BLITZ_FULLSCREEN === '1'

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900, // TODO make sure its close to windowless fullscreen
    show: false,
    fullscreen: FULLSCREEN,
    backgroundColor: '#e9e9e7',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Enable <webview> for live web-app windows.
      webviewTag: true,
      // Keep the desktop renderer itself running full-speed when not focused.
      backgroundThrottling: false
    }
  })

  // Every <webview> attached to the desktop must keep running even when it is
  // panned off-screen, so the agent can drive it. Force backgroundThrottling off
  // for all guests at attach time (the reliable place to set it).
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.backgroundThrottling = false
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
  })

  // Log when a web-surface guest actually loads (proof the real site rendered).
  mainWindow.webContents.on('did-attach-webview', (_e, guest) => {
    guest.on('did-finish-load', () => console.log('[guest] loaded:', guest.getURL()))
    guest.on('did-fail-load', (_ev, code, desc, url) => {
      if (code !== -3) console.log(`[guest] fail-load ${code} ${desc} ${url}`)
    })
    // Even when a webview has keyboard focus, surface a bare ⌘ tap to the desktop
    // so "double-tap ⌘ to toggle pan-mode" works from inside a window.
    let metaDown = false
    let sawOther = false
    guest.on('before-input-event', (_ev, input) => {
      if (input.type === 'keyDown') {
        if (input.key === 'Meta') {
          metaDown = true
          sawOther = false
        } else if (metaDown) {
          sawOther = true
        }
      } else if (input.type === 'keyUp' && input.key === 'Meta') {
        if (metaDown && !sawOther) mainWindow?.webContents.send('os:metatap')
        metaDown = false
      }
    })
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

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
  createWindow()

  // Durably flush cookies + localStorage to disk (web surfaces persist their logins;
  // otherwise the freshest auth token is lost on quit and sites log you back out).
  startSessionPersistence()

  // Wire the renderer<->main control channel (shared by control server + agent-socket). Also creates
  // the shared workspace host (hydrate/persist/switch/list/create/thumb) — the SAME module the server
  // backend uses, so workspaces are one feature across both modes.
  initOsActions(() => mainWindow)

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
  // File-manager listing for a normal folder tile (the Electron counterpart of server /api/os/dir).
  ipcMain.handle('os:dir', (_e, rel: string) => osListDir(String(rel || '')))
  // Close = delete the closed window's backing content file (so it doesn't pop back up on reconcile).
  ipcMain.handle('os:close-surface-file', (_e, id: string) => osCloseSurfaceFile(String(id)))

  // Session terminal I/O from a SessionTerminal in the renderer: keystrokes, resize, scrollback read.
  ipcMain.on('os:session-input', (_e, p: { id: string; data: string }) => electronSessionOps.sendToSession(String(p?.id), String(p?.data ?? '')))
  ipcMain.on('os:session-resize', (_e, p: { id: string; cols: number; rows: number }) => electronSessionOps.resizeSession(String(p?.id), Number(p?.cols) || 80, Number(p?.rows) || 24))
  ipcMain.handle('os:session-read', (_e, id: string) => electronSessionOps.readSession(String(id)))
  ipcMain.on('os:session-spawn', (_e, opts: { command?: string; title?: string }) => { void electronSessionOps.spawnSession(opts || {}) })
  ipcMain.on('os:chat-session-spawn', (_e, p?: { title?: string }) => { try { osSpawnChatSession(p?.title != null ? String(p.title) : undefined) } catch { /* no workspace host yet */ } })
  ipcMain.handle('os:session-list', () => electronSessionOps.listSessions())
  ipcMain.on('os:session-stop', (_e, id: string) => electronSessionOps.stopSession(String(id)))
  ipcMain.on('os:session-restart', (_e, id: string) => { void electronSessionOps.restartSession(String(id)) })

  // Action-items inbox (human side): list / resolve / clear.
  ipcMain.handle('os:action-list', (_e, status?: string) => electronActionItems.listActions(status as ActionStatus | undefined))
  ipcMain.on('os:action-resolve', (_e, p: { id: string; resolution?: string }) => { electronActionItems.resolveAction(String(p?.id), p?.resolution ? String(p.resolution) : 'done') })
  ipcMain.on('os:action-clear', (_e, id: string) => { electronActionItems.clearAction(String(id)) })

  // Local agent path: a localhost HTTP control API.
  startControlServer()

  // Remote agent path: connect to the agent-socket relay (SHARED self-healing lifecycle in relay.mjs — same
  // module the server uses, so it can't diverge) and mint a paste-able URL so any AI chat can drive BlitzOS.
  // restartBrain is threaded so a relay reconnect (new URL) restarts the brain instead of leaving it on a dead
  // URL. The connected agent is the BRAIN; BlitzOS ships NO in-process decision logic — pure substrate.
  let electronBrain: { stop: () => void; restart: () => void } | null = null
  startAgentSocket(() => mainWindow, () => electronBrain?.restart())

  // Boot + supervise the brain: spawn the agent and auto-restart it on exit, so a brain
  // is always watching. Opt-in via BLITZ_AGENT (=claude or a custom command). This is
  // process supervision, not decision-making — the agent remains the sole decider.
  if (process.env.BLITZ_AGENT) {
    electronBrain = startAgentRunner({ getUrl: () => getAgentSocketUrl(), cmd: process.env.BLITZ_AGENT === '1' ? 'claude' : process.env.BLITZ_AGENT, sessionId: '0', getWorkspacePath: () => osWorkspaceContext().workspace_path })
  }

  // Per-session chat agents (#1+): each opened chat session gets its OWN supervised claude over the same
  // relay, scoped to its id. osActions mints the id + surfaces the widget, then calls this hook to spawn the
  // agent (process supervision stays here, with the relay url). #0 is electronBrain above.
  const chatRunners = new Map<string, { stop: () => void; restart: () => void }>()
  const chatAgentCmd = (): string => (process.env.BLITZ_AGENT && process.env.BLITZ_AGENT !== '1' ? process.env.BLITZ_AGENT : 'claude')
  const ensureChatAgent = (sessionId: string): void => {
    const id = String(sessionId)
    if (id === '0' || chatRunners.has(id)) return
    chatRunners.set(id, startAgentRunner({ getUrl: () => getAgentSocketUrl(), cmd: chatAgentCmd(), label: 'chat-' + id, sessionId: id, getWorkspacePath: () => osWorkspaceContext().workspace_path }))
  }
  setSpawnChatAgent(ensureChatAgent)
  // Resume agents for chat sessions opened in a previous run (their meta persists in the workspace).
  for (const id of osChatSessionIds()) if (id !== '0') ensureChatAgent(id)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Flush a pending workspace write + stop the folder watchers before quit (so the last edit persists).
app.on('before-quit', () => {
  osFlushWorkspace()
  try { electronSessionOps.stopHosts() } catch { /* ignore */ } // flush session transcripts + close tmux control clients (sessions survive)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
