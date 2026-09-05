#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E10 "$@"

if payload_lab_dry; then
  publish_variant e10-older
  dry_command "pin older and wait for a natural tick to apply it"
  publish_variant e10-newer
  dry_command "pin newer and await apply; pin older again and await a normal applied downgrade"
  experiment_pass "dry run: older payload downgrade assertions"
fi

require_workspace
publish_variant e10-older
older_version=$PUBLISHED_VERSION
pin_payload "$older_version"
wait_payload_outcome "$MACHINE_ID" "$older_version" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "older payload was not initially applied"

publish_variant e10-newer
newer_version=$PUBLISHED_VERSION
pin_payload "$newer_version"
wait_payload_outcome "$MACHINE_ID" "$newer_version" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "newer payload was not applied"

pin_payload "$older_version"
wait_payload_outcome "$MACHINE_ID" "$older_version" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "downgrade did not apply like another version"
assert_equal "$(payload_current "$WORKSPACE_ID")" "$older_version" \
  "older payload is not current after downgrade"
assert_payload_state_consistent "$WORKSPACE_ID" || experiment_fail "downgrade left inconsistent state"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "older $older_version applied normally after newer $newer_version"
