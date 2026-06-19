#!/bin/bash
# Local prod build: signed + notarized when your shell has the Apple creds (~/.zshrc exports
# APPLE_SIGNING_IDENTITY / APPLE_API_KEY (key id) / APPLE_API_KEY_PATH (.p8) / APPLE_API_ISSUER),
# plain unsigned zip otherwise. Output: release/BlitzOS-<version>-arm64-mac.zip
set -euo pipefail
cd "$(dirname "$0")/.."

# Build + sign the Computer Use helper FIRST so electron-builder bundles the signed bundle
# (plans/blitzos-computer-use-helper.md). Its TCC identity needs a real Developer-ID signature, so
# pass the dist identity through. NOTE: verify on a notarized build that electron-builder's deep
# sign preserved the helper's apple-events entitlement (an afterSign re-sign is the fallback).
if [[ "$(uname)" == "Darwin" ]]; then
  BLITZ_HELPER_SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-}" bash native/computer-use-helper/build.sh || echo "[dist] WARN: CU helper build failed — packaging without it"
fi

# Pack the BlitzOS Connector extension into a signed .crx (extension/key.pem) for the consented force-install.
# Best-effort: if Chrome or the key is missing, ship a 0-byte placeholder so packaging still succeeds (the
# force-install is disabled in that build; load-unpacked still works in dev).
if [[ -f extension/key.pem ]]; then
  node scripts/build-extension.mjs || echo "[dist] WARN: connector .crx pack failed — force-install disabled in this build"
fi
[[ -f extension.crx ]] || { echo "[dist] no extension.crx — shipping placeholder (force-install disabled)"; : > extension.crx; }

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
