// #51 — fuzz + behavior test for the provider capability core (the SSRF boundary). Pure Node.
import {
  PROVIDER_SPECS,
  validatePath,
  matchRoute,
  buildUrl,
  redact,
  safeHeaders,
  resourceRoute,
  listResourceNames,
  capturedScopes
} from '../src/main/provider-specs.mjs'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}

console.log('validatePath — rejects hostile paths:')
const bad = [
  '', 'user', // no leading slash
  '//evil.com/x', // protocol-relative
  '/..%2f..%2fadmin', // encoded traversal
  '/../../etc', // raw traversal
  '/foo\\bar', // backslash
  '/foo?x=1', // query in path
  '/foo#frag', // fragment
  '/a\x00b', // NUL
  '/a\nb', // newline (the bug class that broke this very file)
  '/a\x7fb' // DEL
]
for (const p of bad) ok(`rejects ${JSON.stringify(p)}`, validatePath(p) !== null, validatePath(p))
console.log('validatePath — accepts legit paths:')
for (const p of ['/user', '/user/repos', '/repos/my-org/my-repo', '/repos/o/r/issues/1/comments', '/rest/api/3/issue/PROJ-1', '/conversations.history', '/users/@me/guilds']) {
  ok(`accepts ${p}`, validatePath(p) === null, validatePath(p))
}
// '@' in a path is allowed (Discord /users/@me) but CANNOT escape the host — buildUrl stays on-allowlist.
ok("buildUrl('/users/@me/guilds') stays on discord.com", buildUrl(PROVIDER_SPECS.discord, '/users/@me/guilds', null, { secrets: { access_token: 't' } }).host === 'discord.com', buildUrl(PROVIDER_SPECS.discord, '/users/@me/guilds', null, { secrets: { access_token: 't' } }))

console.log('\nbuildUrl — host confinement (the SSRF gate):')
const gh = PROVIDER_SPECS.github
ok('github /user/repos → api.github.com', buildUrl(gh, '/user/repos', { per_page: '10' }, { secrets: { access_token: 't' } }).host === 'api.github.com')
ok('github query is applied + key-validated', buildUrl(gh, '/user/repos', { per_page: '10' }, {}).url.includes('per_page=10'))
ok('github bad query key rejected', !!buildUrl(gh, '/user', { 'bad key': '1' }, {}).error)
// Every hostile path that slipped a validatePath gap must STILL fail to leave the allowlisted host.
for (const p of ['//evil.com', '/..%2f..%2f@evil.com', '/\\evil', '/foo@bar.com']) {
  const r = buildUrl(gh, p, null, {})
  ok(`buildUrl rejects hostile path ${JSON.stringify(p)} (no host escape)`, !!r.error || r.host === 'api.github.com', r)
}
// jira base needs the cloudId from the record; missing → fail closed.
const jira = PROVIDER_SPECS.jira
ok('jira with cloudId → api.atlassian.com', buildUrl(jira, '/rest/api/3/search', null, { secrets: { cloudId: 'C1', access_token: 't' } }).host === 'api.atlassian.com')
ok('jira without cloudId fails closed (502)', buildUrl(jira, '/rest/api/3/search', null, { secrets: {} }).code === 502)

console.log('\nmatchRoute — reads broad, writes enumerated:')
ok('github GET /user/repos → resource (seed)', matchRoute(gh, 'GET', '/user/repos')?.kind === 'resource')
ok('github GET /repos/o/r → read (prefix)', matchRoute(gh, 'GET', '/repos/o/r')?.kind === 'read')
ok('github GET deep sub-path → read (broad prefix)', matchRoute(gh, 'GET', '/repos/o/r/issues/1/comments')?.kind === 'read')
ok('github GET unknown path → null (no arbitrary read)', matchRoute(gh, 'GET', '/admin/keys') === null)
ok('github POST /repos/o/r/issues → write', matchRoute(gh, 'POST', '/repos/o/r/issues')?.kind === 'write')
ok('github DELETE /repos/o/r → destructive', matchRoute(gh, 'DELETE', '/repos/o/r')?.kind === 'destructive')
ok('github POST unknown write path → null (no arbitrary write)', matchRoute(gh, 'POST', '/repos/o/r/anything-else') === null)
const gm = PROVIDER_SPECS.gmail
ok('gmail GET messages list → read', matchRoute(gm, 'GET', '/gmail/v1/users/me/messages')?.kind === 'read')
const msg = matchRoute(gm, 'GET', '/gmail/v1/users/me/messages/abc123')
ok('gmail GET a message BODY → read + sensitive flag', msg?.kind === 'read' && msg?.sensitive === true, msg)

console.log('\nredact — default-deny credential filter:')
const red = redact({ items: [{ name: 'r1' }], access_token: 'SECRET', nested: { refresh_token: 'X', ok: 1, webhook_url: 'http://h' }, api_key: 'K' })
ok('strips access_token / api_key at top level', red.access_token === undefined && red.api_key === undefined)
ok('strips token-shaped keys at depth (refresh_token, webhook_url)', red.nested.refresh_token === undefined && red.nested.webhook_url === undefined)
ok('keeps non-credential data (items, nested.ok)', Array.isArray(red.items) && red.nested.ok === 1)

console.log('\nsafeHeaders — caller cannot inject auth:')
const hdrs = safeHeaders(gh, { accept: 'application/json', authorization: 'Bearer EVIL', cookie: 'x=1', 'x-github-api-version': '2022-11-28' })
ok('keeps allowlisted (accept, x-github-api-version)', hdrs.accept === 'application/json' && hdrs['x-github-api-version'] === '2022-11-28')
ok('drops authorization + cookie (no injection)', hdrs.authorization === undefined && hdrs.cookie === undefined)

console.log('\nshim lookups (PROVIDER_DATA replacement):')
ok('resourceRoute github/repos exists + carries normalize', typeof resourceRoute('github', 'repos')?.normalize === 'function')
ok('resourceRoute discord/guilds exists', !!resourceRoute('discord', 'guilds'))
ok('listResourceNames includes the 2 seed resources', listResourceNames().includes('github/repos') && listResourceNames().includes('discord/guilds'))

console.log('\ncapturedScopes — granted scopes recorded at connect:')
ok('github "repo, read:user" → ["read:user","repo"]', JSON.stringify(capturedScopes({ scope: 'repo, read:user' }).sort()) === JSON.stringify(['read:user', 'repo']))
ok('slack authed_user.scope captured', capturedScopes({ authed_user: { scope: 'channels:history,users:read' } }).includes('channels:history'))
ok('google space-separated scope', capturedScopes({ scope: 'openid https://www.googleapis.com/auth/gmail.readonly' }).includes('https://www.googleapis.com/auth/gmail.readonly'))
ok('empty secrets → []', capturedScopes({}).length === 0)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
