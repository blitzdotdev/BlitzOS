// Export a BlitzOS agent's Claude Code session (the raw JSONL) as human-readable markdown, so you can
// read EXACTLY how the agent reasoned (thinking + text + every tool call + results) and judge whether it
// behaved like a founder or an assistant.
//
// Usage:
//   node scripts/export-agent-session.mjs                      # auto: the Home agent's current session
//   node scripts/export-agent-session.mjs <sessionId>          # a specific session id (searched under ~/.claude/projects)
//   node scripts/export-agent-session.mjs <path.jsonl> [out.md]
//
// Output (default): agent-os/tmp/agent-sessions/<id>.md  (tmp/ is gitignored — transcripts hold scanned
// personal data, never commit them). Thinking + text + say() messages are kept FULL; tool inputs/results
// are truncated to keep the file readable. Open the .md in JetBrains.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROJECTS = join(homedir(), '.claude', 'projects')

function resolveJsonl(arg) {
  if (arg && arg.endsWith('.jsonl') && existsSync(arg)) return arg
  if (arg) {
    const name = arg.endsWith('.jsonl') ? arg : arg + '.jsonl'
    for (const d of readdirSync(PROJECTS)) {
      const p = join(PROJECTS, d, name)
      if (existsSync(p)) return p
    }
  }
  // auto: the Home agent's current claudeSessionId (override the workspace with BLITZ_ONBOARDING_WS)
  try {
    const wsDir = process.env.BLITZ_ONBOARDING_WS || join(homedir(), 'Blitz', 'Home')
    const meta = JSON.parse(readFileSync(join(wsDir, '.blitzos', 'terminals', '0', 'meta.json'), 'utf8'))
    for (const d of readdirSync(PROJECTS)) {
      const p = join(PROJECTS, d, meta.claudeSessionId + '.jsonl')
      if (existsSync(p)) return p
    }
  } catch { /* no meta */ }
  return null
}

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + ` …[+${s.length - n} chars]` : s }
const ts = (t) => { try { return new Date(t).toISOString().replace('T', ' ').replace(/\..*/, '') } catch { return '' } }

// A tool_use rendered to show INTENT without dumping huge inputs. say/curl text is the agent talking to
// the user — keep it readable; Bash shows the command; Write/Edit show path + a snippet.
function renderTool(name, input) {
  const i = input || {}
  if (name === 'Bash') {
    const cmd = String(i.command || '')
    // surface a /say payload (the agent's actual chat message) in full-ish
    const say = cmd.match(/\/say['"]?\s+-d\s+'([^']*)'/) || cmd.match(/\/say.*?text"?\s*:\s*"([\s\S]*?)"\s*[},]/)
    if (say) return `Bash → /say: ${clip(say[1], 1200)}`
    return `Bash: ${clip(cmd, 600)}${i.description ? `   # ${clip(i.description, 100)}` : ''}`
  }
  if (name === 'Write') return `Write ${i.file_path}\n      ${clip((i.content || '').split('\n').slice(0, 4).join('\n      '), 400)}`
  if (name === 'Edit') return `Edit ${i.file_path}`
  if (name === 'Read') return `Read ${i.file_path}${i.offset ? ` @${i.offset}` : ''}`
  if (name === 'TodoWrite') return `TodoWrite: ${clip(JSON.stringify(i.todos || i), 600)}`
  return `${name}: ${clip(JSON.stringify(i), 500)}`
}

function main() {
  const jsonl = resolveJsonl(process.argv[2])
  if (!jsonl) { console.error('no session found (pass a sessionId or .jsonl path)'); process.exit(1) }
  const id = jsonl.split('/').pop().replace('.jsonl', '')
  const out = process.argv[3] || join(process.cwd(), 'tmp', 'agent-sessions', id + '.md')

  const lines = readFileSync(jsonl, 'utf8').split('\n').filter(Boolean)
  const md = []
  const stat = { assistant: 0, user: 0, thinking: 0, tools: {}, says: 0 }
  let first = '', last = ''

  for (const line of lines) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    const t = d.timestamp ? ts(d.timestamp) : ''
    if (d.timestamp) { if (!first) first = t; last = t }
    const msg = d.message
    if (d.type === 'user' && msg) {
      const c = msg.content
      if (typeof c === 'string') {
        if (c.startsWith('<') && c.includes('system-reminder')) continue // skip reminder noise
        stat.user++
        md.push(`\n\n──────── [${t}] 🧑 USER ────────\n${clip(c, 4000)}`)
      } else if (Array.isArray(c)) {
        const results = c.filter((x) => x.type === 'tool_result')
        const texts = c.filter((x) => x.type === 'text')
        for (const r of results) {
          const body = typeof r.content === 'string' ? r.content : Array.isArray(r.content) ? r.content.map((x) => x.text || '').join('') : JSON.stringify(r.content)
          md.push(`\n   ⤷ result: ${clip(body, 500)}`)
        }
        for (const x of texts) { stat.user++; md.push(`\n\n──────── [${t}] 🧑 USER ────────\n${clip(x.text, 4000)}`) }
      }
    } else if (d.type === 'assistant' && msg && Array.isArray(msg.content)) {
      stat.assistant++
      const head = `\n\n━━━━━━━━ [${t}] 🤖 AGENT ━━━━━━━━`
      let pushedHead = false
      const ensureHead = () => { if (!pushedHead) { md.push(head); pushedHead = true } }
      for (const b of msg.content) {
        if (b.type === 'thinking') {
          stat.thinking++; ensureHead()
          // Claude Code persists only the thinking SIGNATURE (for context replay), not the plaintext, in
          // headless agent sessions — so b.thinking is usually ''. Mark it so the reader knows the agent
          // DID reason here, but the text is not recoverable from the transcript.
          md.push(b.thinking ? `\n💭 THINKING:\n${b.thinking}` : `\n💭 [thought here — text not persisted by Claude Code; signature only]`)
        }
        else if (b.type === 'text' && b.text?.trim()) { ensureHead(); md.push(`\n📝 ${b.text}`) }
        else if (b.type === 'tool_use') {
          stat.tools[b.name] = (stat.tools[b.name] || 0) + 1
          const rendered = renderTool(b.name, b.input)
          if (rendered.includes('/say')) stat.says++
          ensureHead(); md.push(`\n🔧 ${rendered}`)
        }
      }
    }
  }

  const toolSummary = Object.entries(stat.tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')
  const header = [
    `# Agent session ${id}`,
    `Source: ${jsonl}`,
    `Span: ${first} → ${last}`,
    `Turns: ${stat.assistant} agent / ${stat.user} user · thinking blocks: ${stat.thinking} · say()-to-user: ${stat.says}`,
    `Tool calls: ${toolSummary}`,
    `\n> Read top-to-bottom. 💭 = the agent's private reasoning, 🔧 = an action, 📝 = visible text.`,
    `> Look for: where it STOPS pushing, where it asks instead of acts, where it narrows scope.`,
    ''
  ].join('\n')

  mkdirSync(join(out, '..'), { recursive: true })
  writeFileSync(out, header + md.join(''))
  console.log(`wrote ${out}`)
  console.log(`  ${stat.assistant} agent turns, ${stat.thinking} thinking blocks, ${stat.says} say()s`)
  console.log(`  tools: ${toolSummary}`)
}
main()
