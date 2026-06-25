// wf-graph — LIVE workflow externalization as a node graph (generic; the user enriches it).
// See plans/blitzos-workflow-externalization.md. Transparent on the canvas: only nodes + edges paint.
// Self-contained SVG (no external lib): a run root, a horizontal spine of phase nodes, and the agent()
// leaves fanning out below each phase. Event-sourced from blitz.workflow.subscribe(runId); pan (drag) +
// zoom (wheel). Nodes glow while running, settle to ok/error on done. The registry also exposes
// @xyflow/react for an enriched version, but the generic view stays self-contained for robustness.
import React, { useState, useEffect, useMemo, useRef } from 'react'

function reduceEvents(events) {
  const m = { name: '', description: '', status: 'running', stats: null,
    phases: [], phaseSeen: new Set(), groups: {}, nodes: {}, nodeOrder: [] }
  for (const e of events) {
    if (!e || !e.type) continue
    if (e.type === 'run:start') { m.name = e.name || ''; m.description = e.description || '' }
    else if (e.type === 'run:done') { m.status = e.ok ? 'done' : 'error'; m.stats = { ms: e.ms, calls: e.calls, tokens: e.tokens } }
    else if (e.type === 'phase') { const id = e.phaseId == null ? '' : String(e.phaseId); if (id && !m.phaseSeen.has(id)) { m.phaseSeen.add(id); m.phases.push({ id, title: e.title || id }) } }
    else if (e.type === 'group:start') { if (!m.groups[e.groupId]) m.groups[e.groupId] = { groupId: String(e.groupId), kind: e.kind, phaseId: e.phaseId == null ? '' : String(e.phaseId), size: e.size || 0, started: 0 } }
    else if (e.type === 'agent:start') {
      const id = e.nodeId
      if (!m.nodes[id]) {
        m.nodes[id] = { nodeId: id, label: e.label || ('agent ' + id), phaseId: e.phaseId == null ? '' : String(e.phaseId), groupId: e.groupId == null ? null : String(e.groupId), status: 'running', ms: 0, tokens: 0, preview: '', error: '' }
        m.nodeOrder.push(id)
        if (e.groupId != null && m.groups[e.groupId]) m.groups[e.groupId].started++
      } else m.nodes[id].status = 'running'
    } else if (e.type === 'agent:done') {
      const n = m.nodes[e.nodeId]
      if (n) { n.status = e.status === 'error' ? 'error' : e.status === 'null' ? 'empty' : 'done'; n.ms = e.ms || 0; n.tokens = e.tokens || 0; n.preview = e.preview || ''; n.error = e.message || '' }
    }
  }
  return m
}

const INK = { running: 'var(--blitz-accent)', done: 'var(--blitz-sage)', error: 'var(--blitz-terracotta)', empty: 'var(--blitz-text-dim)', queued: 'var(--blitz-text-dim)' }
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms')

// layout constants (world units)
const PAD = 28, CARDW = 168, AGENTH = 54, HEADERH = 30, ROOTH = 44, GAPX = 60, GAPY = 16

