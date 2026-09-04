import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const updater = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-payload", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("blitz-payload file log", () => {
  it("is world-readable and rotates at one MiB while stderr remains intact", () => {
    const root = mkdtempSync(path.join(tmpdir(), "blitz-payload-log-"));
    temporaryDirectories.push(root);
    const payloadRoot = path.join(root, "opt/payload");
    const lodyRoot = path.join(root, "opt/lody");
    const stateRoot = path.join(root, "state");
    const payloadState = path.join(stateRoot, "payload");
    mkdirSync(path.join(payloadRoot, "baked"), { recursive: true });
    mkdirSync(path.join(lodyRoot, "baked"), { recursive: true });
    mkdirSync(payloadState, { recursive: true });
    writeFileSync(path.join(payloadRoot, "baked/payload-version"), "payload-v1\n");
    writeFileSync(path.join(lodyRoot, "baked/daemon-version"), "daemon-v1\n");
    writeFileSync(path.join(lodyRoot, "baked/daemon-protocol-version"), "7\n");
    symlinkSync("baked", path.join(payloadRoot, "current"));
    symlinkSync("baked", path.join(lodyRoot, "current"));
    const logPath = path.join(payloadState, "log");
    writeFileSync(logPath, Buffer.alloc(1024 * 1024, 120), { mode: 0o600 });
    chmodSync(payloadState, 0o700);

    const run = spawnSync(process.execPath, [updater], {
      encoding: "utf8",
      env: {
        ...process.env,
        BLITZ_STATE_DIR: stateRoot,
        BLITZ_PAYLOAD_ROOT: payloadRoot,
        BLITZ_PAYLOAD_STATE: payloadState,
        BLITZ_PAYLOAD_LODY_ROOT: lodyRoot,
        BLITZ_PAYLOAD_ONCE: "1",
      },
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("blitz-payload: idle (no control-plane origin)");
    expect(readFileSync(logPath, "utf8")).toBe(
      "blitz-payload: idle (no control-plane origin)\n",
    );
    expect(statSync(`${logPath}.1`).size).toBe(1024 * 1024);
    expect(statSync(logPath).mode & 0o777).toBe(0o644);
    expect(statSync(`${logPath}.1`).mode & 0o777).toBe(0o644);
    expect(statSync(payloadState).mode & 0o777).toBe(0o755);
  });
});
