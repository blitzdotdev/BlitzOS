#!/usr/bin/env bash
# This is the only gate that exercises the s6 service graph, so it builds from
# this tree by default: silently adopting an existing tag lets an edit to
# rootfs/ or an s6 unit pass against an image that predates it. Reusing an
# image is possible but must be said out loud: IMAGE=<tag> tests that tag
# as-is and never builds.
set -euo pipefail

script_dir=$(realpath "$(dirname "$0")")
repo_root=$(realpath "$script_dir/../../..")
image="${IMAGE:-blitz-box:smoke}"
runtime_image="$image"
container="blitz-box-smoke-$$"
state_volume="blitz-box-smoke-state-$$"
unprivileged_container="blitz-box-smoke-unprivileged-$$"
unprivileged_volume="blitz-box-smoke-unprivileged-state-$$"
curl_image="curlimages/curl:8.16.0@sha256:463eaf6072688fe96ac64fa623fe73e1dbe25d8ad6c34404a669ad3ce1f104b6"
smoke_tmp="$script_dir/.smoke-tmp"
mkdir -p "$smoke_tmp"
test_dir=$(mktemp -d "$smoke_tmp/run.XXXXXX")
preserve_test_dir=false
diagnostics_collected=false

"$script_dir/syntax.sh"

cleanup() {
  timeout --kill-after=1s 10s docker rm -f "$container" >/dev/null 2>&1 || true
  timeout --kill-after=1s 10s docker rm -f "$unprivileged_container" >/dev/null 2>&1 || true
  timeout --kill-after=1s 10s docker volume rm "$state_volume" >/dev/null 2>&1 || true
  timeout --kill-after=1s 10s docker volume rm "$unprivileged_volume" >/dev/null 2>&1 || true
  if [ "$preserve_test_dir" != true ]; then
    rm -rf "$test_dir"
  fi
}
trap cleanup EXIT

collect_diagnostics() {
  if [ "$diagnostics_collected" = true ]; then
    return
  fi
  diagnostics_collected=true
  preserve_test_dir=true
  diagnostics="$test_dir/failure-diagnostics.log"
  {
    echo "== docker logs: $container =="
    timeout --kill-after=1s 10s docker logs "$container" 2>&1 || true
    echo
    echo "== s6 service list: $container =="
    timeout --kill-after=1s 10s docker exec "$container" /command/s6-rc -a list 2>&1 || true
    echo
    echo "== s6 service state: $container =="
    service_paths=$(timeout --kill-after=1s 10s docker exec "$container" \
      sh -c 'find /run/service -mindepth 1 -maxdepth 1 -type d -print' 2>/dev/null || true)
    while IFS= read -r service_path; do
      [ -n "$service_path" ] || continue
      timeout --kill-after=1s 10s docker exec "$container" \
        /command/s6-svstat "$service_path" 2>&1 || true
    done <<<"$service_paths"
    echo
    echo "== docker logs: $unprivileged_container =="
    timeout --kill-after=1s 10s docker logs "$unprivileged_container" 2>&1 || true
    echo
    echo "== .smoke-tmp files =="
    find "$smoke_tmp" -type f -printf '%p (%s bytes)\n' 2>&1 || true
  } >"$diagnostics"
  cat "$diagnostics" >&2
  echo "Diagnostics preserved at: $diagnostics" >&2
}

fail() {
  trap - ERR
  echo "FAIL: $*" >&2
  collect_diagnostics
  exit 1
}

signal_failure() {
  local signal=$1
  local status=$2
  trap - ERR HUP INT TERM
  echo "FAIL: received $signal" >&2
  collect_diagnostics
  exit "$status"
}

trap 'signal_failure HUP 129' HUP
trap 'signal_failure INT 130' INT
trap 'signal_failure TERM 143' TERM
trap 'fail "unexpected command failure at line $LINENO"' ERR

if [ -z "${IMAGE:-}" ]; then
  payload_version=$(node "$repo_root/packages/control-plane/scripts/plan-box-payload.mjs" \
    --repo "$repo_root" --print-version)
  docker build --progress=plain \
    --build-arg "BLITZ_PAYLOAD_VERSION=$payload_version" \
    --file "$repo_root/packages/box/Dockerfile" \
    --tag "$image" \
    "$repo_root"
fi

install -d -m 0755 "$test_dir/workspace"
ssh-keygen -q -t ed25519 -N '' -C 'blitz-box-smoke' -f "$test_dir/id_ed25519"
ssh-keygen -q -t ed25519 -N '' -C 'blitz-box-wrong-key' -f "$test_dir/wrong_ed25519"
umask 077
sentinel=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
printf '%s\n' "$sentinel" >"$test_dir/secret"
printf '%s\n' 'BLITZ_LODY_SESSIONS=1' >"$test_dir/features"
chmod 0644 "$test_dir/features"
docker volume create "$state_volume" >/dev/null

docker create \
  --name "$container" \
  --privileged \
  --env "BLITZ_UID=$(id -u)" \
  --env "BLITZ_GID=$(id -g)" \
  --mount "type=volume,source=$state_volume,target=/var/lib/blitz" \
  --mount "type=bind,source=$test_dir/workspace,target=/workspace" \
  --mount "type=bind,source=$test_dir/id_ed25519.pub,target=/run/blitz/authorized_key,readonly" \
  --mount "type=bind,source=$test_dir/secret,target=/run/blitz/smoke-secret,readonly" \
  --publish 127.0.0.1::22 \
  "$runtime_image" >/dev/null
docker cp "$test_dir/features" "$container:/opt/blitz/payload/state/features" >/dev/null
docker start "$container" >/dev/null

ready=false
platform_json=''
readiness_deadline=$((SECONDS + 180))
run_readiness_command() {
  local remaining=$((readiness_deadline - SECONDS))
  local command_timeout=5
  [ "$remaining" -gt 0 ] || return 124
  if [ "$remaining" -lt "$command_timeout" ]; then
    command_timeout=$remaining
  fi
  timeout --kill-after=1s "${command_timeout}s" "$@"
}

