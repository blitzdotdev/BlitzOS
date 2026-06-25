// The ELECTRON half of the Chrome sign-in importer (plans/blitzos-browser-import.md). The pure core
// (browser-import-core.mjs) enumerates profiles + decrypts cookies; this binds the session injection
// on top: decrypted Google cookies go straight into the `persist:agentos` partition (the same session
// every web surface uses), so the built-in browser inherits the user's Google login and every "Sign in
// with Google" site becomes one-tap. Verified end-to-end feasible on a real Chrome 2026-06-13.
//
// SECURITY: the decrypted values are the user's identity. They live only in memory here and go
// straight into the session's encrypted store via cookies.set; nothing is logged or written as
// plaintext. The Safe Storage key read (in the core) raises one Keychain prompt — the consent gate.
import { session } from 'electron'
import { listProfiles, getSafeStorageKey, decryptProfileCookies, IMPORT_SOURCES } from './browser-import-core.mjs'
import type { DecryptedCookie, DecryptResult } from './browser-import-core.mjs'

const PARTITION = 'persist:agentos'

export interface ImportProfile { id: string; dir: string; name: string; email: string | null }
export interface ImportResult {
  ok: boolean
  reason?: 'denied' | 'no-cookies' | 'unavailable' | 'error'
  account?: string | null
  imported?: number
  failed?: number
  skipped?: number
  signedIn?: boolean
  error?: string
}

/** The chromium browsers we can import from that are actually installed (for the picker's source list). */
export function importSources(): { id: string; name: string; profiles: ImportProfile[] }[] {
  if (process.platform !== 'darwin') return []
  const out: { id: string; name: string; profiles: ImportProfile[] }[] = []
  for (const id of Object.keys(IMPORT_SOURCES)) {
    try {
      const profiles = listProfiles(id) as ImportProfile[]
      if (profiles.length) out.push({ id, name: IMPORT_SOURCES[id].name, profiles })
    } catch { /* a source that fails to enumerate is simply not offered */ }
  }
  return out
}

/** List one source's profiles (the account picker). No decryption, no prompt. */
export function listImportProfiles(src = 'chrome'): ImportProfile[] {
  if (process.platform !== 'darwin') return []
  try { return listProfiles(src) as ImportProfile[] } catch { return [] }
}

/** Inject decrypted cookies into the BlitzOS session. Per-cookie try/catch so one malformed cookie
 *  (e.g. a __Host- with a stray domain) never aborts the import. Returns {set, failed}. */
async function injectCookies(cookies: DecryptedCookie[]): Promise<{ set: number; failed: number }> {
  const sess = session.fromPartition(PARTITION)
  let set = 0, failed = 0
  for (const c of cookies) {
    try { await sess.cookies.set(c); set++ } catch { failed++ }
  }
  return { set, failed }
}

/** Import the Google sign-in from a chosen browser profile into the BlitzOS session. Raises the one
 *  Keychain consent prompt (via the core's Safe Storage read). On success the built-in browser is
 *  logged into the user's Google account, so Gmail/Docs work and every Google-OAuth site is one-tap. */
export async function importGoogleSignin(src = 'chrome', profileId?: string): Promise<ImportResult> {
  if (process.platform !== 'darwin') return { ok: false, reason: 'unavailable' }
  const profiles = listImportProfiles(src)
  const profile = profiles.find((p) => p.id === profileId) || profiles[0]
  if (!profile) return { ok: false, reason: 'unavailable' }

  const key = getSafeStorageKey(src) // the consent prompt
  if (!key) return { ok: false, reason: 'denied', account: profile.email }

  let decrypted: DecryptResult
  try {
    decrypted = decryptProfileCookies(src, profile.id, key, { googleOnly: true })
  } catch (e) {
    return { ok: false, reason: 'error', account: profile.email, error: (e as Error).message?.slice(0, 80) }
  }
  if (decrypted.error) return { ok: false, reason: 'error', account: profile.email, error: decrypted.error }
  if (!decrypted.cookies.length) return { ok: false, reason: 'no-cookies', account: profile.email }

  const { set, failed } = await injectCookies(decrypted.cookies)
  // Cheap verification: the SID cookie landing on .google.com is the signed-in signal.
  let signedIn = false
  try {
    const sid = await session.fromPartition(PARTITION).cookies.get({ domain: '.google.com', name: 'SID' })
    signedIn = sid.length > 0
  } catch { /* non-fatal */ }

  console.log(`[browser-import] ${src}/${profile.id} (${profile.email || 'unknown'}): injected ${set} google cookies (${failed} failed, ${decrypted.stats.skipped} skipped), signedIn=${signedIn}`)
  return { ok: set > 0, account: profile.email, imported: set, failed, skipped: decrypted.stats.skipped, signedIn }
}
