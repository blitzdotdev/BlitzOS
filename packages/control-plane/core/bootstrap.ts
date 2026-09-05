export interface BootstrapOptions {
  boxImageSha256: string;
  boxImageRef: string;
  boxImageTag: string;
  phoneHomeUrl: string;
  sshPublicKey?: string;
  /** Org-level agent-usage capture: pre-creates the two transcript HOME dirs
   * and bind-mounts them read-only under /workspace/shared/agent-usage/. */
  usageCapture?: boolean;
  /** Template repos ("owner/name") cloned into /workspace/<name> by a
   * detached best-effort retry loop (TEMPLATES-V2). Absent or empty leaves
   * the emitted bytes untouched for every ordinary create. */
  repos?: string[];
  /** The resolved VM provider's own apt setup lines, from
   * `VmProvider.bootstrapAptSetup`. Absent emits a script with no provider
   * lines at all, so one provider's fault can never reach another provider's
   * box (plans/PROVIDER-BOOTSTRAP.md). */
  providerAptSetup?: string;
  /** The box container's `--hostname`. Claude's Remote Control names its
   * target `os.hostname()`. No flag overrides that name. Docker defaults the
   * box hostname to the container id, which is hex, so every workspace reads
   * alike in claude.ai/code. Build this value with `boxHostname`. An absent
   * value leaves the emitted bytes untouched. */
  boxHostname?: string;
}

/** Makes one DNS label from a workspace name for `docker run --hostname`.
 * Docker refuses a hostname above 64 characters. Above that, runc fails with
 * `sethostname: invalid argument`. The cap here is 63, the DNS label limit,
 * which sits below both failure points. A name holds any Unicode, so each run
 * outside `[a-z0-9-]` becomes one dash. The edges then lose their dashes. A
 * name of non-Latin characters leaves nothing. The workspace id takes over
 * there: it is a UUID, which is already a legal label. An empty `--hostname`
 * must never reach the shell. */
export function boxHostname(workspaceName: string, workspaceId: string): string {
  const label = workspaceName
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .slice(0, 63)
    .replaceAll(/^-+|-+$/gu, "");
  return label === "" ? workspaceId : label;
}

/** Shell-escapes a value into one single-quoted token. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Emits the first-boot script a VM runs: bash, with Python inline for the
 * box-image manifest. It is a template literal rather than a file because a
 * Worker has no filesystem to read at runtime, so the script has to be part
 * of the bundle. The emitted bytes are a contract pinned by
 * `test/bootstrap-python.test.mjs` and the phone-home fixtures — edit them
 * the way you would edit a wire format, not a script. A create without
 * usage capture or template repos emits byte-identical output. */
/**
 * The shell helpers `boxImageSetupScript` calls. Emitting that setup without
 * these gives `retry: command not found`, and under `set -e` the script dies
 * where it stands. The golden-image bake hit exactly that on its first real
 * run: the builder never powered off, and the bake waited 30 minutes for a
 * shutdown that could not come.
 *
 * `buildBootstrapScript` emits these in its own preamble. Any other caller
 * that embeds the setup has to emit them first.
 */
export const BOX_IMAGE_SETUP_HELPERS = `retry() {
  local attempt=1
  local max_attempts=10
  until "$@"; do
    if (( attempt >= max_attempts )); then
      echo "command failed after $attempt attempts: $*"
      return 1
    fi
    sleep $((attempt * 3))
    attempt=$((attempt + 1))
  done
}
`;

/** The three variables that name one box image build. */
export interface BoxImageRef {
  boxImageRef: string;
  boxImageTag: string;
  boxImageSha256: string;
}

/**
 * The bash that puts the box image into the host's docker store: download and
 * `docker load` for an HTTPS tarball ref, or `docker pull` for a registry ref.
 * Both branches guard on `docker image inspect`, so a host that already holds
 * the image does no work at all. That guard is what makes a golden snapshot
 * fast: the image is already there and the whole block is skipped.
 *
 * Exported so the golden-image bake script bakes the SAME bytes a workspace
 * would download. Two copies of this would be two sides of one contract, and
 * drift between them would produce snapshots holding the wrong image.
 */
