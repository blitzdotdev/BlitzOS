#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E7 "$@"

if payload_lab_dry; then
  dry_command "publish and pin daemon payload; start updater and wait for .staging/pending"
  publish_variant daemon-e7-reset
  pin_payload "$PUBLISHED_VERSION"
  dry_command "POST Hetzner reset; assert boot is old or new, state consistent, and boot outcome reported"
  experiment_pass "dry run: mid-apply VM reset assertions"
fi

require_workspace
require_env HETZNER_API_TOKEN
old=$(payload_current "$WORKSPACE_ID")
before_report=$(payload_reported_at "$MACHINE_ID" "$WORKSPACE_ID")
publish_variant daemon-e7-reset
pin_payload "$PUBLISHED_VERSION"
payload_tick "$WORKSPACE_ID" >"$LAB_TEMP_ROOT/tick.log" 2>&1 &
tick_pid=$!

deadline=$(( $(date +%s) + LAB_OUTCOME_TIMEOUT ))
mid_apply=false
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(payload_staging_count "$WORKSPACE_ID" 2>/dev/null || true)" != 0 ] \
    || payload_state "$WORKSPACE_ID" 2>/dev/null | jq -e 'has("pending")' >/dev/null; then
    mid_apply=true
    break
  fi
  sleep 0.2
done
[ "$mid_apply" = true ] || experiment_fail "could not catch the updater mid-apply"
reset_ms=$(date +%s%3N)
hetzner_reset_machine "$MACHINE_ID" "$WORKSPACE_ID" \
  || experiment_fail "Hetzner reset request failed"
wait "$tick_pid" 2>/dev/null || true
wait_box_ssh "$WORKSPACE_ID" false 60 || payload_lab_trace "reset outage was shorter than SSH polling"
wait_box_ssh "$WORKSPACE_ID" true 240 || experiment_fail "box did not return after reset"

boot_current=$(payload_current "$WORKSPACE_ID")
case "$boot_current" in
  "$old" | "$PUBLISHED_VERSION") ;;
  *) experiment_fail "box booted a half/unknown payload $boot_current" ;;
esac
assert_payload_state_consistent "$WORKSPACE_ID" \
  || experiment_fail "state.json is inconsistent after reset"
wait_payload_any_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" "$LAB_OUTCOME_TIMEOUT" applied booted up-to-date \
  || experiment_fail "the booted updater did not report the pin"
after_report=$(payload_reported_at "$MACHINE_ID" "$WORKSPACE_ID")
[ "$after_report" -gt "$before_report" ] && [ "$after_report" -ge "$reset_ms" ] \
  || experiment_fail "control plane did not receive a boot-time report"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "reset recovered on $boot_current; state consistent; boot report received"
