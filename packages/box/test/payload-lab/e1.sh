#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E1 "$@"

if payload_lab_dry; then
  dry_command "assert an agent turn is running; snapshot service pids and session catalog"
  publish_variant e1-script
  pin_payload "$PUBLISHED_VERSION"
  dry_command "run updater; assert applied, no service pid changed, marker is used by a new tab, turn completes"
  experiment_pass "dry run: script-only in-flight-turn assertions"
fi

require_workspace
session_running "$WORKSPACE_ID" || experiment_fail "no turn is in flight"
before_pids=$(service_pids "$WORKSPACE_ID")
before_sessions=$(session_catalog "$WORKSPACE_ID")
[ -n "$before_sessions" ] || experiment_fail "daemon catalog has no live session"

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
wait_session_idle "$WORKSPACE_ID" "${LAB_TURN_TIMEOUT:-900}" \
  || experiment_fail "the in-flight turn did not complete"
after_sessions=$(session_catalog "$WORKSPACE_ID")
assert_equal "$after_sessions" "$before_sessions" "session catalog changed while the turn completed"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "turn completed; new tabs resolve the script; applied with zero service restarts"
