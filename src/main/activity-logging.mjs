// Privacy-safe product activity logging.
//
// This is intentionally separate from session replay telemetry. It only accepts an allowlisted set of
// product events and aggressively reduces props to enums, booleans, counts, buckets, and salted hashes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

const CONFIG_FILE = join(homedir(), '.blitzos', 'activity-logging.json')
const INSTALL_FILE = join(homedir(), '.blitzos', 'activity-install-id')
const SEGMENT_BYTES = 128 * 1024
const FLUSH_MS = 15_000
const MAX_OUTBOX_FILES = 1000
const MAX_EVENTS_PER_BATCH = 500

export const ACTIVITY_EVENT_NAMES = new Set([
  'app.started',
  'app.focused',
  'app.quit',
  'island.opened',
  'island.closed',
  'island.view_changed',
  'settings.opened',
  'onboarding.step_viewed',
  'onboarding.completed',
  'agent.spawned',
  'agent.selected',
  'agent.status_changed',
  'agent.archived',
  'agent.restored',
  'agent.deleted',
  'agent.renamed',
  'chat.message_sent',
  'choice.shown',
  'choice.answered',
  'app_card.opened',
  'app_card.closed',
  'connector.picker_opened',
  'connector.connected',
  'connector.disconnected',
  'tool.called'
])

const STATUS = new Set(['idle', 'starting', 'working', 'watching', 'waiting', 'stopped', 'error', 'unknown'])
const VIEW = new Set(['home', 'settings', 'session', 'onboarding', 'process', 'app'])
const ONBOARDING_STEP = new Set(['intro', 'permissions', 'browser', 'done'])
const CONNECTOR_KIND = new Set(['browser_tab', 'mac_window', 'browser_extension', 'unknown'])
const SOURCE = new Set([
  'renderer',
  'main',
  'notch',
  'chat',
  'terminal',
  'workflow',
  'user-message',
  'archive',
  'restore',
  'ask',
  'say',
  'say-final',
  'claude-end-turn',
  'tool',
  'unknown'
])

let cfg = null
let sessionId = ''
let installId = ''
let dir = ''
let spool = ''
let seq = 0
let lines = 0
let t0 = 0
let meta = { version: '0', branch: 'dev', run: 0, platform: process.platform, channel: 'development' }

function now() {
  return Date.now()
}

function safeToken(value, allowed) {
  const s = String(value || '').trim()
  if (!s) return undefined
  if (allowed && allowed.has(s)) return s
  return /^[a-zA-Z0-9_.:-]{1,64}$/.test(s) ? s : undefined
}

function safeBool(value) {
  return typeof value === 'boolean' ? value : undefined
}

function safeCount(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(1000, Math.round(n))) : undefined
}

function lengthBucket(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n <= 80) return '1-80'
  if (n <= 280) return '81-280'
  if (n <= 1000) return '281-1000'
  return '1001+'
}

function msBucket(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return undefined
  if (n < 100) return '<100ms'
  if (n < 500) return '100-500ms'
  if (n < 2000) return '500ms-2s'
  if (n < 10000) return '2s-10s'
  return '10s+'
}

function hashValue(value, salt) {
  const s = String(value || '')
  if (!s) return undefined
  return createHash('sha256').update(String(salt || 'activity')).update(':').update(s).digest('hex').slice(0, 16)
}

function safeTool(value) {
  const s = String(value || '').trim()
  if (!/^\/[a-z][a-z0-9_/-]{0,79}$/i.test(s)) return undefined
  return s.replace(/\/+/g, '/')
}

