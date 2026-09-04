#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E3 "$@"

if payload_lab_dry; then
  turn_id=$(start_turn "$WORKSPACE_ID" "reply ready")
  wait_turn "$WORKSPACE_ID" "$turn_id" "${LAB_TURN_TIMEOUT:-900}"
  dry_command "snapshot idle daemon pid and the started session"
  publish_variant daemon-e3
  pin_payload "$PUBLISHED_VERSION"
  dry_command "run updater; assert immediate daemon restart, applied, catalog resumes, no turn lost"
  experiment_pass "dry run: idle daemon restart assertions"
fi

require_workspace
turn_prompt=${LAB_E3_PROMPT:-"Reply with the single word ready."}
turn_id=$(start_turn "$WORKSPACE_ID" "$turn_prompt") \
  || experiment_fail "could not start the E3 turn"
wait_turn "$WORKSPACE_ID" "$turn_id" "${LAB_TURN_TIMEOUT:-900}" >"$LAB_TEMP_ROOT/turn.json" \
  || experiment_fail "the E3 turn did not complete"
session_running "$WORKSPACE_ID" && experiment_fail "the completed E3 turn stayed active"
before_sessions=$(printf '%s\n%s\n' "$turn_id" "$(session_catalog "$WORKSPACE_ID")" | sed '/^$/d' | sort -u)
before_pid=$(daemon_pid "$WORKSPACE_ID")

publish_variant daemon-e3
target_daemon=$(jq -er .daemon.version "$PUBLISHED_RELEASE_DIR/manifest.json") \
  || experiment_fail "published payload has no daemon version"
pin_payload "$PUBLISHED_VERSION"
payload_tick "$WORKSPACE_ID" >"$LAB_TEMP_ROOT/tick.log" 2>&1 &
tick_pid=$!

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
wait "$tick_pid" || experiment_fail "updater tick failed"
[ "$switch_ms" -ne 0 ] && [ "$restart_ms" -ne 0 ] \
  || experiment_fail "daemon did not switch and restart"
restart_gap=$(( restart_ms - switch_ms ))
[ "$restart_gap" -lt 10000 ] \
  || experiment_fail "idle daemon restart took ${restart_gap}ms after the switch"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "control plane did not record applied"
after_sessions=$(printf '%s\n%s\n' "$turn_id" "$(session_catalog "$WORKSPACE_ID")" | sed '/^$/d' | sort -u)
assert_equal "$after_sessions" "$before_sessions" "idle sessions did not resume after daemon restart"
resumed_status=$(node "$PAYLOAD_LAB_SESSION_DRIVER" session status "$turn_id") \
  || experiment_fail "the restarted daemon did not serve the E3 session"
printf '%s' "$resumed_status" | jq -e '.state == "completed"' >/dev/null \
  || experiment_fail "the E3 session was not still completed after restart"
session_running "$WORKSPACE_ID" && experiment_fail "restart created a running turn"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "idle daemon restarted in ${restart_gap}ms; sessions resumed; no turn lost"
