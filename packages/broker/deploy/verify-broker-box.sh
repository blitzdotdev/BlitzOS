#!/usr/bin/env bash
set -euo pipefail

# The end-of-run gate for a broker box (runs on the DOCKER HOST as root, last
# thing in provision-broker.sh verify).
#
#   verify-broker-box.sh
#
# It takes no address, and it writes nothing. BROKER_CONTAINER selects the
# container when the operator did not use the default name; it is not an
# address, and every check below still asks the machine what is true rather than
# taking an answer from the caller.
#
# It exists because pass 2 reported success on a box that was not working. On
# 2026-08-07 the production listener flip raced the tunnel, sshd bound nothing,
# and the run died before the key sync was ever enabled — so the box answered on
# no address and never pulled a key. Every check below is a thing that was wrong
# on that box, re-aimed at the shape blitz-core actually ships: one container
# whose PID 1 is `blitz-broker sync` and whose sshd is a background child
# (packages/broker/entrypoint.sh), not a systemd service plus a timer.
#
# Nothing here writes and nothing is looked up by absolute path, so the test
# suite runs it directly against fake docker/systemctl/ss/timedatectl on PATH.

fail() {
  echo "error: $*" >&2
  exit 1
}

container="${BROKER_CONTAINER:-blitz-broker}"

# How long the sync loop must run clean before its silence counts as evidence.
# It polls once a second, so this is ~10 consecutive control-plane reads.
LOG_WINDOW_SECONDS=10

# ---------------------------------------------------------------------------
# 1. The Docker daemon. `--restart unless-stopped` is the only thing that brings
#    the broker back after a crash or a host reboot, and it means nothing while
#    dockerd is down. A stopped daemon is the container-shaped version of a box
#    that answers ssh on no address.
# ---------------------------------------------------------------------------
systemctl is-active --quiet docker ||
  fail "the docker service is not active: this host runs no broker"

# ---------------------------------------------------------------------------
# 2. The container is running, and will come back on its own. PID 1 in it is
#    `blitz-broker sync`, so the sync loop dying takes the whole container with
#    it; without a restart policy the broker then simply disappears, and the
#    next workspace to ask for a key finds nothing (production needed
#    Restart=always on 2026-08-08 for exactly this).
# ---------------------------------------------------------------------------
state="$(docker inspect -f '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}' "${container}" 2>/dev/null)" ||
  fail "no container named ${container} on this host: nothing was provisioned"
read -r running restart_policy <<<"${state}"
[[ "${running}" == "true" ]] ||
  fail "container ${container} is not running: workspaces reach no broker"
case "${restart_policy}" in
  always | unless-stopped) ;;
  *) fail "container ${container} has restart policy '${restart_policy:-no}': the broker will not survive its first crash" ;;
esac

# ---------------------------------------------------------------------------
# 3. sshd inside the container. entrypoint.sh starts it in the BACKGROUND and
#    then execs the sync loop as PID 1, so a dead sshd leaves the container
#    "running" and healthy-looking while it answers no connection at all. This
#    is the same class of failure as the 2026-08-07 listener, and the container
#    hides it better than systemd did.
# ---------------------------------------------------------------------------
docker exec "${container}" pgrep -x sshd >/dev/null 2>&1 ||
  fail "no sshd inside ${container}: the container is up and answers nothing"

# ---------------------------------------------------------------------------
# 4. ... and that the published port is actually bound on the host. `running` is
#    not proof — the failure this gate exists for is a listener that is up but
#    bound to nothing reachable — so ask docker which port it published and then
#    ask the kernel whether anything holds it.
# ---------------------------------------------------------------------------
published="$(docker port "${container}" 22/tcp 2>/dev/null)" ||
  fail "container ${container} publishes no port for 22/tcp: workspaces cannot dial it"
# Not a pipeline into head: see the SIGPIPE note in check 6.
first_binding="${published%%$'\n'*}"
published_port="${first_binding##*:}"
[[ "${published_port}" =~ ^[0-9]+$ ]] ||
  fail "cannot read the published broker port from '${first_binding}'"
if [[ -z "$(ss -H -ltn "sport = :${published_port}")" ]]; then
  fail "nothing is listening on port ${published_port}; workspaces cannot reach this broker"
fi

# ---------------------------------------------------------------------------
# 5. The sync loop, which is the whole point of the box: without it no member
#    key ever lands in an authorized_keys file. In blitz-core it is PID 1 of the
#    container rather than a systemd unit, so ask the container's process table
#    instead of asking docker twice.
# ---------------------------------------------------------------------------
pid_one="$(docker exec "${container}" ps -p 1 -o args= 2>/dev/null)" ||
  fail "cannot read PID 1 in ${container}"
[[ "${pid_one}" == *"blitz-broker sync"* ]] ||
  fail "PID 1 in ${container} is '${pid_one}', not 'blitz-broker sync': this box will never pull a key"

# ---------------------------------------------------------------------------
# 6. ... and PROOF that the control plane accepted this box.
#
#    Production greps the journal for `members: N (version V)`, which
#    `blitz-broker sync` logs ONLY after the plane accepted its token and
#    returned a scoped key list — evidence of authentication, not merely of the
#    process starting. blitz-core's sync (internal/broker/sync.go) has no such
#    line: on a successful reconcile it logs NOTHING, and it only speaks up when
#    something failed. Until it gains a positive line, the equivalent evidence
#    is assembled from two halves, and both are required:
#
#      a. the box credential exists on the state volume. store.SaveCredential
#         writes it only after the device flow returned tokens, so its presence
#         is the control plane having authenticated this box and issued it a
#         credential. It is never read here — existence is the whole signal.
#      b. the loop has run a window without complaining. sync logs on every
#         failed poll, so silence across ~10 polls means GET /boxes/{id}/feed
#         answered 200 or 304, which needs a bearer token the plane accepts.
#
#    Neither half is sufficient alone: an un-enrolled container is silent too,
#    because sync skips the fetch entirely when no credential exists.
# ---------------------------------------------------------------------------
state_dir="$(docker exec "${container}" sh -c 'if [ -z "${BLITZ_BROKER_STATE_DIR:-}" ]; then set -a; . /etc/blitz/env.defaults; set +a; fi; printf %s "${BLITZ_BROKER_STATE_DIR}"' 2>/dev/null)" ||
  fail "cannot resolve BLITZ_BROKER_STATE_DIR inside ${container}"