export function boxImageSetupScript(options: BoxImageRef): string {
  const isTarball = options.boxImageRef.startsWith("https://");
  if (isTarball && options.boxImageTag.trim() === "") {
    throw new Error("BOX_IMAGE_TAG is required when BOX_IMAGE_REF is an HTTPS URL");
  }
  if (isTarball && !/^[a-fA-F0-9]{64}$/u.test(options.boxImageSha256)) {
    throw new Error(
      "BOX_IMAGE_SHA256 must be a 64-character hexadecimal digest when BOX_IMAGE_REF is an HTTPS URL",
    );
  }
  return isTarball
    ? String.raw`download() {
  curl --fail --location --retry 10 --retry-all-errors --retry-delay 3 \
    --silent --show-error --output "$2" "$1"
}

verify_sha256() {
  local path="$1"
  local expected="$2"
  local actual
  actual=$(sha256sum "$path" | cut -d ' ' -f 1)
  expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
  [ "$actual" = "$expected" ] || fail "SHA-256 mismatch for $path"
}

if ! docker image inspect "$BOX_IMAGE_TAG" >/dev/null 2>&1; then
image_tmp_dir=$(mktemp -d /var/lib/blitz/.bootstrap-image.XXXXXX)
trap 'rm -rf "$image_tmp_dir"' EXIT
image_archive="$image_tmp_dir/image.tar.gz"

case "$BOX_IMAGE_REF" in
  */manifest.json)
    manifest_path="$image_tmp_dir/manifest.json"
    manifest_parts_path="$image_tmp_dir/parts.tsv"
    manifest_metadata_path="$image_tmp_dir/metadata.tsv"
    download "$BOX_IMAGE_REF" "$manifest_path"
    python3 - "$manifest_path" "$manifest_parts_path" >"$manifest_metadata_path" <<'PYTHON'
import json
import re
import sys

manifest_path, parts_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as manifest_file:
    value = json.load(manifest_file)

parts = value.get("parts")
total_sha256 = value.get("totalSha256")
image_tag = value.get("imageTag")
if not isinstance(parts, list) or not parts:
    raise ValueError("manifest parts must be a non-empty list")
if not isinstance(total_sha256, str) or re.fullmatch(r"[a-fA-F0-9]{64}", total_sha256) is None:
    raise ValueError("manifest totalSha256 must be a SHA-256 digest")
if not isinstance(image_tag, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*", image_tag) is None:
    raise ValueError("manifest imageTag is invalid")

with open(parts_path, "w", encoding="utf-8") as parts_file:
    for part in parts:
        if not isinstance(part, dict):
            raise ValueError("manifest part must be an object")
        name = part.get("name")
        sha256 = part.get("sha256")
        if not isinstance(name, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) is None:
            raise ValueError("manifest part name is invalid")
        if not isinstance(sha256, str) or re.fullmatch(r"[a-fA-F0-9]{64}", sha256) is None:
            raise ValueError("manifest part sha256 must be a SHA-256 digest")
        parts_file.write(f"{name}\t{sha256.lower()}\n")

print(f"{total_sha256.lower()}\t{image_tag}")
PYTHON
    IFS=$'\t' read -r manifest_total_sha256 manifest_image_tag <"$manifest_metadata_path"
    [ "$manifest_image_tag" = "$BOX_IMAGE_TAG" ] || fail "manifest imageTag $manifest_image_tag does not match BOX_IMAGE_TAG $BOX_IMAGE_TAG"
    manifest_base=${"${BOX_IMAGE_REF%/*}"}
    : >"$image_archive"
    while IFS=$'\t' read -r part_name part_sha256; do
      part_path="$image_tmp_dir/$part_name"
      download "$manifest_base/$part_name" "$part_path"
      verify_sha256 "$part_path" "$part_sha256"
      cat "$part_path" >>"$image_archive"
      rm -f "$part_path"
    done <"$manifest_parts_path"
    verify_sha256 "$image_archive" "$manifest_total_sha256"
    ;;
  *)
    download "$BOX_IMAGE_REF" "$image_archive"
    ;;
esac

verify_sha256 "$image_archive" "$BOX_IMAGE_SHA256"
gunzip -c "$image_archive" | docker load
rm -rf "$image_tmp_dir"
trap - EXIT
fi
docker image inspect "$BOX_IMAGE_TAG" >/dev/null
box_image="$BOX_IMAGE_TAG"`
    : String.raw`if ! docker image inspect "$BOX_IMAGE_REF" >/dev/null 2>&1; then
  retry docker pull "$BOX_IMAGE_REF"
fi
docker image inspect "$BOX_IMAGE_REF" >/dev/null
box_image="$BOX_IMAGE_REF"`;
}

/** Host inotify capacity for the box, emitted into the bootstrap.
 *
 * Every process in the box container runs as the same uid. Node consumes one
 * inotify instance for each `fs.watch()`, so the kernel's per-uid defaults are
 * one shared ceiling for the session daemon and every agent it starts. Once
 * that ceiling is full, a new session can fail or hang while installing its
 * settings watchers and block the daemon's single local dispatch queue.
 *
 * This belongs on the host, before Docker starts. The drop-in is the durable
 * half: systemd-sysctl replays it after every reboot. `sysctl -p` applies the
 * same values to the boot already in progress. A kernel that refuses either
 * value still has to boot the workspace, so applying the file is non-fatal.
 *
 * KEEP THIS TERSE. Every byte here is cloud-init user-data, and Hetzner caps
 * that at HETZNER_USER_DATA_MAX_BYTES. Reasoning belongs in this comment,
 * which never ships; the emitted script carries only what bash must read. */
const INOTIFY_SETUP = `cat >/etc/sysctl.d/60-blitz-inotify.conf <<'INOTIFY'
fs.inotify.max_user_instances = 1024
fs.inotify.max_user_watches = 524288
INOTIFY
sysctl -q -p /etc/sysctl.d/60-blitz-inotify.conf || echo "blitz bootstrap: inotify sysctl failed, continuing"
blitz_phase inotify-ready

`;

