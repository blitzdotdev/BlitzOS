#!/usr/bin/env node
// Push telemetry/{teenybase.ts,worker.ts} to the blitz.dev project — the backend is
// infra-as-code in THIS repo; the deployed project is reproducible from here at any time.
//
//   node scripts/telemetry-push.mjs                push both files, print build results
//   node scripts/telemetry-push.mjs --commit       ...then commit (applies @migration.sql)
//   node scripts/telemetry-push.mjs --secret NAME=VALUE   set a project secret
//
// Credentials come from ~/.blitzos/telemetry-project.json (the anon-create response, which
// contains agent_link). Never committed; provision a fresh project with:
//   curl -X POST 'https://blitz.dev/api/v1/new-project/<slug>?template=empty' | tee ~/.blitzos/telemetry-project.json
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const proj = JSON.parse(readFileSync(join(homedir(), '.blitzos', 'telemetry-project.json'), 'utf8'))
const token = proj.agent_link.match(/\/agent\/([^/]+)\//)?.[1]
const slug = proj.slug
if (!token || !slug) throw new Error('bad telemetry-project.json (need agent_link + slug)')
const BASE = `https://blitz.dev/api/v1/projects/${slug}`
const H = { Authorization: `Bearer ${token}` }

async function req(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...H, ...headers }, body })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 400) }
  }
  return { status: res.status, json }
}

async function pushFile(name) {
  const content = readFileSync(join(here, '..', 'telemetry', name), 'utf8')
  const cur = await req('GET', `/files?path=${name}`)
  const etag = cur.json?.result?.etag ?? '0'
  const r = await req('PUT', `/files?path=${name}`, content, { 'If-Match': String(etag), 'Content-Type': 'text/plain' })
  const cfg = r.json?.result?.config
  const bun = r.json?.result?.bundle
  console.log(`[push] ${name}: HTTP ${r.status} config.ok=${cfg?.ok} bundle.ok=${bun?.ok}`)
  for (const line of [...(cfg?.output || []), ...(bun?.output || [])]) console.log('   ', line)
  if (r.status >= 400 || cfg?.ok === false || bun?.ok === false) process.exitCode = 1
  return r.json?.result
}

const args = process.argv.slice(2)
const si = args.indexOf('--secret')
if (si >= 0) {
  const [name, ...rest] = args[si + 1].split('=')
  const r = await req('PUT', `/secrets/${name}`, JSON.stringify({ value: rest.join('=') }), { 'Content-Type': 'application/json' })
  console.log(`[secret] ${name}: HTTP ${r.status}`, JSON.stringify(r.json).slice(0, 200))
  process.exit(r.status < 400 ? 0 : 1)
}

await pushFile('teenybase.ts')
await pushFile('worker.ts')

if (args.includes('--commit') && process.exitCode !== 1) {
  const r = await req('POST', '/commit', JSON.stringify({ message: `telemetry backend push ${new Date().toISOString()}` }), {
    'Content-Type': 'application/json'
  })
  console.log(`[commit] HTTP ${r.status}`, JSON.stringify(r.json).slice(0, 300))
  if (r.status >= 400) process.exitCode = 1
}
