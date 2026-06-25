// Types for the pure Chrome sign-in importer core (browser-import-core.mjs).

export interface ImportSourceDef { name: string; dir: string; safe: string; account: string }
export const IMPORT_SOURCES: Record<string, ImportSourceDef>

export interface ImportProfile { id: string; dir: string; name: string; email: string | null }

/** Enumerate a browser's profiles from Local State → info_cache (no decryption, no prompt). */
export function listProfiles(src?: string): ImportProfile[]

/** The cookie DB path for a profile (modern Network/Cookies, falling back to top-level Cookies). */
export function cookiePath(src: string, profileDir: string): string

/** Read the browser's Safe Storage key from the login Keychain. Raises the one consent prompt. */
export function getSafeStorageKey(src?: string): string | null

/** Decrypt one macOS v10 cookie value. Returns the value, or null if not decryptable. */
export function decryptCookieValue(encrypted: Buffer, key: Buffer, hostKey: string): string | null

export interface DecryptedCookie {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expirationDate?: number
}
export interface DecryptResult {
  cookies: DecryptedCookie[]
  stats: { total: number; decrypted: number; skipped: number }
  error?: string
}

/** Decrypt one Cookies SQLite DB (explicit path, derived key) into injection-ready records. */
export function decryptCookieRows(dbPath: string, key: Buffer, opts?: { googleOnly?: boolean }): DecryptResult

/** Decrypt a profile's cookies (resolves path from src+profileDir, derives the key from passphrase). */
export function decryptProfileCookies(
  src: string,
  profileDir: string,
  passphrase: string,
  opts?: { googleOnly?: boolean }
): DecryptResult
