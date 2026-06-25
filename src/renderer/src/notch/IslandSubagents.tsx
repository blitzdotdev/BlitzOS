// IslandSubagents — the SINGLE-PHASE workflow view (a "subagents" fan-out: N independent leaves, no stage
// consuming another's output). Instead of the kanban grid, each subagent is a full-width ROW pill (caret +
// status dot + label + stats), styled like the run-level board head and stacked vertically. Expanding a row
// drops that ONE leaf's one-edge KanbanGrid (a single phase, a single card) directly underneath it; the card
// opens the SHARED IslandLeafDrawer (owned by IslandKanban, via the onOpen passed in).
import { useState } from 'react'
import type { WfNode } from './wfReduce'
import { KanbanGrid, type PhaseView } from './IslandKanban'
import { fmtMs, fmtTok } from './wfShared'

// The right-aligned status line for a collapsed row. A finished leaf shows its time + tokens; the rest show
// their live state in plain words (the per-leaf headline + full detail live in the expanded card / drawer).
function rowStatusText(n: WfNode): string {
  if (n.status === 'running') return 'running…'
  if (n.status === 'queued') return 'queued'
  if (n.status === 'error') return 'failed'
  if (n.status === 'empty') return 'no result'
  const parts = ['done']
  if (n.ms) parts.push(fmtMs(n.ms))
  if (n.tokens) parts.push(fmtTok(n.tokens) + ' tok')
  return parts.join(' · ')
}

// Build a one-node PhaseView so the expansion renders through the SAME KanbanGrid as the full board — the leaf
// lands in To do / Doing / Done by its status (the "max one edge" board).
function edgePhase(n: WfNode): PhaseView {
  const isDone = n.status === 'done' || n.status === 'error' || n.status === 'empty'
  return {
    phaseId: n.phaseId,
    title: n.phaseId || 'Setup',
    todo: n.status === 'queued' ? [n] : [],
    doing: n.status === 'running' ? [n] : [],
    done: isDone ? [n] : []
  }
}

export interface IslandSubagentsProps {
  nodes: WfNode[]
  onOpen: (id: string) => void
}

export default function IslandSubagents({ nodes, onOpen }: IslandSubagentsProps): JSX.Element {
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set())
  const toggle = (id: string): void =>
    setOpenRows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="isl-sub">
      {nodes.map((n) => {
        const open = openRows.has(n.nodeId)
        return (
          <div className={`isl-sub-item${open ? ' isl-sub-open' : ''}`} key={n.nodeId}>
            <button type="button" className="isl-sub-row" aria-expanded={open} onClick={() => toggle(n.nodeId)}>
              <span className="isl-sub-caret" aria-hidden>{open ? '▾' : '▸'}</span>
              <span className={`isl-sub-dot isl-sub-${n.status}`} aria-hidden />
              <span className="isl-sub-label">{n.label}</span>
              {n.model ? <span className="isl-sub-model">{n.model}</span> : null}
              <span className="isl-sub-stat">{rowStatusText(n)}</span>
            </button>
            {open ? (
              <div className="kb kb-edge">
                <KanbanGrid phases={[edgePhase(n)]} onOpen={onOpen} />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
