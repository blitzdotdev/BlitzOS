// #51 — prove the fetchProviderResource back-compat shim (now riding callProvider) is unchanged for the
// widget data path: same { items } normalized output, same 404/401 error codes. Pure Node (stubs fetch).
import { fetchProviderResource } from '../src/main/widget-catalog.mjs'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}

let lastAuth = null
globalThis.fetch = async (url, opts) => {
  lastAuth = opts?.headers?.authorization
  if (String(url).includes('/user/repos')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ full_name: 'o/r', html_url: 'https://x', private: false, stargazers_count: 3 }]) }
  }
  if (String(url).includes('/users/@me/guilds')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'g1', name: 'Guild', owner: true }]) }
  }
  return { ok: false, status: 404, text: async () => '{}' }
}

console.log('fetchProviderResource shim (PROVIDER_DATA → callProvider):')
{
  const r = await fetchProviderResource('github', 'repos', 'TOK')
  ok('github/repos → normalized items', r.items?.[0]?.label === 'o/r' && r.items[0].badge === '★ 3', r)
  ok('token injected as Bearer (server-side)', lastAuth === 'Bearer TOK', lastAuth)
}
{
  const r = await fetchProviderResource('discord', 'guilds', 'TOK')
  ok('discord/guilds → normalized items', r.items?.[0]?.label === 'Guild' && r.items[0].sub === 'owner', r)
}
{
  let code = null
  try {
    await fetchProviderResource('github', 'nope', 'TOK')
  } catch (e) {
    code = e.code
  }
  ok('unknown resource → throws code 404', code === 404, code)
}
{
  let code = null
  try {
    await fetchProviderResource('github', 'repos', '')
  } catch (e) {
    code = e.code
  }
  ok('no token → throws code 401', code === 401, code)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
