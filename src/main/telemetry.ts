// Session telemetry → blitzos-telemetry.app.blitz.dev (plans/blitzos-telemetry.md).
//
// The feedback-loop instrument: capture enough to REPLAY a session (visually + machinery) with the
// simplest possible moving parts. Local append-only JSONL spool (crash-safe by construction) +
// a 30s uploader (gzip segment → /ingest/segments) + a low-fps capturePage JPEG track (the window
// compositor includes webviews — this IS the screen recording) → /ingest/frames.
//
// What flows through ONE line each at existing choke points:
//   act    every os:action broadcast (surface mutations, chat, terminal output, action items…)
//   state  throttled full-desktop keyframe (the renderer's os:state push)
//   tool   every agent tool call (path, ms, status — the AI's hands)
//   moment every perception moment (the AI's eyes)
//   err    console.error/warn + uncaught exceptions/rejections
//
// Enabled ONLY when ~/.blitzos/telemetry.json exists ({url, key}); BLITZ_TELEMETRY=0 kills it.
// Frames skipped while the window is hidden. Outbox capped by FILE COUNT (oldest dropped, loudly) —
// a byte cap meant statSync-ing every file on the main thread each cycle, which froze the UI at scale.
import { app, BrowserWindow } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { gzipSync } from 'zlib'
import { join } from 'path'
import { homedir } from 'os'
import { setToolTap } from './os-tools.mjs'
import { setMomentTap } from './events'

interface Cfg {
  url: string
  key: string
}

const MAX_LINE = 8 * 1024 // a single huge broadcast (chat thread, terminal burst) must not bloat the stream
const SEGMENT_MS = 30_000
const SEGMENT_BYTES = 512 * 1024
const FRAME_MS = 4_000
// Outbox bound by FILE COUNT, not bytes: enforcing a byte cap meant statSync-ing EVERY file in the
// outbox on the MAIN thread each ship cycle, which froze the UI once the spool grew to ~11k files
// (300MB) while shipping was down — input forwarding stalls behind a blocked main in the sandwich.
// readdir already gives the count for free. Frames are downscaled to ~30-45KB and segments are
// <512KB, so ~4000 files keeps the spool well under a few hundred MB with no O(N) synchronous stat.
const MAX_OUTBOX_FILES = 4000

let cfg: Cfg | null = null
let sid = ''
let dir = ''
let spool = ''
let seq = 0
let t0 = 0
let lines = 0
let sessionPosted = false
let getWin: () => BrowserWindow | null = () => null

function now(): number {
  return Date.now()
}

// Bulk-bearing acts (reconcile/hydrate/switch) carry the ENTIRE surface array with props/html —
// one line blew the 8KB cap into a truncated string on every watcher blip (the VM diff showed
// 456/465 acts mutilated). Replay needs their LAYOUT; content fidelity comes from the individual
// create/update/chat acts, which stay verbatim.
const LAYOUT_KEYS = ['id', 'kind', 'component', 'role', 'x', 'y', 'w', 'h', 'z', 'title', 'url', 'slot', 'groupId', 'pinned', 'sessionId', 'focus'] as const
function compactAct(d: unknown): unknown {
  const a = d as { type?: unknown; surfaces?: unknown[]; messages?: unknown[] }
  if (!a || typeof a !== 'object') return d
  const t = String(a.type || '')
  // chat rebroadcasts carry the WHOLE thread each time — keep the delta (the appended message);
  // successive deltas reconstruct the thread, and chat.md remains the authoritative transcript.
  if (t === 'chat' && Array.isArray(a.messages) && a.messages.length) {
    const last = a.messages[a.messages.length - 1] as Record<string, unknown>
    return { ...a, compact: true, n: a.messages.length, messages: [{ ...last, text: String(last?.text ?? '').slice(0, 2000) }] }
  }
  if (!Array.isArray(a.surfaces)) return d
  if (t !== 'reconcile' && t !== 'hydrate' && t !== 'switch') return d
  return {
    ...a,
    compact: true,
    surfaces: a.surfaces.map((s) => {
      const src = s as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of LAYOUT_KEYS) if (src[k] !== undefined) out[k] = src[k]
      return out
    })
  }
}

