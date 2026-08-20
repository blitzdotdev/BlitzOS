#!/usr/bin/env bash
set -euo pipefail

# Provision one operator-provided credential broker host
# (plans/CREDENTIAL-ROAMING.md § Provisioning).
#
#   provision-broker.sh prepare [--dry-run]
#   provision-broker.sh verify  [--dry-run]
#
# BROKER_HOST is the SSH target of the DOCKER HOST (user@host or host). This
# script never creates a machine and never calls a cloud provider: the operator
# supplies the host. SSH_HOST is the public address workspaces dial and defaults
# to the host part of BROKER_HOST; SSH_PORT is the published port and defaults
# to 22.
#
# TWO PASSES, with a human in between, because a workspace PINS this broker's
# SSH host key: the control plane must have that key on file before anything is
# told to trust the broker. The order is:
#
#   1. provision-broker.sh prepare   start the broker container on the host,
#                                    read the SSH host key it generated on its
#                                    state volume, print the enroll command.
#   2. enroll, then approve          the operator runs the printed
#                                    `blitz-broker enroll` and approves the
#                                    device code in a browser. THAT call is what
#                                    creates the broker_boxes row, over
#                                    PUT /boxes/:id/broker.
#   3. provision-broker.sh verify    install and run the end-of-run gate on the
#                                    host, then report the pinned host key.
#
# Production hand-executed `wrangler d1 execute` INSERT SQL at step 2, against a
# pre-shared per-box token the operator had to mint, ship in a 0600 env file and
# keep out of every argv. blitz-core replaces both with the device flow: the
# container authenticates itself and registers its own host/port/host-key, so
# this script carries NO secret at all — nothing to render, nothing to copy,
# nothing to redact. The human step is a browser approval, not a database write.
# Nothing here ever reads the box credential the flow writes onto the state
# volume; the gate proves it exists without opening it.
#
# The broker is infrastructure: it takes no lease, gets no ingress route, and no
# reaper touches it. `member_cap` (default 25) is a blast-radius cap, not a
# capacity number. A second broker is a human running both passes against a
# different BROKER_HOST. There is deliberately no autoscaler and no self-serve
# broker creation.

STAGE_DIR="/tmp/blitz-broker-stage"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# The image's declared mount point (packages/broker/Dockerfile `VOLUME`). It is
# the image contract, not a preference: the state volume carries the SSH host
# key every enrolled workspace pins, so it must survive a container replacement.
STATE_MOUNT="/var/lib/blitz-broker"

usage="usage: provision-broker.sh prepare|verify [--dry-run]"
pass="${1:-}"
case "${pass}" in
  prepare | verify) shift ;;
  *)
    echo "${usage}" >&2
    exit 64
    ;;
esac

dry_run="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run="true"
      shift
      ;;
    *)
      echo "${usage}" >&2
      exit 64
      ;;
  esac
done

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "error: ${name} is required" >&2
    exit 1
  fi
}

require_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "error: ${name} is required" >&2
    exit 1
  fi
}

# ssh joins its remote arguments into ONE string the remote login shell parses,
# so anything interpolated into a remote command line is remote shell source.
# An allowlist rather than an escape: image refs, container and volume names and
# hostnames all live inside this set, and there is no quoting puzzle to lose.
require_plain() {
  local name="$1"
  if [[ ! "${!name}" =~ ^[A-Za-z0-9._:/@=+-]+$ ]]; then
    echo "error: ${name} must contain only [A-Za-z0-9._:/@=+-], got: ${!name}" >&2
    exit 1
  fi
}

require_env BROKER_HOST
if [[ "${pass}" == "prepare" ]]; then
  # Pass 1 composes the enroll command, so it needs the origin the broker will
  # authenticate against and the exact image to run.
  require_env CONTROL_PLANE_ORIGIN
  # No default tag on purpose. Workspaces pin this box's host key, and a
  # floating tag is how a silent image swap becomes a fleet-wide pin mismatch.
  require_env BROKER_IMAGE
fi
if [[ "${pass}" == "verify" ]]; then
  require_command scp
fi
require_command awk
require_command ssh

broker_name="${BROKER_HOST##*@}"
workspace_ssh_host="${SSH_HOST:-${broker_name}}"
workspace_ssh_port="${SSH_PORT:-22}"
container="${BROKER_CONTAINER:-blitz-broker}"
volume="${BROKER_VOLUME:-blitz-broker}"

if [[ ! "${workspace_ssh_port}" =~ ^[0-9]+$ ]] ||
  ((workspace_ssh_port < 1 || workspace_ssh_port > 65535)); then
  echo "error: SSH_PORT must be a port number, got: ${workspace_ssh_port}" >&2
  exit 1
