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
  # The notch-geometry CLI (exact physical-notch read for the bulletproof notch hit-window). No TCC/entitlement
  # needed (plain NSScreen read), so build.sh ad-hoc signs; electron-builder.yml extraResources copies the binary.
  bash native/notch-geometry/build.sh || echo "[dist] WARN: notch-geometry build failed — notch hit-window falls back to no band"
fi

# Pack the BlitzOS Connector extension into a signed .crx (extension/key.pem) for the consented force-install.
# Best-effort: if Chrome or the key is missing, ship a 0-byte placeholder so packaging still succeeds (the
# force-install is disabled in that build; load-unpacked still works in dev).
if [[ -f extension/key.pem ]]; then
  node scripts/build-extension.mjs || echo "[dist] WARN: connector .crx pack failed — force-install disabled in this build"
fi
[[ -f extension.crx ]] || { echo "[dist] no extension.crx — shipping placeholder (force-install disabled)"; : > extension.crx; }

npm run build

ARGS=(--mac dmg zip --arm64 --publish never)
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  # electron-builder env names differ from the tauri-style ones in ~/.zshrc — map them.
  export CSC_NAME="${APPLE_SIGNING_IDENTITY#Developer ID Application: }"
  if [[ -n "${APPLE_API_KEY_PATH:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
    export APPLE_API_KEY_ID="${APPLE_API_KEY}"   # ~/.zshrc's APPLE_API_KEY holds the KEY ID
    export APPLE_API_KEY="${APPLE_API_KEY_PATH}" # electron-builder wants the .p8 PATH here
    ARGS+=(-c.mac.notarize=true)
    NOTARIZE_DMG=1   # post-step below: electron-builder notarizes the .app (the .zip carries it) but leaves the .dmg CONTAINER unsigned/unstapled — a downloaded dmg would warn on mount. Sign+notarize+staple it ourselves.
    echo "[dist] signing as ${CSC_NAME} + notarizing"
  else
    echo "[dist] signing as ${CSC_NAME} (no notarization creds)"
  fi
else
  export CSC_IDENTITY_AUTO_DISCOVERY=false
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

ls -lh release/*.dmg release/*.zip 2>/dev/null
