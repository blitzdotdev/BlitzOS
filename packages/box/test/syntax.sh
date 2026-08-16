#!/usr/bin/env bash
set -euo pipefail

script_dir=$(realpath "$(dirname "$0")")
box_dir=$(realpath "$script_dir/..")

while IFS= read -r script; do
  bash -n "$script"
done < <(
  find "$box_dir/rootfs/usr/local/libexec" "$box_dir/rootfs/etc/s6-overlay/s6-rc.d" \
    -type f \( -name 'blitz-*' -o -name run \) -print
  find "$script_dir" -maxdepth 1 -type f -name '*.sh' -print
)

echo "PASS box shell syntax"
