// test-notch-hit-window.mjs — guards the BULLETPROOF notch toggle. The toggle-in/out-of-BlitzOS target used to be a
// hardcoded 200px DOM pill in the click-through overlay, armed via a mousemove race and shrinking to that strip in
// fullscreen. Now: a native CLI reads the EXACT physical notch (NSScreen ears + safe-area inset), and a dedicated
// always-interactive transparent window is placed over it — clickable in EVERY state, no race. No physical notch =>
// no window (⌥Space only). These asserts keep a future edit from regressing that. Run: node scripts/test-notch-hit-window.mjs
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const swift = readFileSync(join(repoRoot, 'native/notch-geometry/main.swift'), 'utf8')
const overlay = readFileSync(join(repoRoot, 'src/main/notch-overlay.ts'), 'utf8')
const index = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
const preload = readFileSync(join(repoRoot, 'src/preload/index.ts'), 'utf8')
const app = readFileSync(join(repoRoot, 'src/renderer/src/App.tsx'), 'utf8')
const notchHost = readFileSync(join(repoRoot, 'src/renderer/src/notch/NotchHost.tsx'), 'utf8')
const css = readFileSync(join(repoRoot, 'src/renderer/src/styles.css'), 'utf8')

let failures = 0
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
}

console.log('Notch hit-window (bulletproof, exact physical notch):')

// ── native: read the REAL notch geometry ─────────────────────────────────────────────────────────────────────
ok('the native CLI reads the EXACT notch: the gap between the menu-bar ears + the safe-area top inset',
  /auxiliaryTopLeftArea/.test(swift) && /auxiliaryTopRightArea/.test(swift) && /safeAreaInsets/.test(swift) &&
    /hasNotch/.test(swift) && /notchWidth/.test(swift))
ok('the notch-geometry build.sh exists (built to a binary; dist-mac.sh bundles it — see the TODO)',
  existsSync(join(repoRoot, 'native/notch-geometry/build.sh')))

// ── main: the always-interactive hit-window placed over the physical notch, ABOVE the overlay ────────────────
ok('notch-overlay exports the geometry read + hit rect + hit-window opts + the inline catcher page',
  /export function readNotchGeometry/.test(overlay) && /export function notchHitRect/.test(overlay) &&
    /export function notchHitWindowOptions/.test(overlay) && /export const NOTCH_HIT_HTML/.test(overlay))
ok('the hit-window is INTERACTIVE (transparent, acceptFirstMouse, the main preload) — not the click-through overlay',
  /notchHitWindowOptions/.test(overlay) && /transparent: true/.test(overlay) && /acceptFirstMouse: true/.test(overlay) &&
    /preload: preloadPath/.test(overlay))
ok('main creates the hit-window STRICTLY ABOVE the overlay (screen-saver relativeLevel 1) + only when a real notch exists',
  /new BrowserWindow\(notchHitWindowOptions/.test(index) && /setAlwaysOnTop\(true, 'screen-saver', 1\)/.test(index) &&
    /const rect = notchHitRect\(notchGeom\)/.test(index) && /if \(!rect\)/.test(index))
ok('main forwards the hit-window click/hover to the overlay renderer + pushes the REAL notch width + hasNotch',
  /ipcMain\.on\('os:notch-click'[\s\S]*?'os:notch-handle-click'/.test(index) &&
    /ipcMain\.on\('os:notch-hover'[\s\S]*?'os:notch-handle-hover'/.test(index) &&
    /notchWidth: notchGeom\?\.hasNotch/.test(index) && /hasNotch: !!notchGeom\?\.hasNotch/.test(index))

// ── preload + renderer wiring ────────────────────────────────────────────────────────────────────────────────
ok('preload exposes the bridge: notch.click/hover (hit-window → main) + onHandleClick/onHandleHover (→ overlay)',
  /click\(\): void \{[\s\S]*?'os:notch-click'/.test(preload) && /hover\(on: boolean\): void \{[\s\S]*?'os:notch-hover'/.test(preload) &&
    /onHandleClick/.test(preload) && /onHandleHover/.test(preload))
ok('renderer: hit-window CLICK → toggleNewSession (island panel; V1 has no canvas fullscreen), HOVER → open/close the panel',
  /onHandleClick\?\.\(\(\) => toggleNewSession\(\)\)/.test(app) && /onHandleHover\?\.\(\(on\) =>/.test(app))
ok('renderer: hover-opened island has close hysteresis and the chassis keeps the overlay interactive for clicks',
  /NOTCH_HOVER_OPEN_GRACE_MS/.test(app) && /scheduleNotchHoverClose/.test(app) && /onChassisHoverChange=\{setChassisHover\}/.test(app) &&
    /onPointerEnter=\{\(\) => onChassisHoverChange\?\.\(true\)\}/.test(notchHost) &&
    /onPointerMove=\{\(\) => onChassisHoverChange\?\.\(true\)\}/.test(notchHost) &&
    /onPointerLeave=\{\(\) => onChassisHoverChange\?\.\(false\)\}/.test(notchHost))
ok('renderer: the visual pill uses the REAL notch width + is gated on a real notch (no notch → no band, ⌥Space only)',
  /style=\{\{ width: notchWidth/.test(app) && /notchOn && hasNotch &&/.test(app) &&
    /notchClipFor\(notchState[\s\S]*?notchWidth\)/.test(app))
ok('the pill is VISUAL ONLY — clicks belong to the hit-window (.notch-handle is pointer-events:none)',
  /\.notch-handle \{[\s\S]*?pointer-events: none/.test(css))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
