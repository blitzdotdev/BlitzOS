// Headless round-trip test for the MCP token store (src/main/mcp-token-store.mjs). Plain Node — no Electron, so
// this exercises the explicit enc:'none' FALLBACK path: save → load (same record back) → clear (file gone), at
// the documented path <ws>/.blitzos/mcp/<safeSourceId>/tokens.json. Also asserts the store NEVER prints a token
// value (we wrap stdout/stderr and scan for the secret strings) and that the fallback file is plainly marked
// NOT-ENCRYPTED (enc:'none') so cleartext is never mistaken for encrypted.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { saveTokens, loadTokens, clearTokens } from '../../src/main/mcp-token-store.mjs'

// Independent recompute of the store's on-disk dir name (mirrors safeSourceId in connection-ops.mjs +
// mcp-token-store.mjs) so the expected path is derived here, not read back from the module under test.
function safeSourceId(s) {
  const raw = String(s || 'unknown')
  const prefix = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'src'
  return prefix + '-' + createHash('sha1').update(raw).digest('hex').slice(0, 10)
}

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (e) {
    console.error(`  FAIL  ${name}\n    ${(e && e.message) || e}`)
    process.exitCode = 1
  }
}

// Capture EVERYTHING the store writes to stdout/stderr so we can prove no token value leaks. We restore the
// originals before printing our own results, then assert the captured buffer contains no secret substring.
const captured = []
const realOut = process.stdout.write.bind(process.stdout)
const realErr = process.stderr.write.bind(process.stderr)
process.stdout.write = (chunk, ...a) => {
  captured.push(String(chunk))
  return realOut(chunk, ...a)
}
process.stderr.write = (chunk, ...a) => {
  captured.push(String(chunk))
  return realErr(chunk, ...a)
}
function restoreStreams() {
  process.stdout.write = realOut
  process.stderr.write = realErr
}

const ws = mkdtempSync(join(tmpdir(), 'blitz-mcp-tokens-'))
const sourceId = 'mcp.notion.com'
// distinctive secret values so a leak in any printed string is unmistakable
const ACCESS = 'ACCESS-SECRET-7f3c-do-not-print'
const REFRESH = 'REFRESH-SECRET-91ab-do-not-print'
const CLIENT_SECRET = 'CLIENT-SECRET-aa55-do-not-print'
const record = {
  endpoint: 'https://mcp.notion.com/mcp',
  authServer: 'https://mcp.notion.com',
  scopes: ['read', 'write'],
  client_id: 'client_abc123',
  client_secret: CLIENT_SECRET,
  access_token: ACCESS,
  refresh_token: REFRESH,
  expires_at: 1893456000000
}

const expectedFile = join(ws, '.blitzos', 'mcp', safeSourceId(sourceId), 'tokens.json')

// Run the full lifecycle, snapshotting the on-disk file state AFTER save but BEFORE clear (so the
// existence/marker checks see the written file, then we verify clear removes it).
let save, loaded, after, cleared
let existsAfterSave, envelopeAfterSave, existsAfterClear
try {
  save = saveTokens(ws, sourceId, record)
  existsAfterSave = existsSync(expectedFile)
  envelopeAfterSave = existsAfterSave ? JSON.parse(readFileSync(expectedFile, 'utf8')) : null
  loaded = loadTokens(ws, sourceId)
  cleared = clearTokens(ws, sourceId)
  existsAfterClear = existsSync(expectedFile)
  after = loadTokens(ws, sourceId)
} finally {
  restoreStreams()
}

t('saveTokens reported success via the fallback (enc:none) path', () => {
  assert.ok(save && save.ok === true, `expected {ok:true}, got ${JSON.stringify(save)}`)
  assert.equal(save.enc, 'none', 'plain Node should take the unencrypted fallback')
})

t('wrote tokens.json at <ws>/.blitzos/mcp/<safeSourceId>/tokens.json', () => {
  assert.ok(existsAfterSave, `expected file at ${expectedFile}`)
})

t('on-disk file is PLAINLY marked NOT-ENCRYPTED (enc:none + warning)', () => {
  assert.ok(envelopeAfterSave, 'no envelope read from disk')
  assert.equal(envelopeAfterSave.enc, 'none')
  assert.match(String(envelopeAfterSave.warning || ''), /NOT-ENCRYPTED/)
})

t('loadTokens returns exactly what was saved (deep equal)', () => {
  assert.deepEqual(loaded, record)
})

t('clearTokens reported ok and removed the file', () => {
  assert.ok(cleared && cleared.ok === true, `expected {ok:true}, got ${JSON.stringify(cleared)}`)
  assert.ok(!existsAfterClear, 'tokens.json should be gone after clear')
})

t('loadTokens after clear returns null', () => {
  assert.equal(after, null)
})

t('clearTokens is idempotent (clearing a missing record is ok)', () => {
  const again = clearTokens(ws, sourceId)
  assert.ok(again && again.ok === true)
})

t('saveTokens with no workspace returns an error, not a silent success', () => {
  const r = saveTokens('', sourceId, record)
  assert.ok(r && r.error, `expected an error, got ${JSON.stringify(r)}`)
})

t('saveTokens with a non-object record is rejected', () => {
  const r = saveTokens(ws, sourceId, null)
  assert.ok(r && r.error, `expected an error, got ${JSON.stringify(r)}`)
})

t('NO token value was printed by the store (access/refresh/client_secret never leaked to stdout/stderr)', () => {
  // the store itself must print nothing; our own PASS/FAIL lines (printed AFTER restoreStreams) are not captured,
  // and the values above are only in this test's variables — but assert the captured store output is secret-free.
  const blob = captured.join('')
  for (const secret of [ACCESS, REFRESH, CLIENT_SECRET]) {
    assert.ok(!blob.includes(secret), 'a token value leaked into captured store output')
  }
})

rmSync(ws, { recursive: true, force: true })

if (process.exitCode) {
  console.log(`\nFAIL — ${passed} passed, failures above`)
} else {
  console.log(`\nPASS — all ${passed} passed`)
}
