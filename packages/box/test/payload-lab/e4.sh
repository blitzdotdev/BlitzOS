#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E4 "$@"

if payload_lab_dry; then
  publish_variant daemon-e4
  turn_id=$(start_turn "$WORKSPACE_ID" "run beyond the daemon idle cap")
  dry_command "wait for exact session $turn_id to report running; record daemon pid and daemon-log offset"
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait for the normal updater poll; assert pid stays through idle cap, restart, exact-session redispatch, completion, and daemon-log gap"
  experiment_pass "dry run: busy daemon idle-wait and redispatch assertions"
fi

require_workspace
publish_variant daemon-e4
idle_cap=${LAB_DAEMON_IDLE_CAP:-600}
turn_seconds=${LAB_E4_TURN_SECONDS:-$(( idle_cap + LAB_OUTCOME_TIMEOUT + 300 ))}
turn_deadline=$(( $(date +%s) + turn_seconds ))
expected_text=${LAB_E4_EXPECTED_TEXT:-done}
turn_prompt=${LAB_E4_PROMPT:-"Use the shell to wait until Unix time $turn_deadline, checking 'date +%s' every five seconds, then reply $expected_text."}
turn_id=$(start_turn "$WORKSPACE_ID" "$turn_prompt") \
  || experiment_fail "could not start the E4 turn"
arm_turn_cleanup "$WORKSPACE_ID" "$turn_id"
wait_session_state "$WORKSPACE_ID" "$turn_id" running 90 >/dev/null \
  || experiment_fail "the E4 session did not report its own turn running"
before_pid=$(daemon_pid "$WORKSPACE_ID")

target_daemon=$(jq -er .daemon.version "$PUBLISHED_RELEASE_DIR/manifest.json") \
  || experiment_fail "published payload has no daemon version"
pin_payload "$PUBLISHED_VERSION"

deadline=$(( $(date +%s) + LAB_OUTCOME_TIMEOUT ))
switch_ms=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(daemon_version "$WORKSPACE_ID" 2>/dev/null || true)" = "$target_daemon" ]; then
    switch_ms=$(date +%s%3N)
    break
  fi
  sleep 1
done
[ "$switch_ms" -ne 0 ] \
  || experiment_fail "normal updater poll did not stage the daemon switch within ${LAB_OUTCOME_TIMEOUT}s"

probe_delay=$(( idle_cap > 5 ? idle_cap - 5 : 1 ))
sleep "$probe_delay"
probe_pid=$(daemon_pid "$WORKSPACE_ID" 2>/dev/null || true)
assert_equal "$probe_pid" "$before_pid" "daemon restarted before the busy idle-wait cap"
log_offset=$(daemon_log_size "$WORKSPACE_ID") \
  || experiment_fail "daemon log is unavailable"
before_stamp=$(box_ssh "$WORKSPACE_ID" \
  'log=$(find /var/lib/blitz/lody/logs -maxdepth 1 -type f -name "*.log*" -printf "%T@ %p\n" | sort -n | tail -1 | cut -d" " -f2-); tail -1 "$log" | cut -d" " -f1')
[ -n "$before_stamp" ] || experiment_fail "daemon log has no pre-restart timestamp"

restart_deadline=$(( $(date +%s) + 95 ))
restart_ms=0
while [ "$(date +%s)" -lt "$restart_deadline" ]; do
  current_pid=$(daemon_pid "$WORKSPACE_ID" 2>/dev/null || true)
  if [ -n "$current_pid" ] && [ "$current_pid" != "$before_pid" ]; then
    restart_ms=$(date +%s%3N)
    break
  fi
  sleep 0.5
done
[ "$restart_ms" -ne 0 ] || experiment_fail "daemon did not restart after the idle-wait cap"
wait_session_state "$WORKSPACE_ID" "$turn_id" running 90 >/dev/null \
  || experiment_fail "the exact E4 turn was not running after redispatch"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "control plane did not record applied"

daemon_log_since "$WORKSPACE_ID" "$log_offset" >"$LAB_TEMP_ROOT/daemon.log"
dispatch_stamp=$(grep -m1 'Session chat received:' "$LAB_TEMP_ROOT/daemon.log" \
  | cut -d' ' -f1 || true)
[ -n "$dispatch_stamp" ] || experiment_fail "daemon log has no redispatch record"
before_ms=$(iso_epoch_ms "$before_stamp") || experiment_fail "could not parse pre-restart daemon timestamp"
dispatch_ms=$(iso_epoch_ms "$dispatch_stamp") || experiment_fail "could not parse redispatch daemon timestamp"
redispatch_gap=$(( dispatch_ms - before_ms ))
[ "$redispatch_gap" -ge 0 ] || experiment_fail "daemon-log redispatch gap was negative"
idle_wait=$(( (restart_ms - switch_ms) / 1000 ))
[ "$idle_wait" -ge "$probe_delay" ] || experiment_fail "idle wait measured only ${idle_wait}s"
wait_turn "$WORKSPACE_ID" "$turn_id" "$LAB_TURN_TIMEOUT" >"$LAB_TEMP_ROOT/turn.json" \
  || experiment_fail "the re-dispatched E4 turn did not complete"
assert_completed_turn_text "$LAB_TEMP_ROOT/turn.json" "$expected_text" \
  "the E4 session completed without the expected text '$expected_text'"
disarm_turn_cleanup
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "idle wait ${idle_wait}s reached cap; exact turn re-dispatched and completed; daemon-log gap ${redispatch_gap}ms"