/** Compressed swap for the VM, emitted into the bootstrap.
 *
 * A Hetzner Ubuntu image ships no swap at all. With none, a workspace that
 * fills RAM skips every soft stage and lands in direct reclaim: every process stalls,
 * the tunnel stops answering its heartbeats, and the box reads as "connecting"
 * with no OOM line anywhere to explain it. That silent stall, not a kill, is
 * the failure this closes.
 *
 * zram and not a swapfile: the pages stay in RAM, compressed, so the tail of a
 * spike costs CPU instead of disk. A swapfile on the workspace volume would
 * turn a memory spike into an I/O storm on the same disk the build is using.
 *
 * The stock Hetzner Ubuntu image ships without the zram module — it lives in
 * linux-modules-extra, which the lab measured as absent on 2026-08-29. The
 * install fallback covers it; a kernel with no package still boots, swapless.
 *
 * swappiness 100 and page-cluster 0 are the standard pairing for zram. The
 * default 60 assumes a slow disk and holds anonymous pages too long, and the
 * default readahead of 8 pages wastes decompression on pages nobody wants.
 *
 * The disksize arithmetic is `kb * 256`, which is `kb * 1024 / 4` — a
 * quarter of RAM, expressed in bytes.
 *
 * KEEP THIS TERSE. Every byte here is cloud-init user-data, and Hetzner caps
 * that at HETZNER_USER_DATA_MAX_BYTES. Reasoning belongs in this comment,
 * which never ships; the emitted script carries only what bash must read. */
const ZRAM_SETUP = `cat >/usr/local/sbin/blitz-zram <<'ZRAM'
#!/bin/bash
set -Eeuo pipefail
swapoff /dev/zram0 2>/dev/null || true
modprobe zram 2>/dev/null || {
  apt-get install -y -qq linux-modules-extra-$(uname -r) >/dev/null 2>&1 || true
  modprobe zram || exit 0
}
kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
echo 1 >/sys/block/zram0/reset 2>/dev/null || true
echo lz4 >/sys/block/zram0/comp_algorithm 2>/dev/null || true
echo $(( kb * 256 )) >/sys/block/zram0/disksize
mkswap /dev/zram0 >/dev/null
swapon -p 100 /dev/zram0
sysctl -qw vm.swappiness=100 vm.page-cluster=0
ZRAM
chmod 0755 /usr/local/sbin/blitz-zram
cat >/etc/systemd/system/blitz-zram.service <<'ZU'
[Unit]
Description=Blitz compressed swap
Before=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/blitz-zram
[Install]
WantedBy=multi-user.target
ZU
systemctl daemon-reload
systemctl enable --now blitz-zram.service || echo "blitz bootstrap: no zram, continuing"
blitz_phase zram-ready

`;

