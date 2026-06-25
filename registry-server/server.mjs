// The first-party Connection Tool Registry — the NODE http transport (LOCAL DEV only; prod is the Cloudflare
// Worker, worker.mjs). Thin wrapper over the SAME router core + vetted data the Worker uses (no parallel impl).
// Run: node registry-server/server.mjs   (PORT env, default 7700). Point BlitzOS at it with
// BLITZ_TOOL_REGISTRY_URL=http://127.0.0.1:7700.

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { route } from './registry-core.mjs'
import { SOURCES, MCP_ENDPOINTS } from './registry-data.mjs'

const PORT = Number(process.env.PORT) || 7700
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' }

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    return res.end()
  }
  let url
  try {
    url = new URL(req.url, 'http://x')
  } catch {
    res.writeHead(400, { 'content-type': 'application/json', ...CORS })
    return res.end('{"error":"bad url"}')
  }
  const { status, body } = route({ method: req.method, pathname: url.pathname, searchParams: url.searchParams }, SOURCES, MCP_ENDPOINTS)
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...CORS })
  res.end(s)
})

// auto-listen ONLY when run directly — exact entry-point match (a substring check would also catch the test
// file, which is itself named *server.mjs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, '127.0.0.1', () => console.log(`[tool-registry] http://127.0.0.1:${PORT} — ${Object.keys(SOURCES).length} vetted source(s)`))
}

export { server, SOURCES }
