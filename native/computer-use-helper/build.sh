#!/bin/bash
# Build + sign "BlitzOS Automation.app" — the separate computer-use TCC helper
# (plans/blitzos-computer-use-helper.md). Native Swift, arm64, Developer-ID signed so its TCC
# identity is stable. Output: native/computer-use-helper/build/BlitzOS Automation.app
# Distinct display name (NOT "BlitzOS Helper") so it never collides with the main app or Electron's
# own "BlitzOS Helper" Chromium children in the Privacy panes. Bundle id stays dev.blitz.os.computeruse
# so the user's existing TCC grant survives the rename.
#
# Signing: uses the "Developer ID Application" identity from the keychain (override with
# BLITZ_HELPER_SIGN_IDENTITY). Unsigned ad-hoc fallback for dev mechanics testing (TCC identity is
# only real when Developer-ID signed — see the plan's "honest constraints").
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="BlitzOS Automation"
BUNDLE="build/${APP_NAME}.app"
EXEC_DIR="${BUNDLE}/Contents/MacOS"
EXEC="${EXEC_DIR}/${APP_NAME}"
ARCH="${BLITZ_HELPER_ARCH:-arm64}"

echo "[helper] clean"
rm -rf build
mkdir -p "$EXEC_DIR" "${BUNDLE}/Contents/Resources"

echo "[helper] swiftc → ${EXEC} (${ARCH})"
swiftc -O -target "${ARCH}-apple-macos13.0" -framework AppKit -framework CoreGraphics -framework ApplicationServices -framework CoreServices -framework ScreenCaptureKit -framework ScriptingBridge \
  -o "$EXEC" main.swift

cp Info.plist "${BUNDLE}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${BUNDLE}/Contents/Info.plist" >/dev/null # validate
# Bump CFBundleVersion every build (epoch seconds) so the runtime installer ALWAYS redeploys the helper.
# install() copies the bundle ONLY when CFBundleVersion changed (computer-use-helper.ts), so a constant
# version silently left helper edits undeployed — the running binary stayed stale and the cg_key/reveal fixes
# never reached it (the 2026-06-24 self-test). TCC is keyed to the signing identity, not the version, so a
# bump never costs the user's grant.
HELPER_VER="$(date +%s)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${HELPER_VER}" "${BUNDLE}/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string ${HELPER_VER}" "${BUNDLE}/Contents/Info.plist"

# Brand the helper with the BlitzOS mark (so the FDA/Accessibility list + the drag tile show
# "BlitzOS" with the product icon, not the generic executable/helper icon).
ICON_SRC="../../src/renderer/src/assets/blitz-app-icon.png"
if [[ -f "$ICON_SRC" ]]; then
  ICONSET="build/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1
    d=$((s * 2)); sips -z "$d" "$d" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "${BUNDLE}/Contents/Resources/AppIcon.icns" 2>/dev/null && echo "[helper] icon: AppIcon.icns" || echo "[helper] icon gen failed (generic icon)"
  rm -rf "$ICONSET"
else
  echo "[helper] no icon source ($ICON_SRC) — generic icon"
fi

# Signing identity: explicit override → Developer ID in keychain → ad-hoc (-).
IDENTITY="${BLITZ_HELPER_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "[helper] no Developer ID identity found — ad-hoc signing (dev mechanics only; TCC identity not stable)"
  IDENTITY="-"
fi

echo "[helper] codesign as: ${IDENTITY}"
codesign --force --options runtime --timestamp \
  ${IDENTITY:+--sign "$IDENTITY"} \
  --entitlements entitlements.plist \
  "$BUNDLE"

codesign -dvv "$BUNDLE" 2>&1 | grep -iE "Identifier=|TeamIdentifier=|Authority=Developer" || true
echo "[helper] built ${BUNDLE}"
