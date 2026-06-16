// session-tape.mjs — the local model-loop spool (plans/blitzos-logging.md).
//
// Writes one TapeRecord per line to <root>/.blitzos/tape/session-<YYYY-MM-DD>.jsonl. LOCAL-ONLY,
// crash-safe (appendFileSync), never uploads, and must NEVER throw into the tap/emit path. v0 covers
// Stream A of the design: tool.call + moment.delivered over the shared envelope. Heavy payloads are
// clipped inline for now (the real impl hashes them to a content-addressed blob store).
import { appendFileSync, mkdirSync, writeFile, openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const CLIP = 4000 // clip a small string inline so a line stays readable
const BLOB_MIN = 2048 // a string bigger than this is content-addressed to the blob store, not inlined

// Scrub obvious secrets before anything is written (the spool is local today but must be egress-ready).
// Two rules: a key that names a secret, and a value that looks like a token. Never tape a credential.
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|bearer|authorization|access_token|refresh_token|client_secret|cookie)/i
const SECRET_VAL = /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{12,})/g
function scrub(v, key, depth = 0) {
  if (typeof v === 'string') {
    if (key && SECRET_KEY.test(key)) return '[scrubbed]'
    return v.replace(SECRET_VAL, '[scrubbed]')
  }
  if (!v || typeof v !== 'object' || depth > 6) return v
  if (Array.isArray(v)) return v.map((x) => scrub(x, null, depth + 1))
  const out = {}
  for (const k of Object.keys(v)) out[k] = scrub(v[k], k, depth + 1)
  return out
}

function clip(v, depth = 0) {
  if (typeof v === 'string') return v.length > CLIP ? v.slice(0, CLIP) + `…(+${v.length - CLIP} chars)` : v
  if (!v || typeof v !== 'object' || depth > 5) return v
  if (Array.isArray(v)) return v.slice(0, 60).map((x) => clip(x, depth + 1))
  const out = {}
  for (const k of Object.keys(v).slice(0, 80)) out[k] = clip(v[k], depth + 1)
  return out
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd() }).toString().trim() || 'dev'
  } catch {
    return 'dev'
  }
}

