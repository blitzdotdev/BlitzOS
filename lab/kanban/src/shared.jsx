// Shared helpers for both board models + the drill-in drawer: fetch the captured per-leaf record / session, and
// render a leaf's output HUMAN-READABLY (typed: structured → labeled fields, text → text), never raw JSON.
import { useEffect, useState } from 'react'

export const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms || 0) + 'ms')
export const fmtTok = (t) => (t >= 1000 ? (t / 1000).toFixed(1) + 'k' : String(t || 0))
export const isFixture = (runId) => !runId || runId.startsWith('fixture')

// Fetch the captured leaf record once the leaf is terminal (done/error/empty) and we have a REAL runId.
export function useLeaf(runId, nodeId, terminal) {
  const [leaf, setLeaf] = useState(null)
  useEffect(() => {
    if (!terminal || isFixture(runId) || nodeId == null) return
    let live = true
    fetch(`/api/leaf?runId=${encodeURIComponent(runId)}&nodeId=${nodeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => live && j && setLeaf(j.leaf))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [runId, nodeId, terminal])
  return leaf
}

export function useLeafSession(runId, nodeId, open) {
  const [sess, setSess] = useState(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open || isFixture(runId) || nodeId == null) {
      setSess(null)
      return
    }
    setLoading(true)
    let live = true
    fetch(`/api/leaf-session?runId=${encodeURIComponent(runId)}&nodeId=${nodeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (live) {
          setSess(j)
          setLoading(false)
        }
      })
      .catch(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [runId, nodeId, open])
  return { sess, loading }
}

// First meaningful sentence of a prose blob, minus a leading filler ack ("Done." / "Ok,"), clamped for a card face.
function firstSentence(s) {
  let t = String(s).replace(/^\s*(?:done|ok|okay|sure|got it|alright)\b[.!:,—-]*\s+/i, '').trim()
  if (!t) t = String(s).trim()
  const first = t.split(/(?<=[.!?])\s/)[0] || t
  return first.length > 140 ? first.slice(0, 139) + '…' : first
}

// A one-line HUMAN headline for a card face. text → first sentence; structured → the most human field (a salient
// named string, else any string field), and NEVER raw JSON — an all-structured object falls back to its shape.
export function summarize(result, fallback) {
  if (result == null || result === '') return fallback || ''
  if (typeof result === 'string') return firstSentence(result)
  if (Array.isArray(result)) return result.length + (result.length === 1 ? ' item' : ' items')
  if (typeof result === 'object') {
    for (const k of ['summary', 'headline', 'name', 'title', 'verdict', 'answer', 'label', 'result', 'decision', 'area', 'description']) {
      if (typeof result[k] === 'string' && result[k].trim()) return firstSentence(result[k])
    }
    for (const v of Object.values(result)) {
      if (typeof v === 'string' && v.trim()) return firstSentence(v)
    }
    const keys = Object.keys(result)
    return keys.length ? keys.length + (keys.length === 1 ? ' field' : ' fields') : fallback || ''
  }
  return String(result)
}

// Render a leaf's output human-readably: structured → labeled fields; text → paragraphs. The JSON-blob fix.
export function Output({ result, fallback }) {
  if (result == null && fallback) return <div className="out-text">{fallback}</div>
  if (result == null) return null
  if (typeof result === 'string') return <div className="out-text">{result}</div>
  if (Array.isArray(result)) {
    return (
      <ul className="out-list">
        {result.slice(0, 40).map((v, i) => (
          <li key={i}>{typeof v === 'object' ? <code>{JSON.stringify(v)}</code> : String(v)}</li>
        ))}
      </ul>
    )
  }
  if (typeof result === 'object') {
    return (
      <div className="out-fields">
        {Object.entries(result).map(([k, v]) => (
          <div className="out-field" key={k}>
            <span className="out-k">{k}</span>
            <span className="out-v">{v != null && typeof v === 'object' ? <code>{JSON.stringify(v)}</code> : String(v)}</span>
          </div>
        ))}
      </div>
    )
  }
  return <div className="out-text">{String(result)}</div>
}
