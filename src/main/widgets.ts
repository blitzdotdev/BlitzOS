import { ipcMain } from 'electron'
import { loadRecord } from './tokenStore'
import { fetchProviderResource, PROVIDER_DATA } from './widget-catalog.mjs'
import {
  osLoadConsent,
  osPersistConsent,
  osCreateSurface,
  osOpenWindow,
  osMoveSurface,
  osUpdateSurface,
  osCloseSurface,
  osGroupIntoFolder,
  osGoToPrimary,
  osGetState,
  type SurfaceDescriptor
} from './osActions'
import { runProviderCall } from './provider-bridge'
import { makeWidgetToolRunner } from './widget-tools.mjs'

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
  // The CLOSED allowlist (widget-tools.mjs) is the same on both transports; we dispatch to the SAME os*
  // functions the relay uses. provider_call rides the relay-grade gated path (writes → approval card).
  const runWidgetTool = makeWidgetToolRunner({
    create_surface: (a) => osCreateSurface(a as unknown as SurfaceDescriptor),
    open_window: (a) => osOpenWindow(a as { url: string; x?: number; y?: number; w?: number; h?: number; title?: string }),
    move_surface: (a) => (osMoveSurface(String(a.id), Number(a.x) || 0, Number(a.y) || 0), { ok: true }),
    update_surface: (a) => (osUpdateSurface(String(a.id), (a.patch && typeof a.patch === 'object' ? a.patch : a) as Record<string, unknown>), { ok: true }),
    close_surface: (a) => (osCloseSurface(String(a.id)), { ok: true }),
    group: (a) => osGroupIntoFolder(String(a.name || 'Folder'), Array.isArray(a.ids) ? a.ids.map(String) : [], Number(a.x) || 0, Number(a.y) || 0, a.kind === 'board' ? 'board' : 'folder'),
    go_to_primary: () => (osGoToPrimary(), { ok: true }),
    list_state: () => osGetState(),
    provider_call: (a) =>
      runProviderCall(
        { provider: String(a.provider || ''), method: a.method ? String(a.method) : undefined, path: String(a.path || ''), query: a.query as Record<string, unknown> | undefined, body: a.body },
        'relay'
      )
  })
  ipcMain.handle('widget:tool', (_e, req: { surfaceId?: string; name?: string; args?: unknown }) =>
    runWidgetTool(String(req?.name || ''), req?.args, { surfaceId: String(req?.surfaceId || '') })
  )
}
