#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E9 "$@"

if payload_lab_dry; then
  dry_command "pin unreachable, 401, and 5xx manifest URLs while leaving the root-owned box origin untouched"
  dry_command "wait for natural ticks; assert fetch-failed, current unchanged, one attempt with no tight retry, then restore the healthy pin"
  experiment_pass "dry run: control-plane failure and recovery assertions"
fi

require_workspace
require_env LAB_401_ORIGIN
require_env LAB_5XX_ORIGIN
for origin in "$LAB_401_ORIGIN" "$LAB_5XX_ORIGIN"; do
  [[ "$origin" =~ ^https://[^/]+$ ]] || experiment_fail "fixture origins must be bare HTTPS origins"
done
before_current=$(payload_current "$WORKSPACE_ID")
run_id=${LAB_RUN_ID:-$(date -u +%Y%m%dT%H%M%S)-$$}
run_id=${run_id//[^A-Za-z0-9._+-]/-}
durations=()

for pair in \
  "unreachable|https://127.0.0.1:9" \
  "401|$LAB_401_ORIGIN" \
  "5xx|$LAB_5XX_ORIGIN"; do
  label=${pair%%|*}
  origin=${pair#*|}
  version="e9-$label-$run_id"
  ref="$origin/box-payload/$version/manifest.json"
  before_report=$(payload_reported_at "$MACHINE_ID" "$WORKSPACE_ID")
  log_offset=$(payload_log_size "$WORKSPACE_ID")
  pin_payload_ref "$version" "$ref"
  started=$(date +%s)
  wait_payload_outcome_after \
    "$MACHINE_ID" "$WORKSPACE_ID" fetch-failed "$before_report" "$LAB_OUTCOME_TIMEOUT" \
    || experiment_fail "$label manifest failure did not report fetch-failed"
  duration=$(( $(date +%s) - started ))
  payload_log_since "$WORKSPACE_ID" "$log_offset" >"$LAB_TEMP_ROOT/$label.log" \
    || experiment_fail "$label updater log was unreadable"
  attempt="fetch-failed $before_current: attempted $version;"
  attempts=$(grep -Fc "$attempt" "$LAB_TEMP_ROOT/$label.log" || true)
  assert_equal "$attempts" 1 "$label manifest was attempted $attempts times in one scheduled tick"
  sleep 5
  payload_log_since "$WORKSPACE_ID" "$log_offset" >"$LAB_TEMP_ROOT/$label-after.log" \
    || experiment_fail "$label updater log was unreadable after the retry guard window"
  attempts=$(grep -Fc "$attempt" "$LAB_TEMP_ROOT/$label-after.log" || true)
  assert_equal "$attempts" 1 "$label manifest entered a tight retry loop ($attempts attempts in 5s)"
  assert_equal "$(payload_current "$WORKSPACE_ID")" "$before_current" \
    "$label failure changed current"
  durations+=("$label:${duration}s")
done

pin_payload "$before_current"
wait_payload_outcome "$MACHINE_ID" "$before_current" up-to-date "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "box did not report after the healthy manifest pin was restored"
assert_equal "$(payload_current "$WORKSPACE_ID")" "$before_current" \
  "recovery changed the current payload"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "unreachable/401/5xx each attempted once per tick (${durations[*]}); current kept; reporting recovered"
