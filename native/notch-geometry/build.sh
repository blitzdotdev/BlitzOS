#!/bin/bash
# Build the notch-geometry CLI (prints the physical notch rect as JSON; see main.swift). Plain single-file Swift,
# arm64, AppKit. Output: native/notch-geometry/notch-geometry. dist-mac.sh bundles + signs it into the .app
# Resources; in dev, src/main runs it straight from here. Ad-hoc sign is fine (no TCC/entitlement needed to read
# NSScreen geometry).
set -euo pipefail
cd "$(dirname "$0")"

OUT="notch-geometry"
ARCH="${BLITZ_NOTCH_ARCH:-arm64}"

echo "[notch-geometry] compiling ($ARCH)"
swiftc -O -target "${ARCH}-apple-macos12.0" -framework AppKit main.swift -o "$OUT"

# Ad-hoc codesign so it runs without quarantine friction in dev. dist-mac.sh re-signs with Developer ID.
codesign --force --sign - "$OUT" 2>/dev/null || true

echo "[notch-geometry] built -> $(pwd)/$OUT"
