#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E17 "$@"

if payload_lab_dry; then
  publish_variant e17-add-service
  dry_command "snapshot service pids; assert no hello process"
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait for the normal updater poll; assert applied, hello supervised by s6, sshd and gateway pids unchanged"
  experiment_pass "dry run: live service add assertions"
fi

require_workspace
[ -z "$(box_ssh "$WORKSPACE_ID" "pgrep -xf 'sleep infinity' || true")" ] \
  || experiment_fail "a hello process already runs on the box"
publish_variant e17-add-service
before_pids=$(service_pids "$WORKSPACE_ID")
sshd_before=$(printf '%s\n' "$before_pids" | grep '^sshd=' || true)
gateway_before=$(gateway_pid "$WORKSPACE_ID")
[ -n "$sshd_before" ] && [ -n "$gateway_before" ] \
  || experiment_fail "could not snapshot the sshd and gateway pids"
pin_payload "$PUBLISHED_VERSION"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "normal updater poll did not report applied within ${LAB_OUTCOME_TIMEOUT}s"
wait_payload_current "$WORKSPACE_ID" "$PUBLISHED_VERSION" 30 \
  || experiment_fail "new payload is not current"
hello_pid=$(box_ssh "$WORKSPACE_ID" "pgrep -xf 'sleep infinity'" | head -n 1) \
  || experiment_fail "hello is not running after the add"
supervisor=$(box_ssh "$WORKSPACE_ID" "ps -o comm= -p \$(ps -o ppid= -p $hello_pid | tr -d ' ')")
assert_equal "$supervisor" s6-supervise "hello is not supervised by s6 (parent is $supervisor)"
box_ssh "$WORKSPACE_ID" 'test -e /run/service/hello' \
  || experiment_fail "hello has no live service directory"
after_pids=$(service_pids "$WORKSPACE_ID")
assert_equal "$(printf '%s\n' "$after_pids" | grep '^sshd=' || true)" "$sshd_before" \
  "sshd restarted while a service was added"
assert_equal "$(gateway_pid "$WORKSPACE_ID")" "$gateway_before" \
  "gateway restarted while a service was added"
assert_equal "$(printf '%s\n' "$after_pids" | grep -v '^hello=')" "$before_pids" \
  "an existing service restarted while hello was added"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "hello added live (pid $hello_pid under s6-supervise); sshd, gateway and every other service kept their pids"
