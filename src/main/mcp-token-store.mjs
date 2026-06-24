// The MCP token store (plans/blitzos-mcp-connections.md, "Token store"): the broker holds the upstream
// OAuth secrets (refresh_token + access_token + DCR client_id/secret) for a connected MCP source, so the
// agent never sees them. ONE file per (workspace, sourceId) at
//   <workspaceDir>/.blitzos/mcp/<safeSourceId>/tokens.json
// Secrets are ENCRYPTED AT REST with Electron safeStorage when it's available (Keychain-backed on macOS).
//
// Honesty rule (CLAUDE.md): we NEVER store raw secrets while pretending they're encrypted. The on-disk file
// always carries an explicit `enc` discriminator:
//   - enc:'safeStorage' → `payload` is base64 of safeStorage.encryptString(JSON(record))
//   - enc:'none'        → FALLBACK (no Electron / encryption unavailable): `record` is the RAW JSON, and the
//                          file is plainly marked NOT-ENCRYPTED (enc:'none' + a `warning`) so nothing silently
//                          looks encrypted. Callers/operators can see at a glance the secrets are in cleartext.
// Token VALUES are never logged or thrown by this module.
//
// Plain Node-safe: Electron is require()'d LAZILY inside a try/catch, so this module (and its tests) load and
// round-trip in headless Node via the fallback path — Electron is only reached at runtime when it's present.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// EXACT copy of safeSourceId from connection-ops.mjs (same store-dir sanitization, so the MCP store keys on the
// SAME safe id as the connection store): a readable prefix + a hash of the RAW id, so the result can never be a
// path-traversal segment and distinct sources never collide onto one file. Keep these two in lockstep.
function safeSourceId(sourceId) {
  const raw = String(sourceId || 'unknown')
  const prefix = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'src'
  return prefix + '-' + createHash('sha1').update(raw).digest('hex').slice(0, 10)
}

// Lazily resolve Electron's safeStorage IFF it's loadable AND reports encryption available. Returns null in
// plain Node, in a build where the keychain/secret-service is unavailable, or on any error — callers then take
// the explicit enc:'none' fallback. Never throws.
function getSafeStorage() {
  try {
    // eslint-disable-next-line global-require -- lazy: Electron is absent in headless Node + tests
    const electron = require('electron')
    const ss = electron && electron.safeStorage
    if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) return ss
  } catch {
    /* not running under Electron, or safeStorage unavailable — fall back to enc:'none' */
  }
  return null
}

// The directory + file for a (workspace, sourceId). Returns null when there's no workspace to anchor to (the
// caller treats that as "nothing saved" / "can't save"), never an unanchored path.
function tokenDir(workspaceDir, sourceId) {
  const ws = workspaceDir ? String(workspaceDir) : ''
  if (!ws) return null
  return join(ws, '.blitzos', 'mcp', safeSourceId(sourceId))
}
function tokenFile(workspaceDir, sourceId) {
  const dir = tokenDir(workspaceDir, sourceId)
  return dir ? join(dir, 'tokens.json') : null
}

/**
 * Persist a token record for (workspaceDir, sourceId). Overwrites any existing record. Encrypts with
 * safeStorage when available, else writes an explicitly-marked NOT-ENCRYPTED fallback. Returns
 * { ok, enc } on success or { error } (no token values in either).
 * @param {string} workspaceDir active workspace folder
 * @param {string} sourceId     stable source identity (e.g. 'mcp.notion.com')
 * @param {object} record       the opaque token bundle {access_token, refresh_token, expires_at, client_id, ...}
 */