while [ "$SECONDS" -lt "$readiness_deadline" ]; do
  running=$(run_readiness_command docker inspect \
    --format '{{.State.Running}}' "$container" 2>/dev/null || true)
  if [ "$running" = false ]; then
    fail "container exited during startup"
  fi
  listeners=$(run_readiness_command docker exec "$container" \
    ss -ltnH 2>/dev/null || true)
  platform_json=$(run_readiness_command docker exec "$container" \
    curl --silent --show-error --fail --max-time 2 \
    http://127.0.0.1:7445/lody/platform 2>/dev/null || true)
  lody_health=$(run_readiness_command docker exec "$container" \
    curl --silent --show-error --fail --max-time 2 \
    --unix-socket /var/lib/blitz/lody-bridge.sock \
    http://localhost/healthz 2>/dev/null || true)
  lody_daemon_state=$(run_readiness_command docker exec "$container" \
    /command/s6-svstat /run/service/lody-daemon 2>/dev/null || true)
  lody_bridge_state=$(run_readiness_command docker exec "$container" \
    /command/s6-svstat /run/service/lody-bridge 2>/dev/null || true)
  if grep -q '0.0.0.0:22' <<<"$listeners" \
    && grep -q '127.0.0.1:7443' <<<"$listeners" \
    && grep -q '127.0.0.1:7445' <<<"$listeners" \
    && grep -q '127.0.0.1:17445' <<<"$listeners" \
    && grep -q '^up' <<<"$lody_daemon_state" \
    && grep -q '^up' <<<"$lody_bridge_state" \
    && grep -q '"ok"[[:space:]]*:[[:space:]]*true' <<<"$lody_health" \
    && [ -n "$platform_json" ]; then
    ready=true
    break
  fi
  sleep 0.2
done
[ "$ready" = true ] || fail "enabled Lody services and loopback endpoints did not become ready within 180 seconds"

services=$(docker exec "$container" /command/s6-rc -a list)
for service in init-state register payload sshd ttyd dufs gateway watch dockerd lody-daemon lody-bridge lody-watchdog lody-projects; do
  grep -qx "$service" <<<"$services" || fail "s6 graph is missing $service"
done
docker exec "$container" test -L /etc/s6-overlay/s6-rc.d \
  || fail "/etc/s6-overlay/s6-rc.d is not a payload indirection"
s6_tree_target=$(docker exec "$container" readlink /etc/s6-overlay/s6-rc.d)
[ "$s6_tree_target" = /opt/blitz/payload/current/rootfs/etc/s6-overlay/s6-rc.d ] \
  || fail "the s6 tree points at $s6_tree_target"
docker exec "$container" sh -c 'command -v flock' >/dev/null \
  || fail "the box image is missing util-linux flock"
echo "PASS the s6 service tree follows the current payload"
user_services=$(docker exec "$container" /command/s6-rc -l /run/s6-rc listall user)
while IFS= read -r service; do
  [ "$service" = user ] && continue
  [ "$service" = user2 ] && continue
  grep -qx "$service" <<<"$user_services" || fail "the live user bundle is missing $service"
done < <(find "$repo_root/packages/box/rootfs/etc/s6-overlay/s6-rc.d" \
  -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
echo "PASS the live user bundle lists every repository service"
docker exec "$container" test -d \
  /opt/blitz/payload/current/rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d \
  || fail "the user2 bundle has no contents.d directory"
user2_entry=$(docker exec "$container" sh -c \
  'find /opt/blitz/payload/current/rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d -mindepth 1 -maxdepth 1 -print -quit')
[ -z "$user2_entry" ] || fail "the user2 bundle contents.d directory is not empty"
echo "PASS the user2 bundle has an empty contents.d directory"
for service in payload sshd ttyd dufs gateway watch dockerd lody-daemon lody-bridge lody-watchdog lody-projects; do
  docker exec "$container" /command/s6-svstat "/run/service/$service" | grep -q '^up' || fail "$service is not up"
done

docker exec "$container" test -f /opt/blitz/lody/current/lib/node_modules/lody/dist/BUILD.json \
  || fail "the packaged Lody BUILD.json is missing"
docker exec "$container" /opt/blitz/lody/current/bin/lody --help >/dev/null \
  || fail "the tree-built Lody CLI does not answer --help"
# The payload-owned run script names the current daemon.
docker exec "$container" grep -Eq '^[[:space:]]*/opt/blitz/lody/current/bin/lody start$' \
  /opt/blitz/payload/current/rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/run \
  || fail "the lody daemon service no longer points at /opt/blitz/lody/current/bin/lody"
docker exec "$container" node -e '
  const catalog = JSON.parse(process.argv[1]);
  if (!catalog.identity || !Array.isArray(catalog.workspaces) || !catalog.machine) process.exit(1);
' "$platform_json" || fail "/lody/platform did not return the local identity/workspace/machine catalog: $platform_json"
lody_pid=$(docker exec "$container" pgrep -f '/opt/blitz/lody/current/bin/lody start$' | head -1)
[ -n "$lody_pid" ] || fail "the enabled Lody daemon process was not found"
docker exec "$container" sh -c \
  "tr '\\0' '\\n' </proc/$lody_pid/environ | grep -qx 'LODY_MCP_BUILTIN_DISABLED=1'" \
  || fail "the Lody daemon process did not receive LODY_MCP_BUILTIN_DISABLED=1"

# The shipping image registers Claude and Codex only; neither can create a
# credential-free ACP session. The built-tarball tests below exercise a fake
# adapter. Here, prove every real-image invariant available without a provider
# credential, and do not pretend a session leaf was created.
docker logs "$container" >"$test_dir/container.log" 2>&1
grep -q '\[mcp\] built-in server disabled via LODY_MCP_BUILTIN_DISABLED' "$test_dir/container.log" \
  || fail "the daemon log did not confirm that its built-in MCP server is disabled"
echo "PASS enabled Lody daemon, bridge, platform catalog, provenance, service environment, and MCP-disable log"
dufs_version=$(docker exec "$container" /usr/local/bin/dufs --version)
[ "$dufs_version" = 'dufs 0.46.0' ] || fail "unexpected dufs version: $dufs_version"
# dufs must NOT publish the agent HOME. The symlink that used to sit beside
# /workspace exposed ~/.claude/.credentials.json and ~/.codex/auth.json to
# anyone the workspace was shared with; da54646 removed it on purpose. Assert
# the absence so it cannot come back.
docker exec "$container" test ! -e /srv/blitz-files/home \
  || fail "dufs publishes the agent HOME again: /srv/blitz-files/home exists"
echo "PASS s6 graph and longruns"

docker exec "$container" sh -c 'test "$(readlink /opt/blitz/payload/current)" = baked' \
  || fail "the baked payload is not current"
docker exec "$container" sh -c 'test "$(readlink /opt/blitz/lody/current)" = baked' \
  || fail "the baked lody prefix is not current"
for payload_path in \
  /usr/local/bin/blitz \
  /usr/local/bin/blitz-box-gateway \
  /usr/local/libexec/blitz-term \
  /opt/blitz/skel/agent-rules.md; do
  docker exec "$container" test -L "$payload_path" \
    || fail "$payload_path is not indirected through the current payload"
done
docker exec "$container" test ! -L /usr/local/libexec/blitz-payload \
  || fail "the base-owned payload updater is indirected through the payload"
docker exec "$container" test ! -L /usr/local/bin/blitz-cred \
  || fail "the base-owned credential broker is indirected through the payload"
docker exec "$container" test -x /usr/local/bin/blitz-cred \
  || fail "the base-owned credential broker is missing"
docker exec "$container" test ! -L /etc/blitz/env.defaults \
  || fail "the base-owned environment defaults are indirected through the payload"
docker exec "$container" grep -qx 'exec /usr/local/libexec/blitz-payload' \
  /etc/s6-overlay/s6-rc.d/payload/run \
  || fail "the payload service does not run the base-owned updater"
docker exec "$container" sh -c \
  'test "$(readlink /usr/local/bin/lody)" = /opt/blitz/lody/current/bin/lody' \
  || fail "the lody PATH entry does not follow the current daemon"
payload_stamp=$(docker exec "$container" cat /opt/blitz/payload/baked/payload-version)
[[ "$payload_stamp" =~ ^[a-f0-9]{64}$ ]] || fail "the baked payload has no derived version"
daemon_stamp=$(docker exec "$container" cat /opt/blitz/lody/baked/daemon-version)
[[ "$daemon_stamp" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] \
  || fail "the baked daemon has no version"
docker exec "$container" grep -qx '7' /opt/blitz/lody/baked/daemon-protocol-version \
  || fail "the baked daemon has no protocol version"
docker exec --user blitz "$container" test -r /opt/blitz/payload/state/log \
  || fail "the payload updater log is not readable by uid 1000"
docker exec "$container" test ! -e /var/lib/blitz/payload \
  || fail "the payload updater still owns storage under /var/lib/blitz"
echo "PASS baked payload and daemon indirections"

# ---- live payload service-tree updates ------------------------------------

payload_state=$(docker exec "$container" /command/s6-svstat /run/service/payload)
grep -q '^up' <<<"$payload_state" || fail "the supervised payload updater is not up"
payload_lock_status=0
payload_lock_stderr=$(docker exec "$container" /usr/local/libexec/blitz-payload tick \
  2>&1 >/dev/null) || payload_lock_status=$?
[ "$payload_lock_status" -eq 75 ] \
  || fail "contended payload tick exited $payload_lock_status instead of 75"
[ "$payload_lock_stderr" = \
  'another updater holds /run/blitz-payload.lock; stop the payload service (s6-svc -d /run/service/payload) or wait for the running tick' ] \
  || fail "contended payload tick returned unexpected stderr: $payload_lock_stderr"
echo "PASS supervised payload service holds the updater lock"

docker exec "$container" /command/s6-svc -d /run/service/payload
for _attempt in $(seq 1 50); do
  payload_state=$(docker exec "$container" /command/s6-svstat /run/service/payload 2>/dev/null || true)
  grep -q '^down' <<<"$payload_state" && break
  sleep 0.1
done
grep -q '^down' <<<"$payload_state" || fail "the supervised payload updater did not stop"

live_release_root="$test_dir/live-releases"
live_binaries="$test_dir/live-binaries"
mkdir -p "$live_release_root" "$live_binaries"
docker cp \
  "$container:/opt/blitz/payload/current/rootfs/usr/local/bin/blitz-box-gateway" \
  "$live_binaries/blitz-box-gateway" >/dev/null
chmod 0755 "$live_binaries/blitz-box-gateway"
payload_origin_port=18446
payload_origin="http://127.0.0.1:$payload_origin_port"

build_live_release() {
  local variant=$1
  local output="$test_dir/live-$variant"
  local release_json
  local version
  release_json=$(node "$script_dir/payload-live-release.mjs" \
    "$repo_root" "$variant" "$live_binaries" "$output" "$payload_origin")
  version=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).version)' "$release_json")
  mv "$output" "$live_release_root/$version"
  printf '%s\n' "$version"
}

e17_version=$(build_live_release E17)
e18_version=$(build_live_release E18)
e19_version=$(build_live_release E19)
docker exec "$container" mkdir -p /tmp/payload-live/releases
docker cp "$live_release_root/." "$container:/tmp/payload-live/releases" >/dev/null
docker cp "$script_dir/payload-live-origin.mjs" \
  "$container:/tmp/payload-live/origin.mjs" >/dev/null
docker cp "$script_dir/payload-live-cred.sh" "$container:/tmp/payload-live/blitz-cred" >/dev/null
docker exec "$container" sh -c \
  'cp -p /usr/local/bin/blitz-cred /tmp/payload-live/blitz-cred.real && cp /tmp/payload-live/blitz-cred /usr/local/bin/blitz-cred.smoke && chmod 0755 /usr/local/bin/blitz-cred.smoke && mv /usr/local/bin/blitz-cred.smoke /usr/local/bin/blitz-cred'
docker exec "$container" sh -c "printf '%s\n' 1 >/tmp/payload-live/features"
docker exec "$container" sh -c \
  "node /tmp/payload-live/origin.mjs $payload_origin_port /tmp/payload-live/releases /tmp/payload-live/config /tmp/payload-live/features /tmp/payload-live/results.ndjson /tmp/payload-live/ready >/tmp/payload-live/origin.log 2>&1 &"
origin_ready=false
for _attempt in $(seq 1 50); do
  if docker exec "$container" test -f /tmp/payload-live/ready; then
    origin_ready=true
    break
  fi
  sleep 0.1
done
[ "$origin_ready" = true ] || fail "the live payload origin did not start"
docker exec "$container" sh -c "printf '%s\\n' '$payload_origin' >/tmp/payload-live/updater-origin"
payload_test_config='{"originFile":"/tmp/payload-live/updater-origin"}'
sshd_pid_before=$(docker exec "$container" /command/s6-svstat -o pid /run/service/sshd)
gateway_pid_before=$(docker exec "$container" /command/s6-svstat -o pid /run/service/gateway)

latest_payload_outcome() {
  docker exec "$container" node -e '
    const lines = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
    process.stdout.write(JSON.parse(lines.at(-1)).outcome);
  ' /tmp/payload-live/results.ndjson
}

latest_payload_detail() {
  docker exec "$container" node -e '
    const lines = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
    process.stdout.write(JSON.parse(lines.at(-1)).detail);
  ' /tmp/payload-live/results.ndjson
}

wait_for_lody_feature_restarts() {
  local label=$1
  local bridge_before=$2 daemon_before=$3 projects_before=$4 watchdog_before=$5
  local bridge_after daemon_after projects_after watchdog_after
  for _attempt in $(seq 1 100); do
    bridge_after=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-bridge)
    daemon_after=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-daemon)
    projects_after=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-projects)
    watchdog_after=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-watchdog)
    if [ "$bridge_after" != 0 ] && [ "$daemon_after" != 0 ] \
      && [ "$projects_after" != 0 ] && [ "$watchdog_after" != 0 ] \
      && [ "$bridge_after" != "$bridge_before" ] \
      && [ "$daemon_after" != "$daemon_before" ] \
      && [ "$projects_after" != "$projects_before" ] \
      && [ "$watchdog_after" != "$watchdog_before" ]; then
      return
    fi
    sleep 0.1
  done
  fail "E20 did not restart every Lody feature reader while $label Lody"
}

