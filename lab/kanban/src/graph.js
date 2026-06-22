// Build the full compute DAG from the reduced WfEvent model. Layered left→right:
//   run → [group hub (fan-out)] → leaves → [next phase's hub / standalone leaf (fan-in)] → …
// Shows the WHOLE planned graph: a group of declared size N renders N leaf nodes even before they start (the unrun
// ones are ghosts), so the fan-out/fan-in edges are all visible up front. A fan-in of 7 leaves into 1 synthesis
// agent shows as 7 edges converging. Cross-phase edges are phase-sequence (the granularity blitzscript exposes);
// a group's leaves all feed the NEXT phase's hub (or its standalone leaf), so we never draw a dense N×M mesh.

export function buildGraph(m) {
  const nodes = []
  const edges = []
  const byId = new Map()
  const add = (n) => {
    nodes.push(n)
    byId.set(n.id, n)
    return n
  }
  add({ id: 'run', kind: 'run', label: m.name || 'run', status: m.status === 'running' ? 'running' : m.status })

  let prevOutputs = ['run'] // node ids whose outputs feed the next phase

  // A group's EFFECTIVE phase = its LEAVES' phase. group:start's own phaseId is unreliable: a script can set the
  // phase as an agent OPT (opts.phase) instead of the phase() global, so group:start fires with the ambient phase
  // (often '') while the leaves carry the real one. Match leaves→groups by groupId, and bucket each group into its
  // leaves' phase. (Before any leaf has started, fall back to group:start's phaseId.)
  const leavesArr = m.nodeOrder.map((id) => m.nodes[id])
  const groupPhase = {}
  for (const gid of m.groupOrder) {
    const fl = leavesArr.find((n) => n.groupId === gid)
    groupPhase[gid] = fl ? fl.phaseId : m.groups[gid].phaseId || ''
  }
  // Phase order = leaf/group phases in first-seen (execution) order; empty buckets are skipped below.
  const phaseOrder = []
  const seenP = new Set()
  const seeP = (p) => {
    const id = p == null ? '' : String(p)
    if (!seenP.has(id)) {
      seenP.add(id)
      phaseOrder.push(id)
    }
  }
  for (const gid of m.groupOrder) seeP(groupPhase[gid])
  for (const n of leavesArr) seeP(n.phaseId)
  for (const p of m.phaseOrder) seeP(p)

  for (const phaseId of phaseOrder) {
    const phaseLeaves = leavesArr.filter((n) => n.phaseId === phaseId)
    const groups = m.groupOrder.map((g) => m.groups[g]).filter((g) => groupPhase[g.groupId] === phaseId)
    const standalone = phaseLeaves.filter((n) => n.groupId == null)
    const thisOutputs = []

    // No group hub node (it's redundant — the fan-out shape already reads as parallel, and the count is the number
    // of leaf/ghost nodes). The previous phase's outputs (or `run`) feed each leaf of the group DIRECTLY.
    for (const g of groups) {
      const gLeaves = phaseLeaves.filter((n) => n.groupId === g.groupId)
      for (const n of gLeaves) {
        const id = 'n:' + n.nodeId
        add({ id, kind: 'leaf', label: n.label, status: n.status, nodeId: n.nodeId, preview: n.preview, error: n.error, model: n.model })
        for (const src of prevOutputs) edges.push({ from: src, to: id, kind: 'flow' })
        thisOutputs.push(id)
      }
      for (let k = 0; k < Math.max(0, g.size - gLeaves.length); k++) {
        const id = 'ghost:' + g.groupId + ':' + k
        add({ id, kind: 'ghost', label: '', status: 'queued' })
        for (const src of prevOutputs) edges.push({ from: src, to: id, kind: 'flow' })
        thisOutputs.push(id)
      }
    }
    for (const n of standalone) {
      const id = 'n:' + n.nodeId
      add({ id, kind: 'leaf', label: n.label, status: n.status, nodeId: n.nodeId, preview: n.preview, error: n.error, model: n.model })
      for (const src of prevOutputs) edges.push({ from: src, to: id, kind: 'flow' })
      thisOutputs.push(id)
    }

    if (thisOutputs.length) prevOutputs = thisOutputs
  }

  // ── longest-path layering (it's a DAG): level = 1 + max(predecessor levels) ──
  const level = new Map(nodes.map((n) => [n.id, 0]))
  const adj = new Map(nodes.map((n) => [n.id, []]))
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of edges) {
    adj.get(e.from).push(e.to)
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1)
  }
  const ind = new Map(indeg)
  const queue = nodes.filter((n) => (ind.get(n.id) || 0) === 0).map((n) => n.id)
  while (queue.length) {
    const id = queue.shift()
    for (const to of adj.get(id)) {
      level.set(to, Math.max(level.get(to), level.get(id) + 1))
      ind.set(to, ind.get(to) - 1)
      if (ind.get(to) === 0) queue.push(to)
    }
  }
  for (const n of nodes) n.level = level.get(n.id) || 0

  // ── y within each level (insertion order) ──
  const byLevel = new Map()
  for (const n of nodes) {
    const arr = byLevel.get(n.level) || []
    arr.push(n)
    byLevel.set(n.level, arr)
  }
  for (const arr of byLevel.values()) arr.forEach((n, i) => (n.row = i))
  const maxLevel = Math.max(0, ...nodes.map((n) => n.level))
  const maxRows = Math.max(1, ...[...byLevel.values()].map((a) => a.length))
  return { nodes, edges, byId, maxLevel, maxRows }
}
