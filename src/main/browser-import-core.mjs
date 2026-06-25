// The PURE half of the Chrome sign-in importer (plans/blitzos-browser-import.md): enumerate Chrome
// profiles, read the Safe Storage key, and decrypt cookies. No Electron — so it runs under plain
// node (scripts/test-browser-import.mjs) and the Electron wrapper (browser-import.ts) binds the
// session injection on top. Verified feasible end-to-end on a real Chrome 2026-06-13 (the v10
// pipeline decrypts the full Google auth cookie set).
//
// SECURITY: cookies (especially the Google set) ARE the user's identity. This module decrypts in
// memory and returns plaintext to its caller; it NEVER logs a value and NEVER writes plaintext to
// disk. The caller (browser-import.ts) injects straight into the encrypted session store. The Safe
// Storage key read raises ONE macOS Keychain prompt — that prompt is the consent gate.
import { execFileSync } from 'node:child_process'
import { readFileSync, copyFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import crypto from 'node:crypto'

// Chromium-family installs we can import from (same family the scan reads). `safe` = the Keychain
// service name holding that browser's cookie-encryption key.
export const IMPORT_SOURCES = {
  chrome: { name: 'Google Chrome', dir: 'Google/Chrome', safe: 'Chrome Safe Storage', account: 'Chrome' },
  brave: { name: 'Brave', dir: 'BraveSoftware/Brave-Browser', safe: 'Brave Safe Storage', account: 'Brave' },
  edge: { name: 'Microsoft Edge', dir: 'Microsoft Edge', safe: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' }
}
const supportRoot = (src) => join(homedir(), 'Library', 'Application Support', IMPORT_SOURCES[src].dir)

/** Enumerate a browser's profiles from `Local State` → `profile.info_cache`, newest-active first.
 *  Returns [{id, dir, name, email, active}] — `id` is the on-disk profile dir ("Profile 2"). No
 *  decryption, no prompt: this is what the account picker shows. */
export function listProfiles(src = 'chrome') {
  const root = supportRoot(src)
  const localState = join(root, 'Local State')
  if (!existsSync(localState)) return []
  let cache = {}
  try { cache = (JSON.parse(readFileSync(localState, 'utf8'))?.profile?.info_cache) || {} } catch { return [] }
  const out = []
  for (const [dir, info] of Object.entries(cache)) {
    if (!existsSync(cookiePath(src, dir))) continue // a profile with no cookie store is not importable
    out.push({
      id: dir,
      dir,
      name: info?.name || dir,
      email: info?.user_name || null, // user_name is the signed-in Google email when present
      active: (info?.active_time || 0)
    })
  }
  // most-recently-active first, so the picker leads with the profile they actually use
  return out.sort((a, b) => (b.active || 0) - (a.active || 0)).map(({ active, ...p }) => p)
}

/** The cookie DB path for a profile (modern Chrome moved it under Network/; older is top-level). */
export function cookiePath(src, profileDir) {
  const root = supportRoot(src)
  const network = join(root, profileDir, 'Network', 'Cookies')
  if (existsSync(network)) return network
  return join(root, profileDir, 'Cookies')
}

/** Read the browser's Safe Storage key from the login Keychain. RAISES the one macOS Keychain
 *  prompt (the consent gate) on first access. Returns the raw passphrase string, or null if the
 *  user denied / it is absent. Shells out to Apple's `security` (no entitlement needed); a packaged
 *  build may later use the Security framework for a BlitzOS-attributed prompt (TODO). */
export function getSafeStorageKey(src = 'chrome') {
  const { safe, account } = IMPORT_SOURCES[src]
  const tryFind = (args) => {
    try { return String(execFileSync('/usr/bin/security', args, { encoding: 'utf8', timeout: 120_000 })).replace(/\n$/, '') } catch { return '' }
  }
  return tryFind(['find-generic-password', '-w', '-s', safe, '-a', account]) || tryFind(['find-generic-password', '-w', '-s', safe]) || null
}

/** Derive the AES-128 key from the Safe Storage passphrase (macOS: PBKDF2-SHA1, "saltysalt", 1003). */
function deriveKey(passphrase) {
  return crypto.pbkdf2Sync(passphrase, 'saltysalt', 1003, 16, 'sha1')
}

/** Decrypt one macOS `v10` cookie value. AES-128-CBC, IV = 16×0x20. On M80+ the plaintext is
 *  prefixed with SHA256(host_key); we strip it ONLY when it actually matches (so pre-M80 cookies,
 *  which have no prefix, are not truncated). Returns the value string, or null if not decryptable
 *  (e.g. an app-bound `v20` cookie on newer Chrome — skipped, never fatal). */
export function decryptCookieValue(encrypted, key, hostKey) {
  if (!encrypted || encrypted.length < 4) return null
  const tag = encrypted.slice(0, 3).toString('latin1')
  if (tag !== 'v10') return null // v11=linux, v20=app-bound — out of scope for the macOS Chrome MVP
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    d.setAutoPadding(true) // PKCS7 at the END; valid padding ⇒ the key is correct
    const pt = Buffer.concat([d.update(encrypted.slice(3)), d.final()])
    if (pt.length >= 32 && hostKey) {
      const want = crypto.createHash('sha256').update(hostKey).digest()
      if (pt.slice(0, 32).equals(want)) return pt.slice(32).toString('utf8')
    }
    return pt.toString('utf8')
  } catch { return null }
}

// Chrome stores expires_utc as microseconds since 1601-01-01; Unix seconds = µs/1e6 - 11644473600.
const WEBKIT_EPOCH_DELTA = 11644473600
const chromeExpiryToUnix = (utc) => (Number(utc) / 1e6) - WEBKIT_EPOCH_DELTA
// Chrome samesite: -1 unspecified, 0 None, 1 Lax, 2 Strict → Electron cookies.set sameSite.
const SAMESITE = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' }

// The Google sign-in cookie set: google.com itself + any *.google.com subdomain (accounts., mail.,
// docs., the leading-dot domain cookie .google.com). NOT a bare LIKE '%google.com' (that also
// matches notgoogle.com). SQL-injection-safe: a fixed literal, no interpolated input.
const GOOGLE_WHERE = "WHERE host_key = 'google.com' OR host_key LIKE '%.google.com'"

/** Decrypt one Cookies SQLite DB into injection-ready records {url, name, value, domain?, path,
 *  secure, httpOnly, sameSite, expirationDate?}. `key` is the DERIVED AES key (deriveKey). Copies the
 *  DB to a temp + opens immutable so a running Chrome never blocks it. Pure (explicit dbPath) so the
 *  test can drive it against a synthetic Cookies DB. Returns { cookies, stats }. Never logs a value. */
export function decryptCookieRows(dbPath, key, { googleOnly = true } = {}) {
  if (!existsSync(dbPath)) return { cookies: [], stats: { total: 0, decrypted: 0, skipped: 0 } }
  const tmp = mkdtempSync(join(tmpdir(), 'blitz-ck-'))
  const copy = join(tmp, 'Cookies')
  let rows = []
  try {
    copyFileSync(dbPath, copy)
    for (const ext of ['-wal', '-shm']) { try { copyFileSync(dbPath + ext, copy + ext) } catch { /* may not exist */ } }
    // Columns separated by \x1f (sqlite3 -separator), rows by newline (sqlite3's default row break).
    // Cookie metadata never contains \x1f or a newline, and hex(encrypted_value) is hex, so both are safe.
    const sql = `SELECT name, host_key, path, hex(encrypted_value), is_secure, is_httponly, samesite, expires_utc, has_expires FROM cookies ${googleOnly ? GOOGLE_WHERE : ''};`
    const out = execFileSync('/usr/bin/sqlite3', ['-readonly', '-separator', '\x1f', `file:${copy}?immutable=1`, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    rows = out.split('\n').map((r) => r.replace(/\r$/, '')).filter(Boolean)
  } catch (e) {
    return { cookies: [], stats: { total: 0, decrypted: 0, skipped: 0 }, error: (e.message || '').slice(0, 80) }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  const cookies = []
  let decrypted = 0, skipped = 0
  for (const row of rows) {
    const [name, hostKey, path, hex, isSecure, isHttpOnly, samesite, expiresUtc, hasExpires] = row.split('\x1f')
    if (!hostKey) { skipped++; continue }
    const value = decryptCookieValue(Buffer.from(hex || '', 'hex'), key, hostKey)
    if (value == null) { skipped++; continue }
    const secure = isSecure === '1'
    const bareHost = hostKey.replace(/^\./, '')
    const rec = {
      url: `${secure ? 'https' : 'http'}://${bareHost}${path || '/'}`,
      name,
      value,
      path: path || '/',
      secure,
      httpOnly: isHttpOnly === '1',
      sameSite: SAMESITE[samesite] || 'unspecified'
    }
    if (hostKey.startsWith('.')) rec.domain = hostKey // domain cookie (.google.com); host-only omits domain
    if (hasExpires === '1' && Number(expiresUtc) > 0) {
      const exp = chromeExpiryToUnix(expiresUtc)
      if (exp > Date.now() / 1000) rec.expirationDate = exp // skip the already-expired
    }
    cookies.push(rec)
    decrypted++
  }
  return { cookies, stats: { total: rows.length, decrypted, skipped } }
}

/** Decrypt a browser profile's cookies (resolves the DB path from src+profileDir, derives the key
 *  from the Safe Storage passphrase). `googleOnly` filters to the Google sign-in set (the MVP). */
export function decryptProfileCookies(src, profileDir, passphrase, opts = {}) {
  return decryptCookieRows(cookiePath(src, profileDir), deriveKey(passphrase), opts)
}
