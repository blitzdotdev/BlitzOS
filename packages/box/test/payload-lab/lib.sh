#!/usr/bin/env bash
# Shared driver for plans/THIN-IMAGE.md section 6.
#
# THINLAB_TOKEN is a machine-plane bearer from `blitz-cred api-token`.
# THINLAB_COOKIE is a workspace-admin `blitz_session` cookie value; session
# credentials are not bearer tokens and must use this separate path.
#
# Control-plane proxy probes need session/operator scope. THINLAB_COOKIE
# supplies the session form; THINLAB_PROXY_TOKEN may supply an operator bearer.
# E2 probes locally instead. Neither token is ever printed by this harness.

PAYLOAD_LAB_DIR=$(realpath "$(dirname "${BASH_SOURCE[0]}")")
PAYLOAD_LAB_REPO=$(realpath "$PAYLOAD_LAB_DIR/../../../..")
PAYLOAD_LAB_SESSION_DRIVER="$PAYLOAD_LAB_DIR/session-driver/drive.mjs"
THINLAB_ORIGIN=${THINLAB_ORIGIN:-https://blitz-thinlab.minjunesv0.workers.dev}
LAB_R2_BUCKET=${LAB_R2_BUCKET:-blitz-thinlab-images}
LAB_CP_TIMEOUT=${LAB_CP_TIMEOUT:-75}
LAB_OUTCOME_TIMEOUT=${LAB_OUTCOME_TIMEOUT:-420}
LAB_PAYLOAD_INTERVAL=${LAB_PAYLOAD_INTERVAL:-300}
LAB_IMAGE_UPDATE_TIMEOUT=${LAB_IMAGE_UPDATE_TIMEOUT:-420}
LAB_TURN_TIMEOUT=${LAB_TURN_TIMEOUT:-900}
LAB_HEALTH_PATH=${LAB_HEALTH_PATH:-/healthz}

EXPERIMENT_ID=
WORKSPACE_ID=
MACHINE_ID=
LAB_FINAL_LINE=false
LAB_TEMP_ROOT=
LAB_DEPLOY_REPO=${LAB_DEPLOY_REPO:-}
LAB_REMOTE_CLEANUP_WORKSPACE=
LAB_REMOTE_CLEANUP_COMMAND=
LAB_SESSION_CLEANUP_WORKSPACE=
LAB_SESSION_CLEANUP_ID=
LAB_TEST_TERMINAL_KEY=
LAB_TEST_TERMINAL_SESSION=
LAB_TEST_TERMINAL_PLACEMENT=
PUBLISHED_VERSION=
PUBLISHED_REF=
PUBLISHED_PREFIX=
PUBLISHED_RELEASE_DIR=
PUBLISHED_MARKER=

payload_lab_dry() {
  [ "${PAYLOAD_LAB_DRY:-0}" = 1 ]
}

payload_lab_trace() {
  printf '[%s] %s\n' "${EXPERIMENT_ID:-payload-lab}" "$*" >&2
}

dry_command() {
  payload_lab_trace "DRY $*"
}

_payload_lab_cleanup() {
  local pid
  while IFS= read -r pid; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done < <(jobs -pr)
  if [ -n "$LAB_REMOTE_CLEANUP_WORKSPACE" ] && [ -n "$LAB_REMOTE_CLEANUP_COMMAND" ]; then
    box_ssh "$LAB_REMOTE_CLEANUP_WORKSPACE" "$LAB_REMOTE_CLEANUP_COMMAND" \
      >/dev/null 2>&1 || true
  fi
  if [ -n "$LAB_SESSION_CLEANUP_WORKSPACE" ] && [ -n "$LAB_SESSION_CLEANUP_ID" ]; then
    cancel_turn "$LAB_SESSION_CLEANUP_WORKSPACE" "$LAB_SESSION_CLEANUP_ID" \
      >/dev/null 2>&1 || true
  fi
  if [ -n "$LAB_TEMP_ROOT" ] && [ -d "$LAB_TEMP_ROOT" ]; then
    rm -rf "$LAB_TEMP_ROOT"
  fi
}

_payload_lab_exit() {
  local status=$?
  _payload_lab_cleanup
  if [ "$LAB_FINAL_LINE" != true ]; then
    printf '%s FAIL unexpected exit %s\n' "${EXPERIMENT_ID:-payload-lab}" "$status"
  fi
}

payload_lab_init() {
  EXPERIMENT_ID=${1:?experiment id is required}
  shift
  WORKSPACE_ID=${1:-${LAB_WORKSPACE:-}}
  MACHINE_ID=${2:-${LAB_MACHINE_ID:-}}
  if payload_lab_dry; then
    WORKSPACE_ID=${WORKSPACE_ID:-dry-workspace}
    MACHINE_ID=${MACHINE_ID:-dry-machine}
  fi
  LAB_TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/payload-lab.${EXPERIMENT_ID}.XXXXXX")
  trap _payload_lab_exit EXIT
}

experiment_pass() {
  local reason=${1//$'\n'/ }
  LAB_FINAL_LINE=true
  printf '%s PASS %s\n' "$EXPERIMENT_ID" "$reason"
  exit 0
}

experiment_fail() {
  local reason=${1//$'\n'/ }
  LAB_FINAL_LINE=true
  printf '%s FAIL %s\n' "$EXPERIMENT_ID" "$reason"
  exit 1
}

experiment_skip() {
  local reason=${1//$'\n'/ }
  LAB_FINAL_LINE=true
  printf '%s SKIP %s\n' "$EXPERIMENT_ID" "$reason"
  exit 0
}

require_env() {
  local name=$1
  [ -n "${!name:-}" ] || experiment_fail "$name is required"
}

require_workspace() {
  [ -n "$WORKSPACE_ID" ] || experiment_fail "workspace id is required"
  if [ -z "${THINLAB_COOKIE:-}" ] && [ -z "${THINLAB_TOKEN:-}" ]; then
    experiment_fail "THINLAB_COOKIE or THINLAB_TOKEN is required"
  fi
  require_env LAB_SSH_KEY
  [ -r "$LAB_SSH_KEY" ] || experiment_fail "LAB_SSH_KEY is not readable"
  if [ -z "$MACHINE_ID" ]; then
    MACHINE_ID=$(workspace_json "$WORKSPACE_ID" | jq -er \
      '.workspace.members[].machine | select(. != null and .state != "destroyed") | .id' \
      | head -n 1) || experiment_fail "workspace has no live machine"
  fi
}

cp_api_with_token() {
  local token=$1 method=$2 path=$3 body=${4-}
  if payload_lab_dry; then
    dry_command "curl -X $method $THINLAB_ORIGIN$path (bearer redacted)"
    return 0
  fi
  local args=(
    --silent --show-error --fail-with-body
    --max-time "$LAB_CP_TIMEOUT"
    --request "$method"
    --header "Authorization: Bearer $token"
  )
  if [ -n "$body" ]; then
    args+=(--header 'Content-Type: application/json' --data "$body")
  fi
  curl "${args[@]}" "$THINLAB_ORIGIN$path"
}

cp_api_with_cookie() {
  local cookie=$1 method=$2 path=$3 body=${4-}
  if payload_lab_dry; then
    dry_command "curl -X $method $THINLAB_ORIGIN$path (blitz_session cookie redacted)"
    return 0
  fi
  local args=(
    --silent --show-error --fail-with-body
    --max-time "$LAB_CP_TIMEOUT"
    --request "$method"
    --header "Cookie: blitz_session=$cookie"
  )
  if [ -n "$body" ]; then
    args+=(--header 'Content-Type: application/json' --data "$body")
  fi
  curl "${args[@]}" "$THINLAB_ORIGIN$path"
}

cp_api() {
  if [ -n "${THINLAB_COOKIE:-}" ]; then
    cp_api_with_cookie "$THINLAB_COOKIE" "$@"
  else
    require_env THINLAB_TOKEN
    cp_api_with_token "$THINLAB_TOKEN" "$@"
  fi
}

workspace_json() {
  cp_api GET "/workspaces/$1"
}

workspace_for_machine() {
  local machine_id=$1
  cp_api GET /workspaces | jq -er --arg machine "$machine_id" \
    '.workspaces[] | select(any(.members[].machine; . != null and .id == $machine)) | .id'
}

machine_json() {
  local machine_id=$1 workspace_id=${2:-}
  if [ -z "$workspace_id" ]; then
    workspace_id=$(workspace_for_machine "$machine_id")
  fi
  workspace_json "$workspace_id" | jq -ec --arg machine "$machine_id" \
    '.workspace.members[].machine | select(. != null and .id == $machine)'
}

machine_type_json() {
  local machine_type_id=$1
  cp_api GET /machine-types | jq -ec --arg machine_type "$machine_type_id" \
    '.machineTypes[] | select(.id == $machine_type)'
}

_ssh_target() {
  local workspace_id=$1 field=$2
  workspace_json "$workspace_id" | jq -er ".workspace.ssh.$field"
}

_ssh_options() {
  local key=$1
  printf '%s\n' \
    -i "$key" \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=4 \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR
}

box_ssh() {
  local workspace_id=$1 command=$2
  if payload_lab_dry; then
    dry_command "ssh blitz@<workspace:$workspace_id> $command"
    return 0
  fi
  local host port user
  host=$(_ssh_target "$workspace_id" host)
  port=$(_ssh_target "$workspace_id" port)
  user=$(_ssh_target "$workspace_id" user)
  local options=()
  mapfile -t options < <(_ssh_options "$LAB_SSH_KEY")
  ssh "${options[@]}" -p "$port" "$user@$host" "$command"
}

# Opens the box's bridge through SSH and dispatches one real Lody turn. The
# driver prints only the session id on stdout, so callers may capture it while
# transport/runtime progress continues to the experiment log on stderr.
start_turn() {
  local workspace_id=$1 prompt=$2 permissions=${3:-allow} host port user target
  if payload_lab_dry; then
    dry_command "session-driver open <workspace:$workspace_id>; create ${LAB_TURN_AGENT:-claude} turn with $permissions permissions"
    printf 'dry-session-%s\n' "${EXPERIMENT_ID:-payload-lab}"
    return 0
  fi
  host=$(_ssh_target "$workspace_id" host)
  port=$(_ssh_target "$workspace_id" port)
  user=$(_ssh_target "$workspace_id" user)
  if [[ "$host" == *:* && "$host" != \[*\] ]]; then
    target="$user@[$host]:$port"
  else
    target="$user@$host:$port"
  fi
  node "$PAYLOAD_LAB_SESSION_DRIVER" open --ssh "$target" --key "$LAB_SSH_KEY" >&2
  local args=(
    session create
    --agent "${LAB_TURN_AGENT:-claude}"
    --prompt "$prompt"
    --permissions "$permissions"
  )
  if [ -n "${LAB_TURN_PROJECT:-}" ]; then
    args+=(--project "$LAB_TURN_PROJECT")
  fi
  node "$PAYLOAD_LAB_SESSION_DRIVER" "${args[@]}"
}

# Waits for the exact turn started above. A completed turn returns zero; agent
# failure and timeout return non-zero, with the driver's terminal JSON retained
# on stdout for the experiment log or a caller-selected file.
wait_turn() {
  local workspace_id=$1 session_id=$2 timeout=$3
  if payload_lab_dry; then
    dry_command "session-driver wait $session_id on <workspace:$workspace_id> for ${timeout}s"
    return 0
  fi
  node "$PAYLOAD_LAB_SESSION_DRIVER" session wait "$session_id" --timeout "$timeout"
}

# With an `ask` policy, driver wait returns non-zero as soon as the exact
# session requests permission. That terminal JSON is the precondition: the
# turn is genuinely active without relying on a shell command staying in the
# foreground or on any daemon-wide presence pick.
wait_turn_permission() {
  local workspace_id=$1 session_id=$2 timeout=$3 output=$4
  if payload_lab_dry; then
    dry_command "session-driver wait $session_id for its own permission request for ${timeout}s"
    return 0
  fi
  if wait_turn "$workspace_id" "$session_id" "$timeout" >"$output"; then
    return 1
  fi
  jq -e '.state == "awaitingPermission" and (.permissionRequest.requestId | type == "string")' \
    "$output" >/dev/null
}

set_turn_permissions() {
  local workspace_id=$1 session_id=$2 permissions=$3
  if payload_lab_dry; then
    dry_command "session-driver permissions $session_id $permissions on <workspace:$workspace_id>"
    return 0
  fi
  node "$PAYLOAD_LAB_SESSION_DRIVER" session permissions "$session_id" "$permissions"
}

session_status() {
  local workspace_id=$1 session_id=$2
  if payload_lab_dry; then
    dry_command "session-driver status $session_id on <workspace:$workspace_id>"
    printf '{"sessionId":"%s","state":"running","lastAssistantText":null}\n' "$session_id"
    return 0
  fi
  node "$PAYLOAD_LAB_SESSION_DRIVER" session status "$session_id"
}

# Polls only the driver-created session named by the caller. Daemon-wide
# presence is deliberately irrelevant: a real member box can have unrelated
# running or permission-blocked sessions that this harness must never touch.
wait_session_state() {
  local workspace_id=$1 session_id=$2 expected=$3 timeout=$4
  local deadline status observed
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    status=$(session_status "$workspace_id" "$session_id" 2>/dev/null) || status=
    observed=$(printf '%s' "$status" | jq -r '.state // "unavailable"' 2>/dev/null) \
      || observed=unavailable
    if [ "$observed" = "$expected" ]; then
      printf '%s\n' "$status"
      return 0
    fi
    sleep 1
  done
  payload_lab_trace "session $session_id last reported ${observed:-unavailable}, wanted $expected"
  return 1
}

assert_completed_turn_text() {
  local status_file=$1 expected=$2 reason=$3
  jq -e --arg expected "$expected" \
    '.state == "completed" and ((.lastAssistantText // "") | ascii_downcase | contains($expected | ascii_downcase))' \
    "$status_file" >/dev/null || experiment_fail "$reason"
}

arm_turn_cleanup() {
  LAB_SESSION_CLEANUP_WORKSPACE=$1
  LAB_SESSION_CLEANUP_ID=$2
}

disarm_turn_cleanup() {
  LAB_SESSION_CLEANUP_WORKSPACE=
  LAB_SESSION_CLEANUP_ID=
}

# Stops the exact active assistant turn for a driver-created session.
cancel_turn() {
  local workspace_id=$1 session_id=$2
  if payload_lab_dry; then
    dry_command "session-driver cancel $session_id on <workspace:$workspace_id>"
    return 0
  fi
  node "$PAYLOAD_LAB_SESSION_DRIVER" session cancel "$session_id"
}

# Creates the terminal E2 owns without inspecting or changing any other tmux
# session. blitz-term wraps a new pane in this exact cgroup placement. A plain
# tmux fallback keeps the gateway-restart assertion usable on an older image
# whose unprivileged cgroup helper cannot create the leaf.
create_test_terminal() {
  local workspace_id=$1 run_id session experiment_slug
  run_id=${LAB_RUN_ID:-$(date -u +%Y%m%dT%H%M%S)-$$}
  run_id=${run_id//[^A-Za-z0-9_-]/-}
  experiment_slug=${EXPERIMENT_ID,,}
  experiment_slug=${experiment_slug//[^a-z0-9_-]/-}
  LAB_TEST_TERMINAL_KEY="lab-$experiment_slug-$run_id"
  session="term-$LAB_TEST_TERMINAL_KEY"
  LAB_TEST_TERMINAL_SESSION=$session
  LAB_REMOTE_CLEANUP_WORKSPACE=$workspace_id
  LAB_REMOTE_CLEANUP_COMMAND="tmux kill-session -t '=$session' 2>/dev/null || true"

  box_ssh "$workspace_id" "! tmux has-session -t '=$session' 2>/dev/null" \
    || experiment_fail "refusing to replace existing tmux session $session"
  if box_ssh "$workspace_id" \
    "tmux new-session -d -s '$session' /usr/local/bin/blitz-cgroup enter 'user/tab-$session' -- sleep 3600; sleep 1; tmux has-session -t '=$session'"; then
    LAB_TEST_TERMINAL_PLACEMENT=cgroup
  else
    box_ssh "$workspace_id" \
      "tmux kill-session -t '=$session' 2>/dev/null || true; tmux new-session -d -s '$session' sleep 3600; sleep 1; tmux has-session -t '=$session'" \
      || experiment_fail "could not create E2 tmux session $session"
    LAB_TEST_TERMINAL_PLACEMENT=plain
    payload_lab_trace "cgroup placement was unavailable; using the permitted plain tmux fallback"
  fi
}

tmux_session_identity() {
  box_ssh "$1" "tmux display-message -p -t '=$2' '#{session_id}:#{session_created}'"
}

wait_payload_outcome() {
  local machine_id=$1 version=$2 outcome=$3 timeout=$4
  local workspace_id deadline now observed
  workspace_id=$(workspace_for_machine "$machine_id") || return 1
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    observed=$(machine_json "$machine_id" "$workspace_id" | jq -r \
      --arg version "$version" \
      'if .payloadVersion == $version then (.payloadOutcome // "null") else "other-version" end') \
      || observed=unavailable
    if [ "$observed" = "$outcome" ]; then
      return 0
    fi
    now=$(date +%s)
    [ "$now" -lt "$deadline" ] || {
      payload_lab_trace "last outcome for $machine_id/$version was $observed"
      return 1
    }
    sleep 2
  done
}

# Failure reports name the payload that remains running, not the attempted
# target. Pair the newer control-plane report with state.json's failed record
# so a stale outcome or a different failed pin cannot satisfy the assertion.
wait_payload_failure() {
  local machine_id=$1 workspace_id=$2 version=$3 outcome=$4 after=$5 timeout=$6
  local deadline view state observed reported_at failed_version failed_outcome
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    view=$(machine_json "$machine_id" "$workspace_id" 2>/dev/null) || view=
    observed=$(printf '%s' "$view" | jq -r '.payloadOutcome // "null"' 2>/dev/null) \
      || observed=unavailable
    reported_at=$(printf '%s' "$view" | jq -r '.payloadReportedAt // 0' 2>/dev/null) \
      || reported_at=0
    state=$(payload_state "$workspace_id" 2>/dev/null) || state=
    failed_version=$(printf '%s' "$state" | jq -r '.failed.version // "none"' 2>/dev/null) \
      || failed_version=unavailable
    failed_outcome=$(printf '%s' "$state" | jq -r '.failed.outcome // "none"' 2>/dev/null) \
      || failed_outcome=unavailable
    if [ "$observed" = "$outcome" ] && [ "$reported_at" -gt "$after" ] \
        && [ "$failed_version" = "$version" ] && [ "$failed_outcome" = "$outcome" ]; then
      return 0
    fi
    sleep 2
  done
  payload_lab_trace \
    "last failure was report=$observed@$reported_at state=$failed_outcome/$failed_version"
  return 1
}

# Fetch failures are deliberately retried on later scheduled ticks and do not
# populate state.failed. A timestamp newer than the pre-pin snapshot proves
# this outcome belongs to the current experiment.
wait_payload_outcome_after() {
  local machine_id=$1 workspace_id=$2 outcome=$3 after=$4 timeout=$5
  local deadline view observed reported_at
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    view=$(machine_json "$machine_id" "$workspace_id" 2>/dev/null) || view=
    observed=$(printf '%s' "$view" | jq -r '.payloadOutcome // "null"' 2>/dev/null) \
      || observed=unavailable
    reported_at=$(printf '%s' "$view" | jq -r '.payloadReportedAt // 0' 2>/dev/null) \
      || reported_at=0
    if [ "$observed" = "$outcome" ] && [ "$reported_at" -gt "$after" ]; then
      return 0
    fi
    sleep 2
  done
  payload_lab_trace "last outcome was $observed@$reported_at, wanted $outcome after $after"
  return 1
}

wait_payload_any_outcome_after() {
  local machine_id=$1 workspace_id=$2 after=$3 timeout=$4
  shift 4
  local deadline view observed reported_at expected
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    view=$(machine_json "$machine_id" "$workspace_id" 2>/dev/null) || view=
    observed=$(printf '%s' "$view" | jq -r '.payloadOutcome // "null"' 2>/dev/null) \
      || observed=unavailable
    reported_at=$(printf '%s' "$view" | jq -r '.payloadReportedAt // 0' 2>/dev/null) \
      || reported_at=0
    if [ "$reported_at" -gt "$after" ]; then
      for expected in "$@"; do
        [ "$observed" = "$expected" ] && return 0
      done
    fi
    sleep 2
  done
  payload_lab_trace "last outcome was $observed@$reported_at after $after"
  return 1
}

wait_payload_any_outcome() {
  local machine_id=$1 version=$2 timeout=$3
  shift 3
  local workspace_id deadline observed expected
  workspace_id=$(workspace_for_machine "$machine_id") || return 1
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    observed=$(machine_json "$machine_id" "$workspace_id" | jq -r \
      --arg version "$version" \
      'if .payloadVersion == $version then (.payloadOutcome // "null") else "other-version" end') \
      || observed=unavailable
    for expected in "$@"; do
      [ "$observed" = "$expected" ] && return 0
    done
    sleep 2
  done
  payload_lab_trace "last outcome for $machine_id/$version was $observed"
  return 1
}

wait_payload_deferred() {
  local machine_id=$1 workspace_id=$2 version=$3 timeout=$4 deadline outcome staged
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    outcome=$(machine_json "$machine_id" "$workspace_id" | jq -r '.payloadOutcome // "null"') \
      || outcome=unavailable
    staged=$(payload_state "$workspace_id" | jq -r '.deferred.version // "none"') \
      || staged=unavailable
    if [ "$outcome" = deferred ] && [ "$staged" = "$version" ]; then
      return 0
    fi
    sleep 2
  done
  payload_lab_trace "last deferred state for $machine_id was outcome=$outcome staged=$staged"
  return 1
}

payload_state() {
  box_ssh "$1" 'cat /opt/blitz/payload/state/state.json'
}

payload_log_size() {
  box_ssh "$1" 'wc -c </opt/blitz/payload/state/log'
}

payload_log_since() {
  local workspace_id=$1 offset=$2
  box_ssh "$workspace_id" "tail -c +$((offset + 1)) /opt/blitz/payload/state/log"
}

payload_apply_in_progress() {
  box_ssh "$1" 'test -n "$(find /opt/blitz/payload/versions /opt/blitz/lody -mindepth 1 -maxdepth 1 -name "*.staging" -print -quit 2>/dev/null)" || jq -e '\''has("pending")'\'' /opt/blitz/payload/state/state.json >/dev/null'
}

payload_current() {
  payload_state "$1" | jq -er .current
}

daemon_version() {
  payload_state "$1" | jq -er .daemonVersion
}

wait_payload_current() {
  local workspace_id=$1 expected=$2 timeout=$3 deadline
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(payload_current "$workspace_id" 2>/dev/null || true)" = "$expected" ] && return 0
    sleep 1
  done
  return 1
}

assert_payload_state_consistent() {
  box_ssh "$1" 'set -e
state=/opt/blitz/payload/state/state.json
jq -e '\''(.current | type == "string") and (.currentTarget | type == "string") and (has("pending") | not)'\'' "$state" >/dev/null
target=$(jq -r .currentTarget "$state")
test -d "$target"
test "$(readlink -f /opt/blitz/payload/current)" = "$(readlink -f "$target")"'
}

payload_version_count() {
  box_ssh "$1" \
    'find /opt/blitz/payload/versions -mindepth 1 -maxdepth 1 -type d ! -name "*.staging" -print 2>/dev/null | wc -l'
}

payload_staging_count() {
  box_ssh "$1" \
    'find /opt/blitz/payload/versions /opt/blitz/lody -mindepth 1 -maxdepth 1 -name "*.staging" -print 2>/dev/null | wc -l'
}

payload_cache_identity() {
  local workspace_id=$1 version=$2
  box_ssh "$workspace_id" \
    "stat -c '%i:%y:%s' /opt/blitz/payload/versions/$version/.manifest.json"
}

payload_reported_at() {
  machine_json "$1" "${2:-}" | jq -er '.payloadReportedAt // 0'
}

payload_process_ticks() {
  box_ssh "$1" 'pid=$(cat /run/service/payload/supervise/pid); set -- $(cat "/proc/$pid/stat"); printf "%s\n" $(( ${14} + ${15} ))'
}

session_running() {
  local workspace_id=$1
  box_ssh "$workspace_id" \
    'curl --silent --fail --max-time 3 --unix-socket /var/lib/blitz/lody/run/lody-oss-probe.sock http://localhost/state | jq -e '\''(.activeSessionCount // 0) > 0'\'' >/dev/null'
}

wait_session_running() {
  local workspace_id=$1 timeout=$2 deadline
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    session_running "$workspace_id" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

wait_session_idle() {
  local workspace_id=$1 timeout=$2 deadline
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! session_running "$workspace_id" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

daemon_pid() {
  box_ssh "$1" \
    'curl --silent --fail --max-time 3 --unix-socket /var/lib/blitz/lody/run/lody-oss-probe.sock http://localhost/state | jq -er .pid'
}

# runit's supervise directory is root-only on the live image. The gateway
# process itself is visible to the unprivileged workspace user, and its exact
# argv distinguishes it from s6-supervise and this harness's SSH commands.
gateway_pid() {
  box_ssh "$1" "pgrep -fo '^/usr/local/bin/blitz-box-gateway$'"
}

session_catalog() {
  box_ssh "$1" \
    'jq -r '\''.sessions[]?.sessionId'\'' /var/lib/blitz/lody/workspace-catalog.json | sort'
}

tmux_catalog() {
  box_ssh "$1" "tmux list-sessions -F '#{session_id}:#{session_created}' 2>/dev/null | sort || true"
}

service_pids() {
  box_ssh "$1" 'for service in /run/service/*; do
name=${service##*/}
pid=$(cat "$service/supervise/pid" 2>/dev/null || true)
[ -n "$pid" ] && printf "%s=%s\n" "$name" "$pid"
done | sort'
}

# Prints one line per populated non-leaf cgroup. A parent with delegated
# controllers must be empty; all work belongs in one of its leaf children.
orphans() {
  box_ssh "$1" 'find /sys/fs/cgroup -name cgroup.subtree_control -type f -print 2>/dev/null | while IFS= read -r control; do
group=${control%/cgroup.subtree_control}
controllers=$(cat "$control" 2>/dev/null) || continue
[ -n "$controllers" ] || continue
pids=$(cat "$group/cgroup.procs" 2>/dev/null) || continue
[ -n "$pids" ] || continue
printf "%s:" "${group#/sys/fs/cgroup}"
for pid in $pids; do printf " %s" "$pid"; done
printf "\n"
done'
}

assert_equal() {
  local actual=$1 expected=$2 reason=$3
  [ "$actual" = "$expected" ] || experiment_fail "$reason"
}

assert_no_orphans() {
  local found
  found=$(orphans "$1") || experiment_fail "could not inspect cgroup parents"
  [ -z "$found" ] || experiment_fail "processes escaped cgroup leaves: $found"
}

_variant_overlay() {
  local name=$1 repo=$2 overlay=$3 marker=$4 source target
  case "$name" in
    e2-* | e6-*)
      source=packages/box/gateway/main.go
      target="$overlay/$source"
      mkdir -p "$(dirname "$target")"
      cp "$repo/$source" "$target"
      if [[ "$name" = e6-* ]]; then
        sed -i '0,/^func main() {$/s//func main() {\n\tos.Exit(1)/' "$target"
      else
        sed -i \
          "0,/^func main() {$/s//func main() {\\n\\tlog.Print(\"$marker\")/" \
          "$target"
      fi
      ;;
    daemon-*)
      # A daemon-only release changes no payload source. Its distinct identity
      # is stamped into the archive by _prepare_daemon_variant instead.
      ;;
    *)
      source=packages/box/rootfs/usr/local/libexec/blitz-term
      target="$overlay/$source"
      mkdir -p "$(dirname "$target")"
      cp "$repo/$source" "$target"
      printf '\n# payload-lab %s\n' "$marker" >>"$target"
      ;;
  esac
  cp -a "$overlay/." "$repo/"
}

_r2_put() {
  local logical_path=$1 file=$2 content_type=$3
  payload_lab_trace "overwriting test object $LAB_R2_BUCKET/$logical_path"
  "$PAYLOAD_LAB_REPO/node_modules/.bin/wrangler" r2 object put \
    "$LAB_R2_BUCKET/$logical_path" \
    --file "$file" --content-type "$content_type" --remote \
    --config "$LAB_DEPLOY_REPO/packages/control-plane/wrangler.toml"
}

_mutate_published_variant() {
  local name=$1 manifest="$PUBLISHED_RELEASE_DIR/manifest.json" mutated
  case "$name" in
    e5-archive-*)
      mutated="$PUBLISHED_RELEASE_DIR/corrupt-payload.tar.gz"
      printf 'payload-lab corrupt archive\n' >"$mutated"
      _r2_put "$PUBLISHED_PREFIX/payload.tar.gz" "$mutated" application/gzip
      ;;
    e5-file-*)
      mutated="$PUBLISHED_RELEASE_DIR/file-sha-manifest.json"
      jq '.files[0].sha256 = ("0" * 64)' "$manifest" >"$mutated"
      _r2_put "$PUBLISHED_PREFIX/manifest.json" "$mutated" 'application/json; charset=utf-8'
      ;;
    e5-manifest-*)
      mutated="$PUBLISHED_RELEASE_DIR/bad-manifest.json"
      jq '.restart["not-a-service"] = []' "$manifest" >"$mutated"
      _r2_put "$PUBLISHED_PREFIX/manifest.json" "$mutated" 'application/json; charset=utf-8'
      ;;
    e12-*)
      mutated="$PUBLISHED_RELEASE_DIR/min-updater-manifest.json"
      jq '.minUpdater = 99' "$manifest" >"$mutated"
      _r2_put "$PUBLISHED_PREFIX/manifest.json" "$mutated" 'application/json; charset=utf-8'
      ;;
  esac
}

# Makes a distinct daemon identity from the supplied, already-built archive.
# The lab only needs a healthy daemon restart boundary; rebuilding the Docker
# daemon target for every experiment would add no coverage. Keep its executable
# bytes and protocol stamp, but suffix its version with a serial derived from
# the experiment marker, so the updater has a real version and digest change
# to apply. The suffix keeps the stamp a version token.
_prepare_daemon_variant() {
  local base_archive=$1 output_archive=$2 marker=$3 prefix base_version serial
  prefix=${output_archive%.tar.gz}.root
  mkdir -p "$prefix"
  tar -xzf "$base_archive" -C "$prefix"
  base_version=$(tr -d '\n' <"$prefix/daemon-version")
  [ -n "$base_version" ] || experiment_fail "the base daemon archive carries no daemon-version stamp"
  serial=$(printf '%s' "$marker" | cksum)
  serial=${serial%% *}
  printf '%s+lab.%s\n' "$base_version" "$serial" >"$prefix/daemon-version"
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    -czf "$output_archive" -C "$prefix" \
    bin daemon-protocol-version daemon-version lib
}

# Materialises an overlay in an isolated clone because the production
# publisher intentionally has no test-only --overlay option. The publisher is
# then called against that overlaid repo and remains the only artifact writer.
publish_variant() {
  local name=$1 run_id marker root repo overlay release published daemon_archive
  local daemon_args=()
  if payload_lab_dry; then
    dry_command "materialize overlay $name; publish-box-payload.mjs --repo <overlay-$name>"
    PUBLISHED_VERSION="dry-$name"
    PUBLISHED_REF="$THINLAB_ORIGIN/box-payload/$PUBLISHED_VERSION/manifest.json"
    PUBLISHED_PREFIX="box-payload/$PUBLISHED_VERSION"
    PUBLISHED_MARKER="payload-lab-$name"
    return 0
  fi
  require_thinlab_deploy_config
  run_id=${LAB_RUN_ID:-$(date -u +%Y%m%dT%H%M%S)-$$}
  marker="payload-lab-$EXPERIMENT_ID-$name-$run_id"
  root="$LAB_TEMP_ROOT/variant-$name"
  repo="$root/repo"
  overlay="$root/overlay"
  release="$root/release"
  mkdir -p "$overlay"
  git clone --quiet --no-hardlinks "$PAYLOAD_LAB_REPO" "$repo"
  _variant_overlay "$name" "$repo" "$overlay" "$marker"
  (
    cd "$repo"
    git add --all
    git -c user.name=payload-lab -c user.email=payload-lab@invalid \
      commit --quiet --allow-empty -m "payload lab variant $name"
  )
  ln -s "$PAYLOAD_LAB_REPO/node_modules" "$repo/node_modules"
  # Execute the publisher from the overlay checkout so its imported release
  # metadata comes from the same tree as the payload sources. Keep the lab
  # deployment config, which is intentionally uncommitted, rather than the
  # clone's tracked production defaults.
  cp "$LAB_DEPLOY_REPO/packages/control-plane/wrangler.toml" \
    "$repo/packages/control-plane/wrangler.toml"
  if [[ "$name" = daemon-* ]]; then
    require_env LAB_DAEMON_ARCHIVE
    [ -r "$LAB_DAEMON_ARCHIVE" ] || experiment_fail "LAB_DAEMON_ARCHIVE is not readable"
    daemon_archive="$root/daemon-$name.tar.gz"
    _prepare_daemon_variant "$LAB_DAEMON_ARCHIVE" "$daemon_archive" "$marker"
    daemon_args=(--daemon "$daemon_archive")
  fi
  published="$root/published.json"
  payload_lab_trace "publishing variant $name"
  node "$repo/packages/control-plane/scripts/publish-box-payload.mjs" \
    --repo "$repo" --app-url "$THINLAB_ORIGIN" --bucket "$LAB_R2_BUCKET" \
    --out "$release" --json "$published" "${daemon_args[@]}" >/dev/null
  PUBLISHED_VERSION=$(jq -er .version "$published")
  PUBLISHED_REF=$(jq -er .ref "$published")
  PUBLISHED_PREFIX=$(jq -er .prefix "$published")
  PUBLISHED_RELEASE_DIR=$release
  PUBLISHED_MARKER=$marker
  _mutate_published_variant "$name"
}

# Every deploy the lab performs targets the self-hosted Worker and nothing
# else. The deploy script reads packages/control-plane/wrangler.toml, and a
# checkout whose config was regenerated from the template names the canary
# Worker `blitz-control-plane` in the SAME Cloudflare account: on 2026-09-05
# three harness deploys from such checkouts replaced canary's Worker and
# applied migrations to canary's database. So the deploy runs from
# LAB_DEPLOY_REPO and refuses any config whose name is not blitz-thinlab.
require_thinlab_deploy_config() {
  [ -n "$LAB_DEPLOY_REPO" ] \
    || experiment_fail "LAB_DEPLOY_REPO is required; refusing to deploy from the experiment checkout"
  local config="$LAB_DEPLOY_REPO/packages/control-plane/wrangler.toml"
  [ -r "$config" ] || experiment_fail "no wrangler.toml at $config; refusing to deploy"
  grep -qE '^name = "blitz-thinlab"' "$config" \
    || experiment_fail "$config does not name blitz-thinlab; refusing to deploy anywhere else"
}

pin_payload() {
  local version=$1
  pin_payload_ref "$version" "$THINLAB_ORIGIN/box-payload/$version/manifest.json"
}

pin_payload_ref() {
  local version=$1 ref=$2 version_report deployed_ref deployed_tag
  local configured_ref configured_tag configured_origin configured_bucket
  local image_overrides=()
  payload_lab_trace "pinning payload $version"
  if payload_lab_dry; then
    dry_command "verify /version image ref/tag against wrangler.toml or pass LAB_IMAGE_REF/TAG/SHA256; deploy only the payload pin"
    return 0
  fi
  require_thinlab_deploy_config

  version_report=$(curl --silent --show-error --fail-with-body \
    --max-time "$LAB_CP_TIMEOUT" "$THINLAB_ORIGIN/version") \
    || experiment_fail "could not read the deployed image pin from /version"
  deployed_ref=$(printf '%s' "$version_report" | jq -er '.boxImageRef | strings') \
    || experiment_fail "/version did not report boxImageRef"
  deployed_tag=$(printf '%s' "$version_report" | jq -er '.boxImageTag | strings') \
    || experiment_fail "/version did not report boxImageTag"
  configured_origin=$(_wrangler_string_var APP_URL) \
    || experiment_fail "could not read APP_URL from wrangler.toml"
  configured_bucket=$(_wrangler_string_var bucket_name) \
    || experiment_fail "could not read the R2 bucket from wrangler.toml"
  assert_equal "${configured_origin%/}" "${THINLAB_ORIGIN%/}" \
    "wrangler.toml APP_URL is not the thinlab origin"
  assert_equal "$configured_bucket" "$LAB_R2_BUCKET" \
    "wrangler.toml R2 binding is not the thinlab payload bucket"

  if [ -n "${LAB_IMAGE_REF:-}" ] || [ -n "${LAB_IMAGE_TAG:-}" ] \
      || [ -n "${LAB_IMAGE_SHA256:-}" ]; then
    require_env LAB_IMAGE_REF
    require_env LAB_IMAGE_TAG
    require_env LAB_IMAGE_SHA256
    assert_equal "$LAB_IMAGE_REF" "$deployed_ref" \
      "LAB_IMAGE_REF would change the deployment's image pin"
    assert_equal "$LAB_IMAGE_TAG" "$deployed_tag" \
      "LAB_IMAGE_TAG would change the deployment's image pin"
    image_overrides=(
      "BLITZ_DEPLOY_VAR_BOX_IMAGE_REF=$LAB_IMAGE_REF"
      "BLITZ_DEPLOY_VAR_BOX_IMAGE_TAG=$LAB_IMAGE_TAG"
      "BLITZ_DEPLOY_VAR_BOX_IMAGE_SHA256=$LAB_IMAGE_SHA256"
    )
  else
    configured_ref=$(_wrangler_string_var BOX_IMAGE_REF) \
      || experiment_fail "could not read BOX_IMAGE_REF from wrangler.toml"
    configured_tag=$(_wrangler_string_var BOX_IMAGE_TAG) \
      || experiment_fail "could not read BOX_IMAGE_TAG from wrangler.toml"
    assert_equal "$configured_ref" "$deployed_ref" \
      "wrangler.toml BOX_IMAGE_REF would change the deployment's image pin"
    assert_equal "$configured_tag" "$deployed_tag" \
      "wrangler.toml BOX_IMAGE_TAG would change the deployment's image pin"
  fi
  (
    cd "$LAB_DEPLOY_REPO"
    env "${image_overrides[@]}" \
      BLITZ_DEPLOY_VAR_BOX_PAYLOAD_REF="$ref" \
      BLITZ_DEPLOY_VAR_BOX_PAYLOAD_VERSION="$version" \
        npm run deploy -w packages/control-plane
  )
}

_wrangler_string_var() {
  local name=$1 config="$LAB_DEPLOY_REPO/packages/control-plane/wrangler.toml"
  local line value count
  [ -r "$config" ] || return 1
  count=$(grep -Ec "^[[:space:]]*$name[[:space:]]*=" "$config")
  [ "$count" -eq 1 ] || return 1
  line=$(grep -E "^[[:space:]]*$name[[:space:]]*=" "$config")
  value=${line#*=}
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value" | jq -er 'strings'
}

gateway_health_code() {
  local workspace_id=$1 token=${THINLAB_PROXY_TOKEN:-${THINLAB_TOKEN:-}}
  local auth=() code
  if [ -n "${THINLAB_PROXY_TOKEN:-}" ]; then
    auth=(--header "Authorization: Bearer $THINLAB_PROXY_TOKEN")
  elif [ -n "${THINLAB_COOKIE:-}" ]; then
    auth=(--header "Cookie: blitz_session=$THINLAB_COOKIE")
  elif [ -n "$token" ]; then
    auth=(--header "Authorization: Bearer $token")
  else
    return 1
  fi
  code=$(curl --silent --output /dev/null --max-time 3 --write-out '%{http_code}' \
    "${auth[@]}" "$THINLAB_ORIGIN/workspaces/$workspace_id/webapp/7445$LAB_HEALTH_PATH" \
    2>/dev/null || true)
  printf '%s\n' "${code:-000}"
}

wait_gateway_health() {
  local workspace_id=$1 timeout=$2 deadline code
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    code=$(gateway_health_code "$workspace_id")
    case "$code" in
      2??) return 0 ;;
    esac
    sleep 0.2
  done
  payload_lab_trace "gateway health did not become 2xx (last status ${code:-unavailable})"
  return 1
}

start_health_poll() {
  local workspace_id=$1 output=$2
  (
    while :; do
      printf '%s\t%s\n' "$(date +%s%3N)" "$(gateway_health_code "$workspace_id")" >>"$output"
      sleep 0.2
    done
  ) &
  HEALTH_POLL_PID=$!
}

stop_health_poll() {
  local pid=$1
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

# Samples the gateway over one persistent SSH connection. Any HTTP answer
# below 500 proves the gateway is accepting requests; authentication can make
# the deliberately bare /healthz request return 403 while it is healthy.
start_local_gateway_health_poll() {
  local workspace_id=$1 output=$2
  box_ssh "$workspace_id" 'while :; do
timestamp=$(date +%s%3N)
code=$(curl --silent --output /dev/null --max-time 1 --write-out "%{http_code}" http://127.0.0.1:7445/healthz 2>/dev/null || true)
case "$code" in
  1?? | 2?? | 3?? | 4??) code=200 ;;
  *) code=000 ;;
esac
printf "%s\t%s\n" "$timestamp" "$code"
sleep 0.2
done' >"$output" &
  HEALTH_POLL_PID=$!
}

wait_local_gateway_health() {
  local workspace_id=$1 timeout=$2 deadline code
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    code=$(box_ssh "$workspace_id" \
      'curl --silent --output /dev/null --max-time 2 --write-out "%{http_code}" http://127.0.0.1:7445/healthz 2>/dev/null || true') \
      || code=000
    case "$code" in
      1?? | 2?? | 3?? | 4??) return 0 ;;
    esac
    sleep 1
  done
  return 1
}

# Opens a fresh browser-shaped WebSocket through the local gateway into ttyd.
# The static box token is read and consumed on the box; neither it nor response
# bytes are returned to the harness. curl times out after the 101 because the
# attached terminal is intentionally long-lived.
assert_local_terminal_attach() {
  local workspace_id=$1 key=$2 url remote
  url="http://127.0.0.1:7445/terminal/ws?arg=terminal&arg=$key"
  printf -v remote 'token=$(cat /var/lib/blitz/webapp-token); code=$(curl --silent --output /dev/null --max-time 2 --write-out "%%{http_code}" --header "X-Blitz-WebApp-Token: $token" --header "Connection: Upgrade" --header "Upgrade: websocket" --header "Origin: http://localhost" --header "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" --header "Sec-WebSocket-Version: 13" --header "Sec-WebSocket-Protocol: tty" %q 2>/dev/null || true); test "$code" = 101' "$url"
  box_ssh "$workspace_id" "$remote"
}

# Prints the longest observed non-2xx interval in milliseconds. Zero means
# the gateway switched between two 200 samples and the outage was below the
# 200 ms sampling interval.
health_gap_ms() {
  local file=$1 timestamp code down=0 gap=0 candidate
  while IFS=$'\t' read -r timestamp code; do
    case "$code" in
      2??)
        if [ "$down" -ne 0 ]; then
          candidate=$(( timestamp - down ))
          [ "$candidate" -le "$gap" ] || gap=$candidate
          down=0
        fi
        ;;
      *)
        [ "$down" -ne 0 ] || down=$timestamp
        ;;
    esac
  done <"$file"
  printf '%s\n' "$gap"
}

