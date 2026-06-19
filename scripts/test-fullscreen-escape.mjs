// test-fullscreen-escape.mjs — guards the fix for the "BlitzOS randomly goes fullscreen on every desktop and you
// can't quit / exit" trap. Two root causes, both asserted here so a future edit fails loudly:
//
//  1. Page HTML5 fullscreen (a web video) routed macOS KEY to the hidden, EMPTY `pages` window via focusPages().
//     But the page's view is hosted in the UI window (getWindow → mainWindow = sandwich.ui), so the keyboard
//     never reached the video — Esc/Cmd+Q were dead, the chrome was hidden, and the view filled the all-Spaces
//     overlay (every desktop). Fix: onPageFullscreen must NOT focusPages() on ENTER (the view host already
//     focused the page's own webContents).
//  2. Native fullscreen (sandwich.setFullScreen → pages.setFullScreen) is incoherent in OVERLAY (notch) mode —
//     `pages` is a hidden backdrop and the UI overlay is all-Spaces, so it traps with no native exit chrome.
//     Fix: setFullScreen is a no-op when opts.overlay.
//
// Run: node scripts/test-fullscreen-escape.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const osActions = readFileSync(join(repoRoot, 'src/main/osActions.ts'), 'utf8')
const sandwich = readFileSync(join(repoRoot, 'src/main/sandwich.ts'), 'utf8')
const index = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')

let failures = 0
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
}

console.log('Fullscreen-trap escape:')

// The page views are hosted in the UI window — the premise of the bug (so focusPages routes to the wrong window).
ok('page views are hosted in the UI window (getWindow → mainWindow) and mainWindow = sandwich.ui',
  /getWindow: \(\) => mainWindow/.test(index) && /mainWindow = sandwich\.ui/.test(index))

// Extract the onPageFullscreen callback body and assert it no longer STEALS key to the empty pages window on enter.
const m = osActions.match(/onPageFullscreen:\s*\(surfaceId, on\) => \{[\s\S]*?\n {4}\}/)
ok('onPageFullscreen exists', !!m)
const body = m ? m[0] : ''
ok('onPageFullscreen does NOT focusPages() on ENTER (no key-steal to the hidden, empty pages window)',
  !!body && !/if \(on\) sandwichFocus\.focusPages\(\)/.test(body) && !/\bon\b[\s\S]*focusPages/.test(body))
ok('onPageFullscreen still hands the keyboard back to the UI on LEAVE (focusUi when !on)',
  /if \(!on\) sandwichFocus\.focusUi\(\)/.test(body))

// Native fullscreen is disabled in overlay (notch) mode — closes the Ctrl+Cmd+F / green-light trap.
const fs = sandwich.match(/const setFullScreen = \(on: boolean\): void => \{[\s\S]*?\n {2}\}/)
ok('sandwich.setFullScreen exists', !!fs)
ok('setFullScreen is a NO-OP in overlay mode (guards the incoherent native fullscreen on the all-Spaces overlay)',
  !!fs && /if \(opts\.overlay\) return/.test(fs[0]))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
