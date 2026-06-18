#!/bin/bash
# Local prod build: signed + notarized when your shell has the Apple creds (~/.zshrc exports
# APPLE_SIGNING_IDENTITY / APPLE_API_KEY (key id) / APPLE_API_KEY_PATH (.p8) / APPLE_API_ISSUER),
# plain unsigned zip otherwise. Output: release/BlitzOS-<version>-arm64-mac.zip
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
fi

npm run build

ARGS=(--mac zip --arm64 --publish never)
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  # electron-builder env names differ from the tauri-style ones in ~/.zshrc — map them.
  export CSC_NAME="${APPLE_SIGNING_IDENTITY#Developer ID Application: }"
  if [[ -n "${APPLE_API_KEY_PATH:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
    export APPLE_API_KEY_ID="${APPLE_API_KEY}"   # ~/.zshrc's APPLE_API_KEY holds the KEY ID
    export APPLE_API_KEY="${APPLE_API_KEY_PATH}" # electron-builder wants the .p8 PATH here
    ARGS+=(-c.mac.notarize=true)
    echo "[dist] signing as ${CSC_NAME} + notarizing"
  else
    echo "[dist] signing as ${CSC_NAME} (no notarization creds)"
  fi
else
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  echo "[dist] UNSIGNED build (no APPLE_SIGNING_IDENTITY in env)"
fi

npx electron-builder "${ARGS[@]}"
ls -lh release/*.zip
