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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'

const sessionDir = (sessionsDir, id) => join(sessionsDir, String(id))
const metaPath = (sessionsDir, id) => join(sessionDir(sessionsDir, id), 'meta.json')
const bootstrapPath = (sessionsDir, id) => join(sessionDir(sessionsDir, id), 'bootstrap.txt')
export const INTERVIEW_FAST_MODEL = 'sonnet'
export const INTERVIEW_FAST_SETTINGS = { model: INTERVIEW_FAST_MODEL, effortLevel: 'low', env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } }
export const AGENT_RUNTIME_CLAUDE = 'claude'
export const AGENT_RUNTIME_CODEX_SERVERLESS = 'codex-serverless'
export const DEFAULT_AGENT_RUNTIME = AGENT_RUNTIME_CODEX_SERVERLESS
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

/** The agent's BOOTSTRAP prompt (written to a file and passed to the selected agent backend). The served manual
 *  (blitzos-agents.md) is the SINGLE source of truth for identity, the /events loop, every tool, window
 *  management, and the design language — this stays a thin pointer and does NOT restate behavior. Multi-line
 *  is fine: it lives in a file, so it never touches the tmux control-mode command line (which rejects LF). */
export function buildBootstrap(_url, sessionId = '0', bootTask = null, workspace = null) {
  const primary = !sessionId || String(sessionId) === '0'
  const chatFile = primary ? 'chat.md' : `chat-${sessionId}.md`
  // v2 bleed fix: an agent is PINNED to its workspace — every /events + /say carries it, so a
  // background workspace's agent never sees (or answers into) another workspace's chat.
  const wsPin = workspace ? `,"workspace":"${String(workspace).replace(/"/g, '')}"` : ''
  const sess = (primary ? '' : `,"agent":"${sessionId}"`) + wsPin // non-primary agents MUST scope /events + /say to their agent id
  const B = '"$(cat ' + RELAY_URL_FILE + ')"' // every URL is built fresh from the file on each curl
  const identity = primary
    ? 'You are the primary chat agent of BlitzOS, an agent OS the user watches live. BlitzOS makes NO decisions; YOU decide everything.'
    : `You are agent "${sessionId}" — one of several independent agents in BlitzOS (an agent OS). You serve ONLY your own chat; other agents have their own chats.`
  const relay = `BlitzOS runs locally on this Mac and gives you a small local HTTP API to talk to it. It tells you its current address in the file ${RELAY_URL_FILE} in your working folder, and that address can change when the app restarts, so read it from the file each time rather than remembering it: \`curl -sX POST ${B}/<tool> -H 'content-type: application/json' -d '{…}'\`. The \`$(cat …)\` just reads the app's current address. If a call ever returns a connection error or 404, the app most likely restarted with a new address; reading the file again and retrying picks it up.`
  const guide = bootTask
    ? `Your full operating guide is at ${B}/agents.md, with the complete tool set. You do NOT need it for the first step of your standing duty below, so do that FIRST and fetch the guide (\`curl -s ${B}/agents.md\`) only afterward, when you need a tool the duty did not give you. Do not let reading the guide delay your first action.`
    : `Your full operating guide is at ${B}/agents.md. Please read it first (\`curl -s ${B}/agents.md\`) and follow it; if that request doesn't succeed, give it another try before continuing.`
  const desktop = "Note for this session: the user has already arranged their desktop. Please leave it as-is on connect — don't rearrange, resize, recenter, move, or close anything on your own. Ignore the guide's 'assemble the desktop on connect' section here; this is the user's own live layout."
  const recover = `Get your bearings first: you may have been restarted, so recover the conversation before doing anything. Call \`list_state\` to get \`workspace_path\`, then read the recent chat: \`tail -n 60 "$workspace_path/${chatFile}"\`. That file is your saved conversation with the user and it carries over between restarts (the live event feed does not). Reading it helps you understand follow-ups like "continue the X thing" or "go". If the last line is a user message you haven't answered, answer it now.`
  // The OS can hand a session ONE standing duty (e.g. the onboarding interview); the duty text licenses
  // unprompted action for its own scope and is re-read per (re)launch, so a finished duty disappears.
  const duty = bootTask ? `The app has given you one standing task to handle first, right after you've caught up on the conversation (it applies only to its own scope): ${bootTask}` : null
  const eventsLoop = `Your job is to help the user in their chat. To see new chat messages, check the app's message endpoint: call \`curl -sX POST ${B}/events -d '{"since":0,"wait":0${sess}}'\` once to read anything waiting, then use the returned \`latest\` as your next \`since\` and call it again with \`wait:25\`${sess ? ` (always including ${sess.slice(1)})` : ''}. This is a normal long-poll: the request simply waits up to 25 seconds for the next message and returns as soon as one arrives. When a \`trigger:'message'\` comes in, do what it asks.`
  const keepChecking = `Keep checking for messages while you're working. The app doesn't push messages to you; you see them by making that \`/events\` call, so after each one just make the next one — handle anything that arrived, then check again. If you finish a reply and simply stop, you won't notice the user's next message until you check again, so keep the check going rather than waiting idle.`
  const say = `Keep the user in the loop: send your replies and progress with \`curl -sX POST ${B}/say -d '{"text":"…"${sess}}'\` (it appears in their chat). When a message comes in, a quick note of your plan first is nice, then a short line as you go. It's best not to act unless the user has asked for something, and to say what you're doing as you do it rather than working silently.`
  const stage = primary
    ? null
    : `Your windows live in your own stage, separate from the user's primary desktop. On every surface-opening call — create_surface, open_window, and open_terminal — include "agent":"${sessionId}" so the window opens in your stage and doesn't disturb the user. Don't pass an explicit x/y unless you're repositioning a window within your own stage. Open your terminal and all work windows this way.`
  return [identity, relay, guide, desktop, recover, duty, eventsLoop, keepChecking, say, stage].filter(Boolean).join('\n')
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
export function buildClaudeCommand({ cmd = 'claude', claudeSid, mode = 'create', bootstrapFile, lowThinking = false }) {
  const sessionArg = mode === 'resume' ? `--resume ${claudeSid}` : `--session-id ${claudeSid}`
  // The interview asks dynamic questions, so the brain must run FAST. The real lever is `--settings`,
  // NOT env vars or --effort alone: Claude Code's settings precedence is CLI args > project > USER
  // (~/.claude/settings.json). A user's global `model` may also be a 1M-context variant that requires
  // usage credits, so force standard-context sonnet for this once-per-user interview. Standalone timing
  // with global xhigh: baseline 7.9s, --effort low 3.9s, --settings effort+env low 2.7s for a small
  // onboarding-question prompt. The resident phase passes nothing, so it returns to the user's normal
  // model/effort after the duty is done and agent 0 is re-exec'd.
  const fast = lowThinking ? `--model ${INTERVIEW_FAST_MODEL} --effort low --settings ${shellQuote(JSON.stringify(INTERVIEW_FAST_SETTINGS))} ` : ''
  return `${cmd} ${sessionArg} ${fast}--dangerously-skip-permissions "$(cat ${shellQuote(bootstrapFile)})"`
}

/** Codex serverless backend: one non-interactive `codex exec` turn that receives the same BlitzOS
 * bootstrap as Claude. Disable plugins and ignore Codex user config/rules so the app bootstrap is the
 * policy surface instead of inheriting this machine's personal Codex skills, hooks, or repo instructions.
 * Auth still uses CODEX_HOME. The terminal supervisor restarts it when it exits, so it behaves like a
 * resident agent without requiring a long-lived TUI or Anthropic account quota. */
export function buildCodexServerlessCommand({ cmd = 'codex', bootstrapFile, lowThinking = false }) {
  const effort = lowThinking ? `-c ${shellQuote('model_reasoning_effort="low"')} ` : ''
  return `${cmd} exec ${effort}--disable plugins --ignore-user-config --ignore-rules --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --color never "$(cat ${shellQuote(bootstrapFile)})"`
}

export function buildAgentCommand({ runtime = AGENT_RUNTIME_CLAUDE, cmd, claudeSid, mode = 'create', bootstrapFile, lowThinking = false }) {
  const r = normalizeAgentRuntime(runtime)
  if (r === AGENT_RUNTIME_CODEX_SERVERLESS) return buildCodexServerlessCommand({ cmd: cmd || 'codex', bootstrapFile, lowThinking })
  return buildClaudeCommand({ cmd: cmd || 'claude', claudeSid, mode, bootstrapFile, lowThinking })
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
  const m = readMeta(sessionsDir, id)
  // ALWAYS-FRESH PRIMARY (agent '0', the user's call 2026-06-12): the long-lived primary brain
  // accumulated a huge `--resume` transcript that tripped Anthropic's cyber-safety classifier near
  // full context (the saturated curl/bearer/$(cat) history reads as exfiltration) — and a near-full
  // context is degraded anyway. The primary recovers continuity by RE-READING chat.md on every boot
  // (the bootstrap mandates that `tail`), so a claude-level resume adds risk without value. Mint a
  // FRESH session id each launch → `--session-id` create mode, empty context, never trips. A new uuid
  // is REQUIRED (not just create mode): `claude --resume <missing-id>` exits 0 and `--session-id
  // <existing-id>` would continue the old session — only a brand-new id guarantees a clean slate.
  // Spawned agents ('1'+) keep resume (task-scoped, shorter-lived; extend here if they ever trip).
  // TODO: each boot orphans the prior session jsonl in ~/.claude/projects/<ws>/ — harmless, but a
  // periodic sweep of stale agent-0 sessions would be tidy.
  if (String(id) === '0') return { claudeSessionId: randomUUID(), established: false }
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
  const claudeState = agentRuntime === AGENT_RUNTIME_CLAUDE ? ensureClaudeSessionId(sessionsDir, id) : { claudeSessionId: undefined, established: false }
  const agentSessionId = agentRuntime === AGENT_RUNTIME_CODEX_SERVERLESS ? randomUUID() : undefined
  const file = bootstrapPath(sessionsDir, id)
  let bootTask = null
  try {
    bootTask = bootTaskProvider ? bootTaskProvider(String(id)) : null
  } catch { /* a broken provider never blocks a launch */ }
  // sessionsDir = <workspace>/.blitzos/sessions → the workspace NAME pins this agent (v2 bleed fix).
  const workspace = basename(dirname(dirname(sessionsDir)))
  try {
    mkdirSync(sessionDir(sessionsDir, id), { recursive: true })
    writeFileSync(file, buildBootstrap(url, id, bootTask, workspace))
    writeRelayUrl(dirname(sessionsDir), url) // <ws>/.blitzos/relay-url — the live base the agent re-reads per call
    ensureWorkspaceTrusted(dirname(dirname(sessionsDir))) // unattended spawn must never stall on the trust dialog
  } catch { /* best-effort; if the dir is unwritable the spawn will surface it */ }
  // The onboarding interview runs at reduced thinking effort so its dynamic follow-ups are snappy.
  // Other resident duties, such as post-onboarding initiative work, use the normal effort.
  const interview = String(id) === '0' && typeof bootTask === 'string' && bootTask.includes('THE ONBOARDING INTERVIEW')
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
      lowThinking: interview
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
