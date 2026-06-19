// test-island-window.mjs — the NOTCH MERGE (plans/blitzos-dynamic-island.md). The separate island.ts window is
// RETIRED: the real BlitzOS UI window IS the notch. The sandwich runs in OVERLAY mode (one frameless transparent
// full-display window, NOT parented, pages hidden), and the renderer (App.tsx) clips #root-canvas to a NotchShape
// and GROWS the clip to fullscreen — so the LIVE canvas expands out of the notch (no second window, no plate, no
// handoff). This test reads the source off disk and asserts the load-bearing lines so a future edit that breaks
// the merge fails loudly. Run: node scripts/test-island-window.mjs
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const overlaySrc = readFileSync(join(repoRoot, 'src/main/notch-overlay.ts'), 'utf8')
const indexSrc = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
const preloadSrc = readFileSync(join(repoRoot, 'src/preload/index.ts'), 'utf8')
const appSrc = readFileSync(join(repoRoot, 'src/renderer/src/App.tsx'), 'utf8')
const cssSrc = readFileSync(join(repoRoot, 'src/renderer/src/styles.css'), 'utf8')
const notchCss = readFileSync(join(repoRoot, 'src/renderer/src/notch/notch.css'), 'utf8')
const islandCss = readFileSync(join(repoRoot, 'src/renderer/src/notch/island.css'), 'utf8')
const chatInputSrc = readFileSync(join(repoRoot, 'src/renderer/src/notch/ChatInput.tsx'), 'utf8')
const notchHostSrc = readFileSync(join(repoRoot, 'src/renderer/src/notch/NotchHost.tsx'), 'utf8')
const islandSrc = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandPanel.tsx'), 'utf8')
const attachSrc = readFileSync(join(repoRoot, 'src/renderer/src/notch/AttachPanel.tsx'), 'utf8')
const attachCss = readFileSync(join(repoRoot, 'src/renderer/src/notch/attach.css'), 'utf8')
const narratorSrc = readFileSync(join(repoRoot, 'src/main/agent-narrator.mjs'), 'utf8')

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

// ── notch-overlay.ts: the single window as a transparent full-display overlay + click-through toggle ────────────
// (Extracted from the retired sandwich compositor — web is in-DOM <webview> now, so the notch is ONE window.)
ok('notch-overlay window opts are frameless + transparent + cover the notch band (enableLargerThanScreen)',
  /export function notchOverlayWindowOptions\(\)/.test(overlaySrc) &&
    /frame: false[\s\S]*?transparent: true[\s\S]*?enableLargerThanScreen: true/.test(overlaySrc))
ok('applyNotchOverlay: showInactive (no focus steal) + screen-saver + all-Spaces + click-through (forward)',
  /export function applyNotchOverlay/.test(overlaySrc) && /win\.showInactive\(\)/.test(overlaySrc) &&
    /win\.setAlwaysOnTop\(true, 'screen-saver'\)/.test(overlaySrc) &&
    /win\.setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true \}\)/.test(overlaySrc) &&
    /win\.setIgnoreMouseEvents\(true, \{ forward: true \}\)/.test(overlaySrc))
ok('setNotchInteractive toggles the overlay click-through (setIgnoreMouseEvents(!on, forward))',
  /export function setNotchInteractive/.test(overlaySrc) &&
    /win\.setIgnoreMouseEvents\(!on, \{ forward: true \}\)/.test(overlaySrc))

// ── index.ts: notch-gated overlay + the notch IPC (interactive / send / geometry / ⌥Space) ─────────────────────
ok('index.ts is notch-gated and applies the overlay window opts + applyNotchOverlay when notch-gated',
  /const notchGated\s*=/.test(indexSrc) && /notchGated[\s\S]*?notchOverlayWindowOptions\(\)/.test(indexSrc) &&
    /applyNotchOverlay\(mainWindow\)/.test(indexSrc))
