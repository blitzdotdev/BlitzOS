import { useMemo, useRef, useState } from 'react'
import { useDesktop, orderedStageRect, addStageRect, splaySlotRect, insertAt, stageForAgent } from '../store'

type PrimarySpaceProps = {
  showAddArea?: boolean
}

type AreaChromeOverlayProps = {
  showAddArea?: boolean
  onEnterStage?: (stage: number) => void
  onAddArea?: () => void
}

// Sandwich compositor: the stage frame's translucent tint sits BELOW every window, so a browser's page
// hole must be cut out of it (a translucent layer over a hole would wash the live page). That clip is now
// applied IMPERATIVELY by the geometry RAF (App.tsx) off live measured rects — so it tracks an imperative
// window drag + camera pan — instead of a store-driven selector here (which froze mid-drag).

/** The workspace stages, framed in control mode or normal zoom-out. */
export function PrimarySpace({ showAddArea = false }: PrimarySpaceProps): JSX.Element {
  const vp = useDesktop((s) => s.viewport)
  const stageCount = useDesktop((s) => s.stageCount)
  const currentStage = useDesktop((s) => s.currentStage)
  const stageOrder = useDesktop((s) => s.stageOrder)

  const renderStage = (i: number): JSX.Element => {
    const r = orderedStageRect(i, vp, stageOrder, stageCount)
    // The page-holes clip is applied IMPERATIVELY by the geometry RAF (App.tsx) off live measured rects,
    // so the tint's hole tracks an imperative window drag + camera pan without a store-driven re-render.
    return (
      <div
        key={i}
        className={`primary-space${i === currentStage ? ' is-current' : ''}`}
        style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
      />
    )
  }

  const renderAddArea = (): JSX.Element | null => {
    if (!showAddArea) return null
    const r = addStageRect(vp, stageCount)
    return (
      <div
        key="add-area"
        className="primary-space primary-space-add"
        style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
      />
    )
  }

  return (
    <>
      {Array.from({ length: stageCount }, (_, i) => renderStage(i))}
      {renderAddArea()}
    </>
  )
}

/** Stage chrome in the splay: hit areas + labels per stage, the create-stage cell, and DRAG-TO-
 *  REORDER (plans/blitzos-stage-splay-lattice.md): dragging a stage label inserts it at the cell
 *  under the cursor — other stages preview their reflowed cells live (insertion semantics), and the
 *  drop commits the order via applyStageOrder, which MOVES the stages in world space (windows ride). */
