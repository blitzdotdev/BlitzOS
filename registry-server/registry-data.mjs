// The vetted tool data — the SINGLE source of truth, shared by both transports (worker.mjs + server.mjs).
// Each source is a tools/<sourceId>.json file authors only write { name, description, kind, code|steps }; we
// fill sourceId + version + provenance + contentHash here. Adding a vetted source = drop a JSON + add it below.
// contentHash uses Web Crypto (crypto.subtle) so it is identical in Node and Cloudflare Workers (no node:crypto,
// no compat flags). Writes are internal (edit these files + redeploy); there is NO community submission path.

import mail from './tools/mail.google.com.json' with { type: 'json' }
import docs from './tools/docs.google.com.json' with { type: 'json' }
import github from './tools/github.com.json' with { type: 'json' }

const enc = new TextEncoder()
async function contentHash(entry) {
  const body = entry.steps != null ? JSON.stringify(entry.steps) : String(entry.code || '')
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(body))
  return 'sha256:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
async function normalize(sourceId, arr) {
  if (!Array.isArray(arr)) return []
  return Promise.all(
    arr.map(async (e) => ({
      name: String(e.name),
      description: String(e.description || ''),
      kind: e.kind === 'act' ? 'act' : 'read',
      ...(e.steps != null ? { steps: e.steps } : { code: String(e.code || '') }),
      sourceId,
      version: e.version != null ? String(e.version) : '1',
      contentHash: e.contentHash || (await contentHash(e)),
      vettedBy: e.vettedBy || 'blitz',
      vettedAt: e.vettedAt || ''
    }))
  )
}

// normalized at module load (top-level await; supported in Node ESM + Workers)
export const SOURCES = {
  'mail.google.com': await normalize('mail.google.com', mail),
  'docs.google.com': await normalize('docs.google.com', docs),
  'github.com': await normalize('github.com', github)
}

// Curated sourceId -> official MCP endpoint map (served at GET /v1/mcp?sourceId=). Seeds the detection cascade's
// tier-2 for sources that don't self-advertise /.well-known/mcp.json (plans/blitzos-mcp-connections.md). Each
// entry is a DCR-capable provider (its authorization server exposes registration_endpoint, so BlitzOS can
// self-register with no manually-created app — DCR-only is the V1 scope). A miss returns endpoint:null; the
// broker still confirms DCR-eligibility live against the endpoint's metadata before any OAuth. This is DATA
// only — no per-site logic lives in registry-core.mjs. Adding a vetted provider = add a line here (+ redeploy).
// Both the apex and the canonical app/api host map to the same endpoint (a connected tab can report either).
export const MCP_ENDPOINTS = {
  // Notion — DCR proven live 2026-06-22 (POST https://mcp.notion.com/register returned a client_id, no pre-reg).
  'www.notion.com': 'https://mcp.notion.com/mcp',
  'notion.so': 'https://mcp.notion.com/mcp',
  'www.notion.so': 'https://mcp.notion.com/mcp',
  // Sentry — official remote MCP (sentry.dev), DCR-capable.
  'sentry.io': 'https://mcp.sentry.dev/mcp',
  // Linear — official remote MCP, DCR-capable.
  'linear.app': 'https://mcp.linear.app/mcp'
}
