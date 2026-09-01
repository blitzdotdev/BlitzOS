/**
 * Bakes a Hetzner golden image: a snapshot that already carries docker, curl
 * and the box image, so a workspace VM skips that work on first boot.
 *
 * Measured on cx23@hel1 on 2026-08-27, the work this removes costs 18.3 s for
 * `apt-get update`, 17.4 s for `apt-get install docker.io`, and about 58 s to
 * download and load the box image. The snapshot itself bills at $0.0199 per GB
 * each month, once for the whole fleet.
 *
 * Usage:
 *   npm run build --workspace @blitzos/control-plane
 *   node scripts/bake-golden-image.mjs --location hel1 [--server-type cx23]
 *
 * Environment: HETZNER_API_TOKEN, BOX_IMAGE_REF, BOX_IMAGE_TAG,
 * BOX_IMAGE_SHA256 — the same values the deployed Worker holds.
 *
 * It prints the entry to add to HETZNER_SERVER_IMAGES, but only after booting
 * a throwaway probe from the finished snapshot and proving the image is there.
 * It creates one builder VM and one probe VM, and always deletes both,
 * including on failure.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOX_IMAGE_INSTALLER,
  BOX_IMAGE_SETUP_HELPERS,
  boxImageSetupScript,
} from "../dist/core/bootstrap.js";

const API = "https://api.hetzner.cloud/v1";
const POLL_INTERVAL_MS = 5_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
// The port the bake moves sshd to. Reaching the probe here, and not on 22, is
// itself the check that lever 1 survived into the snapshot.
const GOLDEN_SSH_PORT = 2222;

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  const value = process.argv[index + 1];
  if (value === undefined) throw new Error(`--${name} needs a value`);
  return value;
}

/**
 * A Hetzner label value is at most 63 characters and must start and end with
 * an alphanumeric, with only `-`, `_` and `.` between. A mode-B image tag such
 * as `blitz-box:86277e36` carries a colon, which the API rejects outright with
 * "invalid input in field 'labels'" — and the snapshot is then never taken,
 * after the builder has already done all thirty minutes of its work.
 */
function hetznerLabelValue(value) {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 63);
  return cleaned.replace(/^[^A-Za-z0-9]+/u, "").replace(/[^A-Za-z0-9]+$/u, "");
}

async function hetzner(token, path, init) {
  const headers = { Authorization: `Bearer ${token}` };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API}${path}`, { ...init, headers });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Hetzner ${path}: ${message}`);
  }
  return body;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The builder's cloud-init.
 *
 * It installs the tools, loads the box image through the SAME emitted bash a
 * workspace uses, then strips every identity the snapshot must not carry. A
 * clone that keeps a machine id or a host SSH key would hand two workspaces
 * one identity, and cloud-init would refuse to run again on the clone.
 *
 * It never starts the box container and never holds a workspace credential:
 * the builder only fills a docker store.
 */
