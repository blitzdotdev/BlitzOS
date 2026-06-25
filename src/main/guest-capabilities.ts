import { session, type WebContents, type Session, type HandlerDetails, type WindowOpenHandlerResponse } from 'electron'
import { basename, join } from 'path'
import { randomUUID } from 'crypto'
import { getPermission, setPermission } from './workspace.mjs'
import { classifyPopup, type PopupPlan } from './popup-policy.mjs'

// THE ONE owner of every browser-initiated "escape hatch" a `web` guest can trigger — popups, downloads,
// permission prompts, beforeunload. A guest is a real browsing context, so it does real-browser things;
// BlitzOS must answer each the way a browser would, but as an OS (a popup becomes a surface; a download
// becomes a file on the canvas; a permission prompt is a real Allow/Block the human answers and we remember).
//
// CONTENT-AGNOSTIC IS THE RULE. Policy is keyed on WHAT KIND of action it is (web-platform semantics), never
// on WHICH SITE. No hostnames here — the hostname checks the popup hotfix shipped (accounts.google.com,
// contacts.google.com) are exactly what this module exists to delete.
//
// Wired at two altitudes (index.ts): session-level handlers (download, permission) set ONCE on the shared
// persist:agentos session cover every present + future guest; the per-guest window-open/unload handlers
// attach in the WebContentsView host. Server-mode parity (headless Chromium) is a follow-up: popups there are
// orphan Target.targetCreated targets to adopt as surfaces (noted in browser-host.mjs).

const PARTITION = 'persist:agentos'

// Popup classification (classifyPopup / PopupPlan) is the pure, unit-tested policy in popup-policy.mjs —
// content-agnostic, no hostnames. This module APPLIES each plan to Electron's window-open handler.
export type { PopupPlan } from './popup-policy.mjs'

const SAFE_CHILD = { nodeIntegration: false, contextIsolation: true, sandbox: true } as const

/**
 * Attach the per-guest popup + unload policy. `openSurface(url)` makes a new web surface (osCreateSurface).
 * `logPlan` (optional) records each decision so real-world `features`/`disposition` values are visible in
 * the log and the classifier can be tuned from data instead of guesswork.
 */
export function attachGuestWindowPolicy(guest: WebContents, opts: { openSurface: (url: string) => void; logPlan?: (plan: PopupPlan, details: HandlerDetails) => void }): void {
  // A popup we DENY may retry as `top.location = url` (the hijack this policy stops). Remember each denial
  // briefly and swallow the matching top-frame navigation below.
  const deniedNav = new Map<string, number>()
  const DENY_NAV_TTL = 4000

  guest.setWindowOpenHandler((details): WindowOpenHandlerResponse => {
    const plan = classifyPopup(details)
    opts.logPlan?.(plan, details)
    switch (plan.kind) {
      case 'hidden':
        return { action: 'allow', overrideBrowserWindowOptions: { show: false, width: 80, height: 60, webPreferences: { ...SAFE_CHILD } } }
      case 'window':
        return { action: 'allow', overrideBrowserWindowOptions: { width: plan.width, height: plan.height, webPreferences: { ...SAFE_CHILD } } }
      case 'surface':
        opts.openSurface(details.url)
        return { action: 'deny' }
      case 'deny':
      default:
        deniedNav.set(details.url, Date.now())
        if (deniedNav.size > 50) for (const [u, t] of deniedNav) if (Date.now() - t > DENY_NAV_TTL) deniedNav.delete(u)
        return { action: 'deny' }
    }
  })

  guest.on('will-navigate', (e, url) => {
    const t = deniedNav.get(url)
    if (t != null) {
      deniedNav.delete(url)
      if (Date.now() - t < DENY_NAV_TTL) e.preventDefault() // a denied popup's top.location fallback = a hijack, not a real nav
    }
  })

  // beforeunload must never block the agent (or human) from closing/navigating a surface. (persistence.ts
  // adds the same on quit; both calling preventDefault is harmless.)
  guest.on('will-prevent-unload', (e) => e.preventDefault())
}

// ---------- Downloads ----------

/** Stream a guest download INTO the active workspace folder so it lands on the canvas as a file tile —
 *  the OS-correct "where did my download go". Set once on the partition session. */
