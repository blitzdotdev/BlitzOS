#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E2 "$@"

if payload_lab_dry; then
  dry_command "assert turn running; snapshot tmux and daemon; poll CP proxy /webapp/7445$LAB_HEALTH_PATH at 5 Hz"
  publish_variant e2-gateway
  pin_payload "$PUBLISHED_VERSION"
  dry_command "run updater; assert applied, gateway reconnect gap <10s, tmux intact, turn and daemon unaffected"
  experiment_pass "dry run: gateway reconnect assertions"
fi

require_workspace
session_running "$WORKSPACE_ID" || experiment_fail "no turn is in flight"
before_tmux=$(tmux_catalog "$WORKSPACE_ID")
before_daemon=$(daemon_pid "$WORKSPACE_ID")
wait_gateway_health "$WORKSPACE_ID" 10 \
  || experiment_fail "gateway health was not 2xx before the update"

publish_variant e2-gateway
pin_payload "$PUBLISHED_VERSION"
health_log="$LAB_TEMP_ROOT/health.tsv"
start_health_poll "$WORKSPACE_ID" "$health_log"
sleep 1
payload_tick "$WORKSPACE_ID" >/dev/null 2>&1 \
  || experiment_fail "updater tick failed"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "control plane did not record applied"
sleep 1
stop_health_poll "$HEALTH_POLL_PID"
wait_gateway_health "$WORKSPACE_ID" 10 \
  || experiment_fail "gateway health did not recover after the update"

gap=$(health_gap_ms "$health_log")
[ "$gap" -lt 10000 ] || experiment_fail "gateway reconnect gap was ${gap}ms (limit 9999ms)"
after_tmux=$(tmux_catalog "$WORKSPACE_ID")
assert_equal "$after_tmux" "$before_tmux" "tmux sessions changed across gateway restart"
after_daemon=$(daemon_pid "$WORKSPACE_ID")
assert_equal "$after_daemon" "$before_daemon" "daemon restarted for a gateway-only payload"
session_running "$WORKSPACE_ID" || experiment_fail "the in-flight turn was interrupted"
wait_payload_current "$WORKSPACE_ID" "$PUBLISHED_VERSION" 30 \
  || experiment_fail "new gateway payload is not current"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "proxy health reconnect ${gap}ms; tmux intact; turn and daemon unaffected"