fi
require_plain BROKER_HOST
require_plain workspace_ssh_host
require_plain container
require_plain volume
if [[ "${pass}" == "prepare" ]]; then
  require_plain BROKER_IMAGE
  # The origin is interpolated into enroll_command, which this pass PRINTS for
  # an operator to paste into a shell — so it is shell source twice over, and
  # the paste is the copy nothing here gets to re-check. Every URL an origin may
  # legally be fits the allowlist: controlplane.ValidateOrigin already refuses a
  # user-info, query or fragment, leaving scheme, host, port and an optional
  # trailing slash, all of which are inside [A-Za-z0-9._:/@=+-].
  require_plain CONTROL_PLANE_ORIGIN
fi

umask 077
work_dir="$(mktemp -d)"
trap 'rm -rf -- "${work_dir}"' EXIT

enroll_command="docker exec ${container} blitz-broker enroll --origin ${CONTROL_PLANE_ORIGIN:-} --host ${workspace_ssh_host} --port ${workspace_ssh_port}"

if [[ "${dry_run}" == "true" ]]; then
  if [[ "${pass}" == "prepare" ]]; then
    cat <<EOF
dry-run: ssh ${BROKER_HOST}
dry-run: remote docker volume create ${volume}
dry-run: remote docker run -d --name ${container} --restart unless-stopped -p ${workspace_ssh_port}:22 -v ${volume}:${STATE_MOUNT} ${BROKER_IMAGE:-<BROKER_IMAGE>}
dry-run: remote read ${STATE_MOUNT}/ssh/ssh_host_ed25519_key.pub
dry-run: print the host public key workspaces pin, and the enroll command:
dry-run:   ${enroll_command}
EOF
  else
    cat <<EOF
dry-run: ssh ${BROKER_HOST}
dry-run: scp verify-broker-box.sh -> ${STAGE_DIR}/verify-broker-box.sh
dry-run: remote install -> /usr/local/sbin/blitz-broker-verify.sh
dry-run: remote read ${STATE_MOUNT}/ssh/ssh_host_ed25519_key.pub
dry-run: remote BROKER_CONTAINER=${container} /usr/local/sbin/blitz-broker-verify.sh
EOF
  fi
  exit 0
fi

known_hosts="${work_dir}/known_hosts"
: >"${known_hosts}"
ssh_options=(
  # accept-new, not a pin: on a first run there is no host key to pin yet. The
  # pin belongs on the WORKSPACE side, against the host public key these passes
  # print. The known_hosts file is per-run and thrown away, so a changed key
  # never silently passes twice.
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="${known_hosts}"
  -o BatchMode=yes
  -o ConnectTimeout=5
)

report_host_key() { # remote_log
  local remote_log="$1" host_key
  host_key="$(awk -F'\t' '$1 == "BROKER_SSH_HOST_PUBKEY" { print $2 }' "${remote_log}")"
  if [[ -z "${host_key}" ]]; then
    echo "error: the broker host did not report its SSH host public key" >&2
    exit 1
  fi
  printf '%s\n' "${host_key}"
}

remote_log="${work_dir}/remote.log"

if [[ "${pass}" == "prepare" ]]; then
  ssh "${ssh_options[@]}" "${BROKER_HOST}" /bin/bash -s -- \
    "${container}" "${volume}" "${BROKER_IMAGE}" "${workspace_ssh_port}" "${STATE_MOUNT}" \
    <<'REMOTE' | tee "${remote_log}"
set -euo pipefail
container="$1"
volume="$2"
image="$3"
port="$4"
state_mount="$5"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is not installed on the broker host" >&2
  exit 1
fi

docker volume create "${volume}" >/dev/null

# Idempotent: an existing container is left on the image it was created with.
# Replacing it silently would hand every enrolled workspace a host key mismatch
# if the volume were ever re-created with it, so that is an operator decision.
if [[ -z "$(docker ps -aq --filter "name=^${container}$")" ]]; then
  # No --env-file: the image bakes env.defaults at /etc/blitz/env.defaults and
  # entrypoint.sh sources it. Nothing here belongs in the container environment,
  # which `docker inspect` shows to anyone on the host.
  docker run -d \
    --name "${container}" \
    --restart unless-stopped \
    -p "${port}:22" \
    -v "${volume}:${state_mount}" \
    "${image}" >/dev/null
fi

if [[ "$(docker inspect -f '{{.State.Running}}' "${container}")" != "true" ]]; then
  docker start "${container}" >/dev/null
fi

