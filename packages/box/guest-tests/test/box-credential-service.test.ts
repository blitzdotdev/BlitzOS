import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const runScript = fileURLToPath(
  new URL("../../rootfs/etc/s6-overlay/s6-rc.d/box-credential/run", import.meta.url),
);
const temporaryDirectories: string[] = [];

function writeExecutable(filePath: string, source: string): void {
  writeFileSync(filePath, source, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("box-credential service", () => {
  it("repairs both shared files before refreshing as blitz", () => {
    const root = mkdtempSync(path.join(tmpdir(), "box-credential-service-"));
    temporaryDirectories.push(root);
    const stateDir = path.join(root, "state");
    const bin = path.join(root, "bin");
    const chownLog = path.join(root, "chown.log");
    const refreshLog = path.join(root, "refresh.log");
    mkdirSync(stateDir);
    mkdirSync(bin);
    const credential = path.join(stateDir, "box-credential.json");
    const lock = path.join(stateDir, "box-credential.lock");
    writeFileSync(credential, "credential\n");
    writeFileSync(lock, "");
    const currentUid = statSync(credential).uid;
    const currentGid = statSync(credential).gid;
    const expectedUid = currentUid + 1;
    const expectedGid = currentGid + 1;
    writeExecutable(
      path.join(bin, "chown"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$BLITZ_TEST_CHOWN_LOG\"\n",
    );
    writeExecutable(
      path.join(bin, "s6-setuidgid"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$BLITZ_TEST_REFRESH_LOG\"\n",
    );
    writeExecutable(path.join(bin, "sleep"), "#!/bin/sh\nexit 99\n");

    const result = spawnSync("bash", [runScript], {
      encoding: "utf8",
      timeout: 3000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        BLITZ_STATE_DIR: stateDir,
        BLITZ_UID: String(expectedUid),
        BLITZ_GID: String(expectedGid),
        BLITZ_CREDENTIAL_REFRESH_ONCE: "1",
        BLITZ_TEST_CHOWN_LOG: chownLog,
        BLITZ_TEST_REFRESH_LOG: refreshLog,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(chownLog, "utf8").trim().split("\n")).toEqual([
      `${expectedUid}:${expectedGid} ${credential}`,
      `${expectedUid}:${expectedGid} ${lock}`,
    ]);
    expect(readFileSync(refreshLog, "utf8")).toBe(
      "blitz /usr/local/libexec/blitz-credential-refresh\n",
    );
    expect(result.stdout).toContain(
      `box-credential: repaired box-credential.json ownership (was ${currentUid}:${currentGid})`,
    );
    expect(result.stdout).toContain(
      `box-credential: repaired box-credential.lock ownership (was ${currentUid}:${currentGid})`,
    );
  });
});
