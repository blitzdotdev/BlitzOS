#!/usr/bin/env node
// Local-first agent helper: calls localhost with bearer auth, falls back to relay when the local route is absent.
// Run: node scripts/tests/test-agent-call-helper.mjs
import { CALL_SCRIPT } from '../../src/main/agent-runtime.mjs'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const listen = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, url: `http://127.0.0.1:${addr.port}` })
    })
  })

let localCalls = 0
const local = await listen((req, res) => {
  if (req.headers.authorization !== 'Bearer local-token') {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  if (req.method === 'GET' && req.url === '/tools.json') {
    localCalls++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ tools: [{ path: '/list_state' }] }))
    return
  }
  if (req.method === 'POST' && req.url === '/list_state') {
    localCalls++
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, via: 'local', body: JSON.parse(body || '{}') }))
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

let relayCalls = 0
const relay = await listen((req, res) => {
  if (req.method === 'POST' && req.url === '/missing') {
    relayCalls++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, via: 'relay' }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'relay not found' }))
})

try {
  const root = mkdtempSync(join(tmpdir(), 'blitz-call-helper-'))
  const blitzDir = join(root, '.blitzos')
  mkdirSync(blitzDir, { recursive: true })
  const script = join(blitzDir, 'call.sh')
  const sessionFile = join(root, 'session.json')
  writeFileSync(script, CALL_SCRIPT)
  chmodSync(script, 0o755)
  writeFileSync(sessionFile, JSON.stringify({ app: 'BlitzOS', local: { url: local.url, token: 'local-token' } }))
  writeFileSync(join(blitzDir, 'relay-url'), relay.url)

  const env = { ...process.env, BLITZOS_SESSION_JSON: sessionFile }
  const runHelper = async (args) => {
    const out = await execFileP('bash', [script, ...args], { cwd: root, env, encoding: 'utf8', timeout: 8000 })
    return out.stdout
  }

  const localOut = await runHelper(['list_state', '{"agent":"1"}'])
  const localJson = JSON.parse(localOut)
  ok('POST tools prefer localhost', localJson.via === 'local' && localJson.body.agent === '1')

  const toolsOut = await runHelper(['tools.json'])
  const toolsJson = JSON.parse(toolsOut)
  ok('GET tools.json is served through localhost', Array.isArray(toolsJson.tools) && toolsJson.tools[0]?.path === '/list_state')

  const fallbackOut = await runHelper(['missing', '{}'])
  const fallbackJson = JSON.parse(fallbackOut)
  ok('local 404 falls back to relay', fallbackJson.via === 'relay')
  ok('local and relay were both exercised', localCalls >= 2 && relayCalls === 1, `local=${localCalls} relay=${relayCalls}`)
} finally {
  local.server.close()
  relay.server.close()
}

if (failed) {
  console.error(`\n✗ ${failed} failed`)
  process.exit(1)
}
console.log('\n✓ agent call helper test passed')
