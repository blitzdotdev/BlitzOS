// plan — the W1 editable JOB plan widget (plans/blitzos-plan-widget.md, plans/blitzos-user-journey.md).
//
// SCOPE NOTE: this is a FUNCTIONAL TEMPLATE — it compiles and round-trips the correct data contract so a job agent
// can spawn it as-is (spawn_widget {name:"plan"}). Its VISUAL/DESIGN is intentionally lean and is the USER'S to
// redesign; the load-bearing parts are the DATA CONTRACT (props shape) and the RETURN CHANNEL (setProps + a tiny
// sendMessage), documented in get_widget_authoring "Editable / interactive widgets". Keep those intact when restyling.
//
// THE DATA CONTRACT (props — the single source of truth; every edit is mirrored back via blitz.setProps):
//   { mode:'edit'|'status', agentId, title?,
//     stages:[{ id, title, detail?, status:'todo'|'done'|'blocked' }],   // editable, reorderable, removable
//     decisions:{ [name]: boolean },                                     // per-decision yes/no toggles
//     comments:'', decision:null|'approve'|'reject' }
//
// THE RETURN CHANNEL (the recommended no-core-edit two-step):
//   1. on Submit/Reject -> blitz.setProps({ stages, decisions, comments, decision }) writes the FULL edited plan.
//   2. -> blitz.sendMessage('plan '+decision, props.agentId) wakes the JOB agent (props.agentId routes it; without it
//      the primary agent '0' is woken). The agent then reads the full plan with get_surface {id} (sidestepping the
//      4000-byte __blitz:'action' cap) and reconciles it into the job's plan.md.
//
// EXECUTION (mode:'status'): the agent flips props.mode to 'status' on approval and drives each stage's status as work
// moves (update_surface{props}); the rows then render read-only with a status dot. ONE durable surface plan->execute.
import React, { useState, useEffect, useRef } from 'react'

const uid = () => 's' + Math.random().toString(36).slice(2, 8)
const STATUS_COLOR = { done: 'var(--blitz-sage)', blocked: 'var(--blitz-terracotta)', todo: 'var(--blitz-text-dim)' }
// Normalize whatever the agent seeds into a stable, id'd working copy (so reorder/remove never mixes rows).
function normStages(raw) {
  return (Array.isArray(raw) ? raw : []).map((s) => ({
    id: s && s.id ? String(s.id) : uid(),
    title: s && s.title != null ? String(s.title) : '',
    detail: s && s.detail != null ? String(s.detail) : '',
    status: s && (s.status === 'done' || s.status === 'blocked') ? s.status : 'todo'
  }))
}