ok('os:notch-interactive → setNotchInteractive(mainWindow) (collapsed = click-through except the notch; expanded = full)',
  /ipcMain\.on\(\s*'os:notch-interactive'[\s\S]*?setNotchInteractive\(mainWindow/.test(indexSrc))
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
ok('App.tsx notchClipFor: open = fullscreen inset; closed/panel = the bare notch pill (panel UI is the NotchHost portal)',
  /function notchClipFor\(/.test(appSrc) &&
    /state === 'open'[\s\S]*?inset\(0px round/.test(appSrc) &&
    /inset\(0px \$\{sx\}px/.test(appSrc) && !/NOTCH_PANEL_W/.test(appSrc))
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
ok('the physical notch handle is PORTALED to document.body ABOVE the island chassis (z 2147483001) so it stays clickable',
  /createPortal\(/.test(appSrc) && /className=\{`notch-handle/.test(appSrc) && /ref=\{notchHandleRef\}/.test(appSrc) &&
    /\.notch-handle \{[\s\S]*?z-index: 2147483001/.test(cssSrc))
ok('the panel/process UI is the NotchHost rendered via a portal to document.body',
  /createPortal\(\s*<NotchHost[\s\S]*?menuBarH=\{notchMenuBarH\}[\s\S]*?document\.body\s*\)/.test(appSrc))
ok('attach/peek RESIZE holds the island open (NotchHost.onChassisResize → host grace timer; a shrink never self-hides)',
  /onChassisResize\?\.\(\)/.test(notchHostSrc) && /onChassisResize=\{/.test(appSrc) &&
    /notchHoldUntilRef\.current = performance\.now\(\) \+ 1000/.test(appSrc) &&
    /performance\.now\(\) < notchHoldUntilRef\.current/.test(appSrc))
ok('the renderer flips window click-through on notch-hover (mousemove → agentOS.notch.setInteractive)',
  /addEventListener\('mousemove', onMove, true\)/.test(appSrc) &&
    /window\.agentOS\?\.notch\?\.setInteractive\(on\)/.test(appSrc))
ok('the renderer follows main: onGeometry enables the notch, onToggle (⌥Space) TOGGLES the new-session widget (item 2)',
  /notch\?\.onGeometry\?\.\(/.test(appSrc) && /setNotchOn\(true\)/.test(appSrc) &&
    /notch\?\.onToggle\?\.\(\(\) => toggleNewSession\(\)\)/.test(appSrc))

// ── Item 2: ⌥Space is a pure TOGGLE of the new-session widget (closed ↔ panel); it NEVER enters fullscreen ───────
ok('item 2: toggleNewSession shows the panel from closed (pinned) and hides from anything shown',
  /const toggleNewSession = \(\): void =>/.test(appSrc) &&
    /if \(notchStateRef\.current === 'closed'\)[\s\S]*?setNotchPinnedBoth\(true\)[\s\S]*?applyNotchState\('panel'\)/.test(appSrc) &&
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
ok('item 2: the session composer is type-ready — ChatInput supports autoFocus and the session view passes it',
  /autoFocus\?: boolean/.test(chatInputSrc) && /if \(autoFocus\) ref\.current\?\.focus\(\)/.test(chatInputSrc))
ok('item 2: OS key auto-repeat is swallowed — a <120ms re-fire of the toggle is ignored (deliberate re-tap is slower)',
  /performance\.now\(\)[\s\S]*?now - notchToggleAtRef\.current < 120\) return/.test(appSrc))

// ── The LOCKED design: ONE island (the macOS/iOS Dynamic Island), the prototype switcher is RETIRED ─────────────
ok('styles.css notch handle (black pill) still present',
  /\.notch-handle \{/.test(cssSrc))
ok('the CHASSIS is INVARIANT: BLACK + the original NotchShape (square top, 28px rounded bottom), owned by .nh-chassis',
  /\.nh-chassis \{[\s\S]*?background: #000;[\s\S]*?border-radius: 0 0 28px 28px;/.test(notchCss) &&
    /nh-chassis/.test(notchHostSrc))
ok('NotchHost renders the single IslandPanel INSIDE the chassis; the swipe PAGER is removed (no onWheel)',
  /import IslandPanel from '\.\/IslandPanel'/.test(notchHostSrc) && /<IslandPanel\b/.test(notchHostSrc) &&
    !/onWheel/.test(notchHostSrc))
ok('tab nav = Ctrl+Tab / Ctrl+Shift+Tab (wrap) + click; the tab strip scrolls horizontally on swipe (overflow-x:auto)',
  /e\.ctrlKey && e\.key === 'Tab'/.test(notchHostSrc) && /e\.shiftKey \? total - 1 : 1/.test(notchHostSrc) &&
    /\.isl-tabs \{[\s\S]*?overflow-x: auto/.test(islandCss))
ok('IslandPanel is MINIMAL (user constraint): NO header/title/icons — one shared tab strip + a composer/feed body',
  /isl-tabs/.test(islandSrc) && /className="isl-bar"/.test(islandSrc) &&
    !/isl-icon/.test(islandSrc) && !/isl-title/.test(islandSrc) && !/isl-lead/.test(islandSrc))
ok('the new-session tab is JUST a tab: the FIRST chip (isl-chip-new) selects page 0; agents select page i+1; strip is shared',
  /isl-chip-new/.test(islandSrc) && /onSelectPage\(0\)/.test(islandSrc) &&
    /onSelectPage\(i \+ 1\)/.test(islandSrc) && /\.isl-chip-new \{[\s\S]*?border-radius: 50%/.test(islandCss))
ok('status is BINARY: running = a pulsing BLUE dot (isl-dot-pulse on working), everything else gray — no yellow/red',
  /isl-chip-dot\[data-status='working'\][\s\S]{0,90}animation: isl-dot-pulse/.test(islandCss) &&
    !/--isl-warn/.test(islandCss) && !/--isl-error/.test(islandCss) &&
    !/data-status='waiting'/.test(islandCss) && !/data-status='error'/.test(islandCss))

// ── Attach panel: standalone Deep gone; the attach toggle injects the panel INLINE above the bar; island grows ───
ok('the standalone Deep button is GONE; every composer has an attach toggle (isl-attach: + ↔ ×) at the left of the pill',
  !/isl-deep/.test(islandSrc) && /isl-attach/.test(islandSrc) && /onToggleAttach/.test(islandSrc) && /'×'/.test(islandSrc) &&
    /\.isl-attach \{[\s\S]*?border-radius: 50%/.test(islandCss))
ok('the attachment panel is INJECTED INLINE above the message bar (isl-attach-wrap → <AttachPanel/>), not a separate view',
  /import \{ AttachPanel \}/.test(islandSrc) && /<AttachPanel \/>/.test(islandSrc) && /isl-attach-wrap/.test(islandSrc) &&
    /\.isl-attach-wrap \{[\s\S]*?grid-template-rows: 0fr/.test(islandCss))
ok('the island EXPANDS when attachments open: NotchHost adds .nh-wide; notch.css widens + transitions the chassis',
  /attachOpen \? ' nh-wide'/.test(notchHostSrc) && /\.nh-chassis\.nh-wide \{[\s\S]*?width:/.test(notchCss) &&
    /\.nh-chassis \{[\s\S]*?transition: width/.test(notchCss))
ok('the new-session tab icon is a PEN (compose), not a "+" (avoids two identical + circles)',
  /isl-pen/.test(islandSrc) && /<svg className="isl-pen"/.test(islandSrc) && !/isl-plus/.test(islandSrc))
ok('attach panel = a skills strip (Deep is one) + TWO rounded DASHED boxes (left drop, right open-apps), NO Done button',
  /att-skills/.test(attachSrc) && /MOCK_SKILLS/.test(attachSrc) && /att-drop/.test(attachSrc) && /att-apps/.test(attachSrc) &&
    /border: 1\.5px dashed/.test(attachCss) && !/Done/.test(attachSrc))
ok('right box: click an app row selects ALL its tabs; the ▸/▾ twisty expands to per-tab tri-state selection',
  /att-twisty/.test(attachSrc) && /toggleApp/.test(attachSrc) && /selectedTabs/.test(attachSrc) && /att-check/.test(attachSrc))

// ── Piece 1: the island is wired to REAL agent data (sessions/status/transcripts + steer/spawn), no mock ────────
ok('agents snapshot channel exists end to end: preload agents() → os:agents-snapshot → osAgentsSnapshot (main)',
  /agents\(\): Promise/.test(preloadSrc) && /os:agents-snapshot/.test(preloadSrc) &&
    /ipcMain\.handle\('os:agents-snapshot'/.test(indexSrc) && /osAgentsSnapshot/.test(indexSrc))
ok('NotchHost subscribes to the live chat broadcast (onAction, type chat) + pulls the snapshot (agents()); no mock sessions',
  /onAction/.test(notchHostSrc) && /'chat'/.test(notchHostSrc) && /agents\?\.\(\)/.test(notchHostSrc) &&
    !/MOCK_SESSIONS/.test(notchHostSrc) && !/MOCK_MESSAGES/.test(notchHostSrc))
ok('steer + spawn are real: the pen tab spawns (notch.send), an agent tab steers (sendMessage(text, id))',
  /notch\?\.send/.test(notchHostSrc) && /sendMessage\?\.\(text/.test(notchHostSrc))
ok('IslandPanel renders the real transcript (isl-msg bubbles, messages.map) + a live status line (isl-status); no mock import',
  /isl-msg/.test(islandSrc) && /isl-status/.test(islandSrc) && /messages\.map/.test(islandSrc) && !/MOCK_/.test(islandSrc))

// ── Pieces 2 + 3: the canonical transcript reader (details) + the Haiku narrator (milestone timeline) ──────────
ok('the modules exist: the canonical transcript reader + the Haiku narrator',
  existsSync(join(repoRoot, 'src/main/agent-transcript.mjs')) && existsSync(join(repoRoot, 'src/main/agent-narrator.mjs')))
ok('the narrator is started at boot (startNarrator) + feeds the island (setMilestonesProvider)',
  /import \{ startNarrator \}/.test(indexSrc) && /startNarrator\(\{/.test(indexSrc) && /setMilestonesProvider\(/.test(indexSrc))
ok('the narrator summarizes via Haiku with a strict JSON schema (char-capped milestone, skip flag), model haiku',
  /claude/.test(narratorSrc) && /--json-schema/.test(narratorSrc) && /--model', 'haiku'/.test(narratorSrc) &&
    /milestone/.test(narratorSrc) && /skip/.test(narratorSrc))
ok('the details channel exists end to end: preload agentDetails() → os:agent-details → osAgentDetails (raw tool rows)',
  /agentDetails\(id: string\): Promise/.test(preloadSrc) && /os:agent-details/.test(preloadSrc) &&
    /ipcMain\.handle\('os:agent-details'/.test(indexSrc) && /osAgentDetails/.test(indexSrc))
ok('NotchHost merges the live milestone broadcast (type milestone) into a per-session timeline',
  /'milestone'/.test(notchHostSrc) && /setMilestones/.test(notchHostSrc))
ok('the CHAT is PURE messages (bubbles only, NO milestone steps) + a Details expand; summaries live in the peek view',
  /isl-msg/.test(islandSrc) && /messages\.map/.test(islandSrc) && !/isl-step/.test(islandSrc) && !/\.isl-step \{/.test(islandCss) &&
    /isl-details/.test(islandSrc) && /agentDetails/.test(islandSrc) && /isl-peek-ly/.test(islandSrc))

// ── The PEEK view: keep the tab bar; the area BELOW becomes the active agent's "now playing" ───────────────────
ok('the PEEK toggle lives in the NOTCH BAND (NotchHost .nh-peek-toggle, absolute top-right), always visible',
  /nh-peek-toggle/.test(notchHostSrc) && /const \[peek, setPeek\]/.test(notchHostSrc) &&
    /\.nh-peek-toggle \{[\s\S]*?position: absolute/.test(notchCss))
ok('PEEK keeps the tab bar (shared tabStrip in both views); the area below = the active agent now-playing (album + big title + lyrics)',
  /if \(peek\)/.test(islandSrc) && /const tabStrip =/.test(islandSrc) && /\{tabStrip\}/.test(islandSrc) &&
    /isl-peek-album/.test(islandSrc) && /isl-peek-title/.test(islandSrc) && /isl-peek-lyrics/.test(islandSrc) &&
    /agentGradient\(activeId\)/.test(islandSrc))
ok('peek styles match the mockup (big album 92px / radius 24, big title 27px, lyrics + equalizer)',
  /\.isl-peek-album \{[\s\S]*?border-radius: 24px/.test(islandCss) && /\.isl-peek-title \{[\s\S]*?font-size: 27px/.test(islandCss) &&
    /\.isl-peek-lyrics \{/.test(islandCss) && /@keyframes isl-peek-bars/.test(islandCss))
ok('agent tabs are ALBUM PILLS: each = a mini gradient album + name + status dot',
  /isl-chip-agent/.test(islandSrc) && /isl-chip-album/.test(islandSrc) && /agentGradient\(s\.id\)/.test(islandSrc) &&
    /\.isl-chip-album \{/.test(islandCss))
ok('the narrator emits SHORT now-playing titles (schema maxLength 38 + terse "AT MOST 36 characters" prompt + 40-char cap)',
  /maxLength: 38/.test(narratorSrc) && /AT MOST 36 characters/.test(narratorSrc) && /slice\(0, 40\)/.test(narratorSrc))
ok('island.css paints ONLY the interior — the .nh-island root sets NO chassis bg/shape (the chassis is the only black/shape)',
  /\.nh-island \{/.test(islandCss) &&
    (() => {
      const m = islandCss.match(/\.nh-island \{[^}]*\}/)
      return !!m && !/background:\s*#/.test(m[0]) && !/border-radius/.test(m[0])
    })())
ok('the prototype switcher is RETIRED from App.tsx: no NOTCH_PROTOS / setNotchProtoBoth / ⌥←→ proto cycling',
  !/NOTCH_PROTOS/.test(appSrc) && !/setNotchProtoBoth/.test(appSrc) &&
    !/ArrowRight' \|\| e\.key === 'ArrowLeft'/.test(appSrc))
ok('the retired prototype files are gone (protos/ dir + notch/index.ts registry deleted)',
  !existsSync(join(repoRoot, 'src/renderer/src/notch/protos')) &&
    !existsSync(join(repoRoot, 'src/renderer/src/notch/index.ts')))
ok('ChatInput is a properly built composer: autogrow (reset to auto), max-height scroll, Enter sends, IME guard, uncontrolled',
  /el\.style\.height = 'auto'/.test(chatInputSrc) && /Math\.min\(el\.scrollHeight, maxHeight\)/.test(chatInputSrc) &&
    /e\.key === 'Enter' && !e\.shiftKey/.test(chatInputSrc) && /isComposing \|\| e\.keyCode === 229/.test(chatInputSrc) &&
    /defaultValue=""/.test(chatInputSrc))
ok('the shared shell lives in notch.css (.nhost fixed, .nh-chassis pointer-events auto, .ci composer baseline)',
  /\.nhost \{[\s\S]*?position: fixed/.test(notchCss) && /\.nh-chassis \{[\s\S]*?pointer-events: auto/.test(notchCss) &&
    /\.ci \{[\s\S]*?display: flex/.test(notchCss))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
