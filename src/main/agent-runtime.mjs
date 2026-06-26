// agent-runtime.mjs — the SHARED core that turns a workspace terminal into a BlitzOS agent.
//
// There is no privileged headless "brain" anymore: an agent is just a tmux terminal (owned by
// terminal-manager.mjs) whose command runs a pluggable backend pointed at the agent-socket relay. The
// backend survives BlitzOS restarts through tmux supervision and /says clean replies into its chat widget
// over the unchanged agent-socket contract. This module owns the only agent-specific bits:
//   • the bootstrap prompt (the served blitzos-agents.md is the source of truth; this is a thin pointer),
//   • backend-specific command strings (Claude TUI vs Codex serverless), and
//   • backend metadata such as Claude's persisted --session-id token.
// Both transports (Electron + server) import THIS one file — no per-transport fork.
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatFileName, relocateLegacyChats } from './workspace.mjs'

// ── blitzscript runtime paths + the orchestrators-toggle assets ─────────────────────────────────
// Absolute paths to the blitzscript runtime, from THIS module's location. In dev these are real repo files
// the agent's `node` runs/imports. PACKAGING TODO: asarUnpack src/main/blitzscript so a packaged build's
// system node can reach them too.
// BUNDLED-ELECTRON FIX: when main is bundled to out/main/, the sibling out/main/blitzscript/run.mjs does NOT
// exist (electron-vite flattens + hashes chunks), so the agent's `.blitzos/blitz` shim pointed at a missing
// file and `blitz check`/`run` failed. run.mjs is plain Node, so fall back to the real SOURCE run.mjs
// (src/main/blitzscript/run.mjs) when the bundled sibling is absent. The server transport runs unbundled from
// src/main, so its first resolution already hits the real file (no remap).
const BLITZ_RUN = (() => {
  const here = fileURLToPath(new URL('./blitzscript/run.mjs', import.meta.url))
  if (existsSync(here)) return here
  const src = here.replace('/out/main/', '/src/main/')
  return existsSync(src) ? src : here
})()
const ORCHESTRATOR_DUTY_SRC = fileURLToPath(new URL('./blitzos-orchestrator.md', import.meta.url))

/** Write `<blitzDir>/blitz` (the agent's runner shim -> `node <run.mjs> "$@"`) + copy the orchestrator duty
 *  doc to `<blitzDir>/orchestrator.md`. Static; written at every launch like wait.sh so it's always present. */
export function writeBlitzShim(blitzDir) {
  if (!blitzDir) return
  try {
    mkdirSync(blitzDir, { recursive: true })
    const shimPath = join(blitzDir, 'blitz')
    writeFileSync(shimPath, `#!/bin/sh\nexec node ${JSON.stringify(BLITZ_RUN)} "$@"\n`)
    try { chmodSync(shimPath, 0o755) } catch { /* best-effort */ }
    if (existsSync(ORCHESTRATOR_DUTY_SRC)) writeFileSync(join(blitzDir, 'orchestrator.md'), readFileSync(ORCHESTRATOR_DUTY_SRC, 'utf8'))
  } catch { /* best-effort */ }
}

/** The orchestrators-toggle boot-task duty (returned by the provider for an orchestrator agent). A short
 *  pointer; the full how-to is the copied `.blitzos/orchestrator.md`. */
