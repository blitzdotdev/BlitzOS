// reduce — fold the WfEvent stream into a board model. Ported from widgets/wf-kanban.jsx reduceEvents and
// EXTENDED to track ordered phases (for swimlane rows) and per-group queued counts (for the To-do column).
// Pure + idempotent (replayed from seq 0), so live and replayed render identically. This is the candidate to
// port into the island later (src/renderer/src/notch).

export function reduce(events) {
  const m = {
    name: '',
    description: '',
    status: 'running', // running | done | error
    stats: null, // { ms, calls, tokens }
    resultPreview: '',
    phaseOrder: [], // ordered phase ids ('' = the no-phase "Setup" lane), in first-seen order
    phaseSeen: new Set(),
    groups: {}, // groupId -> { groupId, kind, phaseId, size, started }
    groupOrder: [],
    nodes: {}, // nodeId -> { nodeId, label, phaseId, groupId, model, status, ms, tokens, preview, error }
    nodeOrder: []
  }
  const seePhase = (p) => {
    const id = p == null ? '' : String(p)
    if (!m.phaseSeen.has(id)) {
      m.phaseSeen.add(id)
      m.phaseOrder.push(id)
    }
    return id
  }
  for (const e of events) {
    if (!e || !e.type) continue
    if (e.type === 'run:start') {
      m.name = e.name || ''
      m.description = e.description || ''
    } else if (e.type === 'phase') {
      seePhase(e.phaseId)
    } else if (e.type === 'run:done') {
      m.status = e.ok ? 'done' : 'error'
      m.stats = { ms: e.ms, calls: e.calls, tokens: e.tokens }
      m.resultPreview = e.preview || ''
    } else if (e.type === 'group:start') {
      if (!m.groups[e.groupId]) {
        m.groups[e.groupId] = { groupId: e.groupId, kind: e.kind, phaseId: seePhase(e.phaseId), size: e.size || 0, started: 0 }
        m.groupOrder.push(e.groupId)
      }
    } else if (e.type === 'group:done') {
      const g = m.groups[e.groupId]
      if (g) g.done = true
    } else if (e.type === 'agent:start') {
      const id = e.nodeId
      const phaseId = seePhase(e.phaseId)
      if (!m.nodes[id]) {
        m.nodes[id] = {
          nodeId: id,
          label: e.label || 'agent ' + id,
          phaseId,
          groupId: e.groupId == null ? null : String(e.groupId),
          model: e.model || '',
          status: 'running',
          ms: 0,
          tokens: 0,
          preview: '',
          error: '',
          prompt: e.prompt || '' // present on a dry-run skeleton's agent:start (the planned prompt for TODO cards)
        }
        m.nodeOrder.push(id)
        if (e.groupId != null && m.groups[e.groupId]) m.groups[e.groupId].started++
      } else {
        m.nodes[id].status = 'running'
      }
    } else if (e.type === 'agent:done') {
      const n = m.nodes[e.nodeId]
      if (n) {
        n.status = e.status === 'error' ? 'error' : e.status === 'null' ? 'empty' : 'done'
        n.ms = e.ms || 0
        n.tokens = e.tokens || 0
        n.preview = e.preview || ''
        n.error = e.message || ''
      }
    }
  }
  return m
}

// Pivot the reduced model into swimlane rows (one per phase) × the three status columns. Each phase row carries
// its running/done node cards plus a count of still-QUEUED leaves (a group's declared size minus how many started).
export function toBoard(m) {
  const isDoneCol = (s) => s === 'done' || s === 'empty' || s === 'error'
  const rows = m.phaseOrder.map((phaseId) => {
    const nodes = m.nodeOrder.map((id) => m.nodes[id]).filter((n) => n.phaseId === phaseId)
    const queued = m.groupOrder
      .map((gid) => m.groups[gid])
      .filter((g) => g.phaseId === phaseId)
      .reduce((sum, g) => sum + Math.max(0, g.size - g.started), 0)
    return {
      phaseId,
      title: phaseId || 'Setup',
      queued,
      running: nodes.filter((n) => n.status === 'running'),
      done: nodes.filter((n) => isDoneCol(n.status))
    }
  })
  // Drop a phantom empty "Setup" lane when nothing actually lives there.
  return rows.filter((r) => r.phaseId !== '' || r.queued || r.running.length || r.done.length)
}

// Merge the dry-run SKELETON (the full planned structure: every leaf with its label + phase, instant) with the REAL
// run's live events. Result: a reduced model where every planned leaf is present — real ones carry their live state
// (running/done + output), and not-yet-run ones are 'queued' (TODO). So phase 2 sits in TODO while phase 1 runs.
// Leaf identity is nodeId (the deterministic jIndex); for data-dependent fan-outs the skeleton is approximate, so a
// real leaf with no skeleton match is appended, and a skeleton leaf the real run never reaches stays queued.
export function mergeSkeleton(realEvents, skeletonEvents) {
  const real = reduce(realEvents || [])
  if (!skeletonEvents || !skeletonEvents.length) return real
  const skel = reduce(skeletonEvents)
  const nodeOrder = skel.nodeOrder.slice()
  for (const id of real.nodeOrder) if (!(id in skel.nodes)) nodeOrder.push(id)
  const nodes = {}
  for (const id of nodeOrder) {
    nodes[id] = real.nodes[id] ? real.nodes[id] : { ...skel.nodes[id], status: 'queued', ms: 0, tokens: 0, preview: '', error: '' }
  }
  const groupOrder = skel.groupOrder.slice()
  for (const id of real.groupOrder) if (!(id in skel.groups)) groupOrder.push(id)
  const groups = {}
  for (const id of groupOrder) groups[id] = { ...(skel.groups[id] || real.groups[id]), started: (real.groups[id] && real.groups[id].started) || 0 }
  const phaseOrder = skel.phaseOrder.slice()
  for (const p of real.phaseOrder) if (!phaseOrder.includes(p)) phaseOrder.push(p)
  return {
    name: real.name || skel.name,
    description: real.description || skel.description,
    status: real.status,
    stats: real.stats,
    resultPreview: real.resultPreview,
    phaseOrder,
    phaseSeen: new Set(phaseOrder),
    nodeOrder,
    nodes,
    groupOrder,
    groups
  }
}
