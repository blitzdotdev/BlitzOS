// Model A — the kanban board (the MAIN view). ONE unified table on a dotted board (Nani-style): a phase column on
// the left (empty header), then three status columns — To do (yellow) / Doing (red) / Done (green) — with grid
// lines. Each phase is a single ROW. One card per leaf, in exactly one column by its state, advancing left→right;
// with the dry-run skeleton merged in, a later phase's leaves sit in To do while an earlier phase runs.
import React, { useMemo } from 'react'
import { useLeaf, summarize, cardHead, isFixture, fmtMs, fmtTok } from './shared.jsx'

// Insert soft break opportunities (<wbr>) after : / - _ so a long id wraps at delimiters ("research:" / "decode-"
// / "physics") instead of mid-word, while staying fully visible.
function labelBreaks(s) {
  const parts = String(s).split(/(?<=[:\-_/])/)
  return parts.map((p, i) => (
    <React.Fragment key={i}>
      {p}
      {i < parts.length - 1 ? <wbr /> : null}
    </React.Fragment>
  ))
}
// label + the model badge (shown on every card so you read which model ran each agent)
function CardLabel({ n }) {
  return (
    <span className="kc-label-row">
      <span className="kc-label">{labelBreaks(n.label)}</span>
      {n.model ? <span className="kc-model">{n.model}</span> : null}
    </span>
  )
}
function TodoCard({ n, onOpen }) {
  return (
    <button className="kc kc-todo" onClick={() => onOpen(n.nodeId)} title="planned — click for the prompt">
      <CardLabel n={n} />
    </button>
  )
}
function DoingCard({ n, onOpen }) {
  return (
    <button className="kc kc-doing" onClick={() => onOpen(n.nodeId)}>
      <CardLabel n={n} />
      <span className="kc-spark" aria-hidden />
    </button>
  )
}
function DoneCard({ n, runId, onOpen }) {
  const leaf = useLeaf(runId, n.nodeId, true)
  // Human one-liner (concise structured summary, prose fallback) — NEVER the raw JSON preview for a real run
  // (n.preview is JSON.stringify); a fixture's preview is synthetic prose, so allow it while the leaf loads.
  const head = leaf ? cardHead(leaf) : isFixture(runId) ? summarize(n.preview, n.preview) : '…'
  const cls = n.status === 'error' ? ' kc-error' : n.status === 'empty' ? ' kc-empty' : ''
  return (
    <button className={`kc kc-done${cls}`} onClick={() => onOpen(n.nodeId)} title="click for the full output + session">
      <CardLabel n={n} />
      <span className="kc-out">{n.status === 'error' ? n.error || head : head || '—'}</span>
      {n.ms || n.tokens ? (
        <span className="kc-foot">
          {n.ms ? <span>{fmtMs(n.ms)}</span> : null}
          {n.tokens ? <span>{fmtTok(n.tokens)} tok</span> : null}
        </span>
      ) : null}
    </button>
  )
}

export default function ModelA({ model, runId, onOpenLeaf }) {
  const phases = useMemo(() => {
    const isDone = (s) => s === 'done' || s === 'error' || s === 'empty'
    return model.phaseOrder
      .map((phaseId) => {
        const nodes = model.nodeOrder.map((id) => model.nodes[id]).filter((n) => n.phaseId === phaseId)
        return {
          phaseId,
          title: phaseId || 'Setup',
          todo: nodes.filter((n) => n.status === 'queued'),
          doing: nodes.filter((n) => n.status === 'running'),
          done: nodes.filter((n) => isDone(n.status))
        }
      })
      .filter((p) => p.todo.length || p.doing.length || p.done.length)
  }, [model])

  // Dynamic column widths: a column with NO cards anywhere shrinks to ~header width and hands its space to the
  // others; populated To do / Doing take a full share and Done (title + output message + stats) takes the largest.
  // So an empty To do gives its room to Doing/Done, and the busy column gets space for fuller titles. (Titles also
  // wrap rather than truncate, so the full title is always visible regardless of column width.)
  const gridCols = useMemo(() => {
    let t = 0,
      g = 0,
      d = 0
    for (const p of phases) {
      t += p.todo.length
      g += p.doing.length
      d += p.done.length
    }
    const w = (count, full) => (count === 0 ? 0.4 : full)
    // Doing is the active column you watch during a run, so it gets a generous share; Done is a bit wider still
    // (it carries the output message + stats); To do only needs room for a title. Empty columns shrink to ~0.4.
    return `92px minmax(0, ${w(t, 0.95)}fr) minmax(0, ${w(g, 1.35)}fr) minmax(0, ${w(d, 1.5)}fr)`
  }, [phases])

  if (!phases.length) return <div className="kb-empty">waiting for the first event…</div>

  return (
    <div className="kb">
      <div className="kb-grid" style={{ gridTemplateColumns: gridCols }}>
        {/* header row: empty corner, then the three colored status headers */}
        <div className="kb-corner" />
        <div className="kb-colh kb-h-todo">To do</div>
        <div className="kb-colh kb-h-doing">Doing</div>
        <div className="kb-colh kb-h-done">Done</div>

        {/* one row per phase */}
        {phases.map((p) => (
          <React.Fragment key={p.phaseId || '__setup'}>
            <div className="kb-rowh">
              <span className="kb-rowh-name">{p.title}</span>
              <span className="kb-rowh-n">{p.todo.length + p.doing.length + p.done.length} agents</span>
            </div>
            <div className="kb-cell kb-cell-todo">
              {p.todo.map((n) => (
                <TodoCard n={n} key={n.nodeId} onOpen={onOpenLeaf} />
              ))}
            </div>
            <div className="kb-cell kb-cell-doing">
              {p.doing.map((n) => (
                <DoingCard n={n} key={n.nodeId} onOpen={onOpenLeaf} />
              ))}
            </div>
            <div className="kb-cell kb-cell-done">
              {p.done.map((n) => (
                <DoneCard n={n} runId={runId} key={n.nodeId} onOpen={onOpenLeaf} />
              ))}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}
