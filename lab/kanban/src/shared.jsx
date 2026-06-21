// Shared helpers for both board models + the drill-in drawer: fetch the captured per-leaf record / session, and
// render a leaf's output HUMAN-READABLY (typed: structured → labeled fields, text → text), never raw JSON.
import { useEffect, useState, Fragment } from 'react'

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

// First meaningful sentence of a prose/markdown blob for a card face: strip markdown (bold, code, headings, table
// pipes), collapse newlines, drop a leading filler ack ("Done." / "Ok,"), take the first sentence, clamp.
function firstSentence(s) {
  let t = String(s)
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1') // inline/fenced code → its text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/[|>]/g, ' ') // table pipes / blockquote markers
    .replace(/\s+/g, ' ') // collapse newlines + runs of whitespace
    .replace(/^\s*(?:done|ok|okay|sure|got it|alright)\b[.!:,—-]*\s+/i, '')
    .trim()
  if (!t) t = String(s).replace(/\s+/g, ' ').trim()
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
    // No scalar string field: describe the richest array field by its items (name/title/label) or count — never JSON.
    const arrEntry = Object.entries(result).find(([, v]) => Array.isArray(v) && v.length)
    if (arrEntry) {
      const [k, arr] = arrEntry
      const labels = arr.map((x) => (typeof x === 'string' ? x : x && (x.name || x.title || x.label))).filter(Boolean)
      if (labels.length) {
        const shown = labels.slice(0, 3).join(', ')
        return labels.length > 3 ? `${shown} +${labels.length - 3}` : shown
      }
      return arr.length + ' ' + k
    }
    const keys = Object.keys(result)
    return keys.length ? keys.length + (keys.length === 1 ? ' field' : ' fields') : fallback || ''
  }
  return String(result)
}

// The headline for a finished leaf's CARD face. Prefer the concise structured summary (e.g. "fork, spawn, proc
// +6", the `area` line); the agent's prose ack is the fallback, used only when the result is bare shape ("N
// fields"/"N items") — prose can be long/markdown (a whole table), which reads badly on a tight card.
export function cardHead(leaf) {
  if (!leaf) return ''
  const fromResult = summarize(leaf.result, '')
  const shapeOnly = /^\d+ (?:fields?|items?)$/.test(fromResult)
  if (fromResult && !shapeOnly) return fromResult
  const fromProse = leaf.summary && leaf.summary.trim() ? summarize(leaf.summary, '') : ''
  return fromProse || fromResult || '—'
}

// Pretty-print + syntax-highlight any JSON value (keys / strings / numbers / booleans / punctuation) for the
// "Returned" section. A pure regex tokenizer over JSON.stringify(value, null, 2) — no dependency, no innerHTML.
export function JsonView({ value }) {
  const json = JSON.stringify(value, null, 2)
  if (json === undefined) return <pre className="json-view">{String(value)}</pre> // e.g. a bare undefined value
  const out = []
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g
  let last = 0
  let m
  let i = 0
  while ((m = re.exec(json))) {
    if (m.index > last) out.push(json.slice(last, m.index))
    if (m[1] != null && m[2] != null) {
      out.push(
        <span className="jk" key={i++}>
          {m[1]}
        </span>
      )
      out.push(
        <span className="jpunc" key={i++}>
          {m[2]}
        </span>
      )
    } else if (m[1] != null)
      out.push(
        <span className="js" key={i++}>
          {m[1]}
        </span>
      )
    else if (m[3] != null)
      out.push(
        <span className="jb" key={i++}>
          {m[3]}
        </span>
      )
    else if (m[4] != null)
      out.push(
        <span className="jn" key={i++}>
          {m[4]}
        </span>
      )
    else if (m[5] != null)
      out.push(
        <span className="jpunc" key={i++}>
          {m[5]}
        </span>
      )
    last = re.lastIndex
  }
  if (last < json.length) out.push(json.slice(last))
  return <pre className="json-view">{out}</pre>
}

// A tiny markdown renderer (bold, inline code, # headings, paragraphs) for an agent's final prose message.
function mdInline(text, keyBase) {
  const nodes = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let last = 0
  let m
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1] != null) nodes.push(<strong key={keyBase + '-' + i++}>{m[1]}</strong>)
    else
      nodes.push(
        <code className="md-code" key={keyBase + '-' + i++}>
          {m[2]}
        </code>
      )
    last = re.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}
function Para({ text, keyBase }) {
  const lines = String(text).split('\n')
  return (
    <p className="md-p">
      {lines.map((ln, li) => (
        <Fragment key={li}>
          {li ? <br /> : null}
          {mdInline(ln, keyBase + '-' + li)}
        </Fragment>
      ))}
    </p>
  )
}
export function Markdown({ text }) {
  const blocks = String(text || '')
    .trim()
    .split(/\n{2,}/)
  return (
    <div className="md">
      {blocks.map((b, bi) => {
        // A heading is only the FIRST line of its block; any following lines render as a paragraph below it (so a
        // "## Title\nbody" with no blank line does NOT swallow the body into the heading).
        const nl = b.indexOf('\n')
        const firstLine = nl === -1 ? b : b.slice(0, nl)
        const rest = nl === -1 ? '' : b.slice(nl + 1)
        const h = firstLine.match(/^(#{1,4})\s+(.*)$/)
        if (h)
          return (
            <Fragment key={bi}>
              <div className="md-h">{mdInline(h[2], 'h' + bi)}</div>
              {rest.trim() ? <Para text={rest} keyBase={'hb' + bi} /> : null}
            </Fragment>
          )
        return <Para text={b} keyBase={String(bi)} key={bi} />
      })}
    </div>
  )
}

// Render a leaf's output: text → prose; structured → pretty, syntax-highlighted JSON (the "Returned" section).
export function Output({ result, fallback }) {
  if (result == null && fallback != null && fallback !== '') {
    return typeof fallback === 'string' ? <div className="out-text">{fallback}</div> : <JsonView value={fallback} />
  }
  if (result == null) return null
  if (typeof result === 'string') return <div className="out-text">{result}</div>
  return <JsonView value={result} />
}
