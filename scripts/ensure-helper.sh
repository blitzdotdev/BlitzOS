#!/bin/bash
# predev hook (package.json "predev"): make sure the native macOS helpers BlitzOS needs at runtime exist before
# `npm run dev`, building each ONCE if missing (swiftc). macOS-only; NEVER blocks dev — a missing toolchain or a
# failed build just warns and continues.
#   1. Computer Use sidecar (BlitzOS.app) — the draggable helper the onboarding TCC pre-board needs
#      (issues/open/preboard-cu-helper-drag-missing-vm.md). Without it the pre-board drag is silently suppressed.
#   2. notch-geometry CLI — the EXACT physical-notch read for the bulletproof notch hit-window. Without it
#      readNotchGeometry returns null → no hit-window → the notch toggle is ⌥Space-only (the click band needs it).
set -uo pipefail
cd "$(dirname "$0")/.."

# Native macOS helpers — nothing to build (or need) off macOS.
[[ "$(uname -s)" == "Darwin" ]] || exit 0

have_swiftc=1
command -v swiftc >/dev/null 2>&1 || have_swiftc=0
if [[ "$have_swiftc" == "0" ]]; then
  echo "[ensure-helper] swiftc not found (install Xcode Command Line Tools: xcode-select --install) — dev runs" >&2
  echo "[ensure-helper] WITHOUT the Computer Use helper (TCC drag) and WITHOUT the notch hit-window (⌥Space-only)." >&2
  exit 0
fi

# 1) Computer Use helper (build once if missing).
CU_EXE="native/computer-use-helper/build/BlitzOS.app/Contents/MacOS/BlitzOS"
CU_DIR="native/computer-use-helper"
# (Re)build if MISSING or STALE — the source (.swift / Info.plist) is newer than the built binary. "build once if
# missing" silently left edits uncompiled (you'd edit main.swift, restart dev, and run the old binary). `-nt` closes
# that: any source edit rebuilds on the next dev. install() then re-copies it (its CFBundleVersion was bumped).
if [[ ! -x "$CU_EXE" || "$CU_DIR/main.swift" -nt "$CU_EXE" || "$CU_DIR/Info.plist" -nt "$CU_EXE" ]]; then
  echo "[ensure-helper] Computer Use helper missing or stale — (re)building ($CU_DIR/build.sh)"
  bash "$CU_DIR/build.sh" || echo "[ensure-helper] WARN: CU helper build failed — dev continues without it" >&2
fi

# 2) notch-geometry CLI (build if missing or the source changed).
NOTCH_BIN="native/notch-geometry/notch-geometry"
if [[ ! -x "$NOTCH_BIN" || "native/notch-geometry/main.swift" -nt "$NOTCH_BIN" ]]; then
  echo "[ensure-helper] notch-geometry missing or stale — (re)building (native/notch-geometry/build.sh)"
  bash native/notch-geometry/build.sh || echo "[ensure-helper] WARN: notch-geometry build failed — notch toggle is ⌥Space-only in dev" >&2
fi

exit 0
