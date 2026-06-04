#!/usr/bin/env bash
# Start the named Cloudflare tunnel (agentos.blitzmen.com -> localhost:5174)
# using the saved token. Downloads cloudflared if it isn't already present.
#
# The tunnel's public hostname mapping lives in the Cloudflare dashboard
# (Service type MUST be HTTP -> localhost:5174, not HTTPS).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="$DIR/.cf-tunnel-token"
[ -f "$TOKEN_FILE" ] || { echo "missing $TOKEN_FILE"; exit 1; }
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"

CF="$(command -v cloudflared || true)"
if [ -z "$CF" ]; then
  CF="/tmp/cloudflared"
  if [ ! -x "$CF" ]; then
    case "$(uname -m)" in aarch64|arm64) A=arm64;; *) A=amd64;; esac
    echo "downloading cloudflared ($A)..."
    curl -fsSL -o "$CF" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$A"
    chmod +x "$CF"
  fi
fi

echo "starting tunnel via $CF (origin: localhost:5174)..."
exec "$CF" tunnel run --token "$TOKEN"
