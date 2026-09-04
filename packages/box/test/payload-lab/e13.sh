#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E13 "$@"

if payload_lab_dry; then
  dry_command "assert cx23; start tmux session running npm test; verify payload updater is in system slice"
  publish_variant e13-pressure
  pin_payload "$PUBLISHED_VERSION"
  dry_command "run bounded updater under memory pressure; assert old-or-new consistent state and no half apply"
  experiment_pass "dry run: memory-pressure apply assertions"
fi

require_workspace
machine_type=$(machine_json "$MACHINE_ID" "$WORKSPACE_ID" | jq -r .machineTypeId)
[[ "$machine_type" = cx23@* || "$machine_type" = cx23 ]] \
  || experiment_fail "E13 requires cx23, found $machine_type"
load_command=${LAB_E13_COMMAND:-'cd /workspace && npm test'}
quoted_load=$(printf '%q' "$load_command")
box_ssh "$WORKSPACE_ID" \
  "tmux kill-session -t payload-lab-e13 2>/dev/null || true; tmux new-session -d -s payload-lab-e13 bash -lc $quoted_load" \
  || experiment_fail "could not start npm test pressure session"
LAB_REMOTE_CLEANUP_WORKSPACE=$WORKSPACE_ID
LAB_REMOTE_CLEANUP_COMMAND='tmux kill-session -t payload-lab-e13 2>/dev/null || true'
box_ssh "$WORKSPACE_ID" 'tmux has-session -t payload-lab-e13' \
  || experiment_fail "npm test pressure session exited before apply"
payload_group=$(box_ssh "$WORKSPACE_ID" \
  'pid=$(cat /run/service/payload/supervise/pid); sed -n "s|^0::||p" "/proc/$pid/cgroup"')
assert_equal "$payload_group" /blitz-system.slice \
  "payload updater is outside the reserved system slice"

before=$(payload_current "$WORKSPACE_ID")
publish_variant e13-pressure
pin_payload "$PUBLISHED_VERSION"
started=$(date +%s)
payload_tick "$WORKSPACE_ID" >"$LAB_TEMP_ROOT/tick.log" 2>&1 \
  || experiment_fail "updater escaped its fail-open loop under pressure"
duration=$(( $(date +%s) - started ))
[ "$duration" -le "${LAB_E13_TIMEOUT:-180}" ] \
  || experiment_fail "pressure apply was unbounded (${duration}s)"
current=$(payload_current "$WORKSPACE_ID")
case "$current" in
  "$before" | "$PUBLISHED_VERSION") ;;
  *) experiment_fail "memory pressure exposed half payload $current" ;;
esac
assert_payload_state_consistent "$WORKSPACE_ID" \
  || experiment_fail "memory pressure left state inconsistent"
outcome=$(machine_json "$MACHINE_ID" "$WORKSPACE_ID" | jq -r '.payloadOutcome // "null"')
reported_version=$(machine_json "$MACHINE_ID" "$WORKSPACE_ID" | jq -r '.payloadVersion // "null"')
assert_equal "$reported_version" "$PUBLISHED_VERSION" \
  "control plane did not receive the pressure-run payload result"
case "$outcome" in
  applied | rolled-back | start-failed | verify-failed | fetch-failed) ;;
  *) experiment_fail "updater did not report a bounded terminal outcome ($outcome)" ;;
esac
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "updater stayed in system slice; terminal outcome $outcome in ${duration}s; no half state"
