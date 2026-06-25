// node scripts/agent-trace.mjs [agentId|transcriptPath] [--replay] [--ws <dir>]
//
// LIVE observability for a BlitzOS agent: tails an agent's terminal transcript and prints a clean, timestamped
// tool-call feed with the GAP between calls — so you can watch what the agent is doing and SEE where the time
// goes (the gaps are mostly model-think + round-trips). Default: follows the most-recently-active agent live.
//   --replay   print the existing history once and exit (review a finished run)
//   agentId    e.g. 3  (Main = 0, Agent N = N) — else pass a full path to transcript.jsonl
//
// Source = .blitzos/terminals/<id>/transcript.jsonl (the raw tmux capture: {at, data} JSON lines). We strip
// ANSI, dedupe the TUI's repaint noise, and surface tool invocations (connection_*, Bash, Read, Write, Edit).

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const replay = args.includes('--replay')
const wsFlag = args[args.indexOf('--ws') + 1]
const posit = args.find((a) => !a.startsWith('--') && a !== wsFlag)

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][AB0]|\x1b[<>=78]|[\x00-\x08\x0b-\x1f]/g
const strip = (s) => s.replace(ANSI, '')

// resolve the transcript path: explicit path > agentId in a workspace > most-recently-active agent anywhere
function findTranscripts() {
  const roots = []
  if (wsFlag) roots.push(wsFlag)
  const blitz = join(homedir(), 'Blitz')
  if (existsSync(blitz)) for (const d of readdirSync(blitz)) roots.push(join(blitz, d))
  const out = []
  for (const r of roots) {
    const tdir = join(r, '.blitzos', 'terminals')
    if (!existsSync(tdir)) continue
    for (const id of readdirSync(tdir)) {
      const f = join(tdir, id, 'transcript.jsonl')
      if (existsSync(f)) out.push({ id, path: f, mtime: statSync(f).mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

let transcriptPath
if (posit && posit.endsWith('.jsonl')) transcriptPath = posit
else {
  const all = findTranscripts()
  if (!all.length) {
    console.error('no agent transcripts found under ~/Blitz/*/.blitzos/terminals/ (pass a transcript path or --ws)')
    process.exit(1)
  }
  transcriptPath = posit ? all.find((t) => t.id === String(posit))?.path : all[0].path
  if (!transcriptPath) {
    console.error(`no transcript for agent "${posit}". available: ${all.map((t) => t.id).join(', ')}`)
    process.exit(1)
  }
}

// detect a tool invocation in a stripped TUI frame. Returns [{tool, brief}]. The claude CLI marks tool calls
// with ⏺ / spinner glyphs; we match the tool token + a short following context, and dedupe repaint repeats.
const TOOL = /(connection_[a-z_]+|Bash|Read|Write|Edit|Grep|Glob|WebFetch|Task)\b/g
function toolsIn(text) {
  const hits = []
  let m
  while ((m = TOOL.exec(text))) {
    const brief = text
      .slice(m.index, m.index + 90)
      .replace(/\s+/g, ' ')
      .trim()
    hits.push({ tool: m[1], brief })
  }
  return hits
}

const fmt = (ms) => {
  const d = new Date(ms)
  return d.toTimeString().slice(0, 8)
}
let lastAt = null
const recent = [] // dedupe window of recently-printed briefs
function emit(at, tool, brief) {
  const key = tool + '|' + brief.slice(0, 40)
  if (recent.includes(key)) return
  recent.push(key)
  if (recent.length > 40) recent.shift()
  const gap = lastAt == null ? '' : `+${((at - lastAt) / 1000).toFixed(1)}s`
  // flag the big gaps (where the time actually goes)
  const slow = lastAt != null && at - lastAt > 8000 ? '  ⟵ slow' : ''
  console.log(`${fmt(at)}  ${gap.padStart(8)}  ${tool.padEnd(20)} ${brief.slice(0, 64)}${slow}`)
  lastAt = at
}

function processLines(lines) {
  for (const line of lines) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (!e || !e.at) continue
    for (const { tool, brief } of toolsIn(strip(e.data || ''))) emit(e.at, tool, brief)
  }
}

console.log(`# agent-trace: ${transcriptPath}`)
console.log(`# time      gap       tool                 detail        (gaps ⟵slow = model-think / round-trip)\n`)

const raw = readFileSync(transcriptPath, 'utf8')
const allLines = raw.split('\n').filter(Boolean)
if (replay) {
  processLines(allLines)
  process.exit(0)
}
// live: print the tail of history for context, then poll for appends
processLines(allLines.slice(-200))
let offset = Buffer.byteLength(raw, 'utf8')
let carry = ''
setInterval(() => {
  let size
  try {
    size = statSync(transcriptPath).size
  } catch {
    return
  }
  if (size <= offset) return
  const fd = readFileSync(transcriptPath)
  const chunk = fd.subarray(offset).toString('utf8')
  offset = size
  const text = carry + chunk
  const parts = text.split('\n')
  carry = parts.pop() || ''
  processLines(parts)
}, 500)
