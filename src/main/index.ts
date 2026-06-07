import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { startControlServer } from './control-server'
import { registerIntegrations } from './integrations'
import { initOsActions } from './osActions'
import { startAgentSocket, getAgentSocketUrl } from './agentSocket'
import { initCdp } from './cdp'
import { registerWidgets } from './widgets'
import { startAgentRunner } from './agent-runner.mjs'
// Keep web surfaces logged in across quit/relaunch (cookie/localStorage flush + unload).
import { startSessionPersistence } from './persistence'
import { initWorkspaces, flushWorkspaceOnQuit } from './workspaces'

// The widget library lives in <appRoot>/widgets; tell the shared catalog where it
// is (main is bundled to out/, so import.meta-relative resolution there is wrong).
process.env.BLITZ_WIDGETS_DIR = process.env.BLITZ_WIDGETS_DIR || join(app.getAppPath(), 'widgets')

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900, // TODO make sure its close to windowless fullscreen
    show: false,
    backgroundColor: '#0e1116',
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

  // Wire the renderer<->main control channel (shared by control server + agent-socket).
  initOsActions(() => mainWindow)

  // Folder-backed workspace persistence (Electron): restore the canvas on boot, project it to
  // disk on change, watch for external edits, and switch between boards. The renderer requests
  // its hydrate once its onAction listener is mounted.
  initWorkspaces(() => mainWindow)

  // Register the IPC for web-surface CDP control (renderer reports guest ids).
  initCdp()

  // Real integration auth (loopback OAuth SSO), tokens in Keychain.
  registerIntegrations(() => mainWindow)

  // Widget data bridge: relays sandboxed widgets' integration-data requests (consented).
  registerWidgets()

  // Local agent path: a localhost HTTP control API.
  startControlServer()

  // Remote agent path: connect to the agent-socket relay and mint a paste-able
  // URL so any AI chat can drive BlitzOS (no MCP needed). The connected agent is the
  // BRAIN — it watches /events and decides everything. BlitzOS ships NO in-process
  // decision logic (no resident reasoner/governor); it is pure substrate.
  startAgentSocket(() => mainWindow)

  // Boot + supervise the brain: spawn the agent and auto-restart it on exit, so a brain
  // is always watching. Opt-in via BLITZ_AGENT (=claude or a custom command). This is
  // process supervision, not decision-making — the agent remains the sole decider.
  if (process.env.BLITZ_AGENT) {
    startAgentRunner({ getUrl: () => getAgentSocketUrl(), cmd: process.env.BLITZ_AGENT === '1' ? 'claude' : process.env.BLITZ_AGENT })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Persist any pending workspace write before the app exits (the on-change write is debounced).
app.on('before-quit', () => flushWorkspaceOnQuit())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
