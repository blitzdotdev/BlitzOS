import { useEffect, useRef, useState } from 'react'
import { useDesktop, viewTransform, areaRect, type CreateSurfaceInput } from './store'
import type { Surface, CanvasTransform } from './types'
import { isRuntimePanel } from './types'
import { IntegrationWidget } from './components/IntegrationWidget'
import { ConnectPanel } from './components/ConnectPanel'
import { Overview } from './components/Overview'
import { capturePrimaryThumb } from './capture'
import { SurfaceFrame } from './components/SurfaceFrame'
import { PrimarySpace } from './components/PrimarySpace'
import { Sidebar } from './components/Sidebar'
import { IconChat, IconSparkle, IconGrid, IconChevronDown } from './components/Icons'
import { FolderOverlay } from './components/FolderOverlay'
import { OnboardingFlow } from './onboarding/OnboardingFlow'
import { shouldShowOnboarding, markOnboarded } from './onboarding/config'
import { ContextMenu } from './components/ContextMenu'

// Legacy always-on integration cards on the canvas (they stacked at origin and clutter the agent-driven
// desktop). Off by default — integrations now surface as agent-spawned widgets. Flip to re-enable.
const SHOW_INTEGRATION_CARDS = false

// The shared Notepad note BlitzOS keeps as working memory (human + agent r/w). Ensured after each
// hydrate so a fresh workspace gets one (it then persists as a file); idempotent on a restored board.
function ensureNotepad(): void {
  // Both transports get a Notepad (it persists as a file in the workspace folder = the agent's
  // memory; the manual + the dynamic-boot instruction both rely on it existing, incl. server mode).
  const st = useDesktop.getState()
  if (st.surfaces.some((s) => s.kind === 'native' && s.component === 'note' && s.title === 'Notepad')) return
  st.createSurface({
    kind: 'native',
    component: 'note',
    title: 'Notepad',
    props: {
      text: '# Notepad\n\nShared working memory for you and BlitzOS. The agent keeps context and notes here; you can edit it too.\n',
      color: 'yellow'
    }
  })
}

// Server-mode FOLDER drop: the browser exposes the dropped tree via webkitGetAsEntry(). Recurse it,
// upload each file with its in-folder subpath (reconcile deferred), then reconcile ONCE so the whole
// folder surfaces as a single tile. (Electron drops carry real OS paths and use a recursive copy instead.)
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const out: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
    if (!batch.length) break
    out.push(...batch)
  }
  return out
}
async function uploadDroppedEntries(entries: FileSystemEntry[], wx: number, wy: number): Promise<void> {
  const uploads: Array<{ rel: string; getFile: () => Promise<File> }> = []
  async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const fe = entry as FileSystemFileEntry
      uploads.push({ rel: prefix + entry.name, getFile: () => new Promise<File>((res, rej) => fe.file(res, rej)) })
    } else if (entry.isDirectory) {
      const kids = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
      for (const k of kids) await walk(k, prefix + entry.name + '/')
    }
  }
  for (const en of entries) if (en) await walk(en, '')
  const capped = uploads.slice(0, 2000) // safety cap — a drop this large is unusual
  for (const u of capped) {
    try {
      const buf = await (await u.getFile()).arrayBuffer()
      await fetch(`/api/os/upload?name=${encodeURIComponent(u.rel)}&reconcile=0`, { method: 'POST', body: buf })
    } catch {
      /* skip a file we couldn't read/upload */
    }
  }
  try {
    await fetch('/api/os/reconcile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: wx, y: wy }) })
  } catch {
    /* the watcher reconcile will still pick the files up shortly */
  }
}