docker exec "$container" sh -c "printf '%s\\n' '$e17_version' >/tmp/payload-live/config"
docker exec --env "BLITZ_PAYLOAD_TEST_CONFIG=$payload_test_config" \
  "$container" /usr/local/libexec/blitz-payload tick
[ "$(latest_payload_outcome)" = applied ] || fail "E17 did not report applied"
echo "PASS E17 reports applied"
docker exec "$container" /command/s6-svstat /run/service/hello | grep -q '^up' \
  || fail "E17 hello is not up"
echo "PASS E17 adds and starts hello"
[ "$(docker exec "$container" /command/s6-svstat -o pid /run/service/sshd)" = "$sshd_pid_before" ] \
  || fail "E17 restarted sshd"
[ "$(docker exec "$container" /command/s6-svstat -o pid /run/service/gateway)" = "$gateway_pid_before" ] \
  || fail "E17 restarted gateway"
echo "PASS E17 keeps sshd and gateway pids"

docker exec "$container" sh -c "printf '%s\\n' '$e18_version' >/tmp/payload-live/config"
docker exec --env "BLITZ_PAYLOAD_TEST_CONFIG=$payload_test_config" \
  "$container" /usr/local/libexec/blitz-payload tick
[ "$(latest_payload_outcome)" = applied ] || fail "E18 did not report applied"
echo "PASS E18 reports applied"
if docker exec "$container" /command/s6-rc -l /run/s6-rc listall user | grep -qx hello; then
  fail "E18 left hello in the live service set"
