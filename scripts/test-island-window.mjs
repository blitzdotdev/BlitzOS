// test-island-window.mjs — the NOTCH MERGE (plans/blitzos-dynamic-island.md). The separate island.ts window is
// RETIRED: the real BlitzOS UI window IS the notch. The sandwich runs in OVERLAY mode (one frameless transparent
// full-display window, NOT parented, pages hidden), and the renderer (App.tsx) clips #root-canvas to a NotchShape
// and GROWS the clip to fullscreen — so the LIVE canvas expands out of the notch (no second window, no plate, no
// handoff). This test reads the source off disk and asserts the load-bearing lines so a future edit that breaks
// the merge fails loudly. Run: node scripts/test-island-window.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sandwichSrc = readFileSync(join(repoRoot, 'src/main/sandwich.ts'), 'utf8')
const indexSrc = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
const preloadSrc = readFileSync(join(repoRoot, 'src/preload/index.ts'), 'utf8')
const appSrc = readFileSync(join(repoRoot, 'src/renderer/src/App.tsx'), 'utf8')
const cssSrc = readFileSync(join(repoRoot, 'src/renderer/src/styles.css'), 'utf8')

let failures = 0
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
}

console.log('Notch merge — the real canvas window IS the notch:')

// ── sandwich.ts: OVERLAY mode (one transparent full-display window, no parenting, click-through toggle) ─────────
ok('sandwich opts accept overlay; the overlay UI window is frameless + covers the notch (enableLargerThanScreen)',
  /overlay\?: boolean/.test(sandwichSrc) &&
    /opts\.overlay[\s\S]*?frame: false[\s\S]*?enableLargerThanScreen: true/.test(sandwichSrc))
ok('overlay UI window is NOT parented (a standalone full-display overlay, not the L0-attached child)',
  /if \(!opts\.overlay\) ui\.setParentWindow\(pages\)/.test(sandwichSrc))
ok('overlay launch: showInactive (no focus steal) + screen-saver + all-Spaces + click-through (forward)',
  /if \(opts\.overlay\)/.test(sandwichSrc) && /ui\.showInactive\(\)/.test(sandwichSrc) &&
    /ui\.setAlwaysOnTop\(true, 'screen-saver'\)/.test(sandwichSrc) &&
    /ui\.setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true \}\)/.test(sandwichSrc) &&
    /ui\.setIgnoreMouseEvents\(true, \{ forward: true \}\)/.test(sandwichSrc))
ok('sandwich exposes setInteractive (toggle the overlay click-through) on the interface + the return',
  /setInteractive\(on: boolean\): void/.test(sandwichSrc) &&
    /const setInteractive = \(on: boolean\): void =>/.test(sandwichSrc) &&
    /return \{[^}]*setInteractive[^}]*\}/.test(sandwichSrc))

// ── index.ts: notch-gated overlay + the notch IPC (interactive / send / geometry / ⌥Space) ─────────────────────
ok('index.ts is notch-gated and creates the sandwich in OVERLAY mode',
  /const notchGated\s*=/.test(indexSrc) && /overlay: notchGated/.test(indexSrc))
