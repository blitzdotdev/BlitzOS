#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
payload_lab_init E8 "$@"

if payload_lab_dry; then
  dry_command "apply a payload and record its downloaded manifest identity"
  publish_variant e8-before-image
  pin_payload "$PUBLISHED_VERSION"
  dry_command "change the origin manifest evidence; request image update; prove baked from the boot log"
  dry_command "assert a new manifest identity, the origin evidence, and convergence to the pin"
  experiment_pass "dry run: image replacement redownload assertions"
fi

require_workspace
publish_variant e8-before-image
pin_payload "$PUBLISHED_VERSION"
wait_payload_outcome "$MACHINE_ID" "$PUBLISHED_VERSION" applied "$LAB_OUTCOME_TIMEOUT" \
  || experiment_fail "initial payload was not applied"
before_identity=$(payload_cache_identity "$WORKSPACE_ID" "$PUBLISHED_VERSION") \
  || experiment_fail "downloaded manifest is absent"
reported_before=$(payload_reported_at "$MACHINE_ID" "$WORKSPACE_ID") \
  || experiment_fail "payload report timestamp is unavailable"
origin_created_at=$(( $(date +%s) * 1000 + $$ % 1000 ))
origin_manifest="$LAB_TEMP_ROOT/e8-redownload-manifest.json"
jq --argjson created_at "$origin_created_at" '.createdAt = $created_at' \
  "$PUBLISHED_RELEASE_DIR/manifest.json" >"$origin_manifest"
_r2_put "$PUBLISHED_PREFIX/manifest.json" "$origin_manifest" \
  'application/json; charset=utf-8'

box_ssh "$WORKSPACE_ID" 'blitz box update' >/dev/null \
  || experiment_fail "box image update request failed"
wait_box_ssh "$WORKSPACE_ID" false "$LAB_IMAGE_UPDATE_TIMEOUT" \
  || experiment_fail "container replacement never interrupted SSH"
wait_box_ssh "$WORKSPACE_ID" true 300 \
  || experiment_fail "replacement image did not boot"

wait_payload_any_outcome_after \
  "$MACHINE_ID" "$WORKSPACE_ID" "$reported_before" "$LAB_OUTCOME_TIMEOUT" \
  applied booted up-to-date \
  || experiment_fail "replacement updater did not report after boot"
wait_payload_current "$WORKSPACE_ID" "$PUBLISHED_VERSION" 30 \
  || experiment_fail "pin is not current after first tick"
after_identity=$(payload_cache_identity "$WORKSPACE_ID" "$PUBLISHED_VERSION")
[ "$after_identity" != "$before_identity" ] \
  || experiment_fail "replacement retained the old manifest identity"
downloaded_created_at=$(box_ssh "$WORKSPACE_ID" \
  "jq -er .createdAt /opt/blitz/payload/versions/$PUBLISHED_VERSION/.manifest.json")
assert_equal "$downloaded_created_at" "$origin_created_at" \
  "redownloaded manifest did not contain the origin request evidence"
baked_version=$(box_ssh "$WORKSPACE_ID" 'cat /opt/blitz/payload/baked/payload-version')
box_ssh "$WORKSPACE_ID" \
  "grep -F 'blitz-payload: booted $baked_version daemon ' /opt/blitz/payload/state/log >/dev/null" \
  || experiment_fail "replacement boot log did not record the baked payload"
assert_no_orphans "$WORKSPACE_ID"
experiment_pass "replacement booted baked and redownloaded $PUBLISHED_VERSION before converging"