export function orchestratorBootTask() {
  return `ORCHESTRATOR MODE (you author + run workflows, Claude Code workflow style). For a task that is genuinely hard, large, massively parallel, adversarial, or over-context-window, AUTHOR and RUN a workflow instead of doing it all inline; for trivial / one-shot requests just answer directly. Read \`.blitzos/orchestrator.md\` for the full how-to. The runner is \`.blitzos/blitz\`: run \`bash .blitzos/blitz capabilities\` FIRST (your harness/model/effort options), then author a workflow.js the SAME way you would a Claude Code workflow — start with \`export const meta = { name, description }\`, use the INJECTED GLOBALS (NO imports) \`agent(prompt, opts?, fallback?)\` (spawns a sub-agent leaf; with \`opts.schema\` it returns the validated object, else its text), \`parallel\`, \`pipeline\`, \`phase\`, \`log\`, plus \`args\`/\`budget\`/\`workflow()\`, and END the file with \`return <result>\`. Do mechanical work in code; let the agent leaves do file/tool work. Run \`bash .blitzos/blitz check <workflow.js>\` until it PASSes, then RUN IT WITH THE \`run_workflow\` SYSCALL (\`run_workflow { file }\`) — NOT \`bash .blitzos/blitz run\` and NOT your own built-in Workflow tool; ONLY \`run_workflow\` is visible to BlitzOS (it tracks + manages the run and captures every leaf to disk); the other two run invisibly, so BlitzOS can't see or recover them. An in-chat kanban board now appears automatically while a \`run_workflow\` runs (you do not summon or control it; it is durable and survives island reopen / app relaunch); still narrate progress with \`say\` — do not rely on the board alone. \`run_workflow\` works for every agent (no 403). Stay within the act-vs-ask boundary (reversible work freely; ask before any irreversible outward act) and narrate progress with say.`
}

const sessionDir = (sessionsDir, id) => join(sessionsDir, String(id))
const metaPath = (sessionsDir, id) => join(sessionDir(sessionsDir, id), 'meta.json')
const bootstrapPath = (sessionsDir, id) => join(sessionDir(sessionsDir, id), 'bootstrap.txt')
// Reasoning effort for the resident agent. Claude agents run XHIGH so they follow the act/ask boundary
// precisely and make better autonomous calls, keeping the USER's own model. Tunable here. (Earlier
// "always low" pinned the resident low too, which made it over-ask on reversible work.)
export const RESIDENT_EFFORT = 'xhigh'
export const AGENT_RUNTIME_CLAUDE = 'claude'
export const AGENT_RUNTIME_CODEX_SERVERLESS = 'codex-serverless'
// Claude Code is the default backend (codex-serverless stays selectable via BLITZ_AGENT_BACKEND). The
// server transport (preview/backend.mjs) already defaults to Claude; this aligns the Electron desktop.
export const DEFAULT_AGENT_RUNTIME = AGENT_RUNTIME_CLAUDE
function readMeta(sessionsDir, id) { try { return JSON.parse(readFileSync(metaPath(sessionsDir, id), 'utf8')) } catch { return {} } }

export function normalizeAgentRuntime(value) {
  const v = String(value || '').trim().toLowerCase()
  if (!v) return DEFAULT_AGENT_RUNTIME
  if (v === 'codex' || v === 'codex-exec' || v === 'codex-serverless' || v === 'serverless') return AGENT_RUNTIME_CODEX_SERVERLESS
  if (v === 'claude' || v === 'claude-code' || v === 'claude-tui' || v === '1') return AGENT_RUNTIME_CLAUDE
  return v
}

// The agent's agent-socket BASE url is VOLATILE — the relay mints a fresh one on every BlitzOS (re)start, so
// a long-lived terminal can't bake it in. BlitzOS keeps the current base in this file (relative to the agent's
// cwd=workspace) + updates it on every change; the agent INLINES `$(cat <this>)` into every curl, so the shell
// re-reads the live url on each call and a reattached agent self-heals after a restart. Single source of truth.
export const RELAY_URL_FILE = '.blitzos/relay-url'

// Optional per-session STANDING DUTY (e.g. onboarding interview, then resident initiatives): a
// policy-free seam. The transport registers a provider, and prepareAgentLaunch re-reads it on EVERY
// (re)launch (bootstrap.txt is rewritten), so the duty can change as workspace state changes. The duty
// TEXT is owned by whoever set it.
let bootTaskProvider = null
export function setBootTaskProvider(fn) {
  bootTaskProvider = typeof fn === 'function' ? fn : null
}

// Optional user-set STANDING CUSTOM INSTRUCTIONS, injected into EVERY session's first message (both
// backends) wrapped in <user-instructions> tags. Same DI seam as the boot task: the transport registers a
// provider that reads the persisted text, and prepareAgentLaunch re-reads it on EVERY (re)launch, so editing
// the instructions in Settings updates all new/restarted sessions with no rebuild. The TEXT is the user's.
let userInstructionsProvider = null
export function setUserInstructionsProvider(fn) {
  userInstructionsProvider = typeof fn === 'function' ? fn : null
}

