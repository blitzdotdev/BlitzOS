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