/** The capture tap — safe to call from anywhere in main; a no-op until initTelemetry enables it. */
export function tel(ty: string, data: unknown): void {
  if (!cfg) return
  try {
    if (ty === 'act') data = compactAct(data)
    let s = JSON.stringify({ t: now(), ty, d: data })
    if (s.length > MAX_LINE && data && typeof data === 'object') {
      // still oversized after type-aware compaction (e.g. a terminal-output burst): cap every long
      // top-level string field so the line stays a PARSEABLE OBJECT, never an opaque sliced string
      const a = data as Record<string, unknown>
      const capped: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(a)) capped[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v
      s = JSON.stringify({ t: now(), ty, capped: true, d: capped })
    }
    if (s.length > MAX_LINE) s = JSON.stringify({ t: now(), ty, trunc: true, kind: String((data as { type?: unknown })?.type ?? ''), size: s.length })
    if (!lines) t0 = now()
    lines++
    appendFileSync(spool, s + '\n')
    if (statSync(spool).size > SEGMENT_BYTES) rotate()
  } catch {
    /* telemetry must never break the app */
  }
}

function rotate(): void {
  if (!lines) return
  try {
    const out = join(dir, 'outbox', `${String(seq).padStart(6, '0')}-${t0}-${now()}-${lines}.jsonl`)
    renameSync(spool, out)
    seq++
    lines = 0
  } catch {
    /* keep spooling into the same file */
  }
}

async function post(path: string, values: Record<string, unknown>, file?: { buf: Buffer; type: string }): Promise<boolean> {
  if (!cfg) return false
  try {
    const form = new FormData()
    form.set('values', JSON.stringify(values))
    if (file) form.set('file', new Blob([new Uint8Array(file.buf)], { type: file.type }), 'f')
    const res = await fetch(`${cfg.url}/ingest/${path}`, { method: 'POST', headers: { 'x-ingest-key': cfg.key }, body: form })
    return res.ok
  } catch {
    return false
  }
}

async function shipOutbox(): Promise<void> {
  if (!cfg) return
  rotate()
  if (!sessionPosted) {
    sessionPosted = await post('sessions', { sid, device: deviceId(), version: app.getVersion(), branch: build().branch, run: build().run, platform: process.platform, meta: { arch: process.arch } })
    if (!sessionPosted) return // backend unreachable — try again next tick, keep spooling locally
  }
  const ob = join(dir, 'outbox')
  let names: string[] = []
  try {
    names = readdirSync(ob).sort()
  } catch {
    return
  }
  // cap: drop oldest beyond the budget so a long offline stretch can't fill the disk. names is
  // sorted and every filename is seq/timestamp-prefixed, so shifting from the front drops oldest
  // first. Count-only — NO per-file statSync (see MAX_OUTBOX_FILES). Bounded loop, runs only when
  // over cap, so once trimmed each cycle does a single readdir and no stat at all.
  // TODO: if a precise byte budget is ever needed, track outbox bytes incrementally (add on
  // frame/segment write, subtract on ship/drop) rather than re-statting the directory.
  while (names.length > MAX_OUTBOX_FILES) {
    const n = names.shift() as string
    try {
      rmSync(join(ob, n))
      console.error('[telemetry] outbox over cap — dropped', n)
    } catch {
      /* ignore */
    }
  }
  for (const n of names) {
    const p = join(ob, n)
    try {
      if (n.startsWith('frame-')) {
        const t = Number(n.split('-')[1]) || now()
        if (await post('frames', { sid, t }, { buf: readFileSync(p), type: 'image/jpeg' })) rmSync(p)
        else break
      } else {
        const [s, a, b, l] = n.replace('.jsonl', '').split('-')
        const txt = readFileSync(p, 'utf8')
        // per-type counts + first error excerpts, computed at ship time from the plaintext (no spool
        // state to track; works for crash tails too) — the backend keeps session aggregates from these
        const counts: Record<string, number> = {}
        const errs: { t: number; m: string }[] = []
        for (const ln of txt.split('\n')) {
          if (!ln) continue
          try {
            const e = JSON.parse(ln) as { t: number; ty: string; d?: { m?: unknown } }
            counts[e.ty] = (counts[e.ty] || 0) + 1
            if (e.ty === 'err' && errs.length < 10) errs.push({ t: e.t, m: String(e.d?.m ?? '').slice(0, 300) })
          } catch {
            counts.raw = (counts.raw || 0) + 1
          }
        }
        const gz = gzipSync(txt)
        if (await post('segments', { sid, seq: Number(s), t0: Number(a), t1: Number(b), lines: Number(l), counts, errs }, { buf: gz, type: 'application/gzip' })) rmSync(p)
        else break // keep order; retry from here next tick
      }
    } catch {
      break
    }
  }
}


