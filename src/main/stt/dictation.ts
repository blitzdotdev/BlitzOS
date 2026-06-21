import { app, clipboard, dialog, Notification, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HelperProcess, type HelperEnsureResult } from './helper-process'
import { osBroadcast } from '../osActions'
import { computerUseHelper } from '../computer-use-helper'

type DictationPhase = 'absent' | 'downloading' | 'loading' | 'ready' | 'error'

interface DictationEvent {
  state?: string
  text?: string
  seq?: number
  ready?: boolean
  phase?: DictationPhase
  progress?: number
  error?: string
  retryable?: boolean
  need?: 'inputMonitoring' | 'microphone'
  granted?: boolean
  fnUsage?: number
}

const MODEL_DIR = join(homedir(), 'Library', 'Application Support', 'FluidAudio', 'Models', 'parakeet-tdt-0.6b-v3-coreml')
const TWO_GB = 2 * 1024 * 1024 * 1024

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function exec(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })))
}

function macMajor(): number {
  try {
    return Number.parseInt(process.getSystemVersion().split('.')[0] || '0', 10)
  } catch {
    return 0
  }
}

function hasModel(): boolean {
  try {
    return existsSync(MODEL_DIR) && readdirSync(MODEL_DIR).length > 0
  } catch {
    return false
  }
}

function freeBytesForModelDir(): number | null {
  try {
    const stats = statfsSync(join(homedir(), 'Library'))
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

function notify(title: string, body: string, onAction?: () => void, actionLabel?: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title,
    body,
    silent: false,
    actions: actionLabel ? [{ type: 'button', text: actionLabel }] : undefined
  })
  if (onAction) {
    n.on('action', onAction)
    n.on('click', onAction)
  }
  n.show()
}

function fnUsageName(fnUsage: number): string {
  if (fnUsage === 1) return 'Change Input Source'
  if (fnUsage === 2) return 'Show Emoji and Symbols'
  if (fnUsage === 3) return 'Start Dictation'
  return `system action ${fnUsage}`
}

function graphemeChunks(text: string, maxClusters = 60): string[] {
  const anyIntl = Intl as typeof Intl & { Segmenter?: new (locale?: string, opts?: { granularity: 'grapheme' }) => { segment(input: string): Iterable<{ segment: string }> } }
  const clusters = anyIntl.Segmenter
    ? Array.from(new anyIntl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment)
    : Array.from(text)
  const chunks: string[] = []
  for (let i = 0; i < clusters.length; i += maxClusters) chunks.push(clusters.slice(i, i + maxClusters).join(''))
  return chunks
}

export async function insertDictatedText(raw: string): Promise<void> {
  const text = String(raw || '').trim()
  if (!text) return
  let failed = false
  for (const chunk of graphemeChunks(text)) {
    try {
      const r = await computerUseHelper().call('cg_type', { text: chunk }, 8000)
      if (r.error) {
        failed = true
        break
      }
    } catch {
      failed = true
      break
    }
    await sleep(12)
  }
  if (failed) {
    clipboard.writeText(text)
    notify('Could not type into this field', 'Transcript copied. Press Cmd-V to paste.')
  }
}

class DictationHelper {
  private readonly helper = new HelperProcess({
    bundleName: 'BlitzDictation.app',
    installDirName: 'dictation-helper',
    envOverride: 'BLITZ_DICTATION_APP',
    logPrefix: 'dictation',
    socketPrefix: 'blitzdict',
    helloTimeoutMs: 8000
  })
  private unsupportedLogged = false
  private acquireOptOut = false
  private lastModelNotice = ''

  onEvent(fn: ((m: Record<string, unknown>) => void) | null): void {
    this.helper.onEvent(fn)
  }

  call(cmd: string, args: Record<string, unknown> = {}, ms = 10000): Promise<Record<string, unknown>> {
    return this.helper.call(cmd, args, ms)
  }

  async ensure(): Promise<HelperEnsureResult> {
    if (process.platform !== 'darwin') return { ok: false, reason: 'macOS only' }
    if (macMajor() < 15) {
      if (!this.unsupportedLogged) {
        this.unsupportedLogged = true
        console.error('[dictation] disabled: requires macOS 15')
      }
      return { ok: false, reason: 'requires macOS 15' }
    }
    if (!this.helper.available()) return { ok: false, reason: 'helper bundle not found' }
    return this.helper.ensure()
  }