export function makeSessionTape({ getRoot, getWorkspace, appVersion = '0', boot = 'boot', clock = Date.now } = {}) {
  let seq = 0
  let lastMomentSeq = 0
  const wake = {} // agent id -> moment seqs from its last /events (the true cause of its next actions)
  let dir = null
  let file = null
  let day = null
  const codeVersion = gitSha()
  let blobDir = null
  const seenBlobs = new Set() // hashes written this session — never re-write the same bytes (cross-boot dupes overwrite harmlessly)
  const transcripts = new Map() // agent id -> { path, offset } — the model.io stream, collected offset-based

  function ensureBlobDir() {
    if (!blobDir) {
      blobDir = join(getRoot(), '.blitzos', 'tape', 'blobs')
      mkdirSync(blobDir, { recursive: true })
    }
    return blobDir
  }

  // Content-addressed blob store: a large payload (a screenshot, a DOM dump, a frame, a file) is written ONCE
  // under its hash; the record carries a small {$blob} ref. Identical bytes (the same page chrome, an idle
  // frame, a repeated DOM) dedupe across time and the fleet. The HASH is computed inline (it's the ref), but
  // the WRITE is async + fire-and-forget so heavy bytes never ride the hot path. Accepts a string OR a Buffer
  // (frames are JPEG buffers). Best-effort: a failed put falls back to an inline clip at the call site.
  function putBlob(input) {
    try {
      const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8')
      const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
      if (!seenBlobs.has(hash)) {
        seenBlobs.add(hash)
        const p = join(ensureBlobDir(), hash)
        writeFile(p, buf, () => {}) // off-thread; identical bytes are content-addressed so an overwrite is a no-op
      }
      return { blobRef: hash, bytes: buf.length }
    } catch {
      return null
    }
  }
  // Like clip(), but a big string becomes a blob ref (with a short preview) instead of being truncated —
  // so a full read_window DOM or a screenshot is preserved, not lost.
  function clipOrBlob(v, depth = 0) {
    if (typeof v === 'string') {
      if (v.length > BLOB_MIN) {
        const b = putBlob(v)
        return b ? { $blob: b.blobRef, bytes: b.bytes, preview: v.slice(0, 200) } : v.slice(0, CLIP) + `…(+${v.length - CLIP} chars)`
      }
      return v
    }
    if (!v || typeof v !== 'object' || depth > 6) return v
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => clipOrBlob(x, depth + 1))
    const out = {}
    for (const k of Object.keys(v).slice(0, 120)) out[k] = clipOrBlob(v[k], depth + 1)
    return out
  }

  function ensureFile() {
    const d = new Date(clock())
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (key !== day || !file) {
      day = key
      dir = join(getRoot(), '.blitzos', 'tape')
      file = join(dir, `session-${key}.jsonl`)
      mkdirSync(dir, { recursive: true })
    }
  }

  function append(stream, type, body) {
    try {
      ensureFile()
      const rec = {
        ts: clock(),
        seq: ++seq,
        session: boot,
        workspace: (getWorkspace && getWorkspace()) || null,
        codeVersion,
        appVersion,
        stream,
        type,
        ...body
      }
      appendFileSync(file, JSON.stringify(rec) + '\n')
    } catch {
      /* the tape must never break a tool call or a moment */
    }
  }

  // model.io: the agent's conversation/reasoning, collected from its TUI transcript (the raw pty record
  // BlitzOS already writes per agent). Backend-agnostic — whatever the agent loop printed. We START at the
  // CURRENT end of file so a resumed 40MB-backlog agent is not replayed; the live session is captured from
  // registration forward (agent.spawn references the full path for the history). Read-cap drains a burst over
  // several ticks without ever blocking.
  const TRANSCRIPT_CAP = 1024 * 1024 // bytes/agent/flush
  function sizeOf(path) {
    let fd
    try { fd = openSync(path, 'r'); return fstatSync(fd).size } catch { return 0 } finally { if (fd != null) try { closeSync(fd) } catch { /* ignore */ } }
  }
  function registerTranscript(agent, path, startAtEof = true) {
    const id = agent != null ? String(agent) : null
    if (!id || !path || transcripts.has(id)) return
    transcripts.set(id, { path, offset: startAtEof ? sizeOf(path) : 0 })
  }
  function flushTranscripts() {
    for (const [agent, tr] of transcripts) {
      let fd
      try {
        try { fd = openSync(tr.path, 'r') } catch { continue } // not created yet
        const size = fstatSync(fd).size
        if (size < tr.offset) tr.offset = 0 // truncated / rotated
        if (size <= tr.offset) continue // nothing new
        const len = Math.min(size - tr.offset, TRANSCRIPT_CAP)
        const buf = Buffer.allocUnsafe(len)
        const read = readSync(fd, buf, 0, len, tr.offset)
        if (read <= 0) continue
        const from = tr.offset
        tr.offset += read
        // Scrub before blobbing: the pty stream contains the agent's `curl -H "Authorization: Bearer …"` to the
        // control server, so this is the single most likely place a credential lands. Never tape it raw.
        const b = putBlob(scrub(buf.subarray(0, read).toString('utf8')))
        append('model', 'model.io', {
          agent: String(agent),
          source: 'transcript',
          range: { from, to: tr.offset },
          ref: b ? { $blob: b.blobRef, bytes: b.bytes } : undefined
        })
      } catch {
        /* best-effort */
      } finally {
        if (fd != null) try { closeSync(fd) } catch { /* ignore */ }
      }
    }
  }

  return {
    file: () => file,
    dir: () => dir,
    codeVersion,
    // Stream A: an agent action + its effect (the widened tool tap). `agent` = the acting agent (args.agent,
    // or 'human' on localhost, default '0'); `causedBy` = the moments the agent received in its last /events
    // wake (its true cause), falling back to the latest moment seq.
    toolCall(info) {
      const a = info && info.args
      const transport = info && info.transport
      const path = info && info.path
      const agent = a && a.agent != null ? String(a.agent) : transport === 'localhost' ? 'human' : '0'
      if (path === '/events') {
        const r = info && info.result
        const ev = (r && r.events) || (r && r.body && r.body.events)
        if (Array.isArray(ev)) wake[agent] = ev.map((e) => e && e.seq).filter((s) => typeof s === 'number')
      }
      const causedBy = path === '/events' ? [] : wake[agent] && wake[agent].length ? wake[agent] : lastMomentSeq ? [lastMomentSeq] : []
      append('model', 'tool.call', {
        agent,
        decisionId: randomUUID(),
        causedBy,
        transport,
        path,
        ok: !!(info && info.ok),
        ms: info && info.ms,
        status: info && info.status,
        args: clip(scrub(a)),
        result: clipOrBlob(scrub(info && info.result))
      })
    },
    // Stream A: a perception moment as the agent received it (the world half of the model context).
    moment(m) {
      if (m && typeof m.seq === 'number') lastMomentSeq = m.seq
      append('model', 'moment.delivered', {
        agent: m && m.agentId != null ? String(m.agentId) : undefined,
        cursor: lastMomentSeq,
        moment: clip(scrub({
          seq: m && m.seq,
          ts: m && m.ts,
          surfaceId: m && m.surfaceId,
          trigger: m && m.trigger,
          url: m && m.url,
          title: m && m.title,
          signals: m && m.signals,
          user: m && m.user,
          snapshot: m && m.snapshot,
          message: m && m.message,
          windowMs: m && m.windowMs
        }))
      })
    },
    // Stream A: the launch context (bootstrap text, backend/command, session ids, conversation file refs).
    agentSpawn(info) {
      if (info && info.transcriptPath) registerTranscript(info.agent != null ? info.agent : '0', info.transcriptPath, true)
      append('model', 'agent.spawn', {
        agent: info && info.agent != null ? String(info.agent) : '0',
        backend: info && info.backend,
        command: clip(info && info.command),
        cwd: info && info.cwd,
        claudeSessionId: info && info.claudeSessionId,
        agentSessionId: info && info.agentSessionId,
        bootstrap: clip(info && info.bootstrap),
        transcriptRef: info && info.transcriptPath ? { path: info.transcriptPath } : undefined,
        jsonlRef: info && info.jsonlPath ? { path: info.jsonlPath } : undefined
      })
    },
    // Stream C: a renderer or main error (a failure marker). breadcrumbs = the latest moment for context.
    diagError(e) {
      append('diag', 'error', {
        source: (e && e.source) || 'renderer',
        via: e && e.via,
        message: clip(e && e.message),
        stack: clip(e && e.stack),
        surface: e && e.surface,
        breadcrumbs: lastMomentSeq ? [lastMomentSeq] : []
      })
    },
    // Stream B: the user's app state. The small durable files (workspace.json, content, memory) are
    // content-addressed to the blob store (unchanged files dedupe); permissions/bookmarks ride inline.
    // payload = { files: {path: content}, permissions, bookmarks }.
    snapshot(reason, payload) {
      const files = {}
      const src = payload && payload.files
      if (src) for (const name of Object.keys(src)) {
        const content = src[name]
        if (typeof content === 'string') {
          const b = putBlob(scrub(content))
          if (b) files[name] = { $blob: b.blobRef, bytes: b.bytes }
        }
      }
      append('state', 'state.snapshot', {
        reason: reason || 'periodic',
        files,
        permissions: payload && payload.permissions,
        bookmarks: payload && payload.bookmarks
      })
    },
    // Stream B (visual): a window frame (a JPEG/PNG Buffer). Content-addressed, so identical idle frames
    // collapse to one blob. This is the heavy track by design — gate its cadence at the caller.
    frame(image, meta) {
      if (!image) return
      const b = putBlob(image)
      if (b) append('state', 'frame', { ref: { $blob: b.blobRef, bytes: b.bytes }, format: (meta && meta.format) || 'jpeg', w: meta && meta.w, h: meta && meta.h })
    },
    // Register/collect the agent's conversation transcript out-of-band (resumed agents that never hit
    // agentSpawn). flushTranscripts is called on a timer by the host.
    registerTranscript,
    flushTranscripts,
    // Stream C: a structured crash record for the PREVIOUS run (this boot recovered from it). The dirty bit
    // is the truth; detail/at come from the macOS DiagnosticReports scan when available.
    crash(info) {
      append('diag', 'crash', {
        dirty: !!(info && info.dirty),
        concurrent: !!(info && info.concurrent),
        at: info && info.at,
        detail: clip(info && info.detail),
        pid: info && info.pid,
        mode: info && info.mode
      })
    },
    // Stream C: a web surface failed to load (did-fail-load; ERR_ABORTED noise is filtered at the host).
    webFail(info) {
      append('diag', 'web.fail', {
        surfaceId: info && info.surfaceId,
        tabId: info && info.tabId,
        url: clip(info && info.url),
        code: info && info.code,
        desc: clip(info && info.desc),
        breadcrumbs: lastMomentSeq ? [lastMomentSeq] : []
      })
    },
    // Stream C: a guest browser escape decision (a popup classification, or a permission prompt) — content-
    // agnostic, keyed on the KIND of action, never the site (mirrors guest-capabilities.ts).
    guestDecision(info) {
      append('diag', 'guest.decision', {
        subtype: info && info.subtype, // 'popup' | 'permission'
        surfaceId: info && info.surfaceId,
        kind: info && info.kind, // popup: plan.kind (window/hidden/surface/deny)
        url: clip(info && info.url),
        disposition: info && info.disposition,
        features: clip(info && info.features),
        origin: info && info.origin, // permission
        permission: info && info.permission,
        breadcrumbs: lastMomentSeq ? [lastMomentSeq] : []
      })
    }
  }
}
