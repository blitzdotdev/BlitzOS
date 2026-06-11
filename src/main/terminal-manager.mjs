// terminal-manager.mjs — N file-backed terminals over the tmux host. This generalizes the single
// brain into many peer terminals (shells, coding agents, runners); none privileged. It pairs tmux's
// LIVE persistence (a window survives a BlitzOS restart) with a DURABLE workspace record:
//   <workspace>/.blitzos/terminals/<id>/{meta.json, transcript.jsonl}
// On boot, restore() adopts tmux windows that survived AND re-reads their meta, so a terminal comes
// back fully (live process + history) — nothing about a terminal lives outside the workspace folder.
//
// Shared core: both transports bind it with their own seams (the only differences): the tmux `host`,
// the `terminalsDir`, `emit` (server: SSE broadcast; Electron: webContents.send), and `markWrite`
// (tell the workspace watcher a write is the OS's own so it doesn't reconcile itself).
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TRANSCRIPT_FLUSH_MS = 500 // batch tmux %output so a chatty program doesn't fsync per chunk
const ESTABLISH_MS = 8000 // mark an agent's claude session "established" after this healthy uptime (persisted)

// Normalize a persisted meta.kind to the current vocabulary. Legacy values are tolerated on read:
// 'pty' → 'terminal', 'chat' → 'agent'. Rewritten to disk on the next writeMeta.
const normalizeKind = (k) => (k === 'agent' || k === 'chat' ? 'agent' : 'terminal')

