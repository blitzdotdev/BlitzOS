#!/bin/bash
# predev hook (package.json "predev"): make sure the Computer Use sidecar (BlitzComputerUse.app) exists
# before `npm run dev`, so a fresh checkout has the draggable helper the onboarding TCC pre-board needs
# (issues/open/preboard-cu-helper-drag-missing-vm.md — without it, computerUseHelper().available() is
# false, currentDragBundle is null, and the pre-board drag is silently suppressed = nothing to drag).
#
# Builds it ONLY when missing (native/computer-use-helper/build.sh: swiftc + Developer-ID/ad-hoc sign).
# macOS-only, and it NEVER blocks dev: a missing toolchain or a failed build just warns and continues
# (dev can run without the helper, you simply can't exercise the real TCC drag in dev anyway).
set -uo pipefail
cd "$(dirname "$0")/.."

EXE="native/computer-use-helper/build/BlitzComputerUse.app/Contents/MacOS/BlitzComputerUse"

# The helper is a native macOS .app — there is nothing to build (or need) off macOS.
[[ "$(uname -s)" == "Darwin" ]] || exit 0

# Already built → fast no-op (this runs before EVERY `npm run dev`).
[[ -x "$EXE" ]] && exit 0

if ! command -v swiftc >/dev/null 2>&1; then
  echo "[ensure-helper] swiftc not found (install Xcode Command Line Tools: xcode-select --install) —" >&2
  echo "[ensure-helper] dev will run WITHOUT the Computer Use helper; the onboarding TCC drag is unavailable." >&2
  exit 0
fi

echo "[ensure-helper] Computer Use helper missing — building it once (native/computer-use-helper/build.sh)"
bash native/computer-use-helper/build.sh || echo "[ensure-helper] WARN: helper build failed — dev continues without it" >&2
exit 0
