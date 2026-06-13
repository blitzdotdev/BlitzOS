#!/bin/bash
# Build + sign BlitzComputerUse.app — the separate computer-use TCC helper
# (plans/blitzos-computer-use-helper.md). Native Swift, arm64, Developer-ID signed so its TCC
# identity is stable. Output: native/computer-use-helper/build/BlitzComputerUse.app
#
# Signing: uses the "Developer ID Application" identity from the keychain (override with
# BLITZ_HELPER_SIGN_IDENTITY). Unsigned ad-hoc fallback for dev mechanics testing (TCC identity is
# only real when Developer-ID signed — see the plan's "honest constraints").
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="BlitzComputerUse"
BUNDLE="build/${APP_NAME}.app"
EXEC_DIR="${BUNDLE}/Contents/MacOS"
EXEC="${EXEC_DIR}/${APP_NAME}"
ARCH="${BLITZ_HELPER_ARCH:-arm64}"

echo "[helper] clean"
rm -rf build
mkdir -p "$EXEC_DIR" "${BUNDLE}/Contents/Resources"

echo "[helper] swiftc → ${EXEC} (${ARCH})"
swiftc -O -target "${ARCH}-apple-macos13.0" -framework AppKit -framework CoreGraphics -framework ApplicationServices \
  -o "$EXEC" main.swift

cp Info.plist "${BUNDLE}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${BUNDLE}/Contents/Info.plist" >/dev/null # validate

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
