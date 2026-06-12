#!/usr/bin/env bash
# BlitzOS server-mode preview — robust start / stop / restart / status.
#
# Why this is reliable (the thing that kept breaking before): each service runs in
# its OWN process group via `setsid`, and its PGID is written to a pidfile. So:
#   - STOP kills the whole group (`kill -- -PGID`) → the backend's headless-Chromium
#     children die with it. No zombies, no orphaned chrome, no port squatting.
#   - setsid also detaches the service from the launcher's session, so it survives.
#   - START always runs STOP first → re-running is always from a clean slate.
#
#   bash preview/start-all.sh [start|stop|restart|status]      (default: restart)
#
# Env: PUBLIC_BASE_URL  SERVER_MODE(=1)  BACKEND_PORT(=8799)  CHROMIUM  RENDERER_PORT(=5174)
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # BlitzOS package root
cd "$DIR"
RUN="${TMPDIR:-/tmp}/blitzos-run"
mkdir -p "$RUN"

PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://agentos.blitzmen.com}"
SERVER_MODE="${SERVER_MODE:-1}"
RENDERER_PORT="${RENDERER_PORT:-5174}"
BACKEND_PORT="${BACKEND_PORT:-8799}" # NOT 8787 — that's wrangler's default and collides
CHROMIUM="${CHROMIUM:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || echo /usr/bin/chromium)}"

say() { printf '\033[36m[blitzos]\033[0m %s\n' "$*"; }

# Is any process in this group alive?
alive() { local pg="$1"; [ -n "$pg" ] && kill -0 -- "-${pg}" 2>/dev/null; }

stop_svc() {
  local f="$RUN/$1.pid"
  [ -f "$f" ] || return 0
  local pg; pg="$(cat "$f" 2>/dev/null || true)"
  if [ -n "$pg" ]; then
    kill -TERM -- "-${pg}" 2>/dev/null || true
    # The backend owns the headless browser; give it a brief grace on SIGTERM to flush the
    # persistent profile (the user's logins) to disk before we force-kill. Poll for clean
    # exit so we wait no longer than needed; cap ~3s. (curl-to-closed-port is our no-sleep
    # tick — foreground `sleep` is blocked in-harness.) Other services get no grace.
    if [ "$1" = backend ]; then
      for _ in 1 2 3 4; do
        alive "$pg" || break
        # ~1s tick: connrefused on a closed port, then one retry after a 1s delay.
        curl -s -o /dev/null --max-time 3 --retry 1 --retry-delay 1 --retry-connrefused "http://127.0.0.1:9/" 2>/dev/null || true
      done
    fi
    kill -KILL -- "-${pg}" 2>/dev/null || true # force-kill fallback (no zombies)
  fi
  rm -f "$f"
}

# start_svc <name> <command...>  — runs in its own session/group; records the PGID.
start_svc() {
  local name="$1"; shift
  setsid "$@" >"$RUN/$name.log" 2>&1 &
  echo "$!" >"$RUN/$name.pid"
}

cmd_stop() {
  say "stopping (tunnel, backend, vite)…"
  stop_svc tunnel
  stop_svc backend
  stop_svc vite
  # belt-and-suspenders: only OUR resources — our ports + our headless chrome (by its
  # user-data-dir name). Never touches 8787 (the agent-socket relay) or other browsers.
  if command -v fuser >/dev/null 2>&1; then fuser -k -KILL "${RENDERER_PORT}/tcp" "${BACKEND_PORT}/tcp" 2>/dev/null || true; fi
  pkill -KILL -f 'blitz-chrome' 2>/dev/null || true
  # NOTE: agent sessions are backend processes running in the workspace's OWN tmux server (not the backend's
  # process group), so they intentionally SURVIVE a stop and reattach on the next start. Do NOT kill them here.
  say "stopped."
}

