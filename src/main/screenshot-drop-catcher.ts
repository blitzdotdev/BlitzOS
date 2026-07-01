import { app, BrowserWindow, ipcMain } from 'electron'

type DropRect = { x: number; y: number; w: number; h: number }

let dropWin: BrowserWindow | null = null
let activeAgentId = ''
let registered = false
let mainWindowProvider: () => BrowserWindow | null = () => null
let preloadPath = ''

const DROP_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
html,body{margin:0;width:100vw;height:100vh;overflow:hidden;background:#000;-webkit-user-select:none;user-select:none}
body{cursor:copy}
</style></head><body><script>
function hasFiles(e){try{return Array.prototype.indexOf.call(e.dataTransfer&&e.dataTransfer.types||[],"Files")>=0}catch(_){return false}}
function stop(e){e.preventDefault();e.stopPropagation()}
var over=false;
function hover(on){if(over===on)return;over=on;try{if(window.agentOS&&window.agentOS.screenshotDrop)window.agentOS.screenshotDrop.hover(on)}catch(_){}}
window.addEventListener("dragenter",function(e){if(hasFiles(e)){stop(e);hover(true)}},true);
window.addEventListener("dragover",function(e){if(hasFiles(e)){stop(e);hover(true);try{e.dataTransfer.dropEffect="copy"}catch(_){}}},true);
window.addEventListener("dragleave",function(e){if(hasFiles(e))hover(false)},true);
window.addEventListener("drop",function(e){
  if(!hasFiles(e))return;
  stop(e);
  var paths=[];
  try{paths=window.agentOS&&window.agentOS.dropPaths?window.agentOS.dropPaths(Array.prototype.slice.call(e.dataTransfer.files||[])):[]}catch(_){paths=[]}
  hover(false);
  try{if(window.agentOS&&window.agentOS.screenshotDrop)window.agentOS.screenshotDrop.complete(paths)}catch(_){}
},true);
</script></body></html>`

function normalizeRect(raw: unknown): Electron.Rectangle | null {
  const r = raw as Partial<DropRect> | null
  const x = Number(r?.x)
  const y = Number(r?.y)
  const width = Number(r?.w)
  const height = Number(r?.h)
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width < 16 || height < 16) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  }
}

function ensureDropWindow(): BrowserWindow {
  if (dropWin && !dropWin.isDestroyed()) return dropWin
  const win = new BrowserWindow({
    width: 32,
    height: 32,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    show: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  dropWin = win
  win.setOpacity(0.02)
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setHiddenInMissionControl(true)
  win.setMenuBarVisibility(false)
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => {
    if (dropWin === win) dropWin = null
  })
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(DROP_HTML))
  return win
}

function stopDropCatcher(): void {
  forwardDropHover(false)
  activeAgentId = ''
  try {
    if (dropWin && !dropWin.isDestroyed()) dropWin.hide()
  } catch {
    /* best-effort */
  }
}

function destroyDropCatcher(): void {
  activeAgentId = ''
  try {
    if (dropWin && !dropWin.isDestroyed()) dropWin.destroy()
  } catch {
    /* best-effort */
  }
  dropWin = null
}

function forwardDropHover(on: boolean): void {
  const main = mainWindowProvider()
  if (!main || main.isDestroyed()) return
  main.webContents.send('os:screenshot-drop-hover', { on, agentId: activeAgentId })
}

export function registerScreenshotDropCatcher(opts: {
  getWindow: () => BrowserWindow | null
  preloadPath: string
}): void {
  mainWindowProvider = opts.getWindow
  preloadPath = opts.preloadPath
  if (registered) return
  registered = true

  ipcMain.handle('os:screenshot-drop-start', (_e, rect: unknown, agentId: unknown) => {
    const bounds = normalizeRect(rect)
    if (!bounds) return { ok: false, error: 'invalid drop bounds' }
    activeAgentId = String(agentId ?? '')
    try {
      const win = ensureDropWindow()
      win.setBounds(bounds)
      win.setAlwaysOnTop(true, 'floating')
      if (!win.isVisible()) win.showInactive()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'drop catcher unavailable' }
    }
  })

  ipcMain.handle('os:screenshot-drop-stop', () => {
    stopDropCatcher()
    return { ok: true }
  })

  ipcMain.on('os:screenshot-drop-complete', (_e, rawPaths: unknown) => {
    const paths = Array.isArray(rawPaths)
      ? rawPaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []
    if (!paths.length) return
    const main = mainWindowProvider()
    if (!main || main.isDestroyed()) return
    main.webContents.send('os:screenshot-drop', { paths, agentId: activeAgentId })
  })

  ipcMain.on('os:screenshot-drop-hover', (_e, on: unknown) => {
    forwardDropHover(!!on)
  })

  app.on('before-quit', destroyDropCatcher)
}