// Build columns: [root] then [Setup?] + phases; each stage holds its agent "cells" (started nodes + queued
// placeholders for a fan-out group's unfilled slots), in node order.
function layout(m) {
  const stages = []
  const bucket = {} // phaseId -> { cells: [] }
  const ensure = (pid) => (bucket[pid] = bucket[pid] || { cells: [] })
  // group placeholders: per group, (size - started) queued cells
  const order = m.nodeOrder.map((id) => m.nodes[id])
  const hasSetup = order.some((n) => !n.phaseId) || Object.values(m.groups).some((g) => !g.phaseId)
  const stageDefs = (hasSetup ? [{ id: '', title: 'Setup' }] : []).concat(m.phases)
  for (const n of order) ensure(n.phaseId).cells.push({ kind: 'node', n })
  for (const gid in m.groups) { const g = m.groups[gid]; const left = Math.max(0, g.size - g.started); for (let i = 0; i < left; i++) ensure(g.phaseId).cells.push({ kind: 'queued', key: gid + ':' + i, group: g }) }

  const nodes = [], edges = []
  // root
  const rootX = PAD, rootY = PAD
  nodes.push({ id: 'root', x: rootX, y: rootY, w: CARDW, h: ROOTH, kind: 'root' })
  let prevHeaderId = 'root'
  let maxBottom = rootY + ROOTH
  stageDefs.forEach((st, si) => {
    const col = si + 1
    const x = PAD + col * (CARDW + GAPX)
    const hid = 'ph:' + (st.id || 'setup')
    nodes.push({ id: hid, x, y: PAD, w: CARDW, h: HEADERH, kind: 'phase', title: st.title })
    edges.push({ from: prevHeaderId, to: hid, spine: true })
    prevHeaderId = hid
    const cells = (bucket[st.id] || { cells: [] }).cells
    cells.forEach((c, j) => {
      const y = PAD + HEADERH + GAPY + j * (AGENTH + GAPY)
      const id = c.kind === 'node' ? 'n:' + c.n.nodeId : 'q:' + c.key
      nodes.push({ id, x, y, w: CARDW, h: AGENTH, kind: c.kind, n: c.n, group: c.group })
      edges.push({ from: hid, to: id })
      maxBottom = Math.max(maxBottom, y + AGENTH)
    })
  })
  const width = PAD + (stageDefs.length + 1) * (CARDW + GAPX)
  const height = Math.max(maxBottom + PAD, 200)
  return { nodes, edges, width, height }
}