cmd_start() {
  cmd_stop # always from a clean slate
  if [ ! -d node_modules ]; then say "installing deps (no electron)…"; npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1; fi
  if [ "$SERVER_MODE" = "1" ] && ! command -v "$CHROMIUM" >/dev/null 2>&1 && [ ! -x "$CHROMIUM" ]; then
    say "WARNING: server mode needs Chromium ('$CHROMIUM' not found) — set CHROMIUM=/path, or run with SERVER_MODE=0."
  fi

  # BLITZ_AGENT (optional): if set (e.g. =1, =codex, or =claude), each chat session runs a managed agent
  # in its own tmux terminal (reattached across restarts). Unset = sessions persist but no agent is auto-launched.
  # BLITZ_AGENT_BACKEND / BLITZ_AGENT_RUNTIME (optional): choose codex-serverless or claude.
  # BLITZ_WORKSPACES_ROOT (optional): the folder that holds all workspace folders (default
  # preview/.workspace). BLITZ_WORKSPACE (optional, back-compat): a single explicit workspace folder.
  export BLITZ_SERVER_MODE="$SERVER_MODE" BACKEND_PORT="$BACKEND_PORT" CHROMIUM="$CHROMIUM" PUBLIC_BASE_URL="$PUBLIC_BASE_URL" BLITZ_AGENT="${BLITZ_AGENT:-}" BLITZ_AGENT_BACKEND="${BLITZ_AGENT_BACKEND:-}" BLITZ_AGENT_RUNTIME="${BLITZ_AGENT_RUNTIME:-}" BLITZ_WORKSPACES_ROOT="${BLITZ_WORKSPACES_ROOT:-}" BLITZ_WORKSPACE="${BLITZ_WORKSPACE:-}"

  # Clear Vite's transform cache so a restart can NEVER serve a stale module (the "fresh bundle + old
  # agentos-shim" bug). The port was already freed by cmd_stop above, so :5174 is clean here.
  rm -rf "$DIR/node_modules/.vite" 2>/dev/null || true
  say "starting vite (:$RENDERER_PORT, server mode=$SERVER_MODE)…"
  start_svc vite npx vite --config vite.renderer.preview.mjs

  say "starting backend (:$BACKEND_PORT, PUBLIC_BASE_URL=$PUBLIC_BASE_URL)…"
  start_svc backend node preview/backend.mjs

  say "starting cloudflared tunnel…"
  start_svc tunnel bash preview/start-tunnel.sh

  curl -s --retry 40 --retry-connrefused --retry-delay 1 -o /dev/null "http://127.0.0.1:${RENDERER_PORT}/" \
    && say "renderer up" || say "renderer DID NOT come up — see $RUN/vite.log"
  curl -s --retry 40 --retry-connrefused --retry-delay 1 -o /dev/null "http://127.0.0.1:${BACKEND_PORT}/api/health" \
    && say "backend up" || say "backend DID NOT come up — see $RUN/backend.log"

  say "ready → ${PUBLIC_BASE_URL}  (hard-refresh the tab). Connect AI in the toolbar for the agent URL."
  say "stop: bash preview/start-all.sh stop   ·   status: …/start-all.sh status   ·   logs: $RUN/{vite,backend,tunnel}.log"
}

cmd_status() {
  for s in vite backend tunnel; do
    f="$RUN/$s.pid"
    if [ -f "$f" ] && alive "$(cat "$f" 2>/dev/null)"; then echo "$s:    running (pgid $(cat "$f"))"; else echo "$s:    stopped"; fi
  done
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${RENDERER_PORT}/" && echo "renderer: :$RENDERER_PORT responding" || echo "renderer: :$RENDERER_PORT no response"
  H="$(curl -s --max-time 3 "http://127.0.0.1:${BACKEND_PORT}/api/health" 2>/dev/null)"
  if [ -n "$H" ]; then
    echo "backend:  :$BACKEND_PORT responding  $(printf '%s' "$H" | sed -n 's/.*"workspace":"\([^"]*\)".*/[ws=\1]/p')"
    # the load-bearing line: is the agent's RELAY link actually up? (a dead relay = agents can't see/answer chat)
    case "$H" in
      *'"relayOnline":true'*)  echo "relay:    UP (agents can see + answer chat)";;
      *'"relayOnline":false'*) echo "relay:    DOWN — agents offline (the watchdog will reconnect; or restart)";;
    esac
    echo "agents:   $(ps -eo args 2>/dev/null | grep -E -c '([c]laude --(session-id|resume)|[c]odex exec)') managed terminal(s)"
  else
    echo "backend:  :$BACKEND_PORT no response"
  fi
}

case "${1:-restart}" in
  start | restart) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *) echo "usage: $0 [start|stop|restart|status]"; exit 1 ;;
esac
