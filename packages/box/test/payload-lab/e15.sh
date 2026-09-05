#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E15 "$@"

if payload_lab_dry; then
  dry_command "use a workspace already registered to LAB_OLD_CP_ORIGIN, whose box-config omits payload"
  dry_command "stop/start the machine; await its natural updater tick; assert baked, updater stays alive, and log has no error"
  experiment_pass "dry run: old-control-plane compatibility assertions"
fi

[ -n "${LAB_OLD_CP_ORIGIN:-}" ] \
  || experiment_skip "LAB_OLD_CP_ORIGIN is absent; no old control plane is available"
require_workspace
[[ "$LAB_OLD_CP_ORIGIN" =~ ^https://[^/]+$ ]] \
  || experiment_fail "LAB_OLD_CP_ORIGIN must be a bare HTTPS origin"
[ "${THINLAB_ORIGIN%/}" = "${LAB_OLD_CP_ORIGIN%/}" ] \
  || experiment_skip "harness origin is not the available old control plane"
box_origin=$(box_ssh "$WORKSPACE_ID" 'sed -n "1p" /var/lib/blitz/origin')
[ "${box_origin%/}" = "${LAB_OLD_CP_ORIGIN%/}" ] \
  || experiment_skip "workspace is not registered to the available old control plane"

log_offset=$(payload_log_size "$WORKSPACE_ID")
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
deadline=$(( $(date +%s) + LAB_OUTCOME_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  payload_log_since "$WORKSPACE_ID" "$log_offset" >"$LAB_TEMP_ROOT/payload.log" 2>/dev/null \
    || true
  grep -F "booted $baked_version daemon " "$LAB_TEMP_ROOT/payload.log" >/dev/null 2>&1 \
    && break
  sleep 2
done
grep -F "booted $baked_version daemon " "$LAB_TEMP_ROOT/payload.log" >/dev/null \
  || experiment_fail "new updater did not complete its natural tick against the old control plane"
after=$(payload_current "$WORKSPACE_ID")
after_pid=$(box_ssh "$WORKSPACE_ID" 'cat /run/service/payload/supervise/pid')
assert_equal "$after" "$baked_version" "missing payload field changed current"
assert_equal "$after_pid" "$before_pid" "payload service exited against old control plane"
if grep -Ei '(^|[^a-z])(error|failed|failure)([^a-z]|$)' "$LAB_TEMP_ROOT/payload.log" >/dev/null; then
  experiment_fail "missing payload field was logged as an error"
fi
assert_payload_state_consistent "$WORKSPACE_ID" || experiment_fail "old control plane changed state"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "missing payload field idled on baked; updater stayed alive; no error logged"