hetzner_reset_machine() {
  local machine_id=$1 workspace_id=$2 response server_id
  require_env HETZNER_API_TOKEN
  response=$(curl --silent --show-error --fail-with-body \
    --header "Authorization: Bearer $HETZNER_API_TOKEN" \
    --get --data-urlencode "label_selector=blitz-machine=$machine_id" \
    https://api.hetzner.cloud/v1/servers) || return 1
  server_id=$(jq -er --arg workspace "$workspace_id" \
    '.servers | map(select(.labels["blitz-workspace"] == $workspace)) | if length == 1 then .[0].id else error("expected one server") end' \
    <<<"$response") || return 1
  curl --silent --show-error --fail-with-body \
    --request POST --header "Authorization: Bearer $HETZNER_API_TOKEN" \
    "https://api.hetzner.cloud/v1/servers/$server_id/actions/reset" >/dev/null
}

wait_box_ssh() {
  local workspace_id=$1 wanted=$2 timeout=$3 deadline works
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    works=false
    box_ssh "$workspace_id" true >/dev/null 2>&1 && works=true
    [ "$works" = "$wanted" ] && return 0
    sleep 1
  done
  return 1
}

daemon_log_size() {
  box_ssh "$1" \
    'log=$(find /var/lib/blitz/lody/logs -maxdepth 1 -type f -name "*.log*" -printf "%T@ %p\n" 2>/dev/null | sort -n | tail -1 | cut -d" " -f2-); [ -n "$log" ] && wc -c <"$log"'
}

daemon_log_since() {
  local workspace_id=$1 offset=$2
  box_ssh "$workspace_id" \
    "log=\$(find /var/lib/blitz/lody/logs -maxdepth 1 -type f -name '*.log*' -printf '%T@ %p\\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-); [ -n \"\$log\" ] && tail -c +$((offset + 1)) \"\$log\""
}

iso_epoch_ms() {
  local stamp=$1 seconds milliseconds
  seconds=$(date -u -d "${stamp%.*}Z" +%s) || return 1
  milliseconds=${stamp#*.}
  milliseconds=${milliseconds%Z}
  milliseconds=${milliseconds:0:3}
  while [ "${#milliseconds}" -lt 3 ]; do milliseconds=${milliseconds}0; done
  printf '%s%s\n' "$seconds" "$milliseconds"
}
