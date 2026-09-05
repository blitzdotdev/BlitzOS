#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E18 "$@"

if payload_lab_dry; then
  publish_variant with-hello-e18
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait applied; assert hello runs"
  publish_variant e18-remove-service
  pin_payload "$PUBLISHED_VERSION"
  dry_command "wait applied; assert hello gone from the live set, sshd and gateway pids unchanged"
  experiment_pass "dry run: live service remove assertions"
fi

require_workspace
# Start from a tree that carries hello, so the removal is a real transition.
publish_variant with-hello-e18
pin_payload "$PUBLISHED_VERSION"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "the release that adds hello was not applied within ${LAB_OUTCOME_TIMEOUT}s"
box_ssh "$WORKSPACE_ID" "pgrep -xf 'sleep infinity' >/dev/null" \
  || experiment_fail "hello is not running before the removal"
before_pids=$(service_pids "$WORKSPACE_ID")
sshd_before=$(printf '%s\n' "$before_pids" | grep '^sshd=' || true)
gateway_before=$(gateway_pid "$WORKSPACE_ID")
[ -n "$sshd_before" ] && [ -n "$gateway_before" ] \
  || experiment_fail "could not snapshot the sshd and gateway pids"
# The removal release is the base tree plus a blitz-term marker: no hello.
publish_variant e18-remove-service
pin_payload "$PUBLISHED_VERSION"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "the release that removes hello was not applied within ${LAB_OUTCOME_TIMEOUT}s"
wait_payload_current "$WORKSPACE_ID" "$PUBLISHED_VERSION" 30 \
  || experiment_fail "removal payload is not current"
[ -z "$(box_ssh "$WORKSPACE_ID" "pgrep -xf 'sleep infinity' || true")" ] \
  || experiment_fail "hello still runs after its removal"
box_ssh "$WORKSPACE_ID" 'test ! -e /run/service/hello' \
  || experiment_fail "hello still has a live service directory"
after_pids=$(service_pids "$WORKSPACE_ID")
assert_equal "$(printf '%s\n' "$after_pids" | grep '^sshd=' || true)" "$sshd_before" \
  "sshd restarted while a service was removed"
assert_equal "$(gateway_pid "$WORKSPACE_ID")" "$gateway_before" \
  "gateway restarted while a service was removed"
assert_equal "$after_pids" "$(printf '%s\n' "$before_pids" | grep -v '^hello=')" \
  "an unrelated service restarted while hello was removed"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "hello removed live; sshd, gateway and every other service kept their pids"
