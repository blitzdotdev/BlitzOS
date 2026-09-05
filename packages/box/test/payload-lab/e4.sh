#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E4 "$@"

if payload_lab_dry; then
  publish_variant daemon-e4
  turn_id=$(start_turn "$WORKSPACE_ID" "request a shell command containing sleep 60" ask)
  dry_command "wait for exact session $turn_id to request permission; record running payload and daemon pid"
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait for normal updater poll to report deferred with the staged target; assert neither payload nor daemon switched"
  set_turn_permissions "$WORKSPACE_ID" "$turn_id" allow
  dry_command "drive the allowed turn; while its sleep 60 runs assert payload and daemon stay unchanged"
  wait_turn "$WORKSPACE_ID" "$turn_id" "$LAB_TURN_TIMEOUT"
  dry_command "within one ${LAB_PAYLOAD_INTERVAL}s tick assert whole release applies, daemon restarts, and exact completed session remains intact"
  experiment_pass "dry run: whole-release daemon deferral assertions"
fi

require_workspace
publish_variant daemon-e4
expected_text=${LAB_E4_EXPECTED_TEXT:-E4-PAYLOAD-LAB-DONE}
turn_prompt=${LAB_E4_PROMPT:-"Use the shell to run exactly: touch /tmp/blitz-payload-lab-e4 && sleep 60 && rm -f /tmp/blitz-payload-lab-e4. Do not answer before the command succeeds. Then reply exactly $expected_text."}
turn_id=$(start_turn "$WORKSPACE_ID" "$turn_prompt" ask) \
  || experiment_fail "could not start the E4 turn"
arm_turn_cleanup "$WORKSPACE_ID" "$turn_id"
wait_turn_permission "$WORKSPACE_ID" "$turn_id" 120 "$LAB_TEMP_ROOT/permission.json" \
  || experiment_fail "the E4 session did not reach its own permission request"
before_pid=$(daemon_pid "$WORKSPACE_ID")
before_payload=$(payload_current "$WORKSPACE_ID")

target_daemon=$(jq -er .daemon.version "$PUBLISHED_RELEASE_DIR/manifest.json") \
  || experiment_fail "published payload has no daemon version"
pin_payload "$PUBLISHED_VERSION"
wait_payload_deferred \
  "$MACHINE_ID" "$WORKSPACE_ID" "$PUBLISHED_VERSION" "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "normal updater poll did not report the fully staged release as deferred"

assert_equal "$(daemon_pid "$WORKSPACE_ID")" "$before_pid" \
  "daemon restarted while the turn was waiting for permission"
assert_equal "$(payload_current "$WORKSPACE_ID")" "$before_payload" \
  "payload switched before the daemon-changing release could activate as one unit"
set_turn_permissions "$WORKSPACE_ID" "$turn_id" allow >/dev/null \
  || experiment_fail "could not allow the exact E4 session's pending request"
turn_started=$(date +%s)
wait_turn "$WORKSPACE_ID" "$turn_id" "$LAB_TURN_TIMEOUT" >"$LAB_TEMP_ROOT/turn.json" &
turn_wait_pid=$!
wait_session_state "$WORKSPACE_ID" "$turn_id" running 30 >/dev/null \
  || experiment_fail "the exact E4 turn did not start its allowed command"
sleep 30
wait_session_state "$WORKSPACE_ID" "$turn_id" running 5 >/dev/null \
  || experiment_fail "the E4 turn did not remain active during sleep 60"
assert_equal "$(daemon_pid "$WORKSPACE_ID")" "$before_pid" \
  "daemon restarted while the E4 sleep 60 turn was running"
assert_equal "$(payload_current "$WORKSPACE_ID")" "$before_payload" \
  "payload switched while the E4 sleep 60 turn was running"
wait "$turn_wait_pid" || experiment_fail "the deferred E4 turn did not complete"
turn_elapsed=$(( $(date +%s) - turn_started ))
[ "$turn_elapsed" -ge 55 ] \
  || experiment_fail "the E4 sleep 60 turn completed in only ${turn_elapsed}s"
assert_completed_turn_text "$LAB_TEMP_ROOT/turn.json" "$expected_text" \
  "the E4 session completed without the expected text '$expected_text'"
disarm_turn_cleanup

restart_deadline=$(( $(date +%s) + LAB_PAYLOAD_INTERVAL + 90 ))
restart_ms=0
completed_ms=$(date +%s%3N)
while [ "$(date +%s)" -lt "$restart_deadline" ]; do
  current_pid=$(daemon_pid "$WORKSPACE_ID" 2>/dev/null || true)
  if [ -n "$current_pid" ] && [ "$current_pid" != "$before_pid" ]; then
    restart_ms=$(date +%s%3N)
    break
  fi
  sleep 1
done
[ "$restart_ms" -ne 0 ] \
  || experiment_fail "daemon did not restart within one updater tick after the E4 turn completed"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "control plane did not record the deferred release as applied"
wait_payload_current "$WORKSPACE_ID" "$PUBLISHED_VERSION" 30 \
  || experiment_fail "payload did not switch with the deferred daemon"
assert_equal "$(daemon_version "$WORKSPACE_ID")" "$target_daemon" \
  "daemon version does not match the deferred release"
wait_session_state "$WORKSPACE_ID" "$turn_id" completed 90 >"$LAB_TEMP_ROOT/resumed.json" \
  || experiment_fail "the completed E4 session was not intact after the idle daemon restart"
assert_completed_turn_text "$LAB_TEMP_ROOT/resumed.json" "$expected_text" \
  "the restarted daemon lost the completed E4 session text"
restart_delay=$(( restart_ms - completed_ms ))
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "whole release stayed deferred through sleep 60; idle restart followed in ${restart_delay}ms; exact session intact"
