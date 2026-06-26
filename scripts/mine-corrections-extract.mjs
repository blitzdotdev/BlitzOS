#!/usr/bin/env node
// Preprocessor for "mine my corrections" workflow.
// Reads the N most-recent Claude Code session .jsonl files for THIS repo and
// extracts ONLY the genuine human-typed turns (promptSource typed|queued),
// each with a short snippet of the assistant text immediately preceding it for
// context. Writes one compact .md per session + a manifest.json the workflow
// fans out over. Tool outputs / system reminders / sidechain turns are dropped.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const PROJ = '/Users/minjunes/.claude/projects/-Users-minjunes-superapp-teenybase-agent-os'
const OUT = '/Users/minjunes/superapp/teenybase/agent-os/tmp/correction-mining'
const SESS_DIR = path.join(OUT, 'sessions')
const N = Number(process.argv[2] || 50)

fs.mkdirSync(SESS_DIR, { recursive: true })

// Most-recent N .jsonl by mtime.
const files = fs.readdirSync(PROJ)
  .filter(f => f.endsWith('.jsonl'))
  .map(f => ({ f, m: fs.statSync(path.join(PROJ, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)
  .slice(0, N)

// Strip injected scaffolding the user did not type.
function clean(text) {
  if (!text) return ''
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim()
}

// Pull readable text out of a message.content (string | array of blocks).
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
  }
  return ''
}

const manifest = []

for (let i = 0; i < files.length; i++) {
  const { f } = files[i]
  const full = path.join(PROJ, f)
  const id = f.replace('.jsonl', '')
  const short = id.slice(0, 8)

  const turns = []
  let lastAssistant = ''
  let firstTs = null
  let lastTs = null

  const rl = readline.createInterface({ input: fs.createReadStream(full), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.timestamp) { if (!firstTs) firstTs = o.timestamp; lastTs = o.timestamp }

    if (o.type === 'assistant' && o.isSidechain !== true) {
      const t = textOf(o.message?.content)
      if (t && t.trim()) lastAssistant = t.trim()
      continue
    }
    if (o.type === 'user' && o.isSidechain !== true) {
      const src = o.promptSource
      if (src !== 'typed' && src !== 'queued') continue // genuine human turns only
      const raw = clean(textOf(o.message?.content))
      if (!raw) continue
      // Skip pure slash-command invocations with no extra text.
      turns.push({
        ts: o.timestamp || null,
        source: src,
        prior: lastAssistant ? lastAssistant.slice(0, 600) : '',
        text: raw,
      })
    }
  }

  if (turns.length === 0) continue

  // Render compact markdown for this session.
  const idx = String(manifest.length + 1).padStart(2, '0')
  const fname = `${idx}-${short}.md`
  const date = (firstTs || '').slice(0, 10)
  let md = `# Session ${short}  (${date})  — ${turns.length} human turns\n`
  md += `session_id: ${id}\n\n`
  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t]
    md += `## turn ${t + 1}  [${turn.source}]  ${(turn.ts || '').slice(0, 19)}\n`
    if (turn.prior) {
      const p = turn.prior.replace(/\n+/g, ' ').slice(0, 400)
      md += `_prior assistant_: ${p}\n\n`
    }
    md += `**USER:** ${turn.text}\n\n`
  }
  fs.writeFileSync(path.join(SESS_DIR, fname), md)

  manifest.push({
    file: fname,
    session_id: id,
    short,
    date,
    turns: turns.length,
    bytes: Buffer.byteLength(md),
  })
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))

const totalTurns = manifest.reduce((s, m) => s + m.turns, 0)
const totalBytes = manifest.reduce((s, m) => s + m.bytes, 0)
console.log(`sessions with human turns: ${manifest.length}/${files.length}`)
console.log(`total human turns: ${totalTurns}`)
console.log(`total extracted size: ${(totalBytes / 1024).toFixed(0)} KB`)
console.log(`output: ${SESS_DIR}`)
console.log('turns per session (sorted desc):')
console.log(manifest.slice().sort((a, b) => b.turns - a.turns).map(m => `  ${m.file}  ${m.turns}t  ${m.date}`).join('\n'))
