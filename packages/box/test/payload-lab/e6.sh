#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E6 "$@"

if payload_lab_dry; then
  dry_command "snapshot previous payload and tmux; begin CP proxy health poll"
  publish_variant e6-crash-gateway
  pin_payload "$PUBLISHED_VERSION"
  dry_command "run updater; assert rolled-back and proxy recovery <90s, previous serving, terminals reconnect"
  experiment_pass "dry run: crashing gateway rollback assertions"
fi

require_workspace
previous=$(payload_current "$WORKSPACE_ID")
before_tmux=$(tmux_catalog "$WORKSPACE_ID")
[ -n "$before_tmux" ] || experiment_fail "no terminal sessions exist to reconnect"
wait_gateway_health "$WORKSPACE_ID" 10 \
  || experiment_fail "previous gateway health was not 2xx before the update"
publish_variant e6-crash-gateway
pin_payload "$PUBLISHED_VERSION"

health_log="$LAB_TEMP_ROOT/health.tsv"
start_health_poll "$WORKSPACE_ID" "$health_log"
sleep 1
payload_tick "$WORKSPACE_ID" >"$LAB_TEMP_ROOT/tick.log" 2>&1 \
  || experiment_fail "updater tick failed"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" rolled-back "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "control plane did not record rolled-back"
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
after_tmux=$(tmux_catalog "$WORKSPACE_ID")
assert_equal "$after_tmux" "$before_tmux" "terminals did not reconnect to intact tmux sessions"
assert_payload_state_consistent "$WORKSPACE_ID" || experiment_fail "rollback left inconsistent state"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "rolled back in ${gap}ms; previous gateway serves; terminals reconnected"
