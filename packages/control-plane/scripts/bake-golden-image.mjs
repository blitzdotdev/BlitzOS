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
 * It prints the entry to add to HETZNER_SERVER_IMAGES. It creates one builder
 * VM and always deletes it, including on failure.
 */
import { boxImageSetupScript } from "../dist/core/bootstrap.js";

const API = "https://api.hetzner.cloud/v1";
const POLL_INTERVAL_MS = 5_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;

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

fail() { echo "bake failed: $*"; exit 1; }

apt-get update
apt-get install -y docker.io curl
systemctl enable --now docker

mkdir -p /var/lib/blitz
${boxImageSetupScript(image)}
echo "bake: box image present as $box_image"

# Nothing below this line may survive into a workspace's identity.
systemctl stop docker
rm -rf /var/lib/blitz/.bootstrap-image.* /var/log/blitz-bake.log
cloud-init clean --logs --seed
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
rm -rf /root/.ssh /home/*/.ssh /var/log/cloud-init*.log
sync

# The marker is the only thing the bake adds beyond the tools and the image.
printf '%s\\n' ${JSON.stringify(image.boxImageTag || image.boxImageRef)} > /etc/blitz-golden-image
shutdown -h now
`;
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
          "blitz-box-image": (image.boxImageTag || "ref").slice(0, 63),
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
