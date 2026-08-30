#!/usr/bin/env bash
set -euo pipefail

script_dir=$(realpath "$(dirname "$0")")
box_dir=$(realpath "$script_dir/..")

# Every /usr/local/bin entry is POSIX sh. `claude` and `codex` are PATH shims:
# a syntax error in one does not degrade a tab, it removes the version pin the
# shim exists to hold. What each shim must CONTAIN is pinned in
# box/guest-tests/test/agent-shims.test.ts, which runs without docker.
for shim in blitz claude codex; do
  sh -n "$box_dir/rootfs/usr/local/bin/$shim"
done

while IFS= read -r script; do
  bash -n "$script"
done < <(
  find "$box_dir/rootfs/usr/local/libexec" "$box_dir/rootfs/etc/s6-overlay/s6-rc.d" \
    -type f \( -name 'blitz-*' -o -name run \) -print
  find "$script_dir" -maxdepth 1 -type f -name '*.sh' -print
)

echo "PASS box shell syntax"