export function createTerminalManager({ host, terminalsDir, emit = () => {}, markWrite = () => {}, rebuildAgentCommand = null }) {
  const live = new Map() // id -> { meta, buf, flushTimer, establishTimer, restartTimer, stopping, unsubData, unsubExit }
  const agentFails = new Map() // id -> consecutive fast-exit count (drives the auto-restart backoff)
  const stopRequested = new Set() // ids a close/stop requested — so a spawn that RACES the stop is aborted
  let shuttingDown = false // set on shutdown so onExit doesn't auto-restart agents as the app quits

  const dirOf = (id) => join(terminalsDir, id)
  const metaPath = (id) => join(dirOf(id), 'meta.json')
  const transcriptPath = (id) => join(dirOf(id), 'transcript.jsonl')
  const readMeta = (id) => { try { const m = JSON.parse(readFileSync(metaPath(id), 'utf8')); if (m) m.kind = normalizeKind(m.kind); return m } catch { return null } }
  const publicMeta = (m) => ({
    id: m.id, kind: m.kind, title: m.title, command: m.command, cwd: m.cwd, status: m.status,
    pid: m.pid, exitCode: m.exitCode, autonomy: m.autonomy, createdAt: m.createdAt, endedAt: m.endedAt || null, cols: m.cols, rows: m.rows,
    // The workspace area this terminal belongs to (the spawning agent's area). Persisted so a
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

  // Subscribe a terminal's tmux streams to the transcript + the renderer, with the review fixes baked in.
  function wireTerminal(id, meta) {
    // Idempotent: tear down any prior live rec for this id first, so a re-wire (re-spawn / restore)
    // can't leak the old host listeners or duplicate the terminal-data stream to the renderer.
    const prev = live.get(id)
    if (prev) {
      try { prev.unsubData && prev.unsubData(); prev.unsubExit && prev.unsubExit() } catch { /* ignore */ }
      if (prev.flushTimer) { clearTimeout(prev.flushTimer); prev.flushTimer = null }
      if (prev.establishTimer) { clearTimeout(prev.establishTimer); prev.establishTimer = null }
      if (prev.restartTimer) { clearTimeout(prev.restartTimer); prev.restartTimer = null }
    }
    const rec = { meta, buf: [], flushTimer: null, establishTimer: null, restartTimer: null, stopping: false, unsubData: null, unsubExit: null }
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
      emit({ type: 'terminal-data', id, data })
    }, { replay: false })
    rec.unsubExit = host.onExit(id, ({ exitCode, signal }) => {
      if (live.get(id) !== rec) return // a stale exit (restarted/removed id) must NOT clobber the live terminal
      if (rec.flushTimer) { clearTimeout(rec.flushTimer); rec.flushTimer = null }
      if (rec.establishTimer) { clearTimeout(rec.establishTimer); rec.establishTimer = null }
      flushTranscript(id)
      if (meta.status === 'running') {
        meta.status = 'exited'; meta.exitCode = exitCode; meta.signal = signal; meta.endedAt = Date.now()
        // A BlitzOS claude that ran healthily (≥5s) has CREATED its --session-id conversation, so the next
        // (re)launch must --resume it, not re-create. Record that here (the old headless supervisor's
        // "established-after-5s" rule, re-homed onto the terminal's own exit timing).
        if (meta.kind === 'agent' && (meta.endedAt - (meta.createdAt || meta.endedAt)) >= 5000) meta.claudeEstablished = true
        writeMeta(meta)
      }
      try { rec.unsubData && rec.unsubData() } catch { /* ignore */ } // drop the host data listener so the closure + buffer can be GC'd
      rec.buf = []
      emit({ type: 'terminal-exit', id, exitCode, signal })
      // SUPERVISION: a chat agent should stay alive. `claude -p` exits when its turn ends (even code 0 — it
      // set up the loop then stopped calling tools), and a crash also ends it. Auto-restart it (--resume keeps
      // the conversation; the relay-url file gives the live url), UNLESS it was explicitly stopped or we're
      // shutting down. Back off on rapid failures so a broken agent (auth, etc.) can't hot-loop.
      if (meta.kind === 'agent' && meta.claudeSessionId && !rec.stopping && !shuttingDown && !stopRequested.has(id)) {
        const ranMs = (meta.endedAt || Date.now()) - (meta.createdAt || meta.endedAt)
        const fails = ranMs < 15000 ? (agentFails.get(id) || 0) + 1 : 0 // a healthy (≥15s) run resets the backoff
        agentFails.set(id, fails)
        const backoff = fails === 0 ? 1500 : Math.min(2000 * 2 ** fails, 60000)
        rec.restartTimer = setTimeout(() => { if (!shuttingDown && live.get(id) === rec && !stopRequested.has(id)) restartTerminal(id).catch(() => {}) }, backoff)
      }
    })
    return rec
  }

  /** Spawn a terminal. opts: { kind, command, args, cwd, env, cols, rows, title, autonomy, id? } */
  async function spawnTerminal(opts = {}) {
    const id = opts.id || randomUUID()
    stopRequested.delete(id) // a deliberate (re)spawn supersedes any earlier stop intent for this id
    await host.start()
    const meta = {
      id,
      kind: opts.kind === 'agent' ? 'agent' : 'terminal',
      title: opts.title || (opts.command ? String(opts.command).slice(0, 48) : 'shell'),
      command: opts.command || null,
      cwd: opts.cwd || null,
      autonomy: opts.autonomy || 'auto',
      area: Number.isInteger(opts.area) ? opts.area : null, // the spawning agent's area; null = human spawn → current area
      status: 'running', pid: null, exitCode: null, signal: null,
      createdAt: Date.now(), endedAt: null,
      cols: opts.cols || 120, rows: opts.rows || 40,
      // agent terminals only: the persisted claude --session-id token + whether claude has established it
      // (so a re-exec --resumes the SAME conversation). Carried through restarts so continuity survives.
      ...(opts.claudeSessionId ? { claudeSessionId: opts.claudeSessionId } : {}),
      ...(opts.claudeEstablished ? { claudeEstablished: true } : {})
    }
    // Replace any existing window for this id first (idempotent for a fresh id) — so a re-spawn/re-exec
    // (boot resume of a survivor with a now-stale relay url) cleanly REPLACES it instead of leaving a
    // duplicate window (tmux allows same-named windows). A prior live rec is torn down by wireTerminal below.
    try { host.remove(id) } catch { /* no such window — fine */ }
    const info = await host.spawn(id, { command: opts.command, cwd: opts.cwd, env: opts.env, cols: meta.cols, rows: meta.rows })
    if (!info) return null // spawn rejected (illegal control char in a field, or the control client died)
    // A close/stop landed DURING our (multi-tick) spawn — e.g. a flapping agent's auto-restart was already
    // in-flight when closeAgent ran. Honor the stop: kill the just-spawned window so a closed terminal
    // can't resurrect alongside its now-deleted files. (Cleared at the top for a deliberate re-spawn.)
    if (stopRequested.has(id)) { try { host.remove(id) } catch { /* gone */ } return null }
    meta.pid = info.pid ?? null
    writeMeta(meta)
    wireTerminal(id, meta)
    emit({ type: 'terminal-spawn', id, terminal: publicMeta(meta) })
    return publicMeta(meta)
  }

  const sendToTerminal = (id, data) => host.write(id, String(data ?? ''))
  function resizeTerminal(id, cols, rows) {
    const r = live.get(id); if (r) { r.meta.cols = cols; r.meta.rows = rows }
    return host.resize(id, cols, rows)
  }
  function stopTerminal(id) {
    stopRequested.add(id) // record intent even if there's no live rec yet — aborts a spawn racing this stop
    const r = live.get(id)
    if (r) { r.stopping = true; if (r.restartTimer) { clearTimeout(r.restartTimer); r.restartTimer = null } } // explicit stop ⇒ do NOT auto-restart
    agentFails.delete(id)
    host.kill(id)
    if (r && r.meta.status === 'running') { r.meta.status = 'stopped'; r.meta.endedAt = Date.now(); writeMeta(r.meta) }
    emit({ type: 'terminal-stop', id })
    return true
  }
  /** Permanently FORGET a terminal: kill it if live, then delete its persisted dir + in-memory record so it
   *  stops appearing in the tray (a plain shell becomes dead-but-resumable on stop; remove is how you prune it).
   *  NEVER the primary agent ('0'). The id-shape guard blocks path traversal (ids are uuids or numeric). */
  function removeTerminal(id) {
    if (id === '0' || !/^[a-zA-Z0-9_-]+$/.test(String(id))) return false // primary is never removable; reject unsafe ids
    const r = live.get(id)
    if (r) {
      r.stopping = true
      if (r.restartTimer) { clearTimeout(r.restartTimer); r.restartTimer = null }
      try { r.unsubData && r.unsubData(); r.unsubExit && r.unsubExit() } catch { /* ignore */ }
      live.delete(id)
    }
    stopRequested.add(id)
    agentFails.delete(id)
    try { host.kill(id) } catch { /* may already be dead */ }
    try { host.remove(id) } catch { /* ignore */ }
    try { rmSync(dirOf(id), { recursive: true, force: true }); markWrite(dirOf(id)) } catch { /* best-effort */ }
    emit({ type: 'terminal-stop', id })
    return true
  }
  /** Re-spawn a terminal from its persisted meta (an `agent` that ended, or a manual restart). */
  async function restartTerminal(id) {
    const r = live.get(id)
    const meta = r ? r.meta : readMeta(id)
    if (!meta) return null
    if (r) { try { r.unsubData && r.unsubData(); r.unsubExit && r.unsubExit() } catch { /* ignore */ } live.delete(id) }
    host.remove(id)
    // A BlitzOS AGENT (it carries a claudeSessionId) re-execs with a FRESH command (current relay url +
    // --resume), not the stale one baked at create. A plain shell — or a generic spawnTerminal kind:'agent'
    // with its own command (no claudeSessionId) — re-runs its original command verbatim.
    const command = (meta.kind === 'agent' && meta.claudeSessionId && rebuildAgentCommand && rebuildAgentCommand(meta)) || meta.command
    return spawnTerminal({ id, kind: meta.kind, command, cwd: meta.cwd, title: meta.title, autonomy: meta.autonomy, cols: meta.cols, rows: meta.rows, area: meta.area, claudeSessionId: meta.claudeSessionId, claudeEstablished: meta.claudeEstablished })
  }

  /** Reattach-on-boot: adopt tmux windows that SURVIVED a restart, re-read their meta, re-wire streams. */
  async function restore() {
    const adopted = await host.adoptExisting()
    for (const id of adopted) {
      if (live.has(id)) continue
      const m = readMeta(id) || { id, kind: 'terminal', title: id, command: null, cwd: null, autonomy: 'auto', createdAt: Date.now(), endedAt: null, exitCode: null, cols: 120, rows: 40 }
      const li = host.info(id)
      if (li?.exited) {
        m.status = 'exited'; m.exitCode = li.exitCode ?? m.exitCode ?? null; m.endedAt = m.endedAt || Date.now()
        // An adopted-then-exited agent that clearly ran a full session is established → a later re-exec
        // must --resume (same rule as the live exit handler, applied here since that handler didn't run).
        if (m.kind === 'agent' && !m.claudeEstablished && (m.endedAt - (m.createdAt || m.endedAt)) >= 5000) m.claudeEstablished = true
      } else m.status = 'running'
      m.pid = li?.pid ?? m.pid ?? null
      writeMeta(m)
      wireTerminal(id, m)
      emit({ type: 'terminal-spawn', id, terminal: publicMeta(m) })
    }
    return adopted
  }

  const scrollback = (id) => host.scrollback(id)
  const getTerminal = (id) => { const r = live.get(id); if (r) return publicMeta(r.meta); const m = readMeta(id); return m ? publicMeta(m) : null }
  // ACTUALLY live = wired to a tmux window in THIS run (a survivor adopted by restore(), or a fresh spawn).
  // Distinct from getTerminal().status, which is a stale 'running' on disk for a terminal that died while the
  // app was down — boot resume uses this so a died-while-down agent is re-exec'd, not skipped.
  const isLive = (id) => live.has(id)

  /** All terminals: live (in-memory) merged with persisted-but-dead ones from disk (survive a restart). */
  function listTerminals() {
    const out = new Map()
    for (const [id, r] of live) out.set(id, publicMeta(r.meta))
    try {
      for (const d of readdirSync(terminalsDir, { withFileTypes: true })) {
        if (!d.isDirectory() || out.has(d.name)) continue
        const m = readMeta(d.name)
        if (m) out.set(d.name, publicMeta({ ...m, status: m.status === 'running' ? 'exited' : m.status })) // a persisted "running" with no live record is dead
      }
    } catch { /* no terminals dir yet */ }
    return [...out.values()]
  }

  function stopAll() { shuttingDown = true; for (const id of live.keys()) host.kill(id) }
  // Flush every live terminal's pending transcript buffer NOW (e.g. on app shutdown, before the 500ms timer).
  // Also stop supervising (no auto-restart as we tear down) + cancel any pending timers.
  function flushAll() {
    shuttingDown = true
    for (const [id, r] of live) {
      if (r.flushTimer) { clearTimeout(r.flushTimer); r.flushTimer = null }
      if (r.establishTimer) { clearTimeout(r.establishTimer); r.establishTimer = null }
      if (r.restartTimer) { clearTimeout(r.restartTimer); r.restartTimer = null }
      flushTranscript(id)
    }
  }

  return { spawnTerminal, sendToTerminal, resizeTerminal, stopTerminal, removeTerminal, restartTerminal, restore, scrollback, getTerminal, isLive, listTerminals, stopAll, flushAll }
}