ok('os:notch-interactive → sandwich.setInteractive (collapsed = click-through except the notch; expanded = full)',
  /ipcMain\.on\(\s*'os:notch-interactive'[\s\S]*?sandwich\?\.setInteractive/.test(indexSrc))
ok('os:notch-send spawns: Deep ON → electronOps.startWorkflow; Deep OFF → spawnAgent + userMessage',
  /ipcMain\.handle\(\s*'os:notch-send'/.test(indexSrc) &&
    /if \(payload\?\.deep\)[\s\S]*?electronOps\.startWorkflow/.test(indexSrc) &&
    /electronOps\.spawnAgent/.test(indexSrc) && /electronOps\.userMessage/.test(indexSrc))
ok('index.ts pushes the notch geometry (menu-bar height) to the renderer (os:notch-geometry)',
  /'os:notch-geometry'[\s\S]*?menuBarH/.test(indexSrc))
ok('⌥Space toggles the notch — globalShortcut Alt+Space → os:notch-toggle to the renderer',
  /globalShortcut\.register\(\s*'Alt\+Space'[\s\S]*?'os:notch-toggle'/.test(indexSrc))
ok('the separate island.ts window is RETIRED — index.ts no longer wires it (no wireIsland/registerIsland/island bridge)',
  !/\bwireIsland\(/.test(indexSrc) && !/\bregisterIsland\(\)/.test(indexSrc) && !/from '\.\/island'/.test(indexSrc))

// ── preload: the notch bridge (replaces the island bridge) ─────────────────────────────────────────────────────
ok('preload exposes agentOS.notch: setInteractive → os:notch-interactive, send → os:notch-send',
  /notch:\s*\{/.test(preloadSrc) && /ipcRenderer\.send\(\s*'os:notch-interactive'/.test(preloadSrc) &&
    /ipcRenderer\.invoke\(\s*'os:notch-send'/.test(preloadSrc))
ok('preload notch bridge: onToggle ← os:notch-toggle, onGeometry ← os:notch-geometry',
  /ipcRenderer\.on\(\s*'os:notch-toggle'/.test(preloadSrc) && /ipcRenderer\.on\(\s*'os:notch-geometry'/.test(preloadSrc))
ok('the old island bridge is gone from preload (no os:island-* channels)',
  !/os:island-/.test(preloadSrc) && !/\bisland:\s*\{/.test(preloadSrc))

// ── App.tsx: the renderer clips the REAL canvas (#root-canvas) to the notch and grows it ───────────────────────
ok('App.tsx notchClipFor returns inset() reveals (butter, not path() curves) with three stops (open / panel / closed)',
  /function notchClipFor\(/.test(appSrc) &&
    /state === 'open'[\s\S]*?inset\(0px round/.test(appSrc) &&
    /state === 'panel'[\s\S]*?NOTCH_PANEL_W/.test(appSrc) && /inset\(0px \$\{sx\}px/.test(appSrc))
ok('#root-canvas is clipped to the notch (clipPath: notchClip); transition + GPU texture promotion in CSS (.notch-mode)',
  /clipPath: notchClip/.test(appSrc) && /const notchClip = notchOn[\s\S]*?notchClipFor\(/.test(appSrc) &&
    /#root-canvas\.notch-mode[\s\S]*?transition: clip-path/.test(cssSrc) && /#root-canvas\.notch-mode[\s\S]*?transform: translateZ\(0\)/.test(cssSrc))
// The "white corners" were real canvas WIDGETS peeking through the rounded-corner gaps (.world z-index 1 is ABOVE
// .bg z-index 0). Fix: AT REST the canvas does NOT exist — only the black notch DOM shows; the canvas appears only
// when OPEN (the grow reveals it). .bg is black + transform:none so the rounded clip rounds it cleanly.
ok('at rest the canvas is hidden (only black notch DOM); canvas shows only when .notch-open; .bg black + transform:none',
  /#root-canvas\.notch-mode \.bg[\s\S]*?background-color: #000[\s\S]*?transform: none/.test(cssSrc) &&
    /#root-canvas\.notch-mode:not\(\.notch-open\) > \*:not\(\.bg\):not\(\.notch-handle\):not\(\.notch-entry\)[\s\S]*?display: none/.test(cssSrc) &&
    /notchState === 'open' \? 'notch-open'/.test(appSrc) &&
    /setNotchOpening\(true\)[\s\S]*?applyNotchState\('open'\)/.test(appSrc))
// Butter grow WITHOUT faking it: #root-canvas is promoted to its own full-viewport GPU texture (translateZ(0)),
// so the content rasterizes ONCE and the clip reveals pre-painted pixels at the compositor — the REAL content
// shows the whole way out (no hiding of canvas children). Top bar black in notch mode (matches the island).
ok('grow is butter via a GPU texture (translateZ(0), content rasterized once, content NEVER hidden) + black top bar',
  /#root-canvas\.notch-mode[\s\S]*?transform: translateZ\(0\)/.test(cssSrc) &&
    /#root-canvas\.notch-mode \.titlebar[\s\S]*?background: transparent/.test(cssSrc) &&
    !/notch-growing/.test(cssSrc) && !/notchGrowing/.test(appSrc))
// Low-power lever: PAUSE widget MOTION (animation-play-state, NOT visibility) during the clip transition so the
// GPU texture stays static (no per-frame re-raster). Content is fully visible the whole time; motion resumes on
// transitionend. This is the "static texture = pure compositing" optimization, not hiding.
ok('low-power lever: widget motion is PAUSED (not hidden) during the clip transition (notch-anim → animation-play-state)',
  /#root-canvas\.notch-anim[\s\S]*?animation-play-state: paused/.test(cssSrc) &&
    /setNotchAnimating\(true\)/.test(appSrc) && /propertyName === 'clip-path'\) setNotchAnimating\(false\)/.test(appSrc))
ok('the notch handle + entry are rendered INSIDE #root-canvas (so the clip reveals the live canvas around them)',
  /className=\{`notch-handle/.test(appSrc) && /ref=\{notchHandleRef\}/.test(appSrc) &&
    /className=\{`notch-entry/.test(appSrc) && /className="notch-pq"/.test(appSrc))
ok('the renderer flips window click-through on notch-hover (mousemove → agentOS.notch.setInteractive)',
  /addEventListener\('mousemove', onMove, true\)/.test(appSrc) &&
    /window\.agentOS\?\.notch\?\.setInteractive\(on\)/.test(appSrc))
ok('the renderer follows main: onGeometry enables the notch, onToggle (⌥Space) TOGGLES the new-session widget (item 2)',
  /notch\?\.onGeometry\?\.\(/.test(appSrc) && /setNotchOn\(true\)/.test(appSrc) &&
    /notch\?\.onToggle\?\.\(\(\) => toggleNewSession\(\)\)/.test(appSrc))

// ── Item 2: ⌥Space is a pure TOGGLE of the new-session widget (closed ↔ panel); it NEVER enters fullscreen ───────
ok('item 2: toggleNewSession shows the panel from closed (pinned, focused) and hides from anything shown',
  /const toggleNewSession = \(\): void =>/.test(appSrc) &&
    /if \(notchStateRef\.current === 'closed'\)[\s\S]*?setNotchPinnedBoth\(true\)[\s\S]*?applyNotchState\('panel'\)[\s\S]*?focusNotchPrompt\(\)/.test(appSrc) &&
    /else \{[\s\S]*?applyNotchState\('closed'\)[\s\S]*?setNotchInteractive\(false\)/.test(appSrc))
ok('item 2: ⌥Space NEVER enters fullscreen — toggleNewSession does not call openNotch (entering is click/Send only)',
  /const toggleNewSession = \(\): void => \{(?:(?!openNotch)[\s\S])*?\n  \}/.test(appSrc))
ok('item 2: a keyboard-opened panel is PINNED — notchPinned state + notchPinnedRef, set true when ⌥Space pops the panel',
  /const \[notchPinned, setNotchPinned\] = useState\(false\)/.test(appSrc) &&
    /const notchPinnedRef = useRef\(false\)/.test(appSrc) &&
    /const setNotchPinnedBoth = \(on: boolean\): void =>[\s\S]*?notchPinnedRef\.current = on[\s\S]*?setNotchPinned\(on\)/.test(appSrc))
ok('item 2: pinned SUPPRESSES the hover auto-close — the mousemove handler early-returns interactive while pinned',
  /if \(st === 'panel' && notchPinnedRef\.current\) \{[\s\S]*?setNotchInteractive\(true\)[\s\S]*?return/.test(appSrc))
ok('item 2: pin is CLEARED on enter (openNotch), on hide/retract (closeNotch + toggle), and on Esc',
  /const openNotch = \(\): void => \{[\s\S]*?setNotchPinnedBoth\(false\)/.test(appSrc) &&
    /const closeNotch = \(\): void => \{[\s\S]*?setNotchPinnedBoth\(false\)/.test(appSrc) &&
    /e\.key === 'Escape'[\s\S]*?setNotchPinnedBoth\(false\)[\s\S]*?applyNotchState\('closed'\)/.test(appSrc))
ok('item 2: ⌥Space opens the prompt type-ready — focusNotchPrompt focuses the .notch-pq textarea after render',
  /const focusNotchPrompt = \(\): void =>[\s\S]*?querySelector<HTMLTextAreaElement>\('\.notch-pq'\)[\s\S]*?\.focus\(\)/.test(appSrc))
ok('item 2: OS key auto-repeat is swallowed — a <120ms re-fire of the toggle is ignored (deliberate re-tap is slower)',
  /performance\.now\(\)[\s\S]*?now - notchToggleAtRef\.current < 120\) return/.test(appSrc))
ok('Send spawns via the notch bridge (Deep toggle), then expands to the live canvas',
  /window\.agentOS\?\.notch\?\.send\(p, notchDeep\)/.test(appSrc) && /applyNotchState\('open'\)/.test(appSrc))

// ── styles.css: the notch handle + entry ──────────────────────────────────────────────────────────────────────
ok('styles.css styles the notch handle (black pill) + the black entry panel + the prompt',
  /\.notch-handle \{/.test(cssSrc) && /\.notch-entry \{/.test(cssSrc) && /\.notch-pq \{/.test(cssSrc))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
