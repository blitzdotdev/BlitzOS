// Onboarding director (P1 — plans/onboarding-case-file.md): the DETERMINISTIC half of first-run.
// No LLM anywhere in this file. It runs the local scan (scripts/onboarding-scan.mjs) as a child
// process, streams its real progress to the boot screen, builds the "Case File" workspace, and
// seeds the template board. WHAT goes on the board (cards, layout, props) is the pure planner in
// onboarding-board.mjs — this file is the impure glue (scan child, surfaces, IPC, FDA poll). The
// same surfaces double as the resident brain's (P2) medium: it reads .blitzos/onboarding/
// {scan.json,board.json} and drives the SAME ids via update_surface.
//
// FDA tutorial unlock: when Full Disk Access is off, the board gets a native 'unlock' card; we
// poll the TCC probe (the app's own FDA, which the scan child inherits), and on grant re-scan and
// visibly deepen the board (real focus time, Messages/Mail cadence), then retire the card.
//
import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { execFileSync, spawn } from 'node:child_process'

// Repo root in dev; app.asar.UNPACKED in a packaged build — the scan runs as a PLAIN-NODE child
// (no asar fs), so electron-builder.yml ships scripts/onboarding-scan.mjs + the prompt .md files
// asarUnpack'd and we resolve them there.
const appRoot = (): string => app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { osCreateSurface, osUpdateSurface, osCloseSurface, osCreateWorkspace, osSwitchWorkspace, osWorkspaceContext, osGoToPrimary, osSay, osGetState, osKickBrain, osRestartBrain } from './osActions'
import { waitForEvents, latestSeq } from './events'
import { getWidgetSource } from './widget-catalog.mjs'
import { buildBoardPlan, unlockCardProps, findUnlockSlot } from './onboarding-board.mjs'
import type { ScanJson, StagedSurface } from './onboarding-board.mjs'
import { runCannedInterview } from './onboarding-interview.mjs'

const WS_NAME = 'case-file'
const POLL_MS = 3000

interface BoardFile {
  v: 1
  seededAt: number
  fdaAtSeed: boolean
  ids: Record<string, string> // card role → surface id (stable across restarts; the brain reads this too)
  unlockDismissed?: boolean
}

let mainWindow: (() => BrowserWindow | null) | null = null
let starting = false
let pollTimer: ReturnType<typeof setInterval> | null = null

const send = (channel: string, payload: unknown): void => {
  const win = mainWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
const progress = (p: Record<string, unknown>): void => send('onboarding:progress', p)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Same probe as the scan's hasFDA(): can THIS process read a TCC-protected file? In main it tests
// the app's own grant — exactly the entity the scan child (ELECTRON_RUN_AS_NODE) inherits.
export function hasFDA(): boolean {
  const HOME = homedir()
  const tcc = join(HOME, 'Library/Application Support/com.apple.TCC/TCC.db')
  try {
    const fd = openSync(tcc, 'r')
    const b = Buffer.alloc(1)
    readSync(fd, b, 0, 1, 0)
    closeSync(fd)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM' || (e as NodeJS.ErrnoException).code === 'EACCES') return false
  }
  try {
    accessSync(join(HOME, 'Library/Safari/History.db'), constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** What the macOS Settings FDA list will call us: the .app bundle name (dev = "Electron"). */
function fdaAppName(): string {
  const m = process.execPath.match(/([^/]+)\.app\//)
  return m ? m[1] : app.getName()
}

// ---- the scan child --------------------------------------------------------------------------
function onboardingDir(wsPath: string): string {
  return join(wsPath, '.blitzos', 'onboarding')
}

function runScan(wsPath: string): Promise<ScanJson | null> {
  return new Promise((resolve) => {
    const dir = onboardingDir(wsPath)
    mkdirSync(dir, { recursive: true })
    const script = join(appRoot(), 'scripts', 'onboarding-scan.mjs')
    const jsonPath = join(dir, 'scan.json')
    if (!existsSync(script)) {
      progress({ phase: 'error', error: 'scan script not found' })
      resolve(null)
      return
    }
    // --prompt prepends the interviewer instructions, so context.md = the brain's full briefing
    // (rules + scan) in one read. Missing prompt file (packaged build) just degrades to scan-only.
    const promptMd = join(appRoot(), 'src', 'main', 'blitzos-onboarding.md')
    const child = spawn(
      process.execPath,
      [script, '--quiet', '--progress', '--out', join(dir, 'context.md'), '--json', jsonPath, ...(existsSync(promptMd) ? ['--prompt', promptMd] : [])],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'pipe']
      }
    )
    let buf = ''
    child.stderr.on('data', (c: Buffer) => {
      buf += c.toString()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.startsWith('@progress ')) {
          try {
            progress(JSON.parse(line.slice(10)))
          } catch {
            /* malformed progress line — skip */
          }
        }
      }
    })
    const finish = (ok: boolean): void => {
      if (!ok) {
        progress({ phase: 'error', error: 'scan failed' })
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(readFileSync(jsonPath, 'utf8')) as ScanJson)
      } catch {
        progress({ phase: 'error', error: 'scan output unreadable' })
        resolve(null)
      }
    }
    child.on('error', () => finish(false))
    child.on('exit', (code) => finish(code === 0))
  })
}

