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
const ESTABLISH_MS = 8000 // mark a Claude agent session "established" after this healthy uptime (persisted)

// Normalize a persisted meta.kind to the current vocabulary. Legacy values are tolerated on read:
// 'pty' → 'terminal', 'chat' → 'agent'. Rewritten to disk on the next writeMeta.
const normalizeKind = (k) => (k === 'agent' || k === 'chat' ? 'agent' : 'terminal')
const isManagedAgent = (m) => m && m.kind === 'agent' && (m.agentRuntime || m.claudeSessionId)
const isClaudeAgent = (m) => m && m.kind === 'agent' && !!m.claudeSessionId && (!m.agentRuntime || m.agentRuntime === 'claude')

// ---- the SINGLE meta.json serializer (module-level, shared) -----------------------------------
// The per-manager closure helpers below delegate to these so there is exactly ONE place that reads/writes a
// terminal's meta.json. job-model.mjs imports them too — a Job rides the SAME meta.json the terminal owns, so it
// reuses this serializer instead of inventing a parallel store (the three-serializer footgun). `terminalsDir` is
// `<workspace>/.blitzos/terminals`; `id` is the agent/terminal id (a uuid or a numeric agent id).
export const terminalMetaDir = (terminalsDir, id) => join(terminalsDir, String(id))
export const terminalMetaPath = (terminalsDir, id) => join(terminalMetaDir(terminalsDir, id), 'meta.json')
/** Read + parse a terminal's meta.json, normalizing kind. Returns null when absent/corrupt. */
export function readTerminalMeta(terminalsDir, id) {
  try {
    const m = JSON.parse(readFileSync(terminalMetaPath(terminalsDir, id), 'utf8'))
    if (m) m.kind = normalizeKind(m.kind)
    return m
  } catch { return null }
}
/** Write a terminal's meta.json (mkdir -p the dir). NOTE: no markWrite here — that workspace-watcher seam is the
 *  manager's concern (writeMeta below adds it); meta.json is not a surface content file, so a direct write (as
 *  job-model and workspace-host's addAgent both do) is fine. */
