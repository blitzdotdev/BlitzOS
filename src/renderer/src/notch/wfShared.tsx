// Shared helpers for the island kanban + drill-in drawer. Ported from lab/kanban/src/shared.jsx.
// Markdown for "Did" reuses the renderer's MarkdownMessage (react-markdown) — no hand-rolled md here.
import { useEffect, useState, type ReactNode } from 'react'

export const fmtMs = (ms: number): string => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms || 0) + 'ms')
export const fmtTok = (t: number): string => {
  const n = t || 0
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M' // 6,124,700 -> 6.1M
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n) // 612,470 -> 612.5k
}

// A card's `preview` is previewOf(out) = JSON.stringify(out) sliced to ~280 chars. Parse it back to the typed
// value so summarize/cardHead can pick a HUMAN field instead of rendering the raw JSON string. A truncated (slice
// cut mid-JSON) or non-JSON preview won't parse → return it as the plain string (summarize then takes its text).
export function tryParsePreview(preview: string): unknown {
  if (!preview) return ''
  try {
    return JSON.parse(preview)
  } catch {
    return preview
  }
}

// Fetch the captured leaf record once the leaf is terminal (done/error/empty). Lazy on-click via the bridge.
// Main resolves the run's memDir by runId, so this takes only (runId, nodeId). Clears stale state on EVERY change
// so a slow or {ok:false} fetch can never leave the PREVIOUS card's Asked/Did/Returned on screen.
export function useLeaf(runId: string, nodeId: string | null, terminal: boolean): Record<string, unknown> | null {
  const [leaf, setLeaf] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    setLeaf(null) // drop the prior card's record immediately on any run/node/terminal change
    if (!terminal || nodeId == null) return
    let live = true
    window.agentOS
      ?.wfLeaf?.(runId, nodeId)
      .then((r) => { if (live && r && r.ok && r.leaf) setLeaf(r.leaf) })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [runId, nodeId, terminal])
  return leaf
}

// First meaningful sentence of a prose/markdown blob for a card face: strip markdown, collapse newlines,
// drop a leading filler ack ("Done." / "Ok,"), take the first sentence, clamp.
function firstSentence(s: string): string {
  let t = String(s)
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[|>]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*(?:done|ok|okay|sure|got it|alright)\b[.!:,—-]*\s+/i, '')
    .trim()
  if (!t) t = String(s).replace(/\s+/g, ' ').trim()
  const first = t.split(/(?<=[.!?])\s/)[0] || t
  return first.length > 140 ? first.slice(0, 139) + '…' : first
}

// A one-line HUMAN headline for a card face. text → first sentence; structured → a salient named string field
// (or an array's item labels), NEVER raw JSON.
export function summarize(result: unknown, fallback?: string): string {
  if (result == null || result === '') return fallback || ''
  if (typeof result === 'string') return firstSentence(result)
  if (Array.isArray(result)) return result.length + (result.length === 1 ? ' item' : ' items')
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>
    for (const k of ['summary', 'headline', 'name', 'title', 'verdict', 'answer', 'label', 'result', 'decision', 'area', 'description']) {
      if (typeof r[k] === 'string' && (r[k] as string).trim()) return firstSentence(r[k] as string)
    }
    for (const v of Object.values(r)) {
      if (typeof v === 'string' && v.trim()) return firstSentence(v)
    }
    const arrEntry = Object.entries(r).find(([, v]) => Array.isArray(v) && v.length)
    if (arrEntry) {
      const [k, arr] = arrEntry as [string, unknown[]]
      const labels = arr.map((x) => (typeof x === 'string' ? x : x && String((x as Record<string, unknown>).name || (x as Record<string, unknown>).title || (x as Record<string, unknown>).label || ''))).filter(Boolean)
      if (labels.length) {
        const shown = labels.slice(0, 3).join(', ')
        return labels.length > 3 ? `${shown} +${labels.length - 3}` : shown
      }
      return arr.length + ' ' + k
    }
    const keys = Object.keys(r)
    return keys.length ? keys.length + (keys.length === 1 ? ' field' : ' fields') : fallback || ''
  }
  return String(result)
}

// The headline for a finished leaf's CARD face. Prefer the concise structured summary; the agent's prose
// ("Did" = leaf.summary) is the fallback for bare shape.
export function cardHead(leaf: Record<string, unknown> | null): string {
  if (!leaf) return ''
  const fromResult = summarize(leaf.result, '')
  const shapeOnly = /^\d+ (?:fields?|items?)$/.test(fromResult)
  if (fromResult && !shapeOnly) return fromResult
  const summary = leaf.summary && String(leaf.summary).trim() ? summarize(leaf.summary, '') : ''
  return summary || fromResult || '—'
}

// The card-face headline from an agent:done node — NO leaf fetch. Three cases, NEVER raw JSON:
//  (1) the preview parses to an OBJECT → cardHead picks a salient structured field (prose summary as fallback);
//  (2) the preview is a JSON-ish STRING (a structured result whose JSON.stringify was truncated past the ~280-char
//      preview cap, so it no longer parses) → use the leaf's prose `summary` (which agent:done now carries);
//  (3) the preview is plain text → summarize it directly.
export function eventCardHead(node: { preview?: string; summary?: string }): string {
  const preview = node.preview || ''
  const parsed = tryParsePreview(preview)
  if (parsed && typeof parsed === 'object') return cardHead({ result: parsed, summary: node.summary }) || '—'
  const looksJson = /^\s*[[{]/.test(preview) // a (truncated) JSON object/array that did not parse
  if (looksJson && node.summary && String(node.summary).trim()) return summarize(node.summary, '') || '—'
  return summarize(parsed, node.summary || preview) || '—'
}

// Pretty-print + syntax-highlight any JSON value (the "Returned" section). Pure regex tokenizer; no innerHTML.
export function JsonView({ value }: { value: unknown }): JSX.Element {
  const json = JSON.stringify(value, null, 2)
  if (json === undefined) return <pre className="json-view">{String(value)}</pre>
  const out: ReactNode[] = []
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(json))) {
    if (m.index > last) out.push(json.slice(last, m.index))
    if (m[1] != null && m[2] != null) {
      out.push(<span className="jk" key={i++}>{m[1]}</span>)
      out.push(<span className="jpunc" key={i++}>{m[2]}</span>)
    } else if (m[1] != null) out.push(<span className="js" key={i++}>{m[1]}</span>)
    else if (m[3] != null) out.push(<span className="jb" key={i++}>{m[3]}</span>)
    else if (m[4] != null) out.push(<span className="jn" key={i++}>{m[4]}</span>)
    else if (m[5] != null) out.push(<span className="jpunc" key={i++}>{m[5]}</span>)
    last = re.lastIndex
  }
  if (last < json.length) out.push(json.slice(last))
  return <pre className="json-view">{out}</pre>
}

// Render a leaf's output: text → prose; structured → pretty JSON.
export function Output({ result, fallback }: { result: unknown; fallback?: unknown }): JSX.Element | null {
  if (result == null && fallback != null && fallback !== '') {
    return typeof fallback === 'string' ? <div className="out-text">{fallback}</div> : <JsonView value={fallback} />
  }
  if (result == null) return null
  if (typeof result === 'string') return <div className="out-text">{result}</div>
  return <JsonView value={result} />
}