export function sanitizeActivityEvent(name, props = {}, opts = {}) {
  const eventName = String(name || '').trim()
  if (!ACTIVITY_EVENT_NAMES.has(eventName)) return null
  const input = props && typeof props === 'object' ? props : {}
  const salt = opts.salt || installId || 'activity'
  const out = {}

  const agent = input.agentId ?? input.agent
  const agentHash = hashValue(agent, salt)
  if (agentHash) out.agentIdHash = agentHash

  const status = safeToken(input.status, STATUS)
  if (status) out.status = status
  const previousStatus = safeToken(input.previousStatus, STATUS)
  if (previousStatus) out.previousStatus = previousStatus

  const view = safeToken(input.view, VIEW)
  if (view) out.view = view
  const previousView = safeToken(input.previousView, VIEW)
  if (previousView) out.previousView = previousView
  const step = safeToken(input.step, ONBOARDING_STEP)
  if (step) out.step = step

  const source = safeToken(input.source, SOURCE) || (input.source ? 'unknown' : undefined)
  if (source) out.source = source

  const connectorKind = safeToken(input.connectorKind ?? input.kind, CONNECTOR_KIND)
  if (connectorKind) out.connectorKind = connectorKind

  const tool = safeTool(input.tool ?? input.path)
  if (tool) out.tool = tool

  const ok = safeBool(input.ok)
  if (ok !== undefined) out.ok = ok
  const success = safeBool(input.success)
  if (success !== undefined) out.success = success
  const enabled = safeBool(input.enabled)
  if (enabled !== undefined) out.enabled = enabled
  const hasAttachments = safeBool(input.hasAttachments)
  if (hasAttachments !== undefined) out.hasAttachments = hasAttachments

  if (input.count !== undefined) out.count = safeCount(input.count)
  if (input.total !== undefined) out.total = safeCount(input.total)
  if (input.attachmentCount !== undefined) out.attachmentCount = safeCount(input.attachmentCount)
  if (input.statusCode !== undefined) out.statusCode = safeCount(input.statusCode)

  if (input.messageLength !== undefined) out.messageLengthBucket = lengthBucket(input.messageLength)
  if (input.durationMs !== undefined) out.durationBucket = msBucket(input.durationMs)
  if (input.ms !== undefined) out.msBucket = msBucket(input.ms)

  return { name: eventName, props: out }
}

export function sanitizeToolActivity(info, opts = {}) {
  const i = info && typeof info === 'object' ? info : {}
  return sanitizeActivityEvent('tool.called', {
    tool: i.path,
    ok: i.ok,
    statusCode: i.status,
    ms: i.ms,
    source: 'tool'
  }, opts)
}

function ensureInstallId() {
  try {
    mkdirSync(join(homedir(), '.blitzos'), { recursive: true })
    if (existsSync(INSTALL_FILE)) {
      const existing = readFileSync(INSTALL_FILE, 'utf8').trim()
      if (/^[0-9a-f-]{16,80}$/i.test(existing)) return existing
    }
    const id = randomUUID()
    writeFileSync(INSTALL_FILE, id, { mode: 0o600 })
    return id
  } catch {
    return `ephemeral-${randomUUID()}`
  }
}

function rotate() {
  if (!lines || !spool) return
  try {
    const out = join(dir, 'outbox', `${String(seq).padStart(6, '0')}-${t0}-${now()}-${lines}.jsonl`)
    renameSync(spool, out)
    seq++
    lines = 0
    writeFileSync(spool, '')
  } catch {
    /* keep spooling */
  }
}

