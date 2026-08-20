#!/bin/sh
set -eu

# Asserts on what the broker provisioning scripts check and invoke, under fake
# docker/systemctl/ss/timedatectl/ssh/scp. Nothing here reaches a real host, a
# real daemon or a real control plane.
#
# POSIX sh on purpose, like packages/control-plane/test/shell-syntax.sh, so the
# repository can run it with `sh`. The scripts under test are bash and are
# invoked as bash.

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
provision="$script_dir/provision-broker.sh"
gate="$script_dir/verify-broker-box.sh"

test_dir=$(mktemp -d "${TMPDIR:-/tmp}/blitz-broker-deploy.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# ===========================================================================
# 1. Both scripts parse, and neither reintroduces the SIGPIPE trap.
# ===========================================================================
bash -n "$provision" || fail "provision-broker.sh does not parse"
bash -n "$gate" || fail "verify-broker-box.sh does not parse"

# `grep -q` exits on the first match and closes the pipe, the producer dies of
# SIGPIPE, and pipefail turns a SUCCESSFUL match into a failed check: green on a
# short log, red on every healthy long-lived box. The gate must capture into a
# variable first (production hit this on 2026-08-08).
if grep -Eq '(docker logs|journalctl)[^|]*\| *grep' "$gate"; then
  fail "the gate pipes a log producer into grep; pipefail will fail on a successful match"
fi
# `head`/`tail` close the pipe the same way.
if grep -Eq '(docker port|docker logs)[^|]*\| *(head|tail)' "$gate"; then
  fail "the gate pipes a docker producer into head/tail; that is the same SIGPIPE trap"
fi

# ===========================================================================
# 2. Fakes.
# ===========================================================================
fake_bin="$test_dir/bin"
mkdir "$fake_bin"

cat >"$fake_bin/systemctl" <<'SH'
#!/bin/sh
printf 'systemctl %s\n' "$*" >>"$BLITZ_TEST_ARGV_LOG"
case "$*" in
  "is-active --quiet docker")
    [ "${BLITZ_TEST_DOCKER_ACTIVE:-true}" = true ] || exit 3 ;;
  *) printf 'unexpected systemctl invocation: %s\n' "$*" >&2; exit 2 ;;
esac
SH

cat >"$fake_bin/ss" <<'SH'
#!/bin/sh
printf 'ss %s\n' "$*" >>"$BLITZ_TEST_ARGV_LOG"
if [ "${BLITZ_TEST_LISTENING:-true}" = true ]; then
  printf 'LISTEN 0 4096 0.0.0.0:%s 0.0.0.0:*\n' "${BLITZ_TEST_PORT:-2222}"
fi
SH

cat >"$fake_bin/timedatectl" <<'SH'
#!/bin/sh
printf 'timedatectl %s\n' "$*" >>"$BLITZ_TEST_ARGV_LOG"
case "$*" in
  "show --property=Timezone --value") printf '%s\n' "${BLITZ_TEST_TIMEZONE:-UTC}" ;;
  "show --property=NTPSynchronized --value") printf '%s\n' "${BLITZ_TEST_NTP:-yes}" ;;
  *) printf 'unexpected timedatectl invocation: %s\n' "$*" >&2; exit 2 ;;
esac
SH

