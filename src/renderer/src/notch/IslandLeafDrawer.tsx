// IslandLeafDrawer — the drill-in drawer for a kanban card. Ported from lab/kanban/src/LeafDrawer.jsx.
// Click a card → Asked (the input prompt) / Did (the agent's final message, as markdown) / Returned (typed JSON).
// The leaf record comes from osReadLeaf (BLITZ_CAPTURE_LEAVES). "Did" = leaf.summary (the harness's final
// assistant text), rendered with the renderer's shared MarkdownMessage.
import { useEffect, useRef } from 'react'
import { useLeaf, Output, fmtMs, fmtTok } from './wfShared'
import MarkdownMessage from './MarkdownMessage'
import type { WfNode } from './wfReduce'

export interface IslandLeafDrawerProps {
  runId: string
  node: WfNode | null
  onClose: () => void
}

export default function IslandLeafDrawer({ runId, node, onClose }: IslandLeafDrawerProps): JSX.Element | null {
  // Terminal = a leaf that actually RAN (a captured record exists). A queued TODO card is NOT terminal, so we
  // never fetch a non-existent leaf for it (that would return {ok:false} and show stale/empty content).
  const terminal = !!node && (node.status === 'done' || node.status === 'error' || node.status === 'empty')
  const leaf = useLeaf(runId, node ? node.nodeId : null, terminal)
  // On open (or switching cards), bring the drawer's TOP (head + Asked) into view, so a card clicked LOW on a
  // tall board doesn't leave you staring at the empty space below the sheet. block:'start' = sheet top → viewport top.
  const drRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = drRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => { try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch { /* ignore */ } })
    return () => cancelAnimationFrame(raf)
  }, [node ? node.nodeId : null])
  if (!node) return null
  const ask = (leaf && String(leaf.prompt || '')) || node.prompt || ''
  const result = leaf ? leaf.result : undefined
  const did = leaf && leaf.summary && String(leaf.summary).trim() ? String(leaf.summary) : ''

  return (
    <div className="dr-scrim" onClick={onClose}>
      <div className="dr" ref={drRef} onClick={(e) => e.stopPropagation()}>
        <div className="dr-head">
          <span className={`dr-dot dr-${node.status}`} />
          <span className="dr-label">{node.label}</span>
          {node.model ? <span className="dr-model">{node.model}</span> : null}
          <span className="dr-stats">
            {node.status}
            {node.ms ? ' · ' + fmtMs(node.ms) : ''}
            {node.tokens ? ' · ' + fmtTok(node.tokens) + ' tok' : ''}
          </span>
          <button className="dr-x" onClick={onClose} aria-label="close">×</button>
        </div>
        <div className="dr-body">
          <section className="dr-sec">
            <div className="dr-sec-h">Asked</div>
            <div className="dr-card">
              {ask ? <pre className="dr-prompt">{ask}</pre> : <div className="dr-empty">no prompt captured</div>}
            </div>
          </section>
          <section className="dr-sec">
            <div className="dr-sec-h">Did</div>
            <div className="dr-card">
              {node.status === 'running' ? (
                <div className="dr-empty">still running…</div>
              ) : did ? (
                <MarkdownMessage role="agent" text={did} />
              ) : (
                <div className="dr-empty">no final message captured</div>
              )}
            </div>
          </section>
          <section className="dr-sec">
            <div className="dr-sec-h">Returned</div>
            <div className="dr-card">
              {node.status === 'running' ? (
                <div className="dr-empty">still running…</div>
              ) : result !== undefined ? (
                <Output result={result} fallback={node.preview} />
              ) : (
                <div className="dr-empty">no output</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
