#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E4 "$@"

if payload_lab_dry; then
  dry_command "assert long turn running; record daemon pid and daemon-log offset"
  publish_variant daemon-e4
  pin_payload "$PUBLISHED_VERSION"
  dry_command "run updater; assert pid stays through idle cap, restart, redispatch, and calculate gap from daemon log"
  experiment_pass "dry run: busy daemon idle-wait and redispatch assertions"
fi

require_workspace
session_running "$WORKSPACE_ID" || experiment_fail "no long turn is in flight"
before_pid=$(daemon_pid "$WORKSPACE_ID")

publish_variant daemon-e4
target_daemon=$(jq -er .daemon.version "$PUBLISHED_RELEASE_DIR/manifest.json") \
  || experiment_fail "published payload has no daemon version"
pin_payload "$PUBLISHED_VERSION"
payload_tick "$WORKSPACE_ID" >"$LAB_TEMP_ROOT/tick.log" 2>&1 &
tick_pid=$!
LAB_BACKGROUND_PIDS+=("$tick_pid")

deadline=$(( $(date +%s) + LAB_OUTCOME_TIMEOUT ))
switch_ms=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(daemon_version "$WORKSPACE_ID" 2>/dev/null || true)" = "$target_daemon" ]; then
    switch_ms=$(date +%s%3N)
    break
  fi
  sleep 1
done
[ "$switch_ms" -ne 0 ] || experiment_fail "daemon switch was not staged"

idle_cap=${LAB_DAEMON_IDLE_CAP:-600}
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
wait "$tick_pid" || experiment_fail "updater tick failed"
wait_session_running "$WORKSPACE_ID" 60 \
  || experiment_fail "the interrupted turn was not re-dispatched"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "control plane did not record applied"

daemon_log_since "$WORKSPACE_ID" "$log_offset" >"$LAB_TEMP_ROOT/daemon.log"
dispatch_stamp=$(grep -i -m1 'dispatch' "$LAB_TEMP_ROOT/daemon.log" | cut -d' ' -f1 || true)
[ -n "$dispatch_stamp" ] || experiment_fail "daemon log has no redispatch record"
before_ms=$(iso_epoch_ms "$before_stamp") || experiment_fail "could not parse pre-restart daemon timestamp"
dispatch_ms=$(iso_epoch_ms "$dispatch_stamp") || experiment_fail "could not parse redispatch daemon timestamp"
redispatch_gap=$(( dispatch_ms - before_ms ))
[ "$redispatch_gap" -ge 0 ] || experiment_fail "daemon-log redispatch gap was negative"
idle_wait=$(( (restart_ms - switch_ms) / 1000 ))
[ "$idle_wait" -ge "$probe_delay" ] || experiment_fail "idle wait measured only ${idle_wait}s"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "idle wait ${idle_wait}s reached cap; turn re-dispatched; daemon-log gap ${redispatch_gap}ms"
