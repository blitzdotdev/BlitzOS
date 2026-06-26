// Main-process favicon resolver — the RELIABILITY fallback under the renderer's fast direct-<img> path.
//
// Why this exists: the connector list shows a tab's favicon by pointing an <img> at `<origin>/favicon.ico`
// (see faviconForUrl in connection-page-js.mjs). Some sites (Instagram, Threads) serve an HTML login wall at
// /favicon.ico to ANY real-browser request — triggered by a Chrome User-Agent OR Chromium's auto-attached
// Sec-Fetch-* image headers (both verified). The renderer <img> always carries those, so it only ever gets HTML,
// can't decode it, and falls back to the globe glyph. A NEUTRAL main-process fetch (a plain non-browser
// User-Agent, no Sec-Fetch metadata) gets the real bytes. The renderer calls resolveFavicon() ONLY from the
// <img>'s onError (attachTray.tsx Favicon), so sites whose fast path already works (x.com, github) never reach
// here. Privacy is preserved: we hit only the site the user already has open, never a third-party favicon service.
//
// Returns a `data:<mime>;base64,...` string on success, or null (→ the renderer keeps the globe). Never throws.

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

// A non-empty, non-browser User-Agent is LOAD-BEARING: an empty UA AND a Chrome UA both trip Instagram's wall;
// a plain token like this returns the real icon (verified). Do not change to a browser UA.
const UA = 'BlitzOS-favicon/1.0'
const MAX_REDIRECTS = 5 // favicons redirect occasionally (http→https, →CDN); cap so a loop can't run forever
const OK_TTL_MS = 24 * 60 * 60 * 1000 // favicons rarely change — cache a hit for a day
const MISS_TTL_MS = 30 * 60 * 1000 // re-try a miss after 30m (covers a transient outage or a later-added icon)
const MAX_BYTES = 256 * 1024 // a favicon is tiny; cap so a misbehaving host can't stream junk into base64
const TIMEOUT_MS = 5000 // a slow host must not pin a concurrency slot
const MAX_CONCURRENT = 5 // enumerating many failing tabs must not fire a fetch storm
const MAX_ENTRIES = 512 // bound memory across a long session (insertion-order eviction, not strict LRU)

/** url(normalized) -> { value: string|null, expires: number } */
const CACHE = new Map()
/** url(normalized) -> Promise<string|null> — collapse concurrent calls for the same url into one fetch */
const PENDING = new Map()

let inFlight = 0
const waiters = []

// A tiny semaphore so at most MAX_CONCURRENT fetches run at once; the rest queue.
async function withSlot(fn) {
  while (inFlight >= MAX_CONCURRENT) {
    await new Promise((resolve) => waiters.push(resolve))
  }
  inFlight++
  try {
    return await fn()
  } finally {
    inFlight--
    const next = waiters.shift()
    if (next) next()
  }
}

// Accept only http(s) and a sane length. Returns the canonical URL string (the cache key) or null.
// TODO(ssrf): this fetches whatever origin the user's tab is on, same as the renderer <img> already does, so it
// adds no exposure beyond the status quo. If we ever resolve arbitrary agent-supplied URLs, gate private hosts.
function normalize(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) return null
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

// Sniff the real image type from magic bytes (a server can mislabel; the bot-wall is text/html, so byte-sniffing
// rejects it even at HTTP 200). SVG is text, so it's the one type we trust the content-type for, and only after a
// shape check. Returns a MIME string or null (→ not an image, keep the globe).
function imageMime(contentType, buf) {
  const b = buf
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) return 'image/x-icon' // .ico / .cur
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  if ((contentType || '').includes('image/svg')) {
    const head = b.slice(0, 256).toString('utf8').trimStart().toLowerCase()
    if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml'
  }
  return null
}

