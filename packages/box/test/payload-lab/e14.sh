#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E14 "$@"

if payload_lab_dry; then
  dry_command "read two member-machine ids from one workspace"
  publish_variant e14-two-machines
  pin_payload "$PUBLISHED_VERSION"
  dry_command "assert each machine independently reports applied for the same version"
  experiment_pass "dry run: two-member-machine rollout assertions"
fi

require_workspace
mapfile -t machines < <(workspace_json "$WORKSPACE_ID" | jq -r \
  '.workspace.members[].machine | select(. != null and .state == "running") | .id' | sort -u)
[ "${#machines[@]}" -ge 2 ] || experiment_fail "workspace needs two running member machines"
first=${machines[0]}
second=${machines[1]}
[ "$first" != "$second" ] || experiment_fail "member machines are not independent rows"

publish_variant e14-two-machines
pin_payload "$PUBLISHED_VERSION"
# One deployment-wide pin reaches both independently supervised payload loops.
payload_tick "$WORKSPACE_ID" >/dev/null 2>&1 || experiment_fail "requesting member updater tick failed"
wait_payload_outcome "$first" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "first member machine did not report applied"
wait_payload_outcome "$second" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "second member machine did not independently report applied"
first_report=$(payload_reported_at "$first" "$WORKSPACE_ID")
second_report=$(payload_reported_at "$second" "$WORKSPACE_ID")
[ "$first_report" -gt 0 ] && [ "$second_report" -gt 0 ] \
  || experiment_fail "one member machine has no report timestamp"
experiment_pass "machines $first and $second independently reported $PUBLISHED_VERSION"
