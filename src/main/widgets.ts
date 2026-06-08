import { ipcMain } from 'electron'
import { loadRecord } from './tokenStore'
import { fetchProviderResource, PROVIDER_DATA } from './widget-catalog.mjs'
import { osLoadConsent, osPersistConsent } from './osActions'
import { electronOps } from './electron-os-tools'
import { makeWidgetToolRunner, makeWidgetToolHandlers } from './widget-tools.mjs'

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

// #53: persist the widget grants (the `surfaces` slice) to the active workspace so they survive a restart.
function persistWidgetConsent(): void {
  osPersistConsent({ surfaces: [...consentGranted] })
}

/** Drop every consent grant for a surface (its code changed, or it closed). */
export function dropConsent(surfaceId: string): void {
  let changed = false
  for (const k of consentGranted) if (k.startsWith(`${surfaceId}:`)) (consentGranted.delete(k), (changed = true))
  if (changed) persistWidgetConsent()
}

export function registerWidgets(): void {
  // Restore the workspace's persisted widget grants on boot (the host exists by now — initOsActions ran).
  for (const s of osLoadConsent().surfaces) consentGranted.add(s)
  ipcMain.handle('widget:req', async (_e, req: WidgetDataRequest): Promise<WidgetRequestResult> => {
    if (!req || req.op !== 'data') return { ok: false, error: `unsupported op: ${req?.op}` }
    // Closed registry (own-property) check BEFORE consent — mirrors the server route
    // (unknown resource is a 404-style error, never a consent prompt).
    const providers = PROVIDER_DATA as unknown as Record<string, Record<string, unknown>>
    if (!hasOwn(providers, req.provider) || !hasOwn(providers[req.provider], req.resource)) {
      return { ok: false, error: `unknown data resource ${req.provider}/${req.resource}` }
    }
    // No consent gate (removed) — a widget reads its integration data directly. Closed registry + rate-limit remain.
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
    if (surfaceId && provider) {
      consentGranted.add(`${surfaceId}:${provider}`)
      persistWidgetConsent() // #53: survives restart
    }
    return { ok: true }
  })

  ipcMain.handle('widget:consent:revoke', (_e, surfaceId: string): { ok: boolean } => {
    if (surfaceId) dropConsent(surfaceId)
    return { ok: true }
  })

  // blitz.tool — a sandboxed widget calls an OS tool (gated by the `tools` capability in the renderer).
  // The CLOSED allowlist + handler logic (widget-tools.mjs) is shared with the server; we bind it to the SAME
  // electronOps the agent registry uses, so the widget contract can't drift between desktop and server.
  // provider_call rides the relay-grade gated path (writes → approval card) via electronOps.providerCall.
  const runWidgetTool = makeWidgetToolRunner(makeWidgetToolHandlers(electronOps))
  ipcMain.handle('widget:tool', (_e, req: { surfaceId?: string; name?: string; args?: unknown }) =>
    runWidgetTool(String(req?.name || ''), req?.args, { surfaceId: String(req?.surfaceId || '') })
  )
}
