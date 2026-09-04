#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E16 "$@"

if payload_lab_dry; then
  publish_variant e16-volume-cache
  pin_payload "$PUBLISHED_VERSION"
  dry_command "apply and record cached manifest mtime; POST machine stop/start"
  dry_command "assert baked boot, first tick re-applies from versions without changing cache mtime"
  experiment_pass "dry run: stop/start persistent-cache assertions"
fi

require_workspace
publish_variant e16-volume-cache
pin_payload "$PUBLISHED_VERSION"
payload_tick "$WORKSPACE_ID" >/dev/null 2>&1 || experiment_fail "initial updater tick failed"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "initial payload was not applied"
cache_identity=$(payload_cache_identity "$WORKSPACE_ID" "$PUBLISHED_VERSION") \
  || experiment_fail "cached manifest is absent"

cp_api POST "/machines/$MACHINE_ID/stop" >/dev/null \
  || experiment_fail "machine stop failed"
deadline=$(( $(date +%s) + 180 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  state=$(machine_json "$MACHINE_ID" "$WORKSPACE_ID" | jq -r .state)
  [ "$state" = stopped ] && break
  sleep 2
done
[ "${state:-}" = stopped ] || experiment_fail "machine did not reach stopped"
cp_api POST "/machines/$MACHINE_ID/start" >/dev/null \
  || experiment_fail "machine start failed"
wait_box_ssh "$WORKSPACE_ID" true 360 || experiment_fail "machine did not return after start"

boot_current=$(box_ssh "$WORKSPACE_ID" 'basename "$(readlink -f /opt/blitz/payload/current)"')
assert_equal "$boot_current" baked "started container did not begin on baked payload"
payload_tick "$WORKSPACE_ID" >/dev/null 2>&1 || experiment_fail "first post-start tick failed"
wait_payload_any_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" "$LAB_OUTCOME_TIMEOUT" applied up-to-date \
  || experiment_fail "pin was not re-applied after start"
wait_payload_current "$WORKSPACE_ID" "$PUBLISHED_VERSION" 30 \
  || experiment_fail "pin is not current after start"
after_identity=$(payload_cache_identity "$WORKSPACE_ID" "$PUBLISHED_VERSION")
assert_equal "$after_identity" "$cache_identity" "start re-downloaded the cached payload"
assert_payload_state_consistent "$WORKSPACE_ID" || experiment_fail "start left inconsistent state"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "stop/start booted baked then reused cached $PUBLISHED_VERSION without download"
