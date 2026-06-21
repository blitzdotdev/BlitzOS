// node scripts/test-tool-registry-server.mjs
// Contract test for the standalone tool-registry server (registry-server/server.mjs): drives the REAL HTTP
// routes over a real socket against the bundled seed files, asserting the v1 contract
// (plans/connection-tool-registry.md): GET /v1/tools (metadata only) + GET /v1/tool (full) + /v1/health + 404s.

import { server } from '../registry-server/server.mjs'

let pass = 0
let fail = 0
const ok = (name, cond) => (cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.error('  ✗ ' + name)))

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const get = async (p) => {
    const res = await fetch(base + p, { headers: { accept: 'application/json' } })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  const health = await get('/v1/health')
  ok('GET /v1/health -> { ok:true }', health.status === 200 && health.body.ok === true)

  const list = await get('/v1/tools?sourceId=mail.google.com')
  ok('GET /v1/tools returns the seeded Gmail entries', list.status === 200 && Array.isArray(list.body.entries) && list.body.entries.some((e) => e.name === 'unread_count'))
  ok('list entries carry metadata + provenance', list.body.entries.every((e) => e.name && e.kind && e.version && e.contentHash && e.sourceId === 'mail.google.com'))
  ok('list entries OMIT the code/steps body', list.body.entries.every((e) => e.code === undefined && e.steps === undefined))

  const q = await get('/v1/tools?sourceId=mail.google.com&q=archive')
  ok('GET /v1/tools?q= filters by intent', q.status === 200 && q.body.entries.length === 1 && q.body.entries[0].name === 'archive_top')

  const one = await get('/v1/tool?sourceId=mail.google.com&name=unread_count')
  ok('GET /v1/tool returns the FULL entry incl. code', one.status === 200 && one.body.entry && typeof one.body.entry.code === 'string' && one.body.entry.code.length > 0)
  ok('the full entry has a sha256 contentHash', /^sha256:/.test(one.body.entry.contentHash))

  const docs = await get('/v1/tools?sourceId=docs.google.com')
  ok('docs.google.com seed includes the Sheets variant (shared-host convention)', docs.body.entries.some((e) => e.name === 'read_text_sheets'))

  const missing = await get('/v1/tool?sourceId=mail.google.com&name=nope')
  ok('GET /v1/tool 404s for a missing tool', missing.status === 404 && !!missing.body.error)
  const unknownSrc = await get('/v1/tools?sourceId=nowhere.example')
  ok('GET /v1/tools for an unknown source -> empty list (not 404)', unknownSrc.status === 200 && unknownSrc.body.entries.length === 0)
  const noSid = await get('/v1/tools')
  ok('GET /v1/tools without sourceId -> 400', noSid.status === 400)

  await new Promise((r) => server.close(r))
  console.log('\n' + (fail ? '✗' : '✓') + ' tool-registry server: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
