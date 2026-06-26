// Unit tests for the curated sourceId -> MCP-endpoint route (GET /v1/mcp) on the registry router core.
// Hits route() directly (no http) with the real MCP_ENDPOINTS map: a HIT (Notion), a MISS (random site),
// plus the 400 guard, the prototype-pollution guard, and proof the existing /v1/tools route is untouched.
// Plain node; no electron/browser. Run: node scripts/tests/test-mcp-registry.mjs
import assert from 'node:assert/strict'
import { route } from '../../registry-server/registry-core.mjs'
import { SOURCES, MCP_ENDPOINTS } from '../../registry-server/registry-data.mjs'

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e?.message || e}`)
    process.exitCode = 1
  }
}

// call /v1/mcp via the core router exactly as a transport would.
const mcp = (sourceId) =>
  route(
    { method: 'GET', pathname: '/v1/mcp', searchParams: new URLSearchParams(sourceId == null ? '' : { sourceId }) },
    SOURCES,
    MCP_ENDPOINTS
  )

t('HIT — notion.so resolves to the official MCP endpoint', () => {
  const r = mcp('notion.so')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { sourceId: 'notion.so', endpoint: 'https://mcp.notion.com/mcp' })
})

t('HIT — www.notion.com (apex variant) maps to the same endpoint', () => {
  assert.equal(mcp('www.notion.com').body.endpoint, 'https://mcp.notion.com/mcp')
})

t('HIT — the other seeded providers resolve', () => {
  assert.equal(mcp('sentry.io').body.endpoint, 'https://mcp.sentry.dev/mcp')
  assert.equal(mcp('linear.app').body.endpoint, 'https://mcp.linear.app/mcp')
})

t('MISS — an unmapped source returns endpoint:null (still 200)', () => {
  const r = mcp('example.com')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { sourceId: 'example.com', endpoint: null })
})

t('400 — no sourceId is a bad request', () => {
  const r = mcp(null)
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'sourceId required')
})

t('MISS — prototype keys never leak a member (no per-site logic, own-prop only)', () => {
  for (const k of ['toString', '__proto__', 'hasOwnProperty', 'constructor']) {
    assert.deepEqual(mcp(k).body, { sourceId: k, endpoint: null }, k)
  }
})

t('the core stays MCP-map-agnostic — omitting the map is a clean miss, not a crash', () => {
  const r = route({ method: 'GET', pathname: '/v1/mcp', searchParams: new URLSearchParams({ sourceId: 'notion.so' }) }, SOURCES)
  assert.equal(r.status, 200)
  assert.equal(r.body.endpoint, null)
})

t('REGRESSION — the existing /v1/tools route is untouched (github.com still serves entries)', () => {
  const r = route({ method: 'GET', pathname: '/v1/tools', searchParams: new URLSearchParams({ sourceId: 'github.com' }) }, SOURCES, MCP_ENDPOINTS)
  assert.equal(r.status, 200)
  assert.equal(r.body.sourceId, 'github.com')
  assert.ok(Array.isArray(r.body.entries) && r.body.entries.length > 0, 'github.com tool entries present')
  assert.ok(r.body.entries.every((e) => e.code === undefined && e.steps === undefined), 'list still strips the tool body')
})

console.log(process.exitCode ? `\n${passed} passed, FAILURES above` : `\nall ${passed} passed`)
process.exit(process.exitCode ? 1 : 0)
