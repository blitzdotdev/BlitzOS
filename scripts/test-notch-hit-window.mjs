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
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const app = readFileSync(join(repoRoot, 'src/renderer/src/App.tsx'), 'utf8')
const notchHost = readFileSync(join(repoRoot, 'src/renderer/src/notch/NotchHost.tsx'), 'utf8')
const islandHome = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandHome.tsx'), 'utf8')
const islandPanel = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandPanel.tsx'), 'utf8')
const attachPanel = readFileSync(join(repoRoot, 'src/renderer/src/notch/AttachPanel.tsx'), 'utf8')
const agentVisuals = readFileSync(join(repoRoot, 'src/renderer/src/notch/agentVisuals.ts'), 'utf8')
const markdownMessage = readFileSync(join(repoRoot, 'src/renderer/src/notch/MarkdownMessage.tsx'), 'utf8')
const messageParts = readFileSync(join(repoRoot, 'src/renderer/src/notch/messageParts.ts'), 'utf8')
const markdownSafety = readFileSync(join(repoRoot, 'src/renderer/src/notch/markdownSafety.ts'), 'utf8')
const islandSettings = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandSettings.tsx'), 'utf8')
const islandTerminal = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandTerminalPane.tsx'), 'utf8')
const notchTypes = readFileSync(join(repoRoot, 'src/renderer/src/notch/types.ts'), 'utf8')
const islandCss = readFileSync(join(repoRoot, 'src/renderer/src/notch/island.css'), 'utf8')
const attachCss = readFileSync(join(repoRoot, 'src/renderer/src/notch/attach.css'), 'utf8')
const notchCss = readFileSync(join(repoRoot, 'src/renderer/src/notch/notch.css'), 'utf8')
const css = readFileSync(join(repoRoot, 'src/renderer/src/styles.css'), 'utf8')
const workspaceHost = readFileSync(join(repoRoot, 'src/main/workspace-host.mjs'), 'utf8')
const osActions = readFileSync(join(repoRoot, 'src/main/osActions.ts'), 'utf8')
const terminalManager = readFileSync(join(repoRoot, 'src/main/terminal-manager.mjs'), 'utf8')
const homeEmptyBlock = islandCss.match(/\.isl-home-empty \{[\s\S]*?\n\}/)?.[0] || ''

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
    /menuBarH = 0/.test(overlay) && /Math\.min\(safeTop, visibleBand\)/.test(overlay) &&
    /export function notchHitWindowOptions/.test(overlay) && /export const NOTCH_HIT_HTML/.test(overlay))
ok('the hit-window is INTERACTIVE (transparent, acceptFirstMouse, the main preload) — not the click-through overlay',
  /notchHitWindowOptions/.test(overlay) && /transparent: true/.test(overlay) && /acceptFirstMouse: true/.test(overlay) &&
    /preload: preloadPath/.test(overlay))
