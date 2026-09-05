#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E6 "$@"

if payload_lab_dry; then
  dry_command "create and snapshot one uniquely named tmux session; begin CP proxy health poll"
  publish_variant e6-crash-gateway
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait for a natural updater tick; assert rolled-back and proxy recovery <90s, previous serving, owned terminal reconnects"
  experiment_pass "dry run: crashing gateway rollback assertions"
fi

require_workspace
previous=$(payload_current "$WORKSPACE_ID")
create_test_terminal "$WORKSPACE_ID"
before_tmux=$(tmux_session_identity "$WORKSPACE_ID" "$LAB_TEST_TERMINAL_SESSION") \
  || experiment_fail "the E6 tmux precondition is not running"
wait_gateway_health "$WORKSPACE_ID" 10 \
  || experiment_fail "previous gateway health was not 2xx before the update"
publish_variant e6-crash-gateway

health_log="$LAB_TEMP_ROOT/health.tsv"
start_health_poll "$WORKSPACE_ID" "$health_log"
sleep 1
before_report=$(payload_reported_at "$MACHINE_ID" "$WORKSPACE_ID")
log_offset=$(payload_log_size "$WORKSPACE_ID")
pin_payload "$PUBLISHED_VERSION"
wait_payload_failure \
  "$MACHINE_ID" "$WORKSPACE_ID" "$PUBLISHED_VERSION" rolled-back "$before_report" "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "control plane did not record rolled-back"
payload_log_since "$WORKSPACE_ID" "$log_offset" >"$LAB_TEMP_ROOT/payload.log" \
  || experiment_fail "rollback updater log was unreadable"
grep -F "rolled-back $previous: attempted $PUBLISHED_VERSION;" \
  "$LAB_TEMP_ROOT/payload.log" >/dev/null \
  || experiment_fail "updater log did not attribute the rollback to the crashing payload"
wait_gateway_health "$WORKSPACE_ID" 10 \
  || experiment_fail "previous gateway health did not recover after rollback"
sleep 1
stop_health_poll "$HEALTH_POLL_PID"

gap=$(health_gap_ms "$health_log")
[ "$gap" -gt 0 ] || experiment_fail "health poll did not observe the crashing gateway"
[ "$gap" -lt 90000 ] || experiment_fail "rollback took ${gap}ms (limit 89999ms)"
assert_equal "$(payload_current "$WORKSPACE_ID")" "$previous" \
  "rollback did not restore the previous payload"
case "$(gateway_health_code "$WORKSPACE_ID")" in
  2??) ;;
  *) experiment_fail "previous gateway is not serving after rollback" ;;
esac
after_tmux=$(tmux_session_identity "$WORKSPACE_ID" "$LAB_TEST_TERMINAL_SESSION") \
  || experiment_fail "the E6 tmux session did not survive rollback"
assert_equal "$after_tmux" "$before_tmux" "the E6 tmux session changed across rollback"
assert_local_terminal_attach "$WORKSPACE_ID" "$LAB_TEST_TERMINAL_KEY" \
  || experiment_fail "a fresh gateway/ttyd websocket could not attach to the E6 tmux session"
assert_payload_state_consistent "$WORKSPACE_ID" || experiment_fail "rollback left inconsistent state"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "rolled back in ${gap}ms; previous gateway serves; owned terminal reconnected"
