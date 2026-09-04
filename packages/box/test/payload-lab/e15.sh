#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E15 "$@"

if payload_lab_dry; then
  dry_command "point new box at LAB_OLD_CP_ORIGIN fixture whose box-config omits payload"
  dry_command "stop/start the machine; run one updater tick; assert baked, updater stays alive, and log has no error"
  experiment_pass "dry run: old-control-plane compatibility assertions"
fi

require_workspace
require_env LAB_OLD_CP_ORIGIN
[[ "$LAB_OLD_CP_ORIGIN" =~ ^https://[^/]+$ ]] \
  || experiment_fail "LAB_OLD_CP_ORIGIN must be a bare HTTPS origin"
original_origin=$(box_ssh "$WORKSPACE_ID" 'sed -n "1p" /var/lib/blitz/origin')
arm_origin_restore "$WORKSPACE_ID" "$original_origin"
_write_box_origin "$WORKSPACE_ID" "$LAB_OLD_CP_ORIGIN"

cp_api POST "/machines/$MACHINE_ID/stop" >/dev/null \
  || experiment_fail "machine stop failed"
deadline=$(( $(date +%s) + 180 ))
state=
while [ "$(date +%s)" -lt "$deadline" ]; do
  state=$(machine_json "$MACHINE_ID" "$WORKSPACE_ID" | jq -r .state)
  [ "$state" = stopped ] && break
  sleep 2
done
[ "$state" = stopped ] || experiment_fail "machine did not reach stopped"
cp_api POST "/machines/$MACHINE_ID/start" >/dev/null \
  || experiment_fail "machine start failed"
wait_box_ssh "$WORKSPACE_ID" true 360 || experiment_fail "machine did not return after start"

boot_current=$(box_ssh "$WORKSPACE_ID" 'basename "$(readlink -f /opt/blitz/payload/current)"')
assert_equal "$boot_current" baked "box did not start on its baked payload"
baked_version=$(box_ssh "$WORKSPACE_ID" 'cat /opt/blitz/payload/baked/payload-version')
before_pid=$(box_ssh "$WORKSPACE_ID" 'cat /run/service/payload/supervise/pid')
payload_tick "$WORKSPACE_ID" >"$LAB_TEMP_ROOT/tick.log" 2>&1 \
  || experiment_fail "new updater failed against old control plane"
after=$(payload_current "$WORKSPACE_ID")
after_pid=$(box_ssh "$WORKSPACE_ID" 'cat /run/service/payload/supervise/pid')
assert_equal "$after" "$baked_version" "missing payload field changed current"
assert_equal "$after_pid" "$before_pid" "payload service exited against old control plane"
if grep -Ei '(^|[^a-z])(error|failed|failure)([^a-z]|$)' "$LAB_TEMP_ROOT/tick.log" >/dev/null; then
  experiment_fail "missing payload field was logged as an error"
fi
restore_box_origin
assert_payload_state_consistent "$WORKSPACE_ID" || experiment_fail "old control plane changed state"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "missing payload field idled on baked; updater stayed alive; no error logged"
