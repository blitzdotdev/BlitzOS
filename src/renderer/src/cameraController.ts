// cameraController — the imperative camera for canvas pan/zoom. The camera transform is zustand state and the
// .world div binds to it via a React inline style; driving a 60-120Hz trackpad gesture through that state forced a
// full App re-render PER wheel/pointer event (the jank). This hook moves the camera WITHOUT React during a gesture:
// it mutates a liveCam ref and writes worldRef.style.transform directly via ONE rAF per frame (compositor-only,
// no repaint), then commits to the store ONCE when the gesture settles. The store + the .world JSX style + every
// one-shot fly (goToPrimary / zoomOutFromHome / splayWindows / resize-preserve) are UNCHANGED — App.tsx keeps its
// `useDesktop((s)=>s.transform)` subscription, and a no-dep useLayoutEffect in App calls reassert() mid-gesture so
// a stray re-render can never clobber the live transform (zero-frame dual-writer fix). will-change lives here too:
// set on motion (GPU-promote), dropped 200ms after settle so Chromium re-rasterizes sharp at the new scale.
//
// The freeze lock + the cursor-anchored zoom math + the clamp are ported VERBATIM from store.ts panBy/zoomAt so
// behavior is identical; those store actions are kept as the canonical reference (see store.ts) but the gesture
// path no longer calls them. The returned object is REFERENTIALLY STABLE (built once into a ref) so the wheel /
// keybind effects that capture it with [] deps never go stale.
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useDesktop } from './store'
import type { CanvasTransform } from './types'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
// EXACT form matching the .world JSX style in App.tsx, so a settle-commit re-render paints an identical string.
const worldStr = (t: CanvasTransform): string => `translate(${t.x}px, ${t.y}px) scale(${t.scale})`

const SETTLE_MS = 120 // wheel/trackpad has no "up" event; commit this long after the last event of the burst.
const WILLCHANGE_DROP_MS = 200 // after settle, drop will-change so the layer re-rasterizes sharp at the new scale.

export interface CameraController {
  /** Pan by a screen delta (no-ops while frozen). Coalesced to one rAF DOM write per frame. */
  panBy: (dx: number, dy: number) => void
  /** Cursor-anchored zoom (no-ops while frozen). Same math as store.zoomAt, against the live ref. */
  zoomAt: (cursorX: number, cursorY: number, deltaY: number) => void
  /** A real pointerup gesture end (grab-pan): commit now, no debounce. */
  endPointerGesture: () => void
  /** Re-seed liveCam from the committed store transform + schedule a DOM write (call at a pointer-drag start). */
  sync: () => void
  /** Synchronously commit any in-flight gesture so useDesktop.getState().transform is FRESH. Call before a
   *  discrete screen->world read (create-at-cursor / file drop / context-menu placement) that fires within the
   *  ~120ms wheel-settle tail. No-op when not gesturing. */
  flush: () => void
  /** Re-impose liveCam onto .world (the dual-writer fix; App calls this in a mid-gesture useLayoutEffect). */
  reassert: () => void
  /** True while a gesture owns the DOM transform. */
  isGesturing: () => boolean
}

