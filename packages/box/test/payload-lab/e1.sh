#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E1 "$@"

if payload_lab_dry; then
  turn_id=$(start_turn "$WORKSPACE_ID" "run a long command")
  wait_turn "$WORKSPACE_ID" "$turn_id" "${LAB_TURN_TIMEOUT:-900}"
  dry_command "snapshot service pids and the started session"
  publish_variant e1-script
  pin_payload "$PUBLISHED_VERSION"
  dry_command "run updater; assert applied, no service pid changed, marker is used by a new tab, turn completes"
  experiment_pass "dry run: script-only in-flight-turn assertions"
fi

require_workspace
turn_prompt=${LAB_E1_PROMPT:-"Use the shell to run 'sleep ${LAB_E1_TURN_SECONDS:-300}' and wait for it to finish, then reply done."}
turn_id=$(start_turn "$WORKSPACE_ID" "$turn_prompt") \
  || experiment_fail "could not start the E1 turn"
wait_session_running "$WORKSPACE_ID" 60 || experiment_fail "the E1 turn did not become active"
started_status=$(node "$PAYLOAD_LAB_SESSION_DRIVER" session status "$turn_id") \
  || experiment_fail "the E1 session did not sync back"
printf '%s' "$started_status" | jq -e '.state == "running"' >/dev/null \
  || experiment_fail "the E1 session is not the turn reported active"
before_pids=$(service_pids "$WORKSPACE_ID")
before_sessions=$(printf '%s\n%s\n' "$turn_id" "$(session_catalog "$WORKSPACE_ID")" | sed '/^$/d' | sort -u)

publish_variant e1-script
pin_payload "$PUBLISHED_VERSION"
payload_tick "$WORKSPACE_ID" >/dev/null 2>&1 \
  || experiment_fail "updater tick failed"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "control plane did not record applied"
wait_payload_current "$WORKSPACE_ID" "$PUBLISHED_VERSION" 30 \
  || experiment_fail "new payload is not current"

after_pids=$(service_pids "$WORKSPACE_ID")
assert_equal "$after_pids" "$before_pids" "a service restarted for a restart-free blitz-term change"
box_ssh "$WORKSPACE_ID" \
  "grep -F -- '$PUBLISHED_MARKER' /usr/local/libexec/blitz-term >/dev/null" \
  || experiment_fail "a newly resolved blitz-term does not use the new script"
wait_turn "$WORKSPACE_ID" "$turn_id" "${LAB_TURN_TIMEOUT:-900}" >"$LAB_TEMP_ROOT/turn.json" \
  || experiment_fail "the in-flight turn did not complete"
after_sessions=$(printf '%s\n%s\n' "$turn_id" "$(session_catalog "$WORKSPACE_ID")" | sed '/^$/d' | sort -u)
assert_equal "$after_sessions" "$before_sessions" "session catalog changed while the turn completed"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "turn completed; new tabs resolve the script; applied with zero service restarts"
