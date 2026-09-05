#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E2 "$@"

if payload_lab_dry; then
  publish_variant e2-gateway
  turn_id=$(start_turn "$WORKSPACE_ID" "run a long command")
  dry_command "wait for exact session $turn_id; create one uniquely named tmux session in the terminal cgroup"
  dry_command "snapshot only that tmux session and daemon; poll the box-local gateway at 5 Hz"
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait for normal updater poll; assert applied, gateway reconnect gap <10s, owned tmux intact, and a fresh local gateway/ttyd websocket attaches"
  wait_turn "$WORKSPACE_ID" "$turn_id" "$LAB_TURN_TIMEOUT"
  experiment_pass "dry run: gateway reconnect assertions"
fi

require_workspace
publish_variant e2-gateway
turn_seconds=${LAB_E2_TURN_SECONDS:-$(( LAB_OUTCOME_TIMEOUT + 300 ))}
expected_text=${LAB_E2_EXPECTED_TEXT:-done}
turn_prompt=${LAB_E2_PROMPT:-"Use the shell to run 'sleep $turn_seconds' and wait for it to finish, then reply $expected_text."}
turn_id=$(start_turn "$WORKSPACE_ID" "$turn_prompt") \
  || experiment_fail "could not start the E2 turn"
arm_turn_cleanup "$WORKSPACE_ID" "$turn_id"
wait_session_state "$WORKSPACE_ID" "$turn_id" running 90 >/dev/null \
  || experiment_fail "the E2 session did not report its own turn running"
create_test_terminal "$WORKSPACE_ID"
before_tmux=$(tmux_session_identity "$WORKSPACE_ID" "$LAB_TEST_TERMINAL_SESSION") \
  || experiment_fail "the E2 tmux precondition is not running"
before_daemon=$(daemon_pid "$WORKSPACE_ID")
before_gateway=$(box_ssh "$WORKSPACE_ID" 'cat /run/service/gateway/supervise/pid') \
  || experiment_fail "gateway pid was unavailable before the update"
wait_local_gateway_health "$WORKSPACE_ID" 10 \
  || experiment_fail "the local gateway did not answer before the update"

health_log="$LAB_TEMP_ROOT/health.tsv"
start_local_gateway_health_poll "$WORKSPACE_ID" "$health_log"
sleep 1
pin_payload "$PUBLISHED_VERSION"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "normal updater poll did not report applied within ${LAB_OUTCOME_TIMEOUT}s"
wait_local_gateway_health "$WORKSPACE_ID" 10 \
  || experiment_fail "the local gateway did not recover after the update"
sleep 1
stop_health_poll "$HEALTH_POLL_PID"

gap=$(health_gap_ms "$health_log")
[ "$gap" -lt 10000 ] || experiment_fail "gateway reconnect gap was ${gap}ms (limit 9999ms)"
after_gateway=$(box_ssh "$WORKSPACE_ID" 'cat /run/service/gateway/supervise/pid') \
  || experiment_fail "gateway pid was unavailable after the update"
[ "$after_gateway" != "$before_gateway" ] \
  || experiment_fail "gateway service did not restart for its changed binary"
after_tmux=$(tmux_session_identity "$WORKSPACE_ID" "$LAB_TEST_TERMINAL_SESSION") \
  || experiment_fail "the E2 tmux session did not survive the gateway restart"
assert_equal "$after_tmux" "$before_tmux" "the E2 tmux session changed across gateway restart"
assert_local_terminal_attach "$WORKSPACE_ID" "$LAB_TEST_TERMINAL_KEY" \
  || experiment_fail "a new local gateway/ttyd websocket could not attach to the E2 tmux session"
after_daemon=$(daemon_pid "$WORKSPACE_ID")
assert_equal "$after_daemon" "$before_daemon" "daemon restarted for a gateway-only payload"
wait_turn "$WORKSPACE_ID" "$turn_id" "$LAB_TURN_TIMEOUT" >"$LAB_TEMP_ROOT/turn.json" \
  || experiment_fail "the exact E2 turn did not complete after the gateway restart"
assert_completed_turn_text "$LAB_TEMP_ROOT/turn.json" "$expected_text" \
  "the E2 session completed without the expected text '$expected_text'"
disarm_turn_cleanup
wait_payload_current "$WORKSPACE_ID" "$PUBLISHED_VERSION" 30 \
  || experiment_fail "new gateway payload is not current"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "local reconnect ${gap}ms; owned tmux intact ($LAB_TEST_TERMINAL_PLACEMENT); fresh websocket attached; exact turn completed"
