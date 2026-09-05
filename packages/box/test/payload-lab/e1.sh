#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E1 "$@"

if payload_lab_dry; then
  publish_variant e1-script
  turn_id=$(start_turn "$WORKSPACE_ID" "run a long command")
  dry_command "wait for exact session $turn_id to report running; snapshot service pids"
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait up to ${LAB_OUTCOME_TIMEOUT}s for the normal updater poll; assert applied, no service pid changed, marker is used by a new tab"
  wait_turn "$WORKSPACE_ID" "$turn_id" "$LAB_TURN_TIMEOUT"
  dry_command "assert the exact session completed with the expected text"
  experiment_pass "dry run: script-only in-flight-turn assertions"
fi

require_workspace
publish_variant e1-script
turn_seconds=${LAB_E1_TURN_SECONDS:-$(( LAB_OUTCOME_TIMEOUT + 180 ))}
expected_text=${LAB_E1_EXPECTED_TEXT:-done}
turn_prompt=${LAB_E1_PROMPT:-"Use the shell to run 'sleep $turn_seconds' and wait for it to finish, then reply $expected_text."}
turn_id=$(start_turn "$WORKSPACE_ID" "$turn_prompt") \
  || experiment_fail "could not start the E1 turn"
arm_turn_cleanup "$WORKSPACE_ID" "$turn_id"
wait_session_state "$WORKSPACE_ID" "$turn_id" running 90 >/dev/null \
  || experiment_fail "the E1 session did not report its own turn running"
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
wait_turn "$WORKSPACE_ID" "$turn_id" "$LAB_TURN_TIMEOUT" >"$LAB_TEMP_ROOT/turn.json" \
  || experiment_fail "the in-flight turn did not complete"
assert_completed_turn_text "$LAB_TEMP_ROOT/turn.json" "$expected_text" \
  "the E1 session completed without the expected text '$expected_text'"
disarm_turn_cleanup
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "exact turn completed with '$expected_text'; new tabs resolve the script; applied with zero service restarts"
