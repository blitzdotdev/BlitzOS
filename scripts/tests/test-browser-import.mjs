// Unit test for the browser-import core (plans/blitzos-browser-import.md). The v10 decrypt is tested
// with a SYNTHETIC round-trip (no Keychain prompt, deterministic): encrypt the way macOS Chrome does,
// then assert decryptCookieValue recovers it, with and without the M80+ SHA256(host) prefix. Profile
// enumeration runs against the real Chrome install (read-only, no prompt). No cookie value is printed.
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decryptCookieValue, decryptCookieRows, listProfiles, IMPORT_SOURCES } from '../../src/main/browser-import-core.mjs'

let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.error(`  ✗ ${msg}`) } }

const deriveKey = (pass) => crypto.pbkdf2Sync(pass, 'saltysalt', 1003, 16, 'sha1')
// Encrypt a value the way macOS Chrome v10 does (optionally with the M80+ SHA256(host) prefix).
function encV10(value, key, host, withPrefix) {
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const prefix = withPrefix ? crypto.createHash('sha256').update(host).digest() : Buffer.alloc(0)
  const ct = Buffer.concat([c.update(Buffer.concat([prefix, Buffer.from(value, 'utf8')])), c.final()])
  return Buffer.concat([Buffer.from('v10', 'latin1'), ct])
}

console.log('1) v10 decrypt round-trip (M80+ prefix, the real-world case)')
{
  const key = deriveKey('test-safe-storage-pw')
  const host = '.google.com'
  const secret = '1//SID-token_value.AbCdEf-1234567890=='
  const dec = decryptCookieValue(encV10(secret, key, host, true), key, host)
  ok(dec === secret, 'recovers the exact value after stripping the verified SHA256 prefix')
}

console.log('2) v10 decrypt round-trip (pre-M80, NO prefix — must not truncate)')
{
  const key = deriveKey('pw2')
  const host = 'accounts.google.com'
  const secret = 'short'
  const dec = decryptCookieValue(encV10(secret, key, host, false), key, host)
  ok(dec === secret, 'recovers a short value with no prefix (the SHA256 check declines to strip)')
}

console.log('3) a value that is exactly 32+ bytes but has NO host prefix is not over-stripped')
{
  const key = deriveKey('pw3')
  const host = '.google.com'
  const secret = 'x'.repeat(48) // longer than the 32-byte prefix, but no prefix present
  const dec = decryptCookieValue(encV10(secret, key, host, false), key, host)
  ok(dec === secret, 'a long prefix-less value is returned whole (SHA256 mismatch ⇒ no strip)')
}

console.log('4) wrong key never yields the real value')
{
  const right = deriveKey('right'); const wrong = deriveKey('wrong')
  const host = '.google.com'; const secret = 'top-secret-session'
  const dec = decryptCookieValue(encV10(secret, right, host, true), wrong, host)
  ok(dec !== secret, 'the real value is not recovered under the wrong key (padding fails ⇒ null, or garbage ≠ value)')
}

console.log('5) non-v10 (app-bound / linux) is skipped, not guessed')
{
  const key = deriveKey('pw5')
  ok(decryptCookieValue(Buffer.concat([Buffer.from('v20'), Buffer.alloc(32)]), key, 'x') === null, 'a v20 (app-bound) cookie returns null')
  ok(decryptCookieValue(Buffer.from('v10'), key, 'x') === null, 'a too-short blob returns null')
  ok(decryptCookieValue(Buffer.alloc(0), key, 'x') === null, 'an empty blob returns null')
}

console.log('6) empty-value cookie round-trips')
{
  const key = deriveKey('pw6'); const host = '.google.com'
  ok(decryptCookieValue(encV10('', key, host, true), key, host) === '', 'an empty value decrypts to empty string, not null')
}

console.log('7) profile enumeration against the real Chrome install (read-only, no prompt)')
{
  const profiles = listProfiles('chrome')
  ok(Array.isArray(profiles), 'listProfiles returns an array')
  if (profiles.length) {
    ok(profiles.every((p) => p.id && typeof p.name === 'string'), 'every profile has an id + name')
    ok(profiles.some((p) => p.email), 'at least one profile exposes a signed-in email (the account picker label)')
    console.log(`     (found ${profiles.length} profile(s): ${profiles.map((p) => p.email || p.name).join(', ')})`)
  } else {
    console.log('     (no Chrome profiles on this machine — enumeration still returned cleanly)')
  }
  ok(!!IMPORT_SOURCES.chrome && !!IMPORT_SOURCES.brave, 'IMPORT_SOURCES covers the chromium family')
}

console.log('8) decryptCookieRows against a synthetic Chrome Cookies DB (the end-to-end path)')
{
  const key = deriveKey('cookie-db-pw')
  const dir = mkdtempSync(join(tmpdir(), 'blitz-ck-test-'))
  const db = join(dir, 'Cookies')
  const blob = (v, host) => `x'${encV10(v, key, host, true).toString('hex')}'`
  // future expiry in Chrome's epoch (microseconds since 1601-01-01)
  const futureUtc = Math.round((Date.now() / 1000 + 31536000 + 11644473600) * 1e6)
  const sql = [
    'CREATE TABLE cookies(name TEXT, host_key TEXT, path TEXT, encrypted_value BLOB, is_secure INT, is_httponly INT, samesite INT, expires_utc INT, has_expires INT);',
    `INSERT INTO cookies VALUES('SID','.google.com','/',${blob('sid-secret', '.google.com')},1,1,0,${futureUtc},1);`,
    `INSERT INTO cookies VALUES('OSID','accounts.google.com','/',${blob('osid', 'accounts.google.com')},1,1,1,0,0);`,
    `INSERT INTO cookies VALUES('sess','notgoogle.com','/',${blob('x', 'notgoogle.com')},1,0,2,0,0);`
  ].join('\n')
  try {
    execFileSync('/usr/bin/sqlite3', [db, sql])
    const g = decryptCookieRows(db, key, { googleOnly: true })
    ok(g.cookies.length === 2, `googleOnly returns the 2 google cookies, excludes notgoogle.com (got ${g.cookies.length})`)
    const sid = g.cookies.find((c) => c.name === 'SID')
    ok(sid && sid.value === 'sid-secret', 'SID value decrypts correctly through the DB read + parse')
    ok(sid && sid.domain === '.google.com' && sid.secure === true && sid.httpOnly === true, 'SID is a secure httpOnly domain cookie')
    ok(sid && sid.url === 'https://google.com/', `SID url drops the leading dot (got ${sid && sid.url})`)
    ok(sid && typeof sid.expirationDate === 'number' && sid.expirationDate > Date.now() / 1000, 'SID future expiry converts to a Unix-seconds expirationDate')
    const osid = g.cookies.find((c) => c.name === 'OSID')
    ok(osid && osid.domain === undefined && osid.url === 'https://accounts.google.com/', 'OSID is host-only (no domain), url uses its exact host')
    ok(osid && osid.sameSite === 'lax' && osid.expirationDate === undefined, 'OSID samesite=1 → lax, no has_expires → session cookie')
    const all = decryptCookieRows(db, key, { googleOnly: false })
    ok(all.cookies.length === 3, 'googleOnly:false returns every cookie incl. notgoogle.com')
    ok(decryptCookieRows(join(dir, 'Nope'), key).cookies.length === 0, 'a missing DB returns no cookies, no throw')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (failed) { console.error(`\n✗ ${failed} assertion(s) failed`); process.exit(1) }
console.log('\n✓ browser-import core test passed')
