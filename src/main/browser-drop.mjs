// Pure routing decision for a window-picker DROP (used by index.ts's pick_drop handler). Kept here, pure +
// dependency-free, so it's unit-testable (scripts/tests/test-browser-drop.mjs) without spinning up Electron.
//
// The rule that closes the "dropped my Chrome window and the agent grabbed ALL tabs" bug class: a dropped
// BROWSER window must resolve to its ACTIVE TAB via the connector extension (real DOM at tab resolution), and
// must NEVER silently fall back to a whole-window AX/screenshot grab (which exposes every tab and misleads the
// agent). If the tab can't be resolved (the connector is momentarily down / not loaded), the drop fails LOUDLY
// so the user knows, instead of degrading into a confusing whole-window connection. A non-browser window still
// connects as a native window — that's the right and only path for it.

// Chromium-family browsers whose tabs the BlitzOS Connector extension drives (connection-tab-link). Safari is
// deliberately NOT here: it has no extension link, so a Safari drop stays on the native-window path for now.
// TODO(safari): route a Safari window drop to its active tab via the Apple-Events safari link, then add it here.
export const CHROMIUM_BROWSER_BUNDLES = new Set([
  'com.google.Chrome',
  'com.google.Chrome.beta',
  'com.google.Chrome.dev',
  'com.google.Chrome.canary',
  'org.chromium.Chromium',
  'com.brave.Browser',
  'com.brave.Browser.beta',
  'com.brave.Browser.nightly',
  'company.thebrowser.Browser', // Arc
  'com.microsoft.edgemac',
  'com.microsoft.edgemac.Beta',
  'com.microsoft.edgemac.Dev',
  'com.operasoftware.Opera',
  'com.vivaldi.Vivaldi'
])

// Is this dropped window a Chromium-family browser (so it should resolve to a tab, not a whole window)?
// bundleId is authoritative; the app-name regex is only a backstop for when the helper couldn't read a bundleId.
// Safari is explicitly excluded from the name backstop so it keeps the native-window path.
export function isChromiumBrowser(bundleId, app) {
  if (CHROMIUM_BROWSER_BUNDLES.has(String(bundleId || ''))) return true
  const b = String(bundleId || '').toLowerCase()
  if (b) return false // a real bundleId that isn't in the set → trust it, not the fuzzy name
  const n = String(app || '').toLowerCase()
  return /\b(google chrome|chromium|brave|vivaldi|opera|microsoft edge|arc)\b/.test(n)
}

/**
 * Decide how to bind a dropped window.
 * @param {{ isBrowser: boolean, tabId: number|null }} p
 * @returns {'tab'|'window'|'error'}  'tab' → connectTab(tabId); 'window' → connectWindow; 'error' → surface,
 *   never connect (a browser whose tab couldn't be resolved — connector unavailable).
 */
export function decideDrop({ isBrowser, tabId }) {
  if (isBrowser) return tabId != null ? 'tab' : 'error'
  return 'window'
}
