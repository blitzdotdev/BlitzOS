// Pure, transport-agnostic popup classification — what a window.open / target=_blank BECOMES, from
// web-platform signals ONLY (never a hostname). Split out of guest-capabilities.ts (which imports
// electron) so it is unit-testable headlessly and reusable by server mode (the same classifier decides
// how a headless-Chromium orphan target is adopted). See guest-capabilities.ts for how each plan is applied.

/** Parse a window.open `features` string ("width=500,height=600,popup=1") into a lowercased map. */
export function parseFeatures(features) {
  const out = {}
  for (const part of String(features || '').split(',')) {
    const [k, v] = part.split('=')
    if (k && k.trim()) out[k.trim().toLowerCase()] = (v ?? '').trim()
  }
  return out
}

/**
 * Decide what a popup becomes:
 *  - { kind:'hidden' }           about:blank scripted utility child (gapi RPC) → real but invisible; self-closes.
 *  - { kind:'window', width, height }  the page asked for a SIZED popup (every OAuth/share/payment flow does
 *                                `window.open(url,'name','width=…,height=…')`) → a real visible window. This is
 *                                what generalizes the old accounts.google.com special-case WITHOUT a hostname.
 *  - { kind:'surface' }          a link click (disposition foreground/background-tab) → a new web surface.
 *  - { kind:'deny' }             a scripted window.open to a URL with no size + no gesture (helper frames,
 *                                popunders) → refuse; the caller swallows the top.location fallback (anti-hijack).
 * @param {{url?:string, features?:string, disposition?:string, frameName?:string}} details
 */
export function classifyPopup(details) {
  const url = String((details && details.url) || '')
  if (url === 'about:blank') return { kind: 'hidden' }
  if (!/^https?:\/\//.test(url)) return { kind: 'deny' } // javascript:, data:, file:, custom schemes never become windows
  const f = parseFeatures(details && details.features)
  const w = parseInt(f.width || f.innerwidth || '', 10)
  const h = parseInt(f.height || f.innerheight || '', 10)
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    // clamp so a hostile feature string can't open a 30000px window
    return { kind: 'window', width: Math.min(Math.max(w, 240), 1400), height: Math.min(Math.max(h, 160), 1200) }
  }
  const disp = details && details.disposition
  if (disp === 'foreground-tab' || disp === 'background-tab') return { kind: 'surface' }
  return { kind: 'deny' }
}
