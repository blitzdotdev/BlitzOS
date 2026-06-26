// Tests for src/main/mcp-detect.mjs — the MCP detection cascade + DCR filter + TTL cache.
//
// Two layers:
//  - OFFLINE (always run, deterministic): an injected fake fetch exercises every branch — well-known hit,
//    SPA HTML-200 rejection (the x.com trap), registry tier-2, AS-metadata + DCR discrimination, the
//    protected-resource path suffix, and the per-sourceId TTL cache with an injected clock.
//  - LIVE (run when the network is reachable): the two cases the task names — www.notion.com is
//    available + dcr + endpoint includes mcp.notion.com; x.com is not available. If the network is down
//    these are reported SKIP (not FAIL) so the suite still proves the logic headlessly.
//
// Plain node, no electron/browser. PASS/FAIL printed; exit non-zero on any FAIL.
import assert from 'node:assert/strict'
import { detectMcp, clearDetectCache } from '../../src/main/mcp-detect.mjs'

let passed = 0
let failed = 0
let skipped = 0

function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  PASS  ${name}`) })
    .catch((e) => { failed++; console.error(`  FAIL  ${name}\n        ${e?.message || e}`) })
}
function skip(name, why) { skipped++; console.log(`  SKIP  ${name}  (${why})`) }

// ---- a tiny scriptable fetch: map url -> { status?, ct?, body } (string or object) ----
function makeFetch(routes, counter) {
  return async function fakeFetch(url) {
    if (counter) counter.calls.push(url)
    const r = routes[url]
    if (!r) return mkRes(404, 'text/html', '<!doctype html>not found')
    const status = r.status ?? 200
    const ct = r.ct ?? 'application/json'
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return mkRes(status, ct, body)
  }
}
function mkRes(status, ct, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) },
    text: async () => body,
  }
}

async function runOffline() {
  console.log('\n[offline / injected fetch]')

  // 1) Full happy path: well-known endpoint -> protected-resource (path suffix) -> AS meta with DCR.
  await t('well-known -> protected-resource -> AS meta (DCR) => available + dcr', async () => {
    clearDetectCache()
    const routes = {
      'https://acme.test/.well-known/mcp.json': { body: { name: 'Acme', endpoint: 'https://mcp.acme.test/mcp' } },
      // path-aware protected-resource (RFC 9728) is tried first:
      'https://mcp.acme.test/.well-known/oauth-protected-resource/mcp': {
        body: { resource: 'https://mcp.acme.test/mcp', authorization_servers: ['https://mcp.acme.test'], scopes_supported: ['read', 'write'] },
      },
      'https://mcp.acme.test/.well-known/oauth-authorization-server': {
        body: { issuer: 'https://mcp.acme.test', authorization_endpoint: 'https://mcp.acme.test/authorize', token_endpoint: 'https://mcp.acme.test/token', registration_endpoint: 'https://mcp.acme.test/register' },
      },
    }
    const r = await detectMcp('acme.test', { fetch: makeFetch(routes), registryUrl: undefined })
    assert.equal(r.available, true)
    assert.equal(r.dcr, true)
    assert.equal(r.via, 'well-known')
    assert.equal(r.endpoint, 'https://mcp.acme.test/mcp')
    assert.equal(r.authServer, 'https://mcp.acme.test')
    assert.deepEqual(r.scopes, ['read', 'write'])
    assert.equal(r.asMeta.registration_endpoint, 'https://mcp.acme.test/register')
    assert.equal(r.asMeta.authorization_endpoint, 'https://mcp.acme.test/authorize')
    assert.equal(r.asMeta.token_endpoint, 'https://mcp.acme.test/token')
  })

  // 2) The x.com trap: every path returns HTTP 200 with an HTML app shell -> must be available:false.
  await t('SPA HTML-200 at every path => available:false (no false positive)', async () => {
    clearDetectCache()
    const html = { status: 200, ct: 'text/html; charset=utf-8', body: '<!doctype html><html>app</html>' }
    const routes = {
      'https://spa.test/.well-known/mcp.json': html,
      'https://spa.test/.well-known/oauth-protected-resource': html,
      // even the mcp.<domain> convention guess serves HTML here — it must STILL be rejected (shape, not status):
      'https://mcp.spa.test/.well-known/oauth-protected-resource/mcp': html,
      'https://mcp.spa.test/.well-known/oauth-protected-resource': html,
    }
    const r = await detectMcp('spa.test', { fetch: makeFetch(routes) })
    assert.equal(r.available, false)
    assert.equal(r.dcr, false)
    // well-known is HTML (rejected); the convention guess (mcp.spa.test) also serves HTML -> no valid
    // protected-resource metadata anywhere -> not brokerable. (Pre-convention this short-circuited as 'no-endpoint'.)
    assert.equal(r.via, 'no-protected-resource')
  })

  // 2b) JSON 200 but wrong shape (mcp.json with no endpoint) also rejects.
  await t('mcp.json present but missing endpoint => available:false', async () => {
    clearDetectCache()
    const routes = { 'https://noendp.test/.well-known/mcp.json': { body: { name: 'X', description: 'no endpoint here' } } }
    const r = await detectMcp('noendp.test', { fetch: makeFetch(routes) })
    assert.equal(r.available, false)
    // well-known JSON has no endpoint -> fall through to the mcp.<domain> convention (mcp.noendp.test), which
    // serves nothing here -> no protected-resource -> not available. (Pre-convention this was 'no-endpoint'.)
    assert.equal(r.via, 'no-protected-resource')
  })

  // 2c) The mcp.<domain> CONVENTION tier: no well-known + no curated entry, but mcp.<domain> IS a real MCP server
  // -> discovered at runtime with ZERO per-site data. This is what makes a NEW site work (e.g. Figma, Linear).
  await t('mcp.<domain> convention => available via convention (no curated data)', async () => {
    clearDetectCache()
    const routes = {
      // no well-known for conv.test -> tiers 1-3 miss; the convention guesses mcp.conv.test, which is real:
      'https://mcp.conv.test/.well-known/oauth-protected-resource/mcp': { body: { authorization_servers: ['https://mcp.conv.test'], scopes_supported: ['read'] } },
      'https://mcp.conv.test/.well-known/oauth-authorization-server': { body: { issuer: 'https://mcp.conv.test', authorization_endpoint: 'https://mcp.conv.test/auth', token_endpoint: 'https://mcp.conv.test/token', registration_endpoint: 'https://mcp.conv.test/reg' } },
    }
    const r = await detectMcp('conv.test', { fetch: makeFetch(routes) })
    assert.equal(r.available, true)
    assert.equal(r.via, 'convention')
    assert.equal(r.dcr, true)
    assert.equal(r.endpoint, 'https://mcp.conv.test/mcp')
  })

  // 3) Tier-2 registry: no well-known, but the curated registry maps the sourceId -> endpoint.
  await t('registry tier supplies endpoint when well-known absent => via:registry', async () => {
    clearDetectCache()
    const routes = {
      // no mcp.json route -> tier 1 misses (404)
      'https://reg.test/v1/mcp?sourceId=curated.test': { body: { endpoint: 'https://mcp.curated.test/mcp' } },
      'https://mcp.curated.test/.well-known/oauth-protected-resource/mcp': {
        body: { authorization_servers: ['https://mcp.curated.test'] },
      },
      'https://mcp.curated.test/.well-known/oauth-authorization-server': {
        body: { issuer: 'https://mcp.curated.test', authorization_endpoint: 'https://mcp.curated.test/auth', token_endpoint: 'https://mcp.curated.test/token', registration_endpoint: 'https://mcp.curated.test/reg' },
      },
    }
    const r = await detectMcp('curated.test', { fetch: makeFetch(routes), registryUrl: 'https://reg.test' })
    assert.equal(r.available, true)
    assert.equal(r.via, 'registry')
    assert.equal(r.dcr, true)
    assert.equal(r.endpoint, 'https://mcp.curated.test/mcp')
  })

  // 3b) Registry tier is SKIPPED when no registryUrl (no core per-site code path).
  await t('registry tier skipped without registryUrl', async () => {
    clearDetectCache()
    const counter = { calls: [] }
    const routes = { 'https://reg.test/v1/mcp?sourceId=curated2.test': { body: { endpoint: 'https://x/mcp' } } }
    const r = await detectMcp('curated2.test', { fetch: makeFetch(routes, counter) })
    assert.equal(r.available, false)
    assert.ok(!counter.calls.some((u) => u.includes('/v1/mcp')), 'registry endpoint must not be hit without registryUrl')
  })

  // 4) Non-DCR AS (no registration_endpoint) => available:true but dcr:false (the Google-class case).
  await t('AS without registration_endpoint => available:true, dcr:false', async () => {
    clearDetectCache()
    const routes = {
      'https://nodcr.test/.well-known/mcp.json': { body: { endpoint: 'https://mcp.nodcr.test/mcp' } },
      'https://mcp.nodcr.test/.well-known/oauth-protected-resource/mcp': {
        body: { authorization_servers: ['https://as.nodcr.test'] },
      },
      // AS meta with NO registration_endpoint:
      'https://as.nodcr.test/.well-known/oauth-authorization-server': {
        body: { issuer: 'https://as.nodcr.test', authorization_endpoint: 'https://as.nodcr.test/auth', token_endpoint: 'https://as.nodcr.test/token' },
      },
    }
    const r = await detectMcp('nodcr.test', { fetch: makeFetch(routes) })
    assert.equal(r.available, true)
    assert.equal(r.dcr, false)
    assert.equal(r.asMeta.registration_endpoint, undefined)
  })

  // 4b) OIDC fallback used when oauth-authorization-server is absent.
  await t('openid-configuration fallback supplies AS meta', async () => {
    clearDetectCache()
    const routes = {
      'https://oidc.test/.well-known/mcp.json': { body: { endpoint: 'https://mcp.oidc.test/mcp' } },
      'https://mcp.oidc.test/.well-known/oauth-protected-resource/mcp': { body: { authorization_servers: ['https://mcp.oidc.test'] } },
      // no oauth-authorization-server route -> 404; fall through to openid-configuration:
      'https://mcp.oidc.test/.well-known/openid-configuration': {
        body: { issuer: 'https://mcp.oidc.test', authorization_endpoint: 'https://mcp.oidc.test/auth', token_endpoint: 'https://mcp.oidc.test/token', registration_endpoint: 'https://mcp.oidc.test/reg' },
      },
    }
    const r = await detectMcp('oidc.test', { fetch: makeFetch(routes) })
    assert.equal(r.available, true)
    assert.equal(r.dcr, true)
  })

  // 5) Endpoint with no protected-resource metadata => not brokerable.
  await t('endpoint without protected-resource => available:false', async () => {
    clearDetectCache()
    const routes = { 'https://noprm.test/.well-known/mcp.json': { body: { endpoint: 'https://mcp.noprm.test/mcp' } } }
    const r = await detectMcp('noprm.test', { fetch: makeFetch(routes) })
    assert.equal(r.available, false)
    assert.equal(r.via, 'no-protected-resource')
  })

  // 6) TTL cache: second call inside TTL does NOT refetch; after expiry it refetches.
  await t('per-sourceId TTL cache (injected now) — hit, then expire', async () => {
    clearDetectCache()
    const counter = { calls: [] }
    const routes = {
      'https://cache.test/.well-known/mcp.json': { body: { endpoint: 'https://mcp.cache.test/mcp' } },
      'https://mcp.cache.test/.well-known/oauth-protected-resource/mcp': { body: { authorization_servers: ['https://mcp.cache.test'] } },
      'https://mcp.cache.test/.well-known/oauth-authorization-server': { body: { token_endpoint: 'https://mcp.cache.test/token', registration_endpoint: 'https://mcp.cache.test/reg' } },
    }
    let clock = 1000
    const now = () => clock
    const fetchImpl = makeFetch(routes, counter)
    const a = await detectMcp('cache.test', { fetch: fetchImpl, now, ttlMs: 5000 })
    assert.equal(a.available, true)
    const afterFirst = counter.calls.length
    assert.ok(afterFirst > 0, 'first call must fetch')

    clock = 3000 // still inside TTL
    const b = await detectMcp('cache.test', { fetch: fetchImpl, now, ttlMs: 5000 })
    assert.equal(counter.calls.length, afterFirst, 'cached call must not refetch')
    assert.deepEqual(b, a)

    clock = 7000 // past TTL (1000 + 5000)
    await detectMcp('cache.test', { fetch: fetchImpl, now, ttlMs: 5000 })
    assert.ok(counter.calls.length > afterFirst, 'expired call must refetch')
  })

  // 6b) force bypasses cache.
  await t('force:true bypasses cache', async () => {
    clearDetectCache()
    const counter = { calls: [] }
    const routes = {
      'https://force.test/.well-known/mcp.json': { body: { endpoint: 'https://mcp.force.test/mcp' } },
      'https://mcp.force.test/.well-known/oauth-protected-resource/mcp': { body: { authorization_servers: ['https://mcp.force.test'] } },
      'https://mcp.force.test/.well-known/oauth-authorization-server': { body: { token_endpoint: 'https://t', registration_endpoint: 'https://r' } },
    }
    const fetchImpl = makeFetch(routes, counter)
    await detectMcp('force.test', { fetch: fetchImpl })
    const n1 = counter.calls.length
    await detectMcp('force.test', { fetch: fetchImpl, force: true })
    assert.ok(counter.calls.length > n1, 'force must refetch')
  })

  // 7) sourceId normalization: a full URL or host+path collapses to the host.
  await t('sourceId normalization (URL/host+path -> host)', async () => {
    clearDetectCache()
    const counter = { calls: [] }
    const routes = { 'https://norm.test/.well-known/mcp.json': { status: 404, ct: 'text/html', body: '' } }
    await detectMcp('https://norm.test/some/path?q=1', { fetch: makeFetch(routes, counter) })
    assert.ok(counter.calls.some((u) => u === 'https://norm.test/.well-known/mcp.json'), 'must probe the host root well-known')
  })

  // 7b) garbage sourceId => available:false, no throw.
  await t('garbage sourceId => available:false', async () => {
    clearDetectCache()
    const r = await detectMcp('   ', { fetch: makeFetch({}) })
    assert.equal(r.available, false)
  })
}

// ---- live cases the task names ----
async function netUp() {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch('https://www.notion.com/.well-known/mcp.json', { signal: ctrl.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

async function runLive() {
  console.log('\n[live]')
  if (!(await netUp())) {
    skip("detectMcp('www.notion.com') live", 'network unreachable')
    skip("detectMcp('x.com') live", 'network unreachable')
    return
  }
  await t("detectMcp('www.notion.com') => available + dcr + endpoint includes mcp.notion.com", async () => {
    clearDetectCache()
    const r = await detectMcp('www.notion.com', { force: true })
    assert.equal(r.available, true, 'notion must be available')
    assert.equal(r.dcr, true, 'notion must be DCR-eligible')
    assert.ok(typeof r.endpoint === 'string' && r.endpoint.includes('mcp.notion.com'), `endpoint should include mcp.notion.com, got ${r.endpoint}`)
    assert.ok(r.asMeta && r.asMeta.registration_endpoint, 'notion must expose a registration_endpoint')
  })
  await t("detectMcp('x.com') => available:false", async () => {
    clearDetectCache()
    const r = await detectMcp('x.com', { force: true })
    assert.equal(r.available, false, `x.com must not be MCP-available (got ${JSON.stringify(r)})`)
  })
}

async function main() {
  console.log('test-mcp-detect')
  await runOffline()
  await runLive()
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error('harness error:', e); process.exit(1) })
