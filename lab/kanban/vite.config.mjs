// Kanban lab dev server. Vite (React HMR for the board) + an /api middleware that runs REAL example blitzscripts
// (../../src/main/blitzscript via workflow-host.mjs) and streams their live WfEvents to the board. Every run is
// RECORDED to .runs/<runId>.json for instant replay while iterating on the UI.
//
// IMPORTANT: workflow-host is imported LAZILY with a computed file: URL (host() below), so Vite's esbuild config
// loader never tries to BUNDLE the blitzscript runtime (which has a `#!` shebang in run.mjs that esbuild rejects).
// Plain Node import() at request time handles the shebang fine and spawns the `claude -p` leaves via child_process.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

// Capture the per-leaf record (prompt + typed result + claude session_id) for the drill-in views. The agent runs
// in THIS process, so setting the env here turns on agent.mjs's opt-in capture for every lab run.
process.env.BLITZ_CAPTURE_LEAVES = '1'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXAMPLES = resolve(__dirname, '../../src/main/blitzscript/examples/claude_workflows')
const RUNS = join(__dirname, '.runs')
const FIXTURES = join(__dirname, 'fixtures')
const WS = join(__dirname, '.workspace')
mkdirSync(RUNS, { recursive: true })
mkdirSync(WS, { recursive: true })

// Lazy, NON-bundled load of the real runner (computed specifier → esbuild leaves it a runtime import).
let _host = null
async function host() {
  if (_host) return _host
  const spec = pathToFileURL(resolve(__dirname, '../../src/main/workflow-host.mjs')).href
  const mod = await import(/* @vite-ignore */ spec)
  mod.wireWorkflowHost({ getWorkspacePath: () => WS }) // memDirs land under the lab workspace; nothing real is touched
  _host = mod
  return _host
}

const runMeta = new Map() // runId -> { script, started }
const json = (res, code, body) => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}
const readBody = (req) =>
  new Promise((r) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      try {
        r(b ? JSON.parse(b) : {})
      } catch {
        r({})
      }
    })
  })
const listScripts = () =>
  readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.js'))
    .sort((a, b) => (a === 'wf-demo.js' ? -1 : b === 'wf-demo.js' ? 1 : a.localeCompare(b))) // wf-demo first (the fast one)

// ── per-leaf drill-in: the captured record (prompt + typed result) + the leaf's claude session rollout ──
const leafDir = (runId) => join(WS, '.blitzos', 'workflows', String(runId), 'leaves')
function readLeaf(runId, nodeId) {
  const f = join(leafDir(runId), String(nodeId) + '.json')
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
  } catch {
    return null
  }
}
// Find a `claude -p` session rollout by its session id (named <id>.jsonl under ~/.claude/projects/<encoded-cwd>/).
function findRollout(sessionId) {
  if (!sessionId) return null
  const root = join(homedir(), '.claude', 'projects')
  try {
    for (const proj of readdirSync(root)) {
      const f = join(root, proj, sessionId + '.jsonl')
      if (existsSync(f)) return f
    }
  } catch {
    /* no rollouts dir */
  }
  return null
}
const blockText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x.text || '')).join('\n') : '')
const shortInput = (input) => {
  try {
    const s = JSON.stringify(input)
    return s.length > 220 ? s.slice(0, 219) + '…' : s
  } catch {
    return ''
  }
}
// Parse a claude session rollout into a readable timeline: the leaf's text turns, tool calls, and tool results.
function parseRollout(file, max = 240) {
  const steps = []
  let ask = ''
  let lines = []
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return { steps, ask }
  }
  for (const line of lines) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const msg = e.message || e
    const role = e.type || msg.role
    const content = msg && msg.content
    if (role === 'user') {
      if (typeof content === 'string') {
        if (!ask) ask = content
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text' && !ask) ask = b.text
          else if (b.type === 'tool_result') steps.push({ kind: 'result', text: blockText(b.content).slice(0, 1400) })
        }
      }
    } else if (role === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text && b.text.trim()) steps.push({ kind: 'text', text: b.text })
        else if (b.type === 'tool_use') steps.push({ kind: 'tool', name: b.name, input: shortInput(b.input) })
      }
    }
    if (steps.length >= max) break
  }
  return { steps, ask }
}

