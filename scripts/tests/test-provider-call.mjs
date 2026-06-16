// #51 — unit test for the callProvider ENGINE (mock fetch + injected clock). Pure Node.
import { callProvider, callProviderGated, createApprovalLedger, createRateLimiter } from '../../src/main/provider-call.mjs'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}
const resp = (status, jsonObj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(jsonObj) })
const makeFetch = (handler) => {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    return handler(url, opts)
  }
  fn.calls = calls
  return fn
}
const clock = { t: 1_000_000 }
const now = () => clock.t

const ghRec = { secrets: { access_token: 'GH-TOKEN' }, grantedScopes: ['repo'] }
const gmRec = { secrets: { access_token: 'GM-TOKEN' }, grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'] }

console.log('reads — token injected server-side, never leaked; caller auth stripped; response redacted:')
{
  const f = makeFetch(() => resp(200, { login: 'me', access_token: 'SHOULD-BE-REDACTED', items: [1, 2] }))
  const r = await callProvider(
    { provider: 'github', method: 'GET', path: '/user/repos', headers: { authorization: 'Bearer EVIL', accept: 'application/json' }, caller: { kind: 'agent', transport: 'relay' } },
    { record: ghRec, fetchImpl: f, now }
  )
  ok('read ok', r.ok && r.status === 200, r)
  ok('OS-injected Authorization is the real token', f.calls[0].opts.headers.authorization === 'Bearer GH-TOKEN', f.calls[0].opts.headers.authorization)
  ok('caller-supplied authorization is dropped (no injection)', f.calls[0].opts.headers.authorization !== 'Bearer EVIL')
  ok('response redacted (access_token stripped, items kept)', r.data.access_token === undefined && Array.isArray(r.data.items))
  ok('no token string anywhere in the returned object', !JSON.stringify(r).includes('GH-TOKEN'))
}

console.log('\nscope pre-flight — a write without the granted scope fails BEFORE any fetch:')
{
  const f = makeFetch(() => resp(200, {}))
  const r = await callProvider(
    { provider: 'gmail', method: 'POST', path: '/gmail/v1/users/me/messages/send', body: { raw: 'x' }, caller: { kind: 'agent', transport: 'relay' } },
    { record: gmRec, approvals: createApprovalLedger(), fetchImpl: f, now }
  )
  ok('gmail send → scope_insufficient', r.code === 'scope_insufficient', r)
  ok('no fetch attempted on a scope failure', f.calls.length === 0)
}

console.log('\nwrites execute directly — the human-approval gate was REMOVED (no token round-trip):')
{
  const f = makeFetch(() => resp(201, { number: 7 }))
  const base = { provider: 'github', method: 'POST', path: '/repos/o/r/issues', body: { title: 'A' }, caller: { kind: 'agent', transport: 'relay' } }
  const r = await callProvider(base, { record: ghRec, fetchImpl: f, now })
  ok('a write executes with no approval token', r.ok && r.status === 201, r)
  ok('fetch called once with the real token + POST', f.calls.length === 1 && f.calls[0].opts.method === 'POST' && f.calls[0].opts.headers.authorization === 'Bearer GH-TOKEN')
}

console.log('\ntransport + capability ceilings:')
{
  const f = makeFetch(() => resp(200, {}))
  const r = await callProvider(
    { provider: 'github', method: 'POST', path: '/repos/o/r/issues', body: { title: 'x' }, caller: { kind: 'agent', transport: 'server' } },
    { record: ghRec, fetchImpl: f, now }
  )
  ok('server-mode write EXECUTES (parity with Electron — block removed)', r.ok && f.calls.length === 1, r)
  const rw = await callProvider(
    { provider: 'github', method: 'POST', path: '/repos/o/r/issues', body: { t: 1 }, caller: { kind: 'widget', surfaceId: 's' } },
    { record: ghRec, approvals: createApprovalLedger(), fetchImpl: f, now }
  )
  ok('widget cannot write → forbidden', rw.code === 'forbidden')
  const ru = await callProvider({ provider: 'github', method: 'GET', path: '/admin/keys', caller: { kind: 'agent' } }, { record: ghRec, fetchImpl: f, now })
  ok('unknown read path → no_route', ru.code === 'no_route')
  const rn = await callProvider({ provider: 'nope', method: 'GET', path: '/x', caller: { kind: 'agent' } }, { record: ghRec, fetchImpl: f, now })
  ok('unknown provider → unknown_provider', rn.code === 'unknown_provider')
  const rc = await callProvider({ provider: 'github', method: 'GET', path: '/user', caller: { kind: 'agent' } }, { record: null, fetchImpl: f, now })
  ok('not connected → not_connected', rc.code === 'not_connected')
}

console.log('\nsensitive read consent + redirect block + rate limit:')
{
  const f = makeFetch(() => resp(200, { snippet: 'x' }))
  const sens = { provider: 'gmail', method: 'GET', path: '/gmail/v1/users/me/messages/abc', caller: { kind: 'agent', transport: 'relay' } }
  const r1 = await callProvider(sens, { record: gmRec, fetchImpl: f, now })
  ok('sensitive read executes directly — consent gate REMOVED', r1.ok && f.calls.length === 1, r1)

  const fr = makeFetch(() => ({ ok: false, status: 302, text: async () => '' }))
  const rr = await callProvider({ provider: 'github', method: 'GET', path: '/user', caller: { kind: 'agent' } }, { record: ghRec, fetchImpl: fr, now })
  ok('a 3xx is blocked, not followed', rr.code === 'redirect_blocked', rr)

  const rate = createRateLimiter({ writePerMin: 5 })
  let lastWrite
  for (let i = 0; i < 7; i++) {
    lastWrite = await callProvider({ provider: 'github', method: 'POST', path: '/repos/o/r/issues', body: { n: i }, caller: { kind: 'agent', transport: 'relay' } }, { record: ghRec, rate, fetchImpl: makeFetch(() => resp(201, {})), now })
  }
  ok('write rate limit (5/min) still trips → rate_limited (rate-limit is not consent/approval)', lastWrite.code === 'rate_limited', lastWrite)
}

console.log('\naudit hook fires for every call:')
{
  const entries = []
  await callProvider({ provider: 'github', method: 'GET', path: '/user', caller: { kind: 'agent', transport: 'relay' } }, { record: ghRec, fetchImpl: makeFetch(() => resp(200, {})), now, audit: (e) => entries.push(e) })
  ok('audit entry recorded with decision/status/provider', entries.length === 1 && entries[0].decision === 'ok' && entries[0].provider === 'github', entries)
}

console.log('\ncallProviderGated — approval round-trip removed; it now just executes the call:')
{
  const f = makeFetch(() => resp(201, { number: 9 }))
  const write = { provider: 'github', method: 'POST', path: '/repos/o/r/issues', body: { title: 'Z' }, caller: { kind: 'agent', transport: 'localhost' } }
  const r = await callProviderGated(write, { record: ghRec, fetchImpl: f, now })
  ok('gated write executes (no approval needed)', r.ok && r.status === 201 && f.calls.length === 1, r)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
