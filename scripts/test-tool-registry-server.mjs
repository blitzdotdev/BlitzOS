// node scripts/test-tool-registry-server.mjs
// Contract test for the tool registry (plans/connection-tool-registry.md, HTTP contract v1). Runs the SAME
// assertion set against BOTH transports — the Cloudflare Worker (worker.mjs, via its fetch handler) and the
// Node dev server (server.mjs, over a real socket) — proving the one-core/two-transports design serves an
// identical contract: GET /v1/tools (metadata only) + GET /v1/tool (full) + /v1/health + the 400/404 cases.

import { server } from '../registry-server/server.mjs'
import worker from '../registry-server/worker.mjs'

let pass = 0
let fail = 0
const ok = (name, cond) => (cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.error('  ✗ ' + name)))

async function runContract(label, get) {
  console.log('— ' + label)
  const health = await get('/v1/health')
  ok(label + ': GET /v1/health -> { ok:true }', health.status === 200 && health.body.ok === true)

  const list = await get('/v1/tools?sourceId=mail.google.com')
  ok(label + ': /v1/tools returns the seeded Gmail entries', list.status === 200 && Array.isArray(list.body.entries) && list.body.entries.some((e) => e.name === 'unread_count'))
  ok(label + ': list entries carry metadata + provenance', list.body.entries.every((e) => e.name && e.kind && e.version && e.contentHash && e.sourceId === 'mail.google.com'))
  ok(label + ': list entries OMIT the code/steps body', list.body.entries.every((e) => e.code === undefined && e.steps === undefined))

  const q = await get('/v1/tools?sourceId=mail.google.com&q=archive')
  ok(label + ': /v1/tools?q= filters by intent', q.status === 200 && q.body.entries.length === 1 && q.body.entries[0].name === 'archive_top')

  const one = await get('/v1/tool?sourceId=mail.google.com&name=unread_count')
  ok(label + ': /v1/tool returns the FULL entry incl. code', one.status === 200 && one.body.entry && typeof one.body.entry.code === 'string' && one.body.entry.code.length > 0)
  ok(label + ': the full entry has a sha256 contentHash', /^sha256:[0-9a-f]+$/.test(one.body.entry.contentHash))

  const docs = await get('/v1/tools?sourceId=docs.google.com')
  ok(label + ': docs seed includes the Sheets variant (shared-host convention)', docs.body.entries.some((e) => e.name === 'read_text_sheets'))

  const missing = await get('/v1/tool?sourceId=mail.google.com&name=nope')
  ok(label + ': /v1/tool 404s for a missing tool', missing.status === 404 && !!missing.body.error)
  const unknownSrc = await get('/v1/tools?sourceId=nowhere.example')
  ok(label + ': /v1/tools for an unknown source -> empty list (not 404)', unknownSrc.status === 200 && unknownSrc.body.entries.length === 0)
  const noSid = await get('/v1/tools')
  ok(label + ': /v1/tools without sourceId -> 400', noSid.status === 400)
}

async function main() {
  // transport 1: the Cloudflare Worker — call its fetch handler directly with a Request (no network needed)
  await runContract('worker', async (p) => {
    const res = await worker.fetch(new Request('https://reg.test' + p, { headers: { accept: 'application/json' } }))
    return { status: res.status, body: await res.json().catch(() => null) }
  })

  // transport 2: the Node dev server — over a real socket on an ephemeral port
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  await runContract('node-server', async (p) => {
    const res = await fetch(base + p, { headers: { accept: 'application/json' } })
    return { status: res.status, body: await res.json().catch(() => null) }
  })
  await new Promise((r) => server.close(r))

  console.log('\n' + (fail ? '✗' : '✓') + ' tool-registry (worker + node): ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