// ---- board assembly ---------------------------------------------------------------------------
function readBoard(wsPath: string): BoardFile | null {
  try {
    return JSON.parse(readFileSync(join(onboardingDir(wsPath), 'board.json'), 'utf8')) as BoardFile
  } catch {
    return null
  }
}
function writeBoard(wsPath: string, board: BoardFile): void {
  mkdirSync(onboardingDir(wsPath), { recursive: true })
  writeFileSync(join(onboardingDir(wsPath), 'board.json'), JSON.stringify(board, null, 2))
}

/** Live surfaces + viewport for lattice occupancy (the pinned chat hub already holds a span).
 *  Viewport falls back to the real window content size — planning against DEFAULT_VP when the
 *  renderer hasn't pushed yet would place slots on a lattice BIGGER than the real one (observed:
 *  out-of-bounds rows rendering as a pile). */
function liveStage(): { surfaces: StagedSurface[]; viewport: { w: number; h: number } | null } {
  const st = osGetState() as { surfaces?: StagedSurface[]; viewport?: { w: number; h: number } }
  let viewport = st.viewport || null
  if (!viewport) {
    const win = mainWindow?.()
    if (win && !win.isDestroyed()) {
      const b = win.getContentBounds()
      viewport = { w: b.width, h: b.height }
    }
  }
  return { surfaces: st.surfaces || [], viewport }
}

/** Re-ensure path (cached board): slot the unlock card against the LIVE lattice; a full stage
 *  degrades to a free-floating window (floats above tiles, never overlaps them). */
function spawnUnlockCard(): string {
  const live = liveStage()
  const at = findUnlockSlot(live.surfaces, live.viewport)
  return osCreateSurface({ kind: 'native', component: 'unlock', title: 'Unlock the personal layer', ...(at || {}), props: unlockCardProps(fdaAppName()) })
}

async function seedBoard(wsPath: string, scan: ScanJson): Promise<BoardFile> {
  const board: BoardFile = { v: 1, seededAt: Date.now(), fdaAtSeed: scan.meta.fda, ids: {} }
  const plan = buildBoardPlan(scan, liveStage())
  progress({ phase: 'seeding', cards: plan.length })
  for (const card of plan) {
    // staged cards carry slot/slotStage (tiles on the lattice); parked ones carry x/y/w/h below the stage
    const place = card.slot ? { slot: card.slot, slotStage: card.slotStage } : { x: card.x, y: card.y, w: card.w, h: card.h }
    if (card.native === 'unlock') {
      board.ids.unlock = osCreateSurface({ kind: 'native', component: 'unlock', title: card.title, ...place, props: unlockCardProps(fdaAppName()) })
    } else {
      const widget = getWidgetSource(card.widget as string)
      if (!widget) continue
      board.ids[card.role] = osCreateSurface({ kind: 'srcdoc', html: widget.html, title: card.title, ...place, props: card.props })
    }
    await sleep(170) // staggered assembly — the human watches the board build
  }
  writeBoard(wsPath, board)
  osGoToPrimary()
  progress({ phase: 'board-ready', fda: scan.meta.fda })
  return board
}

// ---- the interview (P2): resident brain when a CLI exists, the canned tier when not -----------
interface InterviewState {
  state: 'pending' | 'done'
  startedAt?: number
  finishedAt?: number
  answers?: Record<string, string>
}

function interviewPath(wsPath: string): string {
  return join(onboardingDir(wsPath), 'interview.json')
}
function readInterview(wsPath: string): InterviewState | null {
  try {
    return JSON.parse(readFileSync(interviewPath(wsPath), 'utf8')) as InterviewState
  } catch {
    return null
  }
}
function writeInterview(wsPath: string, st: InterviewState): void {
  mkdirSync(onboardingDir(wsPath), { recursive: true })
  writeFileSync(interviewPath(wsPath), JSON.stringify(st, null, 2))
}

