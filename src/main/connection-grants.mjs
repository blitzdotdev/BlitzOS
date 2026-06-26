// The permission model for connections (plans/blitzos-permissions-helper-todo.md, P0).
// ONE place that (a) describes each macOS grant a connection can need in human terms, and (b) maps a raw
// helper/osascript failure → the grant it means. The UI renders the descriptor as a clear card with an action
// button; the agent surfaces it as a structured `permission_required` error. The grant is always requested on
// the HELPER (dev.blitz.os.computeruse), so BlitzOS itself never prompts.

// Settings deep-links (open the EXACT pane when macOS won't re-prompt a denied grant — the dead-end fix).
const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?'
export const GRANTS = {
  accessibility: {
    grant: 'accessibility',
    title: 'Let Blitz control your apps',
    why: 'Blitz needs Accessibility to see and operate app windows for you.',
    button: 'Enable Accessibility',
    settings: PRIVACY + 'Privacy_Accessibility',
    kind: 'settings' // macOS grants this only from Settings (no inline Allow)
  },
  screen: {
    grant: 'screen',
    title: 'Let Blitz see the screen',
    why: 'Blitz needs Screen Recording to see what is on screen and click accurately.',
    button: 'Enable Screen Recording',
    settings: PRIVACY + 'Privacy_ScreenCapture',
    kind: 'settings'
  },
  'automation:systemevents': {
    grant: 'automation:systemevents',
    title: 'Let Blitz drive menus',
    why: 'Blitz needs permission to control System Events so it can open menus for you.',
    button: 'Grant permission',
    settings: PRIVACY + 'Privacy_Automation',
    kind: 'prompt'
  },
  'automation:chrome': {
    grant: 'automation:chrome',
    title: 'Let Blitz work in Chrome',
    why: 'Blitz needs permission to control Google Chrome so it can act in your tabs.',
    button: 'Grant permission',
    settings: PRIVACY + 'Privacy_Automation',
    kind: 'prompt' // an inline Allow dialog the first time; Settings only if previously denied
  },
  'automation:safari': {
    grant: 'automation:safari',
    title: 'Let Blitz work in Safari',
    why: 'Blitz needs permission to control Safari so it can act in your tabs.',
    button: 'Grant permission',
    settings: PRIVACY + 'Privacy_Automation',
    kind: 'prompt'
  },
  'allowjs:chrome': {
    grant: 'allowjs:chrome',
    title: 'Turn on Chrome scripting',
    why: 'Chrome needs "Allow JavaScript from Apple Events" (a one-time setting) so Blitz can read and act in tabs.',
    button: 'Turn it on',
    settings: '',
    kind: 'allowjs'
  }
}

/** Map a raw connection/helper error → the grant descriptor it requires, or null if it is NOT a permission
 *  problem. `browser` ('chrome'|'safari') disambiguates the Automation/Allow-JS targets, since the raw osascript
 *  error code (-1743) does not name the app. */
export function permissionFromError(err, browser) {
  const s = String((err && err.message) || err || '').toLowerCase()
  if (!s) return null
  if (/event tap|\baccessibility\b|axisprocesstrusted/.test(s)) return GRANTS.accessibility
  if (/-3801|screen recording|scstream|screencapturekit|declined.*capture/.test(s)) return GRANTS.screen
  if (/javascript through applescript|allow javascript from apple events|javascript apple events/.test(s)) {
    return browser === 'safari' ? null : GRANTS['allowjs:chrome'] // Safari uses its own Develop-menu toggle; chrome here
  }
  if (/-1743|not allowed|not authori[sz]ed|apple ?events|automation|requires.*entitlement/.test(s)) {
    return GRANTS[browser === 'safari' ? 'automation:safari' : 'automation:chrome']
  }
  return null
}

/** The grant a connection of this kind needs up front (so the UI can pre-empt the failure on drag/connect).
 *  browser tab → control that browser; native window → Accessibility (the pick/AX) + Screen Recording (vision). */
export function grantForConnection({ type, browser }) {
  if (type === 'tab') return GRANTS[browser === 'safari' ? 'automation:safari' : 'automation:chrome']
  if (type === 'window') return GRANTS.accessibility
  return null
}

/** Classify a browser listTabs failure → the coarse state the connector list renders for that browser: 'denied'
 *  (Automation said no — open Settings), 'allowjs' (the Allow-JS setting is off), 'helper' (no computer-use helper),
 *  else 'unreachable' (not running / no windows). The caller sets 'ok' on success. */
export function classifyBrowserState(err) {
  const s = String((err && err.message) || err || '').toLowerCase()
  if (/-1743|not allowed|not authori[sz]ed/.test(s)) return 'denied'
  if (/javascript through applescript|allow javascript from apple events/.test(s)) return 'allowjs'
  if (/helper (unavailable|not connected)/.test(s)) return 'helper'
  return 'unreachable'
}

/** The grant descriptor for a browser whose connector row is in a non-ok state, or null if there's nothing to grant
 *  (e.g. just not running). 'denied' → Automation; 'allowjs' → the Allow-JS toggle. */
export function grantForBrowserState(browser, state) {
  if (state === 'denied') return GRANTS[browser === 'safari' ? 'automation:safari' : 'automation:chrome']
  if (state === 'allowjs') return GRANTS['allowjs:chrome']
  return null
}

/** The macOS bundle id for a browser — for the helper's no-prompt Automation status check. */
export function browserBundleId(browser) {
  return browser === 'safari' ? 'com.apple.Safari' : 'com.google.Chrome'
}

/** NO-PROMPT gate for a browser's listTabs. Given the helper's automationGranted() result, decide whether the
 *  caller may RUN the (prompting) Apple Event. Only 'granted' runs it; everything else returns the connector state
 *  to show WITHOUT prompting. This is load-bearing: a PASSIVE poll (refreshTabs every 2.5s) must never raise the
 *  "control Safari/Chrome" consent — it pops UNDER the window-picker overlay and is unclickable. The user grants
 *  via the connector's grant row / drop card instead, where the overlay is torn down first. auth is
 *  'granted' | 'denied' | 'undetermined' | 'unknown'. Returns null = "run listTabs", else the state string. */
export function browserListTabsGate(auth) {
  if (auth === 'granted') return null
  return auth === 'denied' ? 'denied' : 'unreachable' // 'undetermined'/'unknown' → "Click to connect" (no prompt)
}
