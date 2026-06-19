#!/bin/bash
# Run the native-mirror spike. Execs the binary from your terminal so logs print here (the TCC grants
# then attach to your terminal app — grant Screen Recording + Accessibility once).
#
#   ./run.sh --name "IntelliJ"
#   ./run.sh --app com.google.Chrome --offset 600 0
#
# To give the mirror its OWN TCC identity instead, launch the bundle via LaunchServices:
#   open build/NativeMirror.app --args --name "IntelliJ"
# (logs then go to Console.app, filter for NativeMirror.)
set -euo pipefail
cd "$(dirname "$0")"

BIN="build/NativeMirror.app/Contents/MacOS/NativeMirror"
[[ -x "$BIN" ]] || { echo "not built — run ./build.sh first"; exit 1; }
exec "$BIN" "$@"
