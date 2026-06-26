#!/bin/bash
# Local prod build: signed + notarized when your shell has the Apple creds (~/.zshrc exports
# APPLE_SIGNING_IDENTITY / APPLE_API_KEY (key id) / APPLE_API_KEY_PATH (.p8) / APPLE_API_ISSUER),
# plain unsigned zip otherwise. Output: release/BlitzOS-<version>-arm64-mac.zip
# Set BLITZ_NO_NOTARIZE=1 to force a fast signed-ONLY build (skips the ~10 min notarize step) even when
# full creds are present — handy for a local demo build you only run on this Mac.
set -euo pipefail
cd "$(dirname "$0")/.."

# Build + sign the native helpers FIRST so electron-builder bundles the signed bundles
# (plans/blitzos-computer-use-helper.md, plans/blitzos-dynamic-island.md). Their identities need a real
# Developer-ID signature, so pass the dist identity through. Fail-soft: a helper build failure WARNs and
# packages without it rather than aborting the whole dist. NOTE: verify on a notarized build that
# electron-builder's deep sign preserved each helper's entitlements (an afterSign re-sign is the fallback).
if [[ "$(uname)" == "Darwin" ]]; then
  BLITZ_HELPER_SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-}" bash native/computer-use-helper/build.sh || echo "[dist] WARN: CU helper build failed — packaging without it"
  # The dynamic-island HUD: same Developer-ID-sign + fail-soft pattern (electron-builder.yml extraResources
  # copies native/island-helper/build/BlitzIsland.app into Contents/Resources, which index.ts then resolves).
  BLITZ_ISLAND_SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-}" bash native/island-helper/build.sh || echo "[dist] WARN: island helper build failed — packaging without it"
  # The notch-geometry CLI (exact physical-notch read for the bulletproof notch hit-window). No TCC/entitlement
  # needed (plain NSScreen read), so build.sh ad-hoc signs; electron-builder.yml extraResources copies the binary.
  bash native/notch-geometry/build.sh || echo "[dist] WARN: notch-geometry build failed — notch hit-window falls back to no band"
fi

npm run build

# Targets: default dmg+zip; BLITZ_DIST_TARGET=dir builds ONLY the signed .app (fast — no dmg/zip),
# used by the local rebuild-and-pin loop (scripts/build-local-app.sh). Intentional word-split, do not quote.
TARGETS=( ${BLITZ_DIST_TARGET:-dmg zip} )
ARGS=(--mac "${TARGETS[@]}" --arm64 --publish never)
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  # electron-builder env names differ from the tauri-style ones in ~/.zshrc — map them.
  export CSC_NAME="${APPLE_SIGNING_IDENTITY#Developer ID Application: }"
  # BLITZ_NO_NOTARIZE=1 forces the fast signed-ONLY path even when full creds exist.
  if [[ "${BLITZ_NO_NOTARIZE:-0}" != "1" && -n "${APPLE_API_KEY_PATH:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
    export APPLE_API_KEY_ID="${APPLE_API_KEY}"   # ~/.zshrc's APPLE_API_KEY holds the KEY ID
    export APPLE_API_KEY="${APPLE_API_KEY_PATH}" # electron-builder wants the .p8 PATH here
    ARGS+=(-c.mac.notarize=true)
    NOTARIZE_DMG=1   # post-step below: electron-builder notarizes the .app (the .zip carries it) but leaves the .dmg CONTAINER unsigned/unstapled — a downloaded dmg would warn on mount. Sign+notarize+staple it ourselves.
    echo "[dist] signing as ${CSC_NAME} + notarizing"
  else
    # Signed-only. electron-builder AUTO-attempts notarization if it sees ANY notary cred in the env
    # (~/.zshrc exports APPLE_API_KEY = the key id) and HARD-ERRORS on a partial API-key trio, so strip
    # every notary cred here to make it cleanly SKIP notarization instead of failing the build.
    unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
    echo "[dist] signing as ${CSC_NAME} (signed-only, notarization skipped)"
  fi
else
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  # Same electron-builder auto-notarize guard as the signed-only branch above.
  unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
  echo "[dist] UNSIGNED build (no APPLE_SIGNING_IDENTITY in env)"
fi

npx electron-builder "${ARGS[@]}"

# Notarize + staple the DMG container itself (Apple's recommended dmg-distribution flow). electron-builder
# only notarizes the .app (which the .zip carries), so without this a downloaded .dmg is quarantined +
# unsigned and Gatekeeper warns on mount even though the app inside is fine. APPLE_API_KEY/_KEY_ID/_ISSUER
# were remapped to electron-builder's names above (APPLE_API_KEY now holds the .p8 PATH).
if [[ "${NOTARIZE_DMG:-0}" == "1" ]]; then
  for dmg in release/*.dmg; do
    [[ -e "$dmg" ]] || continue
    echo "[dist] notarizing dmg: $dmg"
    codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$dmg"
    xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
    xcrun stapler staple "$dmg"
    xcrun stapler validate "$dmg"
  done
fi

# Install the freshly built .app to /Applications/BlitzOS.app so the local Dock icon always launches the
# latest build (the rebuild-and-test loop). Opt out with BLITZ_NO_INSTALL=1 for a pure release-artifact
# build. CI never runs this script (release.yml calls electron-builder directly), so this only touches a dev Mac.
APP_SRC="release/mac-arm64/BlitzOS.app"
if [[ "${BLITZ_NO_INSTALL:-0}" != "1" && -d "$APP_SRC" ]]; then
  DEST="/Applications/BlitzOS.app"
  [[ -w /Applications ]] || { DEST="$HOME/Applications/BlitzOS.app"; mkdir -p "$HOME/Applications"; }
  # Quit a running packaged instance BY BUNDLE ID (so the dev `npm run dev` Electron is never touched) so the
  # swap is clean and the journal is marked clean — no false "recovered from a crash" banner next launch.
  if pgrep -f "/BlitzOS\.app/Contents/MacOS/BlitzOS" >/dev/null 2>&1; then
    osascript -e 'tell application id "dev.blitz.os" to quit' >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do pgrep -f "/BlitzOS\.app/Contents/MacOS/BlitzOS" >/dev/null 2>&1 || break; sleep 0.5; done
  fi
  rm -rf "$DEST"
  ditto "$APP_SRC" "$DEST"
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" -f "$DEST" >/dev/null 2>&1 || true
  echo "[dist] installed -> $DEST"
fi

ls -lhd release/*.dmg release/*.zip release/mac-arm64/*.app 2>/dev/null || true
