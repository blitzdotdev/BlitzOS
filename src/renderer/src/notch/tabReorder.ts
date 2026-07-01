import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

// Browser-style drag-to-reorder for the agent tab strip. The tabs are position:absolute inside the (horizontally
// scrolling) rail; this hook drives each tab's `left` to its slot, and on drag it (a) follows the pointer, (b) slides
// the OTHER tabs out of the way as the dragged one crosses their midpoints, and (c) auto-scrolls the rail when the
// pointer nears an edge (so you can reorder past the visible strip). Blitz '0' is pinned first — it never moves and
// nothing lands before it. Positioning is imperative (not React-controlled) so a mid-drag re-render can't clobber it;
// on drop we commit the new id order upward (persisted) and the layout effect re-lays-out to match (no jump).
const GAP = 6 // must match the slot gap used below + the visual spacing in island.css
const DRAG_THRESHOLD = 4 // px of movement before a press becomes a drag (so a click still just selects the tab)
const EDGE = 38 // px from a rail edge where auto-scroll engages
const AUTO_SPEED = 14 // px/frame auto-scroll

function esc(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&')
}

export function useTabReorder(params: {
  railRef: RefObject<HTMLDivElement>
  order: string[] // the CURRENT visual order of tab ids (pinned id first)
  pinnedId: string // never moves; nothing lands before it (Blitz '0')
  onCommit: (order: string[]) => void // called on drop with the new id order
  signature: string // re-measure + re-layout whenever this changes (order, session count, titles, editing)
  enabled: boolean // false while renaming a tab, etc.
}): { onTabPointerDown: (e: ReactPointerEvent, id: string) => void } {
  const { railRef, pinnedId, onCommit } = params
  const orderRef = useRef(params.order)
  orderRef.current = params.order // always fresh for the drag closures
  const widths = useRef(new Map<string, number>())
  const draggingRef = useRef(false)

  const slots = (order: string[]): { left: Map<string, number>; total: number } => {
    const left = new Map<string, number>()
    let x = 0
    for (const id of order) {
      left.set(id, x)
      x += (widths.current.get(id) ?? 0) + GAP
    }
    return { left, total: Math.max(0, x - GAP) }
  }
  const measure = (): void => {
    const rail = railRef.current
    if (!rail) return
    rail.querySelectorAll<HTMLElement>('[data-agent-id]').forEach((el) => {
      widths.current.set(el.dataset.agentId as string, el.offsetWidth)
    })
  }
  const layout = (order: string[], skipId?: string): void => {
    const rail = railRef.current
    if (!rail) return
    const { left, total } = slots(order)
    rail.querySelectorAll<HTMLElement>('[data-agent-id]').forEach((el) => {
      const id = el.dataset.agentId as string
      if (id === skipId) return
      const target = `${left.get(id) ?? 0}px`
      if (el.style.left === '') {
        // A FRESH element (a just-spawned tab, or the rail just remounted): place it at its slot with NO transition,
        // so it doesn't slide in from left:0 — and, crucially, so the scroll-into-view effect reads its REAL (possibly
        // far-right, off-screen) position and can scroll the strip to a newly-created tab.
        const prev = el.style.transition
        el.style.transition = 'none'
        el.style.left = target
        void el.offsetWidth // commit the position without animating
        el.style.transition = prev
      } else {
        el.style.left = target // an existing tab → animate via the CSS `left` transition (the "make room" slide)
      }
    })
    const spacer = rail.querySelector<HTMLElement>('.isl-tab-spacer')
    if (spacer) spacer.style.width = `${total}px` // drives the rail's scrollWidth so it scrolls when tabs overflow
  }

  // Re-measure + re-place whenever the tab set / order / titles change (but never mid-drag — that would fight the drag).
  useLayoutEffect(() => {
    if (draggingRef.current) return
    measure()
    layout(orderRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.signature])

  const onTabPointerDown = (e: ReactPointerEvent, id: string): void => {
    if (e.button !== 0 || !params.enabled) return // left-button only; right-click opens the context menu
    const rail = railRef.current
    if (!rail) return
    const blocked = id === pinnedId // Blitz: a press still selects (via the button's onClick), but never drags
    const grabDX = e.clientX - rail.getBoundingClientRect().left + rail.scrollLeft - (slots(orderRef.current).left.get(id) ?? 0)
    const startX = e.clientX
    let started = false
    let lastX = e.clientX
    let autoRaf: number | null = null
    let autoDir = 0
    const tabEl = (): HTMLElement | null => rail.querySelector<HTMLElement>(`[data-agent-id="${esc(id)}"]`)

    const apply = (clientX: number): void => {
      const order = orderRef.current
      const w = widths.current.get(id) ?? 0
      const { total } = slots(order)
      let cx = clientX - rail.getBoundingClientRect().left + rail.scrollLeft - grabDX
      cx = Math.max(0, Math.min(cx, total - w))
      const el = tabEl()
      if (el) el.style.left = `${cx}px`
      // Which slot does the dragged tab's center fall into, among the OTHER tabs (laid out contiguously)?
      const center = cx + w / 2
      const others = order.filter((x) => x !== id)
      let ti = 0
      let acc = 0
      for (const oid of others) {
        const ow = widths.current.get(oid) ?? 0
        if (center > acc + ow / 2) ti += 1
        acc += ow + GAP
      }
      if (others[0] === pinnedId) ti = Math.max(1, ti) // never land before the pinned first tab
      const next = [...others.slice(0, ti), id, ...others.slice(ti)]
      if (next.join('') !== order.join('')) {
        orderRef.current = next
        layout(next, id) // the OTHER tabs animate to their new slots; the dragged tab stays under the cursor
      }
    }

    const stopAuto = (): void => {
      if (autoRaf != null) cancelAnimationFrame(autoRaf)
      autoRaf = null
      autoDir = 0
    }
    const tick = (): void => {
      if (!autoDir) {
        stopAuto()
        return
      }
      const before = rail.scrollLeft
      rail.scrollLeft += autoDir * AUTO_SPEED
      if (rail.scrollLeft !== before) apply(lastX) // keep the tab under the cursor as the content scrolls beneath it
      autoRaf = requestAnimationFrame(tick)
    }
    const maybeAuto = (clientX: number): void => {
      const rect = rail.getBoundingClientRect()
      const canL = rail.scrollLeft > 0
      const canR = rail.scrollLeft < rail.scrollWidth - rail.clientWidth - 1
      autoDir = clientX < rect.left + EDGE && canL ? -1 : clientX > rect.right - EDGE && canR ? 1 : 0
      if (autoDir && autoRaf == null) autoRaf = requestAnimationFrame(tick)
      if (!autoDir) stopAuto()
    }

    const move = (ev: PointerEvent): void => {
      if (blocked) return
      lastX = ev.clientX
      if (!started) {
        if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return
        started = true
        draggingRef.current = true
        const el = tabEl()
        if (el) {
          el.classList.add('isl-chip-dragging')
          el.style.transition = 'none' // follow the pointer with zero lag
        }
      }
      apply(ev.clientX)
      maybeAuto(ev.clientX)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      stopAuto()
      if (!started) return // never crossed the threshold → a plain click; the button's onClick selects the tab
      const order = orderRef.current
      const el = tabEl()
      if (el) {
        el.style.transition = '' // restore the CSS transition so it glides into its slot (scale + shadow ease out too)
        el.classList.remove('isl-chip-dragging')
        el.classList.add('isl-chip-settling')
        el.style.left = `${slots(order).left.get(id) ?? 0}px`
        const done = (): void => {
          el.classList.remove('isl-chip-settling')
          el.removeEventListener('transitionend', done)
        }
        el.addEventListener('transitionend', done)
      }
      draggingRef.current = false
      onCommit(order)
    }

    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* capture is best-effort */
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return { onTabPointerDown }
}