fi
docker exec "$container" test ! -e /run/service/hello || fail "E18 left hello supervised"
echo "PASS E18 removes hello from the live service set"
[ "$(docker exec "$container" /command/s6-svstat -o pid /run/service/sshd)" = "$sshd_pid_before" ] \
  || fail "E18 restarted sshd"
[ "$(docker exec "$container" /command/s6-svstat -o pid /run/service/gateway)" = "$gateway_pid_before" ] \
  || fail "E18 restarted gateway"
echo "PASS E18 keeps sshd and gateway pids"

payload_link_before=$(docker exec "$container" readlink /opt/blitz/payload/current)
daemon_link_before=$(docker exec "$container" readlink /opt/blitz/lody/current)
docker exec "$container" sh -c "printf '%s\\n' '$e19_version' >/tmp/payload-live/config"
docker exec --env "BLITZ_PAYLOAD_TEST_CONFIG=$payload_test_config" \
  "$container" /usr/local/libexec/blitz-payload tick
[ "$(latest_payload_outcome)" = verify-failed ] || fail "E19 did not report verify-failed"
echo "PASS E19 reports verify-failed"
[[ "$(latest_payload_detail)" == *"service floor is missing payload/type"* ]] \
  || fail "E19 did not report the missing payload/type floor entry"
echo "PASS E19 names the missing payload/type floor entry"
[ "$(docker exec "$container" readlink /opt/blitz/payload/current)" = "$payload_link_before" ] \
  || fail "E19 changed the payload current link"
[ "$(docker exec "$container" readlink /opt/blitz/lody/current)" = "$daemon_link_before" ] \
  || fail "E19 changed the daemon current link"
echo "PASS E19 leaves current links unchanged"
[ "$(docker exec "$container" /command/s6-svstat -o pid /run/service/sshd)" = "$sshd_pid_before" ] \
  || fail "E19 restarted sshd"
[ "$(docker exec "$container" /command/s6-svstat -o pid /run/service/gateway)" = "$gateway_pid_before" ] \
  || fail "E19 restarted gateway"
echo "PASS E19 keeps sshd and gateway pids"

feature_lody_bridge_pid=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-bridge)
feature_lody_daemon_pid=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-daemon)
feature_lody_projects_pid=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-projects)
feature_lody_watchdog_pid=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-watchdog)
docker exec "$container" sh -c "printf '%s\n' 0 >/tmp/payload-live/features"
docker exec --env "BLITZ_PAYLOAD_TEST_CONFIG=$payload_test_config" \
  "$container" /usr/local/libexec/blitz-payload tick
docker exec "$container" grep -qx 'BLITZ_LODY_SESSIONS=0' /opt/blitz/payload/state/features \
  || fail "E20 did not materialize the disabled Lody feature"
echo "PASS E20 materializes BLITZ_LODY_SESSIONS=0"
wait_for_lody_feature_restarts disabling \
  "$feature_lody_bridge_pid" "$feature_lody_daemon_pid" \
  "$feature_lody_projects_pid" "$feature_lody_watchdog_pid"
