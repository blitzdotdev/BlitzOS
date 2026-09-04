#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E10 "$@"

if payload_lab_dry; then
  publish_variant e10-older
  dry_command "pin older and assert applied"
  publish_variant e10-newer
  dry_command "pin newer and assert applied; pin older again and assert normal applied downgrade"
  experiment_pass "dry run: older payload downgrade assertions"
fi

require_workspace
publish_variant e10-older
older_version=$PUBLISHED_VERSION
pin_payload "$older_version"
payload_tick "$WORKSPACE_ID" >/dev/null 2>&1 || experiment_fail "older apply tick failed"
wait_payload_outcome "$MACHINE_ID" "$older_version" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "older payload was not initially applied"

publish_variant e10-newer
newer_version=$PUBLISHED_VERSION
pin_payload "$newer_version"
payload_tick "$WORKSPACE_ID" >/dev/null 2>&1 || experiment_fail "newer apply tick failed"
wait_payload_outcome "$MACHINE_ID" "$newer_version" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "newer payload was not applied"

pin_payload "$older_version"
payload_tick "$WORKSPACE_ID" >/dev/null 2>&1 || experiment_fail "downgrade tick failed"
wait_payload_outcome "$MACHINE_ID" "$older_version" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "downgrade did not apply like another version"
assert_equal "$(payload_current "$WORKSPACE_ID")" "$older_version" \
  "older payload is not current after downgrade"
assert_payload_state_consistent "$WORKSPACE_ID" || experiment_fail "downgrade left inconsistent state"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "older $older_version applied normally after newer $newer_version"