export function buildBootstrapScript(options: BootstrapOptions): string {
  const controlPlaneOrigin = new URL(options.phoneHomeUrl).origin;
  const trimmedSshPublicKey = options.sshPublicKey?.trim();
  const sshPublicKey = trimmedSshPublicKey === "" ? undefined : trimmedSshPublicKey;

  const imageSetup = boxImageSetupScript(options);

  // The resolved provider's own lines. "" for a provider that needs none, so
  // its boxes never read another provider's setup.
  const providerAptSetup = options.providerAptSetup ?? "";

  // Usage-capture segments; every one is "" on an ordinary create so the
  // emitted bytes stay identical for the plain path.
  // This value lands in an emitted shell command. The emitter is the
  // shell-interpolation boundary. `boxHostname` is the real gate. This
  // re-check keeps the boundary local, the way the template repos do.
  // Refuse a bad shape. Never quote around one.
  const hostname = options.boxHostname;
  if (hostname !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)) {
    throw new Error(`box hostname is not a DNS label: ${hostname}`);
  }
  const hostnameFlag = hostname === undefined
    ? ""
    : `  --hostname ${shellQuote(hostname)} \\\n`;
  // The two transcript HOME dirs pre-exist owned by the blitz user so the
  // read-only mounts never make docker invent root-owned sources, and
  // /workspace/shared/agent-usage pre-exists for the same reason on the
  // destination side (docker would otherwise create shared/ as root and
  // break Drive folder materialization).
  const usageDirectories = options.usageCapture !== true
    ? ""
    : `install -d -o 1000 -g 1000 /var/lib/blitz/home/.claude/projects
install -d -o 1000 -g 1000 /var/lib/blitz/home/.codex/sessions
install -d -o 1000 -g 1000 /var/lib/blitz/workspace/shared/agent-usage
`;
  const usageMounts = options.usageCapture !== true
    ? ""
    : `  --mount type=bind,src=/var/lib/blitz/home/.claude/projects,dst=/workspace/shared/agent-usage/claude,readonly \\
  --mount type=bind,src=/var/lib/blitz/home/.codex/sessions,dst=/workspace/shared/agent-usage/codex,readonly \\
`;
  // The detached `blitz-rc` remote-control tmux session used to be emitted
  // here. Parked 2026-08-24 (owner ruling): that session created the box's
  // tmux server from a bare `docker exec` environment, and every later tab
  // inherited the hollow server, which broke fresh-workspace logins. Bring
  // the feature back only as an in-image service with a real login
  // environment.

  // ---- TEMPLATES-V2 repo cloner (keep as one self-contained segment) ----
  // "" on every create without template repos, so the emitted bytes stay
  // identical and every existing bootstrap pin holds. With repos it starts
  // one detached best-effort retry loop inside the box: each pass skips
  // repos that already have a .git (idempotent across reboots), falls back
  // from Git's negotiated HTTP/2 to HTTP/1.1, and retries every 5s for up to
  // 10 minutes, because cloning can only succeed once registration completes
  // and the baked /etc/gitconfig credential helper (`blitz-git-credential`,
  // CP-direct) can mint. `|| true` overall: a failed clone never fails the
  // boot; output lands in /var/lib/blitz/repo-clone.log.
  const repos = options.repos ?? [];
  for (const repo of repos) {
    // The save-time validator is the real gate; this re-check keeps the
    // shell-interpolation boundary local to the emitter.
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
      throw new Error(`template repo is not owner/name shaped: ${repo}`);
    }
  }
  const repoCloneAttempts = repos.map((repo) => {
    const directory = repo.slice(repo.indexOf("/") + 1);
    return `  [ -d /workspace/${directory}/.git ] || git clone https://github.com/${repo} /workspace/${directory} || git -c http.version=HTTP/1.1 clone https://github.com/${repo} /workspace/${directory} || cloned=false`;
  }).join("\n");
  const repoCloner = repos.length === 0
    ? ""
    : `echo "blitz bootstrap: template repo cloner starting in the background (best-effort)"
nohup docker exec \\
  --user 1000:1000 \\
  --env HOME=/var/lib/blitz/home \\
  --env USER=blitz \\
  blitz-box \\
  sh -c 'deadline=$(( $(date +%s) + 600 ))
while :; do
  cloned=true
${repoCloneAttempts}
  [ "$cloned" = true ] && { echo "template repos cloned"; break; }
  [ "$(date +%s)" -lt "$deadline" ] || { echo "template repo clone gave up after 600 seconds"; break; }
  sleep 5
done' >>/var/lib/blitz/repo-clone.log 2>&1 || true &

`;
  // ---- end TEMPLATES-V2 repo cloner ----

  const sshPublicKeyDeclaration = sshPublicKey === undefined
    ? ""
    : `readonly SSH_PUBLIC_KEY=${shellQuote(sshPublicKey)}\n`;
  // No key supplied PRESERVES whatever the volume already carries, and only
  // creates the file when it is missing. `/var/lib/blitz` is the mounted
  // volume by the time this runs, so the truncation this replaced destroyed
  // the member's own access every time a machine was re-provisioned without a
  // key — including machines whose key arrived through the retired
  // workspace-level field, which have no other copy of it. The bind mount
  // still needs the file to exist, hence the create-if-absent.
  const sshPublicKeyProvisioning = sshPublicKey === undefined
    ? String.raw`[ -e /var/lib/blitz/authorized_key ] || : >/var/lib/blitz/authorized_key
chown root:root /var/lib/blitz/authorized_key
chmod 0644 /var/lib/blitz/authorized_key
`
    : String.raw`printf '%s\n' "$SSH_PUBLIC_KEY" >/var/lib/blitz/authorized_key
chown root:root /var/lib/blitz/authorized_key
chmod 0644 /var/lib/blitz/authorized_key
`;

  return String.raw`#!/bin/bash
set -Eeuo pipefail

${sshPublicKeyDeclaration}readonly PHONE_HOME_URL=${shellQuote(options.phoneHomeUrl)}
readonly CONTROL_PLANE_ORIGIN=${shellQuote(controlPlaneOrigin)}
readonly BOX_IMAGE_REF=${shellQuote(options.boxImageRef)}
readonly BOX_IMAGE_TAG=${shellQuote(options.boxImageTag)}
readonly BOX_IMAGE_SHA256=${shellQuote(options.boxImageSha256)}
readonly BOOTSTRAP_ERROR_MAX_BYTES=1006

bootstrap_error=""

sanitize_bootstrap_error() {
  printf '%s' "$1" |
    tr '\000-\037\177' ' ' |
    sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//' |
    LC_ALL=C cut -c 1-"$BOOTSTRAP_ERROR_MAX_BYTES"
}

report_bootstrap_failure() {
  local status="$1"
  local line="$2"
  local message
  trap - ERR
  message=${"${bootstrap_error:-bootstrap failed at line $line (exit $status)}"}
  message=$(sanitize_bootstrap_error "$message")
  if [ -z "$message" ]; then
    message="bootstrap failed at line $line (exit $status)"
  fi
  curl \
    --silent \
    --show-error \
    --max-time 15 \
    --request POST \
    --data-urlencode "bootstrap_error=$message" \
    --output /dev/null \
    "$PHONE_HOME_URL" || true
  exit "$status"
}

trap 'report_bootstrap_failure "$?" "$LINENO"' ERR

readonly BOOTSTRAP_LOG=/var/log/blitz-bootstrap.log
readonly DURABLE_BOOTSTRAP_LOG=/var/lib/blitz/bootstrap.log
touch "$BOOTSTRAP_LOG"
chmod 0600 "$BOOTSTRAP_LOG"
exec >>"$BOOTSTRAP_LOG" 2>&1

${BOX_IMAGE_SETUP_HELPERS}
fail() {
  bootstrap_error="$*"
  echo "blitz bootstrap failed: $*"
  return 1
}

export DEBIAN_FRONTEND=noninteractive
# A mirror can accept the TCP connection and then never answer. Without a
# timeout apt blocks forever, retry never sees a failure to act on, and the
# workspace sits in creating until the caller gives up instead of reporting an
# error. These timeouts turn that hang into a failure. Every provider needs
# them, so they stay here.
cat >/etc/apt/apt.conf.d/99blitz-acquire <<'APTCONF'
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
Acquire::Retries "2";
APTCONF
# Most boxes reach one mirror and have nothing to move to. The default repair
# therefore does nothing. A provider with a second mirror replaces this in the
# lines it contributes below.
apt_mirror_fallback() { :; }
${providerAptSetup}# A mirror that answers can still trickle at hundreds of KB/s. That passes
# every timeout and turns a 90-second install into a 20-minute hang. Cap each
# attempt and repair the sources between attempts. A stall is a failure, not a
# wait.
apt_watchdog() {
  local attempt
  for attempt in 1 2 3; do
    if timeout 360 apt-get "$@"; then return 0; fi
    echo "blitz: apt-get $1 failed or stalled (attempt $attempt); repairing the sources and retrying"
    apt_mirror_fallback
    dpkg --configure -a 2>/dev/null || true
    sleep 5
  done
  fail "apt-get $1 kept failing or stalling after 3 attempts"
}
# A golden image already carries docker and curl, and re-running apt on it
# changes nothing while costing about 36 seconds (measured 2026-08-27 on
# cx23@hel1: 18.3 s for update, 17.4 s for the install). A stock Ubuntu image
# has neither and takes the original path, so this is a skip, not a new
# dependency: the box never relies on the tools being pre-baked.
if command -v docker >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  echo "blitz: docker and curl are already installed; skipping apt"
else
  apt_watchdog update
  apt_watchdog install -y docker.io curl
fi

# Every phase marker carries seconds since the script started. Without these
# the only way to attribute boot time was subtraction, which turned every
# tuning decision into an estimate (tools/e2e/GAPS.md).
blitz_phase() { echo "blitz-phase: $1 seconds=$SECONDS"; }
${INOTIFY_SETUP}systemctl enable --now docker
blitz_phase apt-done

mkdir -p /var/lib/blitz
volume_device=""
for candidate in /dev/disk/by-id/scsi-0HC_Volume_*; do
  [ -e "$candidate" ] || continue
  volume_device=$(readlink -f "$candidate")
  break
done

if [ -n "$volume_device" ]; then
  blkid_status=0
  blkid "$volume_device" >/dev/null 2>&1 || blkid_status=$?
  case "$blkid_status" in
    0)
      ;;
    2)
      mkfs.ext4 -F "$volume_device"
      ;;
    *)
      fail "blkid failed for $volume_device with status $blkid_status"
      ;;
  esac

  if ! mountpoint -q /var/lib/blitz; then
    mount "$volume_device" /var/lib/blitz
  fi
  volume_uuid=$(blkid -s UUID -o value "$volume_device")
  [ -n "$volume_uuid" ] || fail "mounted volume has no UUID"
  fstab_entry="UUID=$volume_uuid /var/lib/blitz ext4 defaults,nofail 0 2"
  grep -Fqx "$fstab_entry" /etc/fstab || printf '%s\n' "$fstab_entry" >>/etc/fstab
fi

# The surface tokens on this volume were written by whatever VM last ran here,
# and on a re-provision its tunnel is already deleted. Drop the marker now --
# after the mount, before the box container starts -- so the guest's cloudflared
# waits for THIS instance's cloud-init to rewrite them instead of racing it and
# holding a dead credential for the life of the box (core/cloud-init.ts).
rm -f /var/lib/blitz/tokens-ready
blitz_phase volume-mounted
touch "$DURABLE_BOOTSTRAP_LOG"
chmod 0600 "$DURABLE_BOOTSTRAP_LOG"
cat "$BOOTSTRAP_LOG" >"$DURABLE_BOOTSTRAP_LOG"
exec > >(tee -a "$BOOTSTRAP_LOG" "$DURABLE_BOOTSTRAP_LOG" >/dev/null) 2>&1

cat >/usr/local/sbin/blitz-volume-shutdown <<'SHUTDOWN_HOOK'
#!/bin/sh
set -eu
sync
if mountpoint -q /var/lib/blitz; then
  umount /var/lib/blitz
fi
SHUTDOWN_HOOK
chmod 0755 /usr/local/sbin/blitz-volume-shutdown

cat >/etc/systemd/system/blitz-volume-shutdown.service <<'SHUTDOWN_UNIT'
[Unit]
Description=Flush and unmount the Blitz volume during ACPI shutdown
Before=docker.service umount.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
ExecStop=/usr/local/sbin/blitz-volume-shutdown

[Install]
WantedBy=multi-user.target
SHUTDOWN_UNIT
systemctl daemon-reload
systemctl enable --now blitz-volume-shutdown.service

mkdir -p /var/lib/blitz/workspace
${sshPublicKeyProvisioning}
# A retained volume belongs to the previous box identity. Its token family is
# revoked when that workspace is destroyed, and allowing the box init to see
# those files makes its register one-shot fail before sshd can start. The new
# credentials are installed after this VM proves its host key to phone-home.
rm -f /var/lib/blitz/box-credential.json /var/lib/blitz/origin

port_22_free() {
  ! ss -tln 2>/dev/null | grep -qE '(^|[^0-9.:])(0\.0\.0\.0|\[::\]|\*):22[[:space:]]'
}
# Ubuntu 24.04 activates sshd through ssh.socket on port 22. Validate the
# replacement listener before stopping that socket so Docker can safely claim
# host port 22 without losing the host SSH recovery path.
#
# A golden image has already made this move, and its sshd comes up on 2222 with
# ssh.socket masked. Stopping and restarting sshd there costs seconds and
# changes nothing, so the whole block is skipped when the invariant already
# holds: a listener on 2222 and nothing on 22.
if ss -tln 2>/dev/null | grep -qE ':2222[[:space:]]' && port_22_free; then
  echo "blitz: host sshd is already on 2222 and port 22 is free; skipping the move"
else
install -d -m 0755 /etc/ssh/sshd_config.d
# 00- sorts ahead of image drop-ins; sshd takes the first Port it sees.
cat >/etc/ssh/sshd_config.d/00-blitz.conf <<'SSHD_CONFIG'
Port 2222
SSHD_CONFIG
install -d -o root -g root -m 0755 /run/sshd
/usr/sbin/sshd -t
# Stop both units (a scanner-activated sshd holds the :22 fd itself), then
# mask the socket so no postinst or preset re-apply can put :22 back.
systemctl stop ssh.service ssh.socket 2>/dev/null || true
systemctl disable ssh.socket 2>/dev/null || true
systemctl mask ssh.socket
systemctl enable ssh
systemctl restart ssh
# Prove the move by behavior, not by config parsing: a listener on :2222 is
# the invariant every failure mode violates.
sshd_moved_deadline=$((SECONDS + 20))
until ss -tln 2>/dev/null | grep -qE ':2222[[:space:]]'; do
  if (( SECONDS >= sshd_moved_deadline )); then
    ss -tlnp 2>/dev/null || true
    ls -la /etc/ssh/sshd_config.d/ || true
    fail "host sshd never bound :2222 after the config move"
  fi
  sleep 1
done

# systemctl returns as soon as it has signalled the unit, not once the old
# listener has released the port. The box container binds host port 22, so
# racing ahead here makes docker run die with
# "failed to bind host port 0.0.0.0:22/tcp: address already in use" (exit 125)
# on whichever boots fast enough to lose the race. Wait for the port to be
# genuinely free, and say so plainly if it never is.
sshd_release_deadline=$((SECONDS + 60))
until port_22_free; do
  if (( SECONDS >= sshd_release_deadline )); then
    ss -tlnp 2>/dev/null | grep ':22 ' || true
    fail "host sshd still holds port 22 after 60s; the box container cannot bind it"
  fi
  sleep 1
done
fi
blitz_phase sshd-ready

${ZRAM_SETUP}${imageSetup}
blitz_phase box-image-ready
install -d -m 0755 /etc/blitz
${usageDirectories}# The one docker run for the box container, extracted to a host script so
# the initial start here and the host-side updater (blitz-box-update below)
# share one code path. Per-workspace values (hostname, env, mounts) are
# rendered in at create time; only the image ref varies between calls.
cat >/usr/local/bin/blitz-box-run <<'BOX_RUN'
#!/bin/bash
set -Eeuo pipefail
box_image=${"${1:?usage: blitz-box-run <image-ref>}"}
# The container env comes from the image about to start, never from the one
# that ran before it: an update picks up the new image's defaults and a
# rollback restores the old image's. Staged through a temp file so a failed
# read cannot truncate a working env file. A failure here is fatal under
# set -e, because a box image without this file is broken: the caller rolls back.
docker run --rm --entrypoint cat "$box_image" /etc/blitz/env.defaults >/etc/blitz/env.defaults.next
chmod 0644 /etc/blitz/env.defaults.next
mv /etc/blitz/env.defaults.next /etc/blitz/env.defaults
# Ceiling from this VM's own RAM; see bootstrap.ts for why. The limits file is
# optional: an operator or a load test writes it to override any default below.
limits_file=/etc/blitz/box-limits.env
[ -f "$limits_file" ] || : >"$limits_file"
. "$limits_file"
mem_total_mb=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 ))
host_reserve_mb=${"${BLITZ_HOST_RESERVE_MB:-512}"}
box_swap_mb=${"${BLITZ_BOX_SWAP_MB:-2048}"}
box_pids=${"${BLITZ_BOX_PIDS:-8192}"}
box_mem_mb=$(( mem_total_mb - host_reserve_mb ))
limit_flags=(--pids-limit "$box_pids")
if [ "$box_mem_mb" -ge 1024 ]; then
  limit_flags+=(--memory "$box_mem_mb"m --memory-swap $(( box_mem_mb + box_swap_mb ))m)
else
  echo "blitz-box-run: only $mem_total_mb MB total; starting without a memory ceiling" >&2
fi

docker run --detach \
  --name blitz-box \
${hostnameFlag}  --restart unless-stopped \
  --privileged \
  ${"${limit_flags[@]}"} \
  --env-file /etc/blitz/env.defaults \
  --env-file /etc/blitz/box-limits.env \
  -e BLITZ_UID=1000 \
  -e BLITZ_GID=1000 \
  --mount type=bind,src=/var/lib/blitz,dst=/var/lib/blitz \
  --mount type=bind,src=/var/lib/blitz/authorized_key,dst=/run/blitz/authorized_key,readonly \
  --mount type=bind,src=/var/lib/blitz/workspace,dst=/workspace \
${usageMounts}  -p 0.0.0.0:22:22 \
  "$box_image"
BOX_RUN
chmod 0755 /usr/local/bin/blitz-box-run
/usr/local/bin/blitz-box-run "$box_image"

health_deadline=$((SECONDS + 180))
box_healthy=false
while (( SECONDS < health_deadline )); do
  if [ "$(docker inspect --format '{{.State.Running}}' blitz-box 2>/dev/null || true)" = true ] &&
    docker exec blitz-box ssh-keyscan -T 2 -p 22 127.0.0.1 >/dev/null 2>&1 &&
    docker exec blitz-box test -s /var/lib/blitz/ssh/ssh_host_ed25519_key.pub; then
    box_healthy=true
    break
  fi
  sleep 3
done
[ "$box_healthy" = true ] || fail "box health timeout after 180 seconds"

${repoCloner}read_host_key() {
  local key_path="/var/lib/blitz/ssh/ssh_host_$1_key.pub"
  if [ -s "$key_path" ]; then
    sed -n '1p' "$key_path"
  fi
}

pub_key_ecdsa=$(read_host_key ecdsa)
pub_key_ed25519=$(read_host_key ed25519)
pub_key_rsa=$(read_host_key rsa)
[ -n "$pub_key_ed25519" ] || fail "box Ed25519 host public key is missing"

credential_tmp=$(mktemp /var/lib/blitz/.box-credential.XXXXXX)
trap 'rm -f "$credential_tmp"' EXIT
curl \
  --fail-with-body \
  --silent \
  --show-error \
  --retry 10 \
  --retry-all-errors \
  --retry-delay 3 \
  --request POST \
  --data-urlencode "pub_key_ecdsa=$pub_key_ecdsa" \
  --data-urlencode "pub_key_ed25519=$pub_key_ed25519" \
  --data-urlencode "pub_key_rsa=$pub_key_rsa" \
  --output "$credential_tmp" \
  "$PHONE_HOME_URL"
[ -s "$credential_tmp" ] || fail "phone-home returned an empty credential"
python3 - "$credential_tmp" <<'PYTHON'
import json
import sys

credential_path = sys.argv[1]
with open(credential_path, encoding="utf-8") as response_file:
    response = json.load(response_file)
credential = {
    "box_id": response["box_id"],
    "access_token": response["access_token"],
    "refresh_token": response["refresh_token"],
}
with open(credential_path, "w", encoding="utf-8") as credential_file:
    json.dump(credential, credential_file, separators=(",", ":"))
    credential_file.write("\n")
PYTHON
install -m 0600 -o 1000 -g 1000 "$credential_tmp" /var/lib/blitz/box-credential.json
chmod 0600 /var/lib/blitz/box-credential.json
printf '%s\n' "$CONTROL_PLANE_ORIGIN" >/var/lib/blitz/origin
chown 1000:1000 /var/lib/blitz/origin
chmod 0644 /var/lib/blitz/origin
rm -f "$credential_tmp"
trap - EXIT

# ---- host-side box updater (cloud-VM path only) ----
# The box container never upgrades in place on its own, and nothing inside it
# can reach the host docker daemon, so the updater has to live here on the VM
# host. It polls the control plane with the box credential (host root reads
# /var/lib/blitz/box-credential.json), refreshes /var/lib/blitz/origin on
# every poll — the gateway re-reads that file per request, so a domain move
# no longer strands the box — and replaces the container only when the
# workspace's update flag is set, because a replacement kills every process
# inside it. The microVM provider (packages/microvm-host/) has its own guest
# lifecycle and never runs this. The payloads are the box-config contract,
# pinned by packages/schema/fixtures/box-config/.
cat >/usr/local/sbin/blitz-box-update <<'BOX_UPDATER'
#!/bin/bash
set -Eeuo pipefail

readonly STATE_DIR=/var/lib/blitz
readonly ORIGIN_PATH="$STATE_DIR/origin"
readonly CREDENTIAL_PATH="$STATE_DIR/box-credential.json"
readonly UPDATE_LOG="$STATE_DIR/box-update.log"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$UPDATE_LOG"
}

# A box that has not registered yet has neither file; that is the normal
# pre-enrollment state, not an error.
[ -s "$CREDENTIAL_PATH" ] || exit 0
[ -s "$ORIGIN_PATH" ] || exit 0
current_origin=$(sed -n '1p' "$ORIGIN_PATH")
[ -n "$current_origin" ] || exit 0

access_token=$(python3 - "$CREDENTIAL_PATH" <<'CREDENTIAL_READER'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as credential_file:
    value = json.load(credential_file)
token = value.get("access_token") if isinstance(value, dict) else None
if not isinstance(token, str) or token == "":
    raise SystemExit("box credential has no access_token")
sys.stdout.write(token)
CREDENTIAL_READER
) || { log "skip: box credential is unreadable"; exit 0; }

config_tmp=$(mktemp "$STATE_DIR/.box-config.XXXXXX")
result_tmp=$(mktemp "$STATE_DIR/.box-update-result.XXXXXX")
trap 'rm -f "$config_tmp" "$result_tmp"' EXIT

if ! curl --fail --silent --show-error --max-time 30 \
    --header "Authorization: Bearer $access_token" \
    --header "Accept: application/json" \
    --output "$config_tmp" \
    "$current_origin/workspaces/self/box-config"; then
  log "poll failed: $current_origin/workspaces/self/box-config did not answer"
  exit 0
fi

parsed=$(python3 - "$config_tmp" <<'BOX_CONFIG_PARSER'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as config_file:
    value = json.load(config_file)
if not isinstance(value, dict):
    raise ValueError("box-config must be an object")
ref = value.get("boxImageRef")
origin = value.get("controlPlaneOrigin")
update_requested = value.get("updateRequested")
if not isinstance(ref, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*", ref) is None:
    raise ValueError("box-config boxImageRef is invalid")
if not isinstance(origin, str) or re.fullmatch(r"https?://[A-Za-z0-9.-]+(:[0-9]+)?", origin) is None:
    raise ValueError("box-config controlPlaneOrigin is not an origin")
if not isinstance(update_requested, bool):
    raise ValueError("box-config updateRequested must be a boolean")
print(f"{ref}\t{origin}\t{'true' if update_requested else 'false'}")
BOX_CONFIG_PARSER
) || { log "poll rejected: box-config response failed validation"; exit 0; }
IFS=$'\t' read -r next_ref next_origin update_requested <<<"$parsed"

# Origin refresh, every poll. Safe with no restart: the gateway re-reads the
# file per request. This closes the stale-origin outage class for new boxes.
if [ "$next_origin" != "$current_origin" ]; then
  origin_tmp=$(mktemp "$STATE_DIR/.origin.XXXXXX")
  printf '%s\n' "$next_origin" >"$origin_tmp"
  chown 1000:1000 "$origin_tmp"
  chmod 0644 "$origin_tmp"
  mv "$origin_tmp" "$ORIGIN_PATH"
  log "origin refreshed: the box gateway now trusts $next_origin"
fi

[ "$update_requested" = true ] || exit 0

report_result() {
  python3 - "$1" "$2" <<'RESULT_WRITER' >"$result_tmp"
import json
import sys

ref, outcome = sys.argv[1:]
json.dump({"ref": ref, "outcome": outcome}, sys.stdout, separators=(",", ":"))
RESULT_WRITER
  if curl --fail --silent --show-error --max-time 30 \
      --request POST \
      --header "Authorization: Bearer $access_token" \
      --header "Content-Type: application/json" \
      --data-binary @"$result_tmp" \
      --output /dev/null \
      "$next_origin/workspaces/self/box-update-result"; then
    log "reported outcome $2 for $1"
  else
    log "outcome report failed for $1 ($2); the update flag stays set until a report lands"
  fi
}

start_box() {
  # blitz-box-run owns the whole start, including refreshing the container env
  # from the image it is about to run.
  /usr/local/bin/blitz-box-run "$1" >>"$UPDATE_LOG" 2>&1 || return 1
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if [ "$(docker inspect --format '{{.State.Running}}' blitz-box 2>/dev/null || true)" = true ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

current_image=$(docker inspect --format '{{.Config.Image}}' blitz-box 2>/dev/null || true)
if [ "$next_ref" = "$current_image" ]; then
  log "update requested but the requested ref is already running; clearing the request"
  report_result "$next_ref" up-to-date
  exit 0
fi
case "$next_ref" in
  https://*)
    # Tarball pins ride the bootstrap's manifest download path, which this
    # updater does not carry. Report it so the flag clears.
    log "update refused: a tarball ref cannot be pulled in place"
    report_result "$next_ref" unsupported
    exit 0
    ;;
esac

log "update start: [$current_image] -> [$next_ref]"
# Pull FIRST: a failed pull must leave the old container running untouched.
if ! docker pull "$next_ref" >>"$UPDATE_LOG" 2>&1; then
  log "update failed: pull did not complete; the running container is untouched"
  report_result "$next_ref" pull-failed
  exit 0
fi
docker rm -f blitz-box >>"$UPDATE_LOG" 2>&1 || true
if start_box "$next_ref"; then
  log "update complete: blitz-box now runs [$next_ref]"
  report_result "$next_ref" updated
  exit 0
fi
log "update failed: the new container never reached running; rolling back to [$current_image]"
docker rm -f blitz-box >>"$UPDATE_LOG" 2>&1 || true
if [ -n "$current_image" ] && start_box "$current_image"; then
  log "rollback complete: blitz-box runs [$current_image] again"
  report_result "$next_ref" rolled-back
else
  log "rollback failed: no blitz-box container is running"
  report_result "$next_ref" start-failed
fi
BOX_UPDATER
chmod 0755 /usr/local/sbin/blitz-box-update

cat >/etc/systemd/system/blitz-box-update.service <<'BOX_UPDATE_SERVICE'
[Unit]
Description=Blitz box config poll and requested image update
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/blitz-box-update
BOX_UPDATE_SERVICE

cat >/etc/systemd/system/blitz-box-update.timer <<'BOX_UPDATE_TIMER'
[Unit]
Description=Poll the Blitz control plane for box config every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
BOX_UPDATE_TIMER
systemctl daemon-reload
systemctl enable --now blitz-box-update.timer
# ---- end host-side box updater ----

echo "blitz bootstrap: credential registration poke start outer_timeout_seconds=40 inner_timeout_seconds=30"
register_status=0
timeout --foreground --kill-after=5s 40s \
  docker exec \
    --user 1000:1000 \
    --env HOME=/var/lib/blitz/home \
    --env USER=blitz \
    blitz-box \
    timeout --foreground --kill-after=5s 30s \
    blitz-cred register ||
  {
    register_status=$?
    echo "blitz bootstrap: credential registration poke failed or timed out (exit $register_status); continuing bootstrap because registration poke is best-effort"
    true
  }
if (( register_status == 0 )); then
  echo "blitz bootstrap: credential registration poke complete"
fi

trap - ERR
echo "blitz bootstrap completed"
`;
}