/** Lay down the brain's duty doc + pending state (idempotent; never resets a done interview). */
function ensureInterviewArtifacts(wsPath: string): void {
  const dir = onboardingDir(wsPath)
  mkdirSync(dir, { recursive: true })
  const duty = join(appRoot(), 'src', 'main', 'blitzos-interview.md')
  try {
    if (existsSync(duty)) writeFileSync(join(dir, 'interview.md'), readFileSync(duty, 'utf8'))
  } catch {
    /* template unreadable (packaged build) — the canned tier still works */
  }
  if (!readInterview(wsPath)) writeInterview(wsPath, { state: 'pending', startedAt: Date.now() })
}

// `claude` CLI detection — resolved through a LOGIN shell because GUI Electron's PATH often lacks
// /opt/homebrew/bin. The resolved absolute path doubles as the brain cmd (index.ts brainCmd).
let claudePath: string | null | undefined // undefined = not probed yet
export function claudeCliPath(): string | null {
  if (claudePath !== undefined) return claudePath
  try {
    claudePath = execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 8000 }).trim() || null
  } catch {
    claudePath = null
  }
  return claudePath
}

/** index.ts threads this into the session-'0' brain: its standing duty while the interview is pending. */
export function interviewBootTask(): string | null {
  try {
    const st = readInterview(osWorkspaceContext().workspace_path)
    if (st && st.state === 'pending') {
      return 'Read `.blitzos/onboarding/interview.md` (relative to your cwd, the workspace root) and carry it out: the onboarding interview on the Case File board. If it is already in progress per the chat history, continue it, do not restart it.'
    }
  } catch {
    /* no workspace yet */
  }
  return null
}

let cannedRunning = false
// Restore the brain to full thinking effort once the interview is done: poll interview.json and, on
// the pending→done flip, re-exec agent '0' ONCE (the re-exec drops the interview boot task, so its
// command no longer caps --effort). Single-shot; unref'd so it never holds the process open.
let interviewDoneTimer: ReturnType<typeof setInterval> | null = null
function watchInterviewDone(wsPath: string): void {
  if (interviewDoneTimer) return
  interviewDoneTimer = setInterval(() => {
    const st = readInterview(wsPath)
    if (st && st.state === 'done') {
      if (interviewDoneTimer) clearInterval(interviewDoneTimer)
      interviewDoneTimer = null
      osRestartBrain('0') // resident phase resumes at the default (max) effort
    }
  }, 4000)
  if (interviewDoneTimer.unref) interviewDoneTimer.unref()
}

function startInterviewPhase(wsPath: string): void {
  ensureInterviewArtifacts(wsPath)
  const st = readInterview(wsPath)
  if (!st || st.state !== 'pending') return
  if (claudeCliPath()) {
    // Tier 1: the resident brain (existing per-session supervisor) — its boot task points at the duty doc.
    // It launches at reduced thinking effort for snappy questions (agent-runtime INTERVIEW_EFFORT); once
    // the interview finishes we re-exec it once so the resident phase runs at the default (max) effort.
    osKickBrain('0')
    progress({ phase: 'interview', tier: 'brain' })
    watchInterviewDone(wsPath)
    return
  }
  // Tier 2: no model anywhere — the OS runs the static interview itself, through the same chat cards.
  if (cannedRunning) return
  cannedRunning = true
  progress({ phase: 'interview', tier: 'canned' })
  const ops = {
    say: (t: string) => osSay(t),
    waitEvents: (since: number, maxMs: number) => waitForEvents(since, maxMs, '0'),
    latestSeq: () => latestSeq(),
    updateSurface: (id: string, patch: Record<string, unknown>) => osUpdateSurface(id, patch),
    readBoard: () => {
      const board = readBoard(wsPath)
      if (!board) return null
      const state = osGetState() as { surfaces?: { id: string; props?: { items?: { q?: string; done?: boolean }[] } }[] }
      const gaps = (state.surfaces || []).find((s) => s.id === board.ids.gaps)
      return { ids: board.ids, gapsItems: gaps?.props?.items }
    },
    readState: () => readInterview(wsPath),
    writeState: (obj: Record<string, unknown>) => writeInterview(wsPath, obj as unknown as InterviewState),
    writeProfile: (md: string) => writeFileSync(join(onboardingDir(wsPath), 'profile.md'), md),
    done: () => progress({ phase: 'interview-done', tier: 'canned' })
  }
  void runCannedInterview(ops)
    .catch((e) => console.error('[onboarding] canned interview failed:', e?.message || e))
    .finally(() => {
      cannedRunning = false
    })
}

