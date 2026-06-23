// reduce — fold the WfEvent stream into a board model. Ported from lab/kanban/src/reduce.js.
// Pure + idempotent (replayed from seq 0), so live and replayed render identically.

export interface WfModel {
  name: string
  description: string
  status: 'running' | 'done' | 'error'
  stats: { ms: number; calls: number; tokens: number } | null
  resultPreview: string
  phaseOrder: string[]
  phaseSeen: Set<string>
  groups: Record<string, { groupId: string; kind: string; phaseId: string; size: number; started: number; done?: boolean }>
  groupOrder: string[]
  nodes: Record<string, WfNode>
  nodeOrder: string[]
}

export interface WfNode {
  nodeId: string
  label: string
  phaseId: string
  groupId: string | null
  model: string
  status: 'running' | 'done' | 'error' | 'empty' | 'queued'
  ms: number
  tokens: number
  preview: string
  error: string
  prompt?: string
  summary?: string // the leaf's human prose one-liner (harness final text) — the readable card headline (no IPC)
}

export function reduce(events: unknown[]): WfModel {
  const m: WfModel = {
    name: '',
    description: '',
    status: 'running',
    stats: null,
    resultPreview: '',
    phaseOrder: [],
    phaseSeen: new Set(),
    groups: {},
    groupOrder: [],
    nodes: {},
    nodeOrder: []
  }
  const seePhase = (p: unknown): string => {
    const id = p == null ? '' : String(p)
    if (!m.phaseSeen.has(id)) {
      m.phaseSeen.add(id)
      m.phaseOrder.push(id)
    }
    return id
  }
  for (const raw of events) {
    const e = raw as Record<string, unknown>
    if (!e || !e.type) continue
    if (e.type === 'run:start') {
      m.name = String(e.name || '')
      m.description = String(e.description || '')
    } else if (e.type === 'phase') {
      seePhase(e.phaseId)
    } else if (e.type === 'run:done') {
      m.status = e.ok ? 'done' : 'error'
      m.stats = { ms: Number(e.ms) || 0, calls: Number(e.calls) || 0, tokens: Number(e.tokens) || 0 }
      m.resultPreview = String(e.preview || '')
    } else if (e.type === 'group:start') {
      const gid = String(e.groupId)
      if (!m.groups[gid]) {
        m.groups[gid] = { groupId: gid, kind: String(e.kind || ''), phaseId: seePhase(e.phaseId), size: Number(e.size) || 0, started: 0 }
        m.groupOrder.push(gid)
      }
    } else if (e.type === 'group:done') {
      const g = m.groups[String(e.groupId)]
      if (g) g.done = true
    } else if (e.type === 'agent:start') {
      const id = String(e.nodeId)
      const phaseId = seePhase(e.phaseId)
      if (!m.nodes[id]) {
        m.nodes[id] = {
          nodeId: id,
          label: String(e.label || 'agent ' + id),
          phaseId,
          groupId: e.groupId == null ? null : String(e.groupId),
          model: String(e.model || ''),
          status: 'running',
          ms: 0,
          tokens: 0,
          preview: '',
          error: '',
          prompt: e.prompt ? String(e.prompt) : ''
        }
        m.nodeOrder.push(id)
        const gid = e.groupId == null ? null : String(e.groupId)
        if (gid != null && m.groups[gid]) m.groups[gid].started++
      } else {
        m.nodes[id].status = 'running'
      }
    } else if (e.type === 'agent:done') {
      const n = m.nodes[String(e.nodeId)]
      if (n) {
        n.status = e.status === 'error' ? 'error' : e.status === 'null' ? 'empty' : 'done'
        n.ms = Number(e.ms) || 0
        n.tokens = Number(e.tokens) || 0
        n.preview = String(e.preview || '')
        n.error = String(e.message || '')
        if (e.summary) n.summary = String(e.summary) // human one-liner for the card face (no per-card leaf fetch)
      }
    }
  }
  return m
}

// Whether a model is a SINGLE-PHASE fan-out — ≤1 phase actually containing nodes (the "subagents" shape rendered
// as one row per leaf, not the kanban grid). Requires ≥1 node so an empty/not-yet-loaded stream is NOT mistaken
// for single-phase. Shared so IslandKanban (merged events) and IslandPanel (the skeleton alone, to drop the
// redundant run-level pill) decide it identically.
export function isSubagentModel(m: WfModel): boolean {
  if (!m.nodeOrder.length) return false
  const phases = new Set<string>()
  for (const id of m.nodeOrder) phases.add(m.nodes[id].phaseId)
  return phases.size <= 1
}
export function isSubagentEvents(events: unknown[]): boolean {
  return isSubagentModel(reduce(events || []))
}

// Merge the dry-run SKELETON (the full planned structure: every leaf with its label + phase, instant) with the REAL
// run's live events. Result: a reduced model where every planned leaf is present — real ones carry their live state
// (running/done + output), and not-yet-run ones are 'queued' (TODO). So phase 2 sits in TODO while phase 1 runs.
export function mergeSkeleton(realEvents: unknown[], skeletonEvents: unknown[]): WfModel {
  const real = reduce(realEvents || [])
  if (!skeletonEvents || !skeletonEvents.length) return real
  const skel = reduce(skeletonEvents)
  const nodeOrder = skel.nodeOrder.slice()
  for (const id of real.nodeOrder) if (!(id in skel.nodes)) nodeOrder.push(id)
  const nodes: Record<string, WfNode> = {}
  for (const id of nodeOrder) {
    const r = real.nodes[id]
    if (r) {
      // A real node's live agent:start carries no prompt (only the dry SKELETON does). Inherit the skeleton's
      // prompt when the real one lacks it, so the drawer's "Asked" is populated while the leaf is still in Doing
      // (the EXACT prompt reloads from the captured leaf file the moment it finishes). No event-stream bloat.
      const sk = skel.nodes[id]
      nodes[id] = r.prompt || !(sk && sk.prompt) ? r : { ...r, prompt: sk.prompt }
    } else {
      nodes[id] = { ...skel.nodes[id], status: 'queued', ms: 0, tokens: 0, preview: '', error: '' }
    }
  }
  const groupOrder = skel.groupOrder.slice()
  for (const id of real.groupOrder) if (!(id in skel.groups)) groupOrder.push(id)
  const groups: WfModel['groups'] = {}
  for (const id of groupOrder) {
    groups[id] = { ...(skel.groups[id] || real.groups[id]), started: (real.groups[id] && real.groups[id].started) || 0 }
  }
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
