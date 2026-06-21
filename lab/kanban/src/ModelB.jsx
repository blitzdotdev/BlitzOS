// Model B — the run as its full COMPUTE GRAPH. A layered DAG: run → group hubs (fan-out) → leaves → next phase's
// hub / synthesis leaf (fan-in). Every planned leaf of a started group is drawn (unrun ones are ghosts), so the
// fan-out/fan-in edges are all visible — a 7→1 fan-in shows as 7 edges converging. Click a leaf node OR an edge to
// open the relevant leaf's session (the data that flows across an edge IS its source leaf's output).
import React, { useMemo } from 'react'
import { buildGraph } from './graph.js'
import { useLeaf, summarize } from './shared.jsx'

const COLW = 196
const ROWH = 58
const NW = 168
const NH = 44

function LeafNode({ n, runId, onOpen }) {
  const done = n.status === 'done' || n.status === 'error' || n.status === 'empty'
  const leaf = useLeaf(runId, n.nodeId, done)
  const head = done ? summarize(leaf ? leaf.result : n.preview, n.preview) : n.status === 'queued' ? 'queued' : 'running…'
  return (
    <button className={`gn gn-leaf gn-${n.status}`} style={{ width: NW, height: NH }} onClick={() => onOpen(n.nodeId)} title="click for this leaf's session">
      <span className={`gn-ring gn-ring-${n.status}`} />
      <span className="gn-body">
        <span className="gn-label-row">
          <span className="gn-label">{n.label}</span>
          {n.model ? <span className="gn-model">{n.model}</span> : null}
        </span>
        <span className="gn-head">{n.status === 'error' ? n.error || head : head}</span>
      </span>
    </button>
  )
}

export default function ModelB({ model, runId, onOpenLeaf }) {
  const g = useMemo(() => buildGraph(model), [model])

  const { pos, W, H } = useMemo(() => {
    const levelCount = {}
    g.nodes.forEach((n) => (levelCount[n.level] = (levelCount[n.level] || 0) + 1))
    const pos = new Map()
    g.nodes.forEach((n) => {
      const offset = (g.maxRows - levelCount[n.level]) / 2
      pos.set(n.id, { x: n.level * COLW + 12, y: (n.row + offset) * ROWH + 12 })
    })
    return { pos, W: g.maxLevel * COLW + NW + 28, H: g.maxRows * ROWH + 24 }
  }, [g])

  if (g.nodes.length <= 1) return <div className="mb-empty">waiting for the first event…</div>

  // edge → the leaf endpoint to open (the source leaf's output is what flows; else the target leaf)
  const edgeLeaf = (e) => {
    const s = g.byId.get(e.from)
    if (s && s.kind === 'leaf') return s.nodeId
    const t = g.byId.get(e.to)
    return t && t.kind === 'leaf' ? t.nodeId : null
  }

  return (
    <div className="mb-graph" style={{ width: W, height: H }}>
      <svg className="mb-svg" width={W} height={H}>
        {g.edges.map((e, i) => {
          const a = pos.get(e.from)
          const b = pos.get(e.to)
          if (!a || !b) return null
          const x1 = a.x + NW
          const y1 = a.y + NH / 2
          const x2 = b.x
          const y2 = b.y + NH / 2
          const mx = (x1 + x2) / 2
          const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
          const src = g.byId.get(e.from)
          const active = src && src.status === 'done' // an edge is "active" once its source leaf has produced output
          const nodeId = edgeLeaf(e)
          return (
            <g key={i} className={`mb-edge2 ${active ? 'is-active' : ''}`}>
              <path d={d} className="mb-edge-hit" onClick={() => nodeId != null && onOpenLeaf(nodeId)} style={{ cursor: nodeId != null ? 'pointer' : 'default' }} />
              <path d={d} className={`mb-edge-path mb-edge-${e.kind}`} />
            </g>
          )
        })}
      </svg>

      {g.nodes.map((n) => {
        const p = pos.get(n.id)
        const style = { left: p.x, top: p.y, position: 'absolute' }
        if (n.kind === 'leaf') {
          return (
            <div key={n.id} style={style}>
              <LeafNode n={n} runId={runId} onOpen={onOpenLeaf} />
            </div>
          )
        }
        if (n.kind === 'run') {
          return (
            <div key={n.id} className="gn gn-run" style={{ ...style, width: NW, height: NH }}>
              <span className="gn-run-glyph">▶</span>
              <span className="gn-run-label">{n.label}</span>
            </div>
          )
        }
        if (n.kind === 'group') {
          return (
            <div key={n.id} className="gn gn-group" style={{ ...style, width: NW, height: NH }}>
              {n.label}
            </div>
          )
        }
        return <div key={n.id} className="gn gn-ghost" style={{ ...style, width: NW, height: NH }} />
      })}
    </div>
  )
}
