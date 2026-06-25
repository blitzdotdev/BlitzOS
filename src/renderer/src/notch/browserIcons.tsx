// Canonical brand glyphs for the browsers BlitzOS connects to (Chrome via the connector extension, Safari via Apple
// Events). The connectors list / dropbox used to source the browser tile from the computer-use helper's real macOS
// app icon, which is ABSENT when the helper isn't running (and a generic placeholder in dev) and is only re-fetched
// on a full panel refresh — so the tile silently fell back to a bare letter ("C" for Chrome). These bundled vector
// logos make the browser icon reliable regardless of helper state. They fill their wrapper (16px row, 44px tile).
// Chrome paths are the canonical browser-logos artwork with the subtle gradients flattened to their solid brand
// colors (imperceptible at this size, and it avoids cross-instance SVG gradient-id collisions). Safari is a clean
// flat compass that reads at 16px. TODO: add Edge/Brave/Arc here if the connector starts tagging those browsers.

export function ChromeGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 256 256" width="100%" height="100%" aria-hidden focusable="false">
      <circle cx="128" cy="128" r="64" fill="#fff" />
      <path fill="#34a853" d="M96 183.4A63.7 63.7 0 0 1 72.6 160L17.2 64A128 128 0 0 0 128 256l55.4-96A64 64 0 0 1 96 183.4Z" />
      <path fill="#fbbc04" d="M192 128a63.7 63.7 0 0 1-8.6 32L128 256A128 128 0 0 0 238.9 64h-111a64 64 0 0 1 64 64Z" />
      <circle cx="128" cy="128" r="52" fill="#1a73e8" />
      <path fill="#ea4335" d="M96 72.6a63.7 63.7 0 0 1 32-8.6h110.8a128 128 0 0 0-221.7 0l55.5 96A64 64 0 0 1 96 72.6Z" />
    </svg>
  )
}

export function SafariGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 256 256" width="100%" height="100%" aria-hidden focusable="false">
      <circle cx="128" cy="128" r="120" fill="#1d8ff0" />
      <circle cx="128" cy="128" r="106" fill="none" stroke="#fff" strokeOpacity="0.5" strokeWidth="5" />
      <path fill="#fff" d="M196 60 112 112 144 144Z" />
      <path fill="#ff3b30" d="M60 196 112 112 144 144Z" />
      <circle cx="128" cy="128" r="8" fill="#fff" />
    </svg>
  )
}

// Resolve a browser key OR a macOS app name to a brand glyph; null when it isn't a known browser. Matched tightly
// (exact keys + the "Chrome (1)" group-label / "Google Chrome" app-name forms) so a non-browser app can't misfire.
export function brandGlyph(key?: string): JSX.Element | null {
  const s = (key || '').trim().toLowerCase()
  if (!s) return null
  if (s === 'chrome' || s.startsWith('chrome (') || s === 'google chrome' || s === 'chromium') return <ChromeGlyph />
  if (s === 'safari' || s.startsWith('safari (')) return <SafariGlyph />
  return null
}