// Read the body but stop the moment it exceeds `max` (so an oversized/streaming response can't blow up memory).
// Returns a Buffer, or null if it overran or had no body.
async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > max) return null // cheap early-out when the server declares its size
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null
  if (!reader) {
    const ab = await res.arrayBuffer()
    return ab.byteLength > 0 && ab.byteLength <= max ? Buffer.from(ab) : null
  }
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      try {
        await reader.cancel()
      } catch {
        /* best-effort */
      }
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return total > 0 ? Buffer.concat(chunks, total) : null
}

// Expand a (net.isIP-validated, family-6) IPv6 literal to its 8 numeric hextets, normalizing every spelling:
// `::` compression, an embedded dotted IPv4 tail (::ffff:127.0.0.1), and hex hextets (::ffff:7f00:1) all collapse
// to the same 8-number array. Returns null if it can't be parsed into exactly 8 hextets. This is the chokepoint
// that makes the range checks below spelling-independent (the IPv4-mapped-in-hex SSRF hole lived in the old
// regex-on-the-string approach: `::ffff:7f00:1` never matched the dotted regex and slipped through as "public").
function ipv6Hextets(s) {
  let str = s
  // A trailing dotted-quad (mapped/compat form) → two hextets, so ::-expansion math stays in hextet units.
  const dotted = str.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (dotted) {
    const o = dotted.slice(1).map(Number)
    if (o.some((n) => n > 255)) return null
    str = str.slice(0, dotted.index) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16)
  }
  const halves = str.split('::')
  if (halves.length > 2) return null // more than one "::" is illegal
  const toNums = (part) => (part === '' ? [] : part.split(':').map((x) => parseInt(x, 16)))
  const head = toNums(halves[0])
  const tail = halves.length === 2 ? toNums(halves[1]) : []
  if (head.some(Number.isNaN) || tail.some(Number.isNaN)) return null
  let hextets
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    hextets = [...head, ...new Array(fill).fill(0), ...tail]
  } else {
    hextets = head
  }
  if (hextets.length !== 8 || hextets.some((n) => n < 0 || n > 0xffff)) return null
  return hextets
}

// Is this literal IP in a loopback / private / link-local / reserved range we must never fetch? Unparseable → unsafe.
function isPrivateIp(ip) {
  const fam = isIP(ip)
  if (fam === 4) {
    const p = ip.split('.').map(Number)
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
    const [a, b] = p
    if (a === 0) return true // 0.0.0.0/8 "this host"
    if (a === 10) return true // 10/8 private
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local — incl. cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 private
    if (a === 192 && b === 168) return true // 192.168/16 private
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
    if (a >= 224) return true // 224/4 multicast + 240/4 reserved + 255.255.255.255
    return false
  }
  if (fam === 6) {
    const s = ip.toLowerCase().split('%')[0] // drop any zone id
    const x = ipv6Hextets(s)
    if (!x) return true // family-6 per isIP but we can't normalize it → treat as unsafe
    // IPv4-mapped (::ffff:V4) and IPv4-compatible / loopback (top 6 hextets zero, e.g. ::1, ::7f00:1) → judge the V4.
    const topSixZero = x[0] === 0 && x[1] === 0 && x[2] === 0 && x[3] === 0 && x[4] === 0
    if (topSixZero && (x[5] === 0 || x[5] === 0xffff)) {
      const a = x[6] >> 8,
        b = x[6] & 0xff,
        c = x[7] >> 8,
        d = x[7] & 0xff
      // ::, ::1, ::ffff:0:0 etc. all land in private V4 ranges (0/8) anyway, so the V4 verdict is correct here.
      return isPrivateIp(`${a}.${b}.${c}.${d}`)
    }
    const h = x[0] // first hextet, for the prefix range checks below
    if (h >= 0xfc00 && h <= 0xfdff) return true // fc00::/7 unique-local
    if (h >= 0xfe80 && h <= 0xfebf) return true // fe80::/10 link-local
    if (h >= 0xff00) return true // ff00::/8 multicast
    return false
  }
  return true // not a valid IP literal
}

// Reject `promise` if it hasn't settled by `ms` (so a hung DNS lookup can't outlive the fetch deadline). ms<=0 fails fast.
function withTimeout(promise, ms) {
  let t
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error('timeout')), Math.max(0, ms))
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