// ---- FDA unlock: poll → rescan → deepen --------------------------------------------------------
function startFdaPoll(wsPath: string): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    const board = readBoard(wsPath)
    if (!board || board.unlockDismissed) {
      stopFdaPoll()
      return
    }
    if (!hasFDA()) return
    stopFdaPoll()
    void deepen(wsPath)
  }, POLL_MS)
}
function stopFdaPoll(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/** FDA just landed: re-scan (Branch A+B now) and visibly deepen the board in place. */
async function deepen(wsPath: string): Promise<void> {
  const board = readBoard(wsPath)
  if (!board) return
  if (board.ids.unlock) osUpdateSurface(board.ids.unlock, { props: { state: 'scanning' } })
  const scan = await runScan(wsPath)
  if (!scan || !scan.meta.fda) {
    // grant probe raced a revoke, or the rescan failed — restore the card and keep polling
    if (board.ids.unlock) osUpdateSurface(board.ids.unlock, { props: { state: 'locked' } })
    startFdaPoll(wsPath)
    return
  }
  for (const card of buildBoardPlan(scan)) {
    if (card.role === 'unlock') continue // its lifecycle is the granted→retire arc below
    const id = board.ids[card.role]
    if (id) osUpdateSurface(id, { props: card.props })
  }
  if (board.ids.unlock) {
    const unlockId = board.ids.unlock
    osUpdateSurface(unlockId, { props: { state: 'granted' } })
    await sleep(2400)
    osCloseSurface(unlockId)
    delete board.ids.unlock
  }
  writeBoard(wsPath, board)
  osSay('Full Disk Access granted. The personal layer is on the board: real screen time, Messages cadence, Mail correspondents, Safari.')
  progress({ phase: 'deepened' })
}

// ---- entry ------------------------------------------------------------------------------------
async function start(): Promise<{ ok: boolean; cached?: boolean }> {
  if (starting) return { ok: true }
  starting = true
  try {
    osCreateWorkspace(WS_NAME) // idempotent: an already-exists error result is fine
    const sw = await osSwitchWorkspace(WS_NAME)
    if (!sw.ok) {
      progress({ phase: 'error', error: sw.error || 'workspace switch failed' })
      return { ok: false }
    }
    const wsPath = osWorkspaceContext().workspace_path
    const prior = readBoard(wsPath)
    if (prior && Object.keys(prior.ids).length) {
      // Board already seeded (a restart mid-onboarding, or dev re-run): don't re-scan or duplicate —
      // surfaces are file-backed and just rehydrated with the workspace. Re-ensure the unlock card
      // (native = runtime-only, it does not persist) and the poll, then hand straight to the canvas.
      if (!hasFDA() && !prior.unlockDismissed) {
        prior.ids.unlock = spawnUnlockCard()
        writeBoard(wsPath, prior)
        startFdaPoll(wsPath)
      }
      osGoToPrimary()
      progress({ phase: 'board-ready', cached: true, fda: hasFDA() })
      startInterviewPhase(wsPath) // resume a half-finished interview (or no-op when done)
      return { ok: true, cached: true }
    }
    const scan = await runScan(wsPath)
    if (!scan) return { ok: false } // 'error' phase already sent — renderer degrades to plain desktop
    const board = await seedBoard(wsPath, scan)
    if (!scan.meta.fda && !board.unlockDismissed) startFdaPoll(wsPath)
    startInterviewPhase(wsPath) // P2: the resident brain's first duty (or the canned tier)
    return { ok: true }
  } finally {
    starting = false
  }
}

export function registerOnboarding(getWindow: () => BrowserWindow | null): void {
  mainWindow = getWindow
  ipcMain.handle('onboarding:start', () => start())
  ipcMain.handle('onboarding:fda-status', () => ({ fda: hasFDA(), appName: fdaAppName() }))
  ipcMain.handle('onboarding:open-fda-settings', () => {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
    return { ok: true, appName: fdaAppName() }
  })
  ipcMain.handle('onboarding:dismiss-unlock', () => {
    const wsPath = osWorkspaceContext().workspace_path
    const board = readBoard(wsPath)
    if (board) {
      board.unlockDismissed = true
      if (board.ids.unlock) {
        osCloseSurface(board.ids.unlock)
        delete board.ids.unlock
      }
      writeBoard(wsPath, board)
    }
    stopFdaPoll()
    return { ok: true }
  })
  app.on('before-quit', stopFdaPoll)
}
