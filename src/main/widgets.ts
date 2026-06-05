import { ipcMain } from 'electron'
import { loadRecord } from './tokenStore'
import { fetchProviderResource, PROVIDER_DATA } from './widget-catalog.mjs'

// Electron-side widget data bridge (parity with preview/backend.mjs's data route).
// The renderer relays a sandboxed widget's data request here; we authorize it
// against the consent ledger, read the provider's token from the encrypted store,
// and return ONLY normalized data — the token never leaves main.

export interface WidgetDataRequest {
  surfaceId: string
  op: 'data'
  provider: string
  resource: string
}

export interface WidgetRequestResult {
  ok: boolean
  data?: unknown
  error?: string
  code?: string
}

// `${surfaceId}:${provider}` the human approved in the renderer consent prompt.
const consentGranted = new Set<string>()
const lastFetch = new Map<string, number>() // `${surface}:${provider}:${resource}` -> ts
const hasOwn = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** Drop every consent grant for a surface (its code changed, or it closed). */
export function dropConsent(surfaceId: string): void {
  for (const k of consentGranted) if (k.startsWith(`${surfaceId}:`)) consentGranted.delete(k)
}

export function registerWidgets(): void {
  ipcMain.handle('widget:req', async (_e, req: WidgetDataRequest): Promise<WidgetRequestResult> => {
    if (!req || req.op !== 'data') return { ok: false, error: `unsupported op: ${req?.op}` }
    // Closed registry (own-property) check BEFORE consent — mirrors the server route
    // (unknown resource is a 404-style error, never a consent prompt).
    const providers = PROVIDER_DATA as unknown as Record<string, Record<string, unknown>>
    if (!hasOwn(providers, req.provider) || !hasOwn(providers[req.provider], req.resource)) {
      return { ok: false, error: `unknown data resource ${req.provider}/${req.resource}` }
    }
    if (!consentGranted.has(`${req.surfaceId}:${req.provider}`)) {
      return { ok: false, code: 'consent_required', error: `consent required for ${req.provider}` }
    }
    const rk = `${req.surfaceId}:${req.provider}:${req.resource}`
    const now = Date.now()
    if (now - (lastFetch.get(rk) || 0) < 500) return { ok: false, error: 'slow down', code: 'rate_limited' }
    lastFetch.set(rk, now)
    const token = loadRecord(req.provider)?.secrets.access_token as string | undefined
    try {
      const data = await fetchProviderResource(req.provider, req.resource, token)
      return { ok: true, data }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('widget:consent', (_e, surfaceId: string, provider: string): { ok: boolean } => {
    if (surfaceId && provider) consentGranted.add(`${surfaceId}:${provider}`)
    return { ok: true }
  })

  ipcMain.handle('widget:consent:revoke', (_e, surfaceId: string): { ok: boolean } => {
    if (surfaceId) dropConsent(surfaceId)
    return { ok: true }
  })
}