function installDownloads(sess: Session, getDownloadDir: () => string | null, onSettled?: () => void): void {
  sess.on('will-download', (_e, item) => {
    const dir = getDownloadDir()
    if (!dir) return // no active workspace dir → let Electron's default save dialog handle it
    const name = basename(item.getFilename() || 'download') || 'download'
    // basename() jails to the workspace root; if it already exists Electron appends " (1)" itself.
    item.setSavePath(join(dir, name))
    item.once('done', (_ev, state) => {
      if (state === 'completed') onSettled?.() // the folder watcher reconciles it into a tile
    })
  })
}

// ---------- Permissions (real Allow/Block, remembered per origin) ----------

// The sensitive permissions a real browser PROMPTS for (parity). Anything not here is auto-allowed if
// harmless or auto-denied — see decideStatic.
const PROMPTABLE = new Set(['geolocation', 'notifications', 'media', 'midiSysex', 'clipboard-read', 'display-capture', 'window-management'])
// Harmless, gesture-gated-by-Chromium-anyway → allow without a prompt (a browser doesn't prompt for these).
const AUTO_ALLOW = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write'])

/** Non-promptable permissions resolve synchronously; promptable ones return null (→ ask the human). */
function decideStatic(permission: string): boolean | null {
  if (AUTO_ALLOW.has(permission)) return true
  if (PROMPTABLE.has(permission)) return null
  return false // openExternal, idle-detection, unknown… default-deny (safe)
}

function originOf(url: string | undefined): string {
  try {
    return new URL(String(url || '')).origin
  } catch {
    return ''
  }
}

// In-flight prompts: id → the Electron callback awaiting the human's Allow/Block.
const pending = new Map<string, { resolve: (granted: boolean) => void; origin: string; permission: string }>()

export interface PermissionPrompt {
  id: string
  origin: string
  permission: string
  surfaceId: string | null
}

/**
 * Install the permission request + check handlers on the guest session. `broadcast` shows the human a
 * real Allow/Block prompt (renderer); `surfaceIdFor` maps the requesting webContents to its surface so
 * the prompt can anchor to it. Remembered per-origin decisions in the root journal skip the prompt.
 */
function installPermissions(sess: Session, root: string, broadcast: (p: PermissionPrompt) => void, surfaceIdFor: (wc: WebContents) => string | null): void {
  sess.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = originOf((details as { requestingUrl?: string })?.requestingUrl) || originOf(wc?.getURL?.())
    const stat = decideStatic(permission)
    if (stat !== null) return callback(stat)
    const remembered = origin ? getPermission(root, origin, permission) : null
    if (remembered) return callback(remembered === 'granted')
    // Ask the human (browser parity). Hold the callback until they decide.
    const id = randomUUID()
    pending.set(id, { resolve: (granted) => callback(granted), origin, permission })
    broadcast({ id, origin, permission, surfaceId: surfaceIdFor(wc) })
  })
  // Synchronous capability checks (e.g. a getUserMedia precheck) consult remembered grants only — never
  // prompt here (no callback), and default-deny the promptable ones until the request handler runs.
  sess.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const stat = decideStatic(permission)
    if (stat !== null) return stat
    return getPermission(root, requestingOrigin, permission) === 'granted'
  })
}

/** The human answered a prompt (renderer → main IPC). Resolves the held request and, if `remember`, persists
 *  the per-origin decision so we never ask again for that origin+permission. */
export function resolvePermissionPrompt(root: string, id: string, allow: boolean, remember: boolean): { ok: boolean } {
  const p = pending.get(id)
  if (!p) return { ok: false }
  pending.delete(id)
  if (remember && p.origin) setPermission(root, p.origin, p.permission, allow ? 'granted' : 'denied')
  p.resolve(allow)
  return { ok: true }
}

/** Set the session-level guest policy (download + permission) ONCE — covers every current/future guest. */
export function installGuestSessionPolicy(opts: {
  root: string
  getDownloadDir: () => string | null
  onDownloadSettled?: () => void
  broadcastPermission: (p: PermissionPrompt) => void
  surfaceIdFor: (wc: WebContents) => string | null
}): void {
  const sess = session.fromPartition(PARTITION)
  installDownloads(sess, opts.getDownloadDir, opts.onDownloadSettled)
  installPermissions(sess, opts.root, opts.broadcastPermission, opts.surfaceIdFor)
}