export default function App(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const transform = useDesktop((s) => s.transform)
  const mode = useDesktop((s) => s.mode)
  const areaCount = useDesktop((s) => s.areaCount)
  const currentArea = useDesktop((s) => s.currentArea)
  const integrations = useDesktop((s) => s.integrations)
  const surfaces = useDesktop((s) => s.surfaces)
  const grabMode = useDesktop((s) => s.grabMode)
  const snapPreview = useDesktop((s) => s.snapPreview)
  const selection = useDesktop((s) => s.selection)
  const createSurface = useDesktop((s) => s.createSurface)
  const setIntegrations = useDesktop((s) => s.setIntegrations)

  const [connecting, setConnecting] = useState<string | null>(null)
  const [aiUrl, setAiUrl] = useState<string | null>(null)
  const [showAi, setShowAi] = useState(false)
  // Relay/brain connection health, broadcast by the backend (server mode). null = unknown/not reported yet.
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null)
  const [showOverview, setShowOverview] = useState(false)
  const [activeWs, setActiveWs] = useState<string | null>(null)
  const [onboarding, setOnboarding] = useState(() => shouldShowOnboarding())
  // #51: pending write-approvals the agent requested (provider.call writes) — the human OKs or denies each.
  // A QUEUE (not a single slot) so concurrent writes don't overwrite each other's card (review fix); we
  // show the oldest and pop it on answer. Keyed by id, matching provider-bridge's pending Map.
  const [providerApprovals, setProviderApprovals] = useState<Array<{ id: string; summary: string; risk: string }>>([])
  // Right-click desktop menu (New Folder / New Board). wx/wy = the world position to place the new folder.
  const [menu, setMenu] = useState<{ x: number; y: number; wx: number; wy: number } | null>(null)
  const isServer = !!window.agentOS?.serverMode
  const hasWorkspaces = !!window.agentOS?.workspaces // present in BOTH modes (Electron preload + server shim)
  const pan = useRef<{ x: number; y: number } | null>(null)
  const marquee = useRef<{ x0: number; y0: number } | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  // Phase 2: true once the backend has sent (or declined) a hydrate. The state-push is
  // gated on this so a freshly-loaded renderer can't post its empty store and clobber the
  // restored canvas before hydration arrives.
  const hydrated = useRef(false)
  // The active workspace name, mirrored into a ref so the state-push closure (an effect with []
  // deps) reads the CURRENT value — each push is tagged with it so the backend can drop a stale
  // push that belongs to a workspace we already switched away from (else it corrupts the new folder).
  const activeWsRef = useRef<string | null>(null)
  const animRef = useRef<number | null>(null)

  // Smoothly tween the camera (used when entering/leaving control mode).
  function animateTransform(target: CanvasTransform, dur = 320): void {
    const from = useDesktop.getState().transform
    if (animRef.current) cancelAnimationFrame(animRef.current)
    const t0 = performance.now()
    const ease = (p: number): number => 1 - Math.pow(1 - p, 3) // cubic ease-out
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / dur)
      const k = ease(p)
      useDesktop.getState().setTransform({
        x: from.x + (target.x - from.x) * k,
        y: from.y + (target.y - from.y) * k,
        scale: from.scale + (target.scale - from.scale) * k
      })
      animRef.current = p < 1 ? requestAnimationFrame(step) : null
    }
    animRef.current = requestAnimationFrame(step)
  }
  // Double-tap ⌘ toggles "Control mode" (the zoomed-out bird's-eye): animate the camera to the
  // control viewport on enter and back to the locked primary-area view on exit. Both modes exist in
  // BOTH transports (Electron + server/Chrome); normal mode is the default everywhere.
  function toggleControlMode(): void {
    const st = useDesktop.getState()
    st.setSnapPreview(null) // a mode switch cancels any in-flight drag UI
    st.setDragTarget(null)
    const next = st.mode === 'desktop' ? 'canvas' : 'desktop'
    if (next === 'canvas') {
      // Entering control mode: ALWAYS the gentle default zoom-out (controlScale 0.7), never a stale
      // remembered camera — the human wants a consistent gentle bird's-eye, not whatever it was left at.
      const target = viewTransform('canvas', st.viewport, st.currentArea, st.areaCount)
      st.setMode('canvas')
      animateTransform(target)
    } else {
      // Leaving control mode: animate back to the view-locked CURRENT area. controlTransform was
      // already kept current by every pan/zoom/center in canvas mode, so there's nothing to capture
      // here (capturing st.transform now could grab a mid-animation frame — the ISSUE-3 trap).
      st.setMode('desktop')
      animateTransform(viewTransform('desktop', st.viewport, st.currentArea, st.areaCount))
    }
  }

  // Switch to an adjacent workspace area (#45). In normal mode the camera animates to the new area
  // (each area locks to the same on-screen desktop region); in control mode the bird's-eye already
  // shows every area, so we only move the highlight. No-op past the ends.
  function switchArea(delta: number): void {
    const st = useDesktop.getState()
    const next = Math.max(0, Math.min(st.areaCount - 1, st.currentArea + delta))
    if (next === st.currentArea) return
    st.setCurrentArea(next)
    if (st.mode === 'desktop') animateTransform(viewTransform('desktop', st.viewport, next, st.areaCount))
  }
  // Add a new (empty) area to the right and go to it (re-fits the bird's-eye in control mode).
  function addAreaAndGo(): void {
    useDesktop.getState().addArea()
    const now = useDesktop.getState()
    animateTransform(viewTransform(now.mode, now.viewport, now.currentArea, now.areaCount))
  }

  useEffect(() => {
    const refresh = (): void => {
      window.agentOS?.integrations.list().then(setIntegrations)
    }
    refresh()
    const off = window.agentOS?.integrations.onUpdated(refresh)
    window.addEventListener('focus', refresh)
    return () => {
      off?.()
      window.removeEventListener('focus', refresh)
    }
  }, [setIntegrations])

  // The default Notepad is ensured after each hydrate (see the 'hydrate'/'switch' handlers below),
  // so it persists as a file in the active workspace instead of being recreated per session.

  useEffect(() => {
    const onResize = (): void => {
      useDesktop.getState().setViewport(window.innerWidth, window.innerHeight)
      useDesktop.getState().goToPrimary() // re-fit the camera to the new viewport in BOTH modes (control too)
    }
    onResize()
    useDesktop.getState().goToPrimary()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      // pan/zoom only on an UNLOCKED canvas; when locked (⌘⌘) or in desktop mode,
      // let webviews/iframes scroll normally
      const w = useDesktop.getState()
      if (w.mode !== 'canvas' || w.locked) return
      e.preventDefault()
      const st = useDesktop.getState()
      if (e.ctrlKey) st.zoomAt(e.clientX, e.clientY, e.deltaY)
      else st.panBy(-e.deltaX, -e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        useDesktop.getState().goToPrimary()
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) {
        // Cmd+G: collapse the multi-selection into an iPhone-style folder you tap to open (in-memory
        // `component:'folder'` via groupSelection). Works for ANY surface kind — windows, widgets, notes
        // — whereas the file-based disk folder/board (the old Cmd+G path) silently no-ops on a widget
        // with no file to move. REAL persistent folders/boards stay on the right-click desktop menu and
        // the agent's `group` tool, so this keybind is purely the quick visual grouping.
        e.preventDefault()
        useDesktop.getState().groupSelection()
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        // layout undo (Cmd+Z) when nothing editable is focused; else let the browser text-undo win
        const ae = document.activeElement as HTMLElement | null
        const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        if (!editable) {
          e.preventDefault()
          useDesktop.getState().undoLayout()
        }
      } else if (e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // Cmd + ← / → : switch BlitzOS workspace area (#45). Ctrl + ← / → is intentionally NOT bound — it's
        // the macOS "switch desktop/Space" shortcut, left free so the user can swap real desktops (their way
        // out of fullscreen). Skip when typing, and when there's only one area.
        const ae = document.activeElement as HTMLElement | null
        const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        if (!editable && useDesktop.getState().areaCount > 1) {
          e.preventDefault()
          switchArea(e.key === 'ArrowLeft' ? -1 : 1)
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
        // Cmd/Ctrl + N : add a new workspace area and jump to it (#45). Skip when typing in a field.
        const ae = document.activeElement as HTMLElement | null
        const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        if (!editable) {
          e.preventDefault()
          addAreaAndGo()
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete / ⌫ closes the selected surfaces (when not typing in a field).
        const ae = document.activeElement as HTMLElement | null
        const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        const st = useDesktop.getState()
        if (!editable && st.selection.length) {
          e.preventDefault()
          const ids = [...st.selection]
          ids.forEach((id) => st.closeSurface(id))
          st.clearSelection()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Hold ⌥ (or Space, when not typing) → "grab mode": drag any surface from anywhere to
  // move it (and select it); release to interact with content again.
  // NOTE: a key held while a <webview> has keyboard focus is delivered to that guest, not
  // here — so grab-mode may not engage until you click off a focused web page. A robust
  // fix is to forward ⌥/Space from guests via main (like onMetaTap); deferred.
  useEffect(() => {
    const editable = (): boolean => {
      const ae = document.activeElement as HTMLElement | null
      return !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Alt' || (e.key === ' ' && !editable())) {
        if (e.key === ' ') e.preventDefault()
        useDesktop.getState().setGrabMode(true)
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Alt' || e.key === ' ') useDesktop.getState().setGrabMode(false)
    }
    const clear = (): void => useDesktop.getState().setGrabMode(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])

  // Double-tap ⌘ to toggle Control mode (the bird's-eye overview). A bare ⌘ tap from a focused
  // webview arrives via onMetaTap (main); plain keydown/keyup covers the browser/server transport.
  useEffect(() => {
    let metaDown = false
    let sawOther = false
    let lastTap = 0
    const registerTap = (): void => {
      const now = performance.now()
      if (now - lastTap < 450) {
        lastTap = 0
        toggleControlMode()
      } else {
        lastTap = now
      }
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Meta') {
        if (!e.repeat) {
          metaDown = true
          sawOther = false
        }
      } else if (metaDown) {
        sawOther = true
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Meta') {
        if (metaDown && !sawOther) registerTap()
        metaDown = false
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    const off = window.agentOS?.onMetaTap(registerTap)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      off?.()
    }
  }, [])

  // Control actions from main (local control server or agent-socket).
  useEffect(() => {
    return window.agentOS?.onAction((a) => {
      const st = useDesktop.getState()
      if (a.type === 'hydrate') {
        // FIRST hydrate wins: a live renderer is the source of truth mid-session, so an SSE
        // RECONNECT re-sending hydrate must not wholesale-replace (and wipe undo/camera/canvas).
        if (hydrated.current) return
        // Restore a persisted workspace from disk (Phase 2). Replaces the canvas wholesale.
        const surfs = Array.isArray(a.surfaces) ? (a.surfaces as Surface[]) : []
        const cam = (a.camera as { x: number; y: number; scale: number }) ?? { x: 0, y: 0, scale: 1 }
        // Control mode is a transient view toggle, never persisted — always boot the normal desktop.
        st.hydrate(surfs, cam, 'desktop', Number(a.areaCount) || 1)
        ensureNotepad()
        hydrated.current = true
        if (typeof a.workspace === 'string') {
          setActiveWs(a.workspace)
          activeWsRef.current = a.workspace
        }
      } else if (a.type === 'switch') {
        // FORCED re-hydrate on a workspace switch — wholesale swap the canvas. Bypasses the
        // first-hydrate-wins guard, but keeps hydrated.current true (never reset) so a racing SSE
        // reconnect's hydrate still can't clobber the new board.
        const sf = Array.isArray(a.surfaces) ? (a.surfaces as Surface[]) : []
        const cm = (a.camera as { x: number; y: number; scale: number }) ?? { x: 0, y: 0, scale: 1 }
        st.hydrate(sf, cm, 'desktop', Number(a.areaCount) || 1)
        ensureNotepad()
        hydrated.current = true // a switch is also a valid first hydrate — don't depend on a prior 'hydrate'
        if (typeof a.workspace === 'string') {
          setActiveWs(a.workspace)
          activeWsRef.current = a.workspace
        }
        setShowOverview(false)
      } else if (a.type === 'reconcile') {
        // External folder change (dropped/edited/removed files) — merge live, keeping the camera +
        // the runtime chat/activity panels. Only once we already have a canvas (post first hydrate).
        if (hydrated.current) st.applyReconcile(Array.isArray(a.surfaces) ? (a.surfaces as Surface[]) : [])
      } else if (a.type === 'create') {
        const surf = a.surface as CreateSurfaceInput
        // agent-opened web/app surfaces are readable by the agent (it chose the url) -> show 👁 on
        if (surf && (surf.kind === 'web' || surf.kind === 'app')) surf.shared = true
        st.createSurface(surf)
      }
      else if (a.type === 'provider-approval') {
        // The agent asked to perform a WRITE on a connected provider (#51) — show the human a card.
        const req = a.request as { id?: string; summary?: string; risk?: string } | undefined
        if (req && req.id) {
          const card = { id: String(req.id), summary: String(req.summary || 'a provider write'), risk: String(req.risk || 'write') }
          setProviderApprovals((q) => (q.some((c) => c.id === card.id) ? q : [...q, card])) // enqueue (dedupe by id)
        }
      }
      else if (a.type === 'move') st.moveSurface(String(a.id), Number(a.x), Number(a.y))
      else if (a.type === 'update') st.updateSurface(String(a.id), (a.patch ?? {}) as Partial<Surface>)
      else if (a.type === 'close') st.closeSurface(String(a.id))
      else if (a.type === 'goToPrimary') st.goToPrimary()
      else if (a.type === 'chat') {
        // The OS owns the transcript (chat.md) and sends the FULL message list; the chat widget renders
        // props.messages. (Legacy single-text callers fall back to an append.) The chat surface is the
        // role:'chat' srcdoc the host hydrates — if it isn't here yet, ignore (hydrate will bring it).
        const chat = st.surfaces.find((s) => s.role === 'chat' || (s.kind === 'native' && s.component === 'chat'))
        if (!chat) return
        if (Array.isArray(a.messages)) {
          st.updateSurfaceProps(chat.id, { messages: a.messages as Array<{ role: string; text: string }> })
        } else {
          const text = String(a.text ?? '')
          if (!text) return
          const msgs = (chat.props?.messages as Array<{ role: string; text: string }>) ?? []
          st.updateSurfaceProps(chat.id, { messages: [...msgs, { role: 'agent', text }].slice(-200) })
        }
      } else if (a.type === 'agentStatus') {
        // Backend heartbeat: is the brain's relay link up? Drives the toolbar status pill.
        setAgentOnline(!!a.online)
      } else if (a.type === 'activity') {
        // A live feed of what the agent is doing (its tool calls) -> the Agent-activity
        // panel (auto-created, pinned), so the user can see it working during latency.
        const text = String(a.text ?? '')
        if (!text) return
        const evt = { at: Number(a.at) || Date.now(), text }
        const panel = st.surfaces.find((s) => s.kind === 'native' && s.component === 'activity')
        if (panel) {
          const evs = (panel.props?.events as Array<{ at: number; text: string }>) ?? []
          st.updateSurfaceProps(panel.id, { events: [...evs, evt].slice(-60) })
        } else {
          st.createSurface(activitySurfaceInput([evt]))
        }
      }
    })
  }, [])

  // Ask main for the persisted canvas once our onAction listener (above) is mounted; Electron
  // replies with a 'hydrate' os:action. In server mode the SSE connect delivers it, so this no-ops.
  useEffect(() => {
    window.agentOS?.requestHydrate?.()
  }, [])

  // srcdoc surfaces (agent-authored UI) can fire actions back to the agent: a
  // sandboxed iframe postMessages {__blitz:'action', surfaceId, ...} to us and we
  // forward it to main, which emits it into the agent's event stream (the callback
  // half of interactive surfaces, e.g. an "approve" button in a triage panel).
  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      const d = e.data as Record<string, unknown> | null
      if (!d || typeof d !== 'object') return
      // Local UI action: navigate the shared "Sources" tab instantly, no agent round-trip.
      // Only http(s) — a sandboxed widget must not push javascript:/data:/file: URLs into a web surface.
      if (d.__blitz === 'navigate' && typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) {
        const st = useDesktop.getState()
        const tab = st.surfaces.find((s) => s.kind === 'web' && s.title === 'Sources')
        if (tab) st.updateSurface(tab.id, { url: d.url as string })
        else st.createSurface({ kind: 'web', url: d.url as string, title: 'Sources' })
        return
      }
      // Agent action: forward to the agent's event stream (approve, etc.). Cap the
      // payload so a hostile widget can't pump large/looping content through it.
      if (d.__blitz === 'action') {
        try {
          if (JSON.stringify(d).length <= 4000) window.agentOS?.surfaceAction(d)
        } catch {
          /* non-serializable payload — drop */
        }
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Push desktop state to main (so list_state works). Includes the layout the agent
  // needs to arrange windows well: the viewport (screen size), the world-space rect the
  // user can actually SEE right now (so it never drops surfaces off-screen), per-surface
  // z (stacking), and the mode. Surface changes push immediately; camera/pan churn is
  // throttled so panning doesn't flood the channel.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const push = (): void => {
      if (!hydrated.current) return // don't clobber a restoring canvas with our empty store
      const st = useDesktop.getState()
      const { scale, x: tx, y: ty } = st.transform
      const vw = st.viewport.w
      const vh = st.viewport.h
      const surfaces = st.surfaces.map((s) => ({
        id: s.id,
        kind: s.kind,
        x: Math.round(s.x),
        y: Math.round(s.y),
        w: s.w,
        h: s.h,
        z: s.z,
        zoom: s.zoom,
        title: s.title,
        url: s.url,
        html: s.html,
        props: s.props,
        component: s.component,
        role: s.role,
        // Chat + Agent-activity panels are pinned always-on-top — the agent must not cover them
        pinned: isRuntimePanel(s)
      }))
      // The world-space rectangle currently visible on screen (screen = world*scale + t).
      const view = {
        x: Math.round(-tx / scale),
        y: Math.round(-ty / scale),
        w: Math.round(vw / scale),
        h: Math.round(vh / scale),
        cx: Math.round((vw / 2 - tx) / scale),
        cy: Math.round((vh / 2 - ty) / scale),
        scale: Math.round(scale * 100) / 100
      }
      // camera = the WORLD point at screen center + scale (viewport-independent, so it restores
      // correctly on a different screen size — view.cx/cy are exactly that world point).
      // #45: also push the area count + which area is active + the CURRENT area's world rect, so the
      // agent (list_state) places surfaces in the area the human is looking at, not blindly at origin.
      const currentAreaRect = areaRect(st.currentArea, st.viewport)
      window.agentOS?.sendState({
        workspace: activeWsRef.current ?? undefined,
        surfaces,
        viewport: { w: vw, h: vh },
        view,
        mode: st.mode,
        camera: { x: view.cx, y: view.cy, scale },
        areaCount: st.areaCount,
        currentArea: st.currentArea,
        currentAreaRect
      })
    }
    push()
    // SERVER mode always delivers a hydrate on SSE connect, so we wait for it (no fallback) —
    // a fallback there could fire before a slow hydrate, which the first-hydrate-wins guard
    // would then ignore, never restoring. Electron has no server hydrate, so it gets a grace
    // timer to start pushing (and only if it actually has surfaces, to never push an empty store).
    const hydrateFallback = isServer
      ? null
      : setTimeout(() => {
          if (!hydrated.current) {
            hydrated.current = true
            if (useDesktop.getState().surfaces.length) push()
          }
        }, 1500)
    let lastS = useDesktop.getState().surfaces
    let lastT = useDesktop.getState().transform
    let lastVp = useDesktop.getState().viewport
    let lastMode = useDesktop.getState().mode
    let lastArea = useDesktop.getState().currentArea
    let lastAreaCount = useDesktop.getState().areaCount
    const scheduleCamera = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        push()
      }, 250)
    }
    const unsub = useDesktop.subscribe((state) => {
      if (state.surfaces !== lastS) {
        lastS = state.surfaces
        push() // surface set changed — reflect it at once
      } else if (state.areaCount !== lastAreaCount || state.currentArea !== lastArea) {
        // an area switch / add changes which area the agent should target — reflect it at once
        lastArea = state.currentArea
        lastAreaCount = state.areaCount
        push()
      } else if (state.transform !== lastT || state.viewport !== lastVp || state.mode !== lastMode) {
        lastT = state.transform
        lastVp = state.viewport
        lastMode = state.mode
        scheduleCamera() // pan/zoom — coalesce bursts
      }
    })
    return () => {
      if (hydrateFallback) clearTimeout(hydrateFallback)
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [])

  useEffect(() => {
    return window.agentOS?.onAgentSocketUrl((url) => setAiUrl(url))
  }, [])

  // Drag a file from the desktop onto the canvas → upload it into the workspace folder at the drop
  // world-position (server mode; Electron drag-drop uses file paths — a separate path). The tile
  // then appears via reconcile.
  function onDragOver(e: React.DragEvent): void {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  function onDrop(e: React.DragEvent): void {
    const files = Array.from(e.dataTransfer?.files ?? [])
    const items = Array.from(e.dataTransfer?.items ?? [])
    if (!files.length && !items.length) return
    e.preventDefault()
    const t = useDesktop.getState().transform
    const wx = Math.round((e.clientX - t.x) / t.scale)
    const wy = Math.round((e.clientY - t.y) / t.scale)
    const api = window.agentOS
    // Electron: dropped files AND folders carry real OS paths → copy them into the workspace (a folder
    // copies recursively → ONE collapsed tile). This is the desktop-app path the old code skipped (bug).
    if (api && !api.serverMode && api.dropPaths && api.ingestPaths) {
      const paths = api.dropPaths(files)
      if (paths.length) {
        void api.ingestPaths(paths, wx, wy)
        return
      }
    }
    // Server: the browser has no FS path → upload bytes. A dropped FOLDER is recursed via webkitGetAsEntry
    // (each file uploaded with its in-folder subpath, then one reconcile) so it lands as a real subfolder.
    const entries = items.map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null)).filter((en): en is FileSystemEntry => !!en)
    if (entries.some((en) => en.isDirectory)) {
      void uploadDroppedEntries(entries, wx, wy)
      return
    }
    if (!files.length) return
    files.forEach(async (file, i) => {
      try {
        const buf = await file.arrayBuffer()
        await fetch(`/api/os/upload?name=${encodeURIComponent(file.name)}&x=${wx + i * 24}&y=${wy + i * 24}`, { method: 'POST', body: buf })
      } catch {
        /* ignore a failed upload */
      }
    })
  }

  // Right-click empty canvas → New Folder / New Board menu (the discoverable counterpart of Cmd+G).
  function onBgContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    const t = useDesktop.getState().transform
    setMenu({ x: e.clientX, y: e.clientY, wx: Math.round((e.clientX - t.x) / t.scale), wy: Math.round((e.clientY - t.y) / t.scale) })
  }
  // New EMPTY folder (files) or board (windows+widgets) at the click point.
  function makeFolder(kind: 'folder' | 'board', wx: number, wy: number): void {
    void window.agentOS?.newFolder?.(kind === 'board' ? 'Board' : 'Folder', kind, wx, wy)
  }
  // Group the current selection into a real folder (files) or board (windows/widgets stay live + splay).
  function groupSelectionInto(kind: 'folder' | 'board'): void {
    const ids = [...useDesktop.getState().selection]
    if (!ids.length) return
    void window.agentOS?.groupIntoFolder?.(kind === 'board' ? 'Board' : 'Folder', ids, kind)
    useDesktop.getState().clearSelection()
  }

  function onBgDown(e: React.PointerEvent): void {
    // Only the LEFT button pans / starts a marquee / clears the selection. A right-click is the context
    // menu (onBgContextMenu) — it must NOT clear the selection, or "New Folder/Board with Selection (N)"
    // would never show (the right-click's pointerdown was wiping the very selection the menu groups).
    if (e.button !== 0) return
    const st = useDesktop.getState()
    if (st.mode === 'canvas' && !st.locked) {
      // unlocked canvas: drag the background to pan
      pan.current = { x: e.clientX, y: e.clientY }
    } else {
      // locked canvas (or desktop): rubber-band (marquee) selection. Shift adds to the selection.
      if (!e.shiftKey) st.clearSelection()
      marquee.current = { x0: e.clientX, y0: e.clientY }
      setMarqueeRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 })
    }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* no pointer capture (e.g. synthetic events) — fine */
    }
  }
  function onBgMove(e: React.PointerEvent): void {
    if (pan.current) {
      useDesktop.getState().panBy(e.clientX - pan.current.x, e.clientY - pan.current.y)
      pan.current = { x: e.clientX, y: e.clientY }
      return
    }
    if (!marquee.current) return
    const { x0, y0 } = marquee.current
    const x = Math.min(x0, e.clientX)
    const y = Math.min(y0, e.clientY)
    const w = Math.abs(e.clientX - x0)
    const h = Math.abs(e.clientY - y0)
    setMarqueeRect({ x, y, w, h })
    // screen rect -> world rect (screen = world*scale + t), then AABB-intersect surfaces
    const st = useDesktop.getState()
    const t = st.transform
    const wr = { x: (x - t.x) / t.scale, y: (y - t.y) / t.scale, w: w / t.scale, h: h / t.scale }
    const hit = st.surfaces
      .filter((s) => wr.x < s.x + s.w && wr.x + wr.w > s.x && wr.y < s.y + s.h && wr.y + wr.h > s.y)
      .map((s) => s.id)
    st.setSelection(hit)
  }
  function onBgUp(e: React.PointerEvent): void {
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    pan.current = null
    marquee.current = null
    setMarqueeRect(null)
  }

  // The Chat panel docks to the LEFT of whatever the user is currently looking at,
  // so it opens visible (and stays out of the area where the agent puts windows).
  function chatSurfaceInput(messages: Array<{ role: string; text: string }>): CreateSurfaceInput {
    const st = useDesktop.getState()
    const { scale, x: tx, y: ty } = st.transform
    const W = 360
    const H = 460
    const x = Math.round(-tx / scale + 24) // 24 world-px from the left edge of the view
    const y = Math.round((st.viewport.h / 2 - ty) / scale - H / 2) // vertically centered
    return { kind: 'native', component: 'chat', title: 'Chat', w: W, h: H, x, y, props: { messages } }
  }

  // The Agent-activity feed docks to the TOP-LEFT of the view (above the centered chat).
  function activitySurfaceInput(events: Array<{ at: number; text: string }>): CreateSurfaceInput {
    const st = useDesktop.getState()
    const { scale, x: tx, y: ty } = st.transform
    const W = 320
    const H = 200
    const x = Math.round(-tx / scale + 24)
    const y = Math.round(-ty / scale + 24)
    return { kind: 'native', component: 'activity', title: 'Agent activity', w: W, h: H, x, y, props: { events } }
  }

  function addBrowser(): void {
    // let the store cascade + clamp onto the desktop
    createSurface({ kind: 'web', url: 'https://news.ycombinator.com', title: 'Hacker News' })
  }

  // Capture the CURRENT board's primary-area snapshot and upload it as its workspace thumbnail
  // (best-effort, last-seen). Done before opening the overview and before switching away (while the
  // board we're leaving still has live streamed frames — they're torn down by the switch).
  async function captureCurrent(): Promise<void> {
    const name = activeWsRef.current
    const ws = window.agentOS?.workspaces
    if (!name || !ws) return
    try {
      if (ws.captureThumb) {
        await ws.captureThumb(name) // Electron: main-side capturePage (real pixels, incl. <webview>s)
      } else if (ws.thumb) {
        const dataUrl = capturePrimaryThumb() // server: composite the streamed canvases + upload
        if (dataUrl) await ws.thumb(name, dataUrl)
      }
    } catch {
      /* best-effort snapshot */
    }
  }
  async function openOverview(): Promise<void> {
    await captureCurrent() // refresh the active board's tile first
    setShowOverview(true)
  }
  async function switchWorkspace(name: string): Promise<{ ok: boolean; error?: string }> {
    await captureCurrent() // snapshot the board we're leaving BEFORE its targets are torn down
    const r = await window.agentOS?.workspaces?.switch(name)
    // success → the {type:'switch'} broadcast swaps the canvas + closes the overview; a 409 (lock) /
    // 404 / 500 resolves {error} (getJSON never throws) → signal it so the overview clears "opening…".
    return r?.ok ? { ok: true } : { ok: false, error: (r as { error?: string })?.error || 'could not switch' }
  }

  function openChat(): void {
    const st = useDesktop.getState()
    // The chat is a host-hydrated role:'chat' srcdoc widget (blitz-chat.html). Just focus/center it; if a
    // very old session is still on the native chat, fall back to that.
    const existing = st.surfaces.find((s) => s.role === 'chat' || (s.kind === 'native' && s.component === 'chat'))
    if (existing) st.focusSurface(existing.id)
    else createSurface(chatSurfaceInput([]))
  }

  const active = integrations.find((i) => i.id === connecting) ?? null
  const openFolder = surfaces.find((s) => s.kind === 'native' && s.component === 'folder' && s.props?.open)

  return (
    <div id="root-canvas" ref={rootRef} className={grabMode ? 'grab-mode' : undefined} onDragOver={onDragOver} onDrop={onDrop}>
      {/* draggable native-window title bar (macOS move/resize) */}
      <div className="titlebar">
        <span className="titlebar-label">BlitzOS</span>
      </div>

      <div className="bg" onPointerDown={onBgDown} onPointerMove={onBgMove} onPointerUp={onBgUp} onContextMenu={onBgContextMenu} />

      <Sidebar onAddBrowser={addBrowser} />

      <div
        className="world"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      >
        {mode === 'canvas' && <PrimarySpace />}
        {snapPreview && (
          <div
            className="snap-preview"
            style={{ left: snapPreview.x, top: snapPreview.y, width: snapPreview.w, height: snapPreview.h }}
          />
        )}
        {/* Always-on integration connect cards are hidden — integrations surface as agent-spawned widgets
            (e.g. `spawn_widget discord-list`, which reads live data through the OS), not fixed canvas cards.
            Connection status + the OAuth flow still live in ConnectPanel (reachable from the dock). */}
        {SHOW_INTEGRATION_CARDS &&
          integrations.map((it) => <IntegrationWidget key={it.id} integration={it} onConnect={setConnecting} />)}
        {surfaces.map((s) =>
          // folder members live only inside the folder — unless "peeked" open onto the desktop
          s.groupId && !s.peek ? null : <SurfaceFrame key={s.id} surface={s} />
        )}
      </div>

      {mode === 'canvas' && (
        <div className="pan-overlay">
          <span className="pan-hint">Control mode · drag cards to rearrange · scroll or drag the void to pan · double-tap ⌘ to exit</span>
        </div>
      )}

      {marqueeRect && (
        <div
          className="marquee"
          style={{ left: marqueeRect.x, top: marqueeRect.y, width: marqueeRect.w, height: marqueeRect.h }}
        />
      )}

      <div className="toolbar">
        {hasWorkspaces && (
          <button className="ws-btn" onClick={() => void openOverview()} title="Workspaces (Mission Control)">
            <IconGrid size={14} />
            <span className="ws-name">{activeWs ?? '…'}</span>
            <IconChevronDown size={13} />
          </button>
        )}
        {/* Workspace areas (#45): the indicator appears once there's more than one. Create a new area
            with Cmd/Ctrl + N; switch areas with Cmd/Ctrl + ← →. */}
        {areaCount > 1 && (
          <span className="area-ctl" title="Workspace areas — ⌘N new · ⌘← ⌘→ switch">
            <button className="area-arrow" disabled={currentArea <= 0} onClick={() => switchArea(-1)} title="Previous area">‹</button>
            <span className="area-ind">Area {currentArea + 1}/{areaCount}</span>
            <button className="area-arrow" disabled={currentArea >= areaCount - 1} onClick={() => switchArea(1)} title="Next area">›</button>
          </span>
        )}
        <button style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={openChat}>
          <IconChat size={15} /> Chat
        </button>
        <button style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setShowAi((v) => !v)}>
          <span style={{ display: 'inline-flex', color: aiUrl ? 'var(--positive)' : 'var(--text-muted)' }}>
            <IconSparkle size={15} />
          </span>
          Connect AI
        </button>
        {isServer && agentOnline !== null && (
          <span
            title={agentOnline ? 'Brain connected — it can see your chat and the canvas' : 'Brain link is down — reconnecting…'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: agentOnline ? 'var(--positive)' : 'var(--text-muted)' }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: agentOnline ? 'var(--positive)' : '#e0a23c' }} />
            {agentOnline ? 'Agent online' : 'Agent reconnecting…'}
          </span>
        )}
        {!isServer && (
          <span className="hint">
            double-tap ⌘ for control mode
          </span>
        )}
      </div>

      {showAi && (
        <div className="hud">
          <div className="hud-head">Drive BlitzOS from an AI chat</div>
          {aiUrl ? (
            <>
              <p className="hud-sub">
                Paste this URL into a <strong>tool-capable</strong> AI agent — Claude Code, or <code>claude -p</code> — and ask
                it to open windows, post-its, etc. (It needs to make HTTP calls, so a plain Claude.ai / ChatGPT chat can only
                read the link, not drive BlitzOS.)
              </p>
              <div className="hud-row">
                <input className="hud-input" readOnly value={aiUrl} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn primary" onClick={() => navigator.clipboard?.writeText(aiUrl)}>
                  Copy
                </button>
              </div>
            </>
          ) : (
            <p className="hud-sub">Connecting to the agent-socket relay…</p>
          )}
        </div>
      )}

      {hasWorkspaces && showOverview && <Overview onClose={() => setShowOverview(false)} onSwitch={switchWorkspace} />}
      {active && <ConnectPanel integration={active} onClose={() => setConnecting(null)} />}

      {openFolder && <FolderOverlay folder={openFolder} />}

      {onboarding && (
        <OnboardingFlow
          onComplete={() => {
            markOnboarded()
            setOnboarding(false)
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'New Folder', onClick: () => makeFolder('folder', menu.wx, menu.wy) },
            { label: 'New Board', onClick: () => makeFolder('board', menu.wx, menu.wy) },
            // A selection of LIVE surfaces (windows/widgets/notes) → the iPhone-style collapsing folder you
            // tap to open (groupSelection — in-memory, works for ANY kind). Only a selection of REAL file/dir
            // tiles offers the disk folder, since collapsing live surfaces into a file-manager would just turn
            // them into bare file entries. (Real disk folders/boards stay the agent's `group` tool + drag-drop.)
            ...(selection.length
              ? (() => {
                  const sel = surfaces.filter((s) => selection.includes(s.id))
                  const allFiles = sel.length > 0 && sel.every((s) => s.kind === 'native' && (s.component === 'file' || s.component === 'dir'))
                  return allFiles
                    ? [{ label: `New Folder with Selection (${selection.length})`, onClick: () => groupSelectionInto('folder') }]
                    : [{ label: `Group into Folder (${selection.length})`, onClick: () => useDesktop.getState().groupSelection() }]
                })()
              : [])
          ]}
        />
      )}

      {/* #51: the agent asked to perform a WRITE on a connected account — the human must approve it
          (per-call, request-bound). Reads never reach here. The OLDEST pending card shows; answering it
          pops it and reveals the next, so concurrent writes each get their own decision (review fix). */}
      {providerApprovals.length > 0 && (() => {
        const card = providerApprovals[0]
        const pop = (): void => setProviderApprovals((q) => q.filter((c) => c.id !== card.id))
        return (
          <div className="consent" onPointerDown={(e) => e.stopPropagation()}>
            <div className="consent-card">
              <h4>Allow the agent to {card.risk === 'destructive' ? <span style={{ color: 'var(--negative, #e5484d)' }}>make a destructive change</span> : 'make a change'} to your account?</h4>
              <p><code>{card.summary}</code></p>
              <p>This acts on your real connected account. It runs only if you allow it.{providerApprovals.length > 1 ? ` (${providerApprovals.length - 1} more pending)` : ''}</p>
              <div className="consent-actions">
                <button className="btn ghost" onClick={() => { window.agentOS?.denyProviderCall?.(card.id); pop() }}>Deny</button>
                <button className="btn primary" onClick={() => { window.agentOS?.approveProviderCall?.(card.id); pop() }}>Allow</button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
