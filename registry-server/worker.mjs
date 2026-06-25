// The first-party Connection Tool Registry as a CLOUDFLARE WORKER (prod transport). Thin wrapper over the shared
// router core + vetted data. Open read (vetted tools are first-party + non-secret); CORS-permissive so a future
// in-app browse UI can read it too. Writes are internal (edit registry-data's seeds + redeploy). Deploy:
//   cd registry-server && npx wrangler deploy        (config: wrangler.toml)
// Point BlitzOS at it with BLITZ_TOOL_REGISTRY_URL=https://<your-worker-domain>.

import { route } from './registry-core.mjs'
import { SOURCES, MCP_ENDPOINTS } from './registry-data.mjs'

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' }

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    const url = new URL(request.url)
    const { status, body } = route({ method: request.method, pathname: url.pathname, searchParams: url.searchParams }, SOURCES, MCP_ENDPOINTS)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } })
  }
}