# Resolved the way entrypoint.sh resolves it, so a host that overrides
# BLITZ_BROKER_STATE_DIR in the container environment is not read at the wrong
# path and reported as a broker with no host key.
state_dir="$(docker exec "${container}" sh -c 'if [ -z "${BLITZ_BROKER_STATE_DIR:-}" ]; then set -a; . /etc/blitz/env.defaults; set +a; fi; printf %s "${BLITZ_BROKER_STATE_DIR}"')"
if [[ -z "${state_dir}" ]]; then
  echo "error: the container reports no BLITZ_BROKER_STATE_DIR" >&2
  exit 1
fi

# entrypoint.sh generates the host key on first start, before it execs the sync
# loop. A fresh container needs a moment; an existing one answers immediately.
host_key=""
for ((attempt = 1; attempt <= 30; attempt++)); do
  host_key="$(docker exec "${container}" cat "${state_dir}/ssh/ssh_host_ed25519_key.pub" 2>/dev/null || true)"
  if [[ -n "${host_key}" ]]; then
    break
  fi
  sleep 1
done
if [[ -z "${host_key}" ]]; then
  echo "error: ${container} generated no SSH host key in 30 seconds" >&2
  exit 1
fi
printf 'BROKER_SSH_HOST_PUBKEY\t%s\n' "${host_key}"
printf 'BROKER_IMAGE_REF\t%s\n' "$(docker inspect -f '{{.Config.Image}}' "${container}")"
REMOTE

  ssh_host_pubkey="$(report_host_key "${remote_log}")"
  image_ref="$(awk -F'\t' '$1 == "BROKER_IMAGE_REF" { print $2 }' "${remote_log}")"

  echo
  echo "broker target:      ${BROKER_HOST}"
  echo "container / volume: ${container} / ${volume}"
  echo "image:              ${image_ref}"
  echo "workspace SSH host: ${workspace_ssh_host}:${workspace_ssh_port}   (key auth only)"
  echo
  echo "pass 1 of 2 done. Workspaces PIN the host key, so read it now:"
  echo "  ssh_host_public_key = ${ssh_host_pubkey}"
  echo
  echo "enroll the broker on the host, then approve the printed code in a browser."
  echo "It prints a verification URL and a user code, waits for you, and then"
  echo "registers host, port and this host key itself — there is no SQL to run:"
  echo
  echo "  ${enroll_command}"
  echo
  echo "then run pass 2:"
  echo "  provision-broker.sh verify"
  exit 0
fi

# PASS 2. Stage the gate, install it, then run it. Nothing secret crosses the
# wire: the only file copied is this repository's verify-broker-box.sh.
ssh "${ssh_options[@]}" "${BROKER_HOST}" /bin/bash -s -- "${STAGE_DIR}" <<'REMOTE'
set -euo pipefail
rm -rf -- "$1"
install -d -m 0700 "$1"
REMOTE

scp "${ssh_options[@]}" "${SCRIPT_DIR}/verify-broker-box.sh" \
  "${BROKER_HOST}:${STAGE_DIR}/verify-broker-box.sh"

ssh "${ssh_options[@]}" "${BROKER_HOST}" /bin/bash -s -- \
  "${STAGE_DIR}" "${container}" \
  <<'REMOTE' | tee "${remote_log}"
set -euo pipefail
stage_dir="$1"
container="$2"
install -m 0755 "${stage_dir}/verify-broker-box.sh" /usr/local/sbin/blitz-broker-verify.sh.new
mv -f /usr/local/sbin/blitz-broker-verify.sh.new /usr/local/sbin/blitz-broker-verify.sh
state_dir="$(docker exec "${container}" sh -c 'if [ -z "${BLITZ_BROKER_STATE_DIR:-}" ]; then set -a; . /etc/blitz/env.defaults; set +a; fi; printf %s "${BLITZ_BROKER_STATE_DIR}"')"
printf 'BROKER_SSH_HOST_PUBKEY\t%s\n' \
  "$(docker exec "${container}" cat "${state_dir}/ssh/ssh_host_ed25519_key.pub")"
rm -rf -- "${stage_dir}"
# THE GATE, and it runs LAST. A non-zero result fails the remote shell and, via
# pipefail on the tee above, this whole run — before the success report below is
# printed. That ordering is the point: production once shipped a "success"
# report for a box that was not working.
BROKER_CONTAINER="${container}" /usr/local/sbin/blitz-broker-verify.sh >&2
REMOTE

ssh_host_pubkey="$(report_host_key "${remote_log}")"

echo
echo "broker target:      ${BROKER_HOST}"
echo "container:          ${container}"
echo "workspace SSH host: ${workspace_ssh_host}:${workspace_ssh_port}   (key auth only)"
echo
echo "these MUST match the broker_boxes row the enroll step registered:"
echo "  host                = ${workspace_ssh_host}"
echo "  port                = ${workspace_ssh_port}"
echo "  ssh_host_public_key = ${ssh_host_pubkey}"
