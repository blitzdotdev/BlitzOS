#!/usr/bin/env bash
set -euo pipefail

LAB=${BLITZ_LAB:-"$HOME/blitz-microvm-lab"}
SOURCE=${BLITZ_BASE_SOURCE:-"$LAB/rootfs/blitz-box-base.ext4"}
OUTPUT=${BLITZ_M2_BASE_OUTPUT:-"$LAB/rootfs/blitz-box-base-m2-v3.ext4"}
INIT=${BLITZ_M2_INIT:-"$LAB/recipe/m2/microvm-init"}
ENROLL=${BLITZ_M2_ENROLL:-"$LAB/recipe/m2/blitz-microvm-enroll.js"}

for required in "$SOURCE" "$INIT" "$ENROLL"; do
  [[ -f "$required" ]] || { echo "missing $required" >&2; exit 1; }
done
[[ ! -e "$OUTPUT" ]] || { echo "refusing to overwrite versioned image $OUTPUT" >&2; exit 1; }

stage="$OUTPUT.building"
rm -f -- "$stage"
cp --reflink=auto --sparse=always "$SOURCE" "$stage"
chmod 0600 "$stage"

replace_file() {
  local source=$1 destination=$2 mode=$3
  if debugfs -R "stat $destination" "$stage" 2>/dev/null | grep -q '^Inode:'; then
    debugfs -w -R "rm $destination" "$stage" >/dev/null
  fi
  debugfs -w -R "write $source $destination" "$stage" >/dev/null
  debugfs -w -R "set_inode_field $destination mode $mode" "$stage" >/dev/null
  debugfs -w -R "set_inode_field $destination uid 0" "$stage" >/dev/null
  debugfs -w -R "set_inode_field $destination gid 0" "$stage" >/dev/null
  debugfs -R "stat $destination" "$stage" | grep -Eq "Mode:.*0755"
}

replace_file "$INIT" /microvm-init 0100755
replace_file "$ENROLL" /usr/local/libexec/blitz-microvm-enroll.js 0100755
e2fsck -fy "$stage" >/dev/null
chmod 0444 "$stage"
mv "$stage" "$OUTPUT"
sha256sum "$OUTPUT" >"$OUTPUT.sha256"
e2fsck -fn "$OUTPUT"
