// capabilities.mjs — probe THIS machine for the blitzscript harness/model/effort matrix the
// orchestrator agent needs to author llm() calls. DYNAMIC by necessity: which CLIs are installed,
// which models the account can access, and which effort each model takes all vary per machine (a
// model your plan lacks 404s — see the live `fable` case). The orchestrators duty injects
// formatCapabilities() at launch; the agent can also re-run `blitz capabilities`. See the plan.
import { execFile } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { harnesses, CLAUDE_EFFORTS } from './harnesses.mjs'

const exec = (cmd, args, timeout = 4000) =>
  new Promise((res) => {
    try { execFile(cmd, args, { timeout }, (e, out, err) => res({ ok: !e, out: String(out || ''), err: String(err || '') })) }
    catch { res({ ok: false, out: '', err: 'spawn failed' }) }
  })

const uniq = (a) => [...new Set(a)]
const tryJson = (s) => { try { return JSON.parse(s) } catch { return null } }
const readSafe = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }

// ── codex model/effort enumeration ──────────────────────────────────────────────────────────────
// codex exposes NO `models` command and its config holds only the default, so we enumerate the FULL
// set from codex's own machine data: the config default + models/efforts seen in recent session
// rollouts (payload.model / payload.effort) + the global-state upgrade list. A model your account
// lacks still 404s at call time — llm() rethrows it.
const EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
function orderEfforts(list) {
  const set = new Set(list)
  return EFFORT_LADDER.filter((e) => set.has(e)) // ladder-only; junk efforts (e.g. from a polluted session) are dropped
}
function headOfFile(path, maxBytes = 65536) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return buf.toString('utf8', 0, n)
  } catch { return '' } finally { if (fd !== undefined) { try { closeSync(fd) } catch { /* ignore */ } } }
}
function walkModelEffort(o, models, efforts) {
  if (!o || typeof o !== 'object') return
  if (Array.isArray(o)) { for (const x of o) walkModelEffort(x, models, efforts); return }
  for (const [k, v] of Object.entries(o)) {
    const kl = k.toLowerCase()
    if ((kl === 'model' || kl === 'model_slug') && typeof v === 'string') models.add(v)
    if (kl.includes('effort') && typeof v === 'string') efforts.add(v)
    walkModelEffort(v, models, efforts)
  }
}
function mineCodexUsage(home) {
  const models = new Set(), efforts = new Set()
  // Sample recent files from EACH dir SEPARATELY: archived_sessions holds the older runs (where the
  // varied efforts live), and a merged slice would be dominated by recent (all-default-effort) sessions.
  for (const d of [join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')]) {
    if (!existsSync(d)) continue
    let files = []
    try { for (const rel of readdirSync(d, { recursive: true })) { const p = String(rel); if (p.endsWith('.jsonl')) files.push(join(d, p)) } }
    catch { continue }
    files.sort() // rollout paths embed the date -> roughly oldest->newest
    for (const f of files.slice(-400)) {                 // recent ~400 PER dir (the effort variety is deeper in history)
      const lines = headOfFile(f).split('\n')
      for (let i = 0; i < Math.min(lines.length, 12); i++) { // session_meta + early turn events carry model+effort
        const obj = tryJson(lines[i].trim()); if (obj) walkModelEffort(obj, models, efforts) // a truncated last line just fails to parse -> skipped
      }
    }
  }
  return { models: [...models], efforts: [...efforts] }
}
function codexUpgradeListModels(home) {
  const d = tryJson(readSafe(join(home, '.codex', '.codex-global-state.json')))
  const list = d && d['electron-persisted-atom-state'] && d['electron-persisted-atom-state']['seen-model-upgrade-list']
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
}

// A registered harness is a STUB if its build() throws the not-implemented error (pi / opencode).
function isStub(name) {
  try { harnesses[name].build('probe', {}); return false }
  catch (e) { return /not implemented|stub/i.test(String(e && e.message)) }
}

async function probeClaude() {
  const v = await exec('claude', ['--version'])
  if (!v.ok) return { available: false, reason: 'claude not runnable on PATH' }
  const help = (await exec('claude', ['-p', '--help'])).out
  // Aliases shown in the --model help block ('fable','opus','sonnet'); merge with the curated
  // known-good set (haiku worked live but is NOT in claude's help examples).
  const modelBlock = (help.match(/--model[\s\S]*?(?=\n\s*--|\n\n)/) || [''])[0]
  const helpAliases = [...modelBlock.matchAll(/'([a-z][a-z0-9]+)'/g)].map((m) => m[1])
  const models = uniq(['haiku', 'sonnet', 'opus', ...helpAliases])
  // Effort from the --effort help line, else the lib's authoritative CLAUDE_EFFORTS.
  const em = help.match(/Effort level[^(]*\(([^)]+)\)/i)
  const effort = em ? em[1].split(/[,\s]+/).filter(Boolean) : [...CLAUDE_EFFORTS]
  return {
    available: true, version: v.out.trim(), models, cheap: 'haiku', strong: 'opus', effort,
    note: 'model aliases; account access varies (a model your plan lacks throws a 404 and llm() rethrows it). haiku ignores --effort.',
  }
}

async function probeCodex() {
  const v = await exec('codex', ['--version'])
  if (!v.ok) return { available: false, reason: 'codex not runnable on PATH' }
  const home = homedir()
  // config default (the only thing config.toml actually holds).
  let cfgModel = null, cfgEffort = null
  const cfgPath = join(home, '.codex', 'config.toml')
  if (existsSync(cfgPath)) {
    const cfg = readFileSync(cfgPath, 'utf8')
    cfgModel = (cfg.match(/^[ \t]*model[ \t]*=[ \t]*"?([^"\n]+)"?/m) || [])[1]?.trim() || null
    cfgEffort = (cfg.match(/^[ \t]*model_reasoning_effort[ \t]*=[ \t]*"?([^"\n]+)"?/m) || [])[1]?.trim() || null
  }
  // FULL set: config default + models/efforts seen in recent sessions + the upgrade list.
  const mined = mineCodexUsage(home)
  // Mined models come from raw session history, so filter junk: a prior bad-model attempt (a typo'd
  // `-c model=…`) lands in the rollouts. A real model id contains a digit or a known vendor prefix.
  const plausible = (m) => /\d/.test(m) || /^(gpt|o\d|claude|codex|gemini|llama|mistral|qwen)/i.test(m)
  const models = uniq([cfgModel, ...mined.models.filter(plausible), ...codexUpgradeListModels(home)].filter(Boolean)).sort()
  const effort = orderEfforts(uniq([cfgEffort, ...mined.efforts].filter(Boolean)))
  const strong = models.filter((m) => m !== cfgModel).sort().at(-1) || cfgModel // newest non-default seen
  return {
    available: true, version: v.out.trim(),
    models, configDefaultModel: cfgModel, cheap: cfgModel, strong,
    effort, configDefaultEffort: cfgEffort,
    note: 'enumerated from codex config + recent sessions + the upgrade list on this machine; pass any model id your codex account supports (-c model=…). effort = model_reasoning_effort (model-dependent). Omit model/effort to use ~/.codex/config.toml.',
  }
}

export async function capabilities() {
  const out = {}
  for (const name of Object.keys(harnesses)) {
    if (isStub(name)) { out[name] = { available: false, reason: 'harness not implemented yet (stub)' }; continue }
    if (name === 'claude') out[name] = await probeClaude()
    else if (name === 'codex') out[name] = await probeCodex()
    else out[name] = { available: false, reason: 'no probe for this harness' }
  }
  return { probedAt: new Date().toISOString(), harnesses: out }
}

// The exact TEXT the orchestrator agent sees (injected into its duty / printed by `blitz capabilities`).
export function formatCapabilities(caps) {
  const L = []
  L.push('# blitzscript harnesses available on this machine')
  L.push('Author llm(prompt, { harness, model, effort, cwd }) using ONLY these. Account access varies:')
  L.push('llm() THROWS if you pass a model your account cannot use, so prefer the `cheap` alias and retry')
  L.push("on error. Omit `model`/`effort` to use each harness's own configured default.")
  L.push('')
  for (const [name, h] of Object.entries(caps.harnesses)) {
    if (!h.available) { L.push(`## ${name} — UNAVAILABLE (${h.reason})`); L.push(''); continue }
    L.push(`## ${name}   ${h.version}`)
    L.push(`   models:  ${h.models.join(', ') || '(use the configured default)'}${h.configDefaultModel ? `   [default: ${h.configDefaultModel}]` : ''}`)
    L.push(`   cheap=${h.cheap ?? '?'}   strong=${h.strong ?? '?'}`)
    L.push(`   effort:  ${h.effort.join(' | ') || '(model default)'}${h.configDefaultEffort ? `   [default: ${h.configDefaultEffort}]` : ''}`)
    L.push(`   note:    ${h.note}`)
    L.push('')
  }
  L.push(`(probed ${caps.probedAt})`)
  return L.join('\n')
}
