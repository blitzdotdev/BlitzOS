// Types for browser-drop.mjs (the pick_drop routing decision).
export const CHROMIUM_BROWSER_BUNDLES: Set<string>
export function isChromiumBrowser(bundleId: unknown, app: unknown): boolean
export function decideDrop(p: { isBrowser: boolean; tabId: number | null }): 'tab' | 'window' | 'error'
