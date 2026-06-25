#!/usr/bin/env node
// onboarding-scan.mjs — BlitzOS onboarding bootstrap (T3.2): scan the user's LOCAL macOS
// footprint and emit ONE markdown doc to prime the onboarding interview, so it asks
// high-information questions instead of obvious ones.
//
// TWO BRANCHES, keyed on ONE permission gate (Full Disk Access):
//   • Branch B (always, zero prompts): AI sessions, browsers, Spotlight, shell, git,
//     editors, installed apps/dock, downloads, locale.
//   • Branch A (additionally, iff FDA): Messages, Mail, knowledgeC app-usage, Notes,
//     Safari, configured Accounts.
//
// PRINCIPLES: local-only (no network), read-only (SQLite copied + opened immutable),
// the ONLY permission prompt is FDA, secrets hard-excluded + redacted, comms summary-only
// unless --comms-content. Contacts: handles are joined to "First L." names via the local
// AddressBook (so the people picture is human); handles with NO AddressBook match stay hashed.
// Zero npm deps — shells out to macOS binaries.
//
// USAGE: node scripts/onboarding-scan.mjs [--out PATH|-] [--prompt FILE]
//   [--no-fda|--assume-fda] [--comms-content] [--notes-bodies] [--window 90]
//   [--budget 4200] [--halflife 21] [--max-domains 20] [--max-apps 20] [--max-files 20]
//   [--max-sessions 28] [--no-verbatim] [--stochastic] [--quiet]
//   [--json PATH|-] [--progress]
// Default --out: ~/.blitzos/fs/journal/onboarding-context.md
//
// --json PATH   additionally write the distilled view as structured JSON (same sections,
//               same redaction/caps as the markdown — for the onboarding board + agents).
// --progress    emit machine-readable `@progress {json}` lines on stderr (per-source
//               start/done + phases) so a host (the BlitzOS boot screen) can show real stages.

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, copyFileSync, rmSync, openSync, readSync, closeSync, accessSync, constants } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HOME = homedir()
const DAY = 86_400_000
const MAC2001 = 978_307_200, WIN1601 = 11_644_473_600
const LO = Date.UTC(2007, 0, 1), HI = Date.now() + DAY

// ---- self-check: this tool must never touch the network -------------------------------
try {
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  if (/from\s+['"]node:https?['"]|require\(\s*['"]https?['"]\s*\)|\bfetch\s*\(/.test(self)) {
    process.stderr.write('FATAL: network primitive detected in a local-only tool.\n'); process.exit(2)
  }
} catch { /* can't read self → skip the guard */ }

// ---- config (all overridable via CLI) ------------------------------------------------
const CFG = {
  halflifeDays: 21, recentFull: 8, maxSessions: 28, firstK: 2, lastK: 2,
  tokenBudget: 4200, perPromptMaxChars: 320,
  windowDays: 90, maxDomains: 20, maxApps: 20, maxFiles: 20,
  topProjects: 14, topEntities: 24, topDirectives: 24, voiceSamples: 8,
  verbatim: true, stochastic: false, quiet: false,
  commsContent: false, notesBodies: false, fda: null /* null=detect, true/false=override */,
  promptFile: null, json: null, progress: false, openTabs: null,
  out: join(HOME, '.blitzos', 'fs', 'journal', 'onboarding-context.md')
}
function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // consume the next token as this flag's value; tolerate a missing/another-flag value
    const nx = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) { log(`! ${a} expects a value — ignoring (e.g. did you mean \`--out -\` for stdout?)`); return undefined } i++; return v }
    const str = (set) => { const v = nx(); if (v !== undefined) set(v) }
    const num = (set) => { const v = nx(); if (v !== undefined && !isNaN(+v)) set(+v) }
    if (a === '--out') str((v) => { CFG.out = v })
    else if (a === '--json') str((v) => { CFG.json = v })
    else if (a === '--progress') CFG.progress = true
    else if (a === '--prompt') str((v) => { CFG.promptFile = v })
    else if (a === '--open-tabs') str((v) => { CFG.openTabs = v })
    else if (a === '--budget') num((v) => { CFG.tokenBudget = v })
    else if (a === '--halflife') num((v) => { CFG.halflifeDays = v })
    else if (a === '--window') num((v) => { CFG.windowDays = v })
    else if (a === '--max-domains') num((v) => { CFG.maxDomains = v })
    else if (a === '--max-apps') num((v) => { CFG.maxApps = v })
    else if (a === '--max-files') num((v) => { CFG.maxFiles = v })
    else if (a === '--max-sessions') num((v) => { CFG.maxSessions = v })
    else if (a === '--no-fda') CFG.fda = false
    else if (a === '--assume-fda') CFG.fda = true
    else if (a === '--comms-content') CFG.commsContent = true
    else if (a === '--notes-bodies') CFG.notesBodies = true
    else if (a === '--no-verbatim') CFG.verbatim = false
    else if (a === '--stochastic') CFG.stochastic = true
    else if (a === '--quiet') CFG.quiet = true
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
  }
}
function printHelp() {
  process.stdout.write([
    'onboarding-scan.mjs — scan your local macOS footprint into ONE markdown doc to prime BlitzOS onboarding.',
    '',
    'QUICK START (from the agent-os repo):',
    '  npm run onboard        # Branch B: zero setup, no permissions',
    '  npm run onboard:fda    # Branch A+B: richer; needs Full Disk Access granted to your terminal',
    '  npm run onboard:scan   # just the scanned context (no onboarding prompt)',
    '',
    'DIRECT:',
    '  node scripts/onboarding-scan.mjs [--no-fda|--assume-fda] --prompt src/main/blitzos-onboarding.md --out -',
    '',
    'FLAGS:',
    '  --out PATH|-      file path, or - for stdout (default: ~/.blitzos/fs/journal/onboarding-context.md)',
    '  --prompt FILE     prepend an onboarding prompt above the scan (one combined doc)',
    '  --open-tabs PATH  fold a captured live-open-tabs snapshot (pre-board Automation) into the web signal',
    '  --no-fda          skip Full-Disk-Access sources (Branch B only)',
    '  --assume-fda      force Branch A sources on',
    '  --comms-content   include verbatim Messages/Mail text (default: summary-only)',
    '  --window N        lookback days for history/usage (default 90)',
    '  --json PATH|-     also write the distilled view as structured JSON (board/agent input)',
    '  --progress        emit @progress {json} stage lines on stderr (for a host UI)',
    '  --quiet           suppress progress logs',
    '',
    'Local-only, read-only, secrets excluded, contacts hashed. macOS only. See plans/ONBOARDING-FLOW.md.',
    ''
  ].join('\n'))
}
const log = (...a) => { if (!CFG.quiet) process.stderr.write(a.join(' ') + '\n') }
// Machine-readable stage lines for a host UI (one JSON object per line, prefixed so a
// reader can split them from human logs on the same stderr stream).
const emitProgress = (obj) => { if (CFG.progress) process.stderr.write('@progress ' + JSON.stringify(obj) + '\n') }

