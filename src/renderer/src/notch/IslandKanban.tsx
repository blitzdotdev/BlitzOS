// IslandKanban — the live workflow kanban board, inline in agent chat. Ported from lab/kanban/src/ModelA.jsx.
// One unified table: a phase column + To do (yellow) / Doing (red→blue) / Done (green). Each phase is a row;
// one card per leaf, advancing left→right. Subscribes to the wf bus by runId on mount (backlog replayed, then
// live), folds events through mergeSkeleton(skeleton), freezes + unsubscribes on run:done.
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { mergeSkeleton, type WfNode } from './wfReduce'
import { useLeaf, summarize, cardHead, fmtMs, fmtTok } from './wfShared'
import IslandLeafDrawer from './IslandLeafDrawer'

// Insert <wbr> after : / - _ so a long id wraps at delimiters instead of mid-word, staying fully visible.
function labelBreaks(s: string): ReactNode[] {
  const parts = String(s).split(/(?<=[:\-_/])/)
  return parts.map((p, i) => (
    <Fragment key={i}>
      {p}
      {i < parts.length - 1 ? <wbr /> : null}
    </Fragment>
  ))
}

function CardLabel({ n }: { n: WfNode }): JSX.Element {
  return (
    <span className="kc-label-row">
      <span className="kc-label">{labelBreaks(n.label)}</span>
      {n.model ? <span className="kc-model">{n.model}</span> : null}
    </span>
  )
}
function TodoCard({ n, onOpen }: { n: WfNode; onOpen: (id: string) => void }): JSX.Element {
  return (
    <button className="kc kc-todo" onClick={() => onOpen(n.nodeId)} title="planned — click for the prompt">
      <CardLabel n={n} />
    </button>
  )
}
function DoingCard({ n, onOpen }: { n: WfNode; onOpen: (id: string) => void }): JSX.Element {
  return (
    <button className="kc kc-doing" onClick={() => onOpen(n.nodeId)}>
      <CardLabel n={n} />
      <span className="kc-spark" aria-hidden />
    </button>
  )
}
function DoneCard({ n, runId, onOpen }: { n: WfNode; runId: string; onOpen: (id: string) => void }): JSX.Element {
  const leaf = useLeaf(runId, n.nodeId, true)
  const head = leaf ? cardHead(leaf) : summarize(n.preview, n.preview) || '…'
  const cls = n.status === 'error' ? ' kc-error' : n.status === 'empty' ? ' kc-empty' : ''
  return (
    <button className={`kc kc-done${cls}`} onClick={() => onOpen(n.nodeId)} title="click for the full output + what the agent did">
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

export interface IslandKanbanProps {
  runId: string
  skeleton: unknown[]
}

export default function IslandKanban({ runId, skeleton }: IslandKanbanProps): JSX.Element {
  const [events, setEvents] = useState<unknown[]>([])
  const [done, setDone] = useState(false)
  const [openNodeId, setOpenNodeId] = useState<string | null>(null)

  // Subscribe to the wf bus: backlog replayed synchronously, then live events. Unsubscribe on unmount/run:done.
  useEffect(() => {
    let off: (() => void) | null = null
    let live = true
    const seen = new Set<unknown>()
    const push = (ev: unknown): void => {
      const key = (ev as { seq?: unknown })?.seq
      if (key != null && seen.has(key)) return
      if (key != null) seen.add(key)
      if (!live) return
      setEvents((prev) => [...prev, ev])
      if ((ev as { type?: string })?.type === 'run:done') setDone(true)
    }
    // snapshot first (backlog), then subscribe for live.
    window.agentOS
      ?.wfSnapshot?.(runId)
      .then((snap: unknown) => {
        if (!live || !Array.isArray(snap)) return
        for (const ev of snap) push(ev)
        off = window.agentOS?.onWfEvent?.((p: { runId: string; ev: unknown }) => {
          if (p.runId === runId) push(p.ev)
        }) ?? null
      })
      .catch(() => {})
    // also subscribe so live events arrive even before the snapshot resolves
    window.agentOS?.wfSubscribe?.(runId).catch(() => {})
    return () => {
      live = false
      try { off?.() } catch { /* ignore */ }
      try { window.agentOS?.wfUnsubscribe?.(runId) } catch { /* ignore */ }
    }
  }, [runId])

  const m = useMemo(() => mergeSkeleton(events, skeleton), [events, skeleton])

  const phases = useMemo(() => {
    const isDone = (s: string) => s === 'done' || s === 'error' || s === 'empty'
    return m.phaseOrder
      .map((phaseId) => {
        const nodes = m.nodeOrder.map((id) => m.nodes[id]).filter((n) => n.phaseId === phaseId)
        return {
          phaseId,
          title: phaseId || 'Setup',
          todo: nodes.filter((n) => n.status === 'queued'),
          doing: nodes.filter((n) => n.status === 'running'),
          done: nodes.filter((n) => isDone(n.status))
        }
      })
      .filter((p) => p.todo.length || p.doing.length || p.done.length)
  }, [m])

  // Dynamic column widths: empty columns shrink; populated To do / Doing take a full share, Done the largest.
  const gridCols = useMemo(() => {
    let t = 0, g = 0, d = 0
    for (const p of phases) { t += p.todo.length; g += p.doing.length; d += p.done.length }
    const w = (count: number, full: number) => (count === 0 ? 0.4 : full)
    return `92px minmax(0, ${w(t, 0.95)}fr) minmax(0, ${w(g, 1.35)}fr) minmax(0, ${w(d, 1.5)}fr)`
  }, [phases])

  if (!phases.length) {
    return <div className="kb-empty">{done ? 'workflow finished' : 'waiting for the first event…'}</div>
  }

  const openNode = openNodeId ? m.nodes[openNodeId] || null : null

  return (
    <>
      <div className={`kb${done ? ' kb-done' : ''}`}>
        <div className="kb-grid" style={{ gridTemplateColumns: gridCols }}>
          <div className="kb-corner" />
          <div className="kb-colh kb-h-todo">To do</div>
          <div className="kb-colh kb-h-doing">Doing</div>
          <div className="kb-colh kb-h-done">Done</div>
          {phases.map((p) => (
            <Fragment key={p.phaseId || '__setup'}>
              <div className="kb-rowh">
                <span className="kb-rowh-name">{p.title}</span>
                <span className="kb-rowh-n">{p.todo.length + p.doing.length + p.done.length} agents</span>
              </div>
              <div className="kb-cell kb-cell-todo">
                {p.todo.map((n) => (<TodoCard n={n} key={n.nodeId} onOpen={setOpenNodeId} />))}
              </div>
              <div className="kb-cell kb-cell-doing">
                {p.doing.map((n) => (<DoingCard n={n} key={n.nodeId} onOpen={setOpenNodeId} />))}
              </div>
              <div className="kb-cell kb-cell-done">
                {p.done.map((n) => (<DoneCard n={n} runId={runId} key={n.nodeId} onOpen={setOpenNodeId} />))}
              </div>
            </Fragment>
          ))}
        </div>
      </div>
      {openNode && (
        <IslandLeafDrawer runId={runId} node={openNode} onClose={() => setOpenNodeId(null)} />
      )}
    </>
  )
}
