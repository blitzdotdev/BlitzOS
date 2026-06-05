#!/usr/bin/env bash
# One-command bring-up of BlitzOS SERVER MODE on your domain (what runs at
# https://agentos.blitzmen.com):
#   - Vite renderer + /api proxy   (:5174)  — the <canvas> server-surface UI
#   - backend in SERVER MODE       (:8787)  — headless Chromium per web surface + agent-socket
#   - cloudflared named tunnel     (agentos.blitzmen.com -> localhost:5174)
#
# Prereqs (one-time — see preview/RUNNING.md): Chromium installed; the saved tunnel
# token at preview/.cf-tunnel-token; the CF dashboard public hostname mapping
# (agentos.blitzmen.com -> Service HTTP -> localhost:5174); integrations.config.json
# for OAuth (optional).
#
# Idempotent. Logs in /tmp/agentos-*.log. Env overrides:
#   PUBLIC_BASE_URL=https://foo   SERVER_MODE=0   CHROMIUM=/path/to/chromium
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # BlitzOS package root
cd "$DIR"

PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://agentos.blitzmen.com}"
SERVER_MODE="${SERVER_MODE:-1}" # 1 = live web surfaces via headless Chromium
RENDERER_PORT=5174
BACKEND_PORT=8787
CHROMIUM="${CHROMIUM:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || echo /usr/bin/chromium)}"

say() { printf '\033[36m[start-all]\033[0m %s\n' "$*"; }

# 1. deps (skip the ~150MB Electron download — we only serve the renderer)
if [ ! -d node_modules ]; then
  say "installing deps (no electron)…"
  npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
fi

if [ "$SERVER_MODE" = "1" ] && ! command -v "$CHROMIUM" >/dev/null 2>&1 && [ ! -x "$CHROMIUM" ]; then
  say "WARNING: server mode needs Chromium but '$CHROMIUM' not found — set CHROMIUM=/path, or run SERVER_MODE=0."
fi

# 2. stop previous instances (patterns match the real processes, NOT this script file)
say "stopping any previous instances…"
pkill -f 'vite --config vite.renderer.preview.mjs' 2>/dev/null || true
pkill -f 'preview/backend.mjs' 2>/dev/null || true
pkill -f 'cloudflared tunnel run --token' 2>/dev/null || true
pkill -f 'remote-debugging-port' 2>/dev/null || true # headless chromium spawned by server mode
for _ in $(seq 1 30); do
  ss -ltn 2>/dev/null | grep -qE ":(${RENDERER_PORT}|${BACKEND_PORT})[[:space:]]" || break
done

# 3. renderer (React canvas + /api proxy; BLITZ_SERVER_MODE injects the server-mode flag)
say "starting renderer on :${RENDERER_PORT} (server mode=${SERVER_MODE})…"
BLITZ_SERVER_MODE="$SERVER_MODE" nohup npx vite --config vite.renderer.preview.mjs >/tmp/agentos-vite.log 2>&1 &

# 4. backend (server mode: headless Chromium per web surface; OAuth; agent-socket)
say "starting backend on :${BACKEND_PORT} (PUBLIC_BASE_URL=${PUBLIC_BASE_URL})…"
BLITZ_SERVER_MODE="$SERVER_MODE" CHROMIUM="$CHROMIUM" PUBLIC_BASE_URL="$PUBLIC_BASE_URL" BACKEND_PORT="$BACKEND_PORT" \
  nohup node preview/backend.mjs >/tmp/agentos-backend.log 2>&1 &

# 5. cloudflared named tunnel (uses the saved token via start-tunnel.sh)
say "starting cloudflared tunnel…"
nohup bash preview/start-tunnel.sh >/tmp/agentos-tunnel.log 2>&1 &

# 6. wait for health
curl -s --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "http://127.0.0.1:${RENDERER_PORT}/" \
  && say "renderer up" || say "renderer DID NOT come up — see /tmp/agentos-vite.log"
curl -s --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "http://127.0.0.1:${BACKEND_PORT}/api/health" \
  && say "backend up" || say "backend DID NOT come up — see /tmp/agentos-backend.log"

say "ready → public: ${PUBLIC_BASE_URL}   (local: http://127.0.0.1:${RENDERER_PORT})"
say "server mode=${SERVER_MODE}: web surfaces are live server-rendered browsers. HARD-REFRESH the tab after a restart."
say "Connect AI (toolbar) shows the agent paste URL. Logs: /tmp/agentos-{vite,backend,tunnel}.log"
say "tunnel public-hostname mapping (Service=HTTP -> localhost:5174) lives in the Cloudflare dashboard."
