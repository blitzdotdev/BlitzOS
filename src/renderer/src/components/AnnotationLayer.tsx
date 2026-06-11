import { useEffect, useRef, useState } from 'react'
import { useDesktop } from '../store'
import type { Annotation, Surface } from '../types'
import aquaBubble from '../assets/aqua-bubble.png'

// Item 5b — spatial annotations. The human right-clicks a POINT on a surface and asks the agent about it;
// an aqua speech-bubble pins to that point and a grounded reference lands in chat. This layer renders
// INSIDE the world container (so bubbles pan/zoom with their surface), but counter-scales each marker by
// 1/scale so the bubble + text stay a constant, readable size at any zoom. The point is anchored by
// PERCENT of the surface, so it tracks move/resize. Visual (the aqua bubble) is ported from blitz-cn's
// issue toolbar; the input + posted-state UI are rebuilt for BlitzOS.

const BUBBLE = 30 // px, screen-constant

/** World point of an annotation's anchor (top-left origin of its surface + percent offset). */
function anchorWorld(s: Surface, a: { xPct: number; yPct: number }): { wx: number; wy: number } {
  return { wx: s.x + a.xPct * s.w, wy: s.y + a.yPct * s.h }
}

export function AnnotationLayer(): JSX.Element | null {
  const annotations = useDesktop((s) => s.annotations)
  const draft = useDesktop((s) => s.annotationDraft)
  const focused = useDesktop((s) => s.focusedAnnotation)
  const surfaces = useDesktop((s) => s.surfaces)
  const scale = useDesktop((s) => s.transform.scale)
  const byId = (id: string): Surface | undefined => surfaces.find((s) => s.id === id)
  const inv = 1 / (scale || 1)

  // Only the FOCUSED annotation shows on the canvas (recalled by clicking its chat reference) — after
  // send, nothing lingers on the surface. The draft input shows only while composing.
  const active = focused ? annotations.find((a) => a.id === focused) : null
  return (
    <>
      {active &&
        (() => {
          const s = byId(active.surfaceId)
          if (!s || s.minimized || (s.groupId && !s.peek)) return null
          return <PostedBubble key={active.id} annotation={active} surface={s} inv={inv} />
        })()}
      {draft &&
        (() => {
          const s = byId(draft.surfaceId)
          if (!s) return null
          return <DraftInput surface={s} draft={draft} inv={inv} key="draft" />
        })()}
    </>
  )
}

/** The recalled annotation: the aqua bubble at the point + the question text. Only mounted while focused
 *  (clicked from its chat reference), and pulses in. Click the bubble (or ×) to dismiss it again. */
function PostedBubble({ annotation, surface, inv }: { annotation: Annotation; surface: Surface; inv: number }): JSX.Element {
  const focusAnnotation = useDesktop((s) => s.focusAnnotation)
  const { wx, wy } = anchorWorld(surface, annotation)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.animate([{ transform: 'scale(0.6)', opacity: 0.4 }, { transform: 'scale(1.18)' }, { transform: 'scale(1)', opacity: 1 }], { duration: 360, easing: 'ease-out' })
  }, [])

  return (
    <div className="annotation" style={{ position: 'absolute', left: wx, top: wy, transform: `scale(${inv})`, transformOrigin: 'top left', zIndex: 9000 }}>
      <div
        ref={ref}
        onPointerDown={(e) => {
          e.stopPropagation()
          focusAnnotation(annotation.id) // toggle off
        }}
        style={{ position: 'absolute', left: -2, top: -BUBBLE, width: BUBBLE, height: BUBBLE, cursor: 'pointer' }}
        title="Hide"
      >
        <img src={aquaBubble} alt="annotation" width={BUBBLE} height={BUBBLE} style={{ filter: 'drop-shadow(0 2px 5px rgba(0,0,0,0.35))', display: 'block' }} draggable={false} />
      </div>
      <div className="annotation-bubble" onPointerDown={(e) => e.stopPropagation()} style={{ position: 'absolute', left: BUBBLE + 6, top: -BUBBLE - 4, width: 240 }}>
        <div className="annotation-bubble-text">{annotation.text}</div>
        <button className="annotation-bubble-x" onPointerDown={(e) => { e.stopPropagation(); focusAnnotation(annotation.id) }} title="Hide">
          ×
        </button>
      </div>
    </div>
  )
}

/** The drafting input: aqua bubble at the point + a small composer. Enter sends to the agent. */
function DraftInput({ surface, draft, inv }: { surface: Surface; draft: { surfaceId: string; xPct: number; yPct: number }; inv: number }): JSX.Element {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const commitAnnotation = useDesktop((s) => s.commitAnnotation)
  const cancelAnnotation = useDesktop((s) => s.cancelAnnotation)
  const { wx, wy } = anchorWorld(surface, draft)
  useEffect(() => {
    taRef.current?.focus()
  }, [])

  const submit = (): void => {
    const body = text.trim()
    const ann = commitAnnotation(body) // clears the draft; the on-canvas bubble vanishes after send
    // Send to the agent + drop a GROUNDED REFERENCE into chat (carrying the full annotation so a click
    // recalls the bubble, even after a reload). The id ties the chat message to this annotation.
    if (ann) window.agentOS?.annotate?.({ id: ann.id, surfaceId: ann.surfaceId, text: ann.text, xPct: ann.xPct, yPct: ann.yPct })
  }

  return (
    <div style={{ position: 'absolute', left: wx, top: wy, transform: `scale(${inv})`, transformOrigin: 'top left', zIndex: 9100 }}>
      <div style={{ position: 'absolute', left: -2, top: -BUBBLE, width: BUBBLE, height: BUBBLE }}>
        <img src={aquaBubble} alt="" width={BUBBLE} height={BUBBLE} style={{ filter: 'drop-shadow(0 2px 5px rgba(0,0,0,0.35))', display: 'block' }} draggable={false} />
      </div>
      <div className="annotation-input" onPointerDown={(e) => e.stopPropagation()} style={{ position: 'absolute', left: BUBBLE + 6, top: -BUBBLE - 4, width: 256 }}>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              cancelAnnotation()
            }
          }}
          placeholder="Ask the agent about this…"
          rows={2}
        />
        <div className="annotation-input-row">
          <button className="annotation-cancel" onPointerDown={(e) => { e.stopPropagation(); cancelAnnotation() }}>
            Cancel
          </button>
          <button className="annotation-send" disabled={!text.trim()} onPointerDown={(e) => { e.stopPropagation(); submit() }}>
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
