#!/bin/bash
# Local prod build: signed + notarized when your shell has the Apple creds (~/.zshrc exports
# APPLE_SIGNING_IDENTITY / APPLE_API_KEY (key id) / APPLE_API_KEY_PATH (.p8) / APPLE_API_ISSUER),
# plain unsigned zip otherwise. Output: release/BlitzOS-<version>-arm64-mac.zip
set -euo pipefail
cd "$(dirname "$0")/.."

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