// Throw if `hostname` is loopback / private / link-local, as a literal IP OR by DNS resolution. Run on the initial
// URL and EVERY redirect hop (we follow redirects manually for exactly this). Blocks the SSRF where a connected
// tab's /favicon.ico redirects to 127.0.0.1 / 169.254.169.254 / a LAN box and main does a blind internal GET.
// `deadline` (epoch ms) bounds the DNS lookup so a slow resolver can't pin a concurrency slot past the fetch budget.
// TODO(toctou): a hostname could re-resolve to a private IP between this lookup and fetch's connect (DNS rebinding);
// fully closing it needs a custom undici dispatcher that vets the IP at connect time. The OS resolver cache keeps the
// window tiny and V1's fetch is blind (bytes never leave the trusted renderer), so the residual risk is low.
async function assertPublicHost(hostname, deadline) {
  const host = (hostname || '').replace(/^\[|\]$/g, '') // strip IPv6 [..] brackets
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('blocked host')
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('blocked ip')
    return
  }
  const ms = typeof deadline === 'number' ? deadline - Date.now() : TIMEOUT_MS
  const addrs = await withTimeout(lookup(host, { all: true }), ms)
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('blocked resolved ip')
}

async function fetchFavicon(startUrl) {
  const ctrl = new AbortController()
  const deadline = Date.now() + TIMEOUT_MS // one budget for the whole chain: every fetch hop + every DNS lookup
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    let url = startUrl
    // Follow redirects MANUALLY so we can vet each hop's host (redirect:'follow' would chase a 302 into 127.0.0.1).
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicHost(new URL(url).hostname, deadline) // throws on a private/loopback target → caught below → null
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        // The neutral UA dodges the bot-wall; Accept is harmless (verified it does not trigger the wall) and nudges
        // a content-negotiating server toward an image. Node's fetch adds no Sec-Fetch metadata, which is the point.
        headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' }
      })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return null
        const next = new URL(loc, url) // resolve relative redirects against the current hop
        if (next.protocol !== 'http:' && next.protocol !== 'https:') return null // no file:/data: redirect targets
        url = next.toString()
        continue
      }
      if (!res.ok) return null
      const buf = await readCapped(res, MAX_BYTES)
      if (!buf || buf.length === 0) return null
      const mime = imageMime(res.headers.get('content-type'), buf)
      if (!mime) return null
      return `data:${mime};base64,${buf.toString('base64')}`
    }
    return null // too many redirects
  } catch {
    return null // network error, timeout/abort, blocked host, malformed response — fall back to the globe
  } finally {
    clearTimeout(timer)
  }
}

function cachePut(url, value) {
  CACHE.set(url, { value, expires: Date.now() + (value ? OK_TTL_MS : MISS_TTL_MS) })
  if (CACHE.size > MAX_ENTRIES) {
    const oldest = CACHE.keys().next().value
    if (oldest !== undefined) CACHE.delete(oldest)
  }
}

/**
 * Resolve a favicon URL to a base64 data: URL using a neutral main-process fetch, with caching + de-duping.
 * Never rejects — resolves to a data URL string, or null when the icon can't be obtained (→ keep the globe).
 * @param {string} rawUrl the same `<origin>/favicon.ico` the renderer <img> tried
 * @returns {Promise<string|null>}
 */
export async function resolveFavicon(rawUrl) {
  const url = normalize(rawUrl)
  if (!url) return null
  const hit = CACHE.get(url)
  if (hit && hit.expires > Date.now()) return hit.value
  const existing = PENDING.get(url)
  if (existing) return existing
  const p = withSlot(() => fetchFavicon(url))
    .catch(() => null) // withSlot/fetchFavicon shouldn't throw, but never let a caller see a rejection
    .then((value) => {
      cachePut(url, value)
      PENDING.delete(url)
      return value
    })
  PENDING.set(url, p)
  return p
}

// Exposed for tests only.
export const __test = { normalize, imageMime, isPrivateIp, assertPublicHost, CACHE, PENDING }
