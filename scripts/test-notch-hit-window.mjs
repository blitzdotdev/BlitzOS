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
const islandHome = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandHome.tsx'), 'utf8')
const islandPanel = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandPanel.tsx'), 'utf8')
const islandSettings = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandSettings.tsx'), 'utf8')
const islandTerminal = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandTerminalPane.tsx'), 'utf8')
const notchTypes = readFileSync(join(repoRoot, 'src/renderer/src/notch/types.ts'), 'utf8')
const islandCss = readFileSync(join(repoRoot, 'src/renderer/src/notch/island.css'), 'utf8')
const notchCss = readFileSync(join(repoRoot, 'src/renderer/src/notch/notch.css'), 'utf8')
const css = readFileSync(join(repoRoot, 'src/renderer/src/styles.css'), 'utf8')
const workspaceHost = readFileSync(join(repoRoot, 'src/main/workspace-host.mjs'), 'utf8')
const osActions = readFileSync(join(repoRoot, 'src/main/osActions.ts'), 'utf8')
const terminalManager = readFileSync(join(repoRoot, 'src/main/terminal-manager.mjs'), 'utf8')

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
    /onChassisResize=\{\(\) => \{[\s\S]*?notchHoldUntilRef\.current = performance\.now\(\) \+ NOTCH_HOVER_OPEN_GRACE_MS/.test(app) &&
    /onPointerEnter=\{\(\) => onChassisHoverChange\?\.\(true\)\}/.test(notchHost) &&
    /onPointerMove=\{\(\) => onChassisHoverChange\?\.\(true\)\}/.test(notchHost) &&
    /onPointerLeave=\{\(\) => onChassisHoverChange\?\.\(false\)\}/.test(notchHost))
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
ok('active chat view offers archive only for non-primary agents',
  /onArchiveAgent/.test(islandPanel) && /activeId !== '0'/.test(islandPanel) && /Archive agent/.test(islandPanel) &&
    /className="isl-archive"/.test(islandPanel))
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

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