export function saveTokens(workspaceDir, sourceId, record) {
  const dir = tokenDir(workspaceDir, sourceId)
  if (!dir) return { error: 'no workspace to save MCP tokens into' }
  if (!record || typeof record !== 'object') return { error: 'record (object) required' }
  const file = join(dir, 'tokens.json')
  let envelope
  const ss = getSafeStorage()
  if (ss) {
    let buf
    try {
      buf = ss.encryptString(JSON.stringify(record))
    } catch (e) {
      // encryptString failed at the call site even though isEncryptionAvailable() said yes — surface it rather
      // than silently leaking cleartext under an enc:'safeStorage' label. (No token values in the message.)
      return { error: `safeStorage.encryptString failed: ${String((e && e.message) || e)}` }
    }
    envelope = { enc: 'safeStorage', v: 1, sourceId: String(sourceId), payload: Buffer.from(buf).toString('base64') }
  } else {
    // FALLBACK: plainly marked NOT-ENCRYPTED so secrets are never mistaken for encrypted at rest.
    envelope = {
      enc: 'none',
      v: 1,
      sourceId: String(sourceId),
      warning: 'NOT-ENCRYPTED: Electron safeStorage was unavailable; tokens below are stored in cleartext.',
      record
    }
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(envelope, null, 2), { mode: 0o600 })
  } catch (e) {
    return { error: `failed to write MCP tokens: ${String((e && e.message) || e)}` }
  }
  return { ok: true, enc: envelope.enc }
}

/**
 * Load the token record for (workspaceDir, sourceId). Returns the SAME object shape that was saved, or null if
 * nothing is stored / the file is unreadable / a safeStorage-encrypted file can't be decrypted on this machine
 * (e.g. a different OS keychain). Never throws, never logs token values.
 */
export function loadTokens(workspaceDir, sourceId) {
  const file = tokenFile(workspaceDir, sourceId)
  if (!file || !existsSync(file)) return null
  let envelope
  try {
    envelope = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null // corrupt/partial file — treat as "no tokens" (caller will re-auth)
  }
  if (!envelope || typeof envelope !== 'object') return null
  if (envelope.enc === 'none') {
    return envelope.record && typeof envelope.record === 'object' ? envelope.record : null
  }
  if (envelope.enc === 'safeStorage') {
    const ss = getSafeStorage()
    if (!ss) return null // can't decrypt without safeStorage (wrong env / keychain) — re-auth path
    try {
      const buf = Buffer.from(String(envelope.payload || ''), 'base64')
      const json = ss.decryptString(buf)
      const rec = JSON.parse(json)
      return rec && typeof rec === 'object' ? rec : null
    } catch {
      return null // wrong keychain / tampered payload — re-auth rather than crash
    }
  }
  return null // unknown enc discriminator (forward-incompatible) — treat as no tokens
}

/**
 * List the RAW sourceIds that have a stored token bundle under (workspaceDir). The store dir is keyed on a
 * ONE-WAY safeSourceId hash, so the raw id can't be recovered from the dir name; instead each envelope persists
 * its raw `sourceId` UNENCRYPTED at the top level (no secret), which this reads back. Used by the boot rehydrate
 * to re-establish every previously-approved MCP connection without a fresh human approval. Never throws, never
 * reads token values; skips corrupt/foreign-keychain files (they still have a readable `sourceId`).
 * @returns {string[]} the distinct raw sourceIds (empty when none / no workspace).
 */
export function listSources(workspaceDir) {
  const ws = workspaceDir ? String(workspaceDir) : ''
  if (!ws) return []
  const root = join(ws, '.blitzos', 'mcp')
  if (!existsSync(root)) return []
  const out = new Set()
  let dirs = []
  try {
    dirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const file = join(root, d.name, 'tokens.json')
    if (!existsSync(file)) continue
    try {
      const env = JSON.parse(readFileSync(file, 'utf8'))
      const sid = env && typeof env.sourceId === 'string' ? env.sourceId : ''
      if (sid) out.add(sid)
    } catch {
      /* corrupt/partial envelope — skip (no recoverable sourceId) */
    }
  }
  return [...out]
}

/**
 * Remove the stored tokens for (workspaceDir, sourceId). Idempotent: returns { ok:true } whether or not a file
 * existed. The third `record` param is accepted (the shared store signature) but ignored for clear.
 */
export function clearTokens(workspaceDir, sourceId) {
  const file = tokenFile(workspaceDir, sourceId)
  if (!file) return { ok: true }
  try {
    rmSync(file, { force: true })
  } catch (e) {
    return { error: `failed to clear MCP tokens: ${String((e && e.message) || e)}` }
  }
  return { ok: true }
}
