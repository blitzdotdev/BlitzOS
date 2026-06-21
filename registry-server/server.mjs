// The first-party Connection Tool Registry — a STANDALONE, open-read HTTP service we host + vet.
// Plan/contract: plans/connection-tool-registry.md (HTTP contract v1). Clients (BlitzOS, all transports) only
// READ; writes are internal (the vetted seed files in ./tools/<sourceId>.json). No community submission.
//
//   GET /v1/tools?sourceId=<host|bundleId>&q=<intent?>  -> { sourceId, entries:[ <meta, NO code/steps> ] }
//   GET /v1/tool?sourceId=<...>&name=<...>              -> { entry: <full, incl. code/steps> } | 404 { error }
//   GET /v1/health                                      -> { ok:true }
//
// Run: node registry-server/server.mjs   (PORT env, default 7700). Point BlitzOS at it with
// BLITZ_TOOL_REGISTRY_URL=http://127.0.0.1:7700.

import { createServer } from 'node:http'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = process.env.BLITZ_REGISTRY_TOOLS_DIR || join(HERE, 'tools')
const PORT = Number(process.env.PORT) || 7700

const contentHash = (entry) =>
  'sha256:' + createHash('sha256').update(entry.steps != null ? JSON.stringify(entry.steps) : String(entry.code || '')).digest('hex').slice(0, 16)

// A source's vetted entries live in tools/<safe>.json. The file may set fields per entry; we fill sourceId +
// contentHash + version defaults at serve time so authors only write name/description/kind/code|steps.
function loadSource(sourceId) {
  const safe = String(sourceId).replace(/[^a-zA-Z0-9._-]+/g, '_')
  const f = join(TOOLS_DIR, safe + '.json')
  if (!existsSync(f)) return []
  let arr
  try {
    arr = JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr.map((e) => ({
    name: String(e.name),
    description: String(e.description || ''),
    kind: e.kind === 'act' ? 'act' : 'read',
    ...(e.steps != null ? { steps: e.steps } : { code: String(e.code || '') }),
    sourceId: String(sourceId),
    version: e.version != null ? String(e.version) : '1',
    contentHash: e.contentHash || contentHash(e),
    vettedBy: e.vettedBy || 'blitz',
    vettedAt: e.vettedAt || ''
  }))
}
const meta = ({ code, steps, ...rest }) => rest // strip the body for list responses

const send = (res, status, obj) => {
  const s = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

const server = createServer((req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'read-only registry' })
  let url
  try {
    url = new URL(req.url, 'http://x')
  } catch {
    return send(res, 400, { error: 'bad url' })
  }
  const p = url.pathname
  if (p === '/v1/health') return send(res, 200, { ok: true })

  if (p === '/v1/tools') {
    const sourceId = url.searchParams.get('sourceId') || ''
    if (!sourceId) return send(res, 400, { error: 'sourceId required' })
    const q = (url.searchParams.get('q') || '').toLowerCase()
    let entries = loadSource(sourceId).map(meta)
    if (q) entries = entries.filter((e) => (e.name + ' ' + e.description).toLowerCase().includes(q))
    return send(res, 200, { sourceId, entries })
  }

  if (p === '/v1/tool') {
    const sourceId = url.searchParams.get('sourceId') || ''
    const name = url.searchParams.get('name') || ''
    if (!sourceId || !name) return send(res, 400, { error: 'sourceId and name required' })
    const entry = loadSource(sourceId).find((e) => e.name === name)
    if (!entry) return send(res, 404, { error: `no tool "${name}" for ${sourceId}` })
    return send(res, 200, { entry })
  }

  return send(res, 404, { error: 'not found' })
})

// auto-listen ONLY when run directly (node registry-server/server.mjs) — not when imported by a test, which
// drives its own listen on an ephemeral port. Exact entry-point match (a substring check would also match the
// test file, which is itself named *server.mjs).
const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isEntry) {
  const known = existsSync(TOOLS_DIR) ? readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.json')).length : 0
  server.listen(PORT, '127.0.0.1', () => console.log(`[tool-registry] http://127.0.0.1:${PORT} — ${known} vetted source(s) from ${TOOLS_DIR}`))
}

export { server, loadSource, contentHash }
