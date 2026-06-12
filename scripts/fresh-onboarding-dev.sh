#!/bin/bash
# Reset the local onboarding workspace and relaunch BlitzOS in dev.
#
# Usage:
#   scripts/fresh-onboarding-dev.sh --yes
#   scripts/fresh-onboarding-dev.sh --yes --background
#
# Destructive by design: deletes ~/Blitz/case-file unless BLITZ_CASE_FILE is set.
set -euo pipefail
cd "$(dirname "$0")/.."

YES=0
BACKGROUND=0
LOG_FILE="${BLITZ_DEV_LOG:-/tmp/blitzos-fresh-onboarding.log}"
CASE_FILE="${BLITZ_CASE_FILE:-$HOME/Blitz/case-file}"
ROOT_DIR="$(dirname "$CASE_FILE")"
ROOT_STATE="$ROOT_DIR/.blitzos/state.json"

usage() {
  cat <<EOF
Usage: $0 --yes [--background]

Deletes the onboarding workspace, kills the current dev Electron/BlitzOS and tmux
agents, then starts npm run dev.

Options:
  --yes          Required. Confirms deletion of: $CASE_FILE
  --background   Start npm run dev with nohup and return immediately.
  --help         Show this help.

Env:
  BLITZ_CASE_FILE   Override the case-file path. Default: $HOME/Blitz/case-file
  BLITZ_DEV_LOG     Background log path. Default: /tmp/blitzos-fresh-onboarding.log
EOF
}

for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --background) BACKGROUND=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$YES" != "1" ]]; then
  echo "Refusing to delete without --yes: $CASE_FILE" >&2
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
pkill -f "$CASE_FILE/.blitzos/tmux" 2>/dev/null || true
pkill -f "vendor/bin/tmux -S" 2>/dev/null || true
for _ in $(seq 1 50); do
  if ! pgrep -f "$CASE_FILE/.blitzos/tmux|vendor/bin/tmux -S" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "[fresh-onboarding] deleting $CASE_FILE"
rm -rf "$CASE_FILE"

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