// ---- security: files we NEVER open, and in-text redaction ----------------------------
const SECRET_RE = /(^|[._-])(auth|credentials?|secret|token|env|global-state)\b|\bLogin Data\b|\bCookies\b|\bWeb Data\b|\blogins\.json\b|\bkey[34]\.db\b|\.(pem|key|p12|keychain|keychain-db)$|(^|\/)\.env|(^|\/)id_(rsa|ed25519|ecdsa|dsa)\b|\.aws\/credentials|gh\/hosts\.yml/i
const REDACTORS = [
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted-slack]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws]'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9._-]{20,}\b/g, '[redacted-jwt]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/(?<!\d)(\+?\d[\d ().-]{7,}\d)(?!\d)/g, (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m)]
]
const TRIVIAL_RE = /^(y|n|yes|no|ok(ay)?|go( on)?|cont(inue)?|next|fix( it)?|do it|run( it)?|thx|thanks?|thank you|ty|yep|yeah|sure|please|k|proceed|nice|cool|good|done|wait|hm+|\?+|!+|\.+)$/i
const PREF_RE = /\b(always|never|from now on|going forward|in (the )?future|prefer|i (really )?(like|want|need|hate|don'?t (like|want))|make sure|ensure|by default|remember to|avoid|instead of|stick to|do not ever|don'?t ever)\b/i
const CORRECTION_RE = /\b(no[,.]|nope|don'?t|do not|stop|that'?s (wrong|not)|incorrect|actually|instead|revert|undo|not what i|i (said|told you|asked)|you (keep|always|still)|why (did|are) you|that broke|messed up|you forgot)\b/i
const DOMAIN_KW = ['react', 'vue', 'svelte', 'next.js', 'nextjs', 'typescript', 'javascript', 'python', 'rust', 'golang', ' go ', 'swift', 'kotlin', 'java', 'c++', 'cloudflare', 'workers', 'd1', 'r2', 'kv', 'sqlite', 'postgres', 'supabase', 'electron', 'three.js', 'threepipe', 'webgl', 'shader', 'ios', 'android', 'tailwind', 'docker', 'kubernetes', 'terraform', 'llm', 'agent', 'rag', 'embedding', 'fine-tun', 'pytorch', 'tensorflow', 'cuda', 'poker', 'trading', 'crypto', 'stripe', 'oauth', 'auth', 'api', 'sql', 'graphql', 'redis', 'kafka', 'wasm']
const STOPWORDS = new Set(('the a an and or but if then this that these those i you it we they he she of to in on at for with from by as is are was were be been being do does did done have has had can could would should will shall may might must not no yes so just like get got make made use used add fix run try want need also into out up down over under more most some any all what which who when where why how please thanks ok now new old file code function const let var class import export return null true false error test app data text line type value name id url http https com www localhost build work works working project projects hello hi hey greet greeting today opened show shows check create created still there your help thing things change update message prompt pasted using based way good great nice okay really first next last let lets going actually able sure org net html www2 read right only same about after phone email redacted contact send pull push branch master commit merge user users write issue open store them screen plan page chat search again changes other link running thing stuff find show give move keep start build done set').split(' '))

// ---- text utilities ------------------------------------------------------------------
function redact(s) { let t = String(s ?? ''); for (const [re, rep] of REDACTORS) t = t.replace(re, rep); return t }
function stripCode(s) {
  return String(s ?? '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/`[^`]{40,}`/g, ' [code] ').replace(/\s+/g, ' ').trim()
}
function clean(s) {
  return redact(stripCode(s))
    .replace(/\[(pasted text|image|attachment|screenshot)[^\]]*\]/gi, ' ')
    .replace(/\s*\+\s*\d+\s+lines?\b/gi, ' ').replace(/\s+/g, ' ').trim()
}
function clamp(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s }
function normKey(s) { return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80) }
function isTrivial(s) { const t = String(s ?? '').trim(); return t.length < 3 || TRIVIAL_RE.test(t) || t.startsWith('/') }
function recencyWeight(ts, now) { return Math.pow(2, -((now - ts) / DAY) / CFG.halflifeDays) }
function toks(s) { return (clean(s).toLowerCase().match(/[a-z][a-z0-9.+#_-]{2,}/g) || []).map((t) => t.replace(/^[.\-_]+|[.\-_]+$/g, '')).filter((t) => t.length >= 3) }

// ---- timestamp epochs (the landmine — coerce + sanity-check) --------------------------
const inWindow = (ms) => ms >= LO && ms <= HI
function toUnixMs(raw) {
  const n = Number(raw); if (!isFinite(n) || n <= 0) return 0
  for (const ms of [n * 1000, n, (n + MAC2001) * 1000, (n / 1e9 + MAC2001) * 1000, (n / 1e6 - WIN1601) * 1000, (n / 1e6) * 1000]) if (inWindow(ms)) return ms
  return 0
}
const cf2001 = (raw) => { const ms = (Number(raw) + MAC2001) * 1000; return inWindow(ms) ? ms : toUnixMs(raw) }
const chromeTime = (raw) => { const ms = (Number(raw) / 1e6 - WIN1601) * 1000; return inWindow(ms) ? ms : toUnixMs(raw) }
const firefoxTime = (raw) => { const ms = (Number(raw) / 1e6) * 1000; return inWindow(ms) ? ms : toUnixMs(raw) }
const messagesTime = (raw) => { const n = Number(raw); const ms = n > 1e15 ? (n / 1e9 + MAC2001) * 1000 : (n + MAC2001) * 1000; return inWindow(ms) ? ms : toUnixMs(raw) }

// ---- system-binary infra (arg arrays only, timeouts, never a shell string) -----------
function sh(bin, args, { timeout = 15_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout, maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch { return '' }
}
// Copy db (+wal,+shm) to temp, query an IMMUTABLE copy, clean up. Never opens the original.
function sqliteQuery(dbPath, sql) {
  if (!existsSync(dbPath) || SECRET_RE.test(basename(dbPath))) return []
  const dir = mkdtempSync(join(tmpdir(), 'blitz-'))
  try {
    const copy = join(dir, 'db')
    copyFileSync(dbPath, copy)
    for (const ext of ['-wal', '-shm']) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, copy + ext)
    const out = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', `file:${copy}?immutable=1`, sql],
      { encoding: 'utf8', timeout: 20_000, maxBuffer: 96 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim() ? JSON.parse(out) : []
  } catch (e) { log(`  · sqlite skip ${basename(dbPath)} (${e.code || (e.message || '').slice(0, 40)})`); return [] }
  finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}
function plistJson(path) {
  if (!existsSync(path) || SECRET_RE.test(basename(path))) return null
  const out = sh('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { timeout: 8000 })
  if (!out) return null
  try { return JSON.parse(out) } catch { return null }
}
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }
function searchQuery(u) {
  try { const url = new URL(u)
    if (/(^|\.)(google\.|bing\.com|duckduckgo\.com|ecosia\.org|kagi\.com)/.test(url.hostname) && /\/search|^\/$|\/html/.test(url.pathname)) {
      const q = url.searchParams.get('q'); if (q && q.trim().length > 2) return clean(q)
    }
  } catch {} return null
}
// Apple Notes bodies are gzipped protobuf — gunzip (zero-dep) + pull printable text runs.
function gunzipText(hex) {
  try { const out = gunzipSync(Buffer.from(String(hex), 'hex')).toString('utf8'); return (out.match(/[\x20-\x7e]{4,}/g) || []).join(' ') } catch { return '' }
}
// Push a descriptive page title as an aggregate topic signal (deduped, noise-filtered, capped).
function addTitle(ctx, seen, title, ms) {
  const t = String(title || '').trim()
  // skip short, notification-count, and search-result-page titles (the query is captured separately)
  if (t.length < 10 || /^\(?\d[\d,]*\)?[\s—:_-]/.test(t) || /(google search|at duckduckgo|[-–] search|bing|yahoo search)\s*$/i.test(t)) return
  const k = t.toLowerCase(); if (seen.has(k) || seen.size >= 1500) return
  seen.add(k); pushText(ctx, 'web', ms, t, { agg: true })  // agg → feeds topics/entities, never verbatim
}
const SALT = randomBytes(8).toString('hex')
function hashContact(id) { return '[contact-' + createHash('sha256').update(SALT + String(id || '')).digest('hex').slice(0, 6) + ']' }

function hasFDA() {
  if (CFG.fda !== null) return CFG.fda
  // Probe FDA with a REAL, TCC-enforced byte read of an FDA-only file. access()/stat() only check POSIX
  // bits and FALSE-POSITIVE under TCC (the actual read is still blocked and would PROMPT) — that made the
  // scan believe it had FDA and scrape Desktop/Documents/Downloads/Music, a wall of permission dialogs.
  // ANY failure here (EPERM, or TCC hiding the file as ENOENT) = no FDA. TCC.db is in the deny-silently
  // class, so a failed probe never itself raises a prompt. (The old accessSync(Safari) fallback was the bug.)
  try { const fd = openSync(join(HOME, 'Library/Application Support/com.apple.TCC/TCC.db'), 'r'); const b = Buffer.alloc(1); readSync(fd, b, 0, 1, 0); closeSync(fd); return true }
  catch { return false }
}

// ---- ctx buckets + push helpers ------------------------------------------------------
function newCtx() {
  return {
    text: [],      // {source, ts, text, project?, sessionId?}  → voice/directive/entity mining
    events: [],    // {source, ts, kind, key, durSec?, meta?}    → cadence + frequency
    collab: new Map(),  // label → count                         → collaborators (gaps suppression)
    collabVia: new Map(), // label → how we know them ('commits'|'messages'|'mail'|'meetings'|'documents') — first source wins
    contactNames: new Map(), // normalized email / last-10-digits → "First L." (AddressBook join, FDA)
    calendar: { upcoming: [], meetingsPerWeek: 0 }, // {title,start,allDay,attendees}
    census: [],    // {kind, n} — document-type census (what this person MAKES; mdfind, no permission)
    openTabs: null,        // {browser, capturedAt, windows:[{tabs:[{title,host,url}]}], counts} — live working set (--open-tabs)
    openTabHosts: new Set(), // hosts of the open tabs → intentionality boost in matchWorkflow ("you're using this NOW")
    appUse: new Map(),  // app → launch count (Spotlight, Branch-B proxy for knowledgeC time)
    tooling: new Map(), // tool/pkg → count
    facts: { installedApps: [], dockApps: [], loginItems: [], accounts: [], gitRepos: [], editorExtensions: [], brewLeaves: [], locale: {}, defaultBrowser: null, gitName: null, computerName: null, fullName: null },
    authored: []   // {kind, name, text}  → verbatim self-authored prefs
  }
}
// People aggregate: count + remember HOW we know them (the board's people card shows the via).
function bumpPerson(ctx, label, n, via) {
  if (!label) return
  bump(ctx.collab, label, n)
  if (via && !ctx.collabVia.has(label)) ctx.collabVia.set(label, via)
}
function pushText(ctx, source, ts, text, extra = {}) {
  const t = clamp(clean(text), 2000); if (!t || isTrivial(t)) return
  ctx.text.push({ source, ts: ts || 0, text: t, ...extra })
}
function pushEvent(ctx, source, ts, kind, key, rest = {}) {
  if (!ts || !inWindow(ts)) return
  ctx.events.push({ source, ts, kind, key: clamp(redact(String(key || '')), 120), ...rest })
}

// ====================================================================================
// AI SESSION SOURCES (tier 'none') — the original behavior, now feeding ctx.text
// ====================================================================================
function readJsonl(path, max = Infinity) {
  const out = []; let raw
  try { raw = readFileSync(path, 'utf8') } catch { return out }
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length && out.length < max; i++) { const ln = lines[i]; if (!ln) continue; try { out.push(JSON.parse(ln)) } catch {} }
  return out
}
function loadClaude(ctx) {
  const h = join(HOME, '.claude', 'history.jsonl'); if (!existsSync(h)) return
  let n = 0; for (const o of readJsonl(h)) { if (typeof o.display !== 'string') continue; pushText(ctx, 'claude', +o.timestamp || 0, o.display, { project: o.project, sessionId: o.sessionId }); n++ }
  log(`· claude: ${n} prompts`)
}
function loadCodex(ctx) {
  const h = join(HOME, '.codex', 'history.jsonl'); if (!existsSync(h)) return
  let n = 0; for (const o of readJsonl(h)) { if (typeof o.text !== 'string') continue; pushText(ctx, 'codex', (+o.ts || 0) * 1000, o.text, { sessionId: o.session_id }); n++ }
  log(`· codex: ${n} prompts`)
}
function loadGenericAgents(ctx) {
  for (const agent of ['hermes', 'openclaw']) {
    const dir = join(HOME, '.' + agent); if (!existsSync(dir)) continue
    const files = []
    const walk = (d, depth) => {
      if (depth > 3 || files.length > 40) return
      let ents; try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of ents) { const p = join(d, e.name); if (SECRET_RE.test(e.name)) continue
        if (e.isDirectory()) walk(p, depth + 1)
        else if (e.name.endsWith('.jsonl') && /hist|session|chat|conversation|message|rollout/i.test(e.name)) files.push(p) }
    }
    walk(dir, 0); let n = 0
    for (const f of files.slice(0, 40)) for (const o of readJsonl(f, 5000)) {
      const text = o.display ?? o.text ?? o.prompt ?? o.content ?? (o.message && o.message.content)
      if (typeof text !== 'string') continue
      const ts = +o.timestamp || (+o.ts ? (o.ts < 2e10 ? o.ts * 1000 : o.ts) : 0)
      pushText(ctx, agent, ts, text, { sessionId: o.session_id || o.sessionId || basename(f) }); if (++n > 1500) break
    }
    if (n) log(`· ${agent}: ${n} prompts`)
  }
}
// claude ai-title lookup for session summaries
function claudeTranscriptIndex() {
  const root = join(HOME, '.claude', 'projects'); const idx = new Map(); if (!existsSync(root)) return idx
  let dirs; try { dirs = readdirSync(root) } catch { return idx }
  for (const d of dirs) { let fs2; try { fs2 = readdirSync(join(root, d)) } catch { continue }
    for (const f of fs2) if (f.endsWith('.jsonl')) idx.set(f.slice(0, -6), join(root, d, f)) }
  return idx
}
function claudeTitle(path) {
  let raw; try { raw = readFileSync(path, 'utf8') } catch { return null }
  let title = null
  for (const ln of raw.split('\n')) { if (!ln.includes('"ai-title"')) continue; try { const o = JSON.parse(ln); if (o.aiTitle) title = o.aiTitle } catch {} }
  return title
}

// ====================================================================================
// BRANCH B sources (no prompt)
// ====================================================================================
const CHROMIUM_BROWSERS = { 'Google/Chrome': 'chrome', 'BraveSoftware/Brave-Browser': 'brave', 'Microsoft Edge': 'edge', 'Arc': 'arc', 'Vivaldi': 'vivaldi', 'Chromium': 'chromium' }
function srcChromium(ctx) {
  let visits = 0, queries = 0; const seenTitles = new Set()
  for (const [rel, name] of Object.entries(CHROMIUM_BROWSERS)) {
    const base = join(HOME, 'Library/Application Support', rel); if (!existsSync(base)) continue
    let profs; try { profs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && (d.name === 'Default' || /^Profile /.test(d.name))).map((d) => d.name) } catch { continue }
    for (const prof of profs) {
      const hist = join(base, prof, 'History')
      const rows = sqliteQuery(hist, 'SELECT u.url url,u.title title,u.last_visit_time lvt FROM urls u WHERE u.last_visit_time>0 ORDER BY u.last_visit_time DESC LIMIT 4000')
      for (const r of rows) {
        const ms = chromeTime(r.lvt); if (!ms) continue
        const host = hostOf(r.url); if (host) { pushEvent(ctx, name, ms, 'visit', host); visits++ }
        const q = searchQuery(r.url); if (q) { pushText(ctx, name + '-search', ms, q); queries++ }
        addTitle(ctx, seenTitles, r.title, ms)
      }
      const bm = readJson(join(base, prof, 'Bookmarks'))
      if (bm && bm.roots) { const walk = (node) => { if (!node) return; if (Array.isArray(node.children)) node.children.forEach(walk); else if (node.type === 'url' && node.url) { const h = hostOf(node.url); if (h) pushEvent(ctx, name, Date.now() - 30 * DAY, 'bookmark', h) } }; Object.values(bm.roots).forEach(walk) }
    }
  }
  log(`· browsers(chromium): ${visits} visits, ${queries} searches`)
}
function srcFirefox(ctx) {
  const root = join(HOME, 'Library/Application Support/Firefox/Profiles'); if (!existsSync(root)) return
  let profs; try { profs = readdirSync(root) } catch { return }
  let visits = 0; const seenTitles = new Set()
  for (const prof of profs) {
    const rows = sqliteQuery(join(root, prof, 'places.sqlite'), 'SELECT p.url url,p.title title,p.last_visit_date lvd FROM moz_places p WHERE p.last_visit_date IS NOT NULL ORDER BY p.last_visit_date DESC LIMIT 4000')
    for (const r of rows) { const ms = firefoxTime(r.lvd); if (!ms) continue; const host = hostOf(r.url); if (host) { pushEvent(ctx, 'firefox', ms, 'visit', host); visits++ }; const q = searchQuery(r.url); if (q) pushText(ctx, 'firefox-search', ms, q); addTitle(ctx, seenTitles, r.title, ms) }
  }
  if (visits) log(`· browsers(firefox): ${visits} visits`)
}
// The LIVE working set: the open-tabs snapshot the pre-board Automation step captured (--open-tabs).
// This is the single highest-signal browser artifact — what the user is doing RIGHT NOW, with the
// tabs grouped by the window the user themselves grouped them in. We capture+group it (perception);
// the interview agent clusters it by intent (policy). Tab hosts also boost matchWorkflow (you're
// using these now). Read-only of a local JSON snapshot, no network, no Automation here.
function srcOpenTabs(ctx) {
  if (!CFG.openTabs || !existsSync(CFG.openTabs)) return
  let snap; try { snap = JSON.parse(readFileSync(CFG.openTabs, 'utf8')) } catch (e) { log(`· open-tabs skip (${(e.message || '').slice(0, 40)})`); return }
  const rawWins = Array.isArray(snap?.windows) ? snap.windows : []
  const seen = new Set()
  const windows = []
  let total = 0
  for (const w of rawWins) {
    const tabs = []
    for (const t of (Array.isArray(w?.tabs) ? w.tabs : [])) {
      const url = String(t?.url || '')
      if (!/^https?:/i.test(url)) continue // skip chrome://, about:, file:// — not working-set signal
      const host = hostOf(url); if (!host) continue
      const key = host + '|' + (t?.title || '') // dedup identical tabs within the snapshot
      if (seen.has(key)) continue; seen.add(key)
      ctx.openTabHosts.add(host.replace(/^www\./, ''))
      tabs.push({ title: clamp(clean(t?.title || host), 140), host, url: clamp(url, 300) })
      total++
    }
    if (tabs.length) windows.push({ tabs })
  }
  if (!windows.length) return
  ctx.openTabs = { browser: snap?.browser || null, capturedAt: +snap?.capturedAt || 0, windows, counts: { windows: windows.length, tabs: total } }
  log(`· open-tabs: ${total} tabs across ${windows.length} window(s) in ${snap?.browser || 'browser'}`)
}
function srcSpotlightFiles(ctx) {
  let out = sh('/usr/bin/mdfind', ['kMDItemLastUsedDate >= $time.this_month'], { timeout: 12_000 })
  if (!out.trim()) out = sh('/usr/bin/mdfind', ['kMDItemLastUsedDate >= $time.this_year'], { timeout: 12_000 })
  const paths = out.split('\n').filter(Boolean).filter((p) => !/\/(Library|node_modules|\.git|Caches)\//.test(p)).slice(0, CFG.maxFiles * 6)
  let n = 0
  let authors = 0
  const meName = (sh('git', ['config', '--global', 'user.name']) || '').trim().toLowerCase()
  for (const p of paths.slice(0, 140)) {
    const m = sh('/usr/bin/mdls', ['-name', 'kMDItemLastUsedDate', '-name', 'kMDItemUseCount', '-name', 'kMDItemContentType', '-name', 'kMDItemDisplayName', '-name', 'kMDItemAuthors', p], { timeout: 4000 })
    if (!m) continue
    const used = (m.match(/kMDItemLastUsedDate\s*=\s*(.+)/) || [])[1]
    const useCount = +((m.match(/kMDItemUseCount\s*=\s*(\d+)/) || [])[1] || 0)
    const type = (m.match(/kMDItemContentType\s*=\s*"?([^"\n]+)"?/) || [])[1] || ''
    const ts = used && used !== '(null)' ? Date.parse(used) : 0
    // document authors → people (who they make things with — works for non-engineers)
    const authBlock = (m.match(/kMDItemAuthors\s*=\s*\(([^)]*)\)/) || [])[1] || ''
    for (const am of authBlock.matchAll(/"([^"]{2,40})"/g)) {
      const nm = am[1].trim()
      if (nm && !nm.includes('@') && nm.toLowerCase() !== meName && /^[A-Za-z][\w .'-]+$/.test(nm)) { bumpPerson(ctx, nm, 1, 'documents'); authors++ }
    }
    if (/\.app$/.test(p) || /application-bundle/.test(type)) { bump(ctx.appUse, basename(p).replace(/\.app$/, ''), useCount || 1); continue }
    if (!inWindow(ts)) continue
    pushEvent(ctx, 'spotlight', ts, 'file', basename(p), { meta: { useCount, type: type.trim() } }); n++
  }
  log(`· spotlight files: ${n}${authors ? `, ${authors} doc-author credits` : ''}`)
}
function srcInstalledApps(ctx) {
  const dirs = ['/Applications', join(HOME, 'Applications'), '/System/Applications']
  const seen = new Set()
  for (const d of dirs) { let ents; try { ents = readdirSync(d) } catch { continue }
    for (const e of ents) if (e.endsWith('.app')) { const name = e.slice(0, -4); if (!seen.has(name)) { seen.add(name); ctx.facts.installedApps.push(name) } } }
  log(`· installed apps: ${ctx.facts.installedApps.length}`)
}
function srcDock(ctx) {
  const p = plistJson(join(HOME, 'Library/Preferences/com.apple.dock.plist')); if (!p) return
  for (const t of (p['persistent-apps'] || [])) { const label = t['tile-data'] && t['tile-data']['file-label']; if (label) ctx.facts.dockApps.push(label) }
  if (ctx.facts.dockApps.length) log(`· dock: ${ctx.facts.dockApps.length} pinned`)
}
function srcLoginItems(ctx) {
  // osascript via System Events; guarded + short timeout. If not pre-authorized it just returns ''.
  const out = sh('/usr/bin/osascript', ['-e', 'tell application "System Events" to get the name of every login item'], { timeout: 5000 })
  if (out.trim()) { ctx.facts.loginItems = out.trim().split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40); log(`· login items: ${ctx.facts.loginItems.length}`) }
}
function srcDefaultBrowser(ctx) {
  const p = plistJson(join(HOME, 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist'))
  const h = p && (p.LSHandlers || []).find((x) => x.LSHandlerURLScheme === 'https')
  if (h && h.LSHandlerRoleAll) ctx.facts.defaultBrowser = h.LSHandlerRoleAll
}
function srcShell(ctx) {
  // zsh (extended `: ts:dur;cmd` or plain), bash (plain), fish
  const cmds = []
  const zsh = safeRead(join(HOME, '.zsh_history')); if (zsh) for (const ln of zsh.split('\n')) { const m = ln.match(/^: (\d+):\d+;(.*)$/); if (m) cmds.push({ ts: +m[1] * 1000, cmd: m[2] }); else if (ln.trim()) cmds.push({ ts: 0, cmd: ln }) }
  const bash = safeRead(join(HOME, '.bash_history')); if (bash) for (const ln of bash.split('\n')) if (ln.trim()) cmds.push({ ts: 0, cmd: ln })
  const fish = safeRead(join(HOME, '.local/share/fish/fish_history'))
  if (fish) { let cur = null; for (const ln of fish.split('\n')) { const c = ln.match(/^- cmd:\s*(.*)$/); const w = ln.match(/^\s*when:\s*(\d+)/); if (c) { cur = { ts: 0, cmd: c[1] }; cmds.push(cur) } else if (w && cur) cur.ts = +w[1] * 1000 } }
  let cd = 0, pkg = 0
  for (const { ts, cmd } of cmds) {
    if (ts && inWindow(ts)) pushEvent(ctx, 'shell', ts, 'cmd', (cmd.trim().split(/\s+/)[0] || '').slice(0, 24))
    const tool = cmd.trim().split(/\s+/)[0]; if (tool && /^[a-z][\w.-]+$/i.test(tool)) bump(ctx.tooling, tool)
    const m = cmd.match(/\bcd\s+([^\s;&|]+)/); if (m && /[/~]/.test(m[1])) { const dir = m[1].replace(/^~/, HOME); if (basename(dir) && !/[*${}]/.test(dir)) { ctx.facts.gitRepos.push(basename(dir)); cd++ } }
    const pk = cmd.match(/\b(brew install|brew tap|npm i(nstall)?|pnpm add|yarn add|pip3? install|cargo add|gem install|go install)\s+([@\w./-]+)/); if (pk) { bump(ctx.tooling, pk[3].split('/').pop()); pkg++ }
    if (PREF_RE.test(cmd) || CORRECTION_RE.test(cmd)) pushText(ctx, 'shell', ts, cmd)
  }
  // authored dotfiles
  const addAuthored = (path, kind, transform) => { const raw = safeRead(path); if (!raw) return; const t = transform ? transform(raw) : raw; if (t && t.trim()) ctx.authored.push({ kind, name: basename(path), text: redact(t.trim()) }) }
  addAuthored(join(HOME, '.gitconfig'), 'dotfile')
  addAuthored(join(HOME, '.zshrc'), 'dotfile', (r) => r.split('\n').filter((l) => /^\s*(alias|export|#)/.test(l)).slice(0, 50).join('\n'))
  addAuthored(join(HOME, '.ssh/config'), 'dotfile', (r) => r.split('\n').filter((l) => /^\s*(Host|HostName)\b/i.test(l)).slice(0, 60).join('\n'))
  // brew leaves
  const leaves = sh('brew', ['leaves'], { timeout: 8000 }); if (leaves) ctx.facts.brewLeaves = leaves.trim().split('\n').filter(Boolean).slice(0, 60)
  log(`· shell: ${cmds.length} cmds (${cd} cd, ${pkg} installs), ${ctx.facts.brewLeaves.length} brew leaves`)
}
function safeRead(p) { try { return readFileSync(p, 'utf8') } catch { return '' } }
function srcGit(ctx) {
  const roots = [HOME, join(HOME, 'Documents'), join(HOME, 'Developer'), join(HOME, 'code'), join(HOME, 'src'), join(HOME, 'projects'), join(HOME, 'work'), join(HOME, 'superapp')]
  const repos = []
  const walk = (dir, depth) => {
    if (depth > 3 || repos.length >= 40) return
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (ents.some((e) => e.isDirectory() && e.name === '.git')) { repos.push(dir); return }
    for (const e of ents) if (e.isDirectory() && !/^\.|node_modules|Library|vendor|\.repos/.test(e.name)) walk(join(dir, e.name), depth + 1)
  }
  for (const r of roots) if (existsSync(r)) walk(r, 0)
  const gitName = sh('git', ['config', '--global', 'user.name']).trim()
  if (gitName) ctx.facts.gitName = gitName
  const me = (sh('git', ['config', '--global', 'user.email']) + '\n' + gitName).toLowerCase()
  let own = 0
  for (const repo of repos) {
    ctx.facts.gitRepos.push(basename(repo))
    const rem = sh('git', ['-C', repo, 'remote', '-v']); const host = (rem.match(/@([\w.-]+)[:/]|https?:\/\/([\w.-]+)\//) || [])[1] || (rem.match(/https?:\/\/([\w.-]+)\//) || [])[1]
    if (host) bump(ctx.tooling, host)
    const log2 = sh('git', ['-C', repo, 'log', '--no-merges', '-n', '60', '--pretty=format:%at|%an|%ae|%s'])
    for (const ln of log2.split('\n')) { if (!ln) continue; const parts = ln.split('|'); const at = +parts[0] * 1000, an = parts[1] || '', ae = (parts[2] || '').toLowerCase(), s = parts.slice(3).join('|')
      const mine = me.includes(ae) || (an && me.includes(an.toLowerCase()))
      if (mine) { if (s) { pushText(ctx, 'commit', at, s); own++ } }
      else if (an) bumpPerson(ctx, an, 1, 'commits')
      const co = s.match(/Co-authored-by:\s*([^<]+)/i); if (co) bumpPerson(ctx, co[1].trim(), 1, 'commits')
    }
  }
  log(`· git: ${repos.length} repos, ${own} own commits, ${ctx.collab.size} collaborators`)
}
function srcEditor(ctx) {
  for (const ed of ['Code', 'Cursor', 'VSCodium']) {
    const userDir = join(HOME, 'Library/Application Support', ed, 'User')
    if (!existsSync(userDir)) continue
    // recents: storage.json OR state.vscdb
    let recents = []
    const sj = readJson(join(userDir, 'globalStorage', 'storage.json'))
    const lst = sj && (sj['history.recentlyOpenedPathsList'] || (sj.lastKnownMenubarData))
    if (lst && Array.isArray(lst.entries)) recents = lst.entries
    if (!recents.length) { const rows = sqliteQuery(join(userDir, 'globalStorage', 'state.vscdb'), "SELECT value FROM ItemTable WHERE key='history.recentlyOpenedPathsList'"); if (rows[0]) { try { recents = (JSON.parse(rows[0].value).entries) || [] } catch {} } }
    for (const e of recents.slice(0, 40)) { const p = (e.folderUri || e.fileUri || '').replace(/^file:\/\//, ''); if (p) ctx.facts.gitRepos.push(basename(decodeURIComponent(p))) }
    // settings.json → authored
    const settings = safeRead(join(userDir, 'settings.json')); if (settings.trim()) ctx.authored.push({ kind: 'editor', name: `${ed}/settings.json`, text: redact(settings.trim()) })
  }
  // extensions
  const ext = sh('code', ['--list-extensions'], { timeout: 6000 }) || sh('cursor', ['--list-extensions'], { timeout: 6000 })
  if (ext) ctx.facts.editorExtensions = ext.trim().split('\n').filter(Boolean).slice(0, 60)
  // JetBrains recent projects
  const jb = join(HOME, 'Library/Application Support/JetBrains')
  if (existsSync(jb)) { let prods; try { prods = readdirSync(jb) } catch { prods = [] }
    for (const prod of prods) { const xml = safeRead(join(jb, prod, 'options', 'recentProjects.xml')); for (const m of xml.matchAll(/key="([^"]*\/[^"]+)"/g)) ctx.facts.gitRepos.push(basename(m[1].replace(/\$USER_HOME\$/, HOME))) } }
  if (ctx.facts.editorExtensions.length) log(`· editor: ${ctx.facts.editorExtensions.length} extensions`)
}
function srcDownloads(ctx) {
  const dir = join(HOME, 'Downloads'); if (!existsSync(dir)) return
  let ents; try { ents = readdirSync(dir).filter((f) => !f.startsWith('.')).slice(0, 60) } catch { return }
  let n = 0
  for (const f of ents) { const m = sh('/usr/bin/mdls', ['-name', 'kMDItemWhereFroms', join(dir, f)], { timeout: 3000 })
    for (const um of m.matchAll(/https?:\/\/([\w.-]+)/g)) { pushEvent(ctx, 'download', statTs(join(dir, f)), 'download', um[1]); n++ } }
  if (n) log(`· downloads: ${n} origins`)
}
function statTs(p) { try { return statSync(p).mtimeMs } catch { return Date.now() } }
// Document-type census via Spotlight counts (NO permission): what does this person MAKE?
// The cheapest de-engineering of Branch B — slides/design/docs volumes profile the profession.
const CENSUS_BUCKETS = [
  ['documents', ['org.openxmlformats.wordprocessingml.document', 'com.apple.iwork.pages.sffpages']],
  ['slides', ['org.openxmlformats.presentationml.presentation', 'com.apple.iwork.keynote.sffkey']],
  ['spreadsheets', ['org.openxmlformats.spreadsheetml.sheet', 'com.apple.iwork.numbers.sffnumbers']],
  ['PDFs', ['com.adobe.pdf']],
  ['design files', ['com.adobe.photoshop-image', 'com.bohemiancoding.sketch.drawing', 'com.adobe.illustrator.ai-image']]
]
function srcDocCensus(ctx) {
  for (const [kind, utis] of CENSUS_BUCKETS) {
    let n = 0
    for (const u of utis) {
      const out = sh('/usr/bin/mdfind', ['-count', `kMDItemContentType == "${u}" && kMDItemContentModificationDate >= $time.this_year`], { timeout: 8000 })
      n += +out.trim() || 0
    }
    if (n) ctx.census.push({ kind, n })
  }
  if (ctx.census.length) log('· census: ' + ctx.census.map((c) => `${c.kind} ${c.n}`).join(', '))
}
function srcLocale(ctx) {
  ctx.facts.locale = {
    locale: sh('/usr/bin/defaults', ['read', '-g', 'AppleLocale']).trim(),
    measurement: sh('/usr/bin/defaults', ['read', '-g', 'AppleMeasurementUnits']).trim(),
    firstWeekday: sh('/usr/bin/defaults', ['read', '-g', 'AppleFirstWeekday']).trim()
  }
  ctx.facts.computerName = sh('/usr/sbin/scutil', ['--get', 'ComputerName']).trim() || null
  ctx.facts.fullName = sh('/usr/bin/id', ['-F']).trim() || null // the account's full name (NSFullUserName)
}

// ====================================================================================
// BRANCH A sources (FDA)
// ====================================================================================
function srcKnowledgeC(ctx) {
  const db = join(HOME, 'Library/Application Support/Knowledge/knowledgeC.db')
  const cutoff = (Date.now() / 1000 - CFG.windowDays * 86400) - MAC2001
  const rows = sqliteQuery(db, `SELECT ZVALUESTRING app, SUM(ZENDDATE-ZSTARTDATE) secs, COUNT(*) n, MAX(ZSTARTDATE) mx FROM ZOBJECT WHERE ZSTREAMNAME='/app/usage' AND ZSTARTDATE > ${cutoff} GROUP BY app ORDER BY secs DESC LIMIT 60`)
  for (const r of rows) { const ms = cf2001(r.mx); if (r.app) pushEvent(ctx, 'knowledgeC', ms || Date.now(), 'app', r.app, { durSec: +r.secs || 0 }) }
  log(`· knowledgeC: ${rows.length} apps`)
}
function srcSafari(ctx) {
  const rows = sqliteQuery(join(HOME, 'Library/Safari/History.db'), 'SELECT i.url url,i.visit_count vc,v.visit_time vt,v.title title FROM history_visits v JOIN history_items i ON i.id=v.history_item WHERE v.visit_time>0 ORDER BY v.visit_time DESC LIMIT 4000')
  let n = 0; const seenTitles = new Set(); for (const r of rows) { const ms = cf2001(r.vt); if (!ms) continue; const host = hostOf(r.url); if (host) { pushEvent(ctx, 'safari', ms, 'visit', host); n++ }; const q = searchQuery(r.url); if (q) pushText(ctx, 'safari-search', ms, q); addTitle(ctx, seenTitles, r.title, ms) }
  log(`· safari: ${n} visits`)
}
function srcMessages(ctx) {
  const db = join(HOME, 'Library/Messages/chat.db')
  // summary: per-contact counts + is_from_me ratio + range
  const summ = sqliteQuery(db, 'SELECT h.id id, COUNT(*) n, SUM(m.is_from_me) mine, MIN(m.date) mn, MAX(m.date) mx FROM message m JOIN handle h ON h.ROWID=m.handle_id GROUP BY h.id ORDER BY n DESC LIMIT 40')
  let contacts = 0, named = 0
  for (const r of summ) {
    if (!r.id) continue
    const nm = contactName(ctx, r.id) // AddressBook join (srcContacts ran first) — unmatched stays hashed
    if (nm) named++
    bumpPerson(ctx, nm || hashContact(r.id), +r.n || 1, 'messages'); contacts++
  }
  // cadence: sent-message timestamps
  const sent = sqliteQuery(db, 'SELECT m.date date FROM message m WHERE m.is_from_me=1 AND m.date>0 ORDER BY m.date DESC LIMIT 2000')
  for (const r of sent) { const ms = messagesTime(r.date); if (ms) pushEvent(ctx, 'imessage', ms, 'msg', 'sent') }
  // verbatim message text is SENSITIVE (intimate/personal) — emit ONLY with --comms-content.
  // Default: cadence (events above) + collaborator counts (collab) only.
  let v = 0
  if (CFG.commsContent) {
    const mine = sqliteQuery(db, 'SELECT m.text text,m.date date FROM message m WHERE m.is_from_me=1 AND m.text IS NOT NULL AND length(m.text)>25 ORDER BY m.date DESC LIMIT 400')
    for (const r of mine) { if (v >= 30) break; const ms = messagesTime(r.date); pushText(ctx, 'imessage(self)', ms, r.text); v++ }
    const other = sqliteQuery(db, 'SELECT m.text text,m.date date FROM message m WHERE m.is_from_me=0 AND m.text IS NOT NULL AND length(m.text)>25 ORDER BY m.date DESC LIMIT 200')
    for (const r of other.slice(0, 40)) pushText(ctx, 'imessage(other)', messagesTime(r.date), r.text)
  }
  log(`· messages: ${contacts} contacts (${named} named via AddressBook), cadence${CFG.commsContent ? ` + ${v} self samples (+other content)` : ' only (text behind --comms-content)'}`)
}
function srcMail(ctx) {
  let idx; try { idx = readdirSync(join(HOME, 'Library/Mail')).filter((d) => /^V\d+$/.test(d)).map((d) => join(HOME, 'Library/Mail', d, 'MailData', 'Envelope Index')).find(existsSync) } catch {}
  if (!idx) { log('  · mail: no Envelope Index'); return }
  const corr = sqliteQuery(idx, 'SELECT a.address addr, COUNT(*) n FROM messages m JOIN addresses a ON a.ROWID=m.sender GROUP BY a.address ORDER BY n DESC LIMIT 40')
  for (const r of corr) {
    if (!r.addr) continue
    const nm = contactName(ctx, r.addr) // named correspondent beats a bare domain
    if (nm) { bumpPerson(ctx, nm, +r.n || 1, 'mail'); continue }
    const dom = (String(r.addr).split('@')[1] || hashContact(r.addr))
    bumpPerson(ctx, dom.startsWith('[') ? dom : '@' + dom, +r.n || 1, 'mail')
  }
  const subs = sqliteQuery(idx, 'SELECT s.subject subject, m.date_received dr FROM messages m JOIN subjects s ON s.ROWID=m.subject ORDER BY m.date_received DESC LIMIT 600')
  // subjects feed aggregated topics by default (agg:true → entities only, never verbatim);
  // they become verbatim-eligible only under --comms-content.
  let n = 0; for (const r of subs) { if (!r.subject) continue; const ms = toUnixMs(r.dr); pushText(ctx, 'mail-subject', ms, r.subject, { agg: true }); n++ }
  log(`· mail: ${corr.length} correspondents, ${n} subjects → topics${CFG.commsContent ? ' (verbatim too)' : ' (aggregated only)'}`)
}
function srcNotes(ctx) {
  // body lives in ZICNOTEDATA.ZDATA (gzipped protobuf); LEFT JOIN + skip encrypted (ZCRYPTOTAG)
  const rows = sqliteQuery(join(HOME, 'Library/Group Containers/group.com.apple.notes/NoteStore.sqlite'),
    'SELECT n.ZTITLE1 title, n.ZMODIFICATIONDATE1 mod, hex(d.ZDATA) body FROM ZICCLOUDSYNCINGOBJECT n LEFT JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK AND d.ZCRYPTOTAG IS NULL WHERE n.ZTITLE1 IS NOT NULL ORDER BY n.ZMODIFICATIONDATE1 DESC LIMIT 200')
  let n = 0, bodies = 0
  for (const r of rows) {
    const ms = cf2001(r.mod)
    if (r.title) { pushText(ctx, 'note', ms, r.title); pushEvent(ctx, 'note', ms || Date.now(), 'note', 'edit'); n++ }
    if (r.body) { const text = gunzipText(r.body); if (text && text.length > 8) { pushText(ctx, CFG.notesBodies ? 'note-body' : 'note', ms, text, CFG.notesBodies ? {} : { agg: true }); bodies++ } }
  }
  log(`· notes: ${n} titles, ${bodies} bodies → topics${CFG.notesBodies ? ' (verbatim)' : ' (aggregated)'}`)
}
// AddressBook → handle→name map ("First L."), so Messages/Mail/Calendar people get human names
// instead of hashes. Runs BEFORE messages/mail/calendar (SOURCES order). FDA tier.
function srcContacts(ctx) {
  const root = join(HOME, 'Library/Application Support/AddressBook')
  const dirs = [root]
  try { for (const d of readdirSync(join(root, 'Sources'))) dirs.push(join(root, 'Sources', d)) } catch {}
  let nE = 0, nP = 0
  for (const d of dirs) {
    const db = join(d, 'AddressBook-v22.abcddb'); if (!existsSync(db)) continue
    const names = new Map()
    for (const r of sqliteQuery(db, 'SELECT Z_PK pk, ZFIRSTNAME f, ZLASTNAME l, ZORGANIZATION org FROM ZABCDRECORD WHERE ZFIRSTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL')) {
      const nm = r.f ? String(r.f).trim() + (r.l ? ' ' + String(r.l).trim()[0] + '.' : '') : clamp(String(r.org || '').trim(), 24)
      if (nm) names.set(r.pk, nm)
    }
    for (const e of sqliteQuery(db, 'SELECT ZADDRESS a, ZOWNER o FROM ZABCDEMAILADDRESS')) {
      const nm = names.get(e.o); if (nm && e.a) { ctx.contactNames.set(String(e.a).toLowerCase().trim(), nm); nE++ }
    }
    for (const p of sqliteQuery(db, 'SELECT ZFULLNUMBER a, ZOWNER o FROM ZABCDPHONENUMBER')) {
      const nm = names.get(p.o); const digits = String(p.a || '').replace(/\D/g, '')
      if (nm && digits.length >= 7) { ctx.contactNames.set(digits.slice(-10), nm); nP++ }
    }
  }
  if (nE + nP) log(`· contacts: ${nE} emails + ${nP} phones joinable`)
}
function contactName(ctx, handle) {
  const h = String(handle || '').trim(); if (!h) return null
  if (h.includes('@')) return ctx.contactNames.get(h.toLowerCase()) || null
  const digits = h.replace(/\D/g, '')
  return digits.length >= 7 ? ctx.contactNames.get(digits.slice(-10)) || null : null
}
// Calendar (group container CalendarStore schema, NOT Core Data): upcoming events, meeting
// density, attendees→people. The universal projects/people/rhythm source for non-engineers.
function srcCalendar(ctx) {
  const db = join(HOME, 'Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb')
  if (!existsSync(db)) { log('  · calendar: no db'); return }
  const nowCF = Math.floor(Date.now() / 1000) - MAC2001
  const live = "summary IS NOT NULL AND due_date IS NULL AND (hidden IS NULL OR hidden=0)" // events, not reminders/hidden
  const up = sqliteQuery(db, `SELECT summary s, start_date sd, all_day ad, has_attendees ha FROM CalendarItem WHERE ${live} AND start_date BETWEEN ${nowCF} AND ${nowCF + 14 * 86400} ORDER BY start_date LIMIT 40`)
  for (const r of up) { const ms = cf2001(r.sd); if (ms) ctx.calendar.upcoming.push({ title: clamp(redact(r.s), 60), start: ms, allDay: !!r.ad, attendees: !!r.ha }) }
  const meet = sqliteQuery(db, `SELECT COUNT(*) n FROM CalendarItem WHERE ${live} AND has_attendees=1 AND start_date BETWEEN ${nowCF - 90 * 86400} AND ${nowCF}`)
  ctx.calendar.meetingsPerWeek = Math.round(((+(meet[0] && meet[0].n) || 0) / (90 / 7)) * 10) / 10
  // past events feed the rhythm punchcard
  for (const r of sqliteQuery(db, `SELECT start_date sd FROM CalendarItem WHERE ${live} AND all_day=0 AND start_date BETWEEN ${nowCF - CFG.windowDays * 86400} AND ${nowCF} LIMIT 1500`)) {
    const ms = cf2001(r.sd); if (ms) pushEvent(ctx, 'calendar', ms, 'event', 'cal')
  }
  // attendees → people (calendar's own Identity names; bare emails fall back to the contacts join)
  const att = sqliteQuery(db, `SELECT i.first_name f, i.last_name l, i.display_name dn, p.email e, COUNT(*) n FROM Participant p LEFT JOIN Identity i ON i.ROWID=p.identity_id JOIN CalendarItem c ON c.ROWID=p.owner_id WHERE (p.is_self IS NULL OR p.is_self=0) AND c.start_date > ${nowCF - 90 * 86400} GROUP BY COALESCE(i.display_name, p.email) ORDER BY n DESC LIMIT 24`)
  let people = 0
  for (const r of att) {
    const nm = (r.f ? String(r.f).trim() + (r.l ? ' ' + String(r.l).trim()[0] + '.' : '') : null) || (r.dn ? clamp(redact(r.dn), 40) : null) || contactName(ctx, r.e)
    if (nm) { bumpPerson(ctx, nm, +r.n || 1, 'meetings'); people++ }
  }
  log(`· calendar: ${ctx.calendar.upcoming.length} upcoming, ~${ctx.calendar.meetingsPerWeek}/wk meetings, ${people} attendees`)
}
function srcAccounts(ctx) {
  let files; try { files = readdirSync(join(HOME, 'Library/Accounts')).filter((f) => /^Accounts\d*\.sqlite$/.test(f)).map((f) => join(HOME, 'Library/Accounts', f)) } catch { return }
  for (const f of files) { const rows = sqliteQuery(f, 'SELECT ZACCOUNTDESCRIPTION desc, ZIDENTIFIER ident FROM ZACCOUNT WHERE ZACCOUNTDESCRIPTION IS NOT NULL LIMIT 60')
    for (const r of rows) if (r.desc) ctx.facts.accounts.push(clamp(redact(r.desc), 40)) }
  if (ctx.facts.accounts.length) log(`· accounts: ${ctx.facts.accounts.length}`)
}

// ---- source registry -----------------------------------------------------------------
// tier 'fda' = needs Full Disk Access OR touches a TCC-PROTECTED location that would POP a macOS
// permission dialog without a covering grant. git/downloads/census/spotlight reach Desktop/Documents/
// Downloads/Music (srcGit walks HOME into them; srcDownloads reads ~/Downloads), and loginItems sends an
// Apple Event to System Events. The no-FDA boot scan skips every 'fda' source (filter near "fdaOn"), so
// first-run onboarding never spams prompts before the helper holds FDA; the post-FDA enrich re-scan
// (src/main/onboarding.ts → enrichScanAfterFda) then runs them under the FDA'd helper, silently.
const SOURCES = [
  { id: 'claude', tier: 'none', run: loadClaude },
  { id: 'codex', tier: 'none', run: loadCodex },
  { id: 'agents', tier: 'none', run: loadGenericAgents },
  { id: 'chromium', tier: 'none', run: srcChromium },
  { id: 'firefox', tier: 'none', run: srcFirefox },
  { id: 'openTabs', tier: 'none', run: srcOpenTabs },
  { id: 'spotlight', tier: 'fda', run: srcSpotlightFiles }, // mdls over recent files in protected folders
  { id: 'apps', tier: 'none', run: srcInstalledApps },
  { id: 'dock', tier: 'none', run: srcDock },
  { id: 'loginItems', tier: 'fda', run: srcLoginItems }, // System Events Apple Event → Automation prompt
  { id: 'defaultBrowser', tier: 'none', run: srcDefaultBrowser },
  { id: 'shell', tier: 'none', run: srcShell },
  { id: 'git', tier: 'fda', run: srcGit }, // walks HOME → Desktop/Documents/Downloads/Music (protected)
  { id: 'editor', tier: 'none', run: srcEditor },
  { id: 'downloads', tier: 'fda', run: srcDownloads }, // readdir ~/Downloads (protected)
  { id: 'census', tier: 'fda', run: srcDocCensus }, // mdfind across content types incl. media library
  { id: 'locale', tier: 'none', run: srcLocale },
  { id: 'knowledgeC', tier: 'fda', run: srcKnowledgeC },
  { id: 'safari', tier: 'fda', run: srcSafari },
  { id: 'contacts', tier: 'fda', run: srcContacts }, // MUST run before messages/mail/calendar (name join)
  { id: 'messages', tier: 'fda', run: srcMessages },
  { id: 'mail', tier: 'fda', run: srcMail },
  { id: 'calendar', tier: 'fda', run: srcCalendar },
  { id: 'notes', tier: 'fda', run: srcNotes },
  { id: 'accounts', tier: 'fda', run: srcAccounts }
]

// ---- aggregation ---------------------------------------------------------------------
function bump(map, k, n = 1) { if (!k) return; map.set(k, (map.get(k) || 0) + n) }
function topN(map, n) { return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n) }

// Curated workflow-SaaS map: which browsing domains are TOOLS (not reading). Suffix-matched, so
// app.slack.com / x.atlassian.net resolve. `integration` = a BlitzOS OAuth provider id when one exists.
const WORKFLOW_SITES = {
  'mail.google.com': { name: 'Gmail', integration: 'gmail', color: '#EA4335' },
  'calendar.google.com': { name: 'Google Calendar', color: '#4285F4' },
  'docs.google.com': { name: 'Google Docs', color: '#4285F4' },
  'sheets.google.com': { name: 'Google Sheets', color: '#0F9D58' },
  'drive.google.com': { name: 'Google Drive', color: '#FBBC04' },
  'notion.so': { name: 'Notion', color: '#191919' },
  'linear.app': { name: 'Linear', color: '#5E6AD2' },
  'figma.com': { name: 'Figma', color: '#A259FF' },
  'github.com': { name: 'GitHub', integration: 'github', color: '#24292F' },
  'slack.com': { name: 'Slack', integration: 'slack', color: '#611F69' },
  'discord.com': { name: 'Discord', integration: 'discord', color: '#5865F2' },
  'atlassian.net': { name: 'Jira', integration: 'jira', color: '#0052CC' },
  'trello.com': { name: 'Trello', color: '#0079BF' },
  'asana.com': { name: 'Asana', color: '#F06A6A' },
  'airtable.com': { name: 'Airtable', color: '#FCB400' },
  'miro.com': { name: 'Miro', color: '#050038' },
  'canva.com': { name: 'Canva', color: '#00C4CC' },
  'x.com': { name: 'X', color: '#0F1419', kind: 'social' },
  'twitter.com': { name: 'X', color: '#0F1419', kind: 'social' },
  'linkedin.com': { name: 'LinkedIn', color: '#0A66C2', kind: 'social' },
  'chatgpt.com': { name: 'ChatGPT', color: '#10A37F', kind: 'ai' },
  'claude.ai': { name: 'Claude', color: '#D97757', kind: 'ai' },
  'openrouter.ai': { name: 'OpenRouter', color: '#6566F1', kind: 'ai' },
  'aistudio.google.com': { name: 'AI Studio', color: '#4285F4', kind: 'ai' },
  'huggingface.co': { name: 'Hugging Face', color: '#FFD21E', kind: 'ai' },
  'overleaf.com': { name: 'Overleaf', color: '#138A07' },
  'salesforce.com': { name: 'Salesforce', color: '#00A1E0' },
  'hubspot.com': { name: 'HubSpot', color: '#FF7A59' },
  'stripe.com': { name: 'Stripe', color: '#635BFF' },
  'vercel.com': { name: 'Vercel', color: '#171717' },
  'supabase.com': { name: 'Supabase', color: '#3ECF8E' },
  'cloudflare.com': { name: 'Cloudflare', color: '#F38020' },
  'shopify.com': { name: 'Shopify', color: '#96BF48' }
}
// Pure consumption — never "where your work lives", even if visited heavily or open right now (the
// ambient noise the 90-day frequency ranking otherwise rewards). SUFFIX-matched (social/video/shop:
// m.youtube.com is still youtube), so every subdomain is excluded too.
const NON_TOOL_SUFFIX = new Set([
  'instagram.com', 'reddit.com', 'youtube.com', 'youtu.be', 'facebook.com', 'tiktok.com', 'netflix.com',
  'amazon.com', 'twitch.tv', 'pinterest.com', 'spotify.com', 'snapchat.com', 't.co'
])
// Search engines: the BARE host is noise, but subdomains can be real tools (docs.google.com,
// aistudio.google.com), so these match EXACT host only — never as a suffix.
const NON_TOOL_EXACT = new Set(['google.com', 'bing.com', 'duckduckgo.com', 'ecosia.org', 'kagi.com', 'yahoo.com'])
const isExcludedHost = (host) => NON_TOOL_EXACT.has(host) || [...NON_TOOL_SUFFIX].some((k) => suffixMatch(host, k))
// A domain's first label that reads as an app surface (not the marketing root) → it's a tool.
const TOOL_PREFIX = new Set(['app', 'dash', 'dashboard', 'console', 'admin', 'portal', 'studio', 'platform', 'developers', 'developer', 'dev', 'api', 'my', 'account', 'manage', 'cloud', 'workspace'])
// SLDs too generic to name a tool by (use the distinctive subdomain instead).
const GENERIC_SLD = new Set(['google', 'microsoft', 'apple', 'amazonaws', 'azure', 'herokuapp'])
const suffixMatch = (host, key) => host === key || host.endsWith('.' + key)
// Readable tool name from a host the curated map didn't cover (dash.cloudflare.com → Cloudflare,
// aistudio.google.com → Aistudio, outreach.app.blitz.dev → Outreach).
function prettyName(host) {
  const labels = host.replace(/^www\./, '').split('.').slice(0, -1) // drop TLD
  if (!labels.length) return host
  let label
  if (labels.length >= 2 && (TOOL_PREFIX.has(labels[0]) || GENERIC_SLD.has(labels[labels.length - 1]))) {
    label = GENERIC_SLD.has(labels[labels.length - 1]) ? labels[0] : labels[labels.length - 1]
  } else label = labels[0]
  return label.charAt(0).toUpperCase() + label.slice(1)
}
// Classify a host. Returns {kind:'tool'|'ai', name, color?, integration?} for a work tool, the
// sentinel 'EXCLUDE' for a hard non-tool (social/consumer/search — never a tool, even open), or
// null for unknown (the caller may still treat an OPEN unknown as a tool). Curated map FIRST so a
// named tool under a search root wins (docs.google.com → Google Docs, not the google.com exclude);
// then the consumer/search exclusion; then a structural heuristic (app-surface subdomain or the
// user's own *.blitz.dev deploys).
function classifyDomain(host) {
  for (const key of Object.keys(WORKFLOW_SITES)) {
    if (suffixMatch(host, key)) {
      const s = WORKFLOW_SITES[key]
      if (s.kind === 'social') return 'EXCLUDE' // curated, but social → never a workflow tool
      return { kind: s.kind || 'tool', name: s.name, ...(s.color ? { color: s.color } : {}), ...(s.integration ? { integration: s.integration } : {}) }
    }
  }
  if (isExcludedHost(host)) return 'EXCLUDE'
  const sub = host.split('.')[0]
  if (TOOL_PREFIX.has(sub) || /\.blitz\.dev$/.test(host)) return { kind: 'tool', name: prettyName(host) }
  return null
}
// "Where your work lives": the tools the user actually uses, ranked by intentionality — a tab OPEN
// right now ('using') beats raw 90-day frequency. An open tab that isn't a known consumer/social
// site counts as a tool even when the heuristic can't name it structurally (you opened it on purpose).
function matchWorkflow(topDomains, openTabHosts = new Set()) {
  const hits = new Map() // name → {host, name, n, color?, integration?, kind, using?}
  const consider = (rawHost, weight, using) => {
    const host = String(rawHost || '').replace(/^www\./, '')
    if (!host) return
    let c = classifyDomain(host)
    if (c === 'EXCLUDE') return // social/consumer/search — never a tool, even if open right now
    if (!c) { if (!using) return; c = { kind: 'tool', name: prettyName(host) } } // open unknown ⇒ a tool by intent
    const prev = hits.get(c.name)
    hits.set(c.name, {
      host: prev ? prev.host : host, name: c.name, kind: c.kind,
      n: Math.round(weight) + (prev ? prev.n : 0),
      ...(c.color || prev?.color ? { color: c.color || prev.color } : {}),
      ...(c.integration || prev?.integration ? { integration: c.integration || prev.integration } : {}),
      ...(using || prev?.using ? { using: true } : {})
    })
  }
  const norm = new Set()
  for (const [host, w] of topDomains) { const h = String(host).replace(/^www\./, ''); norm.add(h); consider(host, w, openTabHosts.has(h)) }
  for (const h of openTabHosts) if (!norm.has(h)) consider(h, 0, true) // open but not in history (fresh/private)
  return [...hits.values()]
    .sort((a, b) => (b.using ? 1 : 0) - (a.using ? 1 : 0) || b.n - a.n)
    .slice(0, 10)
}

function selfAuthored(ctx) {
  const out = ctx.authored.slice()
  const tryDir = (d, kind) => { if (!existsSync(d)) return; let ents; try { ents = readdirSync(d) } catch { return }
    for (const f of ents) { if (!f.endsWith('.md') || SECRET_RE.test(f)) continue; try { const txt = readFileSync(join(d, f), 'utf8').trim(); if (txt) out.push({ kind, name: f, text: txt }) } catch {} } }
  tryDir(join(HOME, '.claude', 'commands'), 'command')
  const projRoot = join(HOME, '.claude', 'projects')
  if (existsSync(projRoot)) { let dirs; try { dirs = readdirSync(projRoot) } catch { dirs = [] }
    for (const d of dirs) { const mem = join(projRoot, d, 'memory'); if (existsSync(mem)) tryDir(mem, 'memory') } }
  return out
}

function analyze(ctx, now) {
  const text = ctx.text
  text.sort((a, b) => a.ts - b.ts)
  const projects = new Map(), domains = new Map(), hours = new Map(), weekdays = new Map(), entities = new Map()
  const entSess = new Map(), sessSet = new Set()
  const topApps = new Map(), topDomains = new Map()
  const directives = [], corrections = [], voice = []
  const seenPrompt = new Set()
  const punch = new Map() // 'weekday:hour' → n (joint distribution for a rhythm punchcard)
  let tsMin = Infinity, tsMax = 0
  const stamp = (ts) => { if (ts && inWindow(ts)) { tsMin = Math.min(tsMin, ts); tsMax = Math.max(tsMax, ts); const d = new Date(ts); bump(hours, d.getHours()); bump(weekdays, d.getDay()); bump(punch, d.getDay() + ':' + d.getHours()) } }

  // events → cadence, apps, domains, files (+ visit volume for the web-first heuristic)
  const files = []
  let visits = 0
  for (const e of ctx.events) {
    stamp(e.ts)
    if (e.kind === 'app') bump(topApps, e.key, e.durSec || 0)
    else if (e.kind === 'visit' || e.kind === 'bookmark') { topDomains.set(e.key, (topDomains.get(e.key) || 0) + recencyWeight(e.ts, now)); if (e.kind === 'visit') visits++ }
    else if (e.kind === 'file') files.push(e)
  }
  // dev-signal volume (the engineer tells): agent prompts, commits, shell — for web-first detection
  const DEV_SOURCES = new Set(['claude', 'codex', 'hermes', 'openclaw', 'commit', 'shell'])
  let devText = 0
  // text → mining
  let docId = 0
  for (const r of text) {
    stamp(r.ts)
    if (DEV_SOURCES.has(r.source)) devText++
    // per-record doc id for TF-IDF: agent prompts group by their real session; agg records
    // (page titles, note bodies, mail subjects) each count as their own document, so a term's
    // document-frequency reflects how widespread (= generic) it is
    const sid = r.sessionId ? (r.source + ':' + r.sessionId) : (r.source + ':#' + (docId++)); sessSet.add(sid)
    if (r.project) bump(projects, basename(r.project))
    const low = ' ' + r.text.toLowerCase() + ' '
    for (const kw of DOMAIN_KW) if (low.includes(kw)) bump(domains, kw.trim())
    const uniq = new Set()
    for (const t of toks(r.text)) if (!STOPWORDS.has(t) && (t.length > 3 || t.includes('.'))) { bump(entities, t); uniq.add(t) }
    for (const t of uniq) { let s = entSess.get(t); if (!s) { s = new Set(); entSess.set(t, s) } s.add(sid) }
    if (r.agg && !CFG.commsContent) continue  // aggregate-only (e.g. mail subjects): topics, never verbatim
    const k = r.source + '|' + normKey(r.text); if (seenPrompt.has(k)) continue; seenPrompt.add(k)
    const w = recencyWeight(r.ts || tsMin || now, now)
    if (PREF_RE.test(r.text)) directives.push({ ...r, w })
    else if (CORRECTION_RE.test(r.text)) corrections.push({ ...r, w })
    else if (r.text.length >= 30 && r.text.length <= 280) voice.push({ ...r, w })
  }
  // entities also from domains (browser hosts) + tooling
  for (const [host, w] of topDomains) { const label = host.split('.').slice(-2)[0]; if (label && label.length > 2 && !STOPWORDS.has(label)) bump(entities, label, Math.round(w)) }
  const totalSess = sessSet.size || 1
  // TF-IDF-ish: rank by count × idf so distinctive topics (gwern, slumbot, glymphatic) beat
  // ubiquitous verbs (write, open, time). Drop terms in >50% of docs and rare noise (<3 hits).
  const entityRanked = [...entities.entries()]
    .filter(([t, c]) => c >= 3)
    .map(([t, c]) => { const df = entSess.get(t)?.size || 1; return { t, c, score: c * Math.log(1 + totalSess / df), df } })
    .filter((e) => e.df / totalSess <= 0.5)
    .sort((a, b) => b.score - a.score)
    .map((e) => [e.t, e.c])
  const topFiles = files.sort((a, b) => (b.meta?.useCount || 0) - (a.meta?.useCount || 0) || b.ts - a.ts).slice(0, CFG.maxFiles)
  const byW = (a, b) => b.w - a.w
  return {
    nText: text.length, nEvents: ctx.events.length, tsMin, tsMax, totalSess, visits, devText,
    projects, domains, hours, weekdays, punch, entityRanked, topApps, appUse: ctx.appUse, topDomains, topFiles,
    directives: directives.sort(byW), corrections: corrections.sort(byW), voice: voice.sort(byW),
    collab: ctx.collab, collabVia: ctx.collabVia, calendar: ctx.calendar, census: ctx.census,
    tooling: ctx.tooling, facts: ctx.facts, openTabs: ctx.openTabs, openTabHosts: ctx.openTabHosts
  }
}

// AI session grouping (only records with a sessionId from agent sources)
function selectSessions(text, now) {
  const aiSources = new Set(['claude', 'codex', 'hermes', 'openclaw'])
  const map = new Map()
  for (const r of text) {
    if (!aiSources.has(r.source) || !r.sessionId) continue
    const id = r.source + ':' + r.sessionId
    let s = map.get(id); if (!s) { s = { id, agent: r.source, project: r.project, prompts: [], first: r.ts, last: r.ts }; map.set(id, s) }
    s.prompts.push(r); if (r.ts) { s.first = Math.min(s.first || r.ts, r.ts); s.last = Math.max(s.last || r.ts, r.ts) }
  }
  const sessions = [...map.values()].filter((s) => s.prompts.length)
  for (const s of sessions) s.prompts.sort((a, b) => a.ts - b.ts)
  sessions.sort((a, b) => (b.last || 0) - (a.last || 0))
  if (!sessions.length) return []
  const picked = sessions.slice(0, CFG.recentFull); const ids = new Set(picked.map((s) => s.id))
  const seenProj = new Map(); for (const s of picked) bump(seenProj, basename(s.project || s.agent))
  const tail = sessions.filter((s) => !ids.has(s.id)).map((s) => ({ s, score: recencyWeight(s.last || 0, now) / (1 + (seenProj.get(basename(s.project || s.agent)) || 0)) }))
  if (CFG.stochastic) tail.forEach((t, i) => { t.score *= 0.5 + ((i * 2654435761) % 1000) / 1000 })
  tail.sort((a, b) => b.score - a.score)
  for (const { s } of tail) { if (picked.length >= CFG.maxSessions) break; picked.push(s) }
  const idx = claudeTranscriptIndex()
  for (const s of picked) { if (s.agent === 'claude') { const tp = idx.get(s.id.split(':')[1]); if (tp) s.title = claudeTitle(tp) } if (!s.title) s.title = clamp(clean(s.prompts[0].text), 80) }
  return picked
}

// ---- render --------------------------------------------------------------------------
function fmtDate(ts) { return ts && isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '?' }
function fmtDur(secs) { const h = secs / 3600; return h >= 1 ? `${h.toFixed(0)}h` : `${Math.round(secs / 60)}m` }
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function peakHours(hours) { return topN(hours, 3).map(([h]) => +h).sort((a, b) => a - b).map((h) => `${String(h).padStart(2, '0')}:00`).join(', ') }

function render(A, sessions, authored, now, fdaOn) {
  const tok = (s) => Math.ceil((s.length + 1) / 4)
  let left = CFG.tokenBudget
  const out = []
  const add = (s) => { out.push(s); left -= tok(s) }
  const cap = (frac) => { let c = Math.round(CFG.tokenBudget * frac); return (s) => { const t = tok(s); if (t <= c && t <= left) { out.push(s); c -= t; left -= t; return true } return false } }
  const spanDays = Math.max(1, Math.round((A.tsMax - A.tsMin) / DAY))

  // 1. header
  add(`# BlitzOS — scanned user context (${fmtDate(now)})`)
  add('')
  add(`> Local multi-source scan to prime BlitzOS onboarding. **Inferences, not facts** — verify, don't assume; ask the gaps (last section), not the obvious.`)
  add(`> Coverage: **Branch B (no-prompt)${fdaOn ? ' + Branch A (Full Disk Access granted)' : ' only — Full Disk Access OFF'}**. ${A.nText.toLocaleString()} text records, ${A.nEvents.toLocaleString()} events, span ${fmtDate(A.tsMin)} → ${fmtDate(A.tsMax)} (~${spanDays}d).`)
  add('')

  // 2. who & cadence
  add('## Who & cadence')
  if (A.topApps.size) add(`- Top apps by focus time: ${topN(A.topApps, 6).map(([a, s]) => `${String(a).split('.').pop()} (${fmtDur(s)})`).join(', ')}.`)
  else if (A.appUse && A.appUse.size) add(`- Top apps by launches: ${topN(A.appUse, 6).map(([a, n]) => `${a} (${n}×)`).join(', ')}.`)
  add(`- Peak hours (local): ${peakHours(A.hours) || '?'}. Most active: ${topN(A.weekdays, 3).map(([d]) => WD[d]).join(', ') || '?'}.`)
  if (A.collab.size) add(`- ${A.collab.size} recurring contacts/collaborators (Messages + Mail + Calendar + git + doc authors; named via AddressBook when possible).`)
  if (A.calendar.meetingsPerWeek || A.calendar.upcoming.length) add(`- Calendar: ~${A.calendar.meetingsPerWeek}/wk meetings; ${A.calendar.upcoming.length} events in the next 14d.`)
  add(`- Active span ~${spanDays}d.`)
  add('')

  // 3. apps & tooling
  const tline = []
  if (A.facts.dockApps.length) tline.push(`Dock-pinned: ${A.facts.dockApps.slice(0, 12).join(', ')}.`)
  if (A.facts.defaultBrowser) tline.push(`Default browser: ${A.facts.defaultBrowser}.`)
  if (A.facts.brewLeaves.length) tline.push(`brew leaves: ${A.facts.brewLeaves.slice(0, 24).join(', ')}.`)
  if (A.facts.editorExtensions.length) tline.push(`Editor extensions (${A.facts.editorExtensions.length}): ${A.facts.editorExtensions.slice(0, 16).join(', ')}.`)
  if (A.tooling.size) tline.push(`CLI tools/hosts: ${topN(A.tooling, 16).map(([t, n]) => `${t} (${n})`).join(', ')}.`)
  if (A.facts.accounts.length) tline.push(`Configured accounts: ${[...new Set(A.facts.accounts)].slice(0, 12).join(', ')}.`)
  if (A.facts.loginItems.length) tline.push(`Login items: ${A.facts.loginItems.slice(0, 12).join(', ')}.`)
  if (A.census.length) tline.push(`Makes (modified this year): ${A.census.map((c) => `${c.n} ${c.kind}`).join(', ')}.`)
  if (A.facts.installedApps.length) tline.push(`${A.facts.installedApps.length} apps installed.`)
  if (tline.length) { add('## Apps & tooling'); const pT = cap(0.10); for (const l of tline) if (!pT('- ' + l)) break; add('') }

  // 4. projects & domains
  add('## Projects & domains')
  const projs = topN(A.projects, CFG.topProjects)
  const repoSet = [...new Set(A.facts.gitRepos)].slice(0, CFG.topProjects)
  const pD = cap(0.12)
  if (projs.length) pD('Projects (by prompt volume): ' + projs.map(([p, n]) => `\`${p}\` (${n})`).join(', ') + '.')
  if (repoSet.length) pD('Repos / dirs on disk + recents: ' + repoSet.map((r) => `\`${r}\``).join(', ') + '.')
  if (A.topDomains.size) pD('Top web domains: ' + topN(A.topDomains, CFG.maxDomains).map(([d]) => d).join(', ') + '.')
  const wf = matchWorkflow(A.topDomains, A.openTabHosts)
  if (wf.length) {
    const oauth = wf.filter((w) => w.integration).map((w) => w.name)
    pD(`Where their work lives (tools, not reading): ${wf.map((w) => w.name + (w.using ? ' (open now)' : '')).join(', ')}.`
      + ' Their work lives substantially in the browser; offer to bring it in (open the key tools as live surfaces, import tabs).'
      + (oauth.length ? ` Connectable via OAuth so the agent can act, not just look: ${oauth.join(', ')}.` : ''))
  }
  if (A.domains.size) pD('Inferred stack: ' + topN(A.domains, 16).map(([d, n]) => `${d} (${n})`).join(', ') + '.')
  add('')

  // 4b. the LIVE working set — the open tabs captured at onboarding, grouped by the user's own
  // windows. Highest-signal browser artifact (what they're doing NOW). We list it raw; the
  // interviewer clusters it by intent and leads the scope question from it.
  if (A.openTabs && A.openTabs.windows.length) {
    add('## Working set (open right now)')
    const c = A.openTabs.counts
    add(`> ${c.tabs} tabs across ${c.windows} window(s) in ${A.openTabs.browser || 'the browser'}, captured at onboarding. This is the live working set — cluster it by intent and lead the first scope question from it.`)
    const pW = cap(0.16)
    let shown = 0
    A.openTabs.windows.forEach((w, i) => {
      if (shown >= 40) return
      if (!pW(`- **Window ${i + 1}** (${w.tabs.length} tab${w.tabs.length === 1 ? '' : 's'}):`)) return
      for (const t of w.tabs) { if (shown >= 40) break; if (!pW(`  - ${t.title} — ${t.host}`)) break; shown++ }
    })
    add('')
  }

  // 5. self-authored
  if (authored.length) {
    add('## Self-authored preferences (verbatim, from their own config/memory)')
    const pA = cap(0.24)
    for (const a of authored) { const body = clamp(redact(a.text), 600).split('\n').map((l) => '> ' + l).join('\n'); if (!pA(`**${a.kind}: ${a.name}**\n${body}\n`)) break; out.push('') }
    add('')
  }

  // 6. directives & corrections
  if (CFG.verbatim && (A.directives.length || A.corrections.length)) {
    add('## Observed directives & corrections (what they ask for / push back on)')
    const pDir = cap(0.18); let n = 0
    for (const d of A.directives) { if (n >= CFG.topDirectives) break; if (pDir(`- 📌 ${clamp(d.text, CFG.perPromptMaxChars)} _(${d.source})_`)) n++ }
    for (const c of A.corrections) { if (n >= CFG.topDirectives) break; if (pDir(`- ✋ ${clamp(c.text, CFG.perPromptMaxChars)} _(${c.source})_`)) n++ }
    add('')
  }

  // 7. recurring topics
  const ents = A.entityRanked.slice(0, CFG.topEntities)
  if (ents.length) { add('## Recurring topics & entities'); cap(0.08)(ents.map(([t, n]) => `${t} (${n})`).join(' · ')); add('') }

  // 8. recent files
  if (A.topFiles.length) { add('## Recent files'); const pF = cap(0.08); for (const f of A.topFiles) if (!pF(`- ${f.key}${f.meta?.useCount ? ` (used ${f.meta.useCount}×)` : ''}`)) break; add('') }

  // 9. recent AI sessions
  if (sessions.length) {
    add('## Recent AI sessions (intent → last ask)')
    const pS = cap(0.16)
    for (const s of sessions.slice(0, 14)) {
      if (!pS(`- **${clamp(s.title, 80)}** _(${s.agent}, ${fmtDate(s.last)}${s.project ? ', ' + basename(s.project) : ''})_`)) break
      if (CFG.verbatim) { pS(`    - intent: ${s.prompts.slice(0, CFG.firstK).map((p) => clamp(p.text, 140)).join(' / ')}`); if (s.prompts.length > CFG.firstK) pS(`    - last: ${s.prompts.slice(-CFG.lastK).map((p) => clamp(p.text, 140)).join(' / ')}`) }
    }
    add('')
  }

  // 10. voice
  if (CFG.verbatim && A.voice.length) {
    add('## Voice samples (verbatim — for emulating their tone; each labeled with its source)')
    // diversify by source so recent agent prompts don't crowd out the human-comms register
    const pV = cap(0.12); let n = 0; const perSrc = new Map()
    for (const v of A.voice) {
      if (n >= CFG.voiceSamples) break
      if (v.source.includes('(other)')) continue  // voice = the user's OWN tone, never other-party text
      const cls = v.source.replace(/-search$/, '')
      if ((perSrc.get(cls) || 0) >= 3) continue
      if (pV(`- "${clamp(v.text, 220)}" _(${v.source})_`)) { n++; bump(perSrc, cls) }
    }
    add('')
  }

  // 11. gaps
  add('## Gaps to interview on (ask these — low/no signal in the scan)')
  add(gaps(A))
  add('')

  // 12. footer CTA
  if (!fdaOn) {
    add('---')
    add(`> _Branch B only._ Grant **Full Disk Access** to also learn: app-usage rhythm (knowledgeC), message/email voice & collaborators, Safari history, Notes, configured accounts. Re-run after granting.`)
  }
  add(`<!-- generated by scripts/onboarding-scan.mjs · ${fdaOn ? 'A+B' : 'B'} · budget ${CFG.tokenBudget}t · window ${CFG.windowDays}d -->`)
  return out.join('\n')
}

function gaps(A) {
  const reText = (re) => A.directives.concat(A.corrections, A.voice).some((p) => re.test(p.text))
  const haveVoiceComms = A.voice.some((v) => /imessage|mail|note/.test(v.source))
  const haveCollab = A.collab.size > 0
  const haveCadence = A.topApps.size > 0 || A.nEvents > 50
  const checks = [
    ['Communication voice for writing (email/social/docs)', !(haveVoiceComms || reText(/email|reply|tweet|post|write|draft|message/i))],
    ['People & collaborators they work with (teammates, clients, reviewers)', !haveCollab],
    ['Daily rhythm & when NOT to interrupt (focus blocks, meetings)', !haveCadence],
    // always genuinely-unknowable from any local corpus:
    ['How much should BlitzOS act on its own vs. ask before acting?', true],
    ['Risk tolerance & what must always be confirmed (sends, deletes, money, deploys)', true],
    ['What is worth doing this quarter?', true]
  ]
  return checks.filter(([, ask]) => ask).map(([q]) => `- ${q}`).join('\n')
}

// The human's NAME, not their handle: "Minjune's MacBook Pro" → "Minjune" (people name their
// Macs possessively by default), else the account full name (`id -F`, when it isn't just the
// login), else the git user.name (often a handle — last resort).
function humanName(facts) {
  const m = String(facts.computerName || '').match(/^(.+?)[’']s\b/)
  if (m && m[1].trim().length >= 2) return m[1].trim()
  const full = String(facts.fullName || '').trim()
  if (full && full.toLowerCase() !== String(process.env.USER || '').toLowerCase()) return full
  return facts.gitName || null
}

// ---- structured JSON (the onboarding board's input) -----------------------------------
// Same distilled sections + the same redaction/caps as the markdown render — never raw ctx.
// Everything here passed through clean()/redact()/clamp() (or hashContact) on its way in.
function buildJson(A, sessions, authored, now, fdaOn) {
  const spanDays = Math.max(1, Math.round((A.tsMax - A.tsMin) / DAY))
  const pairs = (m, n, ka, kb) => topN(m, n).map(([k, v]) => ({ [ka]: k, [kb]: v }))
  const personKind = (label) => (label.startsWith('[contact-') ? 'hashed' : label.startsWith('@') ? 'domain' : 'name')
  // voice: same source-diversity rule as the markdown (≤3 per source class), roomier cap
  const voice = []; const perSrc = new Map()
  for (const v of A.voice) {
    if (voice.length >= CFG.voiceSamples * 2) break
    if (v.source.includes('(other)')) continue
    const cls = v.source.replace(/-search$/, '')
    if ((perSrc.get(cls) || 0) >= 3) continue
    voice.push({ text: clamp(v.text, 220), source: v.source }); bump(perSrc, cls)
  }
  return {
    meta: {
      v: 2, generatedAt: now, fda: fdaOn, spanDays, nText: A.nText, nEvents: A.nEvents,
      fdaLocked: fdaOn ? [] : SOURCES.filter((s) => s.tier === 'fda').map((s) => s.id)
    },
    identity: { name: humanName(A.facts), handle: A.facts.gitName, computer: A.facts.computerName, locale: A.facts.locale, defaultBrowser: A.facts.defaultBrowser },
    cadence: {
      peakHours: topN(A.hours, 3).map(([h]) => +h).sort((a, b) => a - b),
      activeWeekdays: topN(A.weekdays, 3).map(([d]) => WD[d]),
      hours: Object.fromEntries(A.hours), weekdays: Object.fromEntries(A.weekdays),
      punch: Object.fromEntries(A.punch),
      topApps: pairs(A.topApps, 8, 'app', 'secs'),
      appLaunches: pairs(A.appUse, 8, 'app', 'n')
    },
    projects: pairs(A.projects, CFG.topProjects, 'name', 'prompts'),
    repos: [...new Set(A.facts.gitRepos)].slice(0, CFG.topProjects),
    stack: pairs(A.domains, 16, 'name', 'n'),
    domains: topN(A.topDomains, CFG.maxDomains).map(([d, w]) => ({ host: d, w: +(+w).toFixed(2) })),
    tooling: pairs(A.tooling, 16, 'tool', 'n'),
    people: topN(A.collab, 24).map(([label, n]) => ({ label, n, kind: personKind(label), via: A.collabVia.get(label) || null })),
    calendar: { upcoming: A.calendar.upcoming.slice(0, 10), meetingsPerWeek: A.calendar.meetingsPerWeek },
    census: A.census,
    web: (() => {
      const workflow = matchWorkflow(A.topDomains, A.openTabHosts)
      return {
        // web-first = the browser is a primary work surface. Keyed on browser intensity + tool
        // breadth, NOT the absence of dev signal (the old `devSignals < 150` gate excluded every
        // developer — exactly the builders whose work IS the browser). Import is always offered now.
        webFirst: A.visits > 1000 || workflow.length >= 5 || A.openTabHosts.size >= 6,
        visits: A.visits,
        devSignals: A.devText,
        workflow,
        // the live working set (--open-tabs snapshot), grouped by window. null when not captured.
        openTabs: A.openTabs || null
      }
    })(),
    topics: A.entityRanked.slice(0, CFG.topEntities).map(([t, n]) => ({ t, n })),
    directives: A.directives.slice(0, CFG.topDirectives).map((d) => ({ text: clamp(d.text, CFG.perPromptMaxChars), source: d.source })),
    corrections: A.corrections.slice(0, CFG.topDirectives).map((c) => ({ text: clamp(c.text, CFG.perPromptMaxChars), source: c.source })),
    voice,
    sessions: sessions.slice(0, 14).map((s) => ({ title: clamp(s.title, 80), agent: s.agent, last: s.last || 0, project: s.project ? basename(s.project) : null })),
    files: A.topFiles.map((f) => ({ name: f.key, useCount: f.meta?.useCount || 0 })),
    authored: authored.slice(0, 10).map((a) => ({ kind: a.kind, name: a.name, text: clamp(redact(a.text), 600) })),
    facts: {
      dock: A.facts.dockApps.slice(0, 12), installedApps: A.facts.installedApps.length,
      accounts: [...new Set(A.facts.accounts)].slice(0, 12), editorExtensions: A.facts.editorExtensions.slice(0, 16),
      brewLeaves: A.facts.brewLeaves.slice(0, 24), loginItems: A.facts.loginItems.slice(0, 12)
    },
    gaps: gaps(A).split('\n').map((l) => l.replace(/^- /, '')).filter(Boolean)
  }
}

// ---- main ----------------------------------------------------------------------------
const SRC_LABELS = {
  claude: 'your Claude sessions', codex: 'your Codex history', agents: 'other AI agents',
  chromium: 'Chrome history', firefox: 'Firefox history', openTabs: 'your open tabs', spotlight: 'recent files',
  apps: 'installed apps', dock: 'your Dock', loginItems: 'login items',
  defaultBrowser: 'default browser', shell: 'shell history', git: 'git repositories',
  editor: 'editor projects', downloads: 'downloads', census: 'what you make', locale: 'system locale',
  knowledgeC: 'app focus time', safari: 'Safari history', contacts: 'your address book',
  messages: 'Messages cadence', mail: 'Mail correspondents', calendar: 'your calendar',
  notes: 'Notes', accounts: 'configured accounts'
}
function main() {
  parseArgs(process.argv.slice(2))
  const now = Date.now()
  const fdaOn = hasFDA()
  log(`\n● Branch B (always)${fdaOn ? ' + Branch A (FDA granted)' : ' only — FDA OFF'}`)
  const active = SOURCES.filter((src) => src.tier !== 'fda' || fdaOn)
  emitProgress({ phase: 'begin', fda: fdaOn, sources: active.length })
  const ctx = newCtx()
  const timings = []
  let i = 0
  for (const src of active) {
    i++
    emitProgress({ phase: 'source', id: src.id, label: SRC_LABELS[src.id] || src.id, i, n: active.length })
    const before = ctx.text.length + ctx.events.length
    const t0 = Date.now()
    try { src.run(ctx) } catch (e) { log(`! ${src.id} failed: ${(e.message || '').slice(0, 80)}`) }
    timings.push([src.id, Date.now() - t0])
    emitProgress({ phase: 'source-done', id: src.id, i, n: active.length, ms: Date.now() - t0, signals: ctx.text.length + ctx.events.length - before })
  }
  log('\n⏱ per-source ms (slowest first): ' + timings.sort((a, b) => b[1] - a[1]).map(([id, ms]) => `${id} ${ms}`).join(', '))
  if (!ctx.text.length && !ctx.events.length && !ctx.facts.installedApps.length) { emitProgress({ phase: 'done', empty: true, fda: fdaOn }); log('Nothing found to scan.'); process.exit(0) }

  emitProgress({ phase: 'analyze' })
  const A = analyze(ctx, now)
  const sessions = selectSessions(ctx.text, now)
  const authored = selfAuthored(ctx)
  let doc = render(A, sessions, authored, now, fdaOn)
  if (CFG.promptFile) {
    let preamble = ''; try { preamble = readFileSync(CFG.promptFile, 'utf8').trimEnd() } catch (e) { log(`! could not read --prompt ${CFG.promptFile}: ${e.message}`) }
    if (preamble) { const bar = '='.repeat(70); doc = `${preamble}\n\n${bar}\n# SCANNED CONTEXT (your prior — inferences, not facts)\n${bar}\n\n${doc}` }
  }
  if (CFG.json) {
    const payload = JSON.stringify(buildJson(A, sessions, authored, now, fdaOn), null, 2)
    if (CFG.json === '-') process.stdout.write(payload + '\n')
    else { mkdirSync(dirname(CFG.json), { recursive: true }); writeFileSync(CFG.json, payload); log(`✓ wrote scan json → ${CFG.json}`) }
  }
  // if both sinks are stdout, the json already went there — don't interleave two documents
  if (CFG.out === '-') { if (CFG.json !== '-') process.stdout.write(doc + '\n') }
  else { mkdirSync(dirname(CFG.out), { recursive: true }); writeFileSync(CFG.out, doc); log(`\n✓ wrote ${doc.length} chars (~${Math.ceil(doc.length / 4)} tokens) → ${CFG.out}`) }
  emitProgress({ phase: 'done', out: CFG.out, json: CFG.json || null, fda: fdaOn })
}
main()
