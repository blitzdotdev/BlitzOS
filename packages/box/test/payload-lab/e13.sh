#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E13 "$@"

if payload_lab_dry; then
  dry_command "read the machine type from the workspace view and assert its catalog memory is <=8 GB"
  dry_command "start one uniquely named tmux session running npm test; verify payload updater is in system slice"
  publish_variant e13-pressure
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait for a bounded natural tick under memory pressure; assert old-or-new consistent state and no half apply"
  experiment_pass "dry run: memory-pressure apply assertions"
fi

require_workspace
machine_view=$(machine_json "$MACHINE_ID" "$WORKSPACE_ID") \
  || experiment_fail "E13 machine is absent from the workspace view"
machine_type=$(printf '%s' "$machine_view" | jq -er .machineTypeId)
type_view=$(machine_type_json "$machine_type") \
  || experiment_fail "workspace machine type $machine_type is absent from /machine-types"
memory_gb=$(printf '%s' "$type_view" | jq -er '.memGb | numbers')
printf '%s' "$type_view" | jq -e '.memGb <= 8' >/dev/null \
  || experiment_fail "E13 requires a machine with <=8 GB, found $machine_type with ${memory_gb} GB"
load_command=${LAB_E13_COMMAND:-'cd /workspace && npm test'}
quoted_load=$(printf '%q' "$load_command")
run_id=${LAB_RUN_ID:-$(date -u +%Y%m%dT%H%M%S)-$$}
run_id=${run_id//[^A-Za-z0-9_-]/-}
pressure_session="payload-lab-e13-$run_id"
box_ssh "$WORKSPACE_ID" \
  "! tmux has-session -t '=$pressure_session' 2>/dev/null" \
  || experiment_fail "refusing to replace existing tmux session $pressure_session"
box_ssh "$WORKSPACE_ID" \
  "tmux new-session -d -s '$pressure_session' bash -lc $quoted_load" \
  || experiment_fail "could not start npm test pressure session"
LAB_REMOTE_CLEANUP_WORKSPACE=$WORKSPACE_ID
LAB_REMOTE_CLEANUP_COMMAND="tmux kill-session -t '=$pressure_session' 2>/dev/null || true"
box_ssh "$WORKSPACE_ID" "tmux has-session -t '=$pressure_session'" \
  || experiment_fail "npm test pressure session exited before apply"
payload_group=$(box_ssh "$WORKSPACE_ID" \
  'pid=$(pgrep -f "^node /usr/local/libexec/blitz-payload" | head -1); sed -n "s|^0::||p" "/proc/$pid/cgroup"')
assert_equal "$payload_group" /blitz-system.slice \
  "payload updater is outside the reserved system slice"

before=$(payload_current "$WORKSPACE_ID")
publish_variant e13-pressure
before_report=$(payload_reported_at "$MACHINE_ID" "$WORKSPACE_ID")
log_offset=$(payload_log_size "$WORKSPACE_ID")
pin_payload "$PUBLISHED_VERSION"
started=$(date +%s)
outcome_timeout=${LAB_E13_TIMEOUT:-$LAB_OUTCOME_TIMEOUT}
[ "$outcome_timeout" -ge 420 ] \
  || experiment_fail "LAB_E13_TIMEOUT must be at least 420s for a natural updater tick"
wait_payload_any_outcome_after \
  "$MACHINE_ID" "$WORKSPACE_ID" "$before_report" "$outcome_timeout" \
  applied rolled-back start-failed verify-failed fetch-failed \
  || experiment_fail "updater did not report a bounded terminal outcome under pressure"
duration=$(( $(date +%s) - started ))
[ "$duration" -le "$outcome_timeout" ] \
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
case "$outcome" in
  applied)
    assert_equal "$reported_version" "$PUBLISHED_VERSION" \
      "control plane did not record the applied pressure-run payload"
    ;;
  rolled-back | start-failed | verify-failed)
    wait_payload_failure \
      "$MACHINE_ID" "$WORKSPACE_ID" "$PUBLISHED_VERSION" "$outcome" "$before_report" 5 \
      || experiment_fail "state.json did not attribute $outcome to the pressure-run payload"
    ;;
  fetch-failed)
    payload_log_since "$WORKSPACE_ID" "$log_offset" >"$LAB_TEMP_ROOT/payload.log" \
      || experiment_fail "pressure-run updater log was unreadable"
    grep -F "fetch-failed $before: attempted $PUBLISHED_VERSION;" \
      "$LAB_TEMP_ROOT/payload.log" >/dev/null \
      || experiment_fail "updater log did not attribute fetch-failed to the pressure-run payload"
    ;;
  *) experiment_fail "updater did not report a bounded terminal outcome ($outcome)" ;;
esac
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "$machine_type/${memory_gb}GB; updater stayed in system slice; terminal outcome $outcome in ${duration}s; no half state"
