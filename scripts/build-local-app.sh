#!/bin/bash
# Rebuild BlitzOS from the CURRENT working tree and (re)install it to /Applications, so your pinned Dock
# icon always launches the latest code. Run this whenever you change the source:
#
#   npm run build:app        (or: bash scripts/build-local-app.sh)
#
# Fast LOCAL build: Developer-ID signed but NOT notarized (launches clean on THIS Mac), .app only (no
# dmg/zip). The install to /Applications/BlitzOS.app is done by dist-mac.sh (shared with `npm run dist`).
# For a notarized, distributable build use `npm run dist`.
set -euo pipefail
cd "$(dirname "$0")/.."

BLITZ_NO_NOTARIZE=1 BLITZ_DIST_TARGET=dir bash scripts/dist-mac.sh

DEST="/Applications/BlitzOS.app"; [[ -w /Applications ]] || DEST="$HOME/Applications/BlitzOS.app"
[[ -d "$DEST" ]] || { echo "[build:app] ERROR: $DEST was not produced — see the build output above." >&2; exit 1; }
VER="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$DEST/Contents/Info.plist" 2>/dev/null || echo '?')"
echo ""
echo "[build:app] done — $DEST is now BlitzOS v$VER from your current tree."
echo "[build:app] click your pinned Dock icon (or drag $DEST to the Dock if it isn't pinned yet)."
