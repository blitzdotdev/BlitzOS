#!/usr/bin/env bash
# Image selection (override with IMAGE=<tag>):
#   IMAGE set    -> smoke-test that tag as-is (never builds).
#   IMAGE unset  -> use blitz-box:local when that tag already exists locally,
#                   otherwise build a fresh blitz-box:smoke from this tree.
set -euo pipefail

script_dir=$(realpath "$(dirname "$0")")
repo_root=$(realpath "$script_dir/../../..")
build_image=false
if [ -n "${IMAGE:-}" ]; then
  image="$IMAGE"
elif docker image inspect blitz-box:local >/dev/null 2>&1; then
  image="blitz-box:local"
else
  image="blitz-box:smoke"
  build_image=true
fi
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
trap cleanup EXIT HUP INT TERM

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

if [ "$build_image" = true ]; then
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
    && grep -q '127.0.0.1:7444' <<<"$listeners" \
    && grep -q '127.0.0.1:7445' <<<"$listeners" \
    && grep -q '127.0.0.1:17445' <<<"$listeners"; then
    ready=true
    break
  fi
  sleep 0.2
done
[ "$ready" = true ] || fail "loopback services did not become ready"

services=$(docker exec "$container" /command/s6-rc -a list)
for service in init-state enroll register sshd ttyd actor dufs gateway watch dockerd; do
  grep -qx "$service" <<<"$services" || fail "s6 graph is missing $service"
done
for service in sshd ttyd actor dufs gateway watch dockerd; do
  docker exec "$container" /command/s6-svstat "/run/service/$service" | grep -q '^up' || fail "$service is not up"
done
dufs_version=$(docker exec "$container" /usr/local/bin/dufs --version)
[ "$dufs_version" = 'dufs 0.46.0' ] || fail "unexpected dufs version: $dufs_version"
echo "PASS s6 graph and longruns"

docker logs "$container" >"$test_dir/container.log" 2>&1
grep -q 'enroll: skipped (no control-plane origin)' "$test_dir/container.log" || fail "enroll did not skip cleanly"
grep -q 'register: skipped (no control-plane origin)' "$test_dir/container.log" || fail "register did not skip cleanly"
grep -q 'watch: waiting for broker config' "$test_dir/container.log" || fail "watch did not wait cleanly"
docker exec "$container" test ! -e /var/lib/blitz/broker.json || fail "no-CP mode created broker config"
echo "PASS no-CP skips"

# Terminal delivery: the shim must WIN the PATH over the pinned binary it execs,
# in a plain login shell as well as in the image environment. A member-installed
# copy landing in the writable npm prefix and shadowing it is the single most
# common way a terminal ends up signed out while chat is authenticated.
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
docker exec "$container" /bin/sh -lc 'DISABLE_AUTOUPDATER=1 claude --version' >/dev/null ||
  fail "the claude shim does not run with no broker configured"
echo "PASS terminal delivery shim"

listeners=$(docker exec "$container" ss -ltnH)
grep -Eq '[[:space:]]0\.0\.0\.0:22[[:space:]]' <<<"$listeners" || fail "sshd is not listening on port 22"
for port in 7443 7444 7445; do
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

docker exec -i --workdir /opt/blitz/actor "$container" node --input-type=module <<'NODE'
import { WebSocket } from "ws";

const socket = new WebSocket("ws://127.0.0.1:7444");
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("ACP smoke timeout")), 5000);
  socket.on("open", () => {
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: "initialize", method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }));
  });
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.id === "initialize") {
      if (frame.result?.agentInfo?.name !== "BlitzOS box") reject(new Error("bad initialize response"));
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: "new", method: "session/new", params: { cwd: "/workspace", mcpServers: [] } }));
    } else if (frame.id === "new") {
      if (typeof frame.result?.sessionId !== "string") reject(new Error("bad session/new response"));
      resolve(frame.result.sessionId);
    }
  });
  socket.on("error", reject);
  socket.on("close", () => clearTimeout(timer));
});
console.log(`PASS ACP initialize + session/new (${result})`);
socket.close();
NODE

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
[ "$(docker exec "$container" stat -c '%U:%G %a' /var/lib/blitz/previews.json)" = 'blitz:blitz 600' ] \
  || fail "previews state file has the wrong owner or mode"
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
docker exec -i --workdir /opt/blitz/actor "$container" node --input-type=module <<'NODE'
import { WebSocket } from "ws";

const result = await new Promise((resolve, reject) => {
  const socket = new WebSocket("ws://127.0.0.1:7445/preview/31234/socket?probe=1");
  const timer = setTimeout(() => reject(new Error("preview WebSocket timeout")), 5000);
  socket.on("open", () => socket.send("hello"));
  socket.on("message", (message) => {
    clearTimeout(timer);
    socket.close();
    resolve(message.toString());
  });
  socket.on("error", reject);
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
echo "PASS box smoke"
