// Tests for the main-process favicon resolver. Two parts:
//   1) OFFLINE (deterministic): normalize() + imageMime() magic-byte sniffing — these MUST pass.
//   2) LIVE (network smoke): resolveFavicon() against the real Instagram wall + a normal site + a bogus host.
//      Best-effort — if the network is unreachable it warns instead of failing, so it's not flaky in CI.
// Run: node scripts/tests/test-favicon-resolver.mjs
import http from 'node:http'
import { resolveFavicon, __test } from '../../src/main/favicon-resolver.mjs'

let pass = 0
let fail = 0
function ok(name, cond) {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name)
  }
}

const { normalize, imageMime } = __test

console.log('normalize():')
ok('keeps https', normalize('https://x.com/favicon.ico') === 'https://x.com/favicon.ico')
ok('keeps http', normalize('http://example.com/favicon.ico') === 'http://example.com/favicon.ico')
ok('rejects chrome://', normalize('chrome://favicon') === null)
ok('rejects about:', normalize('about:blank') === null)
ok('rejects file://', normalize('file:///tmp/favicon.ico') === null)
ok('rejects data:', normalize('data:image/png;base64,AAAA') === null)
ok('rejects empty', normalize('') === null)
ok('rejects non-string', normalize(undefined) === null)
ok('rejects garbage', normalize('not a url') === null)
ok('rejects over-long', normalize('https://x.com/' + 'a'.repeat(3000)) === null)

console.log('imageMime() (magic bytes beat content-type):')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00])
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
const BMP = Buffer.from([0x42, 0x4d, 0, 0])
const HTML = Buffer.from('<!doctype html><html><head><title>Login</title>', 'utf8')
ok('PNG', imageMime('image/png', PNG) === 'image/png')
ok('ICO', imageMime('image/x-icon', ICO) === 'image/x-icon')
ok('GIF', imageMime(null, GIF) === 'image/gif')
ok('JPEG', imageMime('image/jpeg', JPG) === 'image/jpeg')
ok('WEBP', imageMime(null, WEBP) === 'image/webp')
ok('BMP', imageMime('', BMP) === 'image/bmp')
ok('HTML wall labeled text/html → null', imageMime('text/html', HTML) === null)
ok('HTML wall MISLABELED image/png → still null (sniffed)', imageMime('image/png', HTML) === null)
ok('SVG only when content-type says svg AND shape matches', imageMime('image/svg+xml', Buffer.from('<svg xmlns="...">', 'utf8')) === 'image/svg+xml')
ok('SVG rejected when content-type lies (html bytes)', imageMime('text/html', Buffer.from('<svg>', 'utf8')) === null)

console.log('isPrivateIp() (SSRF blocklist):')
const { isPrivateIp, assertPublicHost } = __test
for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fe81::1', 'feba::1', 'fd00::1', 'fcff::1', '::ffff:127.0.0.1', 'not-an-ip']) {
  ok(`blocks ${ip}`, isPrivateIp(ip) === true)
}
for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111', '99.86.0.1']) {
  ok(`allows ${ip}`, isPrivateIp(ip) === false)
}
ok('assertPublicHost blocks localhost', await assertPublicHost('localhost').then(() => false, () => true))
ok('assertPublicHost blocks literal 127.0.0.1', await assertPublicHost('127.0.0.1').then(() => false, () => true))
ok('assertPublicHost blocks *.local', await assertPublicHost('printer.local').then(() => false, () => true))

console.log('parseIconHref() (declared <link rel=icon> fallback):')
const { parseIconHref } = __test
ok('finds rel=icon href (relative → absolute)', parseIconHref('<link rel="icon" type="image/png" href="favicon.png">', 'https://blitzos.app/') === 'https://blitzos.app/favicon.png')
ok('resolves root-relative against base', parseIconHref('<link rel="icon" href="/assets/i.png">', 'https://x.com/home') === 'https://x.com/assets/i.png')
ok('prefers rel=icon over apple-touch-icon', parseIconHref('<link rel="apple-touch-icon" href="/a.png"><link rel="icon" href="/b.png">', 'https://s.com/') === 'https://s.com/b.png')
ok('handles "shortcut icon"', parseIconHref('<link rel="shortcut icon" href="/f.ico">', 'https://s.com/') === 'https://s.com/f.ico')
ok('keeps an absolute CDN href', parseIconHref('<link rel="icon" href="https://cdn.s.com/i.png">', 'https://s.com/') === 'https://cdn.s.com/i.png')
ok('falls back to apple-touch-icon when no plain icon', parseIconHref('<link rel="apple-touch-icon" href="/a.png">', 'https://s.com/') === 'https://s.com/a.png')
ok('no icon link → null', parseIconHref('<link rel="stylesheet" href="/s.css">', 'https://s.com/') === null)
ok('rejects javascript: href (non-http(s))', parseIconHref('<link rel="icon" href="javascript:alert(1)">', 'https://s.com/') === null)
ok('empty/garbage html → null (no throw)', parseIconHref('', 'https://s.com/') === null)