/** The agent's BOOTSTRAP prompt (written to a file and passed to the selected agent backend). The served manual
 *  (blitzos-agents.md) is the SINGLE source of truth for identity, the /events loop, every tool, window
 *  management, and the design language — this stays a thin pointer and does NOT restate behavior. Multi-line
 *  is fine: it lives in a file, so it never touches the tmux control-mode command line (which rejects LF). */
export function buildBootstrap(_url, sessionId = '0', bootTask = null, workspace = null, userInstructions = null, resume = false) {
  const primary = !sessionId || String(sessionId) === '0'
  // The agent's OWN private transcript path (relative to its cwd = the workspace). ISOLATION: every agent's
  // chat now lives under .blitzos/agents/<id>/ so no sibling chat is visible in the root (see chatFileName).
  const chatFile = chatFileName(sessionId)
  // v2 bleed fix: an agent is PINNED to its workspace — every /events + /say carries it, so a
  // background workspace's agent never sees (or answers into) another workspace's chat.
  const wsPin = workspace ? `,"workspace":"${String(workspace).replace(/"/g, '')}"` : ''
  const sess = (primary ? '' : `,"agent":"${sessionId}"`) + wsPin // non-primary agents MUST scope /events + /say to their agent id
  const B = '"$(cat ' + RELAY_URL_FILE + ')"' // every URL is built fresh from the file on each curl
  const identity = primary
    ? 'You are the primary chat agent of BlitzOS, an agent OS the user watches live. BlitzOS makes NO decisions; YOU decide everything.'
    : `You are a Blitz agent — one of several independent agents in BlitzOS (an agent OS). You serve ONLY your own chat; other agents have their own chats. Refer to yourself as a Blitz agent, never by a number.`
  const relay = `BlitzOS runs locally on this Mac and gives you a small local HTTP API to talk to it. It tells you its current address in the file ${RELAY_URL_FILE} in your working folder, and that address can change when the app restarts, so read it from the file each time rather than remembering it: \`curl -sX POST ${B}/<tool> -H 'content-type: application/json' -d '{…}'\`. The \`$(cat …)\` just reads the app's current address. If a call ever returns a connection error or 404, the app most likely restarted with a new address; reading the file again and retrying picks it up.`
  const guide = bootTask
    ? `Your full operating guide is at ${B}/agents.md, with the complete tool set. You do NOT need it for the first step of your standing duty below, so do that FIRST and fetch the guide (\`curl -s ${B}/agents.md\`) only afterward, when you need a tool the duty did not give you. Do not let reading the guide delay your first action.`
    : `Your full operating guide is at ${B}/agents.md. Please read it first (\`curl -s ${B}/agents.md\`) and follow it; if that request doesn't succeed, give it another try before continuing.`
  const web = `Hard web rule: do web work in Blitz Chrome, your own background browser (open it with blitz_chrome_open, drive it with the connection_* tools). Use your backend's internal web-search/browser tool only as a discovery index to find candidate URLs or query angles; do not treat invisible snippets as final evidence. Before presenting findings, open every source you rely on in Blitz Chrome (connection_read / connection_act). For open-ended research, use multiple query angles when useful.`
  const progress = `Hard visible-work rule: for any non-trivial user task (multi-step, research/current info, build/customize, compare, troubleshoot, browse, organize, or longer than a quick direct answer), say a one-line plan in chat BEFORE doing hidden work, then say a short line as each step lands. Going dark during active work is a failure; saying "I'm working" once with nothing after it is too. Keep it tight: if a result needs more than a couple of lines, write it to a deliverable. Use share_app for generated blitz.dev apps, complex visuals, dashboards, reports, rich tables/charts, or anything the user should inspect/manipulate. Never paste an *.app.blitz.dev preview URL through say; call share_app first, then summarize without the URL. Use normal markdown for quick prose. Tiny one-shot answers/actions can stay direct.`
  // Read your OWN transcript to pick up the task / catch up. The "you may have been restarted, recover the
  // conversation" framing is the LURE that made a fresh agent go hunting and `cat` a sibling's chat.md (the
  // cross-agent leak) — so only a real RESUME gets it; a fresh spawn just reads its own file for the task.
  const recover = resume
    ? `You may have just been restarted, so catch up before acting: call \`list_state\` for \`workspace_path\`, then \`tail -n 60 "$workspace_path/${chatFile}"\` — your saved conversation (it persists across restarts; the live event feed does not). If its last line is a user message you haven't answered, answer it now.`
    : `Read your own conversation first: call \`list_state\` for \`workspace_path\`, then \`tail -n 60 "$workspace_path/${chatFile}"\`. If its last line is a user message you haven't answered, that is your task — answer it now.`
  // ISOLATION (defense in depth behind the structural relocation): only ever read your OWN chat file. Other
  // agents' conversations are private; reading one injects their task into your context and makes you act on
  // the wrong thing (the exact bug this closes).
  const isolation = `Your conversation with the user lives ONLY in \`${chatFile}\`. Other agents have their own separate, private conversations; never read another agent's chat or transcript — only ever read \`${chatFile}\`. Reading another agent's conversation pulls their task into yours and makes you do the wrong thing.`
  // The OS can hand a session ONE standing duty (e.g. the onboarding interview); the duty text licenses
  // unprompted action for its own scope and is re-read per (re)launch, so a finished duty disappears.
  const duty = bootTask ? `The app has given you one standing task to handle first, right after you've caught up on the conversation (it applies only to its own scope): ${bootTask}` : null
  // MERGE-RECONCILED (master wait.sh + branch const-fragment structure): the agent's event-wait is the
  // shared blocking helper `.blitzos/wait.sh` — one LLM turn per REAL message instead of one per empty 25s
  // poll. These three fragments describe wait.sh, NOT a raw /events poll loop (do not regress them to the
  // pre-wait.sh long-poll text the branch carried forward). wait.sh re-reads relay-url, so it survives a restart.
  const onConnect = `Your job is to help the user in their chat. ON CONNECT, read anything already waiting once: \`curl -sX POST ${B}/events -d '{"since":0,"wait":0${sess}}'\` — then use the returned \`latest\` as your cursor.`
  const waitLoop = `To see new messages, run \`bash .blitzos/wait.sh <cursor> '${sess}'\` AS A BACKGROUND task (set run_in_background:true on your Bash tool), NEVER as a blocking foreground call (a blocking call suspends you in a tool forever so you never yield). It returns a task id immediately and waits in the background, then RE-INVOKES you when a real message arrives, writing \`{"events":[…],"latest":N}\` to its task output. (Under the hood it long-polls \`/events\` and re-reads the relay url each loop, so it survives an app restart.)`
  const keepChecking = `After launching the background wait.sh, do NOT block on it: finish your turn (or continue any work already underway) and let it re-invoke you when a real message arrives. Running it in the BACKGROUND is REQUIRED so you yield between messages instead of hanging in a tool. On each re-invoke, read its task output, handle every \`trigger:'message'\` (do what it asks), set your cursor to the new \`latest\`, and launch wait.sh in the background AGAIN. Always keep exactly one background wait.sh running; it is the only way the app delivers messages to you.`
  const say = `Keep the user in the loop: send your replies and progress with \`curl -sX POST ${B}/say -d '{"text":"…"${sess}}'\` (it appears in their chat). When a message comes in, a quick note of your plan first is nice, then a short line as you go. It's best not to act unless the user has asked for something, and to say what you're doing as you do it rather than working silently.`
  const scope = primary
    ? null
    : `You are one of several Blitz agents; you serve ONLY your own chat thread. Include "agent":"${sessionId}" on your /events, /say, and open_terminal calls so they stay on your own thread and don't disturb the user or the other agents. That id is an internal routing handle, not your name; to the user you are just a Blitz agent.`
  // The user's standing custom instructions (set in BlitzOS Settings), wrapped in tags so the agent sees
  // exactly where they begin and end. Honored like a direct user request; it never overrides the safety /
  // act-vs-ask boundary rules above. Empty/whitespace → omitted entirely (byte-identical to before).
  const userBlock = typeof userInstructions === 'string' && userInstructions.trim()
    ? `The user has set standing custom instructions that apply to every session. Follow them as if the user asked you directly, unless they conflict with a rule above:\n<user-instructions>\n${userInstructions.trim()}\n</user-instructions>`
    : null
  return [identity, relay, guide, web, progress, recover, isolation, duty, onConnect, waitLoop, keepChecking, say, scope, userBlock].filter(Boolean).join('\n')
}