function apiPlugin() {
  return {
    name: 'kanban-lab-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const u = new URL(req.url, 'http://localhost')
        if (!u.pathname.startsWith('/api/')) return next()
        try {
          if (u.pathname === '/api/scripts') {
            return json(res, 200, { scripts: listScripts().map((name) => ({ name, demo: name === 'wf-demo.js' })) })
          }
          if (u.pathname === '/api/run' && req.method === 'POST') {
            const body = await readBody(req)
            const name = String(body.script || '')
            if (!listScripts().includes(name)) return json(res, 400, { error: 'unknown script' })
            const file = join(EXAMPLES, name)
            const h = await host()
            // 1. DRY PREFLIGHT: the full structural skeleton (every leaf, label + phase), instant + no LLM. Per-run
            //    `dry` flag, so it never affects the real run. Best-effort — the live run still works without it.
            let skeleton = []
            try {
              const dry = await h.runWorkflowHosted({ file, dry: true })
              if (dry.ok) {
                await new Promise((done) => {
                  const t0 = Date.now()
                  const t = setInterval(() => {
                    if (h.isDone(dry.runId) || Date.now() - t0 > 8000) {
                      clearInterval(t)
                      done()
                    }
                  }, 25)
                })
                skeleton = h.snapshot(dry.runId)
              }
            } catch { /* preflight is best-effort */ }
            // 2. REAL RUN.
            const r = await h.runWorkflowHosted({ file })
            if (!r.ok) return json(res, 500, { error: r.error || 'run failed to start' })
            runMeta.set(r.runId, { script: name, started: Date.now() })
            const off = h.subscribe(r.runId, (ev) => {
              if (ev.type === 'run:done') {
                try {
                  writeFileSync(join(RUNS, r.runId + '.json'), JSON.stringify({ meta: { ...(runMeta.get(r.runId) || {}), runId: r.runId }, events: h.snapshot(r.runId), skeleton }))
                } catch { /* best-effort */ }
                off()
              }
            })
            return json(res, 200, { runId: r.runId, script: name, skeleton })
          }
          if (u.pathname === '/api/events') {
            const runId = u.searchParams.get('runId')
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
            res.write('retry: 2000\n\n')
            const h = await host()
            const send = (ev) => {
              try {
                res.write('data: ' + JSON.stringify(ev) + '\n\n')
              } catch { /* socket gone */ }
            }
            const off = h.subscribe(runId, send)
            if (h.isDone(runId)) setTimeout(() => res.end(), 200)
            req.on('close', () => off())
            return
          }
          if (u.pathname === '/api/recordings') {
            const recs = []
            if (existsSync(join(FIXTURES, 'sample-run.json'))) recs.push({ id: 'fixture:sample-run', label: 'sample (synthetic seed)', fixture: true })
            for (const f of readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
              let label = f
              try {
                const m = JSON.parse(readFileSync(join(RUNS, f), 'utf8')).meta || {}
                label = (m.script || f) + ' · ' + new Date(m.started || statSync(join(RUNS, f)).mtimeMs).toLocaleTimeString()
              } catch { /* keep filename */ }
              recs.push({ id: f.replace(/\.json$/, ''), label, mtime: statSync(join(RUNS, f)).mtimeMs })
            }
            recs.sort((a, b) => (b.mtime || Infinity) - (a.mtime || Infinity))
            return json(res, 200, { recordings: recs })
          }
          if (u.pathname === '/api/recording') {
            const id = u.searchParams.get('id') || ''
            const path = id.startsWith('fixture:') ? join(FIXTURES, id.slice('fixture:'.length) + '.json') : join(RUNS, id + '.json')
            if (!existsSync(path)) return json(res, 404, { error: 'not found' })
            const data = JSON.parse(readFileSync(path, 'utf8'))
            return json(res, 200, { events: data.events || data, meta: data.meta || {}, skeleton: data.skeleton || [] })
          }
          // The captured per-leaf record (prompt + typed result + tokens/ms/status). Drives the human output + drawer.
          if (u.pathname === '/api/leaf') {
            const rec = readLeaf(u.searchParams.get('runId'), u.searchParams.get('nodeId'))
            if (!rec) return json(res, 404, { error: 'no leaf record (capture pending or this leaf has not finished)' })
            return json(res, 200, { leaf: rec })
          }
          // The leaf's full session ("Did"): resolve its claude rollout by session id + parse to a timeline.
          if (u.pathname === '/api/leaf-session') {
            const rec = readLeaf(u.searchParams.get('runId'), u.searchParams.get('nodeId'))
            if (!rec) return json(res, 404, { error: 'no leaf record' })
            const file = findRollout(rec.sessionId)
            if (!file) return json(res, 200, { ask: rec.prompt || '', steps: [], note: 'no rollout file for this session id' })
            const parsed = parseRollout(file)
            return json(res, 200, { ask: parsed.ask || rec.prompt || '', steps: parsed.steps, sessionId: rec.sessionId })
          }
          return json(res, 404, { error: 'no route' })
        } catch (e) {
          return json(res, 500, { error: String((e && e.message) || e) })
        }
      })
    }
  }
}

export default defineConfig({
  root: __dirname,
  plugins: [react(), apiPlugin()],
  server: { port: 5180, strictPort: false }
})