async function postBatch(events) {
  if (!cfg || !events.length) return false
  try {
    const res = await fetch(`${cfg.url}/ingest/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-key': cfg.key },
      body: JSON.stringify({
        sid: sessionId,
        install: installId,
        version: meta.version,
        branch: meta.branch,
        run: meta.run,
        channel: meta.channel,
        platform: meta.platform,
        t0: events[0]?.t || now(),
        t1: events[events.length - 1]?.t || now(),
        events
      })
    })
    return res.ok
  } catch {
    return false
  }
}

async function shipOutbox() {
  if (!cfg || !dir) return
  rotate()
  const ob = join(dir, 'outbox')
  let names = []
  try {
    names = readdirSync(ob).sort()
  } catch {
    return
  }
  while (names.length > MAX_OUTBOX_FILES) {
    const n = names.shift()
    try { rmSync(join(ob, n)) } catch { /* ignore */ }
  }
  for (const n of names) {
    const p = join(ob, n)
    try {
      const events = []
      for (const ln of readFileSync(p, 'utf8').split('\n')) {
        if (!ln || events.length >= MAX_EVENTS_PER_BATCH) continue
        try {
          const e = JSON.parse(ln)
          if (e && ACTIVITY_EVENT_NAMES.has(e.name)) events.push(e)
        } catch {
          /* skip corrupt line */
        }
      }
      if (!events.length || await postBatch(events)) rmSync(p)
      else break
    } catch {
      break
    }
  }
}

export function trackActivity(name, props = {}) {
  if (!cfg || !spool) return
  try {
    const clean = sanitizeActivityEvent(name, props, { salt: installId })
    if (!clean) return
    const rec = { t: now(), ...clean }
    if (!lines) t0 = rec.t
    lines++
    appendFileSync(spool, JSON.stringify(rec) + '\n')
    if (statSync(spool).size > SEGMENT_BYTES) rotate()
  } catch {
    /* activity logging must never affect the app */
  }
}

export function trackToolActivity(info) {
  const clean = sanitizeToolActivity(info, { salt: installId })
  if (clean) trackActivity(clean.name, clean.props)
}

export function initActivityLogging(opts = {}) {
  if (process.env.BLITZ_ACTIVITY_LOGGING === '0') return false
  // Config sources, first valid wins: (1) a local ~/.blitzos/activity-logging.json (operator/dev override), then
  // (2) opts.bundledConfigPath — the build-bundled config CI injects from a repo secret (Contents/Resources in a
  // packaged app). Absent in local/fork builds (no secret set) → cfg stays null → analytics simply OFF. The key
  // baked into the bundle is a WRITE-ONLY ingest key (the /ingest/activity x-ingest-key); it is extractable from the
  // public binary, so it must NEVER be a broad account/app token — only an ingest credential you can rotate.
  cfg = null
  for (const p of [opts.configPath || CONFIG_FILE, opts.bundledConfigPath]) {
    if (!p) continue
    try {
      const c = JSON.parse(readFileSync(p, 'utf8'))
      if (c && c.url && c.key) { cfg = c; break }
    } catch { /* unreadable/missing/empty — try the next source */ }
  }
  if (!cfg) return false
  // Everything below touches the filesystem (install-id read/write, mkdir, spool write). This runs at app BOOT
  // (index.ts calls it inside app.whenReady), and the bundled config now makes it reach here on EVERY install — so
  // an unwritable userData dir (disk full, root-owned from a prior sudo, read-only volume) would throw UNCAUGHT and
  // skip the rest of boot (onboarding, the ⌥Space shortcut, the control server, connections) — a hard brick from a
  // non-essential analytics subsystem. Guard the whole setup: any failure → disable activity logging, never throw.
  try {
    installId = ensureInstallId()
    sessionId = `act-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`
    meta = {
      version: String(opts.appVersion || '0'),
      branch: String(opts.branch || 'dev'),
      run: Number(opts.run) || 0,
      channel: safeToken(opts.channel, new Set(['production', 'preview', 'development'])) || 'development',
      platform: process.platform
    }
    dir = join(String(opts.userDataDir || join(homedir(), '.blitzos')), 'activity-logging')
    spool = join(dir, 'spool.jsonl')
    mkdirSync(join(dir, 'outbox'), { recursive: true })
    if (existsSync(spool)) {
      try { renameSync(spool, join(dir, 'outbox', `000000-${now() - 1}-${now()}-0.jsonl`)) } catch { /* ignore */ }
    }
    writeFileSync(spool, '')
    const interval = setInterval(() => void shipOutbox(), Number(opts.flushMs) || FLUSH_MS)
    if (typeof interval.unref === 'function') interval.unref()
    const initial = setTimeout(() => void shipOutbox(), 3000)
    if (typeof initial.unref === 'function') initial.unref()
    trackActivity('app.started', { source: 'main' })
    return true
  } catch {
    cfg = null // setup failed (unwritable userData, etc.) → stay OFF; boot must continue unharmed
    return false
  }
}

export function flushActivityLogging() {
  rotate()
  return shipOutbox()
}
