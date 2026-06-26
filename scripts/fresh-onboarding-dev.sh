#!/bin/bash
# Reset the local onboarding state and relaunch BlitzOS in dev.
#
# Usage:
#   scripts/fresh-onboarding-dev.sh --yes
#   scripts/fresh-onboarding-dev.sh --yes --background
#
# Onboarding now runs in the single default workspace (Home) — there is no throwaway case-file. By
# default this does a SAFE reset: it removes only the onboarding artifacts + agent runtime state inside
# the workspace (.blitzos/onboarding and .blitzos/terminals) so the island setup flow starts fresh, while
# PRESERVING your workspace layout, documents, notepad, and chat. Pass --nuke-workspace to delete the
# entire workspace dir (the old behavior) — dangerous now that Home holds real data.
set -euo pipefail
cd "$(dirname "$0")/.."

YES=0
BACKGROUND=0
RESET_PERMS=0
NUKE=0
LOG_FILE="${BLITZ_DEV_LOG:-/tmp/blitzos-fresh-onboarding.log}"
# Default to the single Home workspace. BLITZ_CASE_FILE is kept as a back-compat alias for BLITZ_ONBOARDING_WS.
WORKSPACE="${BLITZ_ONBOARDING_WS:-${BLITZ_CASE_FILE:-$HOME/Blitz/Home}}"
ROOT_DIR="$(dirname "$WORKSPACE")"
ROOT_STATE="$ROOT_DIR/.blitzos/state.json"
# Dev userData (Electron app name from package.json) holds preboard.json; dev runs as the Electron
# binary, whose bundle id TCC attributes grants to. Both overridable for packaged/renamed builds.
PREBOARD_FILE="${BLITZ_PREBOARD_FILE:-$HOME/Library/Application Support/agent-os/preboard.json}"
TCC_BUNDLE_ID="${BLITZ_TCC_BUNDLE_ID:-com.github.Electron}"

usage() {
  cat <<EOF
Usage: $0 --yes [--background] [--nuke-workspace] [--reset-permissions]

Resets onboarding state in the workspace, kills the current dev Electron/BlitzOS and tmux
agents, then starts npm run dev.

Options:
  --yes                 Required. Confirms the reset of: $WORKSPACE
  --background          Start npm run dev with nohup and return immediately.
  --nuke-workspace      DELETE THE ENTIRE workspace dir ($WORKSPACE), not just onboarding
                        state. Dangerous: Home holds your real surfaces/docs/chat. The
                        default is a safe reset that preserves them.
  --reset-permissions   ALSO clear the pre-board sequence so it runs from zero:
                        delete preboard.json + revoke FDA/Automation via tccutil
                        (so the pre-board FDA + browser steps reappear).
  --help                Show this help.

Env:
  BLITZ_ONBOARDING_WS Override the workspace path. Default: \$HOME/Blitz/Home
  BLITZ_CASE_FILE     Back-compat alias for BLITZ_ONBOARDING_WS.
  BLITZ_DEV_LOG       Background log path. Default: /tmp/blitzos-fresh-onboarding.log
  BLITZ_PREBOARD_FILE Override preboard.json. Default: ~/Library/Application Support/agent-os/preboard.json
  BLITZ_TCC_BUNDLE_ID TCC bundle id to reset. Default: com.github.Electron (dev Electron)
EOF
}

for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --background) BACKGROUND=1 ;;
    --nuke-workspace) NUKE=1 ;;
    --reset-permissions) RESET_PERMS=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$YES" != "1" ]]; then
  echo "Refusing to reset without --yes: $WORKSPACE" >&2
  usage >&2
  exit 2
fi

echo "[fresh-onboarding] killing Electron dev processes"
pkill -f "agent-os/node_modules/.bin/electron-vite dev" 2>/dev/null || true
pkill -f "agent-os/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" 2>/dev/null || true
for _ in $(seq 1 50); do
  if ! pgrep -f "agent-os/node_modules/.bin/electron-vite dev|agent-os/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "[fresh-onboarding] killing BlitzOS tmux agents"
