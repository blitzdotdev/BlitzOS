// test-agent-transcript.mjs — deterministic test of the canonical transcript reader (src/main/agent-transcript.mjs):
// the jsonl path encoding, the tool_use → structured row mapping (Grep/Edit/Run + the +added −removed delta), the
// text/result normalization, the narrator digest, and offset resume. No LLM, no network. Run: node scripts/test-agent-transcript.mjs
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sessionJsonlPath, readSessionEvents, toolRow, toolLabel, digestForNarrator } from '../src/main/agent-transcript.mjs'

let failures = 0
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
}

console.log('Canonical transcript reader:')

// ── 1. jsonl path encoding (cwd → -encoded-, under CLAUDE_CONFIG_DIR/projects) ──────────────────────────────────
const cfg = mkdtempSync(join(tmpdir(), 'claude-cfg-'))
process.env.CLAUDE_CONFIG_DIR = cfg
const wsRoot = '/Users/x/Blitz/case-file'
const sid = 'sess-123'
const encoded = wsRoot.replace(/[/.]/g, '-') // -Users-x-Blitz-case-file
const projDir = join(cfg, 'projects', encoded)
mkdirSync(projDir, { recursive: true })
const jsonl = join(projDir, `${sid}.jsonl`)

const records = [
  { type: 'assistant', timestamp: '2026-06-19T00:00:01Z', message: { content: [
    { type: 'text', text: 'Mapping the call sites.' },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'requireSession', path: 'src/' } }
  ] } },
  { type: 'assistant', timestamp: '2026-06-19T00:00:02Z', message: { content: [
    { type: 'tool_use', name: 'Edit', input: { file_path: '/x/src/main/session.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd\ne' } }
  ] } },
  { type: 'user', timestamp: '2026-06-19T00:00:03Z', message: { content: [{ type: 'tool_result', is_error: false }] } },
  { type: 'assistant', timestamp: '2026-06-19T00:00:04Z', message: { content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'npm run typecheck', description: 'typecheck' } }
  ] } }
]
writeFileSync(jsonl, records.map((r) => JSON.stringify(r)).join('\n') + '\n')

ok('sessionJsonlPath encodes the cwd (/ and . → -) and finds the file under CLAUDE_CONFIG_DIR/projects',
  sessionJsonlPath(wsRoot, sid) === jsonl, sessionJsonlPath(wsRoot, sid))
ok('sessionJsonlPath returns null for a missing session', sessionJsonlPath(wsRoot, 'nope') === null)

// ── 2. tool_use → structured row + label ────────────────────────────────────────────────────────────────────────
const grep = toolRow('Grep', { pattern: 'requireSession', path: 'src/' })
ok('Grep → verb/target/detail', grep.verb === 'Grep' && grep.target === 'requireSession' && grep.detail === 'src/', grep)
const edit = toolRow('Edit', { file_path: '/x/src/main/session.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd\ne' })
// new has a,B,c,d,e; old has a,b,c → added {B,d,e}=3, removed {b}=1
ok('Edit → basename target + a +added −removed delta', edit.verb === 'Edit' && edit.target === 'session.ts' && edit.detail === '+3 −1', edit)
ok('Bash → "Run" + description', toolLabel(toolRow('Bash', { command: 'npm run typecheck', description: 'typecheck' })) === 'Run typecheck')
ok('toolLabel joins verb + target + detail', toolLabel(edit) === 'Edit session.ts +3 −1', toolLabel(edit))

// ── 3. readSessionEvents normalization ──────────────────────────────────────────────────────────────────────────
const { events, offset } = readSessionEvents(jsonl, 0)
const tools = events.filter((e) => e.kind === 'tool')
ok('reads text + tool + result events', events.some((e) => e.kind === 'text') && tools.length === 3 && events.some((e) => e.kind === 'result'))
ok('tools are Grep, Edit, Bash in order', tools.map((t) => t.name).join(',') === 'Grep,Edit,Bash', tools.map((t) => t.name))
ok('offset advances to the file size', offset > 0)

// ── 4. narrator digest (trimmed, human-ish lines) ───────────────────────────────────────────────────────────────
const digest = digestForNarrator(events)
ok('digest includes the tool labels + the say text', /Grep requireSession/.test(digest) && /Run typecheck/.test(digest) && /\(says\) Mapping the call sites/.test(digest), digest)

// ── 5. offset resume: only NEW events after appending ───────────────────────────────────────────────────────────
appendFileSync(jsonl, JSON.stringify({ type: 'assistant', timestamp: '2026-06-19T00:00:05Z', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/y/auth.ts' } }] } }) + '\n')
const resumed = readSessionEvents(jsonl, offset)
ok('resume from offset returns ONLY the new event (Read)', resumed.events.length === 1 && resumed.events[0].name === 'Read', resumed.events)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