echo "PASS E20 restarts all four Lody feature readers while disabling Lody"
feature_lody_bridge_pid=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-bridge)
feature_lody_daemon_pid=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-daemon)
feature_lody_projects_pid=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-projects)
feature_lody_watchdog_pid=$(docker exec "$container" /command/s6-svstat -o pid /run/service/lody-watchdog)
docker exec "$container" sh -c "printf '%s\n' 1 >/tmp/payload-live/features"
docker exec --env "BLITZ_PAYLOAD_TEST_CONFIG=$payload_test_config" \
  "$container" /usr/local/libexec/blitz-payload tick
docker exec "$container" grep -qx 'BLITZ_LODY_SESSIONS=1' /opt/blitz/payload/state/features \
  || fail "E20 did not materialize the enabled Lody feature"
echo "PASS E20 materializes BLITZ_LODY_SESSIONS=1"
wait_for_lody_feature_restarts enabling \
  "$feature_lody_bridge_pid" "$feature_lody_daemon_pid" \
  "$feature_lody_projects_pid" "$feature_lody_watchdog_pid"
echo "PASS E20 restarts all four Lody feature readers while enabling Lody"
lody_pid=''
for _attempt in $(seq 1 100); do
  lody_pid=$(docker exec "$container" pgrep -f '/opt/blitz/lody/current/bin/lody start$' \
    2>/dev/null | head -1 || true)
  [ -n "$lody_pid" ] && break
  sleep 0.1
done
[ -n "$lody_pid" ] || fail "E20 left no enabled Lody daemon process"
[ "$(docker exec "$container" /command/s6-svstat -o pid /run/service/sshd)" = "$sshd_pid_before" ] \
  || fail "E20 restarted sshd"
[ "$(docker exec "$container" /command/s6-svstat -o pid /run/service/gateway)" = "$gateway_pid_before" ] \
  || fail "E20 restarted gateway"
echo "PASS E20 keeps sshd and gateway pids across both feature flips"
docker exec "$container" cp -p /tmp/payload-live/blitz-cred.real /usr/local/bin/blitz-cred
docker exec "$container" /command/s6-svc -u /run/service/payload

# ---- the memory boundary ----
# This is the only gate that runs the real s6 graph, so it is the only place
# the cgroup layout can be proved. Every check below is an invariant the
# boundary depends on, and each one has failed at least once during its build.
#
# The checks require the memory controller to be DELEGATED into the container,
# which a box-in-box dev workspace cannot do (its own flat root pins the
# controller). There the boundary correctly stays flat, the boot must still
# succeed — the lines above proved that — and the layout is asserted where
# delegation exists: CI runners and real VMs.
boundary_expected=yes
docker exec "$container" grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null \
  || boundary_expected=no

cgroup_of() {
  # Prints the cgroup path of the first process matching a pgrep pattern.
  local pid
  pid=$(docker exec "$container" pgrep -x "$1" | head -1) || return 1
  [ -n "$pid" ] || return 1
  docker exec "$container" sed -n 's|^0::||p' "/proc/$pid/cgroup"
}

if [ "$boundary_expected" = no ]; then
  if [ "${CI:-}" = true ]; then
    fail "CI did not delegate the memory controller required to prove the Lody session cgroup parent"
  fi
  docker exec "$container" test ! -d /sys/fs/cgroup/blitz-system.slice \
    || fail "no memory controller here, yet a half-built system slice exists"
  echo "SKIP memory boundary layout (memory controller is not delegated here; CI and the Hetzner lab assert it)"
  echo "session-sandbox: SKIP (no delegation)"
else
docker exec "$container" test -d /sys/fs/cgroup/blitz-system.slice \
  || fail "the system slice was not created"
docker exec "$container" test -d /sys/fs/cgroup/blitz-user.slice \
  || fail "the user slice was not created"

# cgroup v2 forbids a cgroup from holding processes AND controller-enabled
# children. If anything is left in the container root, the controllers were
# enabled on a populated cgroup and the whole boundary is silently inert.
root_procs=$(docker exec "$container" sh -c 'wc -l </sys/fs/cgroup/cgroup.procs')
[ "$root_procs" = 0 ] || fail "the container root cgroup still holds $root_procs processes"

controllers=$(docker exec "$container" cat /sys/fs/cgroup/cgroup.subtree_control)
grep -q memory <<<"$controllers" || fail "the memory controller is not delegated: [$controllers]"
grep -q pids <<<"$controllers" || fail "the pids controller is not delegated: [$controllers]"

for service in sshd ttyd dufs blitz-box-gatew; do
  where=$(cgroup_of "$service") || fail "$service is not running, so its cgroup cannot be checked"
  [ "$where" = /blitz-system.slice ] \
    || fail "$service must sit in the reservation, but it is in [$where]"
done
where=$(docker exec "$container" sed -n 's|^0::||p' "/proc/$lody_pid/cgroup")
[ "$where" = /blitz-user.slice/lody.scope ] \
  || fail "the enabled Lody daemon must run in its user leaf, but it is in [$where]"
where=$(cgroup_of dockerd) || fail "dockerd is not running"
[ "$where" = /blitz-user.slice/dockerd.scope ] \
  || fail "dockerd must sit beside its containers, not in them: [$where]"

# The reservation is the half that stops a stall, so a zero here means the box
# is back to the failure that started all this.
system_min=$(docker exec "$container" cat /sys/fs/cgroup/blitz-system.slice/memory.min)
[ "$system_min" -gt 0 ] || fail "the system slice carries no memory reservation"
user_max=$(docker exec "$container" cat /sys/fs/cgroup/blitz-user.slice/memory.max)
user_high=$(docker exec "$container" cat /sys/fs/cgroup/blitz-user.slice/memory.high)
[ "$user_max" != max ] || fail "the user slice has no ceiling"
[ "$user_high" -lt "$user_max" ] \
  || fail "memory.high ($user_high) must throttle below memory.max ($user_max)"

# PID 1 carries the score every service inherits. Losing it means a kill can
# take s6 and restart the whole container, which is the loudest failure of all.
pid1_adj=$(docker exec "$container" cat /proc/1/oom_score_adj)
[ "$pid1_adj" -lt 0 ] || fail "PID 1 is a normal OOM candidate (oom_score_adj=$pid1_adj)"

