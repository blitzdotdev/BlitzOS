import { spawn } from 'child_process'
import type { BlitzMoment } from '../events'

// The reasoner turns a perception "moment" into a one-line observation. In P1 the
// loop is OBSERVE-ONLY, so a reasoner is given TEXT IN / TEXT OUT and NO tools — it
// physically cannot act on the desktop. (The act tier is gated behind P2/P3.)

export interface Observation {
  seq: number
  ts: number
  surfaceId: string
  url?: string
  title?: string
  summary: string
  significant: boolean
  reasoned: boolean // true when an LLM enriched the deterministic baseline
}

/** Zero-cost deterministic summary of a moment (no LLM) — the baseline observation. */
export function summarize(m: BlitzMoment): Observation {
  const acts =
    m.user && m.user.length
      ? m.user.join('; ')
      : Object.entries(m.signals || {})
          .map(([k, n]) => `${k}×${n}`)
          .join(', ')
  const where = m.title || m.url || m.surfaceId
  // nav / idle-after-activity / a UI action are the "good moment to react" transitions.
  const significant = m.trigger === 'nav' || m.trigger === 'idle' || m.trigger === 'action'
  return {
    seq: m.seq,
    ts: m.ts,
    surfaceId: m.surfaceId,
    url: m.url,
    title: m.title,
    summary: `[${m.trigger}] ${where}: ${acts || 'activity'}`,
    significant,
    reasoned: false
  }
}

export interface Reasoner {
  /** Enrich a (significant) moment into a one-line observation. Text-in / text-out;
   *  the reasoner has NO tools, so the observe loop cannot mutate anything through it. */
  summarize(m: BlitzMoment): Promise<string>
}

/**
 * A reasoner backed by a headless `claude -p` child — uses the user's existing Claude
 * Code auth (no API key in BlitzOS) and is given NO tools, so it can only describe.
 * This is ONE option for "where the brain runs" (architecture §7, still open); it is
 * opt-in via BLITZ_BRAIN=claude and never the default.
 */
export function claudeReasoner(): Reasoner {
  return {
    summarize(m: BlitzMoment): Promise<string> {
      const moment = {
        trigger: m.trigger,
        url: m.url,
        title: m.title,
        user: m.user,
        signals: m.signals,
        snapshot: (m.snapshot || '').slice(0, 800)
      }
      const prompt =
        'You are the perception layer of an agent OS, OBSERVING ONLY — you have no tools and must take no action. ' +
        'In ONE short sentence, say what the user appears to be doing and whether it likely needs help. ' +
        'Moment JSON:\n' +
        JSON.stringify(moment)
      return new Promise((resolve, reject) => {
        const child = spawn('claude', ['-p', prompt], { stdio: ['ignore', 'pipe', 'ignore'] })
        let out = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('reasoner timeout'))
        }, 30000)
        child.stdout.on('data', (d) => {
          out += d
        })
        child.on('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
        child.on('close', () => {
          clearTimeout(timer)
          const text = out.trim()
          text ? resolve(text.replace(/\s+/g, ' ').slice(0, 400)) : reject(new Error('empty reasoner output'))
        })
      })
    }
  }
}
