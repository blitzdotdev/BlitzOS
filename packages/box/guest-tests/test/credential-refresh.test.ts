import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** Drives the real `blitz-credential-refresh` one-shot with only blitz-cred
 * replaced. The stand-in records its argv, proving the script delegates token
 * validity and rotation to the broker instead of growing a second refresh
 * implementation. */

const scriptPath = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-credential-refresh", import.meta.url),
);

interface RefreshBox {
  root: string;
  stateDir: string;
  binDir: string;
  callsPath: string;
}

const boxes: string[] = [];

afterEach(() => {
  for (const directory of boxes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeBox(): RefreshBox {
  const root = mkdtempSync(join(tmpdir(), "credential-refresh-"));
  boxes.push(root);
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const binDir = join(root, "stub-bin");
  mkdirSync(binDir);
  const credBin = join(binDir, "blitz-cred");
  const callsPath = join(root, "calls");
  writeFileSync(
    credBin,
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >>"$BLITZ_CRED_CALLS"\nexit "$BLITZ_CRED_STATUS"\n',
  );
  chmodSync(credBin, 0o755);
  return { root, stateDir, binDir, callsPath };
}

interface RefreshResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runRefresh(box: RefreshBox, credStatus = 0): RefreshResult {
  const result = spawnSync("sh", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${box.binDir}:${process.env.PATH ?? ""}`,
      BLITZ_STATE_DIR: box.stateDir,
      BLITZ_CRED_CALLS: box.callsPath,
      BLITZ_CRED_STATUS: String(credStatus),
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writePrerequisites(box: RefreshBox): void {
  writeFileSync(join(box.stateDir, "origin"), "https://cp.example\n");
  writeFileSync(join(box.stateDir, "box-credential.json"), "{}\n");
}

describe("blitz-credential-refresh", () => {
  it("skips until the origin and box credential both exist", () => {
    const box = makeBox();

    const noOrigin = runRefresh(box);
    expect(noOrigin.status, noOrigin.stderr).toBe(0);
    expect(noOrigin.stdout.trim()).toBe(
      "blitz-credential-refresh: skipped (no control-plane origin)",
    );

    writeFileSync(join(box.stateDir, "origin"), "https://cp.example\n");
    const noCredential = runRefresh(box);
    expect(noCredential.status, noCredential.stderr).toBe(0);
    expect(noCredential.stdout.trim()).toBe(
      "blitz-credential-refresh: skipped (no box credential)",
    );
    expect(existsSync(box.callsPath)).toBe(false);
  });

  it("asks blitz-cred for an API token when both files exist", () => {
    const box = makeBox();
    writePrerequisites(box);

    const result = runRefresh(box);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(box.callsPath, "utf8")).toBe("api-token\n");
  });

  it("exits zero when blitz-cred fails", () => {
    const box = makeBox();
    writePrerequisites(box);

    const result = runRefresh(box, 1);

    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe(
      "blitz-credential-refresh: refresh failed; continuing",
    );
    expect(readFileSync(box.callsPath, "utf8")).toBe("api-token\n");
  });
});