# Delegation, and its containment. The configured Blitz identity must be able
# to move its own work between leaves it owns, even when the host uid/gid is not
# the image's baked-in 1000:1000. It must NOT be able to enter the reservation.
blitz_identity=$(docker exec "$container" sh -c \
  'printf "%s:%s" "$(id -u blitz)" "$(id -g blitz)"')
for delegated_path in \
  /sys/fs/cgroup/cgroup.procs \
  /sys/fs/cgroup/blitz-user.slice/cgroup.procs \
  /sys/fs/cgroup/blitz-user.slice/cgroup.subtree_control; do
  owner=$(docker exec "$container" stat -c %u:%g "$delegated_path")
  [ "$owner" = "$blitz_identity" ] \
    || fail "$delegated_path belongs to $owner, not the Blitz identity $blitz_identity"
done
owner=$(docker exec "$container" stat -c %u:%g /sys/fs/cgroup/blitz-system.slice/cgroup.procs)
[ "$owner" = 0:0 ] || fail "the system slice is writable by $owner; it must stay root-owned"

# The Lody daemon's per-session leaves live BESIDE its own leaf, under a
# parent that already hands them every controller the sandbox requires, and
# that the Blitz identity owns — the daemon mkdirs and rmdirs the leaves
# itself. The memory boundary can operate without cpu, but the Lody sandbox
# requires cpu.max and otherwise falls back to a noop sandbox.
docker exec "$container" test -d /sys/fs/cgroup/blitz-user.slice/lody-sessions \
  || fail "the lody-sessions parent was not created"
owner=$(docker exec "$container" stat -c %u:%g /sys/fs/cgroup/blitz-user.slice/lody-sessions/cgroup.procs)
[ "$owner" = "$blitz_identity" ] \
  || fail "lody-sessions belongs to $owner, not the Blitz identity $blitz_identity"
session_controllers=$(docker exec "$container" cat /sys/fs/cgroup/blitz-user.slice/lody-sessions/cgroup.subtree_control)
for controller in memory pids; do
  grep -qw "$controller" <<<"$session_controllers" \
    || fail "lody-sessions does not hand $controller to its leaves: [$session_controllers]"
done
session_parent_pids=$(docker exec "$container" cat /sys/fs/cgroup/blitz-user.slice/lody-sessions/pids.max)
[ "$session_parent_pids" = max ] \
  || fail "lody-sessions parent pids.max is [$session_parent_pids], expected max beneath the 4096-process user ceiling"
user_pids=$(docker exec "$container" cat /sys/fs/cgroup/blitz-user.slice/pids.max)
[ "$user_pids" = 4096 ] || fail "the user slice pids.max is [$user_pids], expected 4096"

session_sandbox_delegated=yes
if ! grep -qw cpu <<<"$session_controllers"; then
  session_sandbox_delegated=no
  if [ "${CI:-}" = true ]; then
    fail "CI did not delegate cpu to lody-sessions; Lody requires cpu.max and would use the noop sandbox: [$session_controllers]"
  fi
fi
if [ "$session_sandbox_delegated" = yes ]; then
  if docker exec --user blitz "$container" sh -eu -c '
    probe=/sys/fs/cgroup/blitz-user.slice/lody-sessions/.smoke-probe-$$
    cleanup_probe() { rmdir "$probe" 2>/dev/null || true; }
    trap cleanup_probe EXIT
    mkdir "$probe"
    for required in pids.max memory.max cpu.max; do
      test -e "$probe/$required"
    done
    rmdir "$probe"
    trap - EXIT
  '; then
    echo "PASS session-sandbox delegated child probe (pids.max, memory.max, cpu.max)"
  elif [ "${CI:-}" = true ]; then
    fail "the blitz user could not create and remove a fully controlled child under lody-sessions"
  else
    echo "session-sandbox: SKIP (no delegation)"
  fi
else
  echo "session-sandbox: SKIP (no delegation)"
fi
echo "PASS memory boundary layout"
fi

if [ "${LODY_BOOT_ONLY:-0}" = 1 ]; then
  echo "PASS enabled Lody image boot smoke"
  exit 0
fi

docker logs "$container" >"$test_dir/container.log" 2>&1
grep -q 'register: skipped (no control-plane origin)' "$test_dir/container.log" || fail "register did not skip cleanly"
grep -q 'watch: waiting for broker config' "$test_dir/container.log" || fail "watch did not wait cleanly"
docker exec "$container" test ! -e /var/lib/blitz/broker.json || fail "no-CP mode created broker config"
echo "PASS no-CP skips"

# Terminal delivery: the shim must WIN the PATH over the pinned binary it execs,
# in a plain login shell as well as in the image environment. A member-installed
# copy landing in the writable npm prefix and shadowing it is the single most
# common way a terminal ends up signed out while the box holds a credential.
resolved=$(docker exec "$container" /bin/sh -lc 'command -v claude')
[ "$resolved" = '/usr/local/bin/claude' ] || fail "login-shell claude resolves to $resolved, not the shim"
resolved=$(docker exec "$container" /bin/sh -c 'command -v claude')
[ "$resolved" = '/usr/local/bin/claude' ] || fail "claude resolves to $resolved, not the shim"
docker exec "$container" grep -q 'CLAUDE_CODE_OAUTH_TOKEN' /usr/local/bin/claude ||
  fail "the claude shim does not export CLAUDE_CODE_OAUTH_TOKEN"
docker exec "$container" test ! -e /etc/claude-code/managed-settings.json ||
  fail "managed settings exist; a managed apiKeyHelper hangs claude when a token is also set"
# Signed out is fine; a dead command is not. With no broker the shim must still
# reach the real binary.
docker exec "$container" /bin/sh -lc 'claude --version' >/dev/null ||
  fail "the claude shim does not run with no broker configured"
echo "PASS terminal delivery shim"

listeners=$(docker exec "$container" ss -ltnH)
grep -Eq '[[:space:]]0\.0\.0\.0:22[[:space:]]' <<<"$listeners" || fail "sshd is not listening on port 22"
for port in 7443 7445; do
  grep -Eq "[[:space:]]127\\.0\\.0\\.1:$port[[:space:]]" <<<"$listeners" || fail "$port is not on loopback"
  if grep -Eq "[[:space:]](0\\.0\\.0\\.0|\[::\]):$port[[:space:]]" <<<"$listeners"; then
    fail "$port has a non-loopback listener"
  fi