function builderUserData(image) {
  return `#!/bin/bash
set -Eeuo pipefail
exec > >(tee -a /var/log/blitz-bake.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
export BOX_IMAGE_REF=${JSON.stringify(image.boxImageRef)}
export BOX_IMAGE_TAG=${JSON.stringify(image.boxImageTag)}
export BOX_IMAGE_SHA256=${JSON.stringify(image.boxImageSha256)}

# Without this the builder can die mid-script and simply never power off, and
# the bake waits for a shutdown that cannot come. Fail loudly, then stop, so a
# broken bake costs two minutes instead of thirty.
trap 'echo "bake: FAILED at line $LINENO"; shutdown -h now' ERR

# The emitted image setup calls these. Without them the setup dies on a
# "retry: command not found", and set -e stops the builder where it stands.
${BOX_IMAGE_SETUP_HELPERS}${BOX_IMAGE_INSTALLER}
apt-get update
apt-get install -y docker.io curl
systemctl enable --now docker

mkdir -p /var/lib/blitz
${boxImageSetupScript(image)}
echo "bake: box image present as $box_image"

# Lever 1: make the sshd move here, once, instead of on every workspace boot.
# The bootstrap skips its own move when a listener is already on 2222 and port
# 22 is free, so a workspace on this image pays none of the stop/restart cost.
install -d -m 0755 /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/00-blitz.conf <<'SSHD_CONFIG'
Port 2222
SSHD_CONFIG
# The config test below refuses with "Missing privilege separation directory:
# /run/sshd" when that directory is absent, and whether it is absent is a race:
# /run is a tmpfs and /run/sshd is made by ssh.service's startup, not at boot.
# Ubuntu 24.04 socket-activates sshd, so on a builder nobody has dialed 22 and
# ssh.service may never have run. The identical script baked 426576280 green on
# 2026-08-31 and then killed 426673356 here on 2026-09-01. Creating it is
# idempotent, so the bake stops depending on which way the race fell.
install -d -m 0755 /run/sshd
/usr/sbin/sshd -t
systemctl disable ssh.socket 2>/dev/null || true
systemctl mask ssh.socket
systemctl enable ssh

# Lever 2: units a workspace never uses, and which cost seconds of every boot.
# \`|| true\` throughout: an absent unit is not a bake failure.
for unit in snapd.service snapd.socket snapd.seeded.service unattended-upgrades.service \
            multipathd.service multipathd.socket apt-daily.timer apt-daily-upgrade.timer \
            motd-news.timer man-db.timer e2scrub_all.timer fstrim.timer; do
  systemctl disable --now "$unit" 2>/dev/null || true
done

# Root's password is expired on a Hetzner image built without an SSH key, and a
# snapshot freezes that state. PAM then refuses every key-based login, so the
# host cannot be debugged. Lock the password instead: no password login, no
# expiry, keys still work.
usermod -p '*' root
chage -I -1 -m 0 -M 99999 -E -1 root
# Undoing the expiry once is not enough: cloud-init runs again on every clone
# and re-expires root, because the Ubuntu cloud image defaults to
# a chpasswd expire default. Turning that default off is what survives.
install -d -m 0755 /etc/cloud/cloud.cfg.d
cat >/etc/cloud/cloud.cfg.d/99-blitz-no-expire.cfg <<'CLOUDCFG'
chpasswd:
  expire: false
CLOUDCFG

# Nothing below this line may survive into a workspace's identity.
systemctl stop docker

# Lever 3: Hetzner bills and materializes a snapshot by its used size, and a
# faster materialization is a faster create. The box image dominates the 2.6 GB
# and cannot shrink, so this only reclaims what the build itself left behind.
apt-get clean
rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /var/cache/*
journalctl --vacuum-size=1M 2>/dev/null || true
rm -rf /var/lib/blitz/.bootstrap-image.* /var/log/blitz-bake.log
cloud-init clean --logs --seed
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
rm -rf /root/.ssh /home/*/.ssh /var/log/cloud-init*.log
sync

# The marker is the only thing the bake adds beyond the tools and the image.
printf '%s\\n' ${JSON.stringify(image.boxImageTag || image.boxImageRef)} > /etc/blitz-golden-image
# Zero the free space last so the snapshot carries no deleted blocks.
fstrim -av 2>/dev/null || true
sync
shutdown -h now
`;
}

/**
 * Runs one ssh command on the probe, and reports rather than throws: the boot
 * poll below calls this while the host is still coming up, and a refused
 * connection is not yet a failure.
 */
