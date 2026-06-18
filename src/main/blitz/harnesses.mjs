// blitzscript leaf harnesses — the pluggable registry behind llm().
//
// Each harness turns an llm() call into a real headless coding-agent process on THIS machine
// (the user's own auth/subscription, cwd = the workspace), captures its stdout, and parses the
// final assistant text back out. This is the RLM "cheap leaf" — a full local agent, not a bare
// completion. See plans/blitzos-blitzscript.md ("llm() = a local claude -p / codex exec").
//
// A harness is: { build(prompt, opts) -> { cmd, args, env }, parse(stdout) -> text }.
//   build()  — produces the spawn descriptor (binary + argv + extra env). NEVER a shell string,
//              so the prompt and flags can't be re-split/injected by the shell.
//   parse()  — extracts the harness's FINAL assistant message from its captured stdout.
//
// Flags below were confirmed against the real CLIs on this machine (2026-06-17):
//   `claude --help`, `claude -p --help`, `codex exec --help`, plus tiny real runs to see the
//   exact stdout JSON shape. They also match the repo's own codex invocation in
//   src/main/agent-runtime.mjs (buildCodexServerlessCommand).
//
// To add a harness: implement build()/parse() and register it here. 'pi' and 'opencode' are
// STUBBED as the obvious extension points (see the // TODO entries at the bottom).

// claude's --effort accepts these levels (confirmed via `claude -p --help`). We pass the agent's
// opts.effort straight through after validating it against this set.
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export const harnesses = {
  // ── claude: `claude -p <prompt> --output-format json [--model …] [--effort …]` ──────────────
  // print mode (-p) makes the run non-interactive and lands the final text on stdout. We use
  // --output-format json (a SINGLE result object) because its `.result` field is the clean final
  // assistant text — far more robust than scraping plain-text stdout. --dangerously-skip-permissions
  // so a leaf that legitimately needs a tool (read a file, run a command) is not blocked mid-run.
  claude: {
    build(prompt, opts = {}) {
      const args = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions']
      // opts.model -> --model (an alias like 'opus'/'sonnet'/'haiku' or a full model name).
      if (opts.model) args.push('--model', String(opts.model))
      // opts.effort -> --effort (low|medium|high|xhigh|max). Validate so a typo fails loudly here
      // rather than the child rejecting it after a slow startup.
      if (opts.effort != null) {
        const eff = String(opts.effort)
        if (!CLAUDE_EFFORTS.has(eff)) {
          throw new Error(`blitz llm: invalid claude effort ${JSON.stringify(eff)} (expected one of ${[...CLAUDE_EFFORTS].join('|')})`)
        }
        args.push('--effort', eff)
      }
      return { cmd: 'claude', args, env: {} }
    },
    // --output-format json prints exactly one JSON object whose `.result` is the final text.
    // If a leaf streamed extra lines, take the LAST parseable JSON line that carries a result.
    parse(stdout) {
      const text = String(stdout ?? '')
      // Fast path: the whole stdout is the single result object.
      const whole = tryJson(text.trim())
      if (whole && typeof whole.result === 'string') return whole.result
      // Fallback: scan lines bottom-up for the last object with a string `result`.
      const lines = text.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const obj = tryJson(lines[i].trim())
        if (obj && typeof obj.result === 'string') return obj.result
      }
      // Last resort: return the raw stdout trimmed (better than throwing on an unexpected shape).
      return text.trim()
    },
  },

  // ── codex: `codex exec <prompt> -c model=… -c model_reasoning_effort=… --json …` ─────────────
  // `codex exec` runs one non-interactive turn and prints the agent output to stdout. Plain stdout
  // is noisy (status/reasoning lines), so we use --json (JSONL events) and pull the final
  // agent_message text. --dangerously-bypass-approvals-and-sandbox + --skip-git-repo-check match
  // the repo's existing serverless codex path and let a leaf actually do work without prompting.
  codex: {
    build(prompt, opts = {}) {
      const args = ['exec', prompt, '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
      // codex overrides go through `-c key=<TOML value>`; strings must be quoted in the value.
      if (opts.model) args.push('-c', `model=${tomlString(String(opts.model))}`)
      if (opts.effort != null) args.push('-c', `model_reasoning_effort=${tomlString(String(opts.effort))}`)
      return { cmd: 'codex', args, env: {} }
    },
    // --json emits JSONL. The final assistant text is the last `agent_message` event. Confirmed shape:
    //   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
    // Older/alternate builds emit a flatter {"type":"agent_message","message":"…"}; handle both.
    parse(stdout) {
      const lines = String(stdout ?? '').split('\n')
      let last = null
      for (const line of lines) {
        const ev = tryJson(line.trim())
        if (!ev) continue
        // Preferred: item.completed wrapping an agent_message item.
        if (ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') {
          last = ev.item.text
          continue
        }
        // Alternate flat shapes seen across codex versions.
        if (ev.type === 'agent_message') {
          if (typeof ev.text === 'string') last = ev.text
          else if (typeof ev.message === 'string') last = ev.message
        }
      }
      // Fallback to raw stdout if no structured agent_message was found (keeps the call non-fatal).
      return last != null ? last : String(stdout ?? '').trim()
    },
  },

  // ── extension points ────────────────────────────────────────────────────────────────────────
  // TODO(blitz): implement 'pi' once its non-interactive CLI + final-text extraction are confirmed.
  pi: {
    build() { throw new Error("blitz llm: harness 'pi' is not implemented yet (stub)") },
    parse(stdout) { return String(stdout ?? '').trim() },
  },
  // TODO(blitz): implement 'opencode' (e.g. `opencode run <prompt>`) once its flags + output shape
  // are confirmed against the real CLI, then map opts.model/opts.effort and parse the final text.
  opencode: {
    build() { throw new Error("blitz llm: harness 'opencode' is not implemented yet (stub)") },
    parse(stdout) { return String(stdout ?? '').trim() },
  },
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
function tryJson(s) {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

// Quote a string as a TOML scalar for `-c key=value`. codex parses the value as TOML and falls
// back to a literal on failure; an explicitly quoted string is unambiguous and escapes safely.
function tomlString(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}