done
published=$(docker port "$container")
grep -q '^22/tcp' <<<"$published" || fail "sshd was not published"
if grep -Eq '^744[345]/tcp' <<<"$published"; then
  fail "a loopback-only webapp was published"
fi
echo "PASS port bindings"

host_port=$(docker port "$container" 22/tcp | sed -n 's/.*://p')
ssh_common=(
  -p "$host_port"
  -o BatchMode=yes
  -o ConnectTimeout=5
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
)
ssh "${ssh_common[@]}" -i "$test_dir/id_ed25519" blitz@127.0.0.1 'test "$(id -un)" = blitz' >/dev/null
if ssh "${ssh_common[@]}" -i "$test_dir/wrong_ed25519" blitz@127.0.0.1 true >/dev/null 2>&1; then
  fail "sshd accepted the wrong key"
fi
if ssh "${ssh_common[@]}" -o PubkeyAuthentication=no -o PasswordAuthentication=yes blitz@127.0.0.1 true >/dev/null 2>&1; then
  fail "sshd accepted password authentication"
fi
echo "PASS sshd key-only authentication"

# An SSH session is user work. sshd itself belongs in the reservation — it is
# the rescue path — so its children start there and would otherwise be the one
# workload with no ceiling at all. A ForceCommand moves each session out.
if [ "$boundary_expected" = yes ]; then
  remote_cgroup=$(ssh "${ssh_common[@]}" -i "$test_dir/id_ed25519" blitz@127.0.0.1 \
    'sed -n "s|^0::||p" /proc/$$/cgroup')
  case "$remote_cgroup" in
    /blitz-user.slice/ssh-*) ;;
    *) fail "an ssh session runs in [$remote_cgroup], not its own user leaf" ;;
  esac
fi
# A ForceCommand replaces the sftp subsystem too, so sftp is the thing most
# likely to break silently. Prove a round trip rather than trust the branch.
printf 'sftp-payload\n' >"$test_dir/sftp-src"
# sftp(1) reads lowercase -p as "preserve times" and only takes -P as the
# port, so ssh_common (built for ssh) cannot be reused here verbatim.
sftp -P "$host_port" "${ssh_common[@]:2}" -i "$test_dir/id_ed25519" -b - blitz@127.0.0.1 >/dev/null 2>&1 <<SFTP \
  || fail "sftp stopped working under the ForceCommand"
put $test_dir/sftp-src /workspace/sftp-dst
SFTP
docker exec "$container" grep -q sftp-payload /workspace/sftp-dst \
  || fail "sftp uploaded nothing"
echo "PASS ssh sessions carry the user ceiling"

docker cp "$script_dir/ws-client.mjs" "$container:/tmp/ws-client.mjs" >/dev/null
docker cp "$script_dir/ttyd-client.mjs" "$container:/tmp/ttyd-client.mjs" >/dev/null
ttyd_url='ws://127.0.0.1:7443/ws?arg=terminal&arg=smoke-contract'
docker exec --user blitz \
  --env "TTYD_URL=$ttyd_url" \
  --env $'TTYD_INPUT=printf first-connect > /workspace/ttyd-first\r' \
  "$container" node /tmp/ttyd-client.mjs
docker exec "$container" test -f /workspace/ttyd-first || fail "writable ttyd attach did not accept input"
session_before=$(docker exec --user blitz "$container" tmux list-panes \
  -t '=term-smoke-contract' -F '#{session_name}:#{session_created}:#{pane_pid}')
grep -Eq '^term-smoke-contract:[0-9]+:[0-9]+$' <<<"$session_before" \
  || fail "could not identify the tmux session: $session_before"
docker exec --user blitz "$container" tmux has-session -t '=term-smoke-contract' \
  || fail "tmux session did not survive the first WebSocket disconnect"

docker exec --user blitz \
  --env "TTYD_URL=${ttyd_url}&arg=ro" \
  --env $'TTYD_INPUT=printf forbidden > /workspace/ttyd-read-only\r' \
  "$container" node /tmp/ttyd-client.mjs
docker exec "$container" test ! -e /workspace/ttyd-read-only || fail "read-only ttyd attach accepted input"

docker exec --user blitz \
  --env "TTYD_URL=$ttyd_url" \
  --env $'TTYD_INPUT=printf reconnected > /workspace/ttyd-reconnected\r' \
  "$container" node /tmp/ttyd-client.mjs
docker exec "$container" test -f /workspace/ttyd-reconnected || fail "reconnected ttyd attach did not accept input"
session_after=$(docker exec --user blitz "$container" tmux list-panes \
  -t '=term-smoke-contract' -F '#{session_name}:#{session_created}:#{pane_pid}')
[ "$session_before" = "$session_after" ] || fail "ttyd reconnect replaced the tmux session"
docker exec --user blitz --env TTYD_URL=ws://127.0.0.1:7443/ws \
  "$container" node /tmp/ttyd-client.mjs
if docker exec --user blitz "$container" /usr/local/libexec/blitz-term terminal 'bad.key' >/dev/null 2>&1; then
  fail "terminal launcher accepted an unsafe session key"
fi
echo "PASS ttyd URL args, no-arg shell, read-only attach, and tmux persistence ($session_before)"

