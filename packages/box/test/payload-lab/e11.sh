#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E11 "$@"

if payload_lab_dry; then
  dry_command "publish five unique payload overlays"
  for number in 1 2 3 4 5; do
    publish_variant "e11-$number"
    pin_payload "$PUBLISHED_VERSION"
  done
  dry_command "within ten minutes await natural convergence; assert last applied, <=2 versions, and no .staging"
  experiment_pass "dry run: five-payload convergence assertions"
fi

require_workspace
versions=()
for number in 1 2 3 4 5; do
  publish_variant "e11-$number"
  versions+=("$PUBLISHED_VERSION")
done

started=$(date +%s)
for version in "${versions[@]}"; do
  pin_payload "$version"
  sleep "${LAB_BURST_DELAY:-1}"
done
last=${versions[4]}
wait_payload_outcome "$MACHINE_ID" "$last" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "machine did not converge to the fifth payload"
elapsed=$(( $(date +%s) - started ))
[ "$elapsed" -le 600 ] || experiment_fail "five pins and convergence took ${elapsed}s (limit 600s)"
assert_equal "$(payload_current "$WORKSPACE_ID")" "$last" "fifth payload is not current"
kept=$(payload_version_count "$WORKSPACE_ID")
[ "$kept" -le 2 ] || experiment_fail "$kept payload versions remain (limit 2)"
staging=$(payload_staging_count "$WORKSPACE_ID")
assert_equal "$staging" 0 "staging directories leaked"
assert_payload_state_consistent "$WORKSPACE_ID" || experiment_fail "burst left inconsistent state"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "converged to fifth pin in ${elapsed}s; kept $kept versions; no staging leaked"
