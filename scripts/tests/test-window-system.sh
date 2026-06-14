#!/usr/bin/env bash
# Headless test of the window system: bundle the REAL store.ts (window stubbed) and run assertions.
set -euo pipefail
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Stub `window` (store.ts reads window.innerWidth at init) before the bundle's code runs.
cat > "$TMP/prelude.js" <<'EOF'
globalThis.window = { innerWidth: 1440, innerHeight: 900 }
EOF
npx esbuild scripts/test-window-system.ts --bundle --format=esm --platform=node \
  --banner:js="$(cat "$TMP/prelude.js")" --outfile="$TMP/test.mjs" --log-level=warning
node "$TMP/test.mjs"