  async maybeAcquireModel(): Promise<void> {
    if (process.env.BLITZ_DICTATION_NO_AUTODOWNLOAD === '1' || this.acquireOptOut || hasModel()) return
    const free = freeBytesForModelDir()
    if (free != null && free < TWO_GB) {
      notify('BlitzOS Dictation needs more disk space', 'Free at least 2 GB to download the speech model.')
      return
    }
    notify(
      'BlitzOS Dictation is downloading a speech model',
      'The model is about 600 MB. Dictation will be ready when it finishes.',
      () => {
        this.acquireOptOut = true
      },
      'Cancel'
    )
    await sleep(1200)
    if (this.acquireOptOut) return
    void this.helper.call('prepare_model', {}, 600_000)
  }

  shutdown(): void {
    this.helper.shutdown()
  }

  updateModelNotification(ev: DictationEvent): void {
    const phase = ev.phase || 'absent'
    let key: string = phase
    let title = 'BlitzOS Dictation'
    let body = ''
    let action: (() => void) | undefined
    let actionLabel: string | undefined
    if (phase === 'downloading') {
      const pct = typeof ev.progress === 'number' ? Math.max(0, Math.min(100, Math.round(ev.progress * 100))) : 0
      key = `${phase}:${Math.floor(pct / 10)}`
      title = 'Downloading BlitzOS Dictation model'
      body = pct > 0 ? `${pct}% complete.` : 'Preparing download.'
    } else if (phase === 'loading') {
      body = 'Loading speech model.'
    } else if (phase === 'ready') {
      body = 'Speech model ready.'
    } else if (phase === 'error') {
      title = 'BlitzOS Dictation model error'
      body = ev.error ? `Could not prepare the speech model: ${ev.error}.` : 'Could not prepare the speech model.'
      if (ev.retryable !== false) {
        action = () => void this.helper.call('prepare_model', { force: true }, 600_000)
        actionLabel = 'Retry'
      }
    } else {
      body = 'Speech model not installed.'
    }
    if (key === this.lastModelNotice && phase !== 'error') return
    this.lastModelNotice = key
    notify(title, body, action, actionLabel)
  }
}

let manager: DictationHelper | null = null
export function dictationHelper(): DictationHelper {
  if (!manager) manager = new DictationHelper()
  return manager
}

export async function reconcileFnConflict(fnUsage: number): Promise<void> {
  const actionName = fnUsageName(fnUsage)
  const detail = fnUsage === 3
    ? 'The fn key is assigned to Start Dictation, which can compete for the same microphone.'
    : `The fn key is assigned to ${actionName}.`
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'fn key is assigned to a system action',
    message: 'fn key is assigned to a system action',
    detail: `${detail} BlitzOS Dictation works best when fn is set to Do Nothing.`,
    buttons: ['Open Keyboard Settings', 'Set fn to Do Nothing', 'Keep as-is'],
    defaultId: 0,
    cancelId: 2
  })
  if (result.response === 0) {
    void shell.openExternal('x-apple.systempreferences:com.apple.Keyboard-Settings.extension')
  } else if (result.response === 1) {
    const r = await exec('/usr/bin/defaults', ['write', '-g', 'AppleFnUsageType', '-int', '0'])
    if (r.ok) notify('fn key set to Do Nothing', 'You may need to sign out and back in before the change takes effect.')
  }
}

let conflictShownFor: number | null = null
export async function handleDictationEvent(message: Record<string, unknown>): Promise<void> {
  if (message.kind && message.kind !== 'dictation') return
  const ev = message as DictationEvent
  if (ev.state === 'partial') {
    osBroadcast({ type: 'dictation', phase: 'partial', text: ev.text || '' })
  } else if (ev.state === 'final') {
    const text = ev.text || ''
    await insertDictatedText(text)
    osBroadcast({ type: 'dictation', phase: 'final', text })
  } else if (ev.state === 'idle') {
    osBroadcast({ type: 'dictation', phase: 'idle' })
  } else if (ev.state === 'model') {
    dictationHelper().updateModelNotification(ev)
  } else if (ev.state === 'perm') {
    if (ev.need === 'inputMonitoring') {
      notify('Hold fn to dictate', 'Enable Input Monitoring for BlitzOS Dictation.', () => {
        void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent')
      })
    } else if (ev.need === 'microphone') {
      notify('BlitzOS Dictation needs Microphone access', 'Open System Settings to enable the microphone.', () => {
        void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
      })
    }
  } else if (ev.state === 'conflict' && typeof ev.fnUsage === 'number' && ev.fnUsage !== conflictShownFor) {
    conflictShownFor = ev.fnUsage
    await reconcileFnConflict(ev.fnUsage)
  }
}
