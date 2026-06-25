// agent-transcript.mjs — read an agent's CANONICAL Claude Code session transcript and normalize it into
// structured events. This is the source of truth for "what the agent did" (Grep / Edit / Run + text + results),
// far cleaner than scraping the terminal. Two consumers: the dynamic-island "details" expand (rendered as-is) and
// the milestone narrator (digested + summarized by Haiku). Backend note: this is the CLAUDE path
// (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl). Codex would add its own reader behind the same shape.
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

/** Locate an agent's jsonl from the workspace root (claude's cwd) + its claudeSessionId. The encoding mirrors
 *  claude's own: the cwd with every `/` and `.` turned into `-` (see agent-runtime claudeConversationExists). */
export function sessionJsonlPath(wsRoot, claudeSessionId) {
  if (!wsRoot || !claudeSessionId) return null
  try {
    const cfgDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const encoded = String(wsRoot).replace(/[/.]/g, '-')
    const p = join(cfgDir, 'projects', encoded, `${claudeSessionId}.jsonl`)
    return existsSync(p) ? p : null
  } catch {
    return null
  }
}

const STOP_TAIL_BYTES = 256 * 1024 // these transcripts get huge — read only the tail to find the last turn

/** The first text block of an assistant message (content is either a string or a content-block array). */
function firstTextBlock(message) {
  const c = message && message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    for (const b of c) if (b && b.type === 'text' && typeof b.text === 'string') return b.text
  }
  return ''
}

/** Classify a Claude Code API-error message (the text of an `isApiErrorMessage` record) into a coarse cause,
 *  for the island's error label. Order matters — more specific patterns first. */
export function classifyApiError(text) {
  const s = String(text || '')
  if (/issue with the selected model/i.test(s)) return 'model'
  // Rate-limit BEFORE usage-limit: the rate-limit text reads "...temporarily limiting requests (not your usage
  // limit)", so a usage-limit check would otherwise false-match on that negation.
  if (/temporarily limiting requests|rate[ _-]?limit/i.test(s)) return 'rate-limit'
  if (/session limit|weekly limit|hit your (?:usage )?limit/i.test(s)) return 'usage-limit'
  if (/overloaded|\b529\b/i.test(s)) return 'overloaded'
  if (/internal server error|server-side issue|\b50[0-9]\b/i.test(s)) return 'server-error'
  if (/unable to connect|connectionrefused|failedtoopensocket|socket connection|idle timeout|timed out|timeout/i.test(s)) return 'connection'
  if (/not logged in|run \/login|credits required/i.test(s)) return 'auth'
  if (/prompt is too long/i.test(s)) return 'input'
  if (/unable to respond to this request/i.test(s)) return 'refusal'
  return 'error'
}

/** The LAST assistant stop signal in a Claude session JSONL (or null if none / unreadable).
 *  Bounded tail read so a multi-MB transcript stays cheap; a torn final line just fails to parse and is skipped. */
export function lastAssistantStop(jsonlPath) {
  if (!jsonlPath) return null
  let fd = null
  try {
    fd = openSync(jsonlPath, 'r')
    const size = fstatSync(fd).size
    const start = size > STOP_TAIL_BYTES ? size - STOP_TAIL_BYTES : 0
    const buf = Buffer.allocUnsafe(size - start)
    readSync(fd, buf, 0, buf.length, start)
    closeSync(fd)
    fd = null
    const lines = buf.toString('utf8').split('\n')
    const offsets = []
    let running = 0
    for (const line of lines) {
      offsets.push(start + running)
      running += Buffer.byteLength(line, 'utf8') + 1
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line || line.indexOf('"assistant"') < 0) continue // cheap prefilter before JSON.parse
      let d
      try {
        d = JSON.parse(line)
      } catch {
        continue // a partial/torn tail line (or a non-JSON line) — skip
      }
      if (d.type === 'assistant' && d.message && d.message.stop_reason != null) {
        // Claude Code records an API failure as an assistant record with `isApiErrorMessage:true` — but it still
        // carries a CLEAN stop_reason (stop_sequence/refusal), so callers keying on stop_reason alone miss it.
        const isApiError = d.isApiErrorMessage === true
        const errorText = isApiError ? firstTextBlock(d.message) : ''
        return {
          stopReason: String(d.message.stop_reason),
          offset: offsets[i],
          timestamp: d.timestamp ? Date.parse(d.timestamp) || null : null,
          isApiError,
          errorText,
          cause: isApiError ? classifyApiError(errorText) : null
        }
      }
    }
    return null
  } catch {
    try {
      if (fd != null) closeSync(fd)
    } catch {
      /* ignore */
    }
    return null
  }
}

/** The `stop_reason` of the LAST assistant message in a Claude session JSONL (or null if none / unreadable).
 *  Used to tell a turn that ended cleanly (end_turn/stop_sequence) from one cut off mid-turn (tool_use/truncated). */
export function lastAssistantStopReason(jsonlPath) {
  return lastAssistantStop(jsonlPath)?.stopReason || null
}

/** The last assistant turn's API error, or null if the last turn was a normal turn. Keys on Claude Code's
 *  `isApiErrorMessage:true` record. Returns the same shape as lastAssistantStop (with isApiError/cause/errorText),
 *  so the caller gets the byte offset to compare against a per-agent turn baseline. */
export function lastAssistantError(jsonlPath) {
  const stop = lastAssistantStop(jsonlPath)
  return stop && stop.isApiError ? stop : null
}

const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

