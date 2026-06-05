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
    kill -KILL -- "-${pg}" 2>/dev/null || true # immediate fallback (no sleep)
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
  say "stopped."
}

cmd_start() {
  cmd_stop # always from a clean slate
  if [ ! -d node_modules ]; then say "installing deps (no electron)…"; npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1; fi
  if [ "$SERVER_MODE" = "1" ] && ! command -v "$CHROMIUM" >/dev/null 2>&1 && [ ! -x "$CHROMIUM" ]; then
    say "WARNING: server mode needs Chromium ('$CHROMIUM' not found) — set CHROMIUM=/path, or run with SERVER_MODE=0."
  fi

  export BLITZ_SERVER_MODE="$SERVER_MODE" BACKEND_PORT="$BACKEND_PORT" CHROMIUM="$CHROMIUM" PUBLIC_BASE_URL="$PUBLIC_BASE_URL"

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
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${BACKEND_PORT}/api/health" && echo "backend:  :$BACKEND_PORT responding" || echo "backend:  :$BACKEND_PORT no response"
}

case "${1:-restart}" in
  start | restart) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *) echo "usage: $0 [start|stop|restart|status]"; exit 1 ;;
esac
