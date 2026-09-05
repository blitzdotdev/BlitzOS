#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E5 "$@"

if payload_lab_dry; then
  dry_command "snapshot current payload and every service pid"
  for variant in e5-archive-sha e5-file-sha e5-bad-manifest; do
    publish_variant "$variant"
    pin_payload "$PUBLISHED_VERSION"
    dry_command "wait for a natural updater tick; assert $variant reports verify-failed with current and service pids unchanged"
  done
  experiment_pass "dry run: archive, file, and manifest verification assertions"
fi

require_workspace
before_current=$(payload_current "$WORKSPACE_ID")
before_pids=$(service_pids "$WORKSPACE_ID")

for variant in e5-archive-sha e5-file-sha e5-bad-manifest; do
  publish_variant "$variant"
  version=$PUBLISHED_VERSION
  before_report=$(payload_reported_at "$MACHINE_ID" "$WORKSPACE_ID")
  log_offset=$(payload_log_size "$WORKSPACE_ID")
  pin_payload "$version"
  wait_payload_failure \
    "$MACHINE_ID" "$WORKSPACE_ID" "$version" verify-failed "$before_report" "$LAB_OUTCOME_TIMEOUT" \
    || experiment_fail "$variant did not report verify-failed"
  payload_log_since "$WORKSPACE_ID" "$log_offset" >"$LAB_TEMP_ROOT/$variant.log" \
    || experiment_fail "$variant updater log was unreadable"
  grep -F "verify-failed $before_current: attempted $version;" \
    "$LAB_TEMP_ROOT/$variant.log" >/dev/null \
    || experiment_fail "$variant was not attributed to its attempted version in the updater log"
  assert_equal "$(payload_current "$WORKSPACE_ID")" "$before_current" \
    "$variant changed current"
  assert_equal "$(service_pids "$WORKSPACE_ID")" "$before_pids" \
    "$variant restarted a service"
done
assert_payload_state_consistent "$WORKSPACE_ID" \
  || experiment_fail "state is inconsistent after verification failures"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "archive sha, file sha, and bad manifest each verify-failed without switch or restart"