# One fake for every docker subcommand the gate reaches for. Each toggle takes
# down exactly one condition so a failing assertion names one cause.
cat >"$fake_bin/docker" <<'SH'
#!/bin/sh
printf 'docker %s\n' "$*" >>"$BLITZ_TEST_ARGV_LOG"
subcommand=$1
shift
case "$subcommand" in
  inspect)
    [ "${BLITZ_TEST_CONTAINER_EXISTS:-true}" = true ] || exit 1
    printf '%s %s\n' "${BLITZ_TEST_RUNNING:-true}" "${BLITZ_TEST_RESTART:-unless-stopped}" ;;
  port)
    [ "${BLITZ_TEST_PORT_PUBLISHED:-true}" = true ] || exit 1
    printf '0.0.0.0:%s\n[::]:%s\n' "${BLITZ_TEST_PORT:-2222}" "${BLITZ_TEST_PORT:-2222}" ;;
  logs)
    [ "${BLITZ_TEST_FEED_OK:-true}" = true ] ||
      printf 'broker feed unavailable; keeping rendered state\n' ;;
  exec)
    shift # the container name
    case "$1" in
      pgrep) [ "${BLITZ_TEST_SSHD_UP:-true}" = true ] || exit 1 ;;
      ps) printf '%s\n' "${BLITZ_TEST_PID1:-/usr/local/bin/blitz-broker sync}" ;;
      sh) printf '%s' "${BLITZ_TEST_STATE_DIR:-/var/lib/blitz-broker}" ;;
      test) [ "${BLITZ_TEST_ENROLLED:-true}" = true ] || exit 1 ;;
      awk) printf '%s\n' "${BLITZ_TEST_AUTHORIZED_KEYS_FILE:-/etc/blitz-broker/authorized_keys/%u}" ;;
      stat) printf '%s\n' "${BLITZ_TEST_AUTHORIZED_KEYS_STAT:-755 root root}" ;;
      *) printf 'unexpected docker exec: %s\n' "$*" >&2; exit 2 ;;
    esac ;;
  *) printf 'unexpected docker invocation: %s %s\n' "$subcommand" "$*" >&2; exit 2 ;;
esac
SH

# The retry loops must not make the suite wait on a real clock.
cat >"$fake_bin/sleep" <<'SH'
#!/bin/sh
exit 0
SH

cat >"$fake_bin/ssh" <<'SH'
#!/bin/sh
printf 'ssh %s\n' "$*" >>"$BLITZ_TEST_ARGV_LOG"
for argument do
  if [ "$argument" = /bin/bash ]; then
    remote_script=$(command cat)
    printf '%s\n' "$remote_script" >>"$BLITZ_TEST_STDIN_LOG"
    printf '%s\n' "$remote_script" >"$BLITZ_TEST_STDIN_LAST"
    case "$remote_script" in
      *BROKER_SSH_HOST_PUBKEY*)
        printf 'BROKER_SSH_HOST_PUBKEY\t%s\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5FAKEHOST broker'
        printf 'BROKER_IMAGE_REF\t%s\n' 'ghcr.io/blitzdotdev/blitz-broker@sha256:feed'
        ;;
    esac
    # A box that does not pass the end-of-run gate: the remote shell runs set -e,
    # so the ssh itself comes back non-zero.
    case "${BLITZ_TEST_VERIFY_FAILS:-false}:$remote_script" in
      true:*blitz-broker-verify.sh*)
        printf 'error: nothing is listening on port 2222\n' >&2
        exit 1 ;;
    esac
    break
  fi
done
exit 0
SH

cat >"$fake_bin/scp" <<'SH'
#!/bin/sh
printf 'scp %s\n' "$*" >>"$BLITZ_TEST_ARGV_LOG"
exit 0
SH

