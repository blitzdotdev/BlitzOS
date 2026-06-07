import { useEffect, useRef, useState } from 'react'
import { useDesktop, viewTransform, type CreateSurfaceInput } from './store'
import type { Surface, CanvasTransform } from './types'
import { IntegrationWidget } from './components/IntegrationWidget'
import { ConnectPanel } from './components/ConnectPanel'
import { Overview } from './components/Overview'
import { capturePrimaryThumb } from './capture'
import { SurfaceFrame } from './components/SurfaceFrame'
import { PrimarySpace } from './components/PrimarySpace'
import { Sidebar } from './components/Sidebar'
import { IconCrosshair, IconChat, IconSparkle, IconGrid, IconChevronDown } from './components/Icons'
import { FolderOverlay } from './components/FolderOverlay'
import { OnboardingFlow } from './onboarding/OnboardingFlow'
import { shouldShowOnboarding, markOnboarded } from './onboarding/config'

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

export default function App(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const transform = useDesktop((s) => s.transform)
  const mode = useDesktop((s) => s.mode)
  const integrations = useDesktop((s) => s.integrations)
  const surfaces = useDesktop((s) => s.surfaces)
  const grabMode = useDesktop((s) => s.grabMode)
  const snapPreview = useDesktop((s) => s.snapPreview)
  const createSurface = useDesktop((s) => s.createSurface)
  const setIntegrations = useDesktop((s) => s.setIntegrations)

  const [connecting, setConnecting] = useState<string | null>(null)
  const [aiUrl, setAiUrl] = useState<string | null>(null)
  const [showAi, setShowAi] = useState(false)
  const [showOverview, setShowOverview] = useState(false)
  const [activeWs, setActiveWs] = useState<string | null>(null)
  const [onboarding, setOnboarding] = useState(() => shouldShowOnboarding())
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
    st.setMode(next)
    animateTransform(viewTransform(next, st.viewport))
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
        // Cmd+G: pack the current selection into an iPhone-style folder.
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
        st.hydrate(surfs, cam, 'desktop')
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
        st.hydrate(sf, cm, 'desktop')
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
      else if (a.type === 'move') st.moveSurface(String(a.id), Number(a.x), Number(a.y))
      else if (a.type === 'update') st.updateSurface(String(a.id), (a.patch ?? {}) as Partial<Surface>)
      else if (a.type === 'close') st.closeSurface(String(a.id))
      else if (a.type === 'goToPrimary') st.goToPrimary()
      else if (a.type === 'chat') {
        // Agent reply -> append to the Chat panel (create one if none is open).
        const text = String(a.text ?? '')
        if (!text) return
        const chat = st.surfaces.find((s) => s.kind === 'native' && s.component === 'chat')
        if (chat) {
          const msgs = (chat.props?.messages as Array<{ role: string; text: string }>) ?? []
          st.updateSurfaceProps(chat.id, { messages: [...msgs, { role: 'agent', text }].slice(-200) })
        } else {
          st.createSurface(chatSurfaceInput([{ role: 'agent', text }]))
        }
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
      } else if (a.type === 'group') {
        // Agent packed related surfaces into a named iPhone-style folder.
        st.group(
          (a.ids as string[]) ?? [],
          a.name != null ? String(a.name) : undefined,
          a.x != null ? Number(a.x) : undefined,
          a.y != null ? Number(a.y) : undefined,
          a.folderId != null ? String(a.folderId) : undefined
        )
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
        // Chat + Agent-activity panels are pinned always-on-top — the agent must not cover them
        pinned: s.kind === 'native' && (s.component === 'chat' || s.component === 'activity')
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
      window.agentOS?.sendState({ workspace: activeWsRef.current ?? undefined, surfaces, viewport: { w: vw, h: vh }, view, mode: st.mode, camera: { x: view.cx, y: view.cy, scale } })
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
    if (!files.length) return
    e.preventDefault()
    if (!window.agentOS?.serverMode) return
    const cx = e.clientX
    const cy = e.clientY
    const t = useDesktop.getState().transform
    files.forEach(async (file, i) => {
      const wx = Math.round((cx - t.x) / t.scale + i * 24)
      const wy = Math.round((cy - t.y) / t.scale + i * 24)
      try {
        const buf = await file.arrayBuffer()
        await fetch(`/api/os/upload?name=${encodeURIComponent(file.name)}&x=${wx}&y=${wy}`, { method: 'POST', body: buf })
      } catch {
        /* ignore a failed upload */
      }
    })
  }

  function onBgDown(e: React.PointerEvent): void {
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
    const existing = st.surfaces.find((s) => s.kind === 'native' && s.component === 'chat')
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

      <div className="bg" onPointerDown={onBgDown} onPointerMove={onBgMove} onPointerUp={onBgUp} />

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
        {integrations.map((it) => (
          <IntegrationWidget key={it.id} integration={it} onConnect={setConnecting} />
        ))}
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
        <button style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => useDesktop.getState().goToPrimary()}>
          <IconCrosshair size={15} /> Center
        </button>
        <button style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={openChat}>
          <IconChat size={15} /> Chat
        </button>
        <button style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setShowAi((v) => !v)}>
          <span style={{ display: 'inline-flex', color: aiUrl ? 'var(--positive)' : 'var(--text-muted)' }}>
            <IconSparkle size={15} />
          </span>
          Connect AI
        </button>
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
              <p className="hud-sub">Paste this URL into Claude / ChatGPT and ask it to open windows, post-its, etc.</p>
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
    </div>
  )
}
