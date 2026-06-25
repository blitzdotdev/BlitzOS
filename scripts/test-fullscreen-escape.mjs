// test-fullscreen-escape.mjs — guards the fix for the "BlitzOS randomly goes fullscreen on every desktop and you
// can't quit / exit" trap. The original two causes lived in the now-removed sandwich compositor + WebContentsView
// page-fullscreen. With web as in-DOM <webview> and the notch as ONE overlay window, the SURVIVING protections are
// asserted here so a future edit can't re-open the trap:
//   1. The notch overlay window is NEVER native-fullscreenable — an all-Spaces overlay going native-fullscreen
//      traps the user with no exit chrome. notch-overlay opts set fullscreenable:false, and index.ts creates the
//      notch-gated window with fullscreen:false.
//   2. os:shell-fullscreen (the custom green light) is a NO-OP in notch mode; the notch's "fullscreen" is the
//      renderer clip-grow, never a native window fullscreen of the overlay.
//   3. The old WebContentsView page-fullscreen key-steal routing (onPageFullscreen/focusPages) is GONE — a page's
//      <video> now enters fullscreen natively on its own <webview>.
// Run: node scripts/test-fullscreen-escape.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const overlaySrc = readFileSync(join(repoRoot, 'src/main/notch-overlay.ts'), 'utf8')
const index = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
const osActions = readFileSync(join(repoRoot, 'src/main/osActions.ts'), 'utf8')

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

ok('the notch overlay window is NOT native-fullscreenable (fullscreenable:false in notch-overlay opts)',
  /fullscreenable: false/.test(overlaySrc))
ok('index.ts creates the notch-gated window with fullscreen:false (an all-Spaces overlay never native-fullscreens)',
  /fullscreen: notchGated \? false/.test(index))
ok('os:shell-fullscreen is a NO-OP in notch mode (the green light cannot native-fullscreen the overlay)',
  /ipcMain\.on\(\s*'os:shell-fullscreen'[\s\S]*?notchGated\) return/.test(index))
ok('the old WebContentsView page-fullscreen key-steal routing is gone (no onPageFullscreen / focusPages in osActions)',
  !/onPageFullscreen/.test(osActions) && !/focusPages/.test(osActions))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