function ssh(keyPath, ip, command) {
  const result = spawnSync("ssh", [
    "-i", keyPath,
    "-p", String(GOLDEN_SSH_PORT),
    "-l", "root",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    // The bake deletes the host keys so every clone generates its own, and
    // there is no fingerprint to pin in advance. This is a throwaway host we
    // created seconds ago, from our own image, to read one line back.
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    ip, command,
  ], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Boots a throwaway probe from the finished snapshot and proves it is usable.
 *
 * A bake can pass every step it already checks and still ship a snapshot no
 * workspace can boot. The builder powers itself off, so a docker store that
 * never received the image, an sshd that did not move, and a root account left
 * expired all snapshot exactly as quietly as a good build does. The first
 * broken image was caught only by booting a workspace on it by hand.
 *
 * Each check is a lever the bake pulled:
 *
 * - Reaching sshd on 2222, and not on 22, is lever 1.
 * - Logging in with a key at all is the root-password expiry fix. That is the
 *   defect that made snapshot 425047509 undebuggable.
 * - `docker image inspect` is the SAME guard a workspace's bootstrap runs. If
 *   it passes there, the workspace skips the download, which is the whole
 *   point of a golden image.
 */
async function verifySnapshot(token, imageId, location, serverType, deadline) {
  const keyDir = mkdtempSync(join(tmpdir(), "blitz-golden-probe-"));
  const keyPath = join(keyDir, "id_ed25519");
  execFileSync("ssh-keygen", [
    "-t", "ed25519", "-N", "", "-q", "-C", "blitz-golden-probe", "-f", keyPath,
  ]);
  let keyId;
  let serverId;
  try {
    keyId = (await hetzner(token, "/ssh_keys", {
      method: "POST",
      body: JSON.stringify({
        name: `blitz-golden-probe-${imageId}`,
        public_key: readFileSync(`${keyPath}.pub`, "utf8").trim(),
        labels: { "blitz-purpose": "golden-probe" },
      }),
    })).ssh_key.id;

    console.log(`bake: probing snapshot ${imageId} with a ${serverType}@${location}`);
    serverId = (await hetzner(token, "/servers", {
      method: "POST",
      body: JSON.stringify({
        name: `blitz-golden-probe-${location}`,
        server_type: serverType,
        image: imageId,
        location,
        ssh_keys: [keyId],
        labels: { "blitz-purpose": "golden-probe" },
      }),
    })).server.id;

    let ip = null;
    while (ip === null) {
      if (Date.now() > deadline) throw new Error(`probe ${serverId} never reached running`);
      await sleep(POLL_INTERVAL_MS);
      const server = (await hetzner(token, `/servers/${serverId}`)).server;
      if (server.status === "running") ip = server.public_net?.ipv4?.ip ?? null;
    }

    // Reachability and the check are separate steps on purpose. Retrying the
    // real check until the deadline would turn "the image is missing" — an
    // answer available on the first attempt — into a thirty-minute hang.
    let reachable = false;
    let lastError = "no ssh response";
    while (Date.now() <= deadline) {
      const attempt = ssh(keyPath, ip, "true");
      if (attempt.status === 0) {
        reachable = true;
        break;
      }
      lastError = attempt.stderr.trim() || `ssh exit ${attempt.status}`;
      await sleep(POLL_INTERVAL_MS);
    }
    if (!reachable) {
      throw new Error(
        `snapshot ${imageId}: nothing answered on ${ip}:${GOLDEN_SSH_PORT} before the `
        + `deadline. A golden box that refuses a key login is the root-password `
        + `expiry this bake clears. Last error: ${lastError}`,
      );
    }

    // Read the image name back out of the marker rather than passing it in, so
    // the probe checks what was baked and cannot drift from it.
    const checked = ssh(keyPath, ip, [
      "set -e",
      "test -s /etc/blitz-golden-image",
      'docker image inspect "$(cat /etc/blitz-golden-image)" >/dev/null',
      'echo "holds $(cat /etc/blitz-golden-image)"',
    ].join("; "));
    if (checked.status !== 0) {
      throw new Error(
        `snapshot ${imageId} booted but failed its check: `
        + (checked.stderr.trim() || checked.stdout.trim() || `ssh exit ${checked.status}`).slice(0, 400),
      );
    }
    console.log(`bake: probe ${checked.stdout.trim()}`);
  } finally {
    rmSync(keyDir, { recursive: true, force: true });
    if (serverId !== undefined) {
      await hetzner(token, `/servers/${serverId}`, { method: "DELETE" })
        .then(() => console.log(`bake: probe ${serverId} deleted`))
        .catch((error) => console.error(`bake: probe ${serverId} NOT deleted: ${error.message}`));
    }
    if (keyId !== undefined) {
      await hetzner(token, `/ssh_keys/${keyId}`, { method: "DELETE" })
        .catch((error) => console.error(`bake: probe key ${keyId} NOT deleted: ${error.message}`));
    }
  }
}

async function main() {
  const token = requireEnv("HETZNER_API_TOKEN");
  const image = {
    boxImageRef: requireEnv("BOX_IMAGE_REF"),
    boxImageTag: process.env.BOX_IMAGE_TAG ?? "",
    boxImageSha256: process.env.BOX_IMAGE_SHA256 ?? "",
  };
  const location = argument("location");
  const serverType = argument("server-type", "cx23");
  const deadline = Date.now() + BUILD_TIMEOUT_MS;

  console.log(`bake: builder ${serverType}@${location} for ${image.boxImageRef}`);
  const created = await hetzner(token, "/servers", {
    method: "POST",
    body: JSON.stringify({
      name: `blitz-golden-builder-${location}`,
      server_type: serverType,
      image: "ubuntu-24.04",
      location,
      user_data: builderUserData(image),
      labels: { "blitz-purpose": "golden-builder" },
    }),
  });
  const serverId = created.server.id;
  console.log(`bake: builder ${serverId} created; waiting for it to finish and power off`);

  try {
    let status = "running";
    while (status !== "off") {
      if (Date.now() > deadline) throw new Error("builder never powered off");
      await sleep(POLL_INTERVAL_MS);
      status = (await hetzner(token, `/servers/${serverId}`)).server.status;
    }
    console.log("bake: builder is off; taking the snapshot");

    const snapshot = await hetzner(token, `/servers/${serverId}/actions/create_image`, {
      method: "POST",
      body: JSON.stringify({
        type: "snapshot",
        description: `blitz-box ${image.boxImageTag || image.boxImageRef} (${location})`,
        labels: {
          "blitz-purpose": "golden-image",
          "blitz-box-image": hetznerLabelValue(image.boxImageTag || "ref"),
        },
      }),
    });
    const imageId = snapshot.image.id;

    let imageStatus = snapshot.image.status;
    while (imageStatus !== "available") {
      if (Date.now() > deadline) throw new Error(`snapshot ${imageId} never became available`);
      await sleep(POLL_INTERVAL_MS);
      imageStatus = (await hetzner(token, `/images/${imageId}`)).image.status;
    }

    await verifySnapshot(token, imageId, location, serverType, deadline).catch((error) => {
      // The snapshot stays: it is the evidence, and nothing pins it, because
      // the id is printed only below and only on success. Name the command
      // that removes it so it does not sit there billing quietly.
      console.error(`bake: snapshot ${imageId} did not pass its probe.`);
      console.error(`bake: delete it with`);
      console.error(`  curl -X DELETE -H "Authorization: Bearer $HETZNER_API_TOKEN" ${API}/images/${imageId}`);
      throw error;
    });

    const details = (await hetzner(token, `/images/${imageId}`)).image;
    const sizeGb = details.image_size ?? 0;
    console.log("");
    console.log(`bake: snapshot ${imageId} is available`);
    console.log(`bake: ${sizeGb} GB, architecture ${details.architecture}`);
    console.log(`bake: about $${(sizeGb * 0.0199).toFixed(2)} per month`);
    console.log("");
    console.log("Add this entry to HETZNER_SERVER_IMAGES:");
    console.log(`  ${location}=${imageId}`);
  } finally {
    // The builder has done its job either way, and it bills by the hour.
    await hetzner(token, `/servers/${serverId}`, { method: "DELETE" })
      .then(() => console.log(`bake: builder ${serverId} deleted`))
      .catch((error) => console.error(`bake: builder ${serverId} NOT deleted: ${error.message}`));
  }
}

main().catch((error) => {
  console.error(`bake: ${error.message}`);
  process.exitCode = 1;
});