export function AreaChromeOverlay({ showAddArea = false, onEnterStage, onAddArea }: AreaChromeOverlayProps): JSX.Element {
  const vp = useDesktop((s) => s.viewport)
  const stageCount = useDesktop((s) => s.stageCount)
  const currentStage = useDesktop((s) => s.currentStage)
  const stageOrder = useDesktop((s) => s.stageOrder)
  const transform = useDesktop((s) => s.transform)
  const mode = useDesktop((s) => s.mode)
  const applyStageOrder = useDesktop((s) => s.applyStageOrder)
  const deleteStage = useDesktop((s) => s.deleteStage)
  const surfaces = useDesktop((s) => s.surfaces)
  // Highest agent-owned stage: agent N owns stage N by identity, so stages ≤ it can't be deleted
  // (a delete renumbers everything above it down one). Stage 0 is the primary — never deletable.
  const agentMax = useMemo(
    () => surfaces.reduce((m, w) => (w.role === 'chat' && w.agentId != null ? Math.max(m, stageForAgent(w.agentId)) : m), 0),
    [surfaces]
  )
  const [drag, setDrag] = useState<{ id: number; from: number; to: number; dx: number; dy: number; active: boolean } | null>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  const previewOrder = drag && drag.active && drag.to !== drag.from ? insertAt(stageOrder, drag.from, drag.to) : stageOrder

  const toScreen = (r: { x: number; y: number; w: number; h: number }): { left: number; top: number; width: number; height: number } => ({
    left: transform.x + r.x * transform.scale,
    top: transform.y + r.y * transform.scale,
    width: r.w * transform.scale,
    height: r.h * transform.scale
  })
  const screenRect = (stage: number, order: number[]): { left: number; top: number; width: number; height: number } =>
    toScreen(stage >= stageCount ? addStageRect(vp, stageCount) : orderedStageRect(stage, vp, order, stageCount))

  /** Which REAL slot (order index) a screen point is nearest — the insertion target. */
  const slotIndexAt = (sx: number, sy: number): number => {
    const wx = (sx - transform.x) / transform.scale
    const wy = (sy - transform.y) / transform.scale
    let best = 0
    let bd = Infinity
    for (let idx = 0; idx < stageCount; idx++) {
      const c = splaySlotRect(idx, stageCount, vp)
      const d = Math.hypot(wx - (c.x + c.w / 2), wy - (c.y + c.h / 2))
      if (d < bd) {
        bd = d
        best = idx
      }
    }
    return best
  }

  const onLabelDown = (stage: number) => (e: React.PointerEvent) => {
    if (e.button !== 0 || stageCount <= 1) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragStart.current = { x: e.clientX, y: e.clientY }
    const from = stageOrder.indexOf(stage)
    setDrag({ id: stage, from: from < 0 ? stage : from, to: from < 0 ? stage : from, dx: 0, dy: 0, active: false })
  }
  const onLabelMove = (e: React.PointerEvent) => {
    if (!drag || !dragStart.current) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    const active = drag.active || Math.hypot(dx, dy) > 6
    setDrag({ ...drag, dx, dy, active, to: active ? slotIndexAt(e.clientX, e.clientY) : drag.to })
  }
  const onLabelUp = (stage: number) => (e: React.PointerEvent) => {
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* capture already released */
    }
    const d = drag
    setDrag(null)
    dragStart.current = null
    if (d?.active) {
      if (d.to !== d.from) applyStageOrder(insertAt(stageOrder, d.from, d.to))
    } else {
      onEnterStage?.(stage) // a tap (no drag) still enters the stage
    }
  }

  const addRect = showAddArea ? screenRect(stageCount, stageOrder) : null
  const ghostRect = drag?.active ? screenRect(drag.id, previewOrder) : null

  return (
    <div className={`area-chrome-overlay${drag?.active ? ' reflowing' : ''}`}>
      {Array.from({ length: stageCount }, (_, i) => {
        const isDragged = drag?.active && drag.id === i
        // While dragging: everyone ELSE previews their reflowed cell; the dragged stage's label
        // rides the cursor from its committed spot, and its target cell shows as the ghost below.
        const r = screenRect(i, previewOrder)
        const base = isDragged ? screenRect(i, stageOrder) : r
        return (
          <div key={i} className="area-chrome-stage">
            <button
              className="area-chrome-hit"
              type="button"
              aria-label={`Open Stage ${i + 1}`}
              style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
              onClick={() => onEnterStage?.(i)}
            />
            {mode === 'canvas' && i > agentMax && !drag?.active && (
              <div className="area-chrome-corner" style={{ left: r.left + r.width, top: r.top }}>
                <button
                  className="area-chrome-close"
                  type="button"
                  aria-label={`Delete Stage ${i + 1}`}
                  title={`Delete Stage ${i + 1} (windows move to Stage 1)`}
                  onClick={() => deleteStage(i)}
                >
                  ×
                </button>
              </div>
            )}
            <button
              className={`area-chrome-label${i === currentStage ? ' is-current' : ''}${isDragged ? ' dragging' : ''}`}
              type="button"
              style={
                isDragged
                  ? { left: base.left + 24 + (drag?.dx ?? 0), top: base.top - 10 + (drag?.dy ?? 0) }
                  : { left: r.left + 24, top: r.top - 10 }
              }
              onPointerDown={onLabelDown(i)}
              onPointerMove={onLabelMove}
              onPointerUp={onLabelUp(i)}
              onPointerCancel={() => {
                setDrag(null)
                dragStart.current = null
              }}
            >
              Stage {i + 1}
            </button>
          </div>
        )
      })}
      {ghostRect && (
        <div
          className="area-chrome-ghost"
          style={{ left: ghostRect.left, top: ghostRect.top, width: ghostRect.width, height: ghostRect.height }}
        />
      )}
      {addRect && (
        <button
          className="area-chrome-create"
          type="button"
          style={{
            left: addRect.left + addRect.width / 2,
            top: addRect.top + addRect.height / 2
          }}
          onClick={() => onAddArea?.()}
        >
          Create new stage
        </button>
      )}
    </div>
  )
}
