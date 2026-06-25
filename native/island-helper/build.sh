#!/bin/bash
# Build + sign BlitzIsland.app — the faceless notch-HUD helper (plans/blitzos-dynamic-island.md).
# Native single-file Swift (pure AppKit), arm64. Output: native/island-helper/build/BlitzIsland.app
#
# Signing: prefers the "Developer ID Application" identity in the keychain (override with
# BLITZ_ISLAND_SIGN_IDENTITY). Ad-hoc fallback ('-') is for DEV MECHANICS ONLY — the TCC/hotkey
# identity is stable only when Developer-ID signed. The ad-hoc path deliberately drops --timestamp
# (it needs network) and hardened runtime so the build/codesign mechanics verify offline.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="BlitzIsland"
BUNDLE="build/${APP_NAME}.app"
EXEC_DIR="${BUNDLE}/Contents/MacOS"
EXEC="${EXEC_DIR}/${APP_NAME}"
ARCH="${BLITZ_ISLAND_ARCH:-arm64}"

echo "[island] clean"
rm -rf build
mkdir -p "$EXEC_DIR" "${BUNDLE}/Contents/Resources"

# Self-verifying scaffold: if there is no main.swift yet, drop a loud P0 STUB so the build/codesign
# mechanics are testable in CI/sandbox. The real island UI/hotkey/WS code replaces this.
if [[ ! -f main.swift ]]; then
  echo "[island] no main.swift — writing P0 STUB (replace with the real island window/hotkey/WS code)"
  cat > main.swift <<'SWIFT'
// BlitzIsland — P0 STUB. Replace with the real notch HUD (NSWindow at safeAreaInsets,
// concave NSBezierPath NotchShape, NSVisualEffectView glass, Carbon RegisterEventHotKey ⌥Space,
// URLSessionWebSocketTask to BlitzOS /island). See plans/blitzos-dynamic-island.md.
import AppKit
import Foundation
import CoreGraphics
import QuartzCore
import Carbon
let app = NSApplication.shared
app.setActivationPolicy(.accessory) // faceless agent; Info.plist LSUIElement also set
// touch RegisterEventHotKey so Carbon is genuinely linked (the whole reason it's a framework dep)
_ = RegisterEventHotKey
FileHandle.standardError.write(Data("BlitzIsland stub launched (replace main.swift)\n".utf8))
app.run()
SWIFT
fi

echo "[island] swiftc → ${EXEC} (${ARCH})"
swiftc -O -target "${ARCH}-apple-macos13.0" \
  -framework AppKit -framework Foundation -framework CoreGraphics \
  -framework QuartzCore -framework Carbon -framework SwiftUI \
  -o "$EXEC" main.swift

cp Info.plist "${BUNDLE}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${BUNDLE}/Contents/Info.plist" >/dev/null # validate

# Brand the island with the BlitzOS bubble mark (generic icon step; gracefully no-ops if absent).
ICON_SRC="../../src/renderer/src/assets/aqua-bubble.png"
if [[ -f "$ICON_SRC" ]]; then
  ICONSET="build/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1
    d=$((s * 2)); sips -z "$d" "$d" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "${BUNDLE}/Contents/Resources/AppIcon.icns" 2>/dev/null && echo "[island] icon: AppIcon.icns" || echo "[island] icon gen failed (generic icon)"
  rm -rf "$ICONSET"
else
  echo "[island] no icon source ($ICON_SRC) — generic icon"
fi

# Signing identity: explicit override → Developer ID in keychain → ad-hoc (-).
IDENTITY="${BLITZ_ISLAND_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "[island] no Developer ID identity found — ad-hoc signing (dev mechanics only; TCC/hotkey identity not stable)"
  IDENTITY="-"
fi

echo "[island] codesign as: ${IDENTITY}"
if [[ "$IDENTITY" == "-" ]]; then
  # ad-hoc: NO --timestamp (needs network), NO hardened runtime needed for dev mechanics
  codesign --force --sign - --entitlements entitlements.plist "$BUNDLE"
else
  codesign --force --options runtime --timestamp --sign "$IDENTITY" --entitlements entitlements.plist "$BUNDLE"
fi

codesign --verify --verbose "$BUNDLE"
codesign -dvv "$BUNDLE" 2>&1 | grep -iE "Identifier=|TeamIdentifier=|Authority=Developer" || true
echo "[island] built ${BUNDLE}"
