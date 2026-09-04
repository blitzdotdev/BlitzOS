#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E9 "$@"

if payload_lab_dry; then
  dry_command "point box at unreachable, 401, and 5xx fixture origins; run bounded updater tick for each"
  dry_command "assert current unchanged, updater CPU does not spin, restore origin, and assert reporting resumes"
  experiment_pass "dry run: control-plane failure and recovery assertions"
fi

require_workspace
require_env LAB_401_ORIGIN
require_env LAB_5XX_ORIGIN
for origin in "$LAB_401_ORIGIN" "$LAB_5XX_ORIGIN"; do
  [[ "$origin" =~ ^https://[^/]+$ ]] || experiment_fail "fixture origins must be bare HTTPS origins"
done
original_origin=$(box_ssh "$WORKSPACE_ID" 'sed -n "1p" /var/lib/blitz/origin')
arm_origin_restore "$WORKSPACE_ID" "$original_origin"
before_current=$(payload_current "$WORKSPACE_ID")
before_report=$(payload_reported_at "$MACHINE_ID" "$WORKSPACE_ID")

for pair in \
  "unreachable|https://127.0.0.1:9" \
  "401|$LAB_401_ORIGIN" \
  "5xx|$LAB_5XX_ORIGIN"; do
  label=${pair%%|*}
  origin=${pair#*|}
  _write_box_origin "$WORKSPACE_ID" "$origin"
  started=$(date +%s)
  payload_tick "$WORKSPACE_ID" >"$LAB_TEMP_ROOT/$label.log" 2>&1 \
    || experiment_fail "$label tick escaped its fail-open loop"
  duration=$(( $(date +%s) - started ))
  [ "$duration" -le "${LAB_FAILURE_TICK_LIMIT:-75}" ] \
    || experiment_fail "$label retry path was unbounded (${duration}s)"
  assert_equal "$(payload_current "$WORKSPACE_ID")" "$before_current" \
    "$label failure changed current"
done

ticks_before=$(payload_process_ticks "$WORKSPACE_ID")
sleep 5
ticks_after=$(payload_process_ticks "$WORKSPACE_ID")
tick_delta=$(( ticks_after - ticks_before ))
[ "$tick_delta" -lt "${LAB_CPU_TICK_LIMIT:-100}" ] \
  || experiment_fail "payload loop spun CPU during outage ($tick_delta ticks in 5s)"

restore_box_origin
payload_tick "$WORKSPACE_ID" >/dev/null 2>&1 || experiment_fail "recovery tick failed"
deadline=$(( $(date +%s) + LAB_OUTCOME_TIMEOUT ))
after_report=$before_report
while [ "$(date +%s)" -lt "$deadline" ]; do
  after_report=$(payload_reported_at "$MACHINE_ID" "$WORKSPACE_ID" 2>/dev/null || printf 0)
  [ "$after_report" -gt "$before_report" ] && break
  sleep 2
done
[ "$after_report" -gt "$before_report" ] || experiment_fail "box did not report after control plane recovered"
assert_equal "$(payload_current "$WORKSPACE_ID")" "$before_current" \
  "recovery changed the current payload"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "unreachable/401/5xx bounded; current kept; CPU delta $tick_delta; reporting recovered"