function edgePath(a, b) {
  // from a's right-or-bottom anchor to b's left-or-top anchor with a smooth cubic.
  const sameCol = Math.abs(a.x - b.x) < 2
  const x1 = sameCol ? a.x + a.w / 2 : a.x + a.w, y1 = sameCol ? a.y + a.h : a.y + a.h / 2
  const x2 = sameCol ? b.x + b.w / 2 : b.x, y2 = sameCol ? b.y : b.y + b.h / 2
  if (sameCol) { const my = (y1 + y2) / 2; return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}` }
  const mx = (x1 + x2) / 2; return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
}

function NodeCard({ node, runMeta }) {
  if (node.kind === 'root') {
    const ink = INK[runMeta.status] || INK.running
    return (
      <div title={runMeta.description || ''} style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: 'var(--blitz-surface)', border: '1px solid var(--blitz-hairline)', borderTop: '3px solid ' + ink, borderRadius: 'var(--blitz-radius-sm)', padding: '6px 10px', display: 'flex', flexDirection: 'column', justifyContent: 'center', boxShadow: '0 6px 18px -10px rgba(0,0,0,.55)' }}>
        <div style={{ font: '700 8px ui-monospace,monospace', letterSpacing: '.16em', textTransform: 'uppercase', color: ink }}>{runMeta.status === 'running' ? 'running' : runMeta.status}</div>
        <div style={{ fontSize: 13, fontWeight: 750, color: 'var(--blitz-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{runMeta.name || 'Workflow'}</div>
      </div>
    )
  }
  if (node.kind === 'phase') {
    return (
      <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, background: 'var(--blitz-surface-2)', border: '1px solid var(--blitz-hairline)' }}>
        <span style={{ font: '700 9px ui-monospace,monospace', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--blitz-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 8px' }}>{node.title}</span>
      </div>
    )
  }
  if (node.kind === 'queued') {
    return (
      <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', border: '1px dashed var(--blitz-hairline)', borderRadius: 'var(--blitz-radius-sm)', padding: '7px 10px', opacity: .45, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--blitz-text-dim)' }}>{node.group ? (node.group.kind === 'pipeline' ? 'pipeline' : 'parallel') : 'queued'}</div>
        <div style={{ font: '600 8px ui-monospace,monospace', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--blitz-text-dim)' }}>queued</div>
      </div>
    )
  }
  const n = node.n, ink = INK[n.status] || INK.running, running = n.status === 'running'
  return (
    <div title={n.preview || n.error || ''} style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: 'var(--blitz-surface)', border: '1px solid var(--blitz-hairline)', borderLeft: '3px solid ' + ink, borderRadius: 'var(--blitz-radius-sm)', padding: '7px 10px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, boxShadow: running ? '0 0 0 1px var(--blitz-accent), 0 8px 22px -8px var(--blitz-accent)' : '0 5px 16px -10px rgba(0,0,0,.5)', animation: running ? 'wfgpulse 1.5s ease-in-out infinite' : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--blitz-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.label}</span>
        {n.groupId ? <span style={{ font: '700 9px ui-monospace', color: 'var(--blitz-text-dim)', flex: '0 0 auto' }}>∥</span> : null}
      </div>
      <div style={{ font: '600 8px ui-monospace,monospace', letterSpacing: '.1em', textTransform: 'uppercase', color: ink }}>
        {running ? 'working' : n.status === 'done' ? fmtMs(n.ms) + (n.tokens ? ' · ' + n.tokens + 'tok' : '') : n.status}
      </div>
    </div>
  )
}

export default function WfGraph() {
  const seed = (window.blitz && blitz.props && blitz.props()) || {}
  const [runId, setRunId] = useState(seed.runId ? String(seed.runId) : '')
  const [events, setEvents] = useState([])
  const [view, setView] = useState({ tx: 0, ty: 0, k: 1 })
  const drag = useRef(null)

  useEffect(() => { return blitz.onProps((p) => { if (p && p.runId != null) setRunId(String(p.runId)) }) }, [])
  useEffect(() => {
    if (!runId || !(window.blitz && blitz.workflow)) return
    return blitz.workflow.subscribe(runId, (ev) => setEvents((prev) => (prev.some((x) => x.seq === ev.seq) ? prev : prev.concat(ev))))
  }, [runId])

  const m = useMemo(() => reduceEvents(events), [events])
  const g = useMemo(() => layout(m), [m])

  const onWheel = (e) => { e.preventDefault(); const k = Math.min(2.2, Math.max(0.35, view.k * Math.exp(-e.deltaY * 0.0015))); setView((v) => ({ ...v, k })) }
  const onDown = (e) => { drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }; }
  const onMove = (e) => { if (!drag.current) return; setView((v) => ({ ...v, tx: drag.current.tx + (e.clientX - drag.current.x), ty: drag.current.ty + (e.clientY - drag.current.y) })) }
  const onUp = () => { drag.current = null }

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 220, fontFamily: 'var(--blitz-font)', position: 'relative', overflow: 'hidden', cursor: drag.current ? 'grabbing' : 'grab' }}
      onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
      <style>{'html,body{background:transparent!important}@keyframes wfgpulse{0%,100%{box-shadow:0 0 0 1px var(--blitz-accent),0 8px 22px -10px var(--blitz-accent)}50%{box-shadow:0 0 0 1px var(--blitz-accent),0 10px 30px -6px var(--blitz-accent)}}'}</style>
      {!runId ? <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--blitz-text-dim)', font: '600 11px ui-monospace,monospace', letterSpacing: '.1em', textTransform: 'uppercase' }}>waiting for a run…</div> : null}
      <svg width="100%" height="100%" viewBox={`0 0 ${Math.max(g.width, 1)} ${Math.max(g.height, 1)}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }}>
        <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
          {g.edges.map((e, i) => {
            const a = g.nodes.find((n) => n.id === e.from), b = g.nodes.find((n) => n.id === e.to)
            if (!a || !b) return null
            const live = b.kind === 'node' && b.n && b.n.status === 'running'
            return <path key={i} d={edgePath(a, b)} fill="none" stroke={live ? 'var(--blitz-accent)' : 'var(--blitz-hairline)'} strokeWidth={live ? 2 : 1.25} strokeOpacity={e.spine ? 0.9 : 0.6} />
          })}
          {g.nodes.map((node) => (
            <foreignObject key={node.id} x={node.x} y={node.y} width={node.w} height={node.h} style={{ overflow: 'visible' }}>
              <NodeCard node={node} runMeta={m} />
            </foreignObject>
          ))}
        </g>
      </svg>
    </div>
  )
}
