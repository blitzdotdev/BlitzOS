// session-manager.mjs — N file-backed sessions over the tmux host. This generalizes the single
// brain into many peer sessions (shells, coding agents, runners); none privileged. It pairs tmux's
// LIVE persistence (a window survives a BlitzOS restart) with a DURABLE workspace record:
//   <workspace>/.blitzos/sessions/<id>/{meta.json, transcript.jsonl}
// On boot, restore() adopts tmux windows that survived AND re-reads their meta, so a session comes
// back fully (live process + history) — nothing about a session lives outside the workspace folder.
//
// Shared core: both transports bind it with their own seams (the only differences): the tmux `host`,
// the `sessionsDir`, `emit` (server: SSE broadcast; Electron: webContents.send), and `markWrite`
// (tell the workspace watcher a write is the OS's own so it doesn't reconcile itself).
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TRANSCRIPT_FLUSH_MS = 500 // batch tmux %output so a chatty program doesn't fsync per chunk
const ESTABLISH_MS = 8000 // mark an agent's claude session "established" after this healthy uptime (persisted)

export function createSessionManager({ host, sessionsDir, emit = () => {}, markWrite = () => {}, rebuildAgentCommand = null }) {
  const live = new Map() // id -> { meta, buf, flushTimer, unsubData, unsubExit }

  const dirOf = (id) => join(sessionsDir, id)
  const metaPath = (id) => join(dirOf(id), 'meta.json')
  const transcriptPath = (id) => join(dirOf(id), 'transcript.jsonl')
  const readMeta = (id) => { try { return JSON.parse(readFileSync(metaPath(id), 'utf8')) } catch { return null } }
  const publicMeta = (m) => ({
    id: m.id, kind: m.kind, title: m.title, command: m.command, cwd: m.cwd, status: m.status,
    pid: m.pid, exitCode: m.exitCode, autonomy: m.autonomy, createdAt: m.createdAt, endedAt: m.endedAt || null, cols: m.cols, rows: m.rows,
    // The workspace area this terminal belongs to (the spawning chat session's area). Persisted so a
    // restart restores an agent's terminal into its area. null = unscoped (a human spawn) → the renderer
    // opens it in the current area, today's behavior.
    area: Number.isInteger(m.area) ? m.area : null
  })

  function writeMeta(meta) {
    const dir = dirOf(meta.id)
    mkdirSync(dir, { recursive: true }); markWrite(dir)
    writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2)); markWrite(metaPath(meta.id))
  }
  function flushTranscript(id) {
    const rec = live.get(id)
    if (!rec || !rec.buf.length) return
    const chunk = rec.buf.join(''); rec.buf = []
    try { appendFileSync(transcriptPath(id), JSON.stringify({ at: Date.now(), data: chunk }) + '\n'); markWrite(transcriptPath(id)) } catch { /* best-effort */ }
  }

  // Subscribe a session's tmux streams to the transcript + the renderer, with the review fixes baked in.
  function wireSession(id, meta) {
    // Idempotent: tear down any prior live rec for this id first, so a re-wire (re-spawn / restore)
    // can't leak the old host listeners or duplicate the session-data stream to the renderer.
    const prev = live.get(id)
    if (prev) {
      try { prev.unsubData && prev.unsubData(); prev.unsubExit && prev.unsubExit() } catch { /* ignore */ }
      if (prev.flushTimer) { clearTimeout(prev.flushTimer); prev.flushTimer = null }
      if (prev.establishTimer) { clearTimeout(prev.establishTimer); prev.establishTimer = null }
    }
    const rec = { meta, buf: [], flushTimer: null, establishTimer: null, unsubData: null, unsubExit: null }
    live.set(id, rec)
    // Mark an agent ESTABLISHED proactively after a healthy run (claude has created its --session-id
    // conversation by then), persisting to disk — so a re-exec after a crash/REBOOT (where the live exit
    // handler never runs, because the agent died while BlitzOS was down) correctly --resumes instead of
    // re-creating an existing id (which claude rejects with "already in use" → a boot crash-loop).
    if (meta.kind === 'agent' && !meta.claudeEstablished && meta.status === 'running') {
      rec.establishTimer = setTimeout(() => {
        rec.establishTimer = null
        if (live.get(id) === rec && meta.status === 'running' && !meta.claudeEstablished) { meta.claudeEstablished = true; writeMeta(meta) }
      }, ESTABLISH_MS)
    }
    rec.unsubData = host.onData(id, (data) => {
      rec.buf.push(data)
      if (!rec.flushTimer) rec.flushTimer = setTimeout(() => { rec.flushTimer = null; flushTranscript(id) }, TRANSCRIPT_FLUSH_MS)
      emit({ type: 'session-data', id, data })
    }, { replay: false })
    rec.unsubExit = host.onExit(id, ({ exitCode, signal }) => {
      if (live.get(id) !== rec) return // a stale exit (restarted/removed id) must NOT clobber the live session
      if (rec.flushTimer) { clearTimeout(rec.flushTimer); rec.flushTimer = null }
      if (rec.establishTimer) { clearTimeout(rec.establishTimer); rec.establishTimer = null }
      flushTranscript(id)
      if (meta.status === 'running') {
        meta.status = 'exited'; meta.exitCode = exitCode; meta.signal = signal; meta.endedAt = Date.now()
        // A BlitzOS claude that ran healthily (≥5s) has CREATED its --session-id conversation, so the next
        // (re)launch must --resume it, not re-create. Record that here (the old headless supervisor's
        // "established-after-5s" rule, re-homed onto the tmux session's own exit timing).
        if (meta.kind === 'agent' && (meta.endedAt - (meta.createdAt || meta.endedAt)) >= 5000) meta.claudeEstablished = true
        writeMeta(meta)
      }
      try { rec.unsubData && rec.unsubData() } catch { /* ignore */ } // drop the host data listener so the closure + buffer can be GC'd
      rec.buf = []
      emit({ type: 'session-exit', id, exitCode, signal })
    })
    return rec
  }

  /** Spawn a session. opts: { kind, command, args, cwd, env, cols, rows, title, autonomy, id? } */
  async function spawnSession(opts = {}) {
    await host.start()
    const id = opts.id || randomUUID()
    const meta = {
      id,
      kind: opts.kind === 'agent' ? 'agent' : 'pty',
      title: opts.title || (opts.command ? String(opts.command).slice(0, 48) : 'shell'),
      command: opts.command || null,
      cwd: opts.cwd || null,
      autonomy: opts.autonomy || 'auto',
      area: Number.isInteger(opts.area) ? opts.area : null, // the spawning chat session's area; null = human spawn → current area
      status: 'running', pid: null, exitCode: null, signal: null,
      createdAt: Date.now(), endedAt: null,
      cols: opts.cols || 120, rows: opts.rows || 40,
      // agent sessions only: the persisted claude --session-id token + whether claude has established it
      // (so a re-exec --resumes the SAME conversation). Carried through restarts so continuity survives.
      ...(opts.claudeSessionId ? { claudeSessionId: opts.claudeSessionId } : {}),
      ...(opts.claudeEstablished ? { claudeEstablished: true } : {})
    }
    // Replace any existing window for this id first (idempotent for a fresh id) — so a re-spawn/re-exec
    // (boot resume of a survivor with a now-stale relay url) cleanly REPLACES it instead of leaving a
    // duplicate window (tmux allows same-named windows). A prior live rec is torn down by wireSession below.
    try { host.remove(id) } catch { /* no such window — fine */ }
    const info = await host.spawn(id, { command: opts.command, cwd: opts.cwd, env: opts.env, cols: meta.cols, rows: meta.rows })
    if (!info) return null // spawn rejected (illegal control char in a field, or the control client died)
    meta.pid = info.pid ?? null
    writeMeta(meta)
    wireSession(id, meta)
    emit({ type: 'session-spawn', id, session: publicMeta(meta) })
    return publicMeta(meta)
  }

  const sendToSession = (id, data) => host.write(id, String(data ?? ''))
  function resizeSession(id, cols, rows) {
    const r = live.get(id); if (r) { r.meta.cols = cols; r.meta.rows = rows }
    return host.resize(id, cols, rows)
  }
  function stopSession(id) {
    host.kill(id)
    const r = live.get(id)
    if (r && r.meta.status === 'running') { r.meta.status = 'stopped'; r.meta.endedAt = Date.now(); writeMeta(r.meta) }
    emit({ type: 'session-stop', id })
    return true
  }
  /** Re-spawn a session from its persisted meta (an `agent` that ended, or a manual restart). */
  async function restartSession(id) {
    const r = live.get(id)
    const meta = r ? r.meta : readMeta(id)
    if (!meta) return null
    if (r) { try { r.unsubData && r.unsubData(); r.unsubExit && r.unsubExit() } catch { /* ignore */ } live.delete(id) }
    host.remove(id)
    // A BlitzOS CHAT agent (it carries a claudeSessionId) re-execs with a FRESH command (current relay url +
    // --resume), not the stale one baked at create. A plain shell — or a generic spawn_session kind:'agent'
    // with its own command (no claudeSessionId) — re-runs its original command verbatim.
    const command = (meta.kind === 'agent' && meta.claudeSessionId && rebuildAgentCommand && rebuildAgentCommand(meta)) || meta.command
    return spawnSession({ id, kind: meta.kind, command, cwd: meta.cwd, title: meta.title, autonomy: meta.autonomy, cols: meta.cols, rows: meta.rows, area: meta.area, claudeSessionId: meta.claudeSessionId, claudeEstablished: meta.claudeEstablished })
  }

  /** Reattach-on-boot: adopt tmux windows that SURVIVED a restart, re-read their meta, re-wire streams. */
  async function restore() {
    const adopted = await host.adoptExisting()
    for (const id of adopted) {
      if (live.has(id)) continue
      const m = readMeta(id) || { id, kind: 'pty', title: id, command: null, cwd: null, autonomy: 'auto', createdAt: Date.now(), endedAt: null, exitCode: null, cols: 120, rows: 40 }
      const li = host.info(id)
      if (li?.exited) {
        m.status = 'exited'; m.exitCode = li.exitCode ?? m.exitCode ?? null; m.endedAt = m.endedAt || Date.now()
        // An adopted-then-exited agent that clearly ran a full session is established → a later re-exec
        // must --resume (same rule as the live exit handler, applied here since that handler didn't run).
        if (m.kind === 'agent' && !m.claudeEstablished && (m.endedAt - (m.createdAt || m.endedAt)) >= 5000) m.claudeEstablished = true
      } else m.status = 'running'
      m.pid = li?.pid ?? m.pid ?? null
      writeMeta(m)
      wireSession(id, m)
      emit({ type: 'session-spawn', id, session: publicMeta(m) })
    }
    return adopted
  }

  const scrollback = (id) => host.scrollback(id)
  const getSession = (id) => { const r = live.get(id); if (r) return publicMeta(r.meta); const m = readMeta(id); return m ? publicMeta(m) : null }
  // ACTUALLY live = wired to a tmux window in THIS run (a survivor adopted by restore(), or a fresh spawn).
  // Distinct from getSession().status, which is a stale 'running' on disk for a session that died while the
  // app was down — boot resume uses this so a died-while-down agent is re-exec'd, not skipped.
  const isLive = (id) => live.has(id)

  /** All sessions: live (in-memory) merged with persisted-but-dead ones from disk (survive a restart). */
  function listSessions() {
    const out = new Map()
    for (const [id, r] of live) out.set(id, publicMeta(r.meta))
    try {
      for (const d of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!d.isDirectory() || out.has(d.name)) continue
        const m = readMeta(d.name)
        if (m) out.set(d.name, publicMeta({ ...m, status: m.status === 'running' ? 'exited' : m.status })) // a persisted "running" with no live record is dead
      }
    } catch { /* no sessions dir yet */ }
    return [...out.values()]
  }

  function stopAll() { for (const id of live.keys()) host.kill(id) }
  // Flush every live session's pending transcript buffer NOW (e.g. on app shutdown, before the 500ms timer).
  function flushAll() { for (const [id, r] of live) { if (r.flushTimer) { clearTimeout(r.flushTimer); r.flushTimer = null } if (r.establishTimer) { clearTimeout(r.establishTimer); r.establishTimer = null } flushTranscript(id) } }

  return { spawnSession, sendToSession, resizeSession, stopSession, restartSession, restore, scrollback, getSession, isLive, listSessions, stopAll, flushAll }
}
