// agent-narrator.mjs — the background "narrator". Every ~60s, per active agent, it reads the NEW canonical
// transcript activity since the last milestone and summarizes it into ONE plain past-tense line via Haiku (strict
// JSON, char-capped). This is the non-technical "what it did" timeline: human steps, not tool rows. Rules:
//   - idle agents make NO call (no new tool activity since last tick → free),
//   - the line is bounded (<=80 chars) and de-duped against the previous one,
//   - milestones are broadcast live (os:action {type:'milestone'}) + kept in memory per session (the island reads
//     them via the agents snapshot for continuity within a run).
// The model call shells out to `claude -p ... --json-schema ... --model haiku` so it uses the user's existing
// auth (no API key), mirroring the blitzscript harness pattern. All failures are swallowed (best-effort UI).
import { spawn } from 'node:child_process'
import { readSessionEvents, sessionJsonlPath, digestForNarrator } from './agent-transcript.mjs'

const MILESTONE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['milestone', 'skip'],
  properties: {
    milestone: {
      type: 'string',
      maxLength: 38,
      description: 'ONE terse "now playing" title: 2 to 5 words, AT MOST 36 characters, past tense, plain words, no "Agent" prefix, no trailing period, no tool names or file paths'
    },
    skip: { type: 'boolean', description: 'true if the actions are pure noise / no real progress worth showing' }
  }
}

const SYS =
  "You narrate an AI agent's work for a NON-TECHNICAL user as SHORT now-playing titles (like song titles). Given " +
  'the agent\'s latest raw actions, output ONE terse title: 2 to 5 words, AT MOST 36 characters — it must fit on ' +
  'ONE short line. Past tense, plain everyday words. Do NOT start with "Agent", do NOT write a sentence, no ' +
  'trailing period, no tool names or file paths. If the actions are just noise or no real progress, set skip=true. ' +
  'Good: "Reading your docs", "Drafted the email", "Found the failing test", "Analyzing the design".'

// Spawn `claude -p` in print mode with a JSON schema → the validated object lands in `structured_output`.
function callHaiku(prompt, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    let child
    try {
      child = spawn(
        'claude',
        ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(MILESTONE_SCHEMA), '--model', 'haiku', '--dangerously-skip-permissions'],
        { cwd: cwd || undefined, stdio: ['ignore', 'pipe', 'ignore'] }
      )
    } catch {
      return finish(null)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish(null)
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const whole = JSON.parse(out)
        const so = whole.structured_output || (typeof whole.result === 'string' ? safeParse(whole.result) : null)
        finish(so && typeof so.milestone === 'string' ? so : null)
      } catch {
        finish(null)
      }
    })
  })
}
function safeParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * Start the narrator loop.
 * @param {{ listAgents:()=>string[], wsRoot:()=>(string|null), claudeSidFor:(id:string)=>(string|null),
 *           broadcast:(ev:object)=>void, intervalMs?:number }} deps
 */
export function startNarrator(deps) {
  const { listAgents, wsRoot, claudeSidFor, broadcast, intervalMs = 60000 } = deps
  const state = new Map() // agentId -> { offset, lastMilestone, milestones:[] }
  let busy = false

  function st(id) {
    let s = state.get(id)
    if (!s) {
      s = { offset: 0, lastMilestone: '', milestones: [] }
      state.set(id, s)
    }
    return s
  }

  async function summarizeOne(id) {
    const root = wsRoot()
    const sid = claudeSidFor(id)
    const jsonl = sessionJsonlPath(root, sid)
    if (!jsonl) return
    const s = st(id)
    const { events, offset } = readSessionEvents(jsonl, s.offset)
    const advanced = offset !== s.offset
    s.offset = offset
    if (!advanced) return // nothing new since last tick → free
    const tools = events.filter((e) => e.kind === 'tool')
    if (tools.length === 0) return // only results/text churn → not a step worth a call
    const digest = digestForNarrator(events)
    if (!digest.trim()) return
    const prompt = `${SYS}\n\nThe agent's latest actions:\n${digest}\n\nPrevious step shown: ${s.lastMilestone || '(none)'}\n\nReturn JSON {"milestone","skip"}.`
    const res = await callHaiku(prompt, root)
    if (!res || res.skip) return
    // Backstop the model: strip a stray "Agent " prefix + trailing period/ellipsis, cap length (keep it a short title).
    const text = String(res.milestone || '')
      .trim()
      .replace(/^agent\s+/i, '')
      .replace(/[.…]+$/, '')
      .slice(0, 40)
    if (!text || text === s.lastMilestone) return
    s.lastMilestone = text
    const m = { id: `m${Date.now()}-${id}`, ts: Date.now(), kind: 'step', text }
    s.milestones.push(m)
    if (s.milestones.length > 60) s.milestones.shift()
    try {
      broadcast({ type: 'milestone', agentId: String(id), ...m })
    } catch {
      /* renderer not ready */
    }
  }

  async function tick() {
    if (busy) return
    busy = true
    try {
      const ids = (listAgents() || []).map(String).filter(Boolean)
      for (const id of ids) {
        try {
          await summarizeOne(id)
        } catch {
          /* per-agent best-effort */
        }
      }
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => {
    tick().catch(() => {})
  }, Math.max(15000, intervalMs))
  if (timer.unref) timer.unref()

  return {
    stop() {
      try {
        clearInterval(timer)
      } catch {
        /* already stopped */
      }
    },
    /** The in-memory milestone list for one session (newest last). */
    milestones(id) {
      return (state.get(String(id))?.milestones || []).slice()
    },
    tickNow: tick
  }
}