[[ -n "${state_dir}" ]] ||
  fail "${container} reports an empty BLITZ_BROKER_STATE_DIR"
docker exec "${container}" test -s "${state_dir}/box-credential.json" ||
  fail "${container} holds no box credential: 'blitz-broker enroll' was never run or never approved"

synced="false"
for ((attempt = 1; attempt <= 15; attempt++)); do
  # NOT a pipeline. `grep -q` exits on the first match and closes the pipe, the
  # producer dies of SIGPIPE, and `set -o pipefail` turns a SUCCESSFUL match into
  # a failed condition. It passes at provisioning time, when the log is short
  # enough that the producer finishes first, and fails on every re-run of a box
  # that has been up a while — observed on the production broker box on
  # 2026-08-08, on a box that was healthy and logging every minute. Capture into
  # a variable, then match.
  recent="$(docker logs --since "${LOG_WINDOW_SECONDS}s" "${container}" 2>&1)" ||
    fail "cannot read the log of ${container}"
  if [[ "${recent}" != *"broker feed unavailable"* &&
    "${recent}" != *"broker feed rejected"* &&
    "${recent}" != *"broker reconciliation incomplete"* &&
    "${recent}" != *"broker enrollment state is invalid"* ]]; then
    synced="true"
    break
  fi
  sleep 2
done
[[ "${synced}" == "true" ]] ||
  fail "${container} kept reporting sync failures for 30 seconds: it is not reaching the control plane with a credential the plane accepts"

# ---------------------------------------------------------------------------
# 7. The authorized_keys directory sshd will actually read, cross-checked
#    against sshd_config rather than assumed. `blitz-broker sync` renders member
#    files into its own compiled-in directory; if sshd is configured to read a
#    different one, every member is rejected and nothing anywhere says why.
#
#    Ownership and mode are part of the same check, not decoration: sshd_config
#    sets StrictModes yes, and for an AuthorizedKeysFile outside the member's
#    home sshd refuses EVERY key unless the file and its parents are root-owned
#    and not group- or world-writable. 0755 root:root is what entrypoint.sh
#    creates and what RenderAuthorizedKeys re-asserts on each reconcile, so
#    anything else means a hand edit that locks the whole box out.
# ---------------------------------------------------------------------------
authorized_keys_file="$(docker exec "${container}" awk '$1 == "AuthorizedKeysFile" { print $2; exit }' /etc/ssh/sshd_config 2>/dev/null)" ||
  fail "cannot read sshd_config inside ${container}"
[[ -n "${authorized_keys_file}" ]] ||
  fail "sshd_config in ${container} sets no AuthorizedKeysFile"
case "${authorized_keys_file}" in
  /*/%u) ;;
  *) fail "sshd_config AuthorizedKeysFile is '${authorized_keys_file}': the broker renders one root-owned file per member, so it must be an absolute <dir>/%u" ;;
esac
authorized_keys_dir="${authorized_keys_file%/%u}"
directory_state="$(docker exec "${container}" stat -c '%a %U %G' "${authorized_keys_dir}" 2>/dev/null)" ||
  fail "${authorized_keys_dir} does not exist in ${container}: sshd reads member keys from a directory nothing creates"
read -r directory_mode directory_owner directory_group <<<"${directory_state}"
[[ "${directory_owner}" == "root" && "${directory_group}" == "root" ]] ||
  fail "${authorized_keys_dir} is owned by ${directory_owner}:${directory_group}, expected root:root: StrictModes makes sshd reject every member key"
[[ "${directory_mode}" == "755" ]] ||
  fail "${authorized_keys_dir} is mode ${directory_mode}, expected 755: StrictModes makes sshd reject every member key under a group-writable path"

# ---------------------------------------------------------------------------
# 8. The clock, on the host. The container has no clock of its own — it shares
#    the host kernel's — so this reading covers both.
#
#    Production's argument was expiry-time="YYYYMMDDHHMMSSZ" in authorized_keys,
#    the last revocation left when sync cannot reach the control plane, which
#    sshd evaluates against this clock. blitz-core does not render expiry-time
#    (internal/broker/authorized_keys.go emits restrict,command= and the pubkey,
#    nothing more; "no ceiling" is a written decision), so that specific argument
#    does not apply yet. The check stays because a wrong clock still breaks TLS
#    to the control plane and the OAuth access-token lifetime the daemon runs on
#    — and here revocation IS the feed, so a broker that cannot fetch is a broker
#    that cannot revoke.
# ---------------------------------------------------------------------------
timezone="$(timedatectl show --property=Timezone --value)"
if [[ "${timezone}" != "UTC" ]]; then
  fail "host timezone is ${timezone}, expected UTC: every timestamp this broker reasons about is wrong"
fi
if [[ "$(timedatectl show --property=NTPSynchronized --value)" != "yes" ]]; then
  fail "the clock is not NTP synchronised: this broker's TLS and token lifetimes are unreliable"
fi

echo "verified: ${container} running on :${published_port}, sshd up, sync loop enrolled and quiet, ${authorized_keys_dir} root:root 0755, clock UTC/synced"
