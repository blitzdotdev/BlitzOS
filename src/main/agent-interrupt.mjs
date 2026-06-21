// agent-interrupt.mjs — "was this agent cut off mid-turn (resume it) or did it finish cleanly (leave it)?"
//
// The turn boundary lives INSIDE the backend (the model decides when to yield) and BlitzOS's wait loop is
// background + decoupled from it, so there is NO protocol-level signal BlitzOS can read. Each backend therefore
// reads its OWN signal. This is a plain switch, not a registry/class hierarchy: add a backend = add a case.
// Used on boot (the boot-task provider) to give ONLY interrupted agents a "continue your unfinished task" clause,
// so a restart auto-resumes mid-task agents without a nudge while leaving cleanly-idle ones (e.g. a chat agent
// waiting for the user) untouched.
import { sessionJsonlPath, lastAssistantStopReason } from './agent-transcript.mjs'

// Claude stop_reasons that mean the agent CHOSE to end its turn (finished + yielded). Anything else
// (tool_use, max_tokens, a truncated/missing reason) means it was mid-turn when the process was cut off.
const CLEAN_STOPS = new Set(['end_turn', 'stop_sequence'])

/**
 * @param {{ agentRuntime?: string, claudeSessionId?: string, status?: string, exitCode?: number }} meta
 *   the agent's terminal meta (readTerminalMeta) — carries the backend + the per-backend signal fields.
 * @param {{ wsRoot?: string|null }} [ctx]  per-call context the readers need (Claude needs the workspace root).
 * @returns {boolean|null}  true = interrupted mid-turn (resume), false = finished cleanly (leave),
 *   null = unknown / not a managed agent (caller treats as "leave it" — never auto-continue blind).
 */
export function wasInterrupted(meta, ctx = {}) {
  const backend = (meta && (meta.agentRuntime || (meta.claudeSessionId ? 'claude' : null))) || null
  switch (backend) {
    case 'claude':
      return claudeInterrupted(meta, ctx)
    case 'codex-serverless':
      return codexInterrupted(meta)
    default:
      return null // unknown backend / not a managed agent → don't auto-continue
  }
}

// CLAUDE (resident process): the turn boundary is the model's stop_reason, recorded per assistant message in the
// session JSONL. The LAST assistant message ending on end_turn/stop_sequence = it finished and yielded; anything
// else = it was mid-turn. Reads the JSONL directly, so it works for both survivors and exited claude agents.
function claudeInterrupted(meta, ctx) {
  const jsonl = sessionJsonlPath(ctx.wsRoot, meta.claudeSessionId)
  const sr = jsonl ? lastAssistantStopReason(jsonl) : null
  if (sr == null) return false // never ran / no assistant turn yet → nothing to resume
  return !CLEAN_STOPS.has(sr)
}

// CODEX serverless (`codex exec`, one-shot, BlitzOS re-execs it per message): the turn boundary IS the PROCESS
// EXIT. A clean exit (code 0) = the task finished; a non-zero exit or a kill = cut off mid-task. A still-running
// survivor is left to the normal boot re-exec (don't kill a live run). NOTE: codex exec is not mid-run resumable,
// so "continue" for it means re-run from the bootstrap — a fidelity gap to revisit when codex is the live backend.
function codexInterrupted(meta) {
  return meta.status === 'exited' && meta.exitCode !== 0
}