/** POSIX single-quote a value for a shell command line (wrap in '…', escape embedded ' as '\''). */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`
}

/** The claude argv command string run inside the tmux terminal. mode 'create' → --session-id (first run),
 *  'resume' → --resume (continue the SAME conversation). The bootstrap is the POSITIONAL prompt (read from a
 *  FILE via "$(cat …)" so the command stays single-line — tmux control mode forbids newlines).
 *  INTERACTIVE (no -p): claude renders its full TUI in the terminal so the user can WATCH it work — print
 *  mode (-p) ran silently, leaving the terminal blank. --dangerously-skip-permissions: the agent acts
 *  unattended; cwd=workspace is set by the spawner (REQUIRED for --resume to find the session). */
export function buildClaudeCommand({ cmd = 'claude', claudeSid, mode = 'create', bootstrapFile, effort = null, hooks = null }) {
  const sessionArg = mode === 'resume' ? `--resume ${claudeSid}` : `--session-id ${claudeSid}`
  // `effort` sets the reasoning level for THIS launch (RESIDENT_EFFORT 'xhigh' for the resident so it follows
  // the boundary and decides well). The real control is `--settings`, NOT --effort or env alone: Claude Code's
  // precedence is CLI args > project > USER (~/.claude/settings.json), so we pass both and override the user's
  // global either way, leaving the user's own MODEL untouched. Timing on a small prompt: xhigh ~7.9s,
  // --effort low ~3.9s, --settings low ~2.7s.
  // `hooks`: a GENERIC Claude Code `--settings` hooks object MERGED into the SAME --settings JSON (an extension
  // seam for any future hook). hooks=null (the default today) → byte-identical to before. The merge keeps the
  // effort logic intact; --settings is emitted when EITHER effort OR hooks is present.
  let tuned = ''
  const settings = effort ? { effortLevel: effort, env: { CLAUDE_CODE_EFFORT_LEVEL: effort } } : {}
  if (hooks && typeof hooks === 'object') Object.assign(settings, hooks) // hooks is a top-level settings key alongside effortLevel/env/model
  if (effort || (hooks && typeof hooks === 'object')) {
    const effortArg = effort ? `--effort ${effort} ` : ''
    tuned = `${effortArg}--settings ${shellQuote(JSON.stringify(settings))} `
  }
  // TODO(E1 irreversible gate — guardrails-doc Phase 2 "Irreversible gate", a SEPARATE decision, deliberately out of
  // this slice): for a real "ask before send/post/deploy/spend", drop `--dangerously-skip-permissions` to
  // `--permission-mode auto` + deny rules in the SAME --settings JSON (today the bypass defeats Auto mode, so the
  // act/ask boundary is the EXECUTE-duty prose only). Wire it the same way as hooks (a settings merge) once signed off.
  return `${cmd} ${sessionArg} ${tuned}--dangerously-skip-permissions "$(cat ${shellQuote(bootstrapFile)})"`
}

/** Codex serverless backend: one non-interactive `codex exec` turn that receives the same BlitzOS
 * bootstrap as Claude. Disable plugins and ignore Codex user config/rules so the app bootstrap is the
 * policy surface instead of inheriting this machine's personal Codex skills, hooks, or repo instructions.
 * Auth still uses CODEX_HOME. The terminal supervisor restarts it when it exits, so it behaves like a
 * resident agent without requiring a long-lived TUI or Anthropic account quota. */
export function buildCodexServerlessCommand({ cmd = 'codex', bootstrapFile, lowThinking = false }) {
  const effort = `-c ${shellQuote(`model_reasoning_effort="${lowThinking ? 'low' : 'medium'}"`)} `
  return `${cmd} exec ${effort}--disable plugins --ignore-user-config --ignore-rules --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --color never "$(cat ${shellQuote(bootstrapFile)})"`
}

export function buildAgentCommand({ runtime = AGENT_RUNTIME_CLAUDE, cmd, claudeSid, mode = 'create', bootstrapFile, effort = null, hooks = null }) {
  const r = normalizeAgentRuntime(runtime)
  // Codex only has the low cap (its reasoning effort lever is a single low/default), so map effort 'low' → it.
  // `hooks` is a Claude Code --settings feature; Codex has no equivalent, so it is dropped for the Codex backend.
  if (r === AGENT_RUNTIME_CODEX_SERVERLESS) return buildCodexServerlessCommand({ cmd: cmd || 'codex', bootstrapFile, lowThinking: effort === 'low' })
  return buildClaudeCommand({ cmd: cmd || 'claude', claudeSid, mode, bootstrapFile, effort, hooks })
}

/** Has claude ALREADY created this conversation on disk? claude writes `<configDir>/projects/<encoded-cwd>/
 *  <session-id>.jsonl` (encoded-cwd = the workspace path with every `/` and `.` turned into `-`; we don't
 *  relocate CLAUDE_CONFIG_DIR, so configDir defaults to ~/.claude). The session-id is a UUID, so a hit is
 *  unambiguous. A wrong/exotic encoding just misses → we safely fall back to the timing flag (no regression). */
function claudeConversationExists(sessionsDir, claudeSessionId) {
  if (!claudeSessionId) return false
  try {
    const wsPath = dirname(dirname(sessionsDir)) // <ws>/.blitzos/sessions → <ws> (claude's cwd)
    const cfgDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const encoded = wsPath.replace(/[/.]/g, '-')
    return existsSync(join(cfgDir, 'projects', encoded, `${claudeSessionId}.jsonl`))
  } catch { return false }
}

/** Read (or mint) this agent's persisted claude session-id + whether claude has ESTABLISHED it (so we
 *  --resume vs --session-id). Lives in the SAME meta.json the terminal-manager owns — no second file. The
 *  caller persists the id by passing it to spawnTerminal (which writes meta). established is true when the
 *  timing flag is set (terminal-manager sets claudeEstablished after ≥8s uptime / a ≥5s exit) OR — the
 *  deterministic backstop — when claude's conversation jsonl already exists on disk. The jsonl check closes
 *  the narrow gap where claude created the session but BlitzOS restarted (and the agent survived in tmux)
 *  before the establish timer fired: without it that re-exec would run `--session-id <existing>` → claude
 *  errors "already in use" → crash loop. We still never --resume an id claude never created (no jsonl, flag
 *  unset → create mode → 'No conversation found' avoided). */
export function ensureClaudeSessionId(sessionsDir, id) {
  // UNIFORM across ALL sessions (the user's call 2026-06-12): the primary (agent '0') is NOT special —
  // it resumes its claude session like every other agent, so its conversation/context persists across a
  // BlitzOS restart unless the USER chooses to clear it. (An earlier "always-fresh primary" auto-rotated
  // the id every launch to dodge a cyber-classifier trip on a near-full transcript; that was the wrong
  // tradeoff — clearing context must be a user action, not automatic. The cyber-classifier risk is now
  // managed by the user-triggered "new context" control, which rotates the id ON DEMAND via clearContext.)
  const m = readMeta(sessionsDir, id)
  const claudeSessionId = m.claudeSessionId || randomUUID()
  const established = !!m.claudeEstablished || claudeConversationExists(sessionsDir, claudeSessionId)
  return { claudeSessionId, established }
}

/** Prepare an agent (re)launch: ensure the claude session-id, (re)write the bootstrap file with the CURRENT
 *  relay url, and build the command. Returns { command, claudeSessionId } for terminal-manager.spawnTerminal.
 *  Used by BOTH the new-agent launch (workspace-host launchAgent) AND the re-exec path (restartTerminal's
 *  rebuildAgentCommand) — one definition, no divergence. */
export function prepareAgentLaunch({ sessionsDir, id, url, cmd, runtime = AGENT_RUNTIME_CLAUDE }) {
  const agentRuntime = normalizeAgentRuntime(runtime)
  // ISOLATION safety net: before ANY agent process starts, relocate any transcript still sitting in the shared
  // workspace root into its private per-agent dir, so this agent can't `cat` a sibling's chat (the cross-agent
  // context leak, plans/blitzos-agent-chat-isolation.md). Idempotent + cheap; the workspace host also runs this
  // at open, but this guarantees it for EVERY launch path (boot-resume and new spawn alike).
  try { relocateLegacyChats(dirname(dirname(sessionsDir))) } catch { /* best-effort; a launch never blocks on it */ }
  const claudeState = agentRuntime === AGENT_RUNTIME_CLAUDE ? ensureClaudeSessionId(sessionsDir, id) : { claudeSessionId: undefined, established: false }
  const agentSessionId = agentRuntime === AGENT_RUNTIME_CODEX_SERVERLESS ? randomUUID() : undefined
  const file = bootstrapPath(sessionsDir, id)
  let bootTask = null
  try {
    bootTask = bootTaskProvider ? bootTaskProvider(String(id)) : null
  } catch { /* a broken provider never blocks a launch */ }
  let userInstructions = null
  try {
    userInstructions = userInstructionsProvider ? userInstructionsProvider(String(id)) : null
  } catch { /* a broken provider never blocks a launch */ }
  // sessionsDir = <workspace>/.blitzos/sessions → the workspace NAME pins this agent (v2 bleed fix).
  const workspace = basename(dirname(dirname(sessionsDir)))
  try {
    mkdirSync(sessionDir(sessionsDir, id), { recursive: true })
    writeFileSync(file, buildBootstrap(url, id, bootTask, workspace, userInstructions, claudeState.established))
    writeRelayUrl(dirname(sessionsDir), url) // <ws>/.blitzos/relay-url — the live base the agent re-reads per call
    writeWaitScript(dirname(sessionsDir)) // <ws>/.blitzos/wait.sh — the blocking event-wait the bootstrap points at
    writeBlitzShim(dirname(sessionsDir)) // <ws>/.blitzos/blitz + orchestrator.md — the workflow runner + duty (orchestrators toggle)
    ensureWorkspaceTrusted(dirname(dirname(sessionsDir))) // unattended spawn must never stall on the trust dialog
  } catch { /* best-effort; if the dir is unwritable the spawn will surface it */ }
  // Reasoning effort (Claude). The RESIDENT agent runs XHIGH (RESIDENT_EFFORT) so it follows the act/ask
  // boundary and decides well, keeping the user's own model. Codex carries no effort knob here (null).
  const isClaude = agentRuntime === AGENT_RUNTIME_CLAUDE
  const effort = isClaude ? RESIDENT_EFFORT : null
  return {
    agentRuntime,
    agentSessionId,
    claudeSessionId: claudeState.claudeSessionId,
    established: claudeState.established, // surfaced so the re-exec path persists the (possibly rotated) id + correct established flag
    command: buildAgentCommand({
      runtime: agentRuntime,
      cmd: cmd || (agentRuntime === AGENT_RUNTIME_CODEX_SERVERLESS ? 'codex' : 'claude'),
      claudeSid: claudeState.claudeSessionId,
      mode: claudeState.established ? 'resume' : 'create',
      bootstrapFile: file,
      effort
    })
  }
}

/** Claude's interactive TUI asks a ONE-TIME workspace-trust question per project dir. Headless `-p`
 *  never did — so when 4c0c641 dropped `-p` for the live TUI, every UNATTENDED spawn on a machine
 *  where no human had ever accepted the dialog froze at it forever (the VM brain: alive, 0 TCP,
 *  waiting on stdin; `--dangerously-skip-permissions` does NOT cover workspace trust). BlitzOS
 *  agents are unattended BY DESIGN, so pre-seed claude's own ack in ~/.claude.json (merge-patch,
 *  claude's persistence). If a future CLI renames the key, the dialog merely reappears —
 *  degraded, never silently broken. */
export function ensureWorkspaceTrusted(wsPath) {
  if (!wsPath) return
  const file = join(homedir(), '.claude.json')
  try {
    let d = {}
    try {
      d = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      /* missing/corrupt → seed fresh; claude tolerates a minimal file */
    }
    if (!d || typeof d !== 'object') d = {}
    if (!d.projects || typeof d.projects !== 'object') d.projects = {}
    const cur = (d.projects[wsPath] = d.projects[wsPath] && typeof d.projects[wsPath] === 'object' ? d.projects[wsPath] : {})
    if (cur.hasTrustDialogAccepted === true && cur.hasCompletedProjectOnboarding === true) return
    cur.hasTrustDialogAccepted = true
    cur.hasCompletedProjectOnboarding = true
    writeFileSync(file, JSON.stringify(d, null, 2))
  } catch {
    /* best-effort — worst case the dialog shows once on an attended machine */
  }
}

/** Write the current agent-socket base url to `<blitzDir>/relay-url` (the file the agent re-reads each call).
 *  `blitzDir` is the workspace's `.blitzos` folder. Called at launch AND whenever the relay url changes, so a
 *  reattached agent self-heals onto the fresh url. Strips a trailing /agents.md so the file is the bare base. */
export function writeRelayUrl(blitzDir, url) {
  if (!blitzDir || !url) return
  const base = String(url).replace(/\/agents\.md$/, '')
  try { mkdirSync(blitzDir, { recursive: true }); writeFileSync(join(blitzDir, 'relay-url'), base) } catch { /* best-effort */ }
}

// The agent's BLOCKING event-wait, run as `bash .blitzos/wait.sh <since> '<scopeJson>'` (cwd = workspace).
// It loops the 25s `/events` long-poll IN THE SHELL and returns ONLY on a real event — so the agent's LLM is
// woken once per actual message instead of once per empty 25s poll (~24× fewer idle turns). It re-reads
// `.blitzos/relay-url` each iteration, so a relay-url change after a BlitzOS restart self-heals mid-wait.
// $1 = the `since` cursor (a number); $2 = the scope JSON fragment (e.g. `,"agent":"1","workspace":"main"`).
export const WAIT_SCRIPT = `#!/bin/sh
# BlitzOS agent event-wait — blocks until the next event, prints {"events":[…],"latest":N}, exits. See agent-runtime.mjs.
S="\${1:-0}"; SC="$2"
while :; do
  B=$(cat .blitzos/relay-url 2>/dev/null)
  [ -z "$B" ] && { sleep 1; continue; }
  R=$(curl -sS -X POST "$B/events" -H 'content-type: application/json' -d "{\\"since\\":$S,\\"wait\\":25$SC}" 2>/dev/null)
  case "$R" in
    '' ) sleep 1 ;;                                            # transient failure / url change — retry (relay-url re-read next loop)
    *'"events":[]'* ) sleep 1 ;;                              # nothing new — brief sleep so an instant-returning server can't peg the CPU
    *'"events":'*'"latest":'* ) printf '%s\\n' "$R"; exit 0 ;; # a REAL events payload — hand it to the agent's turn
    * ) sleep 1 ;;                                            # garbage (HTML error / 404 body) — never feed it to the agent; retry
  esac
done
`

/** Write `<blitzDir>/wait.sh` (the agent's blocking event-wait). Static content; written at every launch so it
 *  always exists next to relay-url. `blitzDir` is the workspace's `.blitzos` folder. */
export function writeWaitScript(blitzDir) {
  if (!blitzDir) return
  try { mkdirSync(blitzDir, { recursive: true }); writeFileSync(join(blitzDir, 'wait.sh'), WAIT_SCRIPT) } catch { /* best-effort */ }
}
