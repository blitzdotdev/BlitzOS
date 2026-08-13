import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUserData } from "../core/cloud-init.js";
import { HetznerProvider } from "../core/providers/hetzner.js";
import {
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
} from "./helpers.js";

const SSH_PUBLIC_KEY = "ssh-ed25519 AAAAC3Nzatest caller's laptop";
const PHONE_HOME_URL =
  "https://cp.example/workspaces/workspace-id/phone-home/capability-token";
const BOX_IMAGE_REF = `ghcr.io/blitzdotdev/blitz-box@sha256:${"a".repeat(64)}`;
const BOX_IMAGE_TAG = "blitz-box:release";
const BOX_IMAGE_SHA256 = "b".repeat(64);

function registryUserData(callerUserData?: string): string {
  return buildUserData(
    SSH_PUBLIC_KEY,
    PHONE_HOME_URL,
    BOX_IMAGE_REF,
    callerUserData,
    "",
    "",
  );
}

describe("production VM bootstrap", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates the ordered host and box bootstrap without cloud-init phone_home", () => {
    const userData = registryUserData();

    expect(userData).toContain("retry apt-get install -y docker.io curl");
    expect(userData).toContain("systemctl enable --now docker");
    expect(userData).toContain("/dev/disk/by-id/scsi-0HC_Volume_*");
    expect(userData).toContain("/var/lib/blitz/authorized_key");
    expect(userData).toContain("chmod 0644 /var/lib/blitz/authorized_key");
    expect(userData).toContain("install -d -o root -g root -m 0755 /run/sshd");
    expect(userData).toContain("systemctl disable --now ssh.socket");
    expect(userData).toContain("Port 2222");
    expect(userData).toContain("systemctl restart ssh");
    expect(userData).toContain(`readonly BOX_IMAGE_REF='${BOX_IMAGE_REF}'`);
    expect(userData).toContain('retry docker pull "$BOX_IMAGE_REF"');
    expect(userData).toContain("--privileged");
    expect(userData).toContain("--restart unless-stopped");
    expect(userData).toContain("-e BLITZ_UID=1000");
    expect(userData).toContain("-e BLITZ_GID=1000");
    expect(userData).toContain("src=/var/lib/blitz,dst=/var/lib/blitz");
    expect(userData).toContain("src=/var/lib/blitz/workspace,dst=/workspace");
    expect(userData).toContain(
      "src=/var/lib/blitz/authorized_key,dst=/run/blitz/authorized_key,readonly",
    );
    expect(userData).toContain("-p 0.0.0.0:22:22");
    expect(userData).not.toContain(":7443");
    expect(userData).not.toContain(":7444");
    expect(userData).not.toContain(":7445");
    expect(userData).not.toMatch(/^phone_home:/mu);

    const createSshRuntime = userData.indexOf(
      "install -d -o root -g root -m 0755 /run/sshd",
    );
    const validateHostSsh = userData.indexOf("/usr/sbin/sshd -t");
    const moveHostSsh = userData.indexOf("systemctl disable --now ssh.socket");
    const restartHostSsh = userData.indexOf("systemctl restart ssh");
    const runBox = userData.indexOf("docker run");
    expect(createSshRuntime).toBeGreaterThan(-1);
    expect(validateHostSsh).toBeGreaterThan(createSshRuntime);
    expect(moveHostSsh).toBeGreaterThan(validateHostSsh);
    expect(restartHostSsh).toBeGreaterThan(moveHostSsh);
    expect(moveHostSsh).toBeGreaterThan(-1);
    expect(runBox).toBeGreaterThan(moveHostSsh);
  });

  it("formats a volume only for blkid's blank-device status and mounts idempotently", () => {
    const userData = registryUserData();

    expect(userData).toMatch(
      /blkid_status=\$\?[\s\S]*?case "\$blkid_status" in[\s\S]*?2\)[\s\S]*?mkfs\.ext4/du,
    );
    expect(userData).toMatch(/0\)[\s\S]*?;;[\s\S]*?2\)/du);
    expect(userData).toContain("mountpoint -q /var/lib/blitz");
    expect(userData).toContain('grep -Fqx "$fstab_entry" /etc/fstab');
  });

  it("installs a guest systemd shutdown hook that syncs and cleanly unmounts the Blitz volume", () => {
    const userData = registryUserData();

    expect(userData).toContain("/usr/local/sbin/blitz-volume-shutdown");
    expect(userData).toContain("/etc/systemd/system/blitz-volume-shutdown.service");
    expect(userData).toContain("Before=docker.service umount.target");
    expect(userData).toContain("ExecStop=/usr/local/sbin/blitz-volume-shutdown");
    expect(userData).toContain("systemctl enable --now blitz-volume-shutdown.service");
    expect(userData).toContain("mountpoint -q /var/lib/blitz");
    expect(userData).toContain("umount /var/lib/blitz");

    const hook = userData.indexOf("/usr/local/sbin/blitz-volume-shutdown");
    const sync = userData.indexOf("sync", hook);
    const unmount = userData.indexOf("umount /var/lib/blitz", sync);
    const runBox = userData.indexOf("docker run", unmount);
    expect(hook).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(hook);
    expect(unmount).toBeGreaterThan(sync);
    expect(runBox).toBeGreaterThan(unmount);
  });

  it("waits for box health before posting keys and installs credentials mode 0600", () => {
    const userData = registryUserData();

    const wait = userData.indexOf("health_deadline=$((SECONDS + 180))");
    const running = userData.indexOf("docker inspect", wait);
    const sshAnswer = userData.indexOf("ssh-keyscan", wait);
    const hostKeys = userData.indexOf("/var/lib/blitz/ssh", wait);
    const post = userData.indexOf("--request POST", wait);
    const credential = userData.indexOf("/var/lib/blitz/box-credential.json", post);
    expect(wait).toBeGreaterThan(-1);
    expect(running).toBeGreaterThan(wait);
    expect(sshAnswer).toBeGreaterThan(running);
    expect(hostKeys).toBeGreaterThan(running);
    expect(post).toBeGreaterThan(sshAnswer);
    expect(credential).toBeGreaterThan(post);
    expect(userData).toContain("pub_key_ecdsa");
    expect(userData).toContain("pub_key_ed25519");
    expect(userData).toContain("pub_key_rsa");
    expect(userData).toContain("chmod 0600 /var/lib/blitz/box-credential.json");
    expect(userData).toContain("/var/lib/blitz/origin");
    expect(userData).toContain("/var/log/blitz-bootstrap.log");
    expect(userData).toContain("set -Eeuo pipefail");
    expect(userData).toContain("chown 1000:1000 /var/lib/blitz/origin");
  });

  it("reports bootstrap failures to the capability with only a bounded bootstrap_error field", () => {
    const userData = registryUserData();
    const failureReporter = userData.match(
      /report_bootstrap_failure\(\) \{\n(?<body>[\s\S]*?)\n\}/u,
    );

    expect(failureReporter?.groups?.body).toBeDefined();
    const body = failureReporter?.groups?.body ?? "";
    expect(userData).toContain("readonly BOOTSTRAP_ERROR_MAX_BYTES=1006");
    expect(userData).toContain(`trap 'report_bootstrap_failure "$?" "$LINENO"' ERR`);
    expect(userData.indexOf("trap 'report_bootstrap_failure")).toBeLessThan(
      userData.indexOf("retry apt-get update"),
    );
    expect(body).toContain('message=$(sanitize_bootstrap_error "$message")');
    expect(body).toContain('--data-urlencode "bootstrap_error=$message"');
    expect(body).toContain('"$PHONE_HOME_URL"');
    expect(
      Array.from(body.matchAll(/--data-urlencode "([^=]+)=/gu), (match) => match[1]),
    ).toEqual(["bootstrap_error"]);
    expect(userData).toContain(
      'LC_ALL=C cut -c 1-"$BOOTSTRAP_ERROR_MAX_BYTES"',
    );
  });

  it("persists exactly the three broker credential fields", () => {
    const userData = registryUserData();
    const projection = userData.match(
      /credential = \{\n(?<fields>(?:    "[^"]+": response\["[^"]+"\],\n)+)\}/u,
    );

    expect(projection?.groups?.fields).toBeDefined();
    const fields = Array.from(
      (projection?.groups?.fields ?? "").matchAll(/^    "([^"]+)":/gmu),
      (match) => match[1],
    );
    expect(fields).toEqual(["box_id", "access_token", "refresh_token"]);
    expect(userData).toContain(
      'with open(credential_path, "w", encoding="utf-8") as credential_file:',
    );
    expect(userData.indexOf("credential = {")).toBeLessThan(
      userData.indexOf(
        "install -m 0600 -o 1000 -g 1000 \"$credential_tmp\" /var/lib/blitz/box-credential.json",
      ),
    );
  });

  it("preserves caller user-data as the unchanged first MIME part", () => {
    const callerUserData = `#cloud-config
write_files:
  - path: /tmp/caller-owned
    content: |
      punctuation: ' " $ \\ #
`;
    const userData = buildUserData(
      SSH_PUBLIC_KEY,
      PHONE_HOME_URL,
      BOX_IMAGE_REF,
      callerUserData,
      "",
      "",
    );

    expect(userData).toMatch(/^Content-Type: multipart\/mixed; boundary="blitz-/u);
    expect(userData).toContain(
      `Content-Type: text/cloud-config; charset="utf-8"\n\n${callerUserData}`,
    );
    expect(userData.indexOf(callerUserData)).toBeLessThan(
      userData.indexOf("#!/bin/bash"),
    );
  });

  it("downloads, verifies, and loads a direct gzip archive before running its configured tag", () => {
    const imageUrl = "https://cp.example/box-image";
    const userData = buildUserData(
      SSH_PUBLIC_KEY,
      PHONE_HOME_URL,
      imageUrl,
      undefined,
      BOX_IMAGE_TAG,
      BOX_IMAGE_SHA256,
    );

    expect(userData).toContain(`readonly BOX_IMAGE_REF='${imageUrl}'`);
    expect(userData).toContain(`readonly BOX_IMAGE_TAG='${BOX_IMAGE_TAG}'`);
    expect(userData).toContain(`readonly BOX_IMAGE_SHA256='${BOX_IMAGE_SHA256}'`);
    expect(userData).toContain('curl --fail --location --retry 10 --retry-all-errors');
    expect(userData).toContain('verify_sha256 "$image_archive" "$BOX_IMAGE_SHA256"');
    expect(userData).toContain('gunzip -c "$image_archive" | docker load');
    expect(userData).toContain('"$BOX_IMAGE_TAG"');
    expect(userData).not.toContain('docker pull "$BOX_IMAGE_REF"');

    const download = userData.indexOf('download "$BOX_IMAGE_REF" "$image_archive"');
    const checksum = userData.indexOf('verify_sha256 "$image_archive" "$BOX_IMAGE_SHA256"');
    const load = userData.indexOf('gunzip -c "$image_archive" | docker load');
    const run = userData.indexOf("docker run", load);
    expect(download).toBeGreaterThan(-1);
    expect(checksum).toBeGreaterThan(download);
    expect(load).toBeGreaterThan(checksum);
    expect(run).toBeGreaterThan(load);
  });

  it("validates multipart manifest parts, total digest, and image tag before loading", () => {
    const manifestUrl = "https://cp.example/box-image/manifest.json";
    const userData = buildUserData(
      SSH_PUBLIC_KEY,
      PHONE_HOME_URL,
      manifestUrl,
      undefined,
      BOX_IMAGE_TAG,
      BOX_IMAGE_SHA256,
    );

    expect(userData).toContain('download "$BOX_IMAGE_REF" "$manifest_path"');
    expect(userData).toContain('value.get("parts")');
    expect(userData).toContain('value.get("totalSha256")');
    expect(userData).toContain('value.get("imageTag")');
    expect(userData).toContain('download "$manifest_base/$part_name" "$part_path"');
    expect(userData).toContain('verify_sha256 "$part_path" "$part_sha256"');
    expect(userData).toContain('cat "$part_path" >>"$image_archive"');
    expect(userData).toContain('verify_sha256 "$image_archive" "$manifest_total_sha256"');
    expect(userData).toContain('verify_sha256 "$image_archive" "$BOX_IMAGE_SHA256"');
    expect(userData).toContain('[ "$manifest_image_tag" = "$BOX_IMAGE_TAG" ]');
    expect(userData).toContain('gunzip -c "$image_archive" | docker load');
    expect(userData).not.toContain('docker pull "$BOX_IMAGE_REF"');
  });

  it("rejects an HTTPS image configuration without a load tag and archive digest", () => {
    expect(() =>
      buildUserData(
        SSH_PUBLIC_KEY,
        PHONE_HOME_URL,
        "https://cp.example/box-image",
      ),
    ).toThrow("BOX_IMAGE_TAG is required");
    expect(() =>
      buildUserData(
        SSH_PUBLIC_KEY,
        PHONE_HOME_URL,
        "https://cp.example/box-image",
        undefined,
        BOX_IMAGE_TAG,
        "not-a-digest",
      ),
    ).toThrow("BOX_IMAGE_SHA256 must be a 64-character hexadecimal digest");
  });

  it("streams the single image and named image parts from R2 without authentication", async () => {
    const { app } = harness();
    await env.BOX_IMAGES.put("box-image", "single archive", {
      httpMetadata: { contentType: "application/gzip" },
    });
    await env.BOX_IMAGES.put("box-image/manifest.json", '{"parts":[]}', {
      httpMetadata: { contentType: "application/json" },
    });

    const single = await appRequest(app, "/box-image");
    expect(single.status).toBe(200);
    expect(single.headers.get("content-type")).toBe("application/gzip");
    expect(single.headers.get("etag")).toMatch(/^".+"$/u);
    expect(new TextDecoder().decode(await single.arrayBuffer())).toBe("single archive");

    const partial = await appRequest(app, "/box-image", {
      headers: { Range: "bytes=0-5" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 0-5/14");
    expect(new TextDecoder().decode(await partial.arrayBuffer())).toBe("single");

    const notModified = await appRequest(app, "/box-image", {
      headers: { "If-None-Match": single.headers.get("etag") ?? "" },
    });
    expect(notModified.status).toBe(304);

    const manifest = await appRequest(app, "/box-image/manifest.json");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/json");
    expect(await manifest.text()).toBe('{"parts":[]}');

    const missing = await appRequest(app, "/box-image/missing-part");
    expect(missing.status).toBe(404);
  });

  it("injects the configured image through workspace creation instead of the fake default", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const response = await app.request(
      "https://cp.example/workspaces",
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          machineTypeId: "small",
          sshPublicKey: SSH_PUBLIC_KEY,
        }),
      },
      {
        DB: env.DB,
        BOX_IMAGES: env.BOX_IMAGES,
        BOX_IMAGE_REF,
        BOX_IMAGE_TAG,
        BOX_IMAGE_SHA256,
      },
    );
    expect(response.status).toBe(201);
    const workspace = await response.json<{ workspace: { id: string } }>();
    const userData = providers.userData.get(workspace.workspace.id);
    expect(userData).toContain(BOX_IMAGE_REF);
    expect(userData).toContain(BOX_IMAGE_TAG);
    expect(userData).toContain(BOX_IMAGE_SHA256);
    expect(userData).not.toContain(env.BOX_IMAGE_REF);
  });

  it("adds dedicated workspace labels to Hetzner's create request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        server: {
          id: 42,
          public_net: { ipv4: { ip: "203.0.113.42" } },
        },
      }),
    );
    const provider = new HetznerProvider("test-token");

    await provider.createVm({
      workspaceId: "workspace-id",
      machineTypeId: "cx23@fsn1",
      sshPublicKey: SSH_PUBLIC_KEY,
      phoneHomeUrl: PHONE_HOME_URL,
      userData: "#cloud-config",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      labels: {
        "blitz-workspace": "workspace-id",
        "blitz-purpose": "workspace",
      },
    });
  });
});
