#!/usr/bin/env node
// Make `npm run dev` show "BlitzOS" (not "Electron") in the macOS menu bar.
//
// In dev, electron-vite execs the prebuilt node_modules/electron/dist/Electron.app, whose
// Info.plist CFBundleName ("Electron") sets the bold app-menu title. app.setName('BlitzOS')
// (src/main/index.ts) renames the app-menu SUBMENU items, but the OS reads the BUNDLE name for
// the bold title — Electron docs: setName "does not affect the name that the OS uses". So patch
// the dev bundle's Info.plist here. Packaged builds already brand via productName
// (electron-builder.yml), so this is dev-only.
//
// Two name sources, two fixes:
//   1. The bold app-menu title — fixed by patching CFBundleName/CFBundleDisplayName below.
//   2. The Dock hover tooltip + the ⌘Tab App Switcher — these read the LaunchServices BUNDLE
//      cache, NOT the live in-process name, so editing the plist alone leaves them showing the
//      stale cached "Electron". So we also `lsregister -f` the bundle to force LS to re-read the
//      patched plist (verified: lsappinfo/LS flip to "BlitzOS"). ~35ms on one bundle.
//
// Runs from predev on every `npm run dev`, so a fresh `npm install` (which re-extracts Electron
// and resets the name) self-heals. macOS-only, idempotent (no-op once branded), never blocks dev.
//
// We deliberately do NOT re-codesign: editing only Contents/Info.plist leaves the Mach-O's own
// signature intact, and a directly-exec'd binary validates THAT signature (not the bundle's
// resource envelope), so it still launches on arm64 — verified on this machine. The prebuilt dev
// Electron also carries no entitlements, so a re-sign would have nothing to preserve. If a future
// macOS ever SIGKILLs the patched binary, ad-hoc re-sign it: `codesign --force --sign - <bundle>`.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_NAME = 'BlitzOS'
if (process.platform !== 'darwin') process.exit(0)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = join(root, 'node_modules', 'electron')

// Resolve the EXACT bundle electron-vite launches from electron/path.txt
// (e.g. "Electron.app/Contents/MacOS/Electron"), so we patch the binary actually run.
let appSeg = 'Electron.app'
try {
  const rel = readFileSync(join(electronDir, 'path.txt'), 'utf8').trim()
  appSeg = rel.split('/').find((s) => s.endsWith('.app')) || appSeg
} catch {
  /* fall back to Electron.app */
}

const plist = join(electronDir, 'dist', appSeg, 'Contents', 'Info.plist')
if (!existsSync(plist)) {
  console.warn(`[rebrand-dev-electron] ${plist} not found — skipping (dev menu may read "Electron")`)
  process.exit(0)
}

function plistRead(key) {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// The LaunchServices registration tool (stable macOS path) — busts the Dock / App Switcher cache.
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

try {
  if (plistRead('CFBundleName') !== APP_NAME) {
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      execFileSync('/usr/bin/plutil', ['-replace', key, '-string', APP_NAME, plist])
    }
    console.log(`[rebrand-dev-electron] dev menu bar -> "${APP_NAME}"`)
  }
  // ALWAYS re-register (cheap, ~35ms): the Dock tooltip + App Switcher read the LaunchServices
  // BUNDLE cache, which a plist edit alone does not refresh. -f forces LS to re-read the patched
  // plist. Running it unconditionally also self-heals a bundle whose plist is branded but whose LS
  // cache went stale (the original bug). The next `npm run dev` then builds a fresh, correctly
  // named Dock tile; a relaunch picks it up (no `killall Dock` needed in steady state).
  try {
    execFileSync(LSREGISTER, ['-f', join(electronDir, 'dist', appSeg)], { stdio: 'ignore' })
  } catch {
    /* LS refresh is best-effort — the menu-bar title (the in-process name) is already correct. */
  }
} catch (err) {
  // Never block dev — a missing plutil or a read-only node_modules just means the menu reads "Electron".
  console.warn(`[rebrand-dev-electron] could not patch ${appSeg} Info.plist — ${err?.message || err}`)
}
