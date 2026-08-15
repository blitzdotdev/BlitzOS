export interface BootstrapOptions {
  boxImageSha256: string;
  boxImageRef: string;
  boxImageTag: string;
  phoneHomeUrl: string;
  sshPublicKey?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildBootstrapScript(options: BootstrapOptions): string {
  const controlPlaneOrigin = new URL(options.phoneHomeUrl).origin;
  const isTarball = options.boxImageRef.startsWith("https://");
  const trimmedSshPublicKey = options.sshPublicKey?.trim();
  const sshPublicKey = trimmedSshPublicKey === "" ? undefined : trimmedSshPublicKey;
  if (isTarball && options.boxImageTag.trim() === "") {
    throw new Error("BOX_IMAGE_TAG is required when BOX_IMAGE_REF is an HTTPS URL");
  }
  if (isTarball && !/^[a-fA-F0-9]{64}$/u.test(options.boxImageSha256)) {
    throw new Error(
      "BOX_IMAGE_SHA256 must be a 64-character hexadecimal digest when BOX_IMAGE_REF is an HTTPS URL",
    );
  }

  const imageSetup = isTarball
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
    [ "$manifest_image_tag" = "$BOX_IMAGE_TAG" ] || fail "manifest imageTag does not match BOX_IMAGE_TAG"
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

  const sshPublicKeyDeclaration = sshPublicKey === undefined
    ? ""
    : `readonly SSH_PUBLIC_KEY=${shellQuote(sshPublicKey)}\n`;
  const sshPublicKeyProvisioning = sshPublicKey === undefined
    ? String.raw`: >/var/lib/blitz/authorized_key
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

retry() {
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

fail() {
  bootstrap_error="$*"
  echo "blitz bootstrap failed: $*"
  return 1
}

export DEBIAN_FRONTEND=noninteractive
retry apt-get update
retry apt-get install -y docker.io curl
systemctl enable --now docker

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

# Ubuntu 24.04 activates sshd through ssh.socket on port 22. Validate the
# replacement listener before stopping that socket so Docker can safely claim
# host port 22 without losing the host SSH recovery path.
install -d -m 0755 /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/blitz.conf <<'SSHD_CONFIG'
Port 2222
SSHD_CONFIG
install -d -o root -g root -m 0755 /run/sshd
/usr/sbin/sshd -t
systemctl disable --now ssh.socket
systemctl enable ssh
systemctl restart ssh

${imageSetup}
docker run --detach \
  --name blitz-box \
  --restart unless-stopped \
  --privileged \
  -e BLITZ_UID=1000 \
  -e BLITZ_GID=1000 \
  --mount type=bind,src=/var/lib/blitz,dst=/var/lib/blitz \
  --mount type=bind,src=/var/lib/blitz/authorized_key,dst=/run/blitz/authorized_key,readonly \
  --mount type=bind,src=/var/lib/blitz/workspace,dst=/workspace \
  -p 0.0.0.0:22:22 \
  "$box_image"

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

read_host_key() {
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

echo "blitz bootstrap: credential registration poke start outer_timeout_seconds=40 inner_timeout_seconds=30"
register_status=0
timeout --foreground --kill-after=5s 40s \
  docker exec \
    --user 1000:1000 \
    --env BLITZ_STATE_DIR=/var/lib/blitz \
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
