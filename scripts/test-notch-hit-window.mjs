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
const rendererMain = readFileSync(join(repoRoot, 'src/renderer/src/main.tsx'), 'utf8')
const app = readFileSync(join(repoRoot, 'src/renderer/src/App.tsx'), 'utf8')
const notchHost = readFileSync(join(repoRoot, 'src/renderer/src/notch/NotchHost.tsx'), 'utf8')
const islandHome = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandHome.tsx'), 'utf8')
const islandPanel = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandPanel.tsx'), 'utf8')
const islandOnboarding = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandOnboarding.tsx'), 'utf8')
const onboardingVisuals = readFileSync(join(repoRoot, 'src/renderer/src/notch/onboardingVisuals.tsx'), 'utf8')
const onboardingVisualsCss = readFileSync(join(repoRoot, 'src/renderer/src/notch/onboardingVisuals.css'), 'utf8')
const agentVisualsPath = join(repoRoot, 'src/renderer/src/notch/agentVisuals.ts')
const agentVisuals = existsSync(agentVisualsPath) ? readFileSync(agentVisualsPath, 'utf8') : ''
const onboardingConfig = readFileSync(join(repoRoot, 'src/renderer/src/onboarding/config.ts'), 'utf8')
const markdownMessage = readFileSync(join(repoRoot, 'src/renderer/src/notch/MarkdownMessage.tsx'), 'utf8')
const messageParts = readFileSync(join(repoRoot, 'src/renderer/src/notch/messageParts.ts'), 'utf8')
const markdownSafety = readFileSync(join(repoRoot, 'src/renderer/src/notch/markdownSafety.ts'), 'utf8')
const appEmbeds = readFileSync(join(repoRoot, 'src/renderer/src/notch/appEmbeds.tsx'), 'utf8')
const islandSettings = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandSettings.tsx'), 'utf8')
const islandTerminal = readFileSync(join(repoRoot, 'src/renderer/src/notch/IslandTerminalPane.tsx'), 'utf8')
const notchTypes = readFileSync(join(repoRoot, 'src/renderer/src/notch/types.ts'), 'utf8')
const islandCss = readFileSync(join(repoRoot, 'src/renderer/src/notch/island.css'), 'utf8')
const notchCss = readFileSync(join(repoRoot, 'src/renderer/src/notch/notch.css'), 'utf8')
const css = readFileSync(join(repoRoot, 'src/renderer/src/styles.css'), 'utf8')
const workspaceHost = readFileSync(join(repoRoot, 'src/main/workspace-host.mjs'), 'utf8')
const workspaceHostTypes = readFileSync(join(repoRoot, 'src/main/workspace-host.d.mts'), 'utf8')
const workspaceCore = readFileSync(join(repoRoot, 'src/main/workspace.mjs'), 'utf8')
const osTools = readFileSync(join(repoRoot, 'src/main/os-tools.mjs'), 'utf8')
const activityLogging = readFileSync(join(repoRoot, 'src/main/activity-logging.mjs'), 'utf8')
const electronOsTools = readFileSync(join(repoRoot, 'src/main/electron-os-tools.ts'), 'utf8')
const previewBackend = readFileSync(join(repoRoot, 'preview/backend.mjs'), 'utf8')
const activity = readFileSync(join(repoRoot, 'src/main/activity.mjs'), 'utf8')
const blitzosAgents = readFileSync(join(repoRoot, 'src/main/blitzos-agents.md'), 'utf8')
const agentRuntime = readFileSync(join(repoRoot, 'src/main/agent-runtime.mjs'), 'utf8')
const agentTranscript = readFileSync(join(repoRoot, 'src/main/agent-transcript.mjs'), 'utf8')
const chatTitleer = readFileSync(join(repoRoot, 'src/main/chat-titleer.mjs'), 'utf8')
const osActions = readFileSync(join(repoRoot, 'src/main/osActions.ts'), 'utf8')
const terminalManager = readFileSync(join(repoRoot, 'src/main/terminal-manager.mjs'), 'utf8')
const onboardingMain = readFileSync(join(repoRoot, 'src/main/onboarding.ts'), 'utf8')
const freshOnboarding = readFileSync(join(repoRoot, 'scripts/fresh-onboarding-dev.sh'), 'utf8')
const computerUseHelperPlist = readFileSync(join(repoRoot, 'native/computer-use-helper/Info.plist'), 'utf8')
const computerUseHelperBuild = readFileSync(join(repoRoot, 'native/computer-use-helper/build.sh'), 'utf8')
const computerUseHelperSwift = readFileSync(join(repoRoot, 'native/computer-use-helper/main.swift'), 'utf8')
const computerUseHelperManager = readFileSync(join(repoRoot, 'src/main/computer-use-helper.ts'), 'utf8')
const builderConfig = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
const ensureHelper = readFileSync(join(repoRoot, 'scripts/ensure-helper.sh'), 'utf8')
const telemetrySchema = readFileSync(join(repoRoot, 'telemetry/teenybase.ts'), 'utf8')
const telemetryWorker = readFileSync(join(repoRoot, 'telemetry/worker.ts'), 'utf8')
const oldOnboardingFlowPath = join(repoRoot, 'src/renderer/src/onboarding/OnboardingFlow.tsx')
const oldOnboardingCssPath = join(repoRoot, 'src/renderer/src/onboarding/onboarding.css')
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
ok('privacy-safe activity logging is config-gated and separate from replay telemetry',
  /activity-logging\.json/.test(activityLogging) &&
    /BLITZ_ACTIVITY_LOGGING === '0'/.test(activityLogging) &&
    /export const ACTIVITY_EVENT_NAMES = new Set/.test(activityLogging) &&
    /export function sanitizeActivityEvent/.test(activityLogging) &&
    /export function sanitizeToolActivity/.test(activityLogging) &&
    !/capturePage/.test(activityLogging) &&
    !/sessionTape/.test(activityLogging) &&
    /initActivityLogging/.test(index) &&
    /setToolTap\(\(info\) => trackToolActivity/.test(index))
ok('activity IPC accepts only named events and sanitized props through main',
  /activity: \{[\s\S]*?track\(name: string, props\?: Record<string, unknown>\): void[\s\S]*?ipcRenderer\.send\('os:activity-track'/.test(preload) &&
    /ipcMain\.on\('os:activity-track'[\s\S]*?trackActivity\(name, props\)/.test(index) &&
    /chat\.message_sent/.test(activityLogging) &&
    /messageLengthBucket/.test(activityLogging) &&
    /agentIdHash/.test(activityLogging) &&
    /statusCode/.test(activityLogging) &&
    !/out\.text|out\.title|out\.url|out\.path|out\.args|out\.result|out\.stack/.test(activityLogging))
ok('workspace host exposes safe chat status transitions for activity logging',
  /onChatStatusTransition\?: \(change: \{ agentId: string; previousStatus\?: string; status: string; source\?: string \}\) => void/.test(workspaceHostTypes) &&
    /onChatStatusTransition: \(\{ agentId, previousStatus, status, source \}\) =>[\s\S]*?trackActivity\('agent\.status_changed'/.test(osActions) &&
    /const previousStatus = chatStatus\(id\)/.test(workspaceHost) &&
    /previousStatus !== s[\s\S]*?a\.onChatStatusTransition\?\.\(\{ agentId: id, previousStatus, status: s, source \}\)/.test(workspaceHost))
ok('activity backend has separate key-gated tables and ingest/data routes',
  /name: 'activity_sessions'/.test(telemetrySchema) &&
    /name: 'activity_events'/.test(telemetrySchema) &&
    /tables: \[sessions, segments, frames, activitySessions, activityEvents\]/.test(telemetrySchema) &&
    /userApp\.post\('\/ingest\/activity'[\s\S]*?const db = await gate\(c\)/.test(telemetryWorker) &&
    /cleanActivityProps/.test(telemetryWorker) &&
    /userApp\.get\('\/dash\/activity\/data'/.test(telemetryWorker))
ok('activity dashboard is password-gated and exposes product overview UI',
  /ACTIVITY_DASH_PASSWORD/.test(telemetryWorker) &&
    /activityDashboardGate/.test(telemetryWorker) &&
    /const ACTIVITY_DASH_HTML = `<!doctype html>/.test(telemetryWorker) &&
    /DAU/.test(telemetryWorker) &&
    /WAU/.test(telemetryWorker) &&
    /MAU/.test(telemetryWorker) &&
    /Onboarding funnel/.test(telemetryWorker) &&
    /Activation & adoption/.test(telemetryWorker) &&
    /userApp\.get\('\/activity'/.test(telemetryWorker) &&
    /userApp\.get\('\/dash\/activity'/.test(telemetryWorker))
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
ok('opening Chat from Home selects the Blitz main thread instead of the last agent tab',
  /const openChat = \(\): void => \{[\s\S]*?const i = sessionsRef\.current\.findIndex\(\(s\) => s\.id === '0'\)[\s\S]*?setPage\(i >= 0 \? i \+ 1 : 1\)[\s\S]*?setPeek\(false\)[\s\S]*?setAttachOpen\(false\)[\s\S]*?setView\('session'\)/.test(notchHost) &&
    /onOpenChat=\{openChat\}/.test(notchHost))
ok('first-launch onboarding is owned by the dynamic island, not the old fullscreen overlay',
  /export type IslandView = 'home' \| 'settings' \| 'session' \| 'onboarding'/.test(notchTypes) &&
    /const islandViewRef = useRef<IslandView>\('home'\)/.test(app) &&
    /if \(!onboarding \|\| isServer \|\| !notchOn\) return/.test(app) &&
    /islandViewRef\.current = 'onboarding'/.test(app) &&
    /setNotchPinnedBoth\(true\)/.test(app) &&
    /applyNotchState\('panel'\)/.test(app) &&
    /onOnboardingComplete=\{completeIslandOnboarding\}/.test(app) &&
    !/OnboardingFlow/.test(app) &&
    !/onboarding\/onboarding\.css/.test(rendererMain) &&
    !existsSync(oldOnboardingFlowPath) &&
    !existsSync(oldOnboardingCssPath) &&
    /ONBOARDING_MODE: 'always' \| 'first-launch' \| 'off' = 'first-launch'/.test(onboardingConfig) &&
    preload.includes("forceVisible: process.env.BLITZ_FORCE_ONBOARDING === '1'") &&
    onboardingConfig.includes('window.agentOS?.onboarding?.forceVisible') &&
    freshOnboarding.includes('export BLITZ_FORCE_ONBOARDING=1'))
ok('island onboarding uses the setup IPC surface and does not start the scan/interview path',
  /import IslandOnboarding from '.\/IslandOnboarding'/.test(notchHost) &&
    /view === 'onboarding'/.test(notchHost) &&
    /<IslandOnboarding[\s\S]*?onComplete=\{\(\) => \{[\s\S]*?setView\('session'\)[\s\S]*?onOnboardingComplete\?\.\(\)/.test(notchHost) &&
    /api\.preboardState\(\)/.test(islandOnboarding) &&
    /api\.listImportProfiles/.test(islandOnboarding) &&
    /const request = api\?\.openPermissionDrag\?\.\(kind\)/.test(islandOnboarding) &&
    /api[\s\S]*?\.importSignin\(picked\.src, picked\.id\)/.test(islandOnboarding) &&
    /api\.requestAutomation/.test(islandOnboarding) &&
    /api\.preboardMark\?\.\('import',/.test(islandOnboarding) &&
    /api\.preboardMark\?\.\('browser',/.test(islandOnboarding) &&
    !/\.start\(\)/.test(islandOnboarding))
ok('island onboarding starts with five simple intro slides before setup',
  /const INTRO_SLIDES: IntroSlide\[\] = \[/.test(islandOnboarding) &&
    /Meet Blitz — your agents, on tap/.test(islandOnboarding) &&
    /Run a roster of agents at once/.test(islandOnboarding) &&
    /Put your browser and apps in reach/.test(islandOnboarding) &&
    /Watch the work unfold/.test(islandOnboarding) &&
    /A few permissions make it useful/.test(islandOnboarding) &&
    /import \{ OnboardingVisual, OnboardingDoneHero, type IntroVisual \} from '.\/onboardingVisuals'/.test(islandOnboarding) &&
    /import blitzAppIcon from '\.\.\/assets\/blitz-app-icon\.png'/.test(onboardingVisuals) &&
    /<img src=\{blitzAppIcon\} alt="" draggable=\{false\} \/>/.test(onboardingVisuals) &&
    /const \[introDone, setIntroDone\] = useState\(false\)/.test(islandOnboarding) &&
    /\{!introDone && \(/.test(islandOnboarding) &&
    /\{introDone && step === 'permissions' && state && \(/.test(islandOnboarding) &&
    /\.isl-onb-intro/.test(islandCss) &&
    /\.oba-home-icon img/.test(onboardingVisualsCss) &&
    /background: #0a84ff;/.test(islandCss) &&
    /\.isl-onb-progress/.test(islandCss))
ok('agent 0 boots into the resident-only BLITZ_DUTY — no interview, no choice-card kickoff, no greeting',
  // ONE resident duty, not two phases: the interview/resident split (INTERVIEW_BOOT_TASK +
  // RESIDENT_INITIATIVE_BOOT_TASK) is gone; interviewBootTask() returns BLITZ_DUTY (the chat gate aside).
  /const BLITZ_DUTY =/.test(onboardingMain) &&
    /resident agent/.test(onboardingMain) &&
    /Do not run an interview/.test(onboardingMain) &&
    /export function interviewBootTask\(\): string \| null \{[\s\S]*?if \(!ONBOARDING_CHAT_ENABLED\) return null[\s\S]*?return BLITZ_DUTY/.test(onboardingMain) &&
    !/INTERVIEW_BOOT_TASK/.test(onboardingMain) &&
    !/RESIDENT_INITIATIVE_BOOT_TASK/.test(onboardingMain) &&
    // The duty itself must never kick off an interview / choice-card flow.
    !/THE ONBOARDING INTERVIEW/.test(onboardingMain) &&
    !/choice-card question/.test(onboardingMain) &&
    // The opt-in chat gate + the (now interview-free) artifact/phase guards still hold.
    /const ONBOARDING_CHAT_ENABLED = process\.env\.BLITZ_ONBOARDING_CHAT === '1'/.test(onboardingMain) &&
    /function startInterviewPhase\(wsPath: string\): void \{[\s\S]*?if \(!ONBOARDING_CHAT_ENABLED\)/.test(onboardingMain) &&
    /if \(ONBOARDING_CHAT_ENABLED\) ensureInterviewArtifacts\(wsPath\)/.test(onboardingMain))
ok('permission drag helper shows a Blitz icon with a clear drag animation while dragging the real helper bundle',
  /const icon = iconUrl \? `<img src="\$\{iconUrl\}" alt="" draggable="false">` : '<span class="fallback">B<\/span>'/.test(onboardingMain) &&
    /function blitzVisualIconDataUrl\(\): Promise<string \| null>/.test(onboardingMain) &&
    /src\/renderer\/src\/assets\/blitz-app-icon\.png/.test(onboardingMain) &&
    /class="drag"[\s\S]*?class="ghost"[\s\S]*?class="tile"[\s\S]*?class="arrow"/.test(onboardingMain) &&
    /@keyframes dragIconHint/.test(onboardingMain) &&
    /@keyframes dragArrowHint/.test(onboardingMain) &&
    /transform:translateY\(-16px\)/.test(onboardingMain) &&
    /<div class="c">Drag the Blitz Icon into \$\{label\}<\/div>/.test(onboardingMain) &&
    /const html = dragHelperHtml\(kind, await blitzVisualIconDataUrl\(\)\)/.test(onboardingMain) &&
    /const bundle = currentDragBundle[\s\S]*?e\.sender\.startDrag\(\{ file: bundle, icon \}\)/.test(onboardingMain) &&
    /<key>CFBundleDisplayName<\/key>\s*<string>BlitzOS Automation<\/string>/.test(computerUseHelperPlist) &&
    /<key>CFBundleName<\/key>\s*<string>BlitzOS Automation<\/string>/.test(computerUseHelperPlist) &&
    /<key>CFBundleExecutable<\/key>\s*<string>BlitzOS Automation<\/string>/.test(computerUseHelperPlist) &&
    /<key>CFBundleVersion<\/key>\s*<string>14<\/string>/.test(computerUseHelperPlist) &&
    /APP_NAME="BlitzOS Automation"/.test(computerUseHelperBuild) &&
    /native\/computer-use-helper\/build\/BlitzOS Automation\.app/.test(builderConfig) &&
    /to: "BlitzOS Automation\.app"/.test(builderConfig) &&
    /build\/BlitzOS Automation\.app\/Contents\/MacOS\/BlitzOS Automation/.test(ensureHelper) &&
    /build', 'BlitzOS Automation\.app'/.test(computerUseHelperManager) &&
    /return join\(app\.getPath\('appData'\), 'BlitzOS', 'BlitzOS Automation\.app'\)/.test(computerUseHelperManager) &&
    /assets\/blitz-app-icon\.png/.test(computerUseHelperBuild) &&
    /Drag the BlitzOS icon into the permission list/.test(islandOnboarding) &&
    !/Accessibility granted to BlitzComputerUse/.test(computerUseHelperSwift))
ok('agent gradient visuals are shared between the session tabs and home working rail',
  (/export function agentGradient\(id: string\): string/.test(agentVisuals) &&
    /import \{ agentGradient \} from '.\/agentVisuals'/.test(islandPanel) &&
    /import \{ agentGradient \} from '.\/agentVisuals'/.test(islandHome)) ||
    (/function agentGradient\(id: string\): string/.test(islandPanel) && /agentGradient\(s\.id\)/.test(islandPanel)))
ok('home renders a compact working-agent rail that matches the tab active-work status rule',
  /onOpenAgent: \(id: string\) => void/.test(islandHome) &&
    /const isActiveStatus = \(value: string\): boolean => value === 'working' \|\| value === 'starting'/.test(islandHome) &&
    /const isWorkingStatus = \(value: string\): boolean => value === 'working'/.test(islandHome) &&
    /const isWaitingStatus = \(value: string\): boolean => value === 'waiting'/.test(islandHome) &&
    /doneAgentIds: string\[\]/.test(islandHome) &&
    /const railSessions = sessions\.filter\(\(s\) => \{[\s\S]*?isWorkingStatus\(rawStatus\) \|\| isWaitingStatus\(rawStatus\) \|\| doneAgents\.has\(s\.id\)/.test(islandHome) &&
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
    /isl-working-agent-alert/.test(islandHome) &&
    /homeState === 'done' \? 'Done' : homeState === 'waiting' \? 'Response Needed' : 'Working'/.test(islandHome) &&
    /onClick=\{\(\) => onOpenAgent\(s\.id\)\}/.test(islandHome) &&
    /\.nh-island\.isl-home\.has-working/.test(islandCss) &&
    /\.isl-home-layout \{[\s\S]*?grid-template-columns: minmax\(0, 220px\) minmax\(0, 220px\)/.test(islandCss) &&
    /\.isl-home-working \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)[\s\S]*?max-height: 146px[\s\S]*?overflow-y: auto/.test(islandCss) &&
    homeEmptyBlock.includes('padding: 12px 2px 0') &&
    !/background:|border:|border-radius:|min-height:|place-items:/.test(homeEmptyBlock) &&
    /\.isl-working-agent-icon \{[\s\S]*?border-radius: 50%/.test(islandCss) &&
    /\.isl-working-agent-main \{[\s\S]*?gap: 2px/.test(islandCss) &&
    /\.isl-working-agent-dot \{[\s\S]*?border-top-color: var\(--isl-accent\)[\s\S]*?animation: isl-spin/.test(islandCss) &&
    /\.isl-working-agent\[data-home-state='waiting'\]/.test(islandCss) &&
    /\.isl-working-agent-alert/.test(islandCss))
ok('notch renders one effective session-status list for tabs, active status, and Home',
  /const displaySessions = sessions\.map\(\(s\) => \(\{ \.\.\.s, status: status\[s\.id\] \|\| s\.status \}\)\)/.test(notchHost) &&
    /const N = displaySessions\.length/.test(notchHost) &&
    /const activeSession = activeIndex >= 0 \? displaySessions\[activeIndex\] : null/.test(notchHost) &&
    /sessions=\{displaySessions\}/.test(notchHost) &&
    /const homeSessions = debugFakeHomeAgents \? FAKE_HOME_AGENTS : displaySessions/.test(notchHost))
ok('settings can enable a fake 10-agent Home grid design preview',
  /DEBUG_FAKE_HOME_AGENTS_KEY = 'blitzos\.debug\.showFakeHomeAgents'/.test(notchHost) &&
    /const FAKE_HOME_AGENTS: IslandSession\[\] = \[/.test(notchHost) &&
    (notchHost.match(/id: 'fake-home-/g) || []).length === 10 &&
    /const FAKE_HOME_DONE_IDS = FAKE_HOME_AGENTS\.filter/.test(notchHost) &&
    /function readDebugFakeHomeAgents\(\): boolean/.test(notchHost) &&
    /const \[debugFakeHomeAgents, setDebugFakeHomeAgents\] = useState\(readDebugFakeHomeAgents\)/.test(notchHost) &&
    /const chooseDebugFakeHomeAgents = \(on: boolean\): void =>/.test(notchHost) &&
    /const homeSessions = debugFakeHomeAgents \? FAKE_HOME_AGENTS : displaySessions/.test(notchHost) &&
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
    /const isHomeWaitingStatus = \(value\?: string\): boolean => value === 'waiting'/.test(notchHost) &&
    /const isHomeDoneReviewStatus = \(value\?: string\): boolean => !!value && !isHomeActiveStatus\(value\) && !isHomeWaitingStatus\(value\) && value !== 'error'/.test(notchHost) &&
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
    /isHomeWaitingStatus\(rawStatus\)[\s\S]*?doneClear\.push\(id\)/.test(notchHost) &&
    /reconcileHomeAgentReviewState\(arr, statusRef\.current\)/.test(notchHost) &&
    /reconcileHomeAgentReviewState\(sessionsRef\.current, nextStatus\)/.test(notchHost) &&
    /viewRef\.current === 'home' && isHomeWorkingStatus\(prevStatus\[id\]\) && isHomeDoneReviewStatus\(next\)/.test(notchHost) &&
    /clearHomeReviewAgents\(\)/.test(notchHost) &&
    /clearHomeReviewAgents\(id\)/.test(notchHost) &&
    /doneAgentIds=\{homeDoneAgentIds\}/.test(notchHost) &&
    /homeState === 'done' \? 'Done' : homeState === 'waiting' \? 'Response Needed' : 'Working'/.test(islandHome) &&
    /isl-working-agent-check/.test(islandHome) &&
    /\.isl-working-agent\[data-home-state='done'\]/.test(islandCss) &&
    /\.isl-working-agent-check/.test(islandCss))
ok('home working-agent rail jumps directly to the selected agent chat',
  /const openAgentChat = \(id: string\): void => \{[\s\S]*?const idx = sessions\.findIndex\(\(s\) => s\.id === id\)[\s\S]*?setPage\(idx \+ 1\)[\s\S]*?setPeek\(false\)[\s\S]*?setAttachOpen\(false\)[\s\S]*?setView\('session'\)/.test(notchHost) &&
    /onOpenAgent=\{openAgentChat\}/.test(notchHost))
ok('notch agent status text keeps the backend starting state visible as Warming up',
  /s === 'starting' \|\| s === 'reconnecting' \? 'warming' : s === 'working' \? 'working' : s === 'waiting' \? 'waiting' : s === 'error' \? 'error' : 'idle'/.test(islandPanel) &&
    /case 'working':[\s\S]*?return 'Working'[\s\S]*?case 'starting':[\s\S]*?return 'Warming up'[\s\S]*?case 'reconnecting'/.test(islandPanel) &&
    /case 'waiting':[\s\S]*?return 'Response Needed'/.test(islandPanel) &&
    /case 'stopped':[\s\S]*?return 'Idle'/.test(islandPanel) &&
    /statusLabel\(status\)/.test(islandPanel) &&
    /\.isl-chip-dot\[data-status='warming'\] \{[\s\S]*?animation: isl-dot-pulse/.test(islandCss) &&
    /\.isl-chip-dot\[data-status='working'\] \{[\s\S]*?animation: isl-spin/.test(islandCss) &&
    /\.isl-chip-dot\[data-status='waiting'\]/.test(islandCss) &&
    /\.isl-chip-dot\[data-status='error'\]/.test(islandCss) &&
    /\.isl-inline-details\[data-status='waiting'\]/.test(islandCss) &&
    /\.isl-inline-details\[data-status='working'\] \.isl-inline-status-dot \{[\s\S]*?animation: isl-spin/.test(islandCss) &&
    /@keyframes isl-spin/.test(islandCss))
ok('workspace host derives working status from contextual terminal output and active workflow runs',
  /chatWorkflowRuns = new Map/.test(workspaceHost) &&
    /chatTerminalWorkUntil = new Map/.test(workspaceHost) &&
    /chatUserTurnAt = new Map/.test(workspaceHost) &&
    /function clearTurnActivity\(agentId\)/.test(workspaceHost) &&
    /function noteWorkflowRun\(agentId, runId, active\)/.test(workspaceHost) &&
    /hasActiveWorkflow\(id\)[\s\S]*?terminalWorkActive\(id\)/.test(workspaceHost) &&
    /recentUserTurn\(id, now\)/.test(workspaceHost))
ok('workflow-run broadcasts update chat status, not only the workflow registry',
  /osNoteWfRun\(action\)[\s\S]*?wsHost\?\.noteWorkflowRun\(String\(action\.agentId\), String\(action\.runId\), true\)[\s\S]*?wsHost\?\.noteWorkflowRun\(String\(action\.agentId\), String\(action\.runId\), false\)/.test(osActions) &&
    /noteWorkflowRun\(agentId: string, runId: string, active: boolean\)/.test(workspaceHostTypes))
ok('new agents do not flash Warming up, while existing starting agents still can',
  /setChatStatusLocal\(id, 'idle'\)[\s\S]*?updateChatHubState\(id, true\)[\s\S]*?a\.launchAgent\?/.test(workspaceHost) &&
    /setChatStatusLocal\(id, 'starting', 'resume'\)/.test(workspaceHost) &&
    /terminal\?\.kind === 'agent' && action\.id != null && wsHost\?\.chatStatusSnapshot\?\.\(\)\?\.\[String\(action\.id\)\] === 'starting'/.test(osActions))
ok('agent replies use a soft post-reply settle window instead of hard-completing the turn',
  /CHAT_POST_SAY_SETTLE_MS/.test(workspaceHost) &&
    /chatPostSaySettleTimers = new Map/.test(workspaceHost) &&
    /function schedulePostSaySettle\(agentId, text = ''\)/.test(workspaceHost) &&
    /terminalWorkActive\(id\) \|\| recentUserTurn\(id\)/.test(workspaceHost) &&
    /if \(source === 'say'\) \{[\s\S]*?schedulePostSaySettle\(id\)[\s\S]*?return \{ ok: true \}/.test(workspaceHost) &&
    /if \(role === 'agent'\) \{[\s\S]*?schedulePostSaySettle\(aid, text\)/.test(workspaceHost) &&
    !/if \(role === 'agent'\) \{[\s\S]*?clearTurnActivity\(aid\)[\s\S]*?setChatStatusLocal\(aid, hasActiveWorkflow\(aid\) \? 'working' : 'watching', 'say'\)/.test(workspaceHost))
ok('terminal activity during the post-reply settle window keeps the agent working',
  /const postSayPending = hasPostSaySettle\(id\)/.test(workspaceHost) &&
    /if \(!postSayPending && now - prev < CHAT_TERMINAL_ACTIVITY_MS\)/.test(workspaceHost) &&
    /if \(postSayPending\) clearPostSaySettle\(id\)/.test(workspaceHost) &&
    /hasActiveWorkflow\(id\) \|\| postSayPending \|\| cur\?\.status === 'working'/.test(workspaceHost))
ok('post-reply terminal activity uses a shorter continuation lease',
  /CHAT_POST_SAY_TERMINAL_WORK_MS/.test(workspaceHost) &&
    /function shortenTerminalWorkAfterSay\(agentId, now = Date\.now\(\)\)/.test(workspaceHost) &&
    /shortenTerminalWorkAfterSay\(id\)/.test(workspaceHost) &&
    /const postSayTerminal = postSayPending \|\| cur\?\.source === 'terminal-post-say'/.test(workspaceHost) &&
    /extendTerminalWork\(id, now, postSayTerminal \? CHAT_POST_SAY_TERMINAL_WORK_MS : CHAT_TERMINAL_WORK_MS\)/.test(workspaceHost) &&
    /if \(postSayTerminal\) source = 'terminal-post-say'/.test(workspaceHost))
ok('Claude end_turn is used as a fresh backend turn-complete signal for status',
  /export function lastAssistantStop\(jsonlPath\)/.test(agentTranscript) &&
    /stopReason: String\(d\.message\.stop_reason\)/.test(agentTranscript) &&
    /offset: offsets\[i\]/.test(agentTranscript) &&
    /sessionJsonlPath, lastAssistantStop/.test(workspaceHost) &&
    /chatClaudeTurnStopOffset = new Map/.test(workspaceHost) &&
    /CHAT_CLAUDE_END_TURN_POLL_MS/.test(workspaceHost) &&
    /function rememberClaudeTurnBaseline\(agentId\)/.test(workspaceHost) &&
    /function hasClaudeTurnBaseline\(agentId\)/.test(workspaceHost) &&
    /function claudeTurnEndedClean\(agentId\)/.test(workspaceHost) &&
    /stop\.stopReason === 'end_turn' && Number\(stop\.offset\) > baseline/.test(workspaceHost) &&
    /setTimeout\(finishSettle, nextDelay\)/.test(workspaceHost) &&
    /claudeTurnEndedClean\(id\)[\s\S]*?setChatStatusLocal\(id, 'watching', 'claude-end-turn'\)/.test(workspaceHost))
ok('blitz-ui choice prompts mark the agent response-needed until the user responds',
  /function isBlitzUiChoiceText\(text\)/.test(workspaceHost) &&
    /isBlitzUiChoiceText\(text\)[\s\S]*?setChatStatusLocal\(id, 'waiting', 'ask'\)/.test(workspaceHost) &&
    /if \(chatStatuses\.get\(id\)\?\.status === 'waiting'\) return \{ ok: true, waiting: true \}/.test(workspaceHost) &&
    /if \(s === 'working' \|\| s === 'starting'\) scheduleChatWatching/.test(workspaceHost) &&
    /chatUserTurnAt\.set\(aid, Date\.now\(\)\)[\s\S]*?setChatStatusLocal\(aid, 'working', 'user-message'\)/.test(workspaceHost))
ok('explicit idle final replies settle without waiting for the generic terminal-work lease',
  /function isIdleCompletionText\(text\)/.test(workspaceHost) &&
    /isIdleCompletionText\(text\)[\s\S]*?clearTurnActivity\(id\)[\s\S]*?setChatStatusLocal\(id, 'watching', 'say-final'\)/.test(workspaceHost))
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
ok('island terminal pane hands the active terminal to a real macOS Terminal window instead of embedding a log',
  /terminalOpenExternal\?\.\(terminalId\)/.test(islandTerminal) &&
    /Open in Terminal/.test(islandTerminal) &&
    /terminalOpenExternal\(id: string\)/.test(preload) &&
    /ipcRenderer\.invoke\('os:terminal-open-external'/.test(preload) &&
    /ipcMain\.handle\('os:terminal-open-external'/.test(index) &&
    /function openTerminalExternal/.test(index) &&
    !/subscribeTerminal\(/.test(islandTerminal) &&
    !/terminalInput/.test(islandTerminal) &&
    !/terminalResize/.test(islandTerminal))
ok('debug terminal open revives placeholder agents through the real launch path, not a shell restart',
  /let reviveAgentBackend/.test(index) &&
    /reviveAgentBackend = \(id, title\) => launchAgent\(String\(id\), 0, title \|\| undefined\)/.test(index) &&
    /terminal\?\.kind === 'agent' && terminal\.status !== 'stopped' && !isRestartableAgentTerminal\(terminal\)[\s\S]*?reviveOrRestartAgentBackend\(id, terminal\)/.test(index) &&
    /terminal is not a live tmux window/.test(index))
ok('island terminal pane keeps a compact debug row with an external-open action',
  /className="isl-terminal-debug"/.test(islandTerminal) &&
    /className="isl-term-external"/.test(islandTerminal) &&
    /\.isl-term-external/.test(islandCss) &&
    /\.isl-terminal-debug/.test(islandCss) &&
    !/className="isl-terminal-log"/.test(islandTerminal))
ok('App no longer exposes the old agent-terminal surface toggle or opens agent terminals with openTerminal',
  !/showAgentTerminals/.test(app) && !/Agent terminal visibility/.test(app) && /term\.kind !== 'agent'/.test(app) &&
    /Managed agent terminals stay hidden here/.test(app))
ok('real user messages revive the selected agent if its backend exited or only a placeholder shell exists',
  /setOnUserMessage\(\(sid\) => \{[\s\S]*?const id = String\(sid \|\| '0'\)[\s\S]*?isRecoverableAgentPane\(id\)[\s\S]*?agent .* not live on user message[\s\S]*?electronTerminalOps\.getTerminal\(id\)[\s\S]*?reviveOrRestartAgentBackend\(id, terminal\)[\s\S]*?osKickBrain\(id\)/.test(index))
ok('wake watchdog refuses to type recovery nudges into shell-only agent panes',
  /const isRecoverableAgentPane = \(id: string\): boolean => \{[\s\S]*?electronTerminalOps\.isTerminalLive\(id\) && isRestartableAgentTerminal\(terminal\)/.test(index) &&
    /isLive: \(id\) => isRecoverableAgentPane\(String\(id\)\)/.test(index))
ok('terminal restart never turns a placeholder agent meta into a plain shell',
  /if \(meta\.kind === 'agent' && !command\) return null/.test(terminalManager))

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
ok('active chat view moves status/details into a Claude-like inline transcript row',
  /const showInlineDetails = Boolean\(activeId && \(latestDetail \|\| dotStatus\(status\) !== 'idle' \|\| detailsOpen\)\)/.test(islandPanel) &&
    /const inlineDetails = showInlineDetails \? \(/.test(islandPanel) &&
    /className=\{`isl-inline-details/.test(islandPanel) &&
    /data-status=\{dotStatus\(status\)\}/.test(islandPanel) &&
    /i === lastVisibleTurnIndex && inlineDetails/.test(islandPanel) &&
    /className="isl-inline-detail-rows"/.test(islandPanel) &&
    !/className="isl-actions"/.test(islandPanel) &&
    /\.nh-island \.isl-inline-details \{/.test(islandCss) &&
    /\.nh-island \.isl-agent-meta \{[\s\S]*?justify-content: flex-end[\s\S]*?padding: 6px 2px 2px/.test(islandCss))
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
    /title: id === '0' \? 'Blitz' : agentTitleText\(meta\.title \|\| defaultAgentTitle\(id\)\)/.test(workspaceHost) &&
    /const persistedTitle = \(\(\) => \{[\s\S]*?readTerminalMeta\(terminalsDir, String\(id\)\)\?\.title[\s\S]*?\}\)\(\)/.test(index) &&
    /const launchTitle = title \|\| persistedTitle \|\| \(id === '0' \? 'Blitz' : 'New Agent'\)/.test(index) &&
    /title: launchTitle/.test(index) &&
    /\.slice\(0, 24\)/.test(workspaceHost) &&
    /isl-chip-editing/.test(islandCss) &&
    /isl-chip-input/.test(islandCss))
ok('non-primary agent chats auto-title from the first default-titled user message via Claude Haiku',
  /generateAgentTitle\?: \(input: \{ agentId: string; text: string; workspacePath: string \}\)/.test(workspaceHostTypes) &&
    /from '.\/chat-titleer\.mjs'/.test(osActions) &&
    /generateAgentTitle: \(\{ agentId, text, workspacePath \}\) => generateAgentTitle\(\{ agentId, text, workspacePath \}\)/.test(osActions) &&
    /const pendingAutoTitles = new Set\(\)/.test(workspaceHost) &&
    /function shouldAutoTitleAgent/.test(workspaceHost) &&
    /if \(id === '0'\) return false/.test(workspaceHost) &&
    /if \(pendingAutoTitles\.has\(id\)\) return false/.test(workspaceHost) &&
    /typeof a\.generateAgentTitle !== 'function'/.test(workspaceHost) &&
    /!messages\.some\(\(m\) => m && m\.role === 'user'\)/.test(workspaceHost) &&
    /const shouldAutoTitle = role === 'user' && shouldAutoTitleAgent\(aid\)/.test(workspaceHost) &&
    /if \(activeWorkspace !== workspacePath\) return/.test(workspaceHost) &&
    /renameAgent\(id, next\)/.test(workspaceHost) &&
    /--model', 'haiku'/.test(chatTitleer) &&
    /--output-format', 'json'/.test(chatTitleer) &&
    /--json-schema/.test(chatTitleer) &&
    /AGENT_TITLE_MAX = 24/.test(chatTitleer) &&
    /Claude title generation timed out/.test(chatTitleer))
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
    /import \{ matchingChoiceAnswerForMessage \} from '.\/messageParts'/.test(islandPanel) &&
    /<MarkdownMessage[\s\S]*?role=\{m\.role\}[\s\S]*?text=\{m\.text\}/.test(islandPanel) &&
    /showDivider=\{m\.role === 'agent' && i > 0\}/.test(islandPanel) &&
    /from 'react-markdown'/.test(markdownMessage) &&
    /from 'remark-gfm'/.test(markdownMessage) &&
    /remarkPlugins=\{remarkPlugins\}/.test(markdownMessage) &&
    /skipHtml/.test(markdownMessage) &&
    /isl-say-divider/.test(markdownMessage) &&
    /\.isl-msg\.agent\.isl-md-msg\.isl-say-divider/.test(islandCss) &&
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
    /type: 'app'/.test(notchTypes) &&
    /type: 'tool'/.test(notchTypes) &&
    /parts\?: IslandMessagePart\[\]/.test(notchTypes) &&
    /messagePartsFor/.test(messageParts) &&
    /parseBlitzUiChoicePart/.test(messageParts) &&
    /matchingChoiceAnswerForMessage/.test(messageParts) &&
    /messagePartsFor\(\{ role, text, parts: providedParts \}\)/.test(markdownMessage))
ok('blitz-ui choice prompts render as typed tappable island parts instead of raw JSON',
  /```blitz-ui/.test(messageParts) &&
    /JSON\.parse/.test(messageParts) &&
    /rawKind === 'choice' \|\| rawKind === 'grid'/.test(messageParts) &&
    /className=\{`isl-ask-card \$\{part\.layout\}/.test(markdownMessage) &&
    /case 'choice':/.test(markdownMessage) &&
    /onChoose\?\.\(option\.label\)/.test(markdownMessage) &&
    /disabled=\{answered \|\| !onChoose\}/.test(markdownMessage) &&
    /setPendingChoiceSelections/.test(islandPanel) &&
    /onSend\(choice\)/.test(islandPanel) &&
    /\.isl-ask-card/.test(islandCss) &&
    /\.isl-ask-option/.test(islandCss) &&
    /\.isl-ask-card::before/.test(islandCss) &&
    /backdrop-filter: blur\(40px\) saturate\(1\.35\)/.test(islandCss))
ok('submitted blitz-ui prompts show the selected answer in the original prompt UI and hide the duplicate user bubble',
  /selectedAnswer/.test(markdownMessage) &&
    /isl-ask-selected/.test(markdownMessage) &&
    /isl-ask-selected-mark/.test(markdownMessage) &&
    /isl-ask-option\$\{selected \? ' selected' : ''\}/.test(markdownMessage) &&
    /className=\{`isl-ask-card \$\{part\.layout\}\$\{answered \? ' answered' : ''\}`\}/.test(markdownMessage) &&
    /pendingChoiceSelections/.test(islandPanel) &&
    /matchingChoiceAnswerForMessage/.test(islandPanel) &&
    /lastVisibleTurnIndex/.test(islandPanel) &&
    /return i - 1/.test(islandPanel) &&
    /isSubmittedAskAnswer/.test(islandPanel) &&
    /if \(isSubmittedAskAnswer\) return null/.test(islandPanel) &&
    /\.isl-ask-card\.answered/.test(islandCss) &&
    /\.isl-ask-card\.answered \.isl-ask-option/.test(islandCss) &&
    /\.isl-ask-selected-answer/.test(islandCss) &&
    /\.isl-ask-selected-mark/.test(islandCss))
ok('generated app message parts render compact cards and open the island iframe viewer',
  /IslandAppIcon = 'dashboard' \| 'report' \| 'table' \| 'checklist' \| 'form' \| 'share' \| 'browser' \| 'file'/.test(notchTypes) &&
    /IslandAppTone = 'sky' \| 'mint' \| 'amber' \| 'violet' \| 'lime' \| 'rose'/.test(notchTypes) &&
    /export interface IslandAppPart/.test(notchTypes) &&
    /type: 'app'/.test(notchTypes) &&
    /APP_EMBED_ICONS/.test(appEmbeds) &&
    /APP_EMBED_TONES/.test(appEmbeds) &&
    /function normalizedBlitzAppUrl/.test(appEmbeds) &&
    /url\.protocol !== 'https:'/.test(appEmbeds) &&
    /url\.hostname\.endsWith\('\.app\.blitz\.dev'\)/.test(appEmbeds) &&
    /case 'app':/.test(markdownMessage) &&
    /className=\{`isl-app-card/.test(markdownMessage) &&
    /className="isl-app-card-icon"/.test(markdownMessage) &&
    !/isl-app-card-frame/.test(markdownMessage) &&
    /<span className="isl-app-card-kicker">\{part\.title\}<\/span>/.test(markdownMessage) &&
    !/isl-app-card-kicker">Blitz app/.test(markdownMessage) &&
    /onOpenApp\?: \(app: IslandAppMessagePart\) => void/.test(markdownMessage) &&
    /onOpenApp=\{showAppViewer\}/.test(islandPanel) &&
    /const islandActiveAppRef = useRef<IslandAppMessagePart \| null>\(null\)/.test(app) &&
    /const \[islandKeepMounted, setIslandKeepMounted\] = useState\(false\)/.test(app) &&
    /setIslandKeepMounted\(Boolean\(activeApp\)\)/.test(app) &&
    /\(notchState === 'panel' \|\| islandKeepMounted\)/.test(app) &&
    /visible=\{notchState === 'panel'\}/.test(app) &&
    /initialActiveApp=\{islandActiveAppRef\.current\}/.test(app) &&
    /initialActiveApp = null/.test(notchHost) &&
    /visible = true/.test(notchHost) &&
    /const \[activeApp, setActiveApp\] = useState<IslandAppMessagePart \| null>\(initialActiveApp\)/.test(notchHost) &&
    /const \[openApp, setOpenApp\] = useState<IslandAppMessagePart \| null>\(\(\) => activeApp\)/.test(islandPanel) &&
    /const \[appFrameLoaded, setAppFrameLoaded\] = useState\(false\)/.test(islandPanel) &&
    /const appReturnScrollTopRef = useRef<number \| null>\(null\)/.test(islandPanel) &&
    /const previousActiveIdRef = useRef<string \| undefined>\(activeId\)/.test(islandPanel) &&
    /const previousActiveId = previousActiveIdRef\.current/.test(islandPanel) &&
    /if \(previousActiveId === activeId\) return/.test(islandPanel) &&
    /if \(!previousActiveId && activeApp\) return/.test(islandPanel) &&
    /appReturnScrollTopRef\.current = feedRef\.current\?\.scrollTop \?\? null/.test(islandPanel) &&
    /setAppFrameLoaded\(false\)[\s\S]*?setOpenApp\(normalized\)[\s\S]*?onActiveAppChange\(normalized\)/.test(islandPanel) &&
    /setOpenApp\(null\)[\s\S]*?setAppFrameLoaded\(false\)/.test(islandPanel) &&
    /if \(feedRef\.current\) feedRef\.current\.scrollTop = restoreTop/.test(islandPanel) &&
    /\{!openApp && \([\s\S]*?className=\{`isl-tabwrap/.test(islandPanel) &&
    !/isl-app-viewer-head/.test(islandPanel) &&
    !/isl-app-viewer-kicker/.test(islandPanel) &&
    /aria-label="Close generated app"/.test(islandPanel) &&
    /<div className="isl-app-viewer" data-tone=\{openApp\.tone\} data-loaded=\{appFrameLoaded \? 'true' : 'false'\}>[\s\S]*?<div className="isl-app-scroll">[\s\S]*?<iframe/.test(islandPanel) &&
    /<\/div>\s*\{!appFrameLoaded && \([\s\S]*?className="isl-app-loading"[\s\S]*?\)\}\s*<\/div>\s*<button type="button" className="isl-app-viewer-close"/.test(islandPanel) &&
    /<iframe[\s\S]*?className="isl-app-frame"[\s\S]*?src=\{openApp\.url\}[\s\S]*?scrolling="no"[\s\S]*?sandbox="allow-scripts allow-forms allow-popups allow-same-origin"[\s\S]*?onLoad=\{\(\) => setAppFrameLoaded\(true\)\}/.test(islandPanel) &&
    /className="isl-app-loading"/.test(islandPanel) &&
    /style=\{lockHeight && !openApp/.test(islandPanel) &&
    /const \[appViewerOpen, setAppViewerOpen\] = useState\(Boolean\(initialActiveApp\)\)/.test(notchHost) &&
    /onActiveAppChange=\{handleActiveAppChange\}/.test(notchHost) &&
    /setAppViewerOpen\(open\)/.test(notchHost) &&
    /nh-parked/.test(notchHost) &&
    /nh-app-viewing/.test(notchHost) &&
    /\{!onHome && view !== 'onboarding' && !appViewerOpen && \(/.test(notchHost) &&
    /onAppViewerToggle=\{handleAppViewerToggle\}/.test(notchHost) &&
    /\.isl-app-card/.test(islandCss) &&
    /\.isl-app-viewer/.test(islandCss) &&
    /\.nh-island\.isl-process\.isl-app-viewing \{[\s\S]*?max-height: none/.test(islandCss) &&
    /\.nh-island\.isl-app-viewing \{[\s\S]*?width: min\(1200px, calc\(100vw - 32px\)\)[\s\S]*?height: min\(800px, calc\(100vh - 22px\)\)[\s\S]*?overflow: hidden/.test(islandCss) &&
    /\.nh-island\.isl-app-viewing \{[\s\S]*?padding-right: 8px[\s\S]*?padding-bottom: 8px[\s\S]*?padding-left: 8px/.test(islandCss) &&
    /\.nh-chassis\.nh-app-viewing \{[\s\S]*?width: min\(1200px, calc\(100vw - 32px\)\)[\s\S]*?max-width: calc\(100vw - 32px\)/.test(notchCss) &&
    /\.nh-chassis\.nh-parked \{[\s\S]*?pointer-events: none[\s\S]*?opacity: 0/.test(notchCss) &&
    /\.nh-island \.isl-app-viewer \{[\s\S]*?border: 0/.test(islandCss) &&
    /\.nh-island \.isl-app-scroll \{[\s\S]*?overflow-x: auto[\s\S]*?overflow-y: auto[\s\S]*?scrollbar-color: rgba\(255, 255, 255, 0\.24\) rgba\(0, 0, 0, 0\.42\)/.test(islandCss) &&
    /\.nh-island \.isl-app-scroll::-webkit-scrollbar \{[\s\S]*?width: 10px[\s\S]*?height: 10px/.test(islandCss) &&
    /\.nh-island \.isl-app-scroll::-webkit-scrollbar-thumb/.test(islandCss) &&
    /\.nh-island \.isl-app-viewer\[data-loaded='false'\] \.isl-app-frame \{[\s\S]*?opacity: 0/.test(islandCss) &&
    /\.nh-island \.isl-app-loading \{[\s\S]*?position: absolute[\s\S]*?place-items: center/.test(islandCss) &&
    /\.nh-island \.isl-app-loading-mark::after \{[\s\S]*?animation: isl-spin/.test(islandCss) &&
    /\.nh-island\.isl-app-viewing > \.isl-app-viewer-close \{[\s\S]*?position: absolute[\s\S]*?z-index: 40[\s\S]*?width: 28px[\s\S]*?height: 28px/.test(islandCss) &&
    /\.isl-app-frame/.test(islandCss) &&
    /\.nh-island \.isl-app-frame \{[\s\S]*?height: 2400px[\s\S]*?color-scheme: dark[\s\S]*?overflow: hidden/.test(islandCss) &&
    !/openExternalUrl/.test(appEmbeds))
ok('agents can share generated Blitz apps as typed island app cards',
  /path: '\/share_app'/.test(osTools) &&
    /normalizedShareAppSpec/.test(osTools) &&
    /firstBlitzAppPreviewUrl/.test(osTools) &&
    /url\.hostname\.endsWith\('\.app\.blitz\.dev'\)/.test(osTools) &&
    /ops\.shareApp\(normalized\.app/.test(osTools) &&
    /MANDATORY FINAL STEP/.test(osTools) &&
    /this tool rejects \*\.app\.blitz\.dev preview URLs/.test(osTools) &&
    /Do not paste Blitz app preview URLs through say/.test(osTools) &&
    /osShareApp/.test(osActions) &&
    /parts: \[part\]/.test(osActions) &&
    /shareApp: \(app: Record<string, unknown>, agentId\?: string, workspace\?: string\) => osShareApp/.test(electronOsTools) &&
    /shareApp: \(app, agentId, workspace\) =>/.test(previewBackend) &&
    /appendChatMessage\(dir, 'agent', text, String\(agentId \?\? '0'\), meta\)/.test(previewBackend) &&
    /Array\.isArray\(meta\?\.parts\)/.test(workspaceCore) &&
    /msg\.parts = meta\.parts/.test(workspaceCore) &&
    /parts\?: unknown\[\]/.test(workspaceHostTypes) &&
    /'\/share_app'/.test(activity) &&
    /case '\/share_app': return `sharing app/.test(activity) &&
    /share_app \{ title, url: preview_url \}/.test(blitzosAgents) &&
    /Never paste an `\*\.app\.blitz\.dev` preview URL through `say`/.test(blitzosAgents) &&
    /Use share_app for generated blitz\.dev apps/.test(agentRuntime))
ok('fake Blitz app embed debug preview setting is not exposed',
  !/DEBUG_FAKE_APP_EMBED_KEY|debugFakeAppEmbed|fakeAppEmbed|showFakeAppEmbed|Show fake Blitz app embed|Refresh preview|DEFAULT_BLITZ_APP_EMBED_URL/.test(
    `${notchHost}\n${islandSettings}\n${appEmbeds}`
  ) &&
    /const mapMessageParts = \(value: unknown\): IslandMessage\['parts'\] \| undefined =>/.test(notchHost) &&
    /parts: mapMessageParts\(m\.parts\)/.test(notchHost) &&
    /\.filter\(\(m\) => m\.text\.trim\(\) \|\| m\.parts\?\.length\)/.test(notchHost))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