# The per-tab leaf is what lets one runaway agent be killed without taking the
# tmux server, ttyd, or any other tab with it. tmux forks panes from its own
# long-lived server, so the wrapper had to go on the PANE COMMAND — this
# asserts the placement landed in the pane, not in blitz-term.
if [ "$boundary_expected" = yes ]; then
  pane_pid=${session_after##*:}
  pane_cgroup=$(docker exec "$container" sed -n 's|^0::||p' "/proc/$pane_pid/cgroup")
  [ "$pane_cgroup" = /blitz-user.slice/tab-term-smoke-contract ] \
    || fail "the tab pane runs in [$pane_cgroup], not its own per-tab leaf"
  # A kill must take the tab as a unit. A half-killed agent that leaves a live
  # child still holding its memory is the failure oom.group prevents.
  tab_group=$(docker exec "$container" cat \
    /sys/fs/cgroup/blitz-user.slice/tab-term-smoke-contract/memory.oom.group)
  [ "$tab_group" = 1 ] || fail "the tab leaf does not kill as a group"
  echo "PASS per-tab memory leaves"
fi

docker run --rm \
  --network "container:$container" \
  --env FILES_BASE=http://127.0.0.1:7445 \
  --mount "type=bind,source=$repo_root/packages/box/test,target=/test,readonly" \
  --entrypoint /bin/sh \
  "$curl_image" /test/files-smoke.sh

docker cp "$script_dir/preview-fixture.mjs" "$container:/tmp/preview-fixture.mjs" >/dev/null
docker exec -d --user blitz --env PREVIEW_FIXTURE_PORT=31234 \
  "$container" node /tmp/preview-fixture.mjs
ports_json=''
for _attempt in $(seq 1 50); do
  ports_json=$(docker run --rm --network "container:$container" "$curl_image" \
    -fsS http://127.0.0.1:7445/ports 2>/dev/null || true)
  if grep -q '"port":31234' <<<"$ports_json"; then
    break
  fi
  sleep 0.1
done
grep -q '"port":31234,"process":"node"' <<<"$ports_json" \
  || fail "/ports omitted the node test listener: $ports_json"
if grep -Eq '"port":(22|7443|7444|7445|17445),' <<<"$ports_json"; then
  fail "/ports exposed a box service port: $ports_json"
fi
docker exec --user blitz "$container" blitz preview add 'https://demo.blitz.dev/app' --title 'Public demo'
preview_links_json=$(docker run --rm --network "container:$container" "$curl_image" \
  -fsS http://127.0.0.1:7445/previews)
grep -Eq '"url":"https://demo\.blitz\.dev/app","title":"Public demo","source":"agent","createdAt":[0-9]+' <<<"$preview_links_json" \
  || fail "/previews omitted the registered link: $preview_links_json"
[ "$(docker exec --user blitz "$container" blitz preview list)" = 'Public demo — https://demo.blitz.dev/app' ] \
  || fail "blitz preview list did not print the registered link"
preview_state=$(docker exec "$container" stat -c '%u:%g %a' /var/lib/blitz/previews.json)
[ "$preview_state" = "$(id -u):$(id -g) 600" ] \
  || fail "previews state file has the wrong owner or mode: $preview_state"
if docker exec --user blitz "$container" blitz preview add 'javascript:alert(1)' >/dev/null 2>&1; then
  fail "blitz preview add accepted a non-http(s) URL"
fi
docker exec --user blitz "$container" blitz preview rm 'https://demo.blitz.dev/app'
[ "$(docker run --rm --network "container:$container" "$curl_image" -fsS http://127.0.0.1:7445/previews)" = '{"previews":[]}' ] \
  || fail "blitz preview rm did not remove the registered link"
preview_http=$(docker run --rm --network "container:$container" "$curl_image" \
  -fsS 'http://127.0.0.1:7445/preview/31234/deep/path?probe=1')
[ "$preview_http" = 'preview-http:GET:/deep/path?probe=1' ] \
  || fail "preview HTTP proxy returned: $preview_http"
docker exec -i "$container" node --input-type=module <<'NODE'
import { openWebSocket } from "/tmp/ws-client.mjs";

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("preview WebSocket timeout")), 5000);
  let client;
  openWebSocket("ws://127.0.0.1:7445/preview/31234/socket?probe=1", {
    origin: "http://127.0.0.1",
    onMessage: (message) => {
      clearTimeout(timer);
      client?.close();
      resolve(message.toString());
    },
  }).then((socket) => {
    client = socket;
    socket.send("hello");
  }, reject);
});
if (result !== "preview-ws:/socket?probe=1:hello") throw new Error(`bad preview WebSocket response: ${result}`);
NODE
echo "PASS ports discovery ($ports_json)"
echo "PASS public preview CLI + gateway ($preview_links_json)"
echo "PASS preview HTTP + WebSocket proxy ($preview_http)"

docker exec --user blitz "$container" sh -c \
  'test ! -r /etc/shadow && test ! -r /var/lib/blitz/ssh/ssh_host_ed25519_key' \
  || fail "blitz can read a root-owned path"
docker exec --user blitz "$container" docker info >/dev/null || fail "inner Docker is unavailable to blitz"
inspect_config=$(docker inspect --format '{{json .Config.Env}} {{json .Config.Cmd}} {{json .Config.Entrypoint}}' "$container")
if grep -Fq "$sentinel" <<<"$inspect_config"; then
  fail "secret sentinel appeared in inspect env/args"
fi
echo "PASS privilege boundary, DinD, and inspect secret check"

docker volume create "$unprivileged_volume" >/dev/null
docker run -d \
  --name "$unprivileged_container" \
  --env "BLITZ_UID=$(id -u)" \
  --env "BLITZ_GID=$(id -g)" \
  --mount "type=volume,source=$unprivileged_volume,target=/var/lib/blitz" \
  --mount "type=bind,source=$test_dir/workspace,target=/workspace" \
  --mount "type=bind,source=$test_dir/id_ed25519.pub,target=/run/blitz/authorized_key,readonly" \
  "$runtime_image" >/dev/null
unprivileged_ready=false
for _attempt in $(seq 1 50); do
  unprivileged_logs=$(docker logs "$unprivileged_container" 2>&1 || true)
  if grep -q 'dockerd: skipped (container is not privileged)' <<<"$unprivileged_logs"; then
    unprivileged_ready=true
    break
  fi
  sleep 0.2
done
[ "$unprivileged_ready" = true ] || fail "unprivileged dockerd did not skip cleanly"
docker exec "$unprivileged_container" /command/s6-svstat /run/service/dockerd | grep -q '^up' \
  || fail "unprivileged dockerd placeholder is not supervised"
docker exec "$unprivileged_container" ss -ltnH | grep -q '127.0.0.1:7445' \
  || fail "unprivileged mode lost a box webapp"
echo "PASS unprivileged dockerd degradation"

# An unprivileged box cannot write cgroups, and it must still boot. Every
# blitz-cgroup call is a passthrough there, so the absence of the tree is the
# correct state — not a failure to report.
if docker exec "$unprivileged_container" test -d /sys/fs/cgroup/blitz-system.slice 2>/dev/null; then
  fail "the unprivileged box built a cgroup tree it cannot own"
fi
docker exec "$unprivileged_container" /usr/local/bin/blitz-cgroup enter user/probe -- true \
  || fail "blitz-cgroup must pass through when it cannot build a boundary"
echo "PASS unprivileged boundary degradation"

echo "PASS box smoke"
