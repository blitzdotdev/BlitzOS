#!/usr/bin/env bash
# Shared driver for plans/THIN-IMAGE.md section 6.
#
# THINLAB_TOKEN may be either:
#   * a machine-plane bearer from `blitz-cred api-token`; it can read
#     workspaces and drive machine lifecycle; or
#   * a session bearer for a workspace admin; it additionally permits the
#     payload-hold write and the webApp proxy.
#
# E2's control-plane proxy probe needs session/operator scope. When
# THINLAB_TOKEN is machine-plane scoped, set THINLAB_PROXY_TOKEN separately.
# Neither token is ever printed by this harness.

PAYLOAD_LAB_DIR=$(realpath "$(dirname "${BASH_SOURCE[0]}")")
PAYLOAD_LAB_REPO=$(realpath "$PAYLOAD_LAB_DIR/../../../..")
THINLAB_ORIGIN=${THINLAB_ORIGIN:-https://blitz-thinlab.minjunesv0.workers.dev}
LAB_R2_BUCKET=${LAB_R2_BUCKET:-blitz-thinlab-images}
LAB_HOST_SSH_PORT=${LAB_HOST_SSH_PORT:-2222}
LAB_CP_TIMEOUT=${LAB_CP_TIMEOUT:-75}
LAB_OUTCOME_TIMEOUT=${LAB_OUTCOME_TIMEOUT:-420}
LAB_HEALTH_PATH=${LAB_HEALTH_PATH:-/healthz}

EXPERIMENT_ID=
WORKSPACE_ID=
MACHINE_ID=
LAB_FINAL_LINE=false
LAB_TEMP_ROOT=
LAB_RESTORE_ORIGIN_WORKSPACE=
LAB_RESTORE_ORIGIN_VALUE=
LAB_REMOTE_CLEANUP_WORKSPACE=
LAB_REMOTE_CLEANUP_COMMAND=
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
  if [ -n "$LAB_RESTORE_ORIGIN_WORKSPACE" ] && [ -n "$LAB_RESTORE_ORIGIN_VALUE" ]; then
    _write_box_origin "$LAB_RESTORE_ORIGIN_WORKSPACE" "$LAB_RESTORE_ORIGIN_VALUE" \
      >/dev/null 2>&1 || true
  fi
  if [ -n "$LAB_REMOTE_CLEANUP_WORKSPACE" ] && [ -n "$LAB_REMOTE_CLEANUP_COMMAND" ]; then
    box_ssh "$LAB_REMOTE_CLEANUP_WORKSPACE" "$LAB_REMOTE_CLEANUP_COMMAND" \
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

require_env() {
  local name=$1
  [ -n "${!name:-}" ] || experiment_fail "$name is required"
}

require_workspace() {
  [ -n "$WORKSPACE_ID" ] || experiment_fail "workspace id is required"
  require_env THINLAB_TOKEN
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

cp_api() {
  require_env THINLAB_TOKEN
  cp_api_with_token "$THINLAB_TOKEN" "$@"
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

# The VM host retains sshd on 2222 while the box owns port 22. The provisioned
# lab key reaches both. Host access lets the harness run one updater tick and
# read docker logs; no test hook is added to the box image.
host_ssh() {
  local workspace_id=$1 command=$2
  if payload_lab_dry; then
    dry_command "ssh root@<workspace-host:$workspace_id>:$LAB_HOST_SSH_PORT $command"
    return 0
  fi
  local host key
  host=$(_ssh_target "$workspace_id" host)
  key=${LAB_HOST_SSH_KEY:-$LAB_SSH_KEY}
  local options=()
  mapfile -t options < <(_ssh_options "$key")
  ssh "${options[@]}" -p "$LAB_HOST_SSH_PORT" "root@$host" "$command"
}

_write_box_origin() {
  local workspace_id=$1 origin=$2 quoted
  printf -v quoted '%q' "$origin"
  box_ssh "$workspace_id" "printf '%s\\n' $quoted > /var/lib/blitz/origin"
}

arm_origin_restore() {
  LAB_RESTORE_ORIGIN_WORKSPACE=$1
  LAB_RESTORE_ORIGIN_VALUE=$2
}

restore_box_origin() {
  _write_box_origin "$LAB_RESTORE_ORIGIN_WORKSPACE" "$LAB_RESTORE_ORIGIN_VALUE"
  LAB_RESTORE_ORIGIN_WORKSPACE=
  LAB_RESTORE_ORIGIN_VALUE=
}

payload_tick() {
  local workspace_id=$1
  payload_lab_trace "running one supervised updater transaction on $workspace_id"
  host_ssh "$workspace_id" \
    "docker exec blitz-box bash -c 'set -e; printf \"%s\\n\" \"\$\$\" > /sys/fs/cgroup/blitz-system.slice/cgroup.procs; exec env BLITZ_PAYLOAD_ONCE=1 /usr/local/libexec/blitz-payload'"
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

payload_state() {
  box_ssh "$1" 'cat /var/lib/blitz/payload/state.json'
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
state=/var/lib/blitz/payload/state.json
jq -e '\''(.current | type == "string") and (.currentTarget | type == "string") and (has("pending") | not)'\'' "$state" >/dev/null
target=$(jq -r .currentTarget "$state")
test -d "$target"
test "$(readlink -f /opt/blitz/payload/current)" = "$(readlink -f "$target")"'
}

payload_version_count() {
  box_ssh "$1" \
    'find /var/lib/blitz/payload/versions -mindepth 1 -maxdepth 1 -type d ! -name "*.staging" -print 2>/dev/null | wc -l'
}

payload_staging_count() {
  box_ssh "$1" \
    'find /var/lib/blitz/payload/versions /opt/blitz/lody -mindepth 1 -maxdepth 1 -name "*.staging" -print 2>/dev/null | wc -l'
}

payload_cache_identity() {
  local workspace_id=$1 version=$2
  box_ssh "$workspace_id" \
    "stat -c '%i:%y:%s' /var/lib/blitz/payload/versions/$version/.manifest.json"
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
  local name=$1 repo=$2 overlay=$3 marker=$4 source target serial
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
      source=packages/control-plane/scripts/lib/box-daemon.mjs
      target="$overlay/$source"
      mkdir -p "$(dirname "$target")"
      cp "$repo/$source" "$target"
      serial=$(printf '%s' "$marker" | cksum)
      serial=${serial%% *}
      sed -i -E \
        "s/(LODY_PATCHSET_SERIAL = )[0-9]+/\\1$serial/" "$target"
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
    --config "$PAYLOAD_LAB_REPO/packages/control-plane/wrangler.toml"
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

# Materialises an overlay in an isolated clone because the production
# publisher intentionally has no test-only --overlay option. The publisher is
# then called against that overlaid repo and remains the only artifact writer.
publish_variant() {
  local name=$1 run_id marker root repo overlay release published daemon_args=()
  if payload_lab_dry; then
    dry_command "materialize overlay $name; publish-box-payload.mjs --repo <overlay-$name>"
    PUBLISHED_VERSION="dry-$name"
    PUBLISHED_REF="$THINLAB_ORIGIN/box-payload/$PUBLISHED_VERSION/manifest.json"
    PUBLISHED_PREFIX="box-payload/$PUBLISHED_VERSION"
    PUBLISHED_MARKER="payload-lab-$name"
    return 0
  fi
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
      commit --quiet -m "payload lab variant $name"
  )
  ln -s "$PAYLOAD_LAB_REPO/node_modules" "$repo/node_modules"
  if [[ "$name" = daemon-* ]]; then
    require_env LAB_DAEMON_ARCHIVE
    [ -r "$LAB_DAEMON_ARCHIVE" ] || experiment_fail "LAB_DAEMON_ARCHIVE is not readable"
    daemon_args=(--daemon "$LAB_DAEMON_ARCHIVE")
  fi
  published="$root/published.json"
  payload_lab_trace "publishing variant $name"
  node "$PAYLOAD_LAB_REPO/packages/control-plane/scripts/publish-box-payload.mjs" \
    --repo "$repo" --app-url "$THINLAB_ORIGIN" --bucket "$LAB_R2_BUCKET" \
    --out "$release" --json "$published" "${daemon_args[@]}" >/dev/null
  PUBLISHED_VERSION=$(jq -er .version "$published")
  PUBLISHED_REF=$(jq -er .ref "$published")
  PUBLISHED_PREFIX=$(jq -er .prefix "$published")
  PUBLISHED_RELEASE_DIR=$release
  PUBLISHED_MARKER=$marker
  _mutate_published_variant "$name"
}

pin_payload() {
  local version=$1
  local ref="$THINLAB_ORIGIN/box-payload/$version/manifest.json"
  payload_lab_trace "pinning payload $version"
  if payload_lab_dry; then
    dry_command "BLITZ_DEPLOY_VAR_BOX_PAYLOAD_REF=<ref> BLITZ_DEPLOY_VAR_BOX_PAYLOAD_VERSION=$version npm run deploy -w packages/control-plane"
    return 0
  fi
  (
    cd "$PAYLOAD_LAB_REPO"
    BLITZ_DEPLOY_VAR_BOX_PAYLOAD_REF="$ref" \
    BLITZ_DEPLOY_VAR_BOX_PAYLOAD_VERSION="$version" \
      npm run deploy -w packages/control-plane
  )
}

gateway_health_code() {
  local workspace_id=$1 token=${THINLAB_PROXY_TOKEN:-${THINLAB_TOKEN:-}}
  local code
  [ -n "$token" ] || return 1
  code=$(curl --silent --output /dev/null --max-time 3 --write-out '%{http_code}' \
    --header "Authorization: Bearer $token" \
    "$THINLAB_ORIGIN/workspaces/$workspace_id/webapp/7445$LAB_HEALTH_PATH" \
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
