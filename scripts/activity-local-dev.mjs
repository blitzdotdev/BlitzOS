#!/usr/bin/env node
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const help = args.includes('--help') || args.includes('-h')
const collectorOnly = args.includes('--collector-only')
const freshOnboarding = args.includes('--fresh-onboarding')
const portArg = args.find((arg) => arg.startsWith('--port='))
const port = Number(portArg?.split('=')[1] || process.env.BLITZ_ACTIVITY_LOCAL_PORT || 8787)
const url = `http://127.0.0.1:${port}`
const key = 'local-dev'
const cfgDir = join(homedir(), '.blitzos')
const cfgPath = join(cfgDir, 'activity-logging.json')
const backupPath = join(cfgDir, 'activity-logging.local-backup.json')

if (help) {
  console.log(`Usage:
  npm run dev:activity
  npm run dev:activity -- --fresh-onboarding
  npm run dev:activity -- --collector-only
  npm run dev:activity -- --port=8788

Starts a local activity collector, temporarily writes ~/.blitzos/activity-logging.json,
and runs npm run dev so sanitized activity events print in this terminal.
`)
  process.exit(0)
}

let priorConfig = null
let hadPriorConfig = false
let child = null
let stopping = false

function restoreConfig() {
  try {
    if (hadPriorConfig && priorConfig != null) {
      writeFileSync(cfgPath, priorConfig)
    } else if (existsSync(cfgPath)) {
      rmSync(cfgPath)
    }
    if (existsSync(backupPath)) rmSync(backupPath)
  } catch {
    /* best effort */
  }
}

function writeLocalConfig() {
  mkdirSync(cfgDir, { recursive: true })
  if (existsSync(cfgPath)) {
    hadPriorConfig = true
    priorConfig = readFileSync(cfgPath, 'utf8')
    writeFileSync(backupPath, priorConfig)
  }
  writeFileSync(cfgPath, JSON.stringify({ url, key }, null, 2) + '\n', { mode: 0o600 })
}

function eventSummary(event) {
  const name = String(event?.name || 'unknown')
  const props = event?.props && typeof event.props === 'object' ? event.props : {}
  const bits = Object.entries(props)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')
  return bits ? `${name}  ${bits}` : name
}

function printBatch(body) {
  const sid = String(body?.sid || 'unknown-session')
  const events = Array.isArray(body?.events) ? body.events : []
  const ts = new Date().toLocaleTimeString()
  console.log(`\n[activity ${ts}] ${events.length} event${events.length === 1 ? '' : 's'} from ${sid}`)
  for (const event of events) console.log(`  - ${eventSummary(event)}`)
}

function stop(code = 0) {
  if (stopping) return
  stopping = true
  try {
    if (child && !child.killed) child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  server.close(() => {
    restoreConfig()
    console.log('\n[activity-local] restored activity logging config')
    process.exit(code)
  })
  setTimeout(() => {
    restoreConfig()
    process.exit(code)
  }, 1500).unref()
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, t: Date.now() }))
    return
  }
  if (req.method !== 'POST' || req.url !== '/ingest/activity') {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* leave empty */
    }
    if (req.headers['x-ingest-key'] !== key) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden' }))
      return
    }
    printBatch(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, events: Array.isArray(body.events) ? body.events.length : 0 }))
  })
})

server.on('error', (error) => {
  console.error(`[activity-local] failed to start ${url}: ${error.message}`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  writeLocalConfig()
  console.log(`[activity-local] listening on ${url}`)
  console.log(`[activity-local] wrote ${cfgPath}`)
  console.log('[activity-local] press Ctrl+C to stop and restore your previous config')
  if (collectorOnly) return

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npmArgs = freshOnboarding ? ['run', 'dev:fresh-onboarding'] : ['run', 'dev']
  const childEnv = { ...process.env }
  if (childEnv.BLITZ_ACTIVITY_LOGGING === '0') delete childEnv.BLITZ_ACTIVITY_LOGGING
  child = spawn(npm, npmArgs, {
    stdio: 'inherit',
    env: childEnv
  })
  child.on('exit', (code) => stop(code || 0))
})

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
process.on('uncaughtException', (error) => {
  console.error(error)
  stop(1)
})