export function useCameraController(worldRef: RefObject<HTMLDivElement>): CameraController {
  const liveCam = useRef<CanvasTransform>(useDesktop.getState().transform)
  const gesturing = useRef(false)
  const committing = useRef(false) // true only while OUR commit's setTransform re-fires the store subscription
  const rafId = useRef<number | null>(null)
  const settleTimer = useRef<number | null>(null)
  const wcDrop = useRef<number | null>(null)
  const apiRef = useRef<CameraController | null>(null)

  if (!apiRef.current) {
    const writeDom = (): void => {
      const el = worldRef.current
      if (el) el.style.transform = worldStr(liveCam.current)
    }
    // One DOM write per frame regardless of how many wheel/pointer events fired in it.
    const schedule = (): void => {
      if (rafId.current != null) return
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null
        writeDom()
      })
    }
    const dropWillChangeSoon = (): void => {
      if (wcDrop.current != null) clearTimeout(wcDrop.current)
      wcDrop.current = window.setTimeout(() => {
        wcDrop.current = null
        const el = worldRef.current
        if (el) el.style.willChange = 'auto'
      }, WILLCHANGE_DROP_MS)
    }
    const startMotion = (): void => {
      gesturing.current = true
      const el = worldRef.current
      if (el) el.style.willChange = 'transform'
      if (wcDrop.current != null) {
        clearTimeout(wcDrop.current)
        wcDrop.current = null
      }
    }
    // The single commit primitive: store gets the EXACT liveCam last shown, so React re-rendering .world from
    // the new store.transform paints an identical string — no one-frame jump.
    const commit = (): void => {
      if (settleTimer.current != null) {
        clearTimeout(settleTimer.current)
        settleTimer.current = null
      }
      // committing flag: setTransform synchronously re-fires our own store subscription below; this marks that
      // re-entry as ours so it is ignored (an EXTERNAL change, with committing=false, is adopted instead).
      committing.current = true
      useDesktop.getState().setTransform({ ...liveCam.current })
      committing.current = false
      gesturing.current = false
      dropWillChangeSoon()
    }
    const armSettle = (): void => {
      if (settleTimer.current != null) clearTimeout(settleTimer.current)
      settleTimer.current = window.setTimeout(commit, SETTLE_MS)
    }
    // Seed liveCam from the committed store value at the first event of a burst (so a gesture that begins right
    // after a fly starts from the real value, not a stale liveCam), and GPU-promote.
    const ensureStart = (): void => {
      if (!gesturing.current) {
        liveCam.current = { ...useDesktop.getState().transform }
        startMotion()
      }
    }
    apiRef.current = {
      panBy: (dx, dy) => {
        if (useDesktop.getState().locked) return // freeze gate (verbatim store.ts panBy no-op)
        ensureStart()
        liveCam.current = { ...liveCam.current, x: liveCam.current.x + dx, y: liveCam.current.y + dy }
        schedule()
        armSettle()
      },
      zoomAt: (cursorX, cursorY, deltaY) => {
        if (useDesktop.getState().locked) return // freeze gate (verbatim store.ts zoomAt no-op)
        ensureStart()
        // PORT of store.ts zoomAt: cursor-anchored, exp falloff, clamp 0.2..3 — against liveCam, not the store.
        const { x: tx, y: ty, scale } = liveCam.current
        const factor = Math.exp(-deltaY * 0.006)
        const wx = (cursorX - tx) / scale
        const wy = (cursorY - ty) / scale
        const newScale = clamp(scale * factor, 0.2, 3)
        liveCam.current = { scale: newScale, x: cursorX - wx * newScale, y: cursorY - wy * newScale }
        schedule()
        armSettle()
      },
      endPointerGesture: () => {
        if (settleTimer.current != null) {
          clearTimeout(settleTimer.current)
          settleTimer.current = null
        }
        if (gesturing.current) commit()
      },
      sync: () => {
        liveCam.current = { ...useDesktop.getState().transform }
        schedule()
      },
      flush: () => {
        if (gesturing.current) commit()
      },
      reassert: writeDom,
      isGesturing: () => gesturing.current,
    }
  }

  useEffect(() => {
    // Frame 0: match the committed store transform (belt-and-suspenders; React also writes the JSX style).
    apiRef.current?.reassert()
    // Resync on any EXTERNAL transform change (one-shot flies, resize-preserve, hydrate) while NOT gesturing —
    // the no-manual-bump path that keeps liveCam + the layer in step + gives flies the same sharp re-raster the
    // old [transform] effect did. During a gesture the rAF owns the DOM, so we never fight it (the !gesturing
    // guard). Plain subscribe + identity diff because the store has no subscribeWithSelector middleware (it
    // mirrors the os:state subscription in App.tsx).
    let lastT = useDesktop.getState().transform
    const unsub = useDesktop.subscribe((state) => {
      if (state.transform === lastT) return
      lastT = state.transform
      if (committing.current) return // our own settle commit re-fired this; ignore (liveCam already equals it)
      // An EXTERNAL transform change: a one-shot fly (goToPrimary / zoomOutFromHome / splayWindows), the
      // resize-preserve, hydrate, or an agent go_to_primary. It WINS — even MID-GESTURE: cancel the in-flight
      // gesture (and kill its pending settle) so the deferred commit can never overwrite the fly with the stale
      // gesture value, then adopt the new transform + a crisp re-raster. Without this, a double-Shift fly-home or
      // an agent recenter fired during a held grab-pan / the wheel-settle tail would be silently clobbered.
      if (gesturing.current) {
        gesturing.current = false
        if (settleTimer.current != null) {
          clearTimeout(settleTimer.current)
          settleTimer.current = null
        }
      }
      liveCam.current = { ...state.transform }
      const el = worldRef.current
      if (el) {
        el.style.transform = worldStr(liveCam.current)
        el.style.willChange = 'transform'
      }
      if (wcDrop.current != null) clearTimeout(wcDrop.current)
      wcDrop.current = window.setTimeout(() => {
        wcDrop.current = null
        const e2 = worldRef.current
        if (e2) e2.style.willChange = 'auto'
      }, WILLCHANGE_DROP_MS)
    })
    return () => {
      unsub()
      if (rafId.current != null) cancelAnimationFrame(rafId.current)
      if (settleTimer.current != null) clearTimeout(settleTimer.current)
      if (wcDrop.current != null) clearTimeout(wcDrop.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return apiRef.current
}