pkill -f "$WORKSPACE/.blitzos/tmux" 2>/dev/null || true
pkill -f "vendor/bin/tmux -S" 2>/dev/null || true
for _ in $(seq 1 50); do
  if ! pgrep -f "$WORKSPACE/.blitzos/tmux|vendor/bin/tmux -S" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# Port backstop: a half-dead previous run can leave the vite dev server (5173) or the connector relay
# (7682/7683) holding their ports, which makes the relaunch silently bind a different port or fail. Kill
# whatever still owns them so the fresh dev run gets the canonical ports. lsof prints nothing when a port
# is free, so the kill is a no-op then.
echo "[fresh-onboarding] freeing dev ports 5173, 7682, 7683"
for PORT in 5173 7682 7683; do
  PIDS="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [[ -n "$PIDS" ]]; then
    echo "[fresh-onboarding]   port $PORT held by: $PIDS — killing"
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
  fi
done

if [[ "$NUKE" == "1" ]]; then
  echo "[fresh-onboarding] --nuke-workspace: deleting ENTIRE workspace $WORKSPACE"
  rm -rf "$WORKSPACE"
else
  echo "[fresh-onboarding] safe reset: clearing onboarding + chat state in $WORKSPACE so the resident starts fresh"
  # context.md/profile.md/scan.json/interview.* → start() re-scans when these are gone.
  rm -rf "$WORKSPACE/.blitzos/onboarding"
  # agent runtime (bootstrap/meta/transcript) → fresh agent sessions on relaunch.
  rm -rf "$WORKSPACE/.blitzos/terminals"
  # The chat transcripts (chat.md = agent '0', chat-N.md = peers): without removing these the island
  # replays the old conversation, so onboarding never looks fresh. Glob may not match (nullglob off) →
  # the `[ -e ]` guard keeps the literal pattern from being rm'd when there are no chat files.
  for f in "$WORKSPACE"/chat.md "$WORKSPACE"/chat-*.md; do
    [ -e "$f" ] && rm -f "$f"
  done
  # Per-message attachment snapshots (.blitzos/attachments/<chat>.json): keyed by user-message ordinal.
  # Deleting chat.md resets those ordinals to 0, so a stale snapshot for ordinal 0 maps onto the FIRST
  # new message in the fresh session and shows a ghost attachment from a previous run. Clear alongside
  # the transcripts so ordinals and snapshots stay in sync.
  rm -rf "$WORKSPACE/.blitzos/attachments"
  # Runtime panel + action-item state (the chat/terminal/inbox panes + the human action queue): drop so
  # no stale agent panes or pending items are reconstructed on boot.
  rm -f "$WORKSPACE/.blitzos/state/panels.json" "$WORKSPACE/.blitzos/state/action-items.json"
  # Move the matching claude session dir aside so `claude --resume` cannot revive the old conversation
  # for agent '0' (a fresh duty needs a fresh session). Encoding matches agent-runtime.mjs exactly:
  # the absolute workspace path with every `/` and `.` turned into `-`. History is preserved under a
  # timestamped `.cleared-` suffix (the same convention osClearBrainContext leaves behind), never deleted.
  CLAUDE_CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  ABS_WS="$(cd "$(dirname "$WORKSPACE")" 2>/dev/null && pwd)/$(basename "$WORKSPACE")"
  ENCODED_WS="$(printf '%s' "$ABS_WS" | sed 's/[/.]/-/g')"
  CLAUDE_PROJECT_DIR="$CLAUDE_CFG_DIR/projects/$ENCODED_WS"
  if [[ -d "$CLAUDE_PROJECT_DIR" ]]; then
    ASIDE="$CLAUDE_PROJECT_DIR.cleared-$(date +%s)"
    echo "[fresh-onboarding] moving claude session dir aside: $CLAUDE_PROJECT_DIR -> $ASIDE"
    mv "$CLAUDE_PROJECT_DIR" "$ASIDE"
  fi
fi