ok('main creates the hit-window STRICTLY ABOVE the overlay (screen-saver relativeLevel 1) + only when a real notch exists',
  /new BrowserWindow\(notchHitWindowOptions/.test(index) && /setAlwaysOnTop\(true, 'screen-saver', 1\)/.test(index) &&
    /const rect = notchHitRect\(notchGeom, menuBarH\)/.test(index) && /if \(!rect\)/.test(index))
ok('open island makes the notch hit-window click-through so it cannot steal tab hover or blank-strip clicks',
  /let notchOverlayInteractive = false/.test(index) && /notchOverlayInteractive = !!on/.test(index) &&
    /notchHitWin\.setIgnoreMouseEvents\(notchOverlayInteractive, \{ forward: true \}\)/.test(index))
ok('main forwards the hit-window click/hover to the overlay renderer + pushes the REAL notch width + hasNotch',
  /ipcMain\.on\('os:notch-click'[\s\S]*?'os:notch-handle-click'/.test(index) &&
    /ipcMain\.on\('os:notch-hover'[\s\S]*?'os:notch-handle-hover'/.test(index) &&
    /notchWidth: notchGeom\?\.hasNotch/.test(index) && /hasNotch: !!notchGeom\?\.hasNotch/.test(index))

// ── preload + renderer wiring ────────────────────────────────────────────────────────────────────────────────
ok('preload exposes the bridge: notch.click/hover (hit-window → main) + onHandleClick/onHandleHover (→ overlay)',
  /click\(\): void \{[\s\S]*?'os:notch-click'/.test(preload) && /hover\(on: boolean\): void \{[\s\S]*?'os:notch-hover'/.test(preload) &&
    /onHandleClick/.test(preload) && /onHandleHover/.test(preload))
ok('renderer: hit-window CLICK opens the island panel when closed, HOVER → open/close the panel',
  /onHandleClick\?\.\(\(\) => \{[\s\S]*?notchStateRef\.current === 'closed'[\s\S]*?toggleIsland\(\)/.test(app) &&
    /onHandleHover\?\.\(\(on\) =>/.test(app))
ok('renderer: hover-opened island has close hysteresis and the chassis keeps the overlay interactive for clicks',
  /NOTCH_HOVER_OPEN_GRACE_MS/.test(app) && /scheduleNotchHoverClose/.test(app) && /onChassisHoverChange=\{setChassisHover\}/.test(app) &&
    /onChassisResize=\{\(\) => \{[\s\S]*?notchHoldUntilRef\.current = performance\.now\(\) \+ NOTCH_HOVER_OPEN_GRACE_MS[\s\S]*?setNotchInteractive\(true\)/.test(app) &&
    /panelHitSlop/.test(app) && /document\.elementFromPoint/.test(app) && /closest\?\.\('\.nh-chassis'\)/.test(app) &&
    /onPointerEnter=\{holdChassisHover\}/.test(notchHost) &&
    /onPointerMove=\{holdChassisHover\}/.test(notchHost) &&
    /onPointerDownCapture=\{holdChassisHover\}/.test(notchHost) &&
    /onPointerLeave=\{\(\) => onChassisHoverChange\?\.\(false\)\}/.test(notchHost))
ok('attach window picker prompts once when Accessibility is missing and degrades granted failures to a neutral list hint',
  /let pickSeq = 0/.test(index) &&
    /let pickStopSeq = 0/.test(index) &&
    /let pickRelaunching: Promise<void> \| null = null/.test(index) &&
    /let pickPermissionFlow: Promise<boolean> \| null = null/.test(index) &&
    /waitForPickerAccessibilityGrant/.test(index) &&
    /const seq = \+\+pickSeq/.test(index) &&
    /const stopSeq = pickStopSeq/.test(index) &&
    /!grantedBeforeRetry/.test(index) &&
    /if \(!pickPermissionFlow\)/.test(index) &&
    /helper\.request\('accessibility'\)/.test(index) &&
    /Date\.now\(\) \+ 60_000/.test(index) &&
    /helper\.grantedFor\('accessibility', tccBeforeRetry\)/.test(index) &&
    /helper[\s\S]*?\.relaunchForGrant\(\)/.test(index) &&
    /if \(seq !== pickSeq \|\| stopSeq !== pickStopSeq\) return \{ ok: false, error: 'picker cancelled' \}/.test(index) &&
    /ipcMain\.handle\('os:pick-stop'[\s\S]*?pickSeq\+\+[\s\S]*?pickStopSeq\+\+/.test(index) &&
    /kind: 'picker_unavailable'/.test(index) &&
    /I opened the Accessibility prompt/.test(index) &&
    /Use the list on the right/.test(index) &&
    /const \[pickerNotice, setPickerNotice\] = useState<string \| null>\(null\)/.test(attachPanel) &&
    /m\.kind === 'picker_unavailable'/.test(attachPanel) &&
    /pickerNotice \? 'info'/.test(attachPanel) &&
    /\.nh-island \.att-drop\.unavailable/.test(attachCss) &&
    /\.nh-island \.att-drop-hint\[data-notice='info'\]/.test(attachCss))
ok('session tab strip has a real blank-space hit area and clear hover affordance',
  /min-height: 40px/.test(islandCss) && /width: 100%/.test(islandCss) &&
    /e\.target === e\.currentTarget/.test(islandPanel) && /e\.stopPropagation\(\)/.test(islandPanel) &&
    /\.nh-island \.isl-chip:hover \{[\s\S]*?background: rgba\(255, 255, 255, 0\.1\)/.test(islandCss) &&
    /\.nh-island \.isl-chip:hover \{[\s\S]*?border-color: rgba\(255, 255, 255, 0\.24\)/.test(islandCss))
ok('agent tab labels have enough line box for descenders like g/y',
  /\.nh-island \.isl-chip \{[\s\S]*?line-height: 18px/.test(islandCss) &&
    /\.nh-island \.isl-chip-label \{[\s\S]*?min-height: 18px[\s\S]*?line-height: 18px/.test(islandCss))
ok('island feed hides horizontal overflow and keeps chat bubbles inset from the panel edge',
  /\.nh-island \.isl-feed \{[\s\S]*?box-sizing: border-box[\s\S]*?overflow-x: hidden[\s\S]*?overflow-y: auto[\s\S]*?padding: 8px 16px 12px/.test(islandCss))
ok('opening Chat from Home resets to the new-session composer instead of the last agent tab',
  /const openChat = \(\): void => \{[\s\S]*?setPage\(0\)[\s\S]*?setPeek\(false\)[\s\S]*?setAttachOpen\(false\)[\s\S]*?setView\('session'\)/.test(notchHost) &&
    /onOpenChat=\{openChat\}/.test(notchHost))
ok('agent gradient visuals are shared between the session tabs and home working rail',
  /export function agentGradient\(id: string\): string/.test(agentVisuals) &&
    /import \{ agentGradient \} from '.\/agentVisuals'/.test(islandPanel) &&
    /import \{ agentGradient \} from '.\/agentVisuals'/.test(islandHome))
ok('home renders a compact working-agent rail that matches the tab active-work status rule',
  /onOpenAgent: \(id: string\) => void/.test(islandHome) &&
    /const isActiveStatus = \(value: string\): boolean => value === 'working' \|\| value === 'starting'/.test(islandHome) &&
    /const isWorkingStatus = \(value: string\): boolean => value === 'working'/.test(islandHome) &&
    /doneAgentIds: string\[\]/.test(islandHome) &&
    /const railSessions = sessions\.filter\(\(s\) => isWorkingStatus\(status\[s\.id\] \|\| s\.status\) \|\| doneAgents\.has\(s\.id\)\)/.test(islandHome) &&
    /const rawStatus = status\[s\.id\] \|\| s\.status/.test(islandHome) &&
    /className="isl-home-layout"/.test(islandHome) &&
    /className="isl-home-chat-zone"/.test(islandHome) &&
    /railSessions\.length > 0 \? \([\s\S]*?className="isl-home-agents-title">Active agents[\s\S]*?\) : \([\s\S]*?className="isl-home-empty">No active agents/.test(islandHome) &&
    /className="isl-home-empty">No active agents/.test(islandHome) &&
    /className="isl-home-working"/.test(islandHome) &&
    /className="isl-working-agent"/.test(islandHome) &&
    /data-home-state=\{homeState\}/.test(islandHome) &&
    !/isl-app-empty/.test(islandHome) &&
    /agentGradient\(s\.id\)/.test(islandHome) &&
    /isl-working-agent-dot/.test(islandHome) &&
    /homeState === 'done' \? 'Done' : 'Working'/.test(islandHome) &&
    /onClick=\{\(\) => onOpenAgent\(s\.id\)\}/.test(islandHome) &&
    /\.nh-island\.isl-home\.has-working/.test(islandCss) &&
    /\.isl-home-layout \{[\s\S]*?grid-template-columns: minmax\(0, 220px\) minmax\(0, 220px\)/.test(islandCss) &&
    /\.isl-home-working \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)[\s\S]*?max-height: 146px[\s\S]*?overflow-y: auto/.test(islandCss) &&
    homeEmptyBlock.includes('padding: 12px 2px 0') &&
    !/background:|border:|border-radius:|min-height:|place-items:/.test(homeEmptyBlock) &&
    /\.isl-working-agent-main \{[\s\S]*?gap: 2px/.test(islandCss) &&
    /\.isl-working-agent-dot \{[\s\S]*?border-top-color: var\(--isl-accent\)[\s\S]*?animation: isl-spin/.test(islandCss))
ok('settings can enable a fake 10-agent Home grid design preview',
  /DEBUG_FAKE_HOME_AGENTS_KEY = 'blitzos\.debug\.showFakeHomeAgents'/.test(notchHost) &&
    /const FAKE_HOME_AGENTS: IslandSession\[\] = \[/.test(notchHost) &&
    (notchHost.match(/id: 'fake-home-/g) || []).length === 10 &&
    /const FAKE_HOME_DONE_IDS = FAKE_HOME_AGENTS\.filter/.test(notchHost) &&
    /function readDebugFakeHomeAgents\(\): boolean/.test(notchHost) &&
    /const \[debugFakeHomeAgents, setDebugFakeHomeAgents\] = useState\(readDebugFakeHomeAgents\)/.test(notchHost) &&
    /const chooseDebugFakeHomeAgents = \(on: boolean\): void =>/.test(notchHost) &&
    /const homeSessions = debugFakeHomeAgents \? FAKE_HOME_AGENTS : sessions/.test(notchHost) &&
    /const homeStatus = debugFakeHomeAgents \? FAKE_HOME_STATUS : status/.test(notchHost) &&
    /const homeDoneAgentIds = debugFakeHomeAgents \? FAKE_HOME_DONE_IDS : Object\.keys\(homeDoneAgents\)/.test(notchHost) &&
    /sessions=\{homeSessions\}/.test(notchHost) &&
    /status=\{homeStatus\}/.test(notchHost) &&
    /doneAgentIds=\{homeDoneAgentIds\}/.test(notchHost) &&
    /showFakeHomeAgents=\{debugFakeHomeAgents\}/.test(notchHost) &&
    /onToggleFakeHomeAgents=\{chooseDebugFakeHomeAgents\}/.test(notchHost) &&
    /showFakeHomeAgents: boolean/.test(islandSettings) &&
    /Show fake Home agents/.test(islandSettings) &&
    /Design preview/.test(islandSettings))
ok('home keeps a reviewable Done pseudo-status when an agent finishes while Home is open',
  /const isHomeActiveStatus = \(value\?: string\): boolean => value === 'working' \|\| value === 'starting'/.test(notchHost) &&
    /const isHomeWorkingStatus = \(value\?: string\): boolean => value === 'working'/.test(notchHost) &&
    /const isHomeDoneReviewStatus = \(value\?: string\): boolean => !!value && !isHomeActiveStatus\(value\) && value !== 'error'/.test(notchHost) &&
    /HOME_DONE_AGENTS_KEY = 'blitzos\.home\.doneAgents'/.test(notchHost) &&
    /HOME_SEEN_WORKING_AGENTS_KEY = 'blitzos\.home\.seenWorkingAgents'/.test(notchHost) &&
    /function readHomeDoneAgents\(\): Record<string, true>/.test(notchHost) &&
    /window\.sessionStorage\.getItem\(HOME_DONE_AGENTS_KEY\)/.test(notchHost) &&
    /function readHomeSeenWorkingAgents\(\): Record<string, true>/.test(notchHost) &&
    /window\.sessionStorage\.getItem\(HOME_SEEN_WORKING_AGENTS_KEY\)/.test(notchHost) &&
    /function writeHomeDoneAgents\(value: Record<string, true>\): void/.test(notchHost) &&
    /window\.sessionStorage\.setItem\(HOME_DONE_AGENTS_KEY, JSON\.stringify\(ids\)\)/.test(notchHost) &&
    /function writeHomeSeenWorkingAgents\(value: Record<string, true>\): void/.test(notchHost) &&
    /window\.sessionStorage\.setItem\(HOME_SEEN_WORKING_AGENTS_KEY, JSON\.stringify\(ids\)\)/.test(notchHost) &&
    /const \[homeDoneAgents, setHomeDoneAgentsState\] = useState<Record<string, true>>\(\(\) => readHomeDoneAgents\(\)\)/.test(notchHost) &&
    /const \[homeSeenWorkingAgents, setHomeSeenWorkingAgentsState\] = useState<Record<string, true>>\(\(\) => readHomeSeenWorkingAgents\(\)\)/.test(notchHost) &&
    /const homeDoneAgentsRef = useRef\(homeDoneAgents\)/.test(notchHost) &&
    /const homeSeenWorkingAgentsRef = useRef\(homeSeenWorkingAgents\)/.test(notchHost) &&
    /writeHomeDoneAgents\(next\)/.test(notchHost) &&
    /writeHomeSeenWorkingAgents\(next\)/.test(notchHost) &&
    /const reconcileHomeAgentReviewState = \(nextSessions = sessionsRef\.current, nextStatus = statusRef\.current\): void =>/.test(notchHost) &&
    /viewRef\.current === 'home' && isHomeWorkingStatus\(rawStatus\)/.test(notchHost) &&
    /isHomeDoneReviewStatus\(rawStatus\)[\s\S]*?doneAdd\.push\(id\)/.test(notchHost) &&
    /reconcileHomeAgentReviewState\(arr, statusRef\.current\)/.test(notchHost) &&
    /reconcileHomeAgentReviewState\(sessionsRef\.current, nextStatus\)/.test(notchHost) &&
    /viewRef\.current === 'home' && isHomeWorkingStatus\(prevStatus\[id\]\) && isHomeDoneReviewStatus\(next\)/.test(notchHost) &&
    /clearHomeReviewAgents\(\)/.test(notchHost) &&
    /clearHomeReviewAgents\(id\)/.test(notchHost) &&
    /doneAgentIds=\{homeDoneAgentIds\}/.test(notchHost) &&
    /homeState === 'done' \? 'Done' : 'Working'/.test(islandHome) &&
    /isl-working-agent-check/.test(islandHome) &&
    /\.isl-working-agent\[data-home-state='done'\]/.test(islandCss) &&
    /\.isl-working-agent-check/.test(islandCss))
ok('home working-agent rail jumps directly to the selected agent chat',
  /const openAgentChat = \(id: string\): void => \{[\s\S]*?const idx = sessions\.findIndex\(\(s\) => s\.id === id\)[\s\S]*?setPage\(idx \+ 1\)[\s\S]*?setPeek\(false\)[\s\S]*?setAttachOpen\(false\)[\s\S]*?setView\('session'\)/.test(notchHost) &&
    /onOpenAgent=\{openAgentChat\}/.test(notchHost))
ok('notch agent status text keeps the backend starting state visible as Warming up',
  /const dotStatus = \(s: string\): string => \(s === 'starting' \? 'warming' : s === 'working' \? 'working' : 'idle'\)/.test(islandPanel) &&
  /case 'working':[\s\S]*?return 'Working'[\s\S]*?case 'starting':[\s\S]*?return 'Warming up'/.test(islandPanel) &&
    /statusLabel\(status\)/.test(islandPanel) &&
    /\.isl-chip-dot\[data-status='warming'\] \{[\s\S]*?animation: isl-dot-pulse/.test(islandCss) &&
    /\.isl-chip-dot\[data-status='working'\] \{[\s\S]*?animation: isl-spin/.test(islandCss) &&
    /\.isl-status\[data-status='working'\] \.isl-status-dot \{[\s\S]*?animation: isl-spin/.test(islandCss) &&
    /@keyframes isl-spin/.test(islandCss))
ok('renderer: the visual pill uses the REAL notch width + is gated on a real notch (no notch → no band, ⌥Space only)',
  /style=\{\{ width: notchWidth/.test(app) && /notchOn && hasNotch &&/.test(app) &&
    /notchClipFor\(notchState[\s\S]*?notchWidth\)/.test(app))
ok('the pill is VISUAL ONLY — clicks belong to the hit-window (.notch-handle is pointer-events:none)',
  /\.notch-handle \{[\s\S]*?pointer-events: none/.test(css))

// ── notch-owned debug terminal setting ───────────────────────────────────────────────────────────────────────
ok('notch home exposes Settings as top-right shell chrome, not as a widget tile',
  /nh-settings-btn/.test(notchHost) && /setView\('settings'\)/.test(notchHost) && /nh-settings-dot/.test(notchHost) &&
    /right: 16px/.test(notchCss) && !/isl-app-settings/.test(islandHome) && !/isl-app-debug-badge/.test(islandHome))
ok('notch settings persists the active-agent terminal debug toggle in localStorage and labels it DEBUG',
  /DEBUG_ACTIVE_TERMINAL_KEY = 'blitzos\.debug\.showActiveAgentTerminal'/.test(notchHost) &&
    /localStorage\.setItem\(DEBUG_ACTIVE_TERMINAL_KEY/.test(notchHost) &&
    /Show active agent terminal/.test(islandSettings) && /isl-debug-flag/.test(islandSettings) && /#ffd84d/.test(islandCss))
ok('active agent terminal pane is gated by the debug setting and uses activeId as the terminal id',
  /debugTerminalEnabled && activeId/.test(islandPanel) && /terminalId=\{activeId\}/.test(islandPanel) &&
    /activeTerminal=\{activeId \? terminals\[activeId\] : undefined\}/.test(notchHost))
ok('island terminal pane is a read-only scrollback log backed by terminalRead + subscribeTerminal, not terminal input/resize',
  /terminalRead\?\.\(terminalId\)/.test(islandTerminal) && /subscribeTerminal\(/.test(islandTerminal) &&
    /toVisibleTerminalText/.test(islandTerminal) && /MAX_LOG_CHARS/.test(islandTerminal) &&
    !/terminalInput/.test(islandTerminal) && !/terminalResize/.test(islandTerminal))
ok('island terminal pane uses a real scrollable DOM log inside the island',
  /className="isl-terminal-log"/.test(islandTerminal) && /onWheel=\{\(e\) => e\.stopPropagation\(\)\}/.test(islandTerminal) &&
    /\.isl-terminal-log \{[\s\S]*?overflow-y: auto/.test(islandCss) && /overscroll-behavior: contain/.test(islandCss))
ok('App no longer exposes the old agent-terminal surface toggle or opens agent terminals with openTerminal',
  !/showAgentTerminals/.test(app) && !/Agent terminal visibility/.test(app) && /term\.kind !== 'agent'/.test(app) &&
    /Managed agent terminals stay hidden here/.test(app))

// ── notch-owned agent archive flow ───────────────────────────────────────────────────────────────────────────
const archiveBlock = workspaceHost.match(/function setAgentArchived[\s\S]*?function archiveAgent/)?.[0] || ''
ok('preload + main expose archive/unarchive IPC for non-primary agents',
  /archiveAgent\(agentId: string\)[\s\S]*?'os:archive-agent'/.test(preload) &&
    /unarchiveAgent\(agentId: string\)[\s\S]*?'os:unarchive-agent'/.test(preload) &&
    /ipcMain\.handle\('os:archive-agent'/.test(index) && /ipcMain\.handle\('os:unarchive-agent'/.test(index) &&
    /op === 'archive'/.test(index) && /op === 'unarchive'/.test(index) &&
    /osArchiveAgent/.test(osActions) && /osUnarchiveAgent/.test(osActions))
ok('workspace host separates active vs archived agents and keeps archived ids out of new-agent allocation collisions',
  /function listedAgentIds/.test(workspaceHost) && /function agentIds\(\) \{ return listedAgentIds\(\) \}/.test(workspaceHost) &&
    /function archivedAgentIds\(\) \{ return listedAgentIds\(\{ archivedOnly: true \}\) \}/.test(workspaceHost) &&
    /archivedSessions/.test(workspaceHost) && /for \(const id of allAgentIds\(\)\)/.test(workspaceHost))
ok('archive metadata is durable and archive parks the agent without deleting its backend record',
  /next\.archived = true/.test(workspaceHost) && /next\.archivedAt = Date\.now\(\)/.test(workspaceHost) &&
    /delete next\.archived/.test(workspaceHost) && /delete next\.archivedAt/.test(workspaceHost) &&
    /pauseAgent/.test(workspaceHost) && /restartAgent/.test(workspaceHost) &&
    /readTerminalMeta/.test(workspaceHost) && /writeTerminalMeta/.test(workspaceHost) &&
    /disk\?\.archived/.test(terminalManager) && /delete meta\.archived/.test(terminalManager) &&
    !/removeAgentFiles/.test(archiveBlock))
ok('active chat view offers archive only for non-primary agents while reserving the slot for Main',
  /onArchiveAgent/.test(islandPanel) &&
    /className=\{`isl-archive\$\{activeId === '0' \? ' placeholder' : ''\}`\}/.test(islandPanel) &&
    /disabled=\{activeId === '0'\}/.test(islandPanel) &&
    /if \(activeId !== '0'\) onArchiveAgent\(activeId\)/.test(islandPanel) &&
    /\.nh-island \.isl-archive\.placeholder \{[\s\S]*?visibility: hidden[\s\S]*?pointer-events: none/.test(islandCss))
ok('active chat view shows status and archive in a padded meta row below the tabs',
  /className="isl-agent-meta"[\s\S]*?className="isl-status"[\s\S]*?className=\{`isl-archive/.test(islandPanel) &&
    /\.nh-island \.isl-agent-meta \{[\s\S]*?justify-content: space-between[\s\S]*?padding: 8px 2px 4px/.test(islandCss) &&
    /\.nh-island \.isl-actions \{[\s\S]*?justify-content: flex-start/.test(islandCss))
ok('agent tabs can be renamed inline from right-click with a 24-character cap',
  /renameAgent\(agentId: string, newTitle: string\)[\s\S]*?'os:rename-agent'/.test(preload) &&
    /ipcMain\.handle\('os:rename-agent'/.test(index) &&
    /AGENT_NAME_MAX = 24/.test(islandPanel) &&
    /onContextMenu=\{\(e\) => \{[\s\S]*?startRename\(s\.id, s\.title\)/.test(islandPanel) &&
    /if \(s\.id === '0'\) return/.test(islandPanel) &&
    /className="isl-chip-input"/.test(islandPanel) &&
    /maxLength=\{AGENT_NAME_MAX\}/.test(islandPanel) &&
    /onSubmit=\{\(e\) => \{[\s\S]*?commitRename\(s\.id\)/.test(islandPanel) &&
    /e\.key === 'Escape'/.test(islandPanel) &&
    /onRenameAgent=\{renameAgent\}/.test(notchHost) &&
    /function agentTitleText/.test(workspaceHost) &&
    /if \(id === '0'\) return \{ ok: false, error: 'main agent cannot be renamed' \}/.test(workspaceHost) &&
    /title: id === '0' \? 'Main' : agentTitleText\(meta\.title \|\| `Chat \$\{id\}`\)/.test(workspaceHost) &&
    /\.slice\(0, 24\)/.test(workspaceHost) &&
    /isl-chip-editing/.test(islandCss) &&
    /isl-chip-input/.test(islandCss))
ok('archive returns the island to the tab strip without the custom archive animation path',
  /moveSessionToArchive/.test(notchHost) && /setPage\(0\)/.test(notchHost) &&
    !/archivingId/.test(islandPanel) && !/isl-archiving/.test(islandPanel) && !/isl-archive-flight/.test(islandPanel) &&
    !/ARCHIVE_ANIMATION_MS/.test(notchHost) && !/waitForArchivePaint/.test(notchHost) &&
    !/isl-archive-minimize/.test(islandCss) && !/isl-archive-chip/.test(islandCss))
ok('notch host moves sessions locally after archive/restore succeeds instead of relying only on broadcasts',
  /moveSessionToArchive/.test(notchHost) && /setSessions\(\(prev\) => prev\.filter/.test(notchHost) &&
    /setArchivedSessions\(\(prev\)/.test(notchHost) && /moveSessionFromArchive/.test(notchHost) &&
    /chatControl\('archive'/.test(notchHost) && /chatControl\('unarchive'/.test(notchHost))
ok('settings renders archived agents with restore and inline delete confirmation',
  /Archived agents/.test(islandSettings) && /archivedSessions\.map/.test(islandSettings) &&
    /Restore/.test(islandSettings) && /Delete forever\?/.test(islandSettings) && /confirmDeleteId/.test(islandSettings))
ok('archived agents show a clipped last-message preview instead of current status',
  /lastMessagePreview/.test(notchTypes) && /lastMessagePreview/.test(notchHost) &&
    /ARCHIVED_PREVIEW_CHARS/.test(islandSettings) && /archivedMessagePreview\(session\)/.test(islandSettings) &&
    /isl-archived-preview/.test(islandSettings) && !/settingsStatusLabel/.test(islandSettings))
ok('permanent archived-agent delete goes through closeAgent only after settings confirmation',
  /deleteArchivedAgent[\s\S]*?closeAgent\?\.\(id\)/.test(notchHost) &&
    /onDeleteAgent\(session\.id\)/.test(islandSettings) && !/stopAgent/.test(islandSettings) && !/openTerminal/.test(islandSettings))
ok('island chat renders markdown with react-markdown + GFM and no raw HTML path',
  pkg.dependencies?.['react-markdown'] && pkg.dependencies?.['remark-gfm'] &&
    /import MarkdownMessage from '.\/MarkdownMessage'/.test(islandPanel) &&
    /import \{ matchingChoiceAnswer \} from '.\/messageParts'/.test(islandPanel) &&
    /<MarkdownMessage[\s\S]*?role=\{m\.role\}[\s\S]*?text=\{m\.text\}/.test(islandPanel) &&
    /from 'react-markdown'/.test(markdownMessage) &&
    /from 'remark-gfm'/.test(markdownMessage) &&
    /remarkPlugins=\{remarkPlugins\}/.test(markdownMessage) &&
    /skipHtml/.test(markdownMessage) &&
    !/dangerouslySetInnerHTML/.test(markdownMessage) &&
    !/rehypeRaw/.test(markdownMessage))
ok('markdown links use the safe external-url bridge and unsafe schemes become inert',
  /openExternalUrl\(url: string\)/.test(preload) &&
    /ipcRenderer\.invoke\('os:open-external-url'/.test(preload) &&
    /ipcMain\.handle\('os:open-external-url'/.test(index) &&
    /shell\.openExternal\(url\)/.test(index) &&
    /url\.protocol === 'http:' \|\| url\.protocol === 'https:' \|\| url\.protocol === 'mailto:'/.test(index) &&
    /DATA_IMAGE_RE/.test(markdownSafety) &&
    /markdownUrlTransform/.test(markdownMessage) &&
    /className="isl-md-link inert"/.test(markdownMessage) &&
    /\.isl-md-table-wrap/.test(islandCss) &&
    /user-select: text/.test(islandCss))
ok('island chat has a typed message-parts adapter before rendering markdown or prompts',
  /IslandMessagePart/.test(notchTypes) &&
    /type: 'text'/.test(notchTypes) &&
    /type: 'choice'/.test(notchTypes) &&
    /type: 'tool'/.test(notchTypes) &&
    /parts\?: IslandMessagePart\[\]/.test(notchTypes) &&
    /messagePartsFor/.test(messageParts) &&
    /parseBlitzUiChoicePart/.test(messageParts) &&
    /matchingChoiceAnswer/.test(messageParts) &&
    /messagePartsFor\(\{ role, text, parts: providedParts \}\)/.test(markdownMessage))
ok('blitz-ui choice prompts render as typed tappable island parts instead of raw JSON',
  /```blitz-ui/.test(messageParts) &&
    /JSON\.parse/.test(messageParts) &&
    /rawKind === 'choice' \|\| rawKind === 'grid'/.test(messageParts) &&
    /className=\{`isl-ask-card \$\{part\.layout\}/.test(markdownMessage) &&
    /case 'choice':/.test(markdownMessage) &&
    /onChoose\?\.\(option\.label\)/.test(markdownMessage) &&
    /onChoose=\{\(choice\) => onSend\(choice\)\}/.test(islandPanel) &&
    /\.isl-ask-card/.test(islandCss) &&
    /\.isl-ask-option/.test(islandCss))
ok('submitted blitz-ui prompts collapse to prompt plus selected answer in history',
  /selectedAnswer/.test(markdownMessage) &&
    /isl-ask-selected/.test(markdownMessage) &&
    /className=\{`isl-ask-card \$\{part\.layout\}\$\{answered \? ' answered' : ''\}`\}/.test(markdownMessage) &&
    /matchingChoiceAnswer/.test(islandPanel) &&
    /isSubmittedAskAnswer/.test(islandPanel) &&
    /if \(isSubmittedAskAnswer\) return null/.test(islandPanel) &&
    /\.isl-ask-card\.answered/.test(islandCss) &&
    /\.isl-ask-selected-answer/.test(islandCss))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
