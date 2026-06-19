#!/bin/bash
# Build the native-mirror lab spike into build/NativeMirror.app (arm64, ad-hoc signed).
# Standalone AppKit app — NOT wired into BlitzOS. See README.md.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="NativeMirror"
BUNDLE="build/${APP_NAME}.app"
EXEC_DIR="${BUNDLE}/Contents/MacOS"
EXEC="${EXEC_DIR}/${APP_NAME}"
ARCH="${BLITZ_MIRROR_ARCH:-arm64}"

echo "[mirror] clean"
rm -rf build
mkdir -p "$EXEC_DIR" "${BUNDLE}/Contents/Resources"

echo "[mirror] swiftc -> ${EXEC} (${ARCH})"
# -swift-version 5: avoid Swift 6 strict-concurrency errors on SCStream delegate callbacks.
swiftc -O -swift-version 5 -target "${ARCH}-apple-macos13.0" \
  -framework AppKit -framework ScreenCaptureKit -framework CoreMedia -framework CoreVideo \
  -framework CoreGraphics -framework QuartzCore -framework IOSurface -framework ApplicationServices \
  -o "$EXEC" mirror.swift

cp Info.plist "${BUNDLE}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${BUNDLE}/Contents/Info.plist" >/dev/null # validate

# Sign with a STABLE identity so TCC grants (Screen Recording, Accessibility) survive rebuilds.
# Ad-hoc (-) changes the cdhash every build, so macOS invalidates the Accessibility grant each time
# and input silently dies — use the Developer ID identity when present (override with
# BLITZ_MIRROR_SIGN_IDENTITY), fall back to ad-hoc only if none exists.
IDENTITY="${BLITZ_MIRROR_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "[mirror] codesign (ad-hoc — TCC grants will NOT persist across rebuilds)"
  codesign --force --identifier dev.blitz.os.lab.mirror --entitlements entitlements.plist --sign - "$BUNDLE"
else
  echo "[mirror] codesign as: ${IDENTITY}"
  codesign --force --options runtime --identifier dev.blitz.os.lab.mirror --entitlements entitlements.plist --sign "$IDENTITY" "$BUNDLE"
fi

echo "[mirror] built ${BUNDLE}"
