#!/bin/bash
# Build and sign BlitzDictation.app. Use a stable signing identity so macOS
# Microphone and Input Monitoring grants persist across rebuilds.
#
# One-time dev identity:
# Keychain Access > Certificate Assistant > Create a Certificate
# name "BlitzOS Dev", type "Code Signing", self-signed.
# Then export BLITZ_DICTATION_SIGN_IDENTITY="BlitzOS Dev".
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="BlitzDictation"
BUNDLE="build/${APP_NAME}.app"
EXEC_DIR="${BUNDLE}/Contents/MacOS"
RES_DIR="${BUNDLE}/Contents/Resources"
EXEC="${EXEC_DIR}/${APP_NAME}"
ARCH="${BLITZ_DICTATION_ARCH:-arm64}"

echo "[dictation] clean"
rm -rf build
mkdir -p "$EXEC_DIR" "$RES_DIR"

echo "[dictation] swift build (${ARCH})"
swift build -c release --arch "$ARCH"

cp ".build/${ARCH}-apple-macosx/release/${APP_NAME}" "$EXEC" 2>/dev/null || cp ".build/release/${APP_NAME}" "$EXEC"
cp Info.plist "${BUNDLE}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${BUNDLE}/Contents/Info.plist" >/dev/null

shopt -s nullglob
bundles=(.build/release/*.bundle ".build/${ARCH}-apple-macosx/release/"*.bundle)
for b in "${bundles[@]}"; do
  [[ -d "$b" ]] || continue
  rm -rf "$RES_DIR/$(basename "$b")"
  cp -R "$b" "$RES_DIR/"
done
if ! find "${BUNDLE}/Contents" -name "*FluidAudio*.bundle" -print -quit | grep -q .; then
  FLUID_BUNDLE="${RES_DIR}/FluidAudioResources.bundle"
  mkdir -p "${FLUID_BUNDLE}/Contents/Resources"
  cat > "${FLUID_BUNDLE}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.blitz.os.dictation.FluidAudioResources</string>
  <key>CFBundleName</key>
  <string>FluidAudioResources</string>
  <key>CFBundlePackageType</key>
  <string>BNDL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
</dict>
</plist>
PLIST
  cat > "${FLUID_BUNDLE}/Contents/Resources/BlitzFluidAudioResourceManifest.json" <<'JSON'
{
  "package": "FluidAudio",
  "vendoredBy": "BlitzOS",
  "sourceRevision": "ba6e4359fbb0d00b63e789354acc3f005641cfe4"
}
JSON
fi
shopt -u nullglob

ICON_SRC="../../src/renderer/src/assets/aqua-bubble.png"
if [[ -f "$ICON_SRC" ]]; then
  ICONSET="build/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1
    d=$((s * 2))
    sips -z "$d" "$d" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "${RES_DIR}/AppIcon.icns" 2>/dev/null && echo "[dictation] icon: AppIcon.icns" || echo "[dictation] icon gen failed"
  rm -rf "$ICONSET"
fi

IDENTITY="${BLITZ_DICTATION_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/BlitzOS Dev/{print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "[dictation] WARNING: ad-hoc signing -> code identity changes every rebuild -> Microphone + Input Monitoring grants RESET on each rebuild. Use a stable identity for grant persistence."
  IDENTITY="-"
fi

echo "[dictation] codesign as: ${IDENTITY}"
find "$BUNDLE" -name "*.bundle" -type d -print0 | while IFS= read -r -d '' nested; do
  [[ -f "$nested/Contents/Info.plist" ]] || continue
  if [[ "$IDENTITY" == "-" ]]; then
    codesign --force --sign - "$nested"
  else
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$nested"
  fi
done
if [[ "$IDENTITY" == "-" ]]; then
  codesign --force --sign - --entitlements entitlements.plist "$BUNDLE"
else
  codesign --force --options runtime --timestamp --sign "$IDENTITY" --entitlements entitlements.plist "$BUNDLE"
fi

codesign --verify --verbose "$BUNDLE"
codesign -dvv "$BUNDLE" 2>&1 | grep -iE "Identifier=|TeamIdentifier=|Authority=" || true
echo "[dictation] built ${BUNDLE}"
