import { contextBridge, ipcRenderer, webUtils } from 'electron'

// ! DEBUG: temporary bridge for the bottom-right runtime selector.
export interface AgentRuntimeStatus {
  ok: boolean
  runtime: string | null
  label: string | null
  available: { codex: boolean; claude: boolean }
  error?: string
}

export interface OsAction {
  type: 'create' | 'move' | 'update' | 'close' | 'focus' | 'goToPrimary' | 'chat' | 'activity' | 'group' | 'hydrate' | 'switch' | 'reconcile' | 'permission-request' | 'surface-contextmenu' | 'agentStatus' | 'terminal-spawn' | 'terminal-data' | 'terminal-exit' | 'terminal-stop' | 'agent-remove' | 'agent-rename' | 'action-item' | 'action-item-removed' | 'set-theme'
  [k: string]: unknown
}

export interface OsState {
  surfaces: Array<{
    id: string
    kind: string
    x: number
    y: number
    w: number
    h: number
    z?: number
    zoom?: number
    title: string
    url?: string
    html?: string
    props?: Record<string, unknown>
    component?: string
    role?: string
    pinned?: boolean
  }>
  /** Screen size in px (so the agent knows what fits). */
  viewport?: { w: number; h: number }
  /** World-space rectangle the user can currently see (so new surfaces land on-screen). */
  view?: { x: number; y: number; w: number; h: number; cx: number; cy: number; scale: number }
  mode?: 'desktop' | 'canvas'
  /** Raw camera transform — persisted to workspace.json (Phase 1). */
  camera?: { x: number; y: number; scale: number }
  /** Last bulk layout transaction (a folder-wide reconcile) — perception treats the push as ONE gesture. */
  bulkAt?: number
  /** Which workspace this state belongs to — lets the backend drop a stale push after a switch. */
  workspace?: string
}

// Workspace launcher / Mission-Control API. ONE shape for both transports: server (shim) provides
// `thumb` (the renderer composites + uploads); Electron provides `captureThumb` (main capturePage) —
// hence both are optional. list/create/switch/thumbUrl exist in both.
export interface WorkspacesApi {
  list(): Promise<{ workspaces: Array<{ name: string; nodeCount: number; updatedAt: number; thumbTs: number }>; active: string }>
  create(name: string): Promise<{ ok: boolean; name?: string; error?: string }>
  switch(name: string): Promise<{ ok: boolean; active?: string; error?: string }>
  delete(name: string): Promise<{ ok: boolean; active?: string; error?: string }>
  thumbUrl(name: string, ts?: number): string
  thumb?(name: string, dataUrl: string): Promise<{ ok?: boolean; error?: string }>
  captureThumb?(name: string): Promise<{ ok: boolean; error?: string }>
}