export function writeTerminalMeta(terminalsDir, id, meta) {
  const dir = terminalMetaDir(terminalsDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(terminalMetaPath(terminalsDir, id), JSON.stringify(meta, null, 2))
}

/** Set or clear the ORCHESTRATORS capability flag on an agent's meta.json (the dynamic-workflows toggle).
 *  Pure (terminalsDir injected) + uses the shared serializer, so it is directly unit-testable. The flag is
 *  durable: the boot-task provider reads it on every (re)launch, and spawnTerminal carries it across re-exec.
 *  Returns { ok, orchestrators } or { ok:false, error } when there is no meta for the id. */
export function setTerminalOrchestrators(terminalsDir, id, on) {
  const meta = readTerminalMeta(terminalsDir, String(id))
  if (!meta) return { ok: false, error: `no agent ${id}` }
  if (on) meta.orchestrators = true
  else delete meta.orchestrators
  writeTerminalMeta(terminalsDir, String(id), meta)
  return { ok: true, orchestrators: !!on }
}

export function createTerminalManager({ host, terminalsDir, emit = () => {}, markWrite = () => {}, rebuildAgentCommand = null }) {
  const live = new Map() // id -> { meta, buf, flushTimer, establishTimer, restartTimer, stopping, unsubData, unsubExit }
  const agentFails = new Map() // id -> consecutive fast-exit count (drives the auto-restart backoff)
  const stopRequested = new Set() // ids a close/stop requested — so a spawn that RACES the stop is aborted
  let shuttingDown = false // set on shutdown so onExit doesn't auto-restart agents as the app quits

  const dirOf = (id) => terminalMetaDir(terminalsDir, id)
  const metaPath = (id) => terminalMetaPath(terminalsDir, id)
  const transcriptPath = (id) => join(dirOf(id), 'transcript.jsonl')
  const readMeta = (id) => readTerminalMeta(terminalsDir, id) // the single module-level serializer (kind-normalizing)
  const publicMeta = (m) => ({
    id: m.id, kind: m.kind, title: m.title, command: m.command, cwd: m.cwd, status: m.status,
    pid: m.pid, exitCode: m.exitCode, autonomy: m.autonomy, createdAt: m.createdAt, endedAt: m.endedAt || null, cols: m.cols, rows: m.rows,
    agentRuntime: m.agentRuntime || (m.claudeSessionId ? 'claude' : null),
    agentSessionId: m.agentSessionId || null
    // (Single-canvas nav: there are no stages, so a terminal has no `stage`/`area`. Legacy persisted
    // meta with a stale `stage`/`area` is simply not surfaced — everything opens at home.)
  })

  function writeMeta(meta) {
    const disk = readMeta(meta.id)
    if (disk?.archived) {
      meta.archived = true
      meta.archivedAt = disk.archivedAt || meta.archivedAt || Date.now()
    } else {
      delete meta.archived
      delete meta.archivedAt
    }
    const dir = dirOf(meta.id)
    markWrite(dir) // tell the workspace watcher this dir write is the OS's own (before the file write)
    writeTerminalMeta(terminalsDir, meta.id, meta) // the single module-level serializer (mkdir + JSON dump)
    markWrite(metaPath(meta.id))
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
    // Mark a Claude agent ESTABLISHED proactively after a healthy run (claude has created its --session-id
    // conversation by then), persisting to disk — so a re-exec after a crash/REBOOT (where the live exit
    // handler never runs, because the agent died while BlitzOS was down) correctly --resumes instead of
    // re-creating an existing id (which claude rejects with "already in use" → a boot crash-loop).
    if (isClaudeAgent(meta) && !meta.claudeEstablished && meta.status === 'running') {
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
        if (isClaudeAgent(meta)) {
          const ranMs = meta.endedAt - (meta.createdAt || meta.endedAt)
          if (ranMs >= 5000) {
            // Ran healthily (≥5s) → it CREATED its --session-id conversation, so the next (re)launch must
            // --resume it, not re-create (the old headless "established-after-5s" rule on the terminal's timing).
            meta.claudeEstablished = true
          } else if (meta.claudeEstablished && !rec.stopping && !shuttingDown && !stopRequested.has(id)) {
            // Launched in --resume mode but FAST-EXITED (and NOT a deliberate stop / app shutdown — those exit fast
            // too, and must NOT cost the agent its conversation): claude almost certainly printed "No conversation found"
            // and quit — the stored session is gone/unresumable (e.g. an old id whose transcript claude has since
            // dropped, or a storage-format change). No STATIC check can predict this (claude's on-disk format
            // varies), so detect it at RUNTIME and ROTATE to a FRESH session id + create mode. The auto-restart
            // below then starts a clean conversation instead of re-failing the same dead resume forever. chat.md
            // is untouched (the bootstrap re-reads it), so the agent keeps its visible history — only claude's
            // in-context memory resets (same effect as the user's "new context" rotate).
            meta.claudeSessionId = randomUUID()
            meta.claudeEstablished = false
          }
        }
        writeMeta(meta)
      }
      try { rec.unsubData && rec.unsubData() } catch { /* ignore */ } // drop the host data listener so the closure + buffer can be GC'd
      rec.buf = []
      emit({ type: 'terminal-exit', id, exitCode, signal })
      // SUPERVISION: a managed chat agent should stay alive. Serverless backends exit after a turn, and a
      // crash also ends them. Auto-restart with a freshly rebuilt command unless it was explicitly stopped
      // or the app is shutting down. Back off on rapid failures so broken auth/config can't hot-loop.
      if (isManagedAgent(meta) && !rec.stopping && !shuttingDown && !stopRequested.has(id)) {
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
      // (Single-canvas nav: no stages. A legacy opts.stage/opts.area is accepted but ignored — not stored.)
      status: 'running', pid: null, exitCode: null, signal: null,
      createdAt: Date.now(), endedAt: null,
      cols: opts.cols || 120, rows: opts.rows || 40,
      // managed agent terminals only: backend runtime metadata. Claude keeps its own --session-id so a
      // re-exec can resume; serverless backends use agentSessionId only for observability/supervision.
      ...(opts.agentRuntime ? { agentRuntime: opts.agentRuntime } : {}),
      ...(opts.agentSessionId ? { agentSessionId: opts.agentSessionId } : {}),
      ...(opts.claudeSessionId ? { claudeSessionId: opts.claudeSessionId } : {}),
      ...(opts.claudeEstablished ? { claudeEstablished: true } : {})
    }
    // Carry forward the ORCHESTRATORS capability flag (the dynamic-workflows toggle): a re-spawn/re-exec
    // rebuilds meta from scratch and must NOT drop it, else the boot-task provider would stop handing the agent
    // its orchestrator duty after the first launch. An explicit opts.orchestrators wins; else inherit on-disk.
    const carriedOrchestrators = opts.orchestrators != null ? opts.orchestrators : readMeta(id)?.orchestrators
    if (carriedOrchestrators) meta.orchestrators = true
    const archivedMeta = readMeta(id)
    if (archivedMeta?.archived) {
      meta.archived = true
      meta.archivedAt = archivedMeta.archivedAt || Date.now()
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
    // A managed BlitzOS AGENT re-execs with a FRESH command (current relay url + backend-specific metadata),
    // not the stale one baked at create. A plain shell or unmanaged agent command re-runs verbatim.
    const rebuilt = (isManagedAgent(meta) && rebuildAgentCommand && rebuildAgentCommand(meta)) || null
    const command = (rebuilt && rebuilt.command) || meta.command
    // A just-created chat writes a lightweight kind:'agent' record before launchAgent overwrites it with the
    // real Claude/Codex command. Restarting that placeholder must not open a plain shell and call it an agent.
    if (meta.kind === 'agent' && !command) return null
    const claudeSessionId = rebuilt ? rebuilt.claudeSessionId : meta.claudeSessionId
    const claudeEstablished = rebuilt ? rebuilt.established : meta.claudeEstablished
    const agentRuntime = rebuilt ? rebuilt.agentRuntime : meta.agentRuntime
    const agentSessionId = rebuilt ? rebuilt.agentSessionId : meta.agentSessionId
    return spawnTerminal({ id, kind: meta.kind, command, cwd: meta.cwd, title: meta.title, autonomy: meta.autonomy, cols: meta.cols, rows: meta.rows, agentRuntime, agentSessionId, claudeSessionId, claudeEstablished })
  }
  /** Clear an AGENT's claude context ON DEMAND (the user's "new context" button) — uniform for EVERY agent,
   *  no primary special-case. Rotate to a FRESH claude session id + mark unestablished, then restart: the
   *  re-exec's rebuildAgentCommand re-derives `--session-id <fresh>` create mode (empty conversation). The
   *  chat.md transcript is UNTOUCHED (the bootstrap re-reads it on boot), so the user's visible history stays
   *  — only claude's in-context memory resets. A plain shell (no claudeSessionId) has no context → no-op. */
  async function clearAgentContext(id) {
    const r = live.get(id)
    const meta = r ? r.meta : readMeta(id)
    if (!meta || meta.kind !== 'agent') return false
    // Rotate whichever session handle this backend uses, then restart so rebuildAgentCommand re-derives a
    // FRESH-context create command. Claude uses claudeSessionId; Codex-serverless uses agentSessionId. A
    // plain shell / unmanaged agent has neither → no context to clear (no-op). Without the Codex branch the
    // job duty-boundary re-exec (approved→running) was a no-op for Codex, landing the EXECUTE duty a launch late.
    if (meta.claudeSessionId) {
      meta.claudeSessionId = randomUUID()
      meta.claudeEstablished = false
    } else if (meta.agentSessionId) {
      meta.agentSessionId = randomUUID()
    } else {
      return false
    }
    writeMeta(meta) // persist the rotated id BEFORE restart so rebuildAgentCommand reads it from disk → create mode
    await restartTerminal(id)
    return true
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
        if (isClaudeAgent(m) && !m.claudeEstablished && (m.endedAt - (m.createdAt || m.endedAt)) >= 5000) m.claudeEstablished = true
      } else m.status = 'running'
      m.pid = li?.pid ?? m.pid ?? null
      writeMeta(m)
      wireTerminal(id, m)
      emit({ type: 'terminal-spawn', id, terminal: publicMeta(m) })
    }
    return adopted
  }

  const scrollback = (id) => host.scrollback(id)
  const capturePane = (id) => host.capture(id) // current rendered pane text (wake watchdog frozen-check)
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

  return { spawnTerminal, sendToTerminal, resizeTerminal, stopTerminal, removeTerminal, restartTerminal, clearAgentContext, restore, scrollback, capturePane, getTerminal, isLive, listTerminals, stopAll, flushAll }
}
