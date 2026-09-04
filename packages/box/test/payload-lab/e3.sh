#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E3 "$@"

if payload_lab_dry; then
  dry_command "assert daemon sessions exist and all are idle; snapshot daemon pid and session catalog"
  publish_variant daemon-e3
  pin_payload "$PUBLISHED_VERSION"
  dry_command "run updater; assert immediate daemon restart, applied, catalog resumes, no turn lost"
  experiment_pass "dry run: idle daemon restart assertions"
fi

require_workspace
session_running "$WORKSPACE_ID" && experiment_fail "a turn is running; E3 requires idle sessions"
before_sessions=$(session_catalog "$WORKSPACE_ID")
[ -n "$before_sessions" ] || experiment_fail "daemon catalog has no sessions to resume"
before_pid=$(daemon_pid "$WORKSPACE_ID")

publish_variant daemon-e3
target_daemon=$(jq -er .daemon.version "$PUBLISHED_RELEASE_DIR/manifest.json") \
  || experiment_fail "published payload has no daemon version"
pin_payload "$PUBLISHED_VERSION"
payload_tick "$WORKSPACE_ID" >"$LAB_TEMP_ROOT/tick.log" 2>&1 &
tick_pid=$!
LAB_BACKGROUND_PIDS+=("$tick_pid")

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
after_sessions=$(session_catalog "$WORKSPACE_ID")
assert_equal "$after_sessions" "$before_sessions" "idle sessions did not resume after daemon restart"
session_running "$WORKSPACE_ID" && experiment_fail "restart created a running turn"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "idle daemon restarted in ${restart_gap}ms; sessions resumed; no turn lost"