const api = {
  /** Control actions from main (local control server or agent-socket) -> renderer. */
  onAction(cb: (a: OsAction) => void): () => void {
    const listener = (_e: unknown, a: OsAction): void => cb(a)
    ipcRenderer.on('os:action', listener)
    return () => ipcRenderer.removeListener('os:action', listener)
  },
  /** Renderer pushes current desktop state so main can answer list_state. */
  sendState(state: OsState): void {
    ipcRenderer.send('os:state', state)
  },
  /** Legacy webview path: renderer reports a guest WebContents id so main can read its DOM. */
  reportWebview(surfaceId: string, wcid: number): void {
    ipcRenderer.send('os:webview', { surfaceId, wcid })
  },
  /** Terminal I/O — the user typing/resizing/repainting a TerminalView (mirrors sendState). */
  terminalInput(id: string, data: string): void {
    ipcRenderer.send('os:terminal-input', { id, data })
  },
  terminalResize(id: string, cols: number, rows: number): void {
    ipcRenderer.send('os:terminal-resize', { id, cols, rows })
  },
  terminalRead(id: string): Promise<string> {
    return ipcRenderer.invoke('os:terminal-read', id) as Promise<string>
  },
  /** Open a new terminal from the UI (a "+ Terminal" button) — the backend emits terminal-spawn which auto-opens its terminal. */
  terminalSpawn(opts: { command?: string; title?: string }): void {
    ipcRenderer.send('os:terminal-spawn', opts)
  },
  /** Open a NEW agent from the UI (a "+ Agent" button) — a fresh peer agent + its own chat widget.
   *  The host broadcasts a `create` for the new chat surface, so it appears without a refresh. */
  spawnAgent(title?: string): void {
    ipcRenderer.send('os:agent-spawn', { title })
  },
  /** Close a non-primary agent: stop its terminal + remove its widget and files. */
  closeAgent(agentId: string): Promise<{ ok: boolean; error?: string }> {
    return (ipcRenderer.invoke('os:close-agent', agentId) as Promise<{ ok: boolean; error?: string }>).catch(() => ({ ok: false }))
  },
  /** Rename an agent (cosmetic title). */
  renameAgent(agentId: string, newTitle: string): Promise<{ ok: boolean; error?: string }> {
    return (ipcRenderer.invoke('os:rename-agent', { id: agentId, title: newTitle }) as Promise<{ ok: boolean; error?: string }>).catch(() => ({ ok: false }))
  },
  /** List every terminal in the active workspace (running + persisted) — for the Terminals & Agents tray. */
  terminalList(): Promise<unknown[]> {
    return (ipcRenderer.invoke('os:terminal-list') as Promise<unknown[]>).catch(() => [])
  },
  /** Stop (kill) a terminal by id. */
  terminalStop(id: string): void {
    ipcRenderer.send('os:terminal-stop', id)
  },
  /** Permanently remove a terminal from the tray (kill if live + delete its record). Never the primary agent. */
  terminalRemove(id: string): void {
    ipcRenderer.send('os:terminal-remove', id)
  },
  /** Re-spawn a dead terminal from its persisted meta (one-click resume) — emits terminal-spawn. */
  terminalRestart(id: string): void {
    ipcRenderer.send('os:terminal-restart', id)
  },
  // ! DEBUG: temporary app-level Codex/Claude switch.
  agentRuntimeGet(): Promise<AgentRuntimeStatus> {
    return ipcRenderer.invoke('os:agent-runtime:get') as Promise<AgentRuntimeStatus>
  },
  agentRuntimeSet(runtime: 'codex-serverless' | 'claude'): Promise<AgentRuntimeStatus> {
    return ipcRenderer.invoke('os:agent-runtime:set', runtime) as Promise<AgentRuntimeStatus>
  },
  /** Action-items inbox (human side): list / resolve (tick) / clear a resolved item. */
  actionList(status?: string): Promise<unknown[]> {
    return (ipcRenderer.invoke('os:action-list', status) as Promise<unknown[]>).catch(() => [])
  },
  actionResolve(id: string, resolution?: string): void {
    ipcRenderer.send('os:action-resolve', { id, resolution })
  },
  actionClear(id: string): void {
    ipcRenderer.send('os:action-clear', id)
  },
  /** Connections — connect a browser tab / macOS window into BlitzOS (the radial "Connect" entry). */
  connections: {
    listTabs(): Promise<{ tabs?: unknown[]; error?: string }> {
      return (ipcRenderer.invoke('os:conn-list-tabs') as Promise<{ tabs?: unknown[]; error?: string }>).catch(() => ({ error: 'unavailable' }))
    },
    listWindows(): Promise<{ windows?: unknown[]; error?: string }> {
      return (ipcRenderer.invoke('os:conn-list-windows') as Promise<{ windows?: unknown[]; error?: string }>).catch(() => ({ error: 'unavailable' }))
    },
    connectTab(tabId: number | string): Promise<Record<string, unknown>> {
      return (ipcRenderer.invoke('os:conn-connect-tab', tabId) as Promise<Record<string, unknown>>).catch((e) => ({ error: String(e) }))
    },
    connectWindow(windowId: number): Promise<Record<string, unknown>> {
      return (ipcRenderer.invoke('os:conn-connect-window', windowId) as Promise<Record<string, unknown>>).catch((e) => ({ error: String(e) }))
    },
    installExtension(): Promise<Record<string, unknown>> {
      return (ipcRenderer.invoke('os:conn-install') as Promise<Record<string, unknown>>).catch((e) => ({ error: String(e) }))
    }
  },
  /** Window picker — while the attach drop-zone is visible, the computer-use helper highlights ANY macOS
   *  window the cursor is over (glow + the app's icon) and lets you DRAG that icon into the drop-zone to
   *  connect it. `start` arms it with the drop-zone's on-screen rect (global, top-left CSS px ≈ macOS points);
   *  `onEvent` streams hover/over/connected/error so the UI can react. */
  pick: {
    start(dropZone: { x: number; y: number; w: number; h: number }): Promise<{ ok: boolean; error?: string }> {
      return (ipcRenderer.invoke('os:pick-start', dropZone) as Promise<{ ok: boolean; error?: string }>).catch((e) => ({ ok: false, error: String(e) }))
    },
    stop(): void {
      void ipcRenderer.invoke('os:pick-stop').catch(() => {})
    },
    onEvent(cb: (m: { kind: string; [k: string]: unknown }) => void): () => void {
      const listener = (_e: unknown, m: { kind: string; [k: string]: unknown }): void => cb(m)
      ipcRenderer.on('os:pick-event', listener)
      return () => ipcRenderer.removeListener('os:pick-event', listener)
    }
  },
  /** The agent-socket paste URL (for the "Connect AI" affordance). */
  onAgentSocketUrl(cb: (url: string) => void): () => void {
    const listener = (_e: unknown, url: string): void => cb(url)
    ipcRenderer.on('agentsocket:url', listener)
    return () => ipcRenderer.removeListener('agentsocket:url', listener)
  },
  /** App keybinds forwarded from main's before-input-event — they fire regardless of which guest
   *  (iframe/WebContentsView) holds keyboard focus. id 'tile': ⌘T toggle / ⇧⌘T cycle size. */
  onKeybind(cb: (k: { id: string; shift: boolean }) => void): () => void {
    const listener = (_e: unknown, k: { id: string; shift: boolean }): void => cb(k)
    ipcRenderer.on('os:keybind', listener)
    return () => ipcRenderer.removeListener('os:keybind', listener)
  },
  /** A bare ⇧ tap forwarded from a focused browser guest (drives the home gesture: single tap → freeze
   *  toggle, double tap → fly home + freeze). */
  onShiftTap(cb: () => void): () => void {
    const listener = (): void => cb()
    ipcRenderer.on('os:shifttap', listener)
    return () => ipcRenderer.removeListener('os:shifttap', listener)
  },
  /** Bare-Option hold/release for the radial create menu, forwarded from main's before-input-event —
   *  fires no matter what holds keyboard focus (host DOM, an app/srcdoc iframe, a browser guest).
   *  'down' carries the true cursor position in window coords (the renderer's own pointermove never
   *  fires while the cursor is over an iframe, so its last-seen position can be stale). */
  onRadialKey(cb: (m: { phase: 'down' | 'up' | 'cancel'; x?: number; y?: number }) => void): () => void {
    const listener = (_e: unknown, m: { phase: 'down' | 'up' | 'cancel'; x?: number; y?: number }): void => cb(m)
    ipcRenderer.on('os:radial', listener)
    return () => ipcRenderer.removeListener('os:radial', listener)
  },

  /** A web surface's in-DOM <webview> reports its guest WebContents id (on dom-ready) so main's agent
   *  read/control/perception path can reach the live page. */
  registerWebview(surfaceId: string, wcid: number): void {
    ipcRenderer.send('os:webview', { surfaceId, wcid })
  },
  /** Per-tab page state pushed from main: {patch} = url/title/favicon/loading/canGoBack/canGoForward;
   *  {removed} = the tab's webContents died; {openTab} = a popup wants a new tab in this surface. */
  onWebTab(
    cb: (m: {
      surfaceId: string
      tabId?: string
      patch?: { url?: string; title?: string; favicon?: string; loading?: boolean; canGoBack?: boolean; canGoForward?: boolean }
      removed?: boolean
      openTab?: { url: string }
    }) => void
  ): () => void {
    const listener = (_e: unknown, m: Parameters<typeof cb>[0]): void => cb(m)
    ipcRenderer.on('os:web-tab', listener)
    return () => ipcRenderer.removeListener('os:web-tab', listener)
  },
  /** Machine-global browser bookmarks (root journal). */
  bookmarksList(): Promise<Array<{ id: string; url: string; title: string; addedAt: number }>> {
    return (ipcRenderer.invoke('os:bookmarks') as Promise<Array<{ id: string; url: string; title: string; addedAt: number }>>).catch(() => [])
  },
  bookmarksToggle(url: string, title: string): Promise<Array<{ id: string; url: string; title: string; addedAt: number }>> {
    return (ipcRenderer.invoke('os:bookmarks-toggle', { url, title }) as Promise<Array<{ id: string; url: string; title: string; addedAt: number }>>).catch(() => [])
  },
  /** A srcdoc surface (agent-authored UI) fired an action back to the agent. */
  surfaceAction(payload: Record<string, unknown>): void {
    ipcRenderer.send('os:surface-action', payload)
  },
  /** Human consent: let the agent read this web surface's content over the relay (P0). */
  setContentShare(surfaceId: string, on: boolean): void {
    ipcRenderer.send('os:content-share', { surfaceId, on })
  },
  /** Capture a web surface's current frame as a data URL (for folder previews). */
  captureSurface(surfaceId: string): Promise<string | null> {
    return ipcRenderer.invoke('surface:capture', surfaceId)
  },
  /** Best-effort: the user's macOS wallpaper as a downscaled data URL (frosted onboarding backdrop). */
  getWallpaper(): Promise<string | null> {
    return ipcRenderer.invoke('os:wallpaper')
  },
  /** The user typed a message to an agent (agentId '0' = the primary chat). */
  sendMessage(text: string, agentId = '0'): void {
    ipcRenderer.send('os:user-message', { text, agentId })
  },
  /** One-shot snapshot of all agent sessions for the dynamic island: roster + per-session transcripts +
   *  status. The island calls this on open, then rides the live `os:action {type:'chat'}` broadcast. */
  agents(): Promise<{
    sessions: Array<{ id: string; title: string; status: string; updatedAt?: number; lastMessagePreview?: string }>
    threads: Record<string, Array<{ role: string; text: string; ts?: number }>>
    status: Record<string, string>
    milestones: Record<string, Array<{ id: string; ts: number; kind: string; text: string }>>
  }> {
    return ipcRenderer.invoke('os:agents-snapshot')
  },
  /** The island's per-session Details expand: the agent's recent raw tool calls (Grep/Edit/Run …). */
  agentDetails(id: string): Promise<{ rows: Array<{ label: string }> }> {
    return ipcRenderer.invoke('os:agent-details', { id })
  },
  /** Forward an uncaught renderer error to main (the session tape's diagnostics stream). */
  reportError(payload: { via?: string; message?: string; stack?: string; surface?: string }): void {
    ipcRenderer.send('os:client-error', payload)
  },
  /** Item 5b: the human placed a spatial annotation on a surface + asked about that point. Lands in chat
   *  + wakes the agent with a surface-anchored moment carrying the point. */
  annotate(p: { id: string; surfaceId: string; text: string; xPct: number; yPct: number }): void {
    ipcRenderer.send('os:annotate', p)
  },
  /** The shared chat hub manages threads via blitz.chat: op 'new' -> { id } of a fresh agent; 'rename' -> set its title. */
  chatControl(op: string, args: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke('os:chat-control', { op, args })
  },
  /** Ask main to (re)send the persisted canvas as a hydrate, once our onAction listener is up. */
  requestHydrate(): void {
    ipcRenderer.send('workspace:request-hydrate')
  },
  /** Re-open the runtime chat hub if the user closed it. */
  restoreChatHub(): Promise<{ ok: boolean; id?: string; error?: string }> {
    return ipcRenderer.invoke('os:restore-chat-hub')
  },

  /** A sandboxed widget calls an OS tool via blitz.tool (gated by the `tools` capability; CLOSED allowlist). */
  widgetTool(surfaceId: string, name: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    return ipcRenderer.invoke('widget:tool', { surfaceId, name, args })
  },
  /** Live workflow externalization: a srcdoc widget's blitz.workflow.* bridges to the per-run event bus.
   *  subscribe -> main streams the run's backlog + live events back as os:wf-event (SurfaceFrame routes them
   *  to the right iframe). snapshot pulls the current backlog. */
  wfSubscribe(runId: string): Promise<{ ok: boolean }> {
    return (ipcRenderer.invoke('os:wf-subscribe', runId) as Promise<{ ok: boolean }>).catch(() => ({ ok: false }))
  },
  wfUnsubscribe(runId: string): void {
    ipcRenderer.send('os:wf-unsubscribe', runId)
  },
  wfSnapshot(runId: string): Promise<unknown[]> {
    return (ipcRenderer.invoke('os:wf-snapshot', runId) as Promise<unknown[]>).catch(() => [])
  },
  onWfEvent(cb: (payload: { runId: string; ev: unknown }) => void): () => void {
    const listener = (_e: unknown, payload: { runId: string; ev: unknown }): void => { try { cb(payload) } catch { /* ignore */ } }
    ipcRenderer.on('os:wf-event', listener as never)
    return () => ipcRenderer.removeListener('os:wf-event', listener as never)
  },
  // Item 3: the human answered a web guest's Allow/Block permission prompt (geolocation, camera, …).
  decidePermission(id: string, allow: boolean, remember: boolean): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('os:permission-decide', id, allow, remember)
  },
  // #52: group surfaces into a REAL folder on disk (mkdir + mv). Server mode overrides this in the shim.
  // kind:'board' → a '.board' on-canvas folder (windows/widgets splay live); else a normal file folder.
  groupIntoFolder(name: string, ids: string[], kind?: 'board' | 'folder'): Promise<{ ok: boolean; folder?: string; moved?: number; error?: string }> {
    return ipcRenderer.invoke('os:group', name, ids, kind)
  },
  // Drag-drop: resolve dropped File objects to absolute OS paths (Electron only — the browser has none),
  // then copy them into the workspace (folders recursively). Server mode uploads bytes instead.
  dropPaths(files: File[]): string[] {
    const out: string[] = []
    for (const f of files) {
      try {
        const p = webUtils.getPathForFile(f)
        if (p) out.push(p)
      } catch {
        /* not a real OS file (e.g. a synthetic drag) */
      }
    }
    return out
  },
  ingestPaths(paths: string[], x: number, y: number): Promise<{ ok: boolean; copied?: number; error?: string }> {
    return ipcRenderer.invoke('os:ingest-paths', paths, x, y)
  },
  // "New Folder" (files) / "New Board" (windows+widgets) — the right-click desktop action.
  newFolder(name: string, kind: 'board' | 'folder', x: number, y: number): Promise<{ ok: boolean; folder?: string; error?: string }> {
    return ipcRenderer.invoke('os:new-folder', name, kind, x, y)
  },
  renameFolder(path: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return ipcRenderer.invoke('os:rename-folder', path, name)
  },
  moveIntoFolder(folderPath: string, ids: string[]): Promise<{ ok: boolean; moved?: number; skipped?: number; movedIds?: string[]; skippedIds?: string[]; error?: string }> {
    return ipcRenderer.invoke('os:move-into-folder', folderPath, ids)
  },
  moveOutOfFolder(paths: string[], x?: number, y?: number): Promise<{ ok: boolean; moved?: number; skipped?: number; movedPaths?: string[]; skippedPaths?: string[]; pathMoves?: Array<{ from: string; to: string }>; surfaceIds?: string[]; surfaces?: unknown[]; updatedIds?: string[]; updatedSurfaces?: unknown[]; error?: string }> {
    return ipcRenderer.invoke('os:move-out-of-folder', paths, x, y)
  },
  openFolderEntry(path: string, x?: number, y?: number): Promise<{ ok: boolean; id?: string; surface?: unknown; error?: string }> {
    return ipcRenderer.invoke('os:open-folder-entry', path, x, y)
  },
  // List a normal folder's contents for the file-manager overlay (server shim fetches /api/os/dir instead).
  listDir(path: string): Promise<{ path: string; entries: unknown[]; total: number; truncated: boolean } | null> {
    return ipcRenderer.invoke('os:dir', path)
  },
  // Close = delete the closed window's backing content file so it doesn't resurrect on the next reconcile.
  closeSurfaceFile(id: string): Promise<{ ok: boolean; removed?: string }> {
    return ipcRenderer.invoke('os:close-surface-file', id)
  },

  // Workspaces (one feature, both modes). Electron thumbnails are captured main-side (capturePage)
  // and served over the blitz-thumb:// protocol; switching is the shared host's atomic switch.
  workspaces: {
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (name: string) => ipcRenderer.invoke('workspace:create', name),
    switch: (name: string) => ipcRenderer.invoke('workspace:switch', name),
    delete: (name: string) => ipcRenderer.invoke('workspace:delete', name),
    captureThumb: (name: string) => ipcRenderer.invoke('workspace:capture', name),
    thumbUrl: (name: string, ts?: number) => `blitz-thumb://t/?name=${encodeURIComponent(name)}${ts ? `&t=${ts}` : ''}`
  } as WorkspacesApi,

  // Onboarding (P1 director): start the scan+board flow, stream real scan progress to the boot
  // screen, and drive the FDA tutorial-unlock card.
  onboarding: {
    start(): Promise<{ ok: boolean; cached?: boolean }> {
      return ipcRenderer.invoke('onboarding:start')
    },
    fdaStatus(): Promise<{ fda: boolean; appName: string }> {
      return ipcRenderer.invoke('onboarding:fda-status')
    },
    openFdaSettings(): Promise<{ ok: boolean; appName: string }> {
      return ipcRenderer.invoke('onboarding:open-fda-settings')
    },
    dismissUnlock(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('onboarding:dismiss-unlock')
    },
    /** Pre-board permission sequence (Dia-style frontloading): settled outcomes + live status. */
    preboardState(): Promise<{
      forced?: boolean
      steps: Record<string, 'granted' | 'denied' | 'skipped' | undefined>
      fda: boolean
      accessibility: boolean
      screen: boolean
      appName: string
      browser: { id: string; name: string } | null
      canDrag: boolean
      appIcon: string | null
    }> {
      return ipcRenderer.invoke('onboarding:preboard-state')
    },
    preboardMark(step: string, outcome: 'granted' | 'denied' | 'skipped'): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('onboarding:preboard-mark', step, outcome)
    },
    /** Codex-style: start a NATIVE drag of the .app bundle so the user can drop it straight into
     *  the System Settings permission list. Call from a dragstart handler (after preventDefault). */
    preboardDrag(): void {
      ipcRenderer.send('onboarding:preboard-drag')
    },
    /** Open a drag-list permission step (fda|accessibility|screen): main navigates Settings to the
     *  pane + raises the floating drag-helper window over it + polls until granted. */
    openPermissionDrag(kind: 'fda' | 'accessibility' | 'screen'): Promise<{ ok: boolean; appName?: string }> {
      return ipcRenderer.invoke('onboarding:open-permission-drag', kind)
    },
    closePermissionDrag(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('onboarding:close-permission-drag')
    },
    /** Fired when main's poll detects a drag-list permission was granted (helper window closes). */
    onPermissionGranted(cb: (m: { kind: 'fda' | 'accessibility' | 'screen' }) => void): () => void {
      const listener = (_e: unknown, m: { kind: 'fda' | 'accessibility' | 'screen' }): void => cb(m)
      ipcRenderer.on('onboarding:permission-granted', listener)
      return () => ipcRenderer.removeListener('onboarding:permission-granted', listener)
    },
    /** Ask for Automation (AppleEvents) consent to the detected browser — raises the macOS prompt
     *  on first call; resolves AFTER the user answers, with live window/tab counts on grant. */
    requestAutomation(): Promise<{ status: 'granted' | 'denied' | 'unavailable'; windows?: number; tabs?: number; browser?: string }> {
      return ipcRenderer.invoke('onboarding:request-automation')
    },
    openAutomationSettings(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('onboarding:open-automation-settings')
    },
    /** Chrome/Chromium profiles available to import a sign-in from (the account picker). */
    listImportProfiles(): Promise<{ id: string; name: string; profiles: { id: string; name: string; email: string | null }[] }[]> {
      return ipcRenderer.invoke('onboarding:list-import-profiles')
    },
    /** Import the chosen profile's Google sign-in into the BlitzOS session (raises one Keychain prompt). */
    importSignin(src: string, profileId: string): Promise<{ ok: boolean; reason?: string; account?: string | null; imported?: number; signedIn?: boolean }> {
      return ipcRenderer.invoke('onboarding:import-signin', src, profileId)
    },
    onProgress(cb: (p: Record<string, unknown>) => void): () => void {
      const listener = (_e: unknown, p: Record<string, unknown>): void => cb(p)
      ipcRenderer.on('onboarding:progress', listener)
      return () => ipcRenderer.removeListener('onboarding:progress', listener)
    }
  },

  // Standalone Launcher bridge (src/main/launcher.ts) — ONLY the launcher window uses these (it shares this
  // preload). startWorkflow → start_workflow (spawns an orchestrator agent seeded with the prompt); hide
  // closes the bar; onShow lets the bar refocus its input each time main re-shows the window.
  launcher: {
    startWorkflow(prompt: string, attachments?: string[]): Promise<{ ok: boolean; agentId?: string | null; error?: string }> {
      return ipcRenderer.invoke('launcher:start-workflow', { prompt, attachments: attachments || [] }) as Promise<{ ok: boolean; agentId?: string | null; error?: string }>
    },
    hide(): void {
      ipcRenderer.send('launcher:hide')
    },
    autosize(height: number): void {
      ipcRenderer.send('launcher:autosize', height)
    },
    // Resolve a dropped path to its real Finder icon (a PNG data URL) for the tray previews. Returns ''
    // when the path has no icon (e.g. a URL, or a vanished file) so the UI can fall back to a glyph.
    fileIcon(path: string): Promise<string> {
      return ipcRenderer.invoke('launcher:file-icon', path) as Promise<string>
    },
    onShow(cb: () => void): () => void {
      const listener = (): void => cb()
      ipcRenderer.on('launcher:show', listener)
      return () => ipcRenderer.removeListener('launcher:show', listener)
    }
  },

  // Notch (dynamic island) bridge — THE MERGE: the real UI window IS the notch (src/main/index.ts notch wiring +
  // sandwich overlay mode). The renderer (App.tsx) clips #root-canvas to the notch shape and GROWS the clip to
  // fullscreen, so the live canvas expands out of the notch. setInteractive toggles the window click-through
  // (collapsed = only the notch captures; expanded = full canvas). send spawns (Deep ON → workflow, OFF → agent).
  // onToggle = ⌥Space (expand/collapse). onGeometry feeds the menu-bar height (the notch height).
  notch: {
    setInteractive(on: boolean): void {
      ipcRenderer.send('os:notch-interactive', !!on)
    },
    send(prompt: string, deep: boolean): Promise<{ ok: boolean; id?: string | null; error?: string }> {
      return ipcRenderer.invoke('os:notch-send', { prompt, deep: !!deep }) as Promise<{ ok: boolean; id?: string | null; error?: string }>
    },
    // Sent BY the notch hit-window (the tiny always-interactive transparent window placed exactly over the physical
    // notch). Main forwards them to the overlay renderer as os:notch-handle-click / os:notch-handle-hover.
    click(): void {
      ipcRenderer.send('os:notch-click')
    },
    hover(on: boolean): void {
      ipcRenderer.send('os:notch-hover', !!on)
    },
    onToggle(cb: () => void): () => void {
      const listener = (): void => cb()
      ipcRenderer.on('os:notch-toggle', listener)
      return () => ipcRenderer.removeListener('os:notch-toggle', listener)
    },
    // Listened to BY the overlay renderer: the hit-window's click toggles fullscreen, its hover opens/closes the panel.
    onHandleClick(cb: () => void): () => void {
      const listener = (): void => cb()
      ipcRenderer.on('os:notch-handle-click', listener)
      return () => ipcRenderer.removeListener('os:notch-handle-click', listener)
    },
    onHandleHover(cb: (on: boolean) => void): () => void {
      const listener = (_e: unknown, on: boolean): void => cb(!!on)
      ipcRenderer.on('os:notch-handle-hover', listener)
      return () => ipcRenderer.removeListener('os:notch-handle-hover', listener)
    },
    onGeometry(
      cb: (g: { width: number; height: number; menuBarH: number; notchWidth?: number; hasNotch?: boolean }) => void
    ): () => void {
      const listener = (
        _e: unknown,
        g: { width: number; height: number; menuBarH: number; notchWidth?: number; hasNotch?: boolean }
      ): void => cb(g)
      ipcRenderer.on('os:notch-geometry', listener)
      return () => ipcRenderer.removeListener('os:notch-geometry', listener)
    }
  }
}

contextBridge.exposeInMainWorld('agentOS', api)

export type AgentOSApi = typeof api
