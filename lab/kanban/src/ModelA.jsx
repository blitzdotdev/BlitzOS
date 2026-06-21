// Model A — the kanban board (the MAIN view). ONE unified table on a dotted board (Nani-style): a phase column on
// the left (empty header), then three status columns — To do (yellow) / Doing (red) / Done (green) — with grid
// lines. Each phase is a single ROW. One card per leaf, in exactly one column by its state, advancing left→right;
// with the dry-run skeleton merged in, a later phase's leaves sit in To do while an earlier phase runs.
import React, { useMemo } from 'react'
import { useLeaf, summarize, fmtMs, fmtTok } from './shared.jsx'

// label + the model badge (shown on every card so you read which model ran each agent)
function CardLabel({ n }) {
  return (
    <span className="kc-label-row">
      <span className="kc-label">{n.label}</span>
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
  const result = leaf ? leaf.result : undefined
  const head = result !== undefined ? summarize(result, n.preview) : summarize(n.preview, n.preview)
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

  if (!phases.length) return <div className="kb-empty">waiting for the first event…</div>

  return (
    <div className="kb">
      <div className="kb-grid">
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
