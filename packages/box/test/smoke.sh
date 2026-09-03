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
container="blitz-box-smoke-$$"
state_volume="blitz-box-smoke-state-$$"
unprivileged_container="blitz-box-smoke-unprivileged-$$"
unprivileged_volume="blitz-box-smoke-unprivileged-state-$$"
curl_image="curlimages/curl:8.16.0@sha256:463eaf6072688fe96ac64fa623fe73e1dbe25d8ad6c34404a669ad3ce1f104b6"
smoke_tmp="$script_dir/.smoke-tmp"
mkdir -p "$smoke_tmp"
test_dir=$(mktemp -d "$smoke_tmp/run.XXXXXX")
preserve_test_dir=false

"$script_dir/syntax.sh"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker rm -f "$unprivileged_container" >/dev/null 2>&1 || true
  docker volume rm "$state_volume" >/dev/null 2>&1 || true
  docker volume rm "$unprivileged_volume" >/dev/null 2>&1 || true
  if [ "$preserve_test_dir" != true ]; then
    rm -rf "$test_dir"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "FAIL: $*" >&2
  preserve_test_dir=true
  diagnostics="$test_dir/failure-diagnostics.log"
  {
    echo "== docker logs: $container =="
    docker logs "$container" 2>&1 || true
    echo
    echo "== s6 service list: $container =="
    docker exec "$container" /command/s6-rc -a list 2>&1 || true
    echo
    echo "== s6 service state: $container =="
    for service_path in $(docker exec "$container" sh -c 'find /run/service -mindepth 1 -maxdepth 1 -type d -print' 2>/dev/null || true); do
      docker exec "$container" /command/s6-svstat "$service_path" 2>&1 || true
    done
    echo
    echo "== docker logs: $unprivileged_container =="
    docker logs "$unprivileged_container" 2>&1 || true
  } >"$diagnostics"
  echo "Diagnostics preserved at: $diagnostics" >&2
  exit 1
}
trap 'fail "unexpected command failure at line $LINENO"' ERR

if [ -z "${IMAGE:-}" ]; then
  docker build --progress=plain \
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
docker volume create "$state_volume" >/dev/null

docker run -d \
  --name "$container" \
  --privileged \
  --env-file "$repo_root/env.defaults" \
  --env "BLITZ_UID=$(id -u)" \
  --env "BLITZ_GID=$(id -g)" \
  --mount "type=volume,source=$state_volume,target=/var/lib/blitz" \
  --mount "type=bind,source=$test_dir/workspace,target=/workspace" \
  --mount "type=bind,source=$test_dir/id_ed25519.pub,target=/run/blitz/authorized_key,readonly" \
  --mount "type=bind,source=$test_dir/secret,target=/run/blitz/smoke-secret,readonly" \
  --publish 127.0.0.1::22 \
  "$image" >/dev/null

ready=false
for _attempt in $(seq 1 100); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
    fail "container exited during startup"
  fi
  listeners=$(docker exec "$container" ss -ltnH 2>/dev/null || true)
  if grep -q '0.0.0.0:22' <<<"$listeners" \
    && grep -q '127.0.0.1:7443' <<<"$listeners" \
    && grep -q '127.0.0.1:7445' <<<"$listeners" \
    && grep -q '127.0.0.1:17445' <<<"$listeners"; then
    ready=true
    break
  fi
  sleep 0.2
done
[ "$ready" = true ] || fail "loopback services did not become ready"

services=$(docker exec "$container" /command/s6-rc -a list)
for service in init-state enroll register sshd ttyd dufs gateway watch dockerd; do
  grep -qx "$service" <<<"$services" || fail "s6 graph is missing $service"
done
for service in sshd ttyd dufs gateway watch dockerd; do
  docker exec "$container" /command/s6-svstat "/run/service/$service" | grep -q '^up' || fail "$service is not up"
done
dufs_version=$(docker exec "$container" /usr/local/bin/dufs --version)
[ "$dufs_version" = 'dufs 0.46.0' ] || fail "unexpected dufs version: $dufs_version"
# dufs must NOT publish the agent HOME. The symlink that used to sit beside
# /workspace exposed ~/.claude/.credentials.json and ~/.codex/auth.json to
# anyone the workspace was shared with; da54646 removed it on purpose. Assert
# the absence so it cannot come back.
docker exec "$container" test ! -e /srv/blitz-files/home \
  || fail "dufs publishes the agent HOME again: /srv/blitz-files/home exists"
echo "PASS s6 graph and longruns"

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
  docker exec "$container" test ! -d /sys/fs/cgroup/blitz-system.slice \
    || fail "no memory controller here, yet a half-built system slice exists"
  echo "SKIP memory boundary layout (memory controller is not delegated here; CI and the Hetzner lab assert it)"
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
# The actor that used to hold user/actor.scope is gone; the Lody daemon
# inherited the placement. It is dark by default, so a smoke box idles it in
# `sleep infinity` and there is no node to look at here. The placement is
# asserted by reading its run script instead — see the boundary lab
# (packages/box/test/memory-load.sh) for the live check on an enabled box.
docker exec "$container" grep -q 'blitz-cgroup enter user/lody.scope' \
  /etc/s6-overlay/s6-rc.d/lody-daemon/run \
  || fail "the lody daemon does not enter the user ceiling"
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
# itself. cpu is asserted only where the host delegates it; the boundary does
# not need it, the sandbox does, and blitz-cgroup enables it best-effort for
# that reason.
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
if docker exec "$container" grep -qw cpu /sys/fs/cgroup/cgroup.controllers; then
  grep -qw cpu <<<"$session_controllers" \
    || fail "cpu is delegated here, yet lody-sessions does not hand it to its leaves: [$session_controllers]"
fi
echo "PASS memory boundary layout"
fi


docker logs "$container" >"$test_dir/container.log" 2>&1
grep -q 'enroll: skipped (no control-plane origin)' "$test_dir/container.log" || fail "enroll did not skip cleanly"
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
  --env-file "$repo_root/env.defaults" \
  --env "BLITZ_UID=$(id -u)" \
  --env "BLITZ_GID=$(id -g)" \
  --mount "type=volume,source=$unprivileged_volume,target=/var/lib/blitz" \
  --mount "type=bind,source=$test_dir/workspace,target=/workspace" \
  --mount "type=bind,source=$test_dir/id_ed25519.pub,target=/run/blitz/authorized_key,readonly" \
  "$image" >/dev/null
unprivileged_ready=false
for _attempt in $(seq 1 50); do
  if docker logs "$unprivileged_container" 2>&1 | grep -q 'dockerd: skipped (container is not privileged)'; then
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
