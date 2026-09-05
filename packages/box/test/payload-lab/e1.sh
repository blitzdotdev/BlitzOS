#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E1 "$@"

if payload_lab_dry; then
  publish_variant e1-script
  turn_id=$(start_turn "$WORKSPACE_ID" "request one shell command" ask)
  dry_command "wait for exact session $turn_id to request permission; snapshot service pids"
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait up to ${LAB_OUTCOME_TIMEOUT}s for the normal updater poll; assert applied, no service pid changed, marker is used by a new tab"
  set_turn_permissions "$WORKSPACE_ID" "$turn_id" allow
  wait_turn "$WORKSPACE_ID" "$turn_id" "$LAB_TURN_TIMEOUT"
  dry_command "assert the exact session completed with the expected text"
  experiment_pass "dry run: script-only in-flight-turn assertions"
fi

require_workspace
publish_variant e1-script
expected_text=${LAB_E1_EXPECTED_TEXT:-E1-PAYLOAD-LAB-DONE}
turn_prompt=${LAB_E1_PROMPT:-"Use the shell to run exactly: touch /tmp/blitz-payload-lab-e1 && rm -f /tmp/blitz-payload-lab-e1. Do not answer before the command succeeds. Then reply exactly $expected_text."}
turn_id=$(start_turn "$WORKSPACE_ID" "$turn_prompt" ask) \
  || experiment_fail "could not start the E1 turn"
arm_turn_cleanup "$WORKSPACE_ID" "$turn_id"
wait_turn_permission "$WORKSPACE_ID" "$turn_id" 120 "$LAB_TEMP_ROOT/permission.json" \
  || experiment_fail "the E1 session did not reach its own permission request"
before_pids=$(service_pids "$WORKSPACE_ID")

pin_payload "$PUBLISHED_VERSION"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "normal updater poll did not report applied within ${LAB_OUTCOME_TIMEOUT}s"
wait_payload_current "$WORKSPACE_ID" "$PUBLISHED_VERSION" 30 \
  || experiment_fail "new payload is not current"

after_pids=$(service_pids "$WORKSPACE_ID")
assert_equal "$after_pids" "$before_pids" "a service restarted for a restart-free blitz-term change"
box_ssh "$WORKSPACE_ID" \
  "grep -F -- '$PUBLISHED_MARKER' /usr/local/libexec/blitz-term >/dev/null" \
  || experiment_fail "a newly resolved blitz-term does not use the new script"
set_turn_permissions "$WORKSPACE_ID" "$turn_id" allow >/dev/null \
  || experiment_fail "could not allow the exact E1 session's pending request"
wait_turn "$WORKSPACE_ID" "$turn_id" "$LAB_TURN_TIMEOUT" >"$LAB_TEMP_ROOT/turn.json" \
  || experiment_fail "the in-flight turn did not complete"
assert_completed_turn_text "$LAB_TEMP_ROOT/turn.json" "$expected_text" \
  "the E1 session completed without the expected text '$expected_text'"
disarm_turn_cleanup
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "exact turn completed with '$expected_text'; new tabs resolve the script; applied with zero service restarts"