chmod 0755 "$fake_bin"/*
real_path=$PATH
PATH="$fake_bin:$PATH"
export PATH

BLITZ_TEST_ARGV_LOG="$test_dir/argv.log"
BLITZ_TEST_STDIN_LOG="$test_dir/ssh-stdin.log"
BLITZ_TEST_STDIN_LAST="$test_dir/ssh-stdin.last"
export BLITZ_TEST_ARGV_LOG BLITZ_TEST_STDIN_LOG BLITZ_TEST_STDIN_LAST
: >"$BLITZ_TEST_ARGV_LOG"
: >"$BLITZ_TEST_STDIN_LOG"
: >"$BLITZ_TEST_STDIN_LAST"

# ===========================================================================
# 3. verify-broker-box.sh, the end-of-run gate.
#
#    It is invoked here EXACTLY as pass 2 invokes it — no arguments. Running it
#    with an address the caller no longer passes is how the production suite
#    stayed green while the gate died on a real box with
#    "usage: verify-broker-box.sh <overlay_ip>" (2026-08-08).
# ===========================================================================
: >"$BLITZ_TEST_ARGV_LOG"
gate_output=$(bash "$gate" 2>&1) ||
  fail "a healthy box did not pass the gate: $gate_output"

# `running` is not proof of a usable listener: ask the kernel what is bound.
grep -Fq 'ss -H -ltn sport = :2222' "$BLITZ_TEST_ARGV_LOG" ||
  fail "the gate never asks the kernel what the broker actually bound"
# sshd is a background child of the entrypoint, so the container stays "running"
# when it dies. The gate must look inside.
grep -Fq 'docker exec blitz-broker pgrep -x sshd' "$BLITZ_TEST_ARGV_LOG" ||
  fail "the gate never checks that sshd is alive inside the container"
# The blitz-core equivalent of production's `members:` line: an existing box
# credential plus a quiet window from the 1 s sync loop.
grep -Fq 'box-credential.json' "$BLITZ_TEST_ARGV_LOG" ||
  fail "the gate never checks that the box holds a control-plane credential"
grep -Fq 'docker logs --since 10s blitz-broker' "$BLITZ_TEST_ARGV_LOG" ||
  fail "the gate never reads the sync loop's log"
# The directory sshd reads must be the directory the daemon renders into.
grep -Fq 'AuthorizedKeysFile' "$BLITZ_TEST_ARGV_LOG" ||
  fail "the gate never cross-checks authorized_keys against sshd_config"
# A container clock is the host clock; a wrong one breaks TLS and token lifetime.
grep -Fq 'timedatectl show --property=NTPSynchronized --value' "$BLITZ_TEST_ARGV_LOG" ||
  fail "the gate never checks the clock"

expect_gate_failure() { # message env-name=value...
  expected_message=$1
  shift
  gate_stderr="$test_dir/gate.stderr"
  if env "$@" bash "$gate" >/dev/null 2>"$gate_stderr"; then
    fail "$expected_message"
  fi
  grep -Fq 'error:' "$gate_stderr" || fail "$expected_message (no error line)"
}

expect_gate_failure "a host with no docker daemon passed the gate" \
  BLITZ_TEST_DOCKER_ACTIVE=false
expect_gate_failure "a missing container passed the gate" \
  BLITZ_TEST_CONTAINER_EXISTS=false
expect_gate_failure "a stopped container passed the gate" \
  BLITZ_TEST_RUNNING=false
expect_gate_failure "a container that will not restart passed the gate" \
  BLITZ_TEST_RESTART=no
expect_gate_failure "a container with no sshd passed the gate" \
  BLITZ_TEST_SSHD_UP=false
expect_gate_failure "a container publishing no port passed the gate" \
  BLITZ_TEST_PORT_PUBLISHED=false
expect_gate_failure "a listener bound to nothing passed the gate" \
  BLITZ_TEST_LISTENING=false
expect_gate_failure "a container whose PID 1 is not the sync loop passed the gate" \
  BLITZ_TEST_PID1=/bin/sleep
expect_gate_failure "an un-enrolled broker passed the gate" \
  BLITZ_TEST_ENROLLED=false
expect_gate_failure "a sync loop that never reached the control plane passed the gate" \
  BLITZ_TEST_FEED_OK=false
expect_gate_failure "an authorized_keys directory sshd does not read passed the gate" \
  BLITZ_TEST_AUTHORIZED_KEYS_FILE=.ssh/authorized_keys
expect_gate_failure "a member-owned authorized_keys directory passed the gate" \
  BLITZ_TEST_AUTHORIZED_KEYS_STAT="755 m-0123456789ab m-0123456789ab"
expect_gate_failure "a group-writable authorized_keys directory passed the gate" \
  BLITZ_TEST_AUTHORIZED_KEYS_STAT="775 root root"
expect_gate_failure "a non-UTC host passed the gate" \
  BLITZ_TEST_TIMEZONE=Europe/Berlin
expect_gate_failure "an unsynchronised clock passed the gate" \
  BLITZ_TEST_NTP=no

# ===========================================================================
# 4. provision-broker.sh: two passes, required inputs, and the gate's exit
#    status staying load-bearing.
# ===========================================================================
prepare_env="BROKER_HOST=operator@broker.example \
CONTROL_PLANE_ORIGIN=https://cp.example \
BROKER_IMAGE=ghcr.io/blitzdotdev/blitz-broker@sha256:feed \
SSH_PORT=2222"

# shellcheck disable=SC2086  # the assignments are deliberately word-split into env
env $prepare_env bash "$provision" prepare --dry-run \
  >"$test_dir/prepare-dry.stdout" 2>"$test_dir/prepare-dry.stderr" ||
  fail "pass 1 dry-run failed: $(cat "$test_dir/prepare-dry.stderr")"
grep -Fq 'ssh operator@broker.example' "$test_dir/prepare-dry.stdout" ||
  fail "pass 1 does not use BROKER_HOST as the SSH target"
grep -Fq 'blitz-broker enroll --origin https://cp.example --host broker.example --port 2222' \
  "$test_dir/prepare-dry.stdout" ||
  fail "pass 1 does not print the device-flow enroll command the operator runs"

env BROKER_HOST=operator@broker.example bash "$provision" verify --dry-run \
  >"$test_dir/verify-dry.stdout" 2>"$test_dir/verify-dry.stderr" ||
  fail "pass 2 dry-run failed: $(cat "$test_dir/verify-dry.stderr")"
grep -Fq 'verify-broker-box.sh' "$test_dir/verify-dry.stdout" ||
  fail "pass 2 dry-run does not say it stages and runs the gate"

expect_provision_failure() { # message pass env-name=value...
  expected_message=$1
  provision_pass=$2
  shift 2
  provision_stderr="$test_dir/provision.stderr"
  if env "$@" bash "$provision" "$provision_pass" --dry-run \
    >/dev/null 2>"$provision_stderr"; then
    fail "$expected_message"
  fi
  grep -Fq 'error:' "$provision_stderr" || fail "$expected_message (no error line)"
}

expect_provision_failure "pass 1 accepted a missing BROKER_HOST" prepare \
  CONTROL_PLANE_ORIGIN=https://cp.example BROKER_IMAGE=broker@sha256:feed
grep -Fq 'BROKER_HOST is required' "$test_dir/provision.stderr" ||
  fail "the missing BROKER_HOST error does not name the required input"
expect_provision_failure "pass 1 accepted a missing CONTROL_PLANE_ORIGIN" prepare \
  BROKER_HOST=broker.example BROKER_IMAGE=broker@sha256:feed
expect_provision_failure "pass 1 accepted a missing BROKER_IMAGE" prepare \
  BROKER_HOST=broker.example CONTROL_PLANE_ORIGIN=https://cp.example
expect_provision_failure "an invalid SSH_PORT was accepted" verify \
  BROKER_HOST=broker.example SSH_PORT=notaport
# ssh joins its remote arguments into one string the remote shell parses, so an
# image reference is remote shell source.
expect_provision_failure "an image reference carrying a shell command was accepted" prepare \
  BROKER_HOST=broker.example CONTROL_PLANE_ORIGIN=https://cp.example \
  'BROKER_IMAGE=broker@sha256:feed; rm -rf /'

# ---- pass 1 for real, against the fakes ------------------------------------
: >"$BLITZ_TEST_ARGV_LOG"
: >"$BLITZ_TEST_STDIN_LOG"
# shellcheck disable=SC2086  # see above
env $prepare_env bash "$provision" prepare \
  >"$test_dir/prepare.stdout" 2>&1 ||
  fail "pass 1 failed: $(cat "$test_dir/prepare.stdout")"

grep -Fq 'docker run -d' "$BLITZ_TEST_STDIN_LOG" ||
  fail "pass 1 never starts the broker container"
grep -Fq -- '--restart unless-stopped' "$BLITZ_TEST_STDIN_LOG" ||
  fail "pass 1 starts a container that will not survive its first crash"
grep -Fq 'ssh_host_ed25519_key.pub' "$BLITZ_TEST_STDIN_LOG" ||
  fail "pass 1 never reads the SSH host key workspaces pin"
# Workspaces PIN this key, so the operator has to be able to eyeball it.
grep -Fq 'ssh_host_public_key = ssh-ed25519 AAAAC3NzaC1lZDI1NTE5FAKEHOST' \
  "$test_dir/prepare.stdout" ||
  fail "pass 1 does not print the host public key workspaces pin"
grep -Fq 'blitz-broker enroll --origin https://cp.example --host broker.example --port 2222' \
  "$test_dir/prepare.stdout" ||
  fail "pass 1 does not print the enroll command"
# The device flow replaced production's hand-run INSERT. Nothing here should
# send an operator back to a SQL console.
if grep -Eq 'INSERT INTO|wrangler d1' "$test_dir/prepare.stdout"; then
  fail "pass 1 still asks a human to hand-write the broker_boxes row"
fi
# Pass 1 prepares; it does not configure a box that is not registered yet.
if grep -Fq 'blitz-broker-verify.sh' "$BLITZ_TEST_STDIN_LOG"; then
  fail "pass 1 ran the end-of-run gate before the broker was enrolled"
fi

# ---- pass 2 for real -------------------------------------------------------
: >"$BLITZ_TEST_ARGV_LOG"
: >"$BLITZ_TEST_STDIN_LOG"
env BROKER_HOST=operator@broker.example SSH_PORT=2222 \
  bash "$provision" verify >"$test_dir/verify.stdout" 2>&1 ||
  fail "pass 2 failed: $(cat "$test_dir/verify.stdout")"

grep -Fq 'install -d -m 0700 ' "$BLITZ_TEST_STDIN_LOG" ||
  fail "the remote staging directory is not 0700"
grep -Fq 'verify-broker-box.sh' "$BLITZ_TEST_ARGV_LOG" ||
  fail "pass 2 never copies the gate to the host"
# The gate's exit status is LOAD-BEARING: no `|| true`, no `if`, nothing that
# turns a box that does not work into a successful provision — and it is the
# LAST thing the remote shell does, so its failure lands before any report.
grep -Eq '^BROKER_CONTAINER="\$\{container\}" /usr/local/sbin/blitz-broker-verify\.sh >&2$' \
  "$BLITZ_TEST_STDIN_LOG" ||
  fail "pass 2 either never runs the end-of-run gate or swallows its exit status"
last_remote_line=$(tail -n 1 "$BLITZ_TEST_STDIN_LAST")
case "$last_remote_line" in
  *blitz-broker-verify.sh*) ;;
  *) fail "the gate is not the last thing pass 2 runs on the host: $last_remote_line" ;;
esac
grep -Fq 'ssh_host_public_key = ssh-ed25519 AAAAC3NzaC1lZDI1NTE5FAKEHOST' \
  "$test_dir/verify.stdout" ||
  fail "pass 2 does not re-print the host public key for the operator to match"

# A box that fails the gate is NOT a provisioned box: pass 2 must exit non-zero
# and must not print the report the operator matches against broker_boxes.
: >"$BLITZ_TEST_STDIN_LOG"
if env BROKER_HOST=operator@broker.example BLITZ_TEST_VERIFY_FAILS=true \
  bash "$provision" verify >"$test_dir/verify-fail.stdout" 2>&1; then
  fail "pass 2 exited 0 although the box did not verify"
fi
if grep -Fq 'these MUST match' "$test_dir/verify-fail.stdout"; then
  fail "pass 2 printed its success report although the box did not verify"
fi

# ===========================================================================
# 5. shellcheck
# ===========================================================================
PATH=$real_path
export PATH
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x "$script_dir"/*.sh || fail "shellcheck reported findings"
  printf '%s\n' "shellcheck: clean"
else
  printf '%s\n' "shellcheck: not installed, skipped" >&2
fi

printf '%s\n' "provision-broker.test.sh: all assertions passed"
