#!/usr/bin/env bash
# One-command bring-up of the Agent OS browser preview:
#   - Vite renderer + /api proxy   (:5174)
#   - integrations backend         (:8787)
#   - cloudflared named tunnel     (agentos.blitzmen.com -> localhost:5174)
#
# Idempotent: stops any previous instances first. Logs go to /tmp/agentos-*.log.
# Override the domain with: PUBLIC_BASE_URL=https://foo.example.com bash preview/start-all.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # BlitzOS package root
cd "$DIR"

PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://agentos.blitzmen.com}"
RENDERER_PORT=5174
BACKEND_PORT=8787

say() { printf '\033[36m[start-all]\033[0m %s\n' "$*"; }

# 1. deps (skip the ~150MB Electron download — we only serve the renderer)
if [ ! -d node_modules ]; then
  say "installing deps (no electron)…"
  npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
fi

# 2. stop previous instances (patterns match the real processes, NOT this script)
say "stopping any previous instances…"
pkill -f 'vite --config vite.renderer.preview.mjs' 2>/dev/null || true
pkill -f 'preview/backend.mjs' 2>/dev/null || true
pkill -f 'cloudflared tunnel run --token' 2>/dev/null || true

# wait (bounded, no sleep) for the ports to free
for _ in $(seq 1 30); do
  ss -ltn 2>/dev/null | grep -qE ":(${RENDERER_PORT}|${BACKEND_PORT})[[:space:]]" || break
done

# 3. renderer (React canvas + /api proxy to the backend)
say "starting renderer on :${RENDERER_PORT}…"
nohup npx vite --config vite.renderer.preview.mjs >/tmp/agentos-vite.log 2>&1 &

# 4. integrations backend (real OAuth; redirect URI derived from PUBLIC_BASE_URL)
say "starting backend on :${BACKEND_PORT} (PUBLIC_BASE_URL=${PUBLIC_BASE_URL})…"
PUBLIC_BASE_URL="$PUBLIC_BASE_URL" BACKEND_PORT="$BACKEND_PORT" \
  nohup node preview/backend.mjs >/tmp/agentos-backend.log 2>&1 &

# 5. cloudflared named tunnel (uses the saved token via start-tunnel.sh)
say "starting cloudflared tunnel…"
nohup bash preview/start-tunnel.sh >/tmp/agentos-tunnel.log 2>&1 &

# 6. wait for health
curl -s --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "http://127.0.0.1:${RENDERER_PORT}/" \
  && say "renderer up" || say "renderer did NOT come up — see /tmp/agentos-vite.log"
curl -s --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "http://127.0.0.1:${BACKEND_PORT}/api/health" \
  && say "backend up" || say "backend did NOT come up — see /tmp/agentos-backend.log"

say "ready → local: http://127.0.0.1:${RENDERER_PORT}   public: ${PUBLIC_BASE_URL}"
say "logs: /tmp/agentos-{vite,backend,tunnel}.log"
say "note: the tunnel's public-hostname mapping (Service=HTTP -> localhost:5174) lives in the Cloudflare dashboard."
