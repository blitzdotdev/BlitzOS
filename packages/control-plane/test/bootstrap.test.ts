import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boxHostname, buildBootstrapScript } from "../core/bootstrap.js";
import { buildUserData } from "../core/cloud-init.js";
import { AwsProvider } from "../core/compute/aws.js";
import { HetznerProvider } from "../core/compute/hetzner.js";
import {
  appRequest,
  appWithProviders,
  FakeProviders,
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
const AWS_APT_SETUP = new AwsProvider({
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
}).bootstrapAptSetup();
const phoneHomeFixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/phone-home/**/*.json",
  { eager: true, import: "default", query: "?raw" },
);

interface PhoneHomeFixtureDescriptor {
  contentType: string;
  body: string | Record<string, string>;
  expect: {
    canonicalKeys?: string[];
  };
}

function phoneHomeFixture(relativePath: string): PhoneHomeFixtureDescriptor {
  const suffix = `/phone-home/${relativePath}`;
  const source = Object.entries(phoneHomeFixtureSources)
    .find(([fixturePath]) => fixturePath.endsWith(suffix))?.[1];
  if (source === undefined) throw new Error(`missing phone-home fixture ${relativePath}`);
  return JSON.parse(source) as PhoneHomeFixtureDescriptor;
}

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

    expect(userData).toContain("apt_watchdog install -y docker.io curl");
    expect(userData).toContain("systemctl enable --now docker");
    expect(userData).toContain("/dev/disk/by-id/scsi-0HC_Volume_*");
    expect(userData).toContain("/var/lib/blitz/authorized_key");
    expect(userData).toContain("chmod 0644 /var/lib/blitz/authorized_key");
    expect(userData).toContain("install -d -o root -g root -m 0755 /run/sshd");
    expect(userData).toContain("systemctl stop ssh.service ssh.socket");
    expect(userData).toContain("systemctl mask ssh.socket");
    expect(userData).toContain("Port 2222");
    expect(userData).toContain("systemctl restart ssh");
    // A socket-activated sshd ignores Port directives, so the script proves
    // the move by behavior: a listener on :2222 must appear.
    expect(userData).toContain("host sshd never bound :2222");
    expect(userData).toContain(`readonly BOX_IMAGE_REF='${BOX_IMAGE_REF}'`);
    expect(userData).toContain('retry docker pull "$BOX_IMAGE_REF"');
    expect(userData).toContain("--privileged");
    expect(userData).toContain("--restart unless-stopped");
    expect(userData).toContain("--env-file /etc/blitz/env.defaults");
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
    const moveHostSsh = userData.indexOf("systemctl mask ssh.socket");
    const restartHostSsh = userData.indexOf("systemctl restart ssh");
    const runBox = userData.indexOf("docker run");
    expect(createSshRuntime).toBeGreaterThan(-1);
    expect(validateHostSsh).toBeGreaterThan(createSshRuntime);
    expect(moveHostSsh).toBeGreaterThan(validateHostSsh);
    expect(restartHostSsh).toBeGreaterThan(moveHostSsh);
    expect(moveHostSsh).toBeGreaterThan(-1);
    expect(runBox).toBeGreaterThan(moveHostSsh);
  });

  it.each([undefined, "", " \t\n"])(
    "omits cloud-init authorization and provisions an empty mounted key file when no public key is provided",
    (sshPublicKey) => {
      const userData = buildUserData(
        sshPublicKey,
        PHONE_HOME_URL,
        BOX_IMAGE_REF,
        undefined,
        "",
        "",
      );

      expect(userData).not.toContain("ssh_authorized_keys");
      expect(userData).not.toContain("SSH_PUBLIC_KEY");
      expect(userData).toContain(": >/var/lib/blitz/authorized_key");
      expect(userData).toContain("chown root:root /var/lib/blitz/authorized_key");
      expect(userData).toContain("chmod 0644 /var/lib/blitz/authorized_key");
      expect(userData).toContain(
        "src=/var/lib/blitz/authorized_key,dst=/run/blitz/authorized_key,readonly",
      );
      expect(userData).toContain('readonly PHONE_HOME_URL=');
    },
  );

  it("keeps the box container spec identical without an SSH key", () => {
    const keyed = registryUserData();
    const keyless = buildUserData(
      undefined,
      PHONE_HOME_URL,
      BOX_IMAGE_REF,
      undefined,
      "",
      "",
    );
    const containerSpec = (userData: string): string => {
      const start = userData.indexOf("docker run --detach");
      const end = userData.indexOf("\n\nhealth_deadline=", start);
      return userData.slice(start, end);
    };

    expect(containerSpec(keyless)).toBe(containerSpec(keyed));
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

  it("preserves pre-mount output and tees all later bootstrap output to the durable volume log", () => {
    const userData = registryUserData();

    const initialCapture = userData.indexOf('exec >>"$BOOTSTRAP_LOG" 2>&1');
    const apt = userData.indexOf("apt_watchdog update");
    const mount = userData.indexOf('mount "$volume_device" /var/lib/blitz');
    const durableCopy = userData.indexOf(
      'cat "$BOOTSTRAP_LOG" >"$DURABLE_BOOTSTRAP_LOG"',
    );
    const durableTee = userData.indexOf(
      'exec > >(tee -a "$BOOTSTRAP_LOG" "$DURABLE_BOOTSTRAP_LOG" >/dev/null) 2>&1',
    );

    expect(userData).toContain(
      "readonly DURABLE_BOOTSTRAP_LOG=/var/lib/blitz/bootstrap.log",
    );
    expect(userData).toContain('chmod 0600 "$BOOTSTRAP_LOG"');
    expect(userData).toContain('chmod 0600 "$DURABLE_BOOTSTRAP_LOG"');
    expect(initialCapture).toBeGreaterThan(-1);
    expect(apt).toBeGreaterThan(initialCapture);
    expect(mount).toBeGreaterThan(apt);
    expect(durableCopy).toBeGreaterThan(mount);
    expect(durableTee).toBeGreaterThan(durableCopy);
    expect(userData.indexOf("docker run", durableTee)).toBeGreaterThan(durableTee);
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

  it("replaces the reused-volume authorized key and preserves idempotent workspace creation", () => {
    const userData = registryUserData();

    const workspace = userData.indexOf("mkdir -p /var/lib/blitz/workspace");
    const replaceKey = userData.indexOf(
      `printf '%s\\n' "$SSH_PUBLIC_KEY" >/var/lib/blitz/authorized_key`,
    );
    const keyOwner = userData.indexOf(
      "chown root:root /var/lib/blitz/authorized_key",
      replaceKey,
    );
    const keyMode = userData.indexOf(
      "chmod 0644 /var/lib/blitz/authorized_key",
      keyOwner,
    );
    const run = userData.indexOf("docker run", keyMode);

    expect(workspace).toBeGreaterThan(-1);
    expect(replaceKey).toBeGreaterThan(workspace);
    expect(keyOwner).toBeGreaterThan(replaceKey);
    expect(keyMode).toBeGreaterThan(keyOwner);
    expect(run).toBeGreaterThan(keyMode);
    expect(userData).not.toMatch(
      /if[^\n]*\/var\/lib\/blitz\/authorized_key/u,
    );
  });

  it("clears stale box credentials before starting a reused-volume container", () => {
    const userData = registryUserData();

    const mount = userData.indexOf('mount "$volume_device" /var/lib/blitz');
    const clearCredential = userData.indexOf(
      "rm -f /var/lib/blitz/box-credential.json /var/lib/blitz/origin",
    );
    const run = userData.indexOf("docker run", clearCredential);

    expect(mount).toBeGreaterThan(-1);
    expect(clearCredential).toBeGreaterThan(mount);
    expect(run).toBeGreaterThan(clearCredential);
  });

  it("reinstalls and enables host SSH and volume-shutdown configuration on every bootstrap", () => {
    const userData = registryUserData();

    const hook = userData.indexOf(
      "cat >/usr/local/sbin/blitz-volume-shutdown <<'SHUTDOWN_HOOK'",
    );
    const hookMode = userData.indexOf(
      "chmod 0755 /usr/local/sbin/blitz-volume-shutdown",
      hook,
    );
    const unit = userData.indexOf(
      "cat >/etc/systemd/system/blitz-volume-shutdown.service <<'SHUTDOWN_UNIT'",
      hookMode,
    );
    const reload = userData.indexOf("systemctl daemon-reload", unit);
    const enableShutdown = userData.indexOf(
      "systemctl enable --now blitz-volume-shutdown.service",
      reload,
    );
    const sshDropIn = userData.indexOf(
      "cat >/etc/ssh/sshd_config.d/00-blitz.conf <<'SSHD_CONFIG'",
      enableShutdown,
    );
    const validateSsh = userData.indexOf("/usr/sbin/sshd -t", sshDropIn);
    const restartSsh = userData.indexOf("systemctl restart ssh", validateSsh);

    expect(hook).toBeGreaterThan(-1);
    expect(hookMode).toBeGreaterThan(hook);
    expect(unit).toBeGreaterThan(hookMode);
    expect(reload).toBeGreaterThan(unit);
    expect(enableShutdown).toBeGreaterThan(reload);
    expect(sshDropIn).toBeGreaterThan(enableShutdown);
    expect(validateSsh).toBeGreaterThan(sshDropIn);
    expect(restartSsh).toBeGreaterThan(validateSsh);
  });

  it("waits for box health before posting keys and installs credentials mode 0600", () => {
    const userData = registryUserData();
    const fixture = phoneHomeFixture("requests/valid/form-success.json");

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
    const requestEnd = userData.indexOf('"$PHONE_HOME_URL"', post);
    const requestFields = Array.from(
      userData.slice(post, requestEnd).matchAll(/--data-urlencode "([^=]+)=/gu),
      (match) => match[1],
    );
    expect(requestFields).toEqual(fixture.expect.canonicalKeys);
    expect(userData).toContain("chmod 0600 /var/lib/blitz/box-credential.json");
    expect(userData).toContain("/var/lib/blitz/origin");
    expect(userData).toContain("/var/log/blitz-bootstrap.log");
    expect(userData).toContain("set -Eeuo pipefail");
    expect(userData).toContain("chown 1000:1000 /var/lib/blitz/origin");
  });

  it("starts no remote-control session and no tmux server", () => {
    const userData = registryUserData();
    // Parked 2026-08-24. Bootstrap used to start a detached `blitz-rc` tmux
    // session for `claude remote-control`. That session created the box's
    // tmux server from a bare `docker exec` environment, so every later tab
    // inherited a hollow environment and fresh-workspace logins broke.
    // Bootstrap must now start no tmux server at all: the first session on
    // the box comes from blitz-term, which sets its own environment.
    expect(userData).not.toContain("blitz-rc");
    expect(userData).not.toContain("remote-control");
    expect(userData).not.toContain("tmux");
    expect(userData).not.toContain("term-3");
  });

  it("pokes registration after both enrollment files are installed with a bounded logged best-effort command", () => {
    const userData = registryUserData();

    const credential = userData.indexOf(
      'install -m 0600 -o 1000 -g 1000 "$credential_tmp" /var/lib/blitz/box-credential.json',
    );
    const origin = userData.indexOf(
      `printf '%s\\n' "$CONTROL_PLANE_ORIGIN" >/var/lib/blitz/origin`,
      credential,
    );
    const originMode = userData.indexOf(
      "chmod 0644 /var/lib/blitz/origin",
      origin,
    );
    const registerStart = userData.indexOf(
      'echo "blitz bootstrap: credential registration poke start outer_timeout_seconds=40 inner_timeout_seconds=30"',
      originMode,
    );
    const outerTimeout = userData.indexOf(
      "timeout --foreground --kill-after=5s 40s",
      registerStart,
    );
    const dockerExec = userData.indexOf("docker exec", outerTimeout);
    const containerUser = userData.indexOf("--user 1000:1000", dockerExec);
    const homeEnv = userData.indexOf(
      "--env HOME=/var/lib/blitz/home",
      containerUser,
    );
    const userEnv = userData.indexOf("--env USER=blitz", homeEnv);
    const container = userData.indexOf("blitz-box", userEnv);
    const innerTimeout = userData.indexOf(
      "timeout --foreground --kill-after=5s 30s",
      container,
    );
    const register = userData.indexOf("blitz-cred register", innerTimeout);
    const completed = userData.indexOf('echo "blitz bootstrap completed"');
    const registerBlock = userData.slice(registerStart, completed);

    expect(credential).toBeGreaterThan(-1);
    expect(origin).toBeGreaterThan(credential);
    expect(originMode).toBeGreaterThan(origin);
    expect(registerStart).toBeGreaterThan(originMode);
    expect(outerTimeout).toBeGreaterThan(registerStart);
    expect(dockerExec).toBeGreaterThan(outerTimeout);
    expect(containerUser).toBeGreaterThan(dockerExec);
    expect(homeEnv).toBeGreaterThan(containerUser);
    expect(userEnv).toBeGreaterThan(homeEnv);
    expect(container).toBeGreaterThan(userEnv);
    expect(innerTimeout).toBeGreaterThan(container);
    expect(register).toBeGreaterThan(innerTimeout);
    expect(completed).toBeGreaterThan(register);
    expect(registerBlock).toContain(
      "credential registration poke",
    );
    expect(registerBlock).toContain(
      "continuing bootstrap because registration poke is best-effort",
    );
    expect(registerBlock).not.toContain("watch will retry");
    expect(userData.slice(register, completed)).toMatch(/\|\|[\s\S]*true/u);
  });

  // ---- box update path (blitz-box-run + host updater) ----
  // The docker run for the box container is emitted as /usr/local/bin/
  // blitz-box-run so create and update share one code path; the host-side
  // updater and its 5-minute timer poll GET /workspaces/self/box-config with
  // the box credential. See core/box-config.ts and the box-config fixtures.

  it("extracts the box container start into blitz-box-run and boots through it", () => {
    const userData = registryUserData();

    const write = userData.indexOf("cat >/usr/local/bin/blitz-box-run <<'BOX_RUN'");
    const run = userData.indexOf("docker run --detach", write);
    const mode = userData.indexOf("chmod 0755 /usr/local/bin/blitz-box-run", run);
    const start = userData.indexOf('/usr/local/bin/blitz-box-run "$box_image"', mode);
    const health = userData.indexOf("health_deadline=", start);
    expect(write).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(write);
    expect(mode).toBeGreaterThan(run);
    expect(start).toBeGreaterThan(mode);
    expect(health).toBeGreaterThan(start);
    // The script takes the image as its one argument; nothing else varies
    // between the initial start and an update.
    expect(userData).toContain("box_image=${1:?usage: blitz-box-run <image-ref>}");
  });

  it("installs the host-side updater with its timer after enrollment lands", () => {
    const userData = registryUserData();

    const originInstall = userData.indexOf(
      `printf '%s\\n' "$CONTROL_PLANE_ORIGIN" >/var/lib/blitz/origin`,
    );
    const updater = userData.indexOf("cat >/usr/local/sbin/blitz-box-update <<'BOX_UPDATER'");
    const service = userData.indexOf("cat >/etc/systemd/system/blitz-box-update.service", updater);
    const timer = userData.indexOf("cat >/etc/systemd/system/blitz-box-update.timer", service);
    const enable = userData.indexOf("systemctl enable --now blitz-box-update.timer", timer);
    const poke = userData.indexOf("credential registration poke start", enable);
    expect(originInstall).toBeGreaterThan(-1);
    expect(updater).toBeGreaterThan(originInstall);
    expect(service).toBeGreaterThan(updater);
    expect(timer).toBeGreaterThan(service);
    expect(enable).toBeGreaterThan(timer);
    expect(poke).toBeGreaterThan(enable);
    expect(userData).toContain("OnUnitActiveSec=5min");
    expect(userData).toContain('"$current_origin/workspaces/self/box-config"');
    expect(userData).toContain("/workspaces/self/box-update-result");
    // The log path resolves to /var/lib/blitz/box-update.log at run time.
    expect(userData).toContain("readonly STATE_DIR=/var/lib/blitz");
    expect(userData).toContain('UPDATE_LOG="$STATE_DIR/box-update.log"');
  });

  it("orders the updater's swap pull-first with a rollback start", () => {
    const userData = registryUserData();

    // Origin refresh happens on every poll, before the update gate.
    const refresh = userData.indexOf('mv "$origin_tmp" "$ORIGIN_PATH"');
    const gate = userData.indexOf('[ "$update_requested" = true ] || exit 0');
    const pull = userData.indexOf('docker pull "$next_ref"', gate);
    const remove = userData.indexOf("docker rm -f blitz-box", pull);
    const startNew = userData.indexOf('if start_box "$next_ref"; then', remove);
    const rollback = userData.indexOf('start_box "$current_image"', startNew);
    expect(refresh).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(refresh);
    expect(pull).toBeGreaterThan(gate);
    expect(remove).toBeGreaterThan(pull);
    expect(startNew).toBeGreaterThan(remove);
    expect(rollback).toBeGreaterThan(startNew);
  });

  it("reports bootstrap failures to the capability with only a bounded bootstrap_error field", () => {
    const userData = registryUserData();
    const fixture = phoneHomeFixture("requests/valid/form-failure.json");
    const failureReporter = userData.match(
      /report_bootstrap_failure\(\) \{\n(?<body>[\s\S]*?)\n\}/u,
    );

    expect(failureReporter?.groups?.body).toBeDefined();
    const body = failureReporter?.groups?.body ?? "";
    expect(userData).toContain("readonly BOOTSTRAP_ERROR_MAX_BYTES=1006");
    expect(userData).toContain(`trap 'report_bootstrap_failure "$?" "$LINENO"' ERR`);
    expect(userData.indexOf("trap 'report_bootstrap_failure")).toBeLessThan(
      userData.indexOf("apt_watchdog update"),
    );
    expect(body).toContain('message=$(sanitize_bootstrap_error "$message")');
    expect(body).toContain('--data-urlencode "bootstrap_error=$message"');
    expect(body).toContain('"$PHONE_HOME_URL"');
    expect(
      Array.from(body.matchAll(/--data-urlencode "([^=]+)=/gu), (match) => match[1]),
    ).toEqual(fixture.expect.canonicalKeys);
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

  it("keys archive image setup only to image availability on the current daemon", () => {
    const imageUrl = "https://cp.example/box-image";
    const userData = buildUserData(
      SSH_PUBLIC_KEY,
      PHONE_HOME_URL,
      imageUrl,
      undefined,
      BOX_IMAGE_TAG,
      BOX_IMAGE_SHA256,
    );

    const inspectGuard = userData.indexOf(
      'if ! docker image inspect "$BOX_IMAGE_TAG" >/dev/null 2>&1; then',
    );
    const download = userData.indexOf('download "$BOX_IMAGE_REF" "$image_archive"');
    const load = userData.indexOf('gunzip -c "$image_archive" | docker load');
    const guardEnd = userData.indexOf("\nfi\n", load);
    const provenPresent = userData.indexOf(
      'docker image inspect "$BOX_IMAGE_TAG" >/dev/null',
      guardEnd + 1,
    );
    const run = userData.indexOf("docker run", provenPresent);

    expect(inspectGuard).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(inspectGuard);
    expect(load).toBeGreaterThan(download);
    expect(guardEnd).toBeGreaterThan(load);
    expect(provenPresent).toBeGreaterThan(guardEnd);
    expect(run).toBeGreaterThan(provenPresent);
    expect(userData.slice(inspectGuard, provenPresent)).not.toMatch(
      /(?:if|elif)[^\n]*\/var\/lib\/blitz/u,
    );
  });

  it("keys registry image setup only to image availability on the current daemon", () => {
    const userData = registryUserData();

    const inspectGuard = userData.indexOf(
      'if ! docker image inspect "$BOX_IMAGE_REF" >/dev/null 2>&1; then',
    );
    const pull = userData.indexOf('retry docker pull "$BOX_IMAGE_REF"');
    const guardEnd = userData.indexOf("\nfi\n", pull);
    const provenPresent = userData.indexOf(
      'docker image inspect "$BOX_IMAGE_REF" >/dev/null',
      guardEnd + 1,
    );
    const run = userData.indexOf("docker run", provenPresent);

    expect(inspectGuard).toBeGreaterThan(-1);
    expect(pull).toBeGreaterThan(inspectGuard);
    expect(guardEnd).toBeGreaterThan(pull);
    expect(provenPresent).toBeGreaterThan(guardEnd);
    expect(run).toBeGreaterThan(provenPresent);
    expect(userData.slice(inspectGuard, provenPresent)).not.toMatch(
      /(?:if|elif)[^\n]*\/var\/lib\/blitz/u,
    );
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

  it("emits the template repo cloner as a detached best-effort loop outside the container spec", () => {
    const base = {
      boxImageSha256: "",
      boxImageRef: BOX_IMAGE_REF,
      boxImageTag: "",
      phoneHomeUrl: PHONE_HOME_URL,
      sshPublicKey: SSH_PUBLIC_KEY,
    };
    const script = buildBootstrapScript({
      ...base,
      repos: ["blitzdotdev/blitz-core", "acme/tools"],
    });

    expect(script).toContain(
      'echo "blitz bootstrap: template repo cloner starting in the background (best-effort)"',
    );
    expect(script).toContain(
      "[ -d /workspace/blitz-core/.git ] || git clone https://github.com/blitzdotdev/blitz-core /workspace/blitz-core || cloned=false",
    );
    expect(script).toContain(
      "[ -d /workspace/tools/.git ] || git clone https://github.com/acme/tools /workspace/tools || cloned=false",
    );
    // One nohup'd docker exec running the retry loop as the blitz user: 5s
    // interval, 10-minute deadline, || true overall, logged under
    // /var/lib/blitz/ — a failed clone never fails the boot.
    expect(script).toContain("deadline=$(( $(date +%s) + 600 ))");
    expect(script).toContain("sleep 5");
    expect(script).toContain(
      "done' >>/var/lib/blitz/repo-clone.log 2>&1 || true &",
    );
    const cloner = script.indexOf("template repo cloner starting");
    const clonerExec = script.indexOf("nohup docker exec", cloner);
    const clonerUser = script.indexOf("--user 1000:1000", clonerExec);
    expect(cloner).toBeGreaterThan(script.indexOf('[ "$box_healthy" = true ]'));
    expect(cloner).toBeLessThan(script.indexOf("read_host_key()"));
    expect(clonerExec).toBeGreaterThan(cloner);
    expect(clonerUser).toBeGreaterThan(clonerExec);

    // The container spec itself is untouched: the segment lives after the
    // health wait, never inside the docker run block.
    const runStart = script.indexOf("docker run --detach");
    const runEnd = script.indexOf("\n\nhealth_deadline=", runStart);
    expect(script.slice(runStart, runEnd)).not.toContain("git clone");

    // No repos — explicitly byte-identical to the pinned ordinary create,
    // whether the field is absent or an empty list.
    const plain = buildBootstrapScript(base);
    expect(plain).not.toContain("git clone");
    expect(plain).not.toContain("repo-clone.log");
    expect(buildBootstrapScript({ ...base, repos: [] })).toBe(plain);

    // The emitter is the shell-interpolation boundary: anything that is not
    // owner/name shaped is refused outright, never quoted around.
    expect(() => buildBootstrapScript({ ...base, repos: ["bad'; rm -rf /'"] }))
      .toThrow("template repo is not owner/name shaped");
  });

  // ---- Remote Control target name ----
  // Claude 2.1.228 registers its Remote Control environment with two readable
  // strings. `machine_name` is always `os.hostname()`. `directory` is always
  // `/workspace`. No flag overrides either one. Docker gives the box the
  // container id as its hostname, which is hex. Every workspace then reads
  // the same in claude.ai/code. A real container proved `--hostname`: it
  // changes `os.hostname()`, and it survives the service launch chain.

  it("names the box container so each workspace is a distinct Remote Control target", () => {
    const base = {
      boxImageSha256: "",
      boxImageRef: BOX_IMAGE_REF,
      boxImageTag: "",
      phoneHomeUrl: PHONE_HOME_URL,
      sshPublicKey: SSH_PUBLIC_KEY,
    };
    const script = buildBootstrapScript({ ...base, boxHostname: "design-partner" });

    expect(script).toContain("  --hostname 'design-partner' \\\n");
    // The flag belongs to the box container spec, not to any earlier docker
    // call in the script.
    const runStart = script.indexOf("docker run --detach");
    const runEnd = script.indexOf("\n\nhealth_deadline=", runStart);
    expect(script.slice(runStart, runEnd)).toContain("--hostname");
    expect(script.slice(0, runStart)).not.toContain("--hostname");

    // Absent name: the pre-hostname bytes, exactly.
    const plain = buildBootstrapScript(base);
    expect(plain).not.toContain("--hostname");
    expect(plain).toContain(`docker run --detach \\
  --name blitz-box \\
  --restart unless-stopped \\`);

    // The emitter is the shell-interpolation boundary: anything that is not
    // one DNS label is refused outright, never quoted around.
    for (const bad of ["bad'; rm -rf /", "", "-lead", "trail-", "UPPER", "a".repeat(64)]) {
      expect(() => buildBootstrapScript({ ...base, boxHostname: bad }))
        .toThrow("box hostname is not a DNS label");
    }
  });

  it.each([
    ["Design Partner", "design-partner"],
    ["Blitz OS v2.0!", "blitz-os-v2-0"],
    ["  Anoop's AEC harness!  ", "anoop-s-aec-harness"],
    ["bad'; rm -rf /'", "bad-rm--rf"],
    ["`$(id)`;", "id"],
    ["a".repeat(80), "a".repeat(63)],
    [`${"a".repeat(62)} b`, "a".repeat(62)],
  ])("turns the workspace name %j into the box hostname %j", (name, expected) => {
    const label = boxHostname(name, "workspace-id");

    expect(label).toBe(expected);
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
  });

  it("falls back to the workspace id when the name leaves no label", () => {
    // A workspace can carry a name with no Latin letters at all. An empty
    // `--hostname` must never reach the shell, so the id takes over.
    for (const name of ["研究ワークスペース", "Ωμέγα", "  ", "!!!"]) {
      expect(boxHostname(name, "d3f7a1c2-0000-4000-8000-abcdefabcdef"))
        .toBe("d3f7a1c2-0000-4000-8000-abcdefabcdef");
    }
  });

  it("carries the created workspace's own name into its box hostname", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const create = async (name: string): Promise<{ id: string; userData: string }> => {
      const response = await appRequest(app, "/workspaces", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ machineTypeId: "small", name }),
      });
      expect(response.status).toBe(201);
      const { workspace } = await response.json<{ workspace: { id: string } }>();
      return { id: workspace.id, userData: providers.userData.get(workspace.id) ?? "" };
    };

    const first = await create("Design Partner");
    const second = await create("Anoop's AEC Harness");
    expect(first.userData).toContain("  --hostname 'design-partner' \\\n");
    expect(second.userData).toContain("  --hostname 'anoop-s-aec-harness' \\\n");

    // A name with no Latin letters still boots: the id is the label.
    const third = await create("研究ワークスペース");
    expect(third.userData).toContain(`  --hostname '${third.id}' \\\n`);
  });

  // ---- provider bootstrap seam (plans/PROVIDER-BOOTSTRAP.md) ----
  // AWS-only mirror lines used to sit in the shared script. On a Hetzner box
  // the grep matched nothing, exited 1, and `set -Eeuo pipefail` killed the
  // boot at line 84. Every non-AWS create failed.

  it("emits no other provider's setup lines when the provider contributes none", () => {
    const script = buildBootstrapScript({
      boxImageSha256: "",
      boxImageRef: BOX_IMAGE_REF,
      boxImageTag: "",
      phoneHomeUrl: PHONE_HOME_URL,
      sshPublicKey: SSH_PUBLIC_KEY,
    });

    expect(script).not.toMatch(/ec2/iu);
    expect(script).not.toContain("archive.ubuntu.com");
    // The watchdog calls this between attempts. Undefined would exit 127.
    expect(script).toContain("apt_mirror_fallback() { :; }");
    expect(script).toContain("apt_watchdog update");
    // Hetzner needs nothing extra, so it declares nothing.
    expect(new HetznerProvider("test-token").bootstrapAptSetup).toBeUndefined();
  });

  it("splices the provider's setup between the apt tuning and the watchdog", () => {
    const base = {
      boxImageSha256: "",
      boxImageRef: BOX_IMAGE_REF,
      boxImageTag: "",
      phoneHomeUrl: PHONE_HOME_URL,
      sshPublicKey: SSH_PUBLIC_KEY,
    };
    const script = buildBootstrapScript({
      ...base,
      providerAptSetup: "provider_only_line\n",
    });

    expect(script).toContain("\nprovider_only_line\n");
    expect(script.indexOf("provider_only_line")).toBeGreaterThan(
      script.indexOf("Acquire::Retries"),
    );
    expect(script.indexOf("provider_only_line")).toBeLessThan(
      script.indexOf("apt_watchdog() {"),
    );
    // Absent and empty are the same script, so no create grows bytes it does
    // not use.
    expect(buildBootstrapScript({ ...base, providerAptSetup: "" })).toBe(
      buildBootstrapScript(base),
    );
  });

  it("carries the AWS mirror probe and its fallback into an AWS box's script", () => {
    const script = buildBootstrapScript({
      boxImageSha256: "",
      boxImageRef: BOX_IMAGE_REF,
      boxImageTag: "",
      phoneHomeUrl: PHONE_HOME_URL,
      sshPublicKey: SSH_PUBLIC_KEY,
      providerAptSetup: AWS_APT_SETUP,
    });

    expect(script).toContain(
      `if ec2_mirror=$(grep -rhoE 'https?://[a-z0-9-]+\\.ec2\\.archive\\.ubuntu\\.com' \\
  /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | head -1) &&
  ! curl -fsS -m 10 -o /dev/null "$ec2_mirror/ubuntu/dists/noble/InRelease"; then`,
    );
    expect(script).toContain(
      'echo "blitz: $ec2_mirror is unreachable; falling back to archive.ubuntu.com"',
    );
    expect(script).toContain(`apt_mirror_fallback() {
  sed -i -E 's|https?://[a-z0-9-]+\\.ec2\\.archive\\.ubuntu\\.com|http://archive.ubuntu.com|g' \\
    /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null || true
}`);
    // The provider's own definition wins: it is emitted after the default.
    expect(script.indexOf("apt_mirror_fallback() { :; }")).toBeLessThan(
      script.indexOf("apt_mirror_fallback() {\n"),
    );
  });

  it("asks the provider that owns the machine type for its bootstrap lines", async () => {
    class ContributingProviders extends FakeProviders {
      bootstrapAptSetup(): string {
        return "provider_only_line\n";
      }
    }
    const providers = new ContributingProviders();
    const app = appWithProviders(providers, providers);
    const cookie = await operatorSession(app);
    const response = await app.request(
      "https://cp.example/workspaces",
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ machineTypeId: "small", sshPublicKey: SSH_PUBLIC_KEY }),
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
    expect(providers.userData.get(workspace.workspace.id)).toContain(
      "\nprovider_only_line\n",
    );
  });

  it("creates a workspace with no EC2 text when the provider contributes none", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const response = await app.request(
      "https://cp.example/workspaces",
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ machineTypeId: "small", sshPublicKey: SSH_PUBLIC_KEY }),
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
    expect(providers.userData.get(workspace.workspace.id)).not.toMatch(/ec2/iu);
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
    const headers = init?.headers ?? {};
    expect(Object.keys(headers)).toEqual(["Authorization", "Content-Type"]);
    expect("Content-Type" in headers).toBe(true);
    expect(JSON.stringify(headers)).toBe(
      '{"Authorization":"Bearer test-token","Content-Type":"application/json"}',
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      labels: {
        "blitz-workspace": "workspace-id",
        "blitz-purpose": "workspace",
      },
    });
  });
});
