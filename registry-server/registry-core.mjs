// The first-party Connection Tool Registry — the PURE routing core (no IO, no transport). ONE core, two thin
// transports bind it: the Cloudflare Worker (worker.mjs, prod) and a Node http server (server.mjs, local dev).
// Contract v1 (plans/connection-tool-registry.md):
//   GET /v1/tools?sourceId=<host|bundleId>&q=<intent?>  -> { sourceId, entries:[ <meta, NO code/steps> ] }
//   GET /v1/tool?sourceId=<...>&name=<...>              -> { entry: <full, incl. code/steps> } | 404 { error }
//   GET /v1/mcp?sourceId=<host>                         -> { sourceId, endpoint:<url>|null }
//   GET /v1/health                                      -> { ok:true }
//
// `sources` is a map { [sourceId]: entries[] } of already-normalized FULL entries (see registry-data.mjs).
// `mcpEndpoints` is a map { [sourceId]: endpointUrl } — the curated MCP map (registry-data.mjs); data only,
// so NO per-site logic lives here, only the generic lookup. Optional (defaults to {}) for tool-only callers.

const meta = ({ code, steps, ...rest }) => rest // strip the body for list responses

// route a parsed request -> { status, body }. Transport-agnostic: callers supply method + URL parts.
export function route({ method, pathname, searchParams }, sources, mcpEndpoints = {}) {
  if (method !== 'GET') return { status: 405, body: { error: 'read-only registry' } }
  if (pathname === '/v1/health') return { status: 200, body: { ok: true } }

  if (pathname === '/v1/tools') {
    const sourceId = searchParams.get('sourceId') || ''
    if (!sourceId) return { status: 400, body: { error: 'sourceId required' } }
    const q = (searchParams.get('q') || '').toLowerCase()
    let entries = (sources[sourceId] || []).map(meta)
    if (q) entries = entries.filter((e) => (e.name + ' ' + e.description).toLowerCase().includes(q))
    return { status: 200, body: { sourceId, entries } }
  }

  if (pathname === '/v1/tool') {
    const sourceId = searchParams.get('sourceId') || ''
    const name = searchParams.get('name') || ''
    if (!sourceId || !name) return { status: 400, body: { error: 'sourceId and name required' } }
    const entry = (sources[sourceId] || []).find((e) => e.name === name)
    if (!entry) return { status: 404, body: { error: `no tool "${name}" for ${sourceId}` } }
    return { status: 200, body: { entry } }
  }

  if (pathname === '/v1/mcp') {
    const sourceId = searchParams.get('sourceId') || ''
    if (!sourceId) return { status: 400, body: { error: 'sourceId required' } }
    // own-property lookup so a key like "toString"/"__proto__" can't resolve a prototype member.
    const endpoint = Object.prototype.hasOwnProperty.call(mcpEndpoints, sourceId) ? mcpEndpoints[sourceId] : null
    return { status: 200, body: { sourceId, endpoint } }
  }

  return { status: 404, body: { error: 'not found' } }
}
