#!/usr/bin/env bash
set -uo pipefail

script_dir=$(realpath "$(dirname "$0")")
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
results_dir="$script_dir/results"
result="$results_dir/$timestamp.md"
mkdir -p "$results_dir"

if [ "${PAYLOAD_LAB_DRY:-0}" = 1 ] && [ -z "${LAB_WORKSPACES:-}" ]; then
  LAB_WORKSPACES=dry-workspace
fi
if [ -z "${LAB_WORKSPACES:-}" ]; then
  printf 'payload-lab FAIL LAB_WORKSPACES is required\n' >&2
  exit 1
fi
read -r -a workspaces <<<"$LAB_WORKSPACES"

{
  printf '# Payload lab %s\n\n' "$timestamp"
  printf '| Run | Workspace |'
  for experiment in $(seq 1 16); do printf ' E%s |' "$experiment"; done
  printf '\n|---:|---|'
  for _experiment in $(seq 1 16); do printf '%s' '---|'; done
  printf '\n'
} >"$result"

failures=0
for run in 1 2 3; do
  workspace_index=0
  for workspace in "${workspaces[@]}"; do
    workspace_index=$((workspace_index + 1))
    printf '| %s | `%s` |' "$run" "$workspace" >>"$result"
    for experiment in $(seq 1 16); do
      output="$results_dir/.$timestamp-r$run-w$workspace_index-e$experiment.log"
      if LAB_RUN_ID="$timestamp-r$run-w$workspace_index-e$experiment" \
        "$script_dir/e$experiment.sh" "$workspace" >"$output" 2>&1; then
        status=PASS
      else
        status=FAIL
        failures=$((failures + 1))
      fi
      final=$(tail -n 1 "$output")
      printf ' %s |' "$status" >>"$result"
      printf '[run %s workspace %s] %s\n' "$run" "$workspace" "$final" >&2
    done
    printf '\n' >>"$result"
  done
done

printf '\nFailures: %s\n' "$failures" >>"$result"
printf 'payload-lab matrix: %s (%s failures)\n' "$result" "$failures"
[ "$failures" -eq 0 ]
