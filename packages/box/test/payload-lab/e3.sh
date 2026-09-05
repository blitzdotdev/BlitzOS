#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E3 "$@"

if payload_lab_dry; then
  publish_variant daemon-e3
  turn_id=$(start_turn "$WORKSPACE_ID" "reply ready")
  wait_turn "$WORKSPACE_ID" "$turn_id" "$LAB_TURN_TIMEOUT"
  dry_command "assert exact session completed with expected text; snapshot idle daemon pid"
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait for the normal updater poll; assert immediate daemon restart, applied, and exact session resumes completed"
  experiment_pass "dry run: idle daemon restart assertions"
fi

require_workspace
publish_variant daemon-e3
turn_prompt=${LAB_E3_PROMPT:-"Reply with the single word ready."}
expected_text=${LAB_E3_EXPECTED_TEXT:-ready}
turn_id=$(start_turn "$WORKSPACE_ID" "$turn_prompt") \
  || experiment_fail "could not start the E3 turn"
arm_turn_cleanup "$WORKSPACE_ID" "$turn_id"
wait_turn "$WORKSPACE_ID" "$turn_id" "$LAB_TURN_TIMEOUT" >"$LAB_TEMP_ROOT/turn.json" \
  || experiment_fail "the E3 turn did not complete"
assert_completed_turn_text "$LAB_TEMP_ROOT/turn.json" "$expected_text" \
  "the E3 session completed without the expected text '$expected_text'"
disarm_turn_cleanup
before_pid=$(daemon_pid "$WORKSPACE_ID")

target_daemon=$(jq -er .daemon.version "$PUBLISHED_RELEASE_DIR/manifest.json") \
  || experiment_fail "published payload has no daemon version"
pin_payload "$PUBLISHED_VERSION"

deadline=$(( $(date +%s) + LAB_OUTCOME_TIMEOUT ))
switch_ms=0
restart_ms=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$switch_ms" -eq 0 ] \
    && [ "$(daemon_version "$WORKSPACE_ID" 2>/dev/null || true)" = "$target_daemon" ]; then
    switch_ms=$(date +%s%3N)
  fi
  current_pid=$(daemon_pid "$WORKSPACE_ID" 2>/dev/null || true)
  if [ -n "$current_pid" ] && [ "$current_pid" != "$before_pid" ]; then
    restart_ms=$(date +%s%3N)
    break
  fi
  sleep 0.2
done
[ "$switch_ms" -ne 0 ] && [ "$restart_ms" -ne 0 ] \
  || experiment_fail "normal updater poll did not switch and restart the daemon within ${LAB_OUTCOME_TIMEOUT}s"
restart_gap=$(( restart_ms - switch_ms ))
[ "$restart_gap" -lt 10000 ] \
  || experiment_fail "idle daemon restart took ${restart_gap}ms after the switch"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "control plane did not record applied"
resumed_status=$(session_status "$WORKSPACE_ID" "$turn_id") \
  || experiment_fail "the restarted daemon did not serve the E3 session"
printf '%s' "$resumed_status" | jq -e '.state == "completed"' >/dev/null \
  || experiment_fail "the E3 session was not still completed after restart"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "idle daemon restarted in ${restart_gap}ms; exact completed session resumed; no turn lost"
