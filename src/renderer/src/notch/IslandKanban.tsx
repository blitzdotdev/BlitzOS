// IslandKanban — the live workflow kanban board, inline in agent chat. Ported from lab/kanban/src/ModelA.jsx.
// One unified table: a phase column + To do (yellow) / Doing (red→blue) / Done (green). Each phase is a row;
// one card per leaf, advancing left→right. Subscribes to the wf bus by runId on mount (backlog replayed, then
// live), folds events through mergeSkeleton(skeleton), freezes + unsubscribes on run:done.
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { mergeSkeleton, type WfNode } from './wfReduce'
import { eventCardHead, fmtMs, fmtTok } from './wfShared'
import IslandLeafDrawer from './IslandLeafDrawer'
import IslandSubagents from './IslandSubagents'

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
function DoneCard({ n, onOpen }: { n: WfNode; onOpen: (id: string) => void }): JSX.Element {
  // Human one-liner from the EVENT only — NO per-card leaf fetch (a 30-leaf run would fire 30 IPCs). cardHead
  // prefers a salient structured field (parsed from the preview), falling back to the leaf's prose summary that
  // agent:done now carries; never the raw JSON string. The full record loads lazily only when the drawer opens.
  const head = eventCardHead(n) || '…'
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

// One phase's nodes, partitioned into the three columns. Built by IslandKanban and consumed by KanbanGrid; the
// single-edge subagent expansion builds a one-node PhaseView from the SAME shape so it renders identically.
export interface PhaseView {
  phaseId: string
  title: string
  todo: WfNode[]
  doing: WfNode[]
  done: WfNode[]
}

// Dynamic column widths: empty columns shrink; populated To do / Doing take a full share, Done the largest.
export function gridColsFor(phases: PhaseView[]): string {
  let t = 0, g = 0, d = 0
  for (const p of phases) { t += p.todo.length; g += p.doing.length; d += p.done.length }
  const w = (count: number, full: number): number => (count === 0 ? 0.4 : full)
  return `92px minmax(0, ${w(t, 0.95)}fr) minmax(0, ${w(g, 1.35)}fr) minmax(0, ${w(d, 1.5)}fr)`
}

// The phase-row kanban grid: a phase column + To do / Doing / Done, one card per leaf. Extracted from IslandKanban
// so BOTH the full multi-phase board AND a single subagent's one-edge expansion (one phase, one card) reuse it.
export function KanbanGrid({ phases, onOpen }: { phases: PhaseView[]; onOpen: (id: string) => void }): JSX.Element {
  return (
    <div className="kb-grid" style={{ gridTemplateColumns: gridColsFor(phases) }}>
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
            {p.todo.map((n) => (<TodoCard n={n} key={n.nodeId} onOpen={onOpen} />))}
          </div>
          <div className="kb-cell kb-cell-doing">
            {p.doing.map((n) => (<DoingCard n={n} key={n.nodeId} onOpen={onOpen} />))}
          </div>
          <div className="kb-cell kb-cell-done">
            {p.done.map((n) => (<DoneCard n={n} key={n.nodeId} onOpen={onOpen} />))}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

export interface WfStats {
  ms: number
  calls: number
  tokens: number
}
export interface IslandKanbanProps {
  runId: string
  skeleton: unknown[]
  /** Report the run's rolled-up stats (set on run:done; null while running) so the board caption can show
   *  "{ms} · {calls} agents · {tokens} tok". Must be a STABLE callback (useCallback) to avoid an effect loop. */
  onStats?: (runId: string, stats: WfStats | null) => void
}

export default function IslandKanban({ runId, skeleton, onStats }: IslandKanbanProps): JSX.Element {
  const [events, setEvents] = useState<unknown[]>([])
  const [done, setDone] = useState(false)
  const [openNodeId, setOpenNodeId] = useState<string | null>(null)

  // Subscribe to the wf bus: backlog replayed, then live events. Unsubscribe on unmount/run:done.
  useEffect(() => {
    let live = true
    const seen = new Set<unknown>()
    // COALESCE every push into ONE setState per microtask. A reloaded/frozen board replays its WHOLE backlog at
    // once (the snapshot AND the subscribe both replay it, up to MAX_EVENTS=6000), so a naive setEvents-per-event
    // is O(n^2) array copies + n full mergeSkeleton reductions → the 1-2s tab-open freeze. Buffering the burst and
    // flushing once makes it O(n): one concat + one reduce. Live post-mount events (rare, one at a time) coalesce
    // the same way. The seq `seen` set still de-dupes the snapshot vs the subscribe-replay vs live overlap.
    let pending: unknown[] = []
    let sawDone = false
    let scheduled = false
    const flush = (): void => {
      scheduled = false
      if (!live) return
      const batch = pending
      pending = []
      if (batch.length) setEvents((prev) => prev.concat(batch))
      if (sawDone) { sawDone = false; setDone(true) }
    }
    const push = (ev: unknown): void => {
      const key = (ev as { seq?: unknown })?.seq
      if (key != null) { if (seen.has(key)) return; seen.add(key) }
      if (!live) return
      pending.push(ev)
      if ((ev as { type?: string })?.type === 'run:done') sawDone = true
      if (!scheduled) { scheduled = true; queueMicrotask(flush) }
    }
    // Register the live listener FIRST, BEFORE snapshot/subscribe, so an event fired during that window is never
    // lost (the seq `seen` set de-dupes the backlog snapshot against any overlapping live event). The prior order
    // (register only after the snapshot resolved) could drop a live event → a card stuck "running" forever.
    const off = window.agentOS?.onWfEvent?.((p: { runId: string; ev: unknown }) => {
      if (p.runId === runId) push(p.ev)
    }) ?? null
    // Pull the current backlog, then tell main to start fanning live events for this run.
    window.agentOS?.wfSnapshot?.(runId)
      .then((snap: unknown) => { if (live && Array.isArray(snap)) for (const ev of snap) push(ev) })
      .catch(() => {})
    window.agentOS?.wfSubscribe?.(runId).catch(() => {})
    return () => {
      live = false
      try { off?.() } catch { /* ignore */ }
      try { window.agentOS?.wfUnsubscribe?.(runId) } catch { /* ignore */ }
    }
  }, [runId])

  const m = useMemo(() => mergeSkeleton(events, skeleton), [events, skeleton])

  // Report the rolled-up stats up to the board caption (null until run:done sets m.stats).
  useEffect(() => {
    onStats?.(runId, m.stats)
  }, [runId, m.stats, onStats])

  const phases = useMemo<PhaseView[]>(() => {
    const isDone = (s: string): boolean => s === 'done' || s === 'error' || s === 'empty'
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

  const openNode = openNodeId ? m.nodes[openNodeId] || null : null
  // Drill-in is an OVERLAY card that slides up over the BOTTOM 90% of THIS board frame (rendered below). The
  // board stays mounted at its size behind it (no resize); the card body scrolls internally.

  if (!phases.length) {
    return <div className="kb-empty">{done ? 'workflow finished' : 'waiting for the first event…'}</div>
  }

  // SINGLE PHASE = a "subagents" fan-out (N independent leaves, no stage consuming another's output). Render one
  // ROW per subagent instead of the kanban grid; expanding a row drops that one leaf's one-edge KanbanGrid
  // underneath. Detection is STRUCTURAL: the merged skeleton carries the full planned phase set, so a genuinely
  // multi-phase run shows >1 phase as soon as its dry-preflight lands and never collapses to this view.
  const single = phases.length === 1
  const subNodes = single ? m.nodeOrder.map((id) => m.nodes[id]) : []

  return (
    <div className={`${single ? 'kb-sub' : 'kb'}${done ? ' kb-done' : ''}`}>
      {single ? (
        <IslandSubagents nodes={subNodes} onOpen={setOpenNodeId} />
      ) : (
        <KanbanGrid phases={phases} onOpen={setOpenNodeId} />
      )}
      {openNode ? (
        <IslandLeafDrawer runId={runId} node={openNode} onClose={() => setOpenNodeId(null)} />
      ) : null}
    </div>
  )
}
