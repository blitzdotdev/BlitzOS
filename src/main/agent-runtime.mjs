// agent-runtime.mjs — the SHARED core that turns a workspace terminal into a BlitzOS agent.
//
// There is no privileged headless "brain" anymore: an agent is just a tmux terminal (owned by
// terminal-manager.mjs) whose command runs `claude` pointed at the agent-socket relay. The claude process
// is VISIBLE (you watch it work), survives a BlitzOS restart (tmux), and /says clean replies into its chat
// widget over the unchanged agent-socket contract. This module owns the only agent-specific bits:
//   • the bootstrap prompt (the served blitzos-agents.md is the source of truth; this is a thin pointer),
//   • the claude argv command string (create vs resume), and
//   • the persisted claude --session-id token (so the SAME conversation continues across restarts).
// Both transports (Electron + server) import THIS one file — no per-transport fork.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'

const sessionDir = (sessionsDir, id) => join(sessionsDir, String(id))
const metaPath = (sessionsDir, id) => join(sessionDir(sessionsDir, id), 'meta.json')
const bootstrapPath = (sessionsDir, id) => join(sessionDir(sessionsDir, id), 'bootstrap.txt')
function readMeta(sessionsDir, id) { try { return JSON.parse(readFileSync(metaPath(sessionsDir, id), 'utf8')) } catch { return {} } }

// The agent's agent-socket BASE url is VOLATILE — the relay mints a fresh one on every BlitzOS (re)start, so
// a long-lived terminal can't bake it in. BlitzOS keeps the current base in this file (relative to the agent's
// cwd=workspace) + updates it on every change; the agent INLINES `$(cat <this>)` into every curl, so the shell
// re-reads the live url on each call and a reattached agent self-heals after a restart. Single source of truth.
export const RELAY_URL_FILE = '.blitzos/relay-url'

// Optional per-session STANDING DUTY (e.g. the onboarding interview): a policy-free seam — the transport
// registers a provider, and prepareAgentLaunch re-reads it on EVERY (re)launch (bootstrap.txt is rewritten),
// so a finished duty drops off the next respawn automatically. The duty TEXT is owned by whoever set it.
let bootTaskProvider = null
export function setBootTaskProvider(fn) {
  bootTaskProvider = typeof fn === 'function' ? fn : null
}

