// session-manager.mjs — many file-backed sessions over the PTY host. This GENERALIZES the
// single-brain agent-runner (one supervised process) into N peer sessions: shells, coding
// agents (`claude`/`codex` in a PTY), build/test runners — each its own session, all equal,
// none privileged. The current brain becomes just one `agent` session.
//
// THE WORKSPACE IS THE ONLY DATASOURCE: every session's metadata + transcript live UNDER the
// active workspace at `<workspace>/.blitzos/sessions/<id>/{meta.json, transcript.jsonl}` —
// nothing in RAM-only, ~/.blitzos, /tmp, or the Keychain. On restart the manager re-lists prior
// sessions from those files.
//
// Shared core: both transports bind it with their own platform seams (the only differences):
//   ptyHost   — the shared PTY primitive (pty-host.mjs)
//   sessionsDir — <workspace>/.blitzos/sessions (from the workspace host)
//   emit(ev)  — publish a session event to the renderer (server: SSE broadcast; Electron: webContents.send)
//   markWrite(path) — tell the workspace watcher "this write is mine" so it doesn't reconcile itself
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TRANSCRIPT_FLUSH_MS = 500 // batch PTY chunks so a chatty program doesn't fsync per keystroke

/**
 * @param {{ ptyHost:import('./pty-host.d.mts').PtyHost, sessionsDir:string,
 *           emit?:(ev:object)=>void, markWrite?:(path:string)=>void }} deps
 */
export function createSessionManager({ ptyHost, sessionsDir, emit = () => {}, markWrite = () => {} }) {
  const live = new Map() // id -> { meta, buf, flushTimer, unsub }

  const dirOf = (id) => join(sessionsDir, id)
  const metaPath = (id) => join(dirOf(id), 'meta.json')
  const transcriptPath = (id) => join(dirOf(id), 'transcript.jsonl')

  const publicMeta = (m) => ({
    id: m.id, kind: m.kind, title: m.title, command: m.command, cwd: m.cwd,
    status: m.status, pid: m.pid, exitCode: m.exitCode, autonomy: m.autonomy,
    createdAt: m.createdAt, endedAt: m.endedAt || null, cols: m.cols, rows: m.rows
  })

  function writeMeta(meta) {
    const dir = dirOf(meta.id)
    mkdirSync(dir, { recursive: true }); markWrite(dir)
    const p = metaPath(meta.id)
    writeFileSync(p, JSON.stringify(meta, null, 2)); markWrite(p)
  }
  function flushTranscript(id) {
    const rec = live.get(id)
    if (!rec || !rec.buf.length) return
    const chunk = rec.buf.join(''); rec.buf = []
    try { appendFileSync(transcriptPath(id), JSON.stringify({ at: Date.now(), data: chunk }) + '\n'); markWrite(transcriptPath(id)) } catch { /* best-effort */ }
  }

  /** Spawn a session. opts: { kind, command, args, cwd, env, cols, rows, title, autonomy, id? } */
  function spawnSession(opts = {}) {
    const id = opts.id || randomUUID()
    const meta = {
      id,
      kind: opts.kind === 'agent' ? 'agent' : 'pty',
      title: opts.title || (opts.command ? String(opts.command).slice(0, 48) : 'shell'),
      command: opts.command || null,
      cwd: opts.cwd || null,
      autonomy: opts.autonomy || 'auto', // policy hook for later (auto | checkpoint | dry-run)
      status: 'running', pid: null, exitCode: null, signal: null,
      createdAt: Date.now(), endedAt: null,
      cols: opts.cols || 80, rows: opts.rows || 24
    }
    const info = ptyHost.spawn(id, {
      command: opts.command, args: opts.args, cwd: opts.cwd, env: opts.env, cols: meta.cols, rows: meta.rows
    })
    meta.pid = info.pid
    writeMeta(meta)

    const rec = { meta, buf: [], flushTimer: null, unsub: null }
    live.set(id, rec)

    rec.unsub = ptyHost.onData(id, (data) => {
      rec.buf.push(data)
      if (!rec.flushTimer) rec.flushTimer = setTimeout(() => { rec.flushTimer = null; flushTranscript(id) }, TRANSCRIPT_FLUSH_MS)
      emit({ type: 'session-data', id, data })
    }, { replay: false })

    ptyHost.onExit(id, ({ exitCode, signal }) => {
      if (rec.flushTimer) { clearTimeout(rec.flushTimer); rec.flushTimer = null }
      flushTranscript(id)
      if (meta.status === 'running') meta.status = 'exited'
      meta.exitCode = exitCode; meta.signal = signal; meta.endedAt = Date.now()
      writeMeta(meta)
      emit({ type: 'session-exit', id, exitCode, signal })
    })

    emit({ type: 'session-spawn', id, session: publicMeta(meta) })
    return publicMeta(meta)
  }

  const sendToSession = (id, data) => ptyHost.write(id, String(data ?? ''))
  function resizeSession(id, cols, rows) {
    const r = live.get(id); if (r) { r.meta.cols = cols; r.meta.rows = rows }
    return ptyHost.resize(id, cols, rows)
  }
  function stopSession(id) {
    ptyHost.kill(id)
    const r = live.get(id)
    if (r && r.meta.status === 'running') { r.meta.status = 'stopped'; r.meta.endedAt = Date.now(); writeMeta(r.meta) }
    emit({ type: 'session-stop', id })
    return true
  }
  /** Re-spawn a session from its persisted meta (for an `agent` session that ended, or a manual restart). */
  function restartSession(id) {
    const r = live.get(id)
    const meta = r ? r.meta : readMeta(id)
    if (!meta) return null
    if (r) { try { r.unsub && r.unsub() } catch { /* ignore */ } live.delete(id) }
    ptyHost.remove(id)
    return spawnSession({ id, kind: meta.kind, command: meta.command, cwd: meta.cwd, title: meta.title, autonomy: meta.autonomy, cols: meta.cols, rows: meta.rows })
  }

  /** Live scrollback for a (re)connecting terminal surface to repaint — mirrors screencast lastFrame replay. */
  const scrollback = (id) => ptyHost.scrollback(id)
  const getSession = (id) => { const r = live.get(id); return r ? publicMeta(r.meta) : readMeta(id) && publicMeta(readMeta(id)) }

  function readMeta(id) { try { return JSON.parse(readFileSync(metaPath(id), 'utf8')) } catch { return null } }

  /** All sessions: live (in-memory) merged with persisted-but-dead ones from disk (survive a restart). */
  function listSessions() {
    const out = new Map()
    for (const [id, r] of live) out.set(id, publicMeta(r.meta))
    try {
      for (const d of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!d.isDirectory() || out.has(d.name)) continue
        const m = readMeta(d.name)
        if (m) out.set(d.name, publicMeta({ ...m, status: m.status === 'running' ? 'exited' : m.status })) // a persisted "running" with no live pty is dead
      }
    } catch { /* no sessions dir yet */ }
    return [...out.values()]
  }

  function stopAll() { for (const id of live.keys()) ptyHost.kill(id) }

  return { spawnSession, sendToSession, resizeSession, stopSession, restartSession, scrollback, getSession, listSessions, stopAll }
}