function deviceId(): string {
  try {
    const out = require('child_process').execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }) as string
    return out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-F-]+)"/i)?.[1]?.slice(0, 8) || 'unknown'
  } catch {
    return 'unknown'
  }
}

function build(): { branch: string; run: number } {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { buildBranch?: string; buildRun?: number }
    return { branch: pkg.buildBranch || 'dev', run: pkg.buildRun || 0 }
  } catch {
    return { branch: 'dev', run: 0 }
  }
}

let lastFrame: Buffer = Buffer.alloc(0)
async function captureFrame(): Promise<void> {
  const win = getWin()
  if (!cfg || !win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return
  try {
    const img = await win.webContents.capturePage()
    // 900px/q35: frames are the storage budget (~30-45MB per ACTIVE hour at the old 1100/q55) and
    // replay only needs "what was the user doing", not pixel fidelity. Measured ~3x smaller.
    const jpg = img.resize({ width: 900 }).toJPEG(35)
    if (jpg.length === lastFrame.length && jpg.equals(lastFrame)) return // idle screen — don't re-ship identical frames
    lastFrame = jpg
    writeFileSync(join(dir, 'outbox', `frame-${now()}.jpg`), jpg)
  } catch {
    /* never break the app */
  }
}

/** Wire capture + shipping. Call once after the window exists. Disabled without the config file. */
export function initTelemetry(getWindow: () => BrowserWindow | null): void {
  if (process.env.BLITZ_TELEMETRY === '0') return
  try {
    cfg = JSON.parse(readFileSync(join(homedir(), '.blitzos', 'telemetry.json'), 'utf8')) as Cfg
    if (!cfg.url || !cfg.key) {
      cfg = null
      return
    }
  } catch {
    return // no config = telemetry off (the default)
  }
  getWin = getWindow
  sid = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`
  dir = join(app.getPath('userData'), 'telemetry')
  spool = join(dir, 'spool.jsonl')
  mkdirSync(join(dir, 'outbox'), { recursive: true })
  if (existsSync(spool)) {
    // a previous run's tail (crash) — rotate it into the outbox under a fresh segment name
    try {
      renameSync(spool, join(dir, 'outbox', `000000-${now() - 1}-${now()}-0.jsonl`))
    } catch {
      /* ignore */
    }
  }
  writeFileSync(spool, '')
  console.log(`[telemetry] on — sid ${sid} → ${cfg.url}`)

  // the AI's hands: every tool call across every transport (os-tools shared registry hook)
  setToolTap((info: unknown) => tel('tool', info))
  // the AI's eyes: every perception moment (snapshot dropped — it's huge and reconstructable from acts;
  // trigger/signals/user-lines are what replay needs to show what woke the agent and why)
  setMomentTap((m) => {
    const mm = m as { seq?: unknown; trigger?: unknown; surfaceId?: unknown; url?: unknown; title?: unknown; windowMs?: unknown; signals?: unknown; user?: unknown; sessionId?: unknown; message?: unknown }
    tel('moment', { seq: mm.seq, trigger: mm.trigger, surfaceId: mm.surfaceId, url: mm.url, title: mm.title, windowMs: mm.windowMs, signals: mm.signals, user: mm.user, sessionId: mm.sessionId, message: typeof mm.message === 'string' ? mm.message.slice(0, 500) : undefined })
  })
  // errors: console + process level
  const origErr = console.error.bind(console)
  console.error = (...a: unknown[]) => {
    try {
      tel('err', { via: 'console', m: a.map((x) => String((x as Error)?.stack || x)).join(' ').slice(0, 2000) })
    } catch {
      /* ignore */
    }
    origErr(...a)
  }
  process.on('uncaughtException', (e) => tel('err', { via: 'uncaught', m: String(e?.stack || e).slice(0, 2000) }))
  process.on('unhandledRejection', (e) => tel('err', { via: 'rejection', m: String((e as Error)?.stack || e).slice(0, 2000) }))

  setInterval(() => void captureFrame(), FRAME_MS)
  setInterval(() => void shipOutbox(), SEGMENT_MS)
  setTimeout(() => void shipOutbox(), 8000) // first ship soon after boot (session row + crash tail)
  app.on('before-quit', () => rotate())
  tel('boot', { version: app.getVersion(), ...build(), platform: process.platform })
}