echo "[fresh-onboarding] resetting root boot state to Home"
mkdir -p "$(dirname "$ROOT_STATE")"
node - "$ROOT_STATE" <<'NODE'
const fs = require('node:fs')
const path = process.argv[2]
let d = {}
try { d = JSON.parse(fs.readFileSync(path, 'utf8')) } catch {}
if (!d || typeof d !== 'object') d = {}
d.lastActiveWorkspace = 'Home'
if (d.boot && typeof d.boot === 'object') d.boot = { ...d.boot, cleanShutdown: true }
fs.writeFileSync(path, JSON.stringify(d, null, 2) + '\n')
NODE

export BLITZ_FORCE_ONBOARDING=1
echo "[fresh-onboarding] BLITZ_FORCE_ONBOARDING=1 (dev: ignore renderer localStorage completion flag)"

if [[ "$RESET_PERMS" == "1" ]]; then
  echo "[fresh-onboarding] clearing pre-board state: $PREBOARD_FILE"
  rm -f "$PREBOARD_FILE"
  # The captured working set (open-tabs snapshot) the browser step writes — delete it so a fresh run
  # re-captures rather than reopening stale tabs on the stage if the browser step is skipped.
  rm -f "$(dirname "$PREBOARD_FILE")/preboard-tabs.json"
  echo "[fresh-onboarding] revoking FDA + Automation for $TCC_BUNDLE_ID (correct for a packaged build)"
  # tccutil exits non-zero when the service has no entry for the id — fine, treat as already-clear.
  tccutil reset SystemPolicyAllFiles "$TCC_BUNDLE_ID" 2>/dev/null || echo "  (FDA already clear or tccutil declined)"
  tccutil reset AppleEvents "$TCC_BUNDLE_ID" 2>/dev/null || echo "  (Automation already clear or tccutil declined)"
  # Clear any STALE Electron entry from the Accessibility / Screen Recording lists (an earlier buggy
  # drag could have added BlitzOS/Electron there; toggling that stale entry is what restarts Electron).
  tccutil reset Accessibility "$TCC_BUNDLE_ID" 2>/dev/null || echo "  (Electron Accessibility already clear)"
  tccutil reset ScreenCapture "$TCC_BUNDLE_ID" 2>/dev/null || echo "  (Electron Screen Recording already clear)"
  # The Computer Use HELPER holds Accessibility + Screen Recording on its OWN bundle id — reset
  # those so the helper-backed pre-board steps start ungranted (the helper's grant is real in dev).
  HELPER_BUNDLE_ID="${BLITZ_HELPER_BUNDLE_ID:-dev.blitz.os.computeruse}"
  tccutil reset Accessibility "$HELPER_BUNDLE_ID" 2>/dev/null || echo "  (helper Accessibility already clear)"
  tccutil reset ScreenCapture "$HELPER_BUNDLE_ID" 2>/dev/null || echo "  (helper Screen Recording already clear)"
  # In DEV the Electron binary inherits the TERMINAL's FDA grant (macOS attributes TCC to the
  # responsible process), so the reset above can't actually revoke it and the FDA step would
  # self-skip. Force the pre-board to offer every step for visual testing; the drag + open-settings
  # actions stay real, only the live grant-detection poll is skipped (it needs a packaged build).
  export BLITZ_PREBOARD_FORCE=1
  echo "[fresh-onboarding] BLITZ_PREBOARD_FORCE=1 (dev: show every pre-board step regardless of inherited grants)"
fi

if [[ "$BACKGROUND" == "1" ]]; then
  echo "[fresh-onboarding] starting npm run dev in background"
  : >"$LOG_FILE"
  PID=$(node - "$LOG_FILE" "$PWD" <<'NODE'
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const [logFile, cwd] = process.argv.slice(2)
const out = fs.openSync(logFile, 'a')
const child = spawn('npm', ['run', 'dev'], {
  cwd,
  detached: true,
  stdio: ['ignore', out, out]
})
child.unref()
console.log(child.pid)
NODE
)
  echo "[fresh-onboarding] pid=$PID log=$LOG_FILE"
else
  echo "[fresh-onboarding] starting npm run dev"
  exec npm run dev
fi