export default function Plan() {
  const seed = (window.blitz && blitz.props && blitz.props()) || {}
  const [mode, setMode] = useState(seed.mode === 'status' ? 'status' : 'edit')
  const [title, setTitle] = useState(seed.title || 'Plan')
  const [stages, setStages] = useState(normStages(seed.stages))
  const [decisions, setDecisions] = useState(seed.decisions && typeof seed.decisions === 'object' ? { ...seed.decisions } : {})
  const [comments, setComments] = useState(seed.comments || '')
  const [submitted, setSubmitted] = useState(seed.decision || null)
  // The agentId is read-only routing info — keep it in a ref so a re-seed never drops it.
  const agentId = useRef(seed.agentId != null ? String(seed.agentId) : undefined)
  // The once-bound Submit/Reject button listeners keep their first-render closure, so submit() must read the LATEST
  // edited state from a ref (refreshed every render) rather than the stale render-time stages/decisions/comments.
  const latest = useRef({ stages, decisions, comments })
  latest.current = { stages, decisions, comments }

  // Re-seed from the agent: update_surface{props} fires onProps. We re-sync mode/title/stages/decisions/comments so an
  // agent reconcile (e.g. it normalized the plan after a user edit, or flipped to status mode) lands in the widget.
  // Local edits are mirrored to props on each change, so onProps replays the same values harmlessly between edits.
  useEffect(() => {
    return blitz.onProps((p) => {
      if (!p || typeof p !== 'object') return
      if (p.agentId != null) agentId.current = String(p.agentId)
      if (p.mode === 'status' || p.mode === 'edit') setMode(p.mode)
      if (p.title != null) setTitle(String(p.title))
      if (Array.isArray(p.stages)) setStages(normStages(p.stages))
      if (p.decisions && typeof p.decisions === 'object') setDecisions({ ...p.decisions })
      if (p.comments != null) setComments(String(p.comments))
      if (p.decision !== undefined) setSubmitted(p.decision || null)
    })
  }, [])

  // Persist the editable state to props (durable own-surface) so a reload restores the in-progress edit.
  const persist = (patch) => {
    try { blitz.setProps(patch) } catch (e) { /* bridge not up yet — the next edit re-tries */ }
  }
  // Mutators use FUNCTIONAL updaters (compute next from prev, then persist next) so the once-bound <blitz-edit>/
  // <blitz-toggle> listeners — which keep their first-render closure — always act on the LATEST state, never a
  // stale snapshot (the row event listeners are attached once per element; only the row id is closed over, and
  // that is stable). React onClick handlers (Mini, buttons) re-bind every render, but functional updates keep them
  // consistent too.
  const editStage = (id, key, value) => setStages((prev) => { const next = prev.map((s) => (s.id === id ? { ...s, [key]: value } : s)); persist({ stages: next }); return next })
  const moveStage = (i, dir) => setStages((prev) => {
    const j = i + dir
    if (j < 0 || j >= prev.length) return prev
    const next = prev.slice()
    const t = next[i]; next[i] = next[j]; next[j] = t
    persist({ stages: next }); return next
  })
  const removeStage = (id) => setStages((prev) => { const next = prev.filter((s) => s.id !== id); persist({ stages: next }); return next })
  const addStage = () => setStages((prev) => { const next = prev.concat({ id: uid(), title: '', detail: '', status: 'todo' }); persist({ stages: next }); return next })
  const toggleDecision = (name, on) => setDecisions((prev) => { const next = { ...prev, [name]: on }; persist({ decisions: next }); return next })
  const editComments = (v) => { setComments(v); persist({ comments: v }) }

  // THE RETURN CHANNEL: write the full edited plan into props (read the LATEST via the ref, not a stale closure),
  // then wake the job agent with a tiny message — the agent reads the full plan back with get_surface.
  const submit = (decision) => {
    setSubmitted(decision)
    const { stages: st, decisions: dc, comments: cm } = latest.current
    persist({ stages: st, decisions: dc, comments: cm, decision })
    try { blitz.sendMessage('plan ' + decision, agentId.current) } catch (e) { /* offline — the agent re-reads on next poll */ }
  }

  const kicker = { font: '600 9px ui-monospace,monospace', letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--blitz-accent)' }
  const rowWrap = { display: 'flex', gap: 9, alignItems: 'flex-start', padding: '8px 0', borderTop: '1px solid var(--blitz-hairline)' }
  const isStatus = mode === 'status'

  return (
    <div style={{ padding: '16px 18px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={kicker}>{isStatus ? 'Running' : 'Plan · review'}</div>
        {submitted ? <div style={{ font: '600 9px ui-monospace,monospace', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--blitz-text-dim)' }}>{submitted === 'approve' ? 'Submitted' : 'Sent back'}</div> : null}
      </div>
      <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-.02em', color: 'var(--blitz-text)' }}>{title}</div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {stages.map((s, i) => (
          <div key={s.id} style={rowWrap}>
            <div style={{ width: 9, height: 9, borderRadius: '50%', marginTop: 5, flex: '0 0 auto', background: STATUS_COLOR[s.status] || STATUS_COLOR.todo }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {isStatus ? (
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--blitz-text)' }}>{s.title || 'Untitled step'}</div>
              ) : (
                <blitz-edit value={s.title} placeholder="Step title" ref={bindEdit((v) => editStage(s.id, 'title', v))} style={{ fontSize: 13, fontWeight: 600 }} />
              )}
              {isStatus ? (
                s.detail ? <div style={{ fontSize: 12, color: 'var(--blitz-text-dim)', marginTop: 2 }}>{s.detail}</div> : null
              ) : (
                <blitz-edit value={s.detail} placeholder="Detail (optional)" multiline="" ref={bindEdit((v) => editStage(s.id, 'detail', v))} style={{ fontSize: 12, color: 'var(--blitz-text-dim)' }} />
              )}
            </div>
            {!isStatus ? (
              <div style={{ display: 'flex', gap: 2, flex: '0 0 auto' }}>
                <Mini label="▲" onClick={() => moveStage(i, -1)} disabled={i === 0} />
                <Mini label="▼" onClick={() => moveStage(i, 1)} disabled={i === stages.length - 1} />
                <Mini label="✕" onClick={() => removeStage(s.id)} />
              </div>
            ) : null}
          </div>
        ))}
        {!isStatus ? (
          <button onClick={addStage} style={{ marginTop: 8, alignSelf: 'flex-start', appearance: 'none', border: '1px dashed var(--blitz-hairline)', background: 'transparent', color: 'var(--blitz-text-dim)', borderRadius: 'var(--blitz-radius-sm)', padding: '5px 10px', font: 'inherit', cursor: 'pointer' }}>+ Add step</button>
        ) : null}
      </div>

      {!isStatus && Object.keys(decisions).length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 4 }}>
          <div style={kicker}>Decisions</div>
          {Object.keys(decisions).map((name) => (
            <blitz-toggle key={name} label={name} {...(decisions[name] ? { on: '' } : {})} ref={bindToggle((on) => toggleDecision(name, on))} />
          ))}
        </div>
      ) : null}

      {!isStatus ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
          <div style={kicker}>Comments</div>
          <textarea
            value={comments}
            onChange={(e) => editComments(e.target.value)}
            placeholder="Anything to change before this runs?"
            rows={2}
            style={{ resize: 'vertical', background: 'var(--blitz-bg)', color: 'var(--blitz-text)', border: '1px solid var(--blitz-hairline)', borderRadius: 'var(--blitz-radius-sm)', padding: '7px 9px', font: 'inherit', outline: 'none' }}
          />
          <div style={{ display: 'flex', gap: 8, paddingTop: 2 }}>
            <blitz-button ref={bindClick(() => submit('approve'))}>Approve & run</blitz-button>
            <blitz-button variant="ghost" ref={bindClick(() => submit('reject'))}>Send back</blitz-button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// A tiny ghost icon-button for reorder/remove (kept inline so the widget is one file).
function Mini({ label, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ appearance: 'none', border: 'none', background: 'transparent', color: 'var(--blitz-text-dim)', width: 22, height: 22, borderRadius: 5, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.3 : 1, fontSize: 11 }}
    >
      {label}
    </button>
  )
}

// Custom-element event binding via ref (React doesn't bind a CustomEvent onChange to a <blitz-*> element's listener).
const bindEdit = (cb) => (node) => {
  if (!node || node.__bound) return
  node.__bound = true
  const fire = (e) => cb(e.detail && e.detail.value != null ? e.detail.value : '')
  node.addEventListener('input', fire)
  node.addEventListener('change', fire)
}
const bindToggle = (cb) => (node) => {
  if (!node || node.__bound) return
  node.__bound = true
  node.addEventListener('change', (e) => cb(!!(e.detail && e.detail.on)))
}
const bindClick = (cb) => (node) => {
  if (!node || node.__bound) return
  node.__bound = true
  node.addEventListener('click', cb)
}
