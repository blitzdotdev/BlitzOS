#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E12 "$@"

if payload_lab_dry; then
  dry_command "snapshot current payload"
  publish_variant e12-min-updater-99
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait for a natural updater tick; assert unsupported, current unchanged, and MachineView carries unsupported"
  experiment_pass "dry run: minUpdater compatibility assertions"
fi

require_workspace
before=$(payload_current "$WORKSPACE_ID")
publish_variant e12-min-updater-99
before_report=$(payload_reported_at "$MACHINE_ID" "$WORKSPACE_ID")
log_offset=$(payload_log_size "$WORKSPACE_ID")
pin_payload "$PUBLISHED_VERSION"
wait_payload_failure \
  "$MACHINE_ID" "$WORKSPACE_ID" "$PUBLISHED_VERSION" unsupported "$before_report" "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "control plane did not mark machine unsupported/image-update-needed"
payload_log_since "$WORKSPACE_ID" "$log_offset" >"$LAB_TEMP_ROOT/payload.log" \
  || experiment_fail "unsupported updater log was unreadable"
grep -F "unsupported $before: attempted $PUBLISHED_VERSION;" \
  "$LAB_TEMP_ROOT/payload.log" >/dev/null \
  || experiment_fail "updater log did not attribute unsupported to the attempted version"
assert_equal "$(payload_current "$WORKSPACE_ID")" "$before" \
  "unsupported payload changed current"
machine_outcome=$(machine_json "$MACHINE_ID" "$WORKSPACE_ID" | jq -r .payloadOutcome)
assert_equal "$machine_outcome" unsupported "MachineView does not expose the image-update-needed mark"
assert_payload_state_consistent "$WORKSPACE_ID" || experiment_fail "unsupported result left inconsistent state"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "minUpdater 99 reported unsupported; machine marked; current unchanged"
