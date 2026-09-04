#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E8 "$@"

if payload_lab_dry; then
  dry_command "apply a payload and record its cached manifest mtime"
  publish_variant e8-before-image
  pin_payload "$PUBLISHED_VERSION"
  dry_command "request host image update; observe baked boot; run first tick; assert pin re-applied"
  experiment_pass "dry run: image replacement and first-tick reapply assertions"
fi

require_workspace
publish_variant e8-before-image
pin_payload "$PUBLISHED_VERSION"
payload_tick "$WORKSPACE_ID" >/dev/null 2>&1 || experiment_fail "initial updater tick failed"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "initial payload was not applied"
cache_identity=$(payload_cache_identity "$WORKSPACE_ID" "$PUBLISHED_VERSION") \
  || experiment_fail "cached manifest is absent"

box_ssh "$WORKSPACE_ID" 'blitz box update' >/dev/null \
  || experiment_fail "box image update request failed"
host_ssh "$WORKSPACE_ID" 'systemctl start blitz-box-update.service' \
  >"$LAB_TEMP_ROOT/image-update.log" 2>&1 &
update_pid=$!
wait_box_ssh "$WORKSPACE_ID" false 180 \
  || experiment_fail "container replacement never interrupted SSH"
wait_box_ssh "$WORKSPACE_ID" true 300 \
  || experiment_fail "replacement image did not boot"
wait "$update_pid" || experiment_fail "host image update failed"

boot_current=$(box_ssh "$WORKSPACE_ID" 'basename "$(readlink -f /opt/blitz/payload/current)"')
assert_equal "$boot_current" baked "replacement image did not boot its baked payload"
payload_tick "$WORKSPACE_ID" >/dev/null 2>&1 || experiment_fail "first payload tick failed"
wait_payload_any_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" "$LAB_OUTCOME_TIMEOUT" applied up-to-date \
  || experiment_fail "pin was not re-applied after image replacement"
wait_payload_current "$WORKSPACE_ID" "$PUBLISHED_VERSION" 30 \
  || experiment_fail "pin is not current after first tick"
after_identity=$(payload_cache_identity "$WORKSPACE_ID" "$PUBLISHED_VERSION")
assert_equal "$after_identity" "$cache_identity" "cached payload was downloaded again"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "replacement booted baked and first tick re-applied cached pin"
