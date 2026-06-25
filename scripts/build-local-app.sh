#!/bin/bash
# Rebuild BlitzOS from the CURRENT working tree and (re)install it to /Applications, so your pinned
# Dock icon always launches the latest code. Run this whenever you change the source.
#
#   npm run build:app        (or: bash scripts/build-local-app.sh)
#
# Fast LOCAL build: Developer-ID signed but NOT notarized (launches clean on THIS Mac), and only the
# .app target (no dmg/zip). For a notarized, distributable build use `npm run dist` instead.
set -euo pipefail
cd "$(dirname "$0")/.."

LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
SRC="release/mac-arm64/BlitzOS.app"
APP_ID="dev.blitz.os"   # the packaged bundle id (electron-builder.yml appId) — NOT the dev Electron

echo "[build:app] building signed-only .app from the current tree…"
BLITZ_NO_NOTARIZE=1 BLITZ_DIST_TARGET=dir bash scripts/dist-mac.sh

[[ -d "$SRC" ]] || { echo "[build:app] ERROR: $SRC was not produced — see the build output above." >&2; exit 1; }

# A running packaged instance keeps the OLD bundle open, and one-instance-per-machine means a click
# would just refocus it instead of launching the new build. Quit it gracefully (Apple-event quit, by
# BUNDLE ID so the dev `npm run dev` Electron is never touched) so the swap is clean and marks the
# journal clean — no false "recovered from a crash" banner on the next launch.
if pgrep -f "/BlitzOS\.app/Contents/MacOS/BlitzOS" >/dev/null 2>&1; then
  echo "[build:app] a packaged BlitzOS is running — quitting it so the new build takes over…"
  osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do pgrep -f "/BlitzOS\.app/Contents/MacOS/BlitzOS" >/dev/null 2>&1 || break; sleep 0.5; done
fi

# Install to /Applications (fall back to ~/Applications if it isn't writable), replacing any prior copy.
DEST="/Applications/BlitzOS.app"
if [[ ! -w /Applications ]]; then DEST="$HOME/Applications/BlitzOS.app"; mkdir -p "$HOME/Applications"; fi
echo "[build:app] installing -> $DEST"
rm -rf "$DEST"
ditto "$SRC" "$DEST"
"$LSREG" -f "$DEST" >/dev/null 2>&1 || true   # refresh the Dock name + icon

VER="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$DEST/Contents/Info.plist" 2>/dev/null || echo '?')"
echo ""
echo "[build:app] done — $DEST is now BlitzOS v$VER from your current tree."
echo "[build:app] click your pinned Dock icon (or drag $DEST to the Dock if it isn't pinned yet)."
