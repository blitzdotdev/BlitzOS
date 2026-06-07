import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

export interface StoredRecord {
  provider: string
  label: string
  secrets: Record<string, unknown>
  /** #51: OAuth scopes granted at connect, recorded authoritatively (for the write scope-preflight). */
  grantedScopes?: string[]
  connectedAt: number
}

type Disk = Record<string, string> // provider -> base64 ciphertext

function file(): string {
  return join(app.getPath('userData'), 'integrations.json')
}

function readDisk(): Disk {
  try {
    if (!existsSync(file())) return {}
    return JSON.parse(readFileSync(file(), 'utf8')) as Disk
  } catch {
    return {}
  }
}

function writeDisk(d: Disk): void {
  writeFileSync(file(), JSON.stringify(d), 'utf8')
}

function encrypt(plaintext: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext).toString('base64')
  }
  // Fallback: not encrypted. macOS always has Keychain, so this should not happen there.
  console.warn('[agent-os] safeStorage unavailable; storing tokens unencrypted (dev fallback)')
  return Buffer.from(plaintext, 'utf8').toString('base64')
}

function decrypt(b64: string): string {
  const buf = Buffer.from(b64, 'base64')
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(buf)
  }
  return buf.toString('utf8')
}

export function saveRecord(rec: StoredRecord): void {
  const d = readDisk()
  d[rec.provider] = encrypt(JSON.stringify(rec))
  writeDisk(d)
}

export function loadRecord(provider: string): StoredRecord | null {
  const enc = readDisk()[provider]
  if (!enc) return null
  try {
    return JSON.parse(decrypt(enc)) as StoredRecord
  } catch {
    return null
  }
}

export function deleteRecord(provider: string): void {
  const d = readDisk()
  delete d[provider]
  writeDisk(d)
}