// A cheap +added −removed line delta for an Edit (multiset diff — exact enough for a label; the narrator
// summarizes anyway, and the details expand only needs a sense of size).
function editDelta(oldS, newS) {
  const a = String(oldS ?? '').split('\n')
  const b = String(newS ?? '').split('\n')
  const ca = new Map()
  for (const l of a) ca.set(l, (ca.get(l) || 0) + 1)
  const cb = new Map()
  for (const l of b) cb.set(l, (cb.get(l) || 0) + 1)
  let added = 0
  let removed = 0
  for (const [l, n] of cb) added += Math.max(0, n - (ca.get(l) || 0))
  for (const [l, n] of ca) removed += Math.max(0, n - (cb.get(l) || 0))
  return { added, removed }
}

// Map a tool_use to a structured row: a verb + a target + an optional detail. Mirrors the activity-feed grammar
// the island shows (Grep / Edit / Run …). Inputs are NEVER dumped (only name + target + a short detail).
export function toolRow(name, input) {
  const i = input || {}
  switch (name) {
    case 'Bash': {
      return { verb: 'Run', target: clip(i.description || i.command, 72) }
    }
    case 'Edit':
    case 'MultiEdit': {
      const d = editDelta(i.old_string, i.new_string)
      return { verb: 'Edit', target: i.file_path ? basename(String(i.file_path)) : '', detail: `+${d.added} −${d.removed}` }
    }
    case 'Write':
      return { verb: 'Write', target: i.file_path ? basename(String(i.file_path)) : '' }
    case 'Read':
      return { verb: 'Read', target: i.file_path ? basename(String(i.file_path)) : '' }
    case 'Grep':
      return { verb: 'Grep', target: clip(i.pattern, 48), detail: i.path ? clip(i.path, 32) : '' }
    case 'Glob':
      return { verb: 'Find', target: clip(i.pattern, 48) }
    case 'WebSearch':
      return { verb: 'Search', target: clip(i.query, 60) }
    case 'WebFetch':
      return { verb: 'Fetch', target: clip(i.url, 60) }
    case 'Task':
      return { verb: 'Subagent', target: clip(i.description || i.subagent_type, 60) }
    case 'TodoWrite':
      return { verb: 'Plan', target: '' }
    default:
      return { verb: name || 'Tool', target: clip(JSON.stringify(i), 56) }
  }
}

/** One-line label for a tool row (the details expand). e.g. "Edit session.ts +18 −9", "Run npm run typecheck". */
export function toolLabel(row) {
  if (!row) return ''
  return [row.verb, row.target, row.detail].filter(Boolean).join(' ')
}

/**
 * Read NEW transcript records since a byte offset. Returns normalized events + the next offset (so a poller can
 * resume cheaply without re-reading). Event kinds:
 *   { kind:'tool', name, row:{verb,target,detail}, ts }     — a tool call (Grep/Edit/Run…)
 *   { kind:'text', text, ts }                               — the agent's visible text (trimmed)
 *   { kind:'result', isError, ts }                          — a tool result (body dropped; just the ok/error)
 * @param {string} jsonlPath
 * @param {number} sinceOffset  byte offset to resume from (0 = whole file)
 * @returns {{ events: Array<object>, offset: number }}
 */
export function readSessionEvents(jsonlPath, sinceOffset = 0) {
  if (!jsonlPath || !existsSync(jsonlPath)) return { events: [], offset: sinceOffset }
  let size = 0
  try {
    size = statSync(jsonlPath).size
  } catch {
    return { events: [], offset: sinceOffset }
  }
  // No growth since last read → nothing new; skip reading the file entirely (cheap idle ticks even for a huge
  // transcript like the primary agent's). This is what makes the 60s loop free when an agent is quiet.
  if (size === sinceOffset) return { events: [], offset: size }
  // The file is append-only; if it shrank (a fresh session / --resume rotation), restart from 0.
  const from = sinceOffset > size ? 0 : sinceOffset
  let buf = ''
  try {
    buf = readFileSync(jsonlPath, 'utf8')
  } catch {
    return { events: [], offset: sinceOffset }
  }
  // Slice by character offset (utf8 read); close enough for resume (we re-read from a line boundary by trimming
  // a leading partial line). Simpler + robust: parse the WHOLE file but only KEEP records after `from` bytes by
  // tracking a running byte length. For our sizes (a session jsonl) this is fine.
  const events = []
  let running = 0
  for (const line of buf.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1 // +1 for the newline
    const startedAt = running
    running += lineBytes
    if (!line) continue
    if (startedAt < from) continue // already seen
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const ts = d.timestamp ? Date.parse(d.timestamp) || undefined : undefined
    const msg = d.message
    if (d.type === 'assistant' && msg && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use') events.push({ kind: 'tool', name: b.name, row: toolRow(b.name, b.input), ts })
        else if (b.type === 'text' && b.text && b.text.trim()) events.push({ kind: 'text', text: clip(b.text, 400), ts })
      }
    } else if (d.type === 'user' && msg && Array.isArray(msg.content)) {
      for (const x of msg.content) {
        if (x.type === 'tool_result') events.push({ kind: 'result', isError: !!x.is_error, ts })
      }
    }
  }
  return { events, offset: size }
}

/** A compact, trimmed digest of events for the Haiku narrator (never the raw diffs — just verbs + targets +
 *  a little text). Bounded so the prompt stays small + cheap. */
export function digestForNarrator(events, max = 40) {
  const lines = []
  for (const e of events.slice(-max)) {
    if (e.kind === 'tool') lines.push('- ' + toolLabel(e.row) + (e.name && !e.row.target ? '' : ''))
    else if (e.kind === 'text') lines.push('- (says) ' + e.text)
    else if (e.kind === 'result' && e.isError) lines.push('- (a step failed)')
  }
  return lines.join('\n')
}
