#!/usr/bin/env bash
set -euo pipefail

script_dir=$(realpath "$(dirname "$0")")
repo_root=$(realpath "$script_dir/../../..")
image="blitz-box-smoke:$$"
container="blitz-box-smoke-$$"
state_volume="blitz-box-smoke-state-$$"
unprivileged_container="blitz-box-smoke-unprivileged-$$"
unprivileged_volume="blitz-box-smoke-unprivileged-state-$$"
curl_image="curlimages/curl:8.16.0@sha256:463eaf6072688fe96ac64fa623fe73e1dbe25d8ad6c34404a669ad3ce1f104b6"
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/blitz-box-smoke.XXXXXX")

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker rm -f "$unprivileged_container" >/dev/null 2>&1 || true
  docker volume rm "$state_volume" >/dev/null 2>&1 || true
  docker volume rm "$unprivileged_volume" >/dev/null 2>&1 || true
  rm -rf "$test_dir"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  docker logs "$container" >&2 2>/dev/null || true
  exit 1
}

docker build --progress=plain \
  --file "$repo_root/packages/box/Dockerfile" \
  --tag "$image" \
  "$repo_root"

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
  --env "BLITZ_UID=$(id -u)" \
  --env "BLITZ_GID=$(id -g)" \
  --volume "$state_volume:/var/lib/blitz" \
  --volume "$test_dir/workspace:/workspace" \
  --volume "$test_dir/id_ed25519.pub:/run/blitz/authorized_key:ro" \
  --volume "$test_dir/secret:/run/blitz/smoke-secret:ro" \
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
    && grep -q '127.0.0.1:7445' <<<"$listeners"; then
    ready=true
    break
  fi
  sleep 0.2
done
[ "$ready" = true ] || fail "loopback services did not become ready"

services=$(docker exec "$container" /command/s6-rc -a list)
for service in init-state enroll register sshd ttyd actor dufs watch dockerd; do
  grep -qx "$service" <<<"$services" || fail "s6 graph is missing $service"
done
for service in sshd ttyd actor dufs watch dockerd; do
  docker exec "$container" /command/s6-svstat "/run/service/$service" | grep -q '^up' || fail "$service is not up"
done
dufs_version=$(docker exec "$container" /usr/local/bin/dufs --version)
[ "$dufs_version" = 'dufs 0.46.0' ] || fail "unexpected dufs version: $dufs_version"
echo "PASS s6 graph and longruns"

docker logs "$container" >"$test_dir/container.log" 2>&1
grep -q 'enroll: skipped (no control-plane origin)' "$test_dir/container.log" || fail "enroll did not skip cleanly"
grep -q 'register: skipped (no control-plane origin)' "$test_dir/container.log" || fail "register did not skip cleanly"
grep -q 'watch: skipped (no broker config)' "$test_dir/container.log" || fail "watch did not skip cleanly"
docker exec "$container" test ! -e /var/lib/blitz/broker.json || fail "no-CP mode created broker config"
echo "PASS no-CP skips"

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
  fail "a loopback-only surface was published"
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
  --volume "$repo_root/packages/box/test:/test:ro" \
  --entrypoint /bin/sh \
  "$curl_image" /test/files-smoke.sh

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
  --volume "$unprivileged_volume:/var/lib/blitz" \
  --volume "$test_dir/workspace:/workspace" \
  --volume "$test_dir/id_ed25519.pub:/run/blitz/authorized_key:ro" \
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
  || fail "unprivileged mode lost a box surface"
echo "PASS unprivileged dockerd degradation"
echo "PASS box smoke"
