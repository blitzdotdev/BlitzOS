// wf-kanban — LIVE workflow externalization as a kanban post-it board (generic; the user enriches it).
// See plans/blitzos-workflow-externalization.md. Transparent on the canvas: the cards float, no window box.
// Event-sourced from blitz.workflow.subscribe(runId): each agent() leaf is a post-it that moves Queued ->
// Running (glowing) -> Done (a summary note). Queued slots come from a fan-out group's declared size. No lib.
import React, { useState, useEffect, useMemo } from 'react'

// ── reduce the WfEvent stream into a render model (pure; replayed from seq 0, so order/idempotency are free) ──
function reduceEvents(events) {
  const m = { name: '', description: '', status: 'running', stats: null, resultPreview: '',
    groups: {}, groupOrder: [], nodes: {}, nodeOrder: [] }
  for (const e of events) {
    if (!e || !e.type) continue
    if (e.type === 'run:start') { m.name = e.name || ''; m.description = e.description || '' }
    else if (e.type === 'run:done') { m.status = e.ok ? 'done' : 'error'; m.stats = { ms: e.ms, calls: e.calls, tokens: e.tokens }; m.resultPreview = e.preview || '' }
    else if (e.type === 'group:start') { if (!m.groups[e.groupId]) { m.groups[e.groupId] = { groupId: e.groupId, kind: e.kind, phaseId: e.phaseId == null ? null : String(e.phaseId), size: e.size || 0, started: 0 }; m.groupOrder.push(e.groupId) } }
    else if (e.type === 'agent:start') {
      const id = e.nodeId
      if (!m.nodes[id]) {
        m.nodes[id] = { nodeId: id, label: e.label || ('agent ' + id), phaseId: e.phaseId == null ? null : String(e.phaseId), groupId: e.groupId == null ? null : String(e.groupId), model: e.model || '', status: 'running', ms: 0, tokens: 0, preview: '', error: '' }
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

const STATUS = {
  running: { ink: 'var(--blitz-accent)', tag: 'working' },
  done: { ink: 'var(--blitz-sage)', tag: 'done' },
  error: { ink: 'var(--blitz-terracotta)', tag: 'failed' },
  empty: { ink: 'var(--blitz-text-dim)', tag: 'empty' }
}
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms')

function Card({ n }) {
  const s = STATUS[n.status] || STATUS.running
  const running = n.status === 'running'
  return (
    <div style={{
      background: 'var(--blitz-surface)', border: '1px solid var(--blitz-hairline)', borderLeft: '3px solid ' + s.ink,
      borderRadius: 'var(--blitz-radius-sm)', padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 5,
      boxShadow: running ? '0 0 0 1px var(--blitz-accent), 0 6px 18px -8px var(--blitz-accent)' : '0 4px 14px -10px rgba(0,0,0,.5)',
      animation: running ? 'wfpulse 1.5s ease-in-out infinite' : 'none'
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--blitz-text)', letterSpacing: '-.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.label}</div>
        <div style={{ font: '600 8.5px ui-monospace,monospace', letterSpacing: '.12em', textTransform: 'uppercase', color: s.ink, flex: '0 0 auto' }}>{s.tag}</div>
      </div>
      {n.phaseId ? <div style={{ font: '600 8px ui-monospace,monospace', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--blitz-text-dim)' }}>{n.phaseId}</div> : null}
      {n.status === 'done' && n.preview ? <div style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--blitz-text-dim)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{n.preview}</div> : null}
      {n.status === 'error' && n.error ? <div style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--blitz-terracotta)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{n.error}</div> : null}
      {(n.status === 'done' || n.status === 'error') ? <div style={{ font: '500 9px ui-monospace,monospace', color: 'var(--blitz-text-dim)', opacity: .8 }}>{fmtMs(n.ms)}{n.tokens ? ' · ' + n.tokens + ' tok' : ''}</div> : null}
    </div>
  )
}

function Placeholder({ label }) {
  return (
    <div style={{ border: '1px dashed var(--blitz-hairline)', borderRadius: 'var(--blitz-radius-sm)', padding: '9px 11px', opacity: .45, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--blitz-text-dim)' }}>{label}</div>
      <div style={{ font: '600 8.5px ui-monospace,monospace', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--blitz-text-dim)' }}>queued</div>
    </div>
  )
}

function Column({ title, count, accent, children }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingBottom: 2 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: accent }} />
        <span style={{ font: '700 9px ui-monospace,monospace', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--blitz-text)' }}>{title}</span>
        <span style={{ font: '600 9px ui-monospace,monospace', color: 'var(--blitz-text-dim)' }}>{count}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  )
}

export default function WfKanban() {
  const seed = (window.blitz && blitz.props && blitz.props()) || {}
  const [runId, setRunId] = useState(seed.runId ? String(seed.runId) : '')
  const [events, setEvents] = useState([])

  // runId can arrive via props after mount; re-read on prop change.
  useEffect(() => { return blitz.onProps((p) => { if (p && p.runId != null) setRunId(String(p.runId)) }) }, [])

  // Subscribe once per runId: the OS replays the backlog (seq 0..n) then streams live. Dedupe by seq so a
  // re-subscribe (or an enrichment swap) can never double-count.
  useEffect(() => {
    if (!runId || !(window.blitz && blitz.workflow)) return
    const off = blitz.workflow.subscribe(runId, (ev) => setEvents((prev) => (prev.some((x) => x.seq === ev.seq) ? prev : prev.concat(ev))))
    return off
  }, [runId])

  const m = useMemo(() => reduceEvents(events), [events])
  const running = m.nodeOrder.map((id) => m.nodes[id]).filter((n) => n.status === 'running')
  const done = m.nodeOrder.map((id) => m.nodes[id]).filter((n) => n.status !== 'running')
  const queued = []
  for (const gid of m.groupOrder) { const g = m.groups[gid]; const left = Math.max(0, g.size - g.started); for (let i = 0; i < left; i++) queued.push({ key: gid + ':' + i, label: (g.phaseId || g.kind || 'task') }) }

  const dotFor = m.status === 'done' ? 'var(--blitz-sage)' : m.status === 'error' ? 'var(--blitz-terracotta)' : 'var(--blitz-accent)'
  return (
    <div style={{ padding: '14px 16px', boxSizing: 'border-box', minHeight: '100%', display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'var(--blitz-font)' }}>
      <style>{'html,body{background:transparent!important}@keyframes wfpulse{0%,100%{box-shadow:0 0 0 1px var(--blitz-accent),0 6px 18px -10px var(--blitz-accent)}50%{box-shadow:0 0 0 1px var(--blitz-accent),0 8px 26px -6px var(--blitz-accent)}}'}</style>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <div style={{ font: '700 9px ui-monospace,monospace', letterSpacing: '.18em', textTransform: 'uppercase', color: dotFor }}>{m.status === 'running' ? 'Workflow · running' : m.status === 'done' ? 'Workflow · done' : 'Workflow · error'}</div>
          <div style={{ fontSize: 17, fontWeight: 750, letterSpacing: '-.02em', color: 'var(--blitz-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name || (runId ? 'Workflow' : 'Waiting for a run…')}</div>
        </div>
        {m.stats ? <div style={{ font: '500 10px ui-monospace,monospace', color: 'var(--blitz-text-dim)', flex: '0 0 auto' }}>{m.stats.calls} agents · {fmtMs(m.stats.ms)}{m.stats.tokens ? ' · ' + m.stats.tokens + ' tok' : ''}</div> : null}
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <Column title="Queued" count={queued.length} accent="var(--blitz-text-dim)">
          {queued.map((q) => <Placeholder key={q.key} label={q.label} />)}
        </Column>
        <Column title="Running" count={running.length} accent="var(--blitz-accent)">
          {running.map((n) => <Card key={n.nodeId} n={n} />)}
        </Column>
        <Column title="Done" count={done.length} accent="var(--blitz-sage)">
          {done.map((n) => <Card key={n.nodeId} n={n} />)}
        </Column>
      </div>
    </div>
  )
}
