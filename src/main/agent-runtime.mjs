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
    `BlitzOS runs locally on this Mac and gives you a small local HTTP API to talk to it. It tells you its current address in the file ${RELAY_URL_FILE} in your working folder, and that address can change when the app restarts, so read it from the file each time rather than remembering it: \`curl -sX POST ${B}/<tool> -H 'content-type: application/json' -d '{…}'\`. The \`$(cat …)\` just reads the app's current address. If a call ever returns a connection error or 404, the app most likely restarted with a new address; reading the file again and retrying picks it up.`,
    `Your full operating guide is at ${B}/agents.md. Please read it first (\`curl -s ${B}/agents.md\`) and follow it; if that request doesn't succeed, give it another try before continuing.`,
    "Note for this session: the user has already arranged their desktop. Please leave it as-is on connect — don't rearrange, resize, recenter, move, or close anything on your own. Ignore the guide's 'assemble the desktop on connect' section here; this is the user's own live layout.",
    `Get your bearings first: you may have been restarted, so recover the conversation before doing anything. Call \`list_state\` to get \`workspace_path\`, then read the recent chat: \`tail -n 60 "$workspace_path/${chatFile}"\`. That file is your saved conversation with the user and it carries over between restarts (the live event feed does not). Reading it helps you understand follow-ups like "continue the X thing" or "go". If the last line is a user message you haven't answered, answer it now.`,
    // The OS can hand a session ONE standing duty (e.g. the onboarding interview); the duty text licenses
    // unprompted action for its own scope and is re-read per (re)launch, so a finished duty disappears.
    ...(bootTask ? [`The app has given you one standing task to handle first, right after you've caught up on the conversation (it applies only to its own scope): ${bootTask}`] : []),
    `Your job is to help the user in their chat. ON CONNECT, read anything already waiting once: \`curl -sX POST ${B}/events -d '{"since":0,"wait":0${sess}}'\` — then use the returned \`latest\` as your cursor.`,
    `To see new messages, run \`bash .blitzos/wait.sh <cursor> '${sess}'\` with a 10-minute timeout on your Bash tool (replace <cursor> with your latest number). It waits in the shell and returns as soon as a message arrives — printing \`{"events":[…],"latest":N}\` — so you don't have to keep polling yourself. (Under the hood it's a normal \`/events\` long-poll loop; the script just runs it for you, and re-reads the relay url each time so it keeps working across an app restart.)`,
    `Keep checking for messages while you're working: when \`wait.sh\` returns, handle each \`trigger:'message'\` (do what it asks), set your cursor to the new \`latest\`, and run \`wait.sh\` again. The app doesn't push messages to you — you see them by running \`wait.sh\` — so after each one, start the next wait rather than stopping idle, or you won't notice the user's next message until you check again.`,
    `Keep the user in the loop: send your replies and progress with \`curl -sX POST ${B}/say -d '{"text":"…"${sess}}'\` (it appears in their chat). When a message comes in, a quick note of your plan first is nice, then a short line as you go. It's best not to act unless the user has asked for something, and to say what you're doing as you do it rather than working silently.`,
    ...(primary
      ? []
      : [
          `Your windows live in your own stage, separate from the user's primary desktop. On every surface-opening call — create_surface, open_window, and open_terminal — include "agent":"${sessionId}" so the window opens in your stage and doesn't disturb the user. Don't pass an explicit x/y unless you're repositioning a window within your own stage. Open your terminal and all work windows this way.`
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
    writeWaitScript(dirname(sessionsDir)) // <ws>/.blitzos/wait.sh — the blocking event-wait the bootstrap points at
    ensureWorkspaceTrusted(dirname(dirname(sessionsDir))) // unattended spawn must never stall on the trust dialog
  } catch { /* best-effort; if the dir is unwritable the spawn will surface it */ }
  return {
    claudeSessionId,
    command: buildClaudeCommand({ cmd, claudeSid: claudeSessionId, mode: established ? 'resume' : 'create', bootstrapFile: file })
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
// $1 = the `since` cursor (a number); $2 = the scope JSON fragment (e.g. `,"agent":"1","workspace":"Home"`).
export const WAIT_SCRIPT = `#!/bin/sh
# BlitzOS agent event-wait — blocks until the next event, prints {"events":[…],"latest":N}, exits. See agent-runtime.mjs.
S="\${1:-0}"; SC="$2"
while :; do
  B=$(cat .blitzos/relay-url 2>/dev/null)
  [ -z "$B" ] && { sleep 1; continue; }
  R=$(curl -sS -X POST "$B/events" -H 'content-type: application/json' -d "{\\"since\\":$S,\\"wait\\":25$SC}" 2>/dev/null)
  case "$R" in
    '' ) sleep 1 ;;                     # transient failure / url change — retry (relay-url re-read next loop)
    *'"events":[]'* ) : ;;             # 25s timeout, nothing new — keep blocking
    * ) printf '%s\\n' "$R"; exit 0 ;; # got events — hand them back to the agent's turn
  esac
done
`

/** Write `<blitzDir>/wait.sh` (the agent's blocking event-wait). Static content; written at every launch so it
 *  always exists next to relay-url. `blitzDir` is the workspace's `.blitzos` folder. */
export function writeWaitScript(blitzDir) {
  if (!blitzDir) return
  try { mkdirSync(blitzDir, { recursive: true }); writeFileSync(join(blitzDir, 'wait.sh'), WAIT_SCRIPT) } catch { /* best-effort */ }
}