console.log('resolveFavicon() guards (offline):')
ok('bad scheme → null', (await resolveFavicon('chrome://favicon')) === null)
ok('empty → null', (await resolveFavicon('')) === null)

console.log('SSRF: redirect to a private host is blocked (live local server):')
{
  // A site whose /favicon.ico 302-redirects to loopback. A naive redirect:'follow' would fetch the internal body;
  // our per-hop assertPublicHost must refuse the redirect target → null. Also confirm a NON-redirecting valid PNG
  // served on loopback is itself refused (the initial host is private).
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const srv = http.createServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { Location: `http://127.0.0.1:${srv.address().port}/secret.png` })
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
    }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  ok('redirect → 127.0.0.1 is NOT followed (null)', (await resolveFavicon(base + '/redir')) === null)
  ok('direct loopback origin is refused (null)', (await resolveFavicon(base + '/secret.png')) === null)
  srv.close()
}

console.log('SSRF: IPv4-mapped IPv6 loopback spellings must be blocked (regression):')
{
  // BYPASS: the dotted mapped form `::ffff:127.0.0.1` is caught by isPrivateIp's regex, but the equivalent HEX
  // hextet form `::ffff:7f00:1` (= ::ffff:127.0.0.1) is NOT — new URL() leaves it as [::ffff:7f00:1], isIP() says
  // family-6, and isPrivateIp returns false (public). The OS kernel maps ::ffff:<v4> straight to that IPv4, so a
  // connected tab whose /favicon.ico points at (or 302-redirects to) http://[::ffff:7f00:1]:PORT/ reaches loopback.
  // The whole IPv4 space is reachable this way (e.g. ::ffff:a9fe:a9fe = 169.254.169.254 cloud metadata).
  ok('isPrivateIp blocks ::ffff:7f00:1 (hex-form mapped 127.0.0.1)', isPrivateIp('::ffff:7f00:1') === true)
  ok('isPrivateIp blocks ::ffff:a9fe:a9fe (hex-form mapped 169.254.169.254)', isPrivateIp('::ffff:a9fe:a9fe') === true)
  ok('assertPublicHost blocks [::ffff:7f00:1]', await assertPublicHost('[::ffff:7f00:1]').then(() => false, () => true))

  // End-to-end: a loopback service addressed via the hex-mapped literal must NOT be reached.
  const SECRET = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') // valid PNG magic
  let internalHit = false
  const internal = http.createServer((req, res) => {
    internalHit = true
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(SECRET)
  })
  await new Promise((r) => internal.listen(0, '127.0.0.1', r))
  const port = internal.address().port
  const mappedDirect = await resolveFavicon(`http://[::ffff:7f00:1]:${port}/secret.png`)
  ok('direct [::ffff:7f00:1] loopback is refused (null)', mappedDirect === null)
  ok('loopback service was NOT hit via the mapped literal', internalHit === false)
  internal.close()
}

// ---- LIVE network smoke ----
console.log('resolveFavicon() LIVE (network):')
async function reachable() {
  try {
    await fetch('https://x.com/favicon.ico', { method: 'HEAD' })
    return true
  } catch {
    return false
  }
}
if (!(await reachable())) {
  console.log('  ⚠ network unreachable — skipping live checks')
} else {
  const ig = await resolveFavicon('https://www.instagram.com/favicon.ico')
  ok('instagram (the wall) → real image data URL', typeof ig === 'string' && ig.startsWith('data:image/'))
  console.log('    instagram →', ig ? ig.slice(0, 40) + '… (' + ig.length + ' chars)' : ig)

  const x = await resolveFavicon('https://x.com/favicon.ico')
  ok('x.com → real image data URL', typeof x === 'string' && x.startsWith('data:image/'))
  console.log('    x.com →', x ? x.slice(0, 40) + '… (' + x.length + ' chars)' : x)

  // Cache + de-dupe: a second call returns the SAME cached value; concurrent calls share ONE promise.
  ok('instagram cached (same ref second call)', (await resolveFavicon('https://www.instagram.com/favicon.ico')) === ig)
  const [a, b] = await Promise.all([
    resolveFavicon('https://www.instagram.com/favicon.ico'),
    resolveFavicon('https://www.instagram.com/favicon.ico')
  ])
  ok('concurrent calls de-duped (equal results)', a === b)

  const bogus = await resolveFavicon('https://no-such-host-blitzos-xyz.invalid/favicon.ico')
  ok('bogus host → null (not a throw)', bogus === null)

  // Declared-icon fallback end-to-end: blitzos.app serves NO /favicon.ico (404) but declares /favicon.png via
  // <link rel="icon">. resolveFavicon must page-parse and return the real PNG. (If the site/network changes this
  // can go stale — it asserts the FALLBACK path against a real server, the whole point of this feature.)
  const blitz = await resolveFavicon('https://blitzos.app/favicon.ico')
  ok('blitzos.app (no .ico, declares /favicon.png) → real image via page-parse', typeof blitz === 'string' && blitz.startsWith('data:image/'))
  console.log('    blitzos.app →', blitz ? blitz.slice(0, 40) + '… (' + blitz.length + ' chars)' : blitz)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