/** The agent's BOOTSTRAP prompt (written to a file, run via `claude -p "$(cat …)"`). The served manual
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
  return [
    primary
      ? 'You are the primary chat agent of BlitzOS, an agent OS the user watches live. BlitzOS makes NO decisions; YOU decide everything.'
      : `You are agent "${sessionId}" — one of several independent agents in BlitzOS (an agent OS). You serve ONLY your own chat; other agents have their own chats.`,
    `YOUR AGENT-SOCKET BASE URL IS VOLATILE — it changes every time BlitzOS restarts. NEVER hardcode it. Build EVERY url FRESH from the file ${RELAY_URL_FILE} (in your cwd): write each call as \`curl -sX POST ${B}/<tool> -H 'content-type: application/json' -d '{…}'\`. The \`$(cat …)\` re-reads your CURRENT base on each call, so you stay connected across restarts. If ANY curl fails (connection error / app_offline / 404), it almost always means BlitzOS restarted and minted a new url — just retry; the inlined \`$(cat …)\` already picks up the fresh one.`,
    `Your full operating manual is ${B}/agents.md. Fetch it FIRST (with your Bash tool: \`curl -s ${B}/agents.md\`) and FOLLOW it. If the fetch fails, retry; do not act blind.`,
    "IMPORTANT OVERRIDE for this session: the desktop is ALREADY set up by the user. Do NOT assemble, rearrange, resize, recenter, move, or close ANYTHING on connect or on your own — ignore the manual's 'assemble the desktop on connect' guidance entirely. This is the user's curated, live desktop.",
    `CONTEXT FIRST (you restart often + lose memory): ON CONNECT, before anything, recover your conversation history — call \`list_state\` to get \`workspace_path\`, then with your Bash tool run \`tail -n 60 "$workspace_path/${chatFile}"\`. That file is YOUR FULL chat history with the user and it PERSISTS across your restarts (the /events moment log does NOT — it resets). Read it so you understand follow-ups like 'continue the X thing' or 'go'. If the LAST line is an unanswered user message, act on it now.`,
    // The OS can hand a session ONE standing duty (e.g. the onboarding interview); the duty text licenses
    // unprompted action for its own scope and is re-read per (re)launch, so a finished duty disappears.
    ...(bootTask ? [`STANDING DUTY — sanctioned by the OS, do it FIRST after recovering context (it OVERRIDES the do-nothing-unprompted rule below until it is done, and only for its own scope): ${bootTask}`] : []),
    `Your ONLY job: respond when the user types in YOUR chat. Poll \`curl -sX POST ${B}/events -d '{"since":0,"wait":0${sess}}'\` once for the live backlog, then set \`since\` to the returned \`latest\` and run the /events long-poll loop FOREVER (wait:25${sess ? `, always including ${sess.slice(1)}` : ''}), responding to each new trigger:'message' and doing EXACTLY what it asks.`,
    `CRITICAL — STAYING REACHABLE: there is NO background process polling for you. The user reaches you ONLY while you are actively calling \`/events\`. The INSTANT you stop (end your turn, go "idle", or announce you are "watching/listening" and then sit waiting) you go DEAF — the user's messages pile up unseen and you appear frozen. So you must keep calling \`/events\` yourself in an UNBROKEN, NEVER-ENDING chain: poll → (handle any message) → poll again → poll again → forever. After EVERY poll, immediately issue the next poll, even if it returned nothing. Do NOT say "I'm now watching" and then stop — that makes you deaf. Just keep polling, forever, no matter what.`,
    `BE VISIBLE — the user must always SEE what you're doing. Reply + progress ONLY via \`curl -sX POST ${B}/say -d '{"text":"…"${sess}}'\` (this lands in YOUR chat). The MOMENT you get a message, /say a one-line acknowledgement of your PLAN, then /say a short note before/after each meaningful step. Never go quiet for more than a few seconds of work without a /say. DO NOTHING unprompted. Going silent, or acting without saying what you're doing, is a FAILURE.`,
    ...(primary
      ? []
      : [
          `YOUR WINDOWS LIVE IN YOUR OWN STAGE (separate from the user's primary desktop). On EVERY surface-opening call — create_surface, open_window, and open_terminal — you MUST include "agent":"${sessionId}" so the window opens in YOUR stage and never disturbs the user. Do NOT pass an explicit x/y unless repositioning a window within your own stage. Open your terminal and all work windows this way.`
        ])
  ].join('\n')
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
export function buildClaudeCommand({ cmd = 'claude', claudeSid, mode = 'create', bootstrapFile }) {
  const sessionArg = mode === 'resume' ? `--resume ${claudeSid}` : `--session-id ${claudeSid}`
  return `${cmd} ${sessionArg} --dangerously-skip-permissions "$(cat ${shellQuote(bootstrapFile)})"`
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
  const claudeSessionId = m.claudeSessionId || randomUUID()
  const established = !!m.claudeEstablished || claudeConversationExists(sessionsDir, claudeSessionId)
  return { claudeSessionId, established }
}

/** Prepare an agent (re)launch: ensure the claude session-id, (re)write the bootstrap file with the CURRENT
 *  relay url, and build the command. Returns { command, claudeSessionId } for terminal-manager.spawnTerminal.
 *  Used by BOTH the new-agent launch (workspace-host launchAgent) AND the re-exec path (restartTerminal's
 *  rebuildAgentCommand) — one definition, no divergence. */
export function prepareAgentLaunch({ sessionsDir, id, url, cmd = 'claude' }) {
  const { claudeSessionId, established } = ensureClaudeSessionId(sessionsDir, id)
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
  } catch { /* best-effort; if the dir is unwritable the spawn will surface it */ }
  return {
    claudeSessionId,
    command: buildClaudeCommand({ cmd, claudeSid: claudeSessionId, mode: established ? 'resume' : 'create', bootstrapFile: file })
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
