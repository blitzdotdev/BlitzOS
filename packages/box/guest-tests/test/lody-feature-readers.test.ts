import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const servicesRoot = fileURLToPath(
  new URL("../../rootfs/etc/s6-overlay/s6-rc.d/", import.meta.url),
);
const readerNames = ["lody-bridge", "lody-daemon", "lody-projects", "lody-watchdog"];
const temporaryDirectories: string[] = [];
const setpriv = "/usr/bin/setpriv";
const linuxRootIt = process.platform === "linux"
  && process.getuid?.() === 0
  && existsSync(setpriv)
  ? it
  : it.skip;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function asBoxUser(command: string, environment: NodeJS.ProcessEnv): number | null {
  return spawnSync(
    setpriv,
    ["--reuid=1000", "--regid=1000", "--clear-groups", "/bin/sh", "-c", command],
    { env: environment, encoding: "utf8" },
  ).status;
}

describe("Lody feature readers", () => {
  it("parses one exact record without evaluating the feature file", () => {
    for (const service of readerNames) {
      const source = readFileSync(path.join(servicesRoot, service, "run"), "utf8");
      const code = source.split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      expect(code.match(/grep -qx 'BLITZ_LODY_SESSIONS=1' "\$features_file"/gu))
        .toHaveLength(1);
      expect(code).not.toMatch(/(?:^|\n)\s*(?:source|\.)\s/u);
      expect(code).toContain("/opt/blitz/payload/state/features");
      expect(code).toContain("sleep 2");
    }
  });

  linuxRootIt("keeps updater state root-only and makes junk disable every reader [Linux root only]", () => {
    const root = mkdtempSync(path.join(tmpdir(), "blitz-feature-security-"));
    temporaryDirectories.push(root);
    chmodSync(root, 0o755);
    const state = path.join(root, "opt/blitz/payload/state");
    const features = path.join(state, "features");
    const writable = path.join(root, "box-user");
    const replacement = path.join(writable, "replacement");
    mkdirSync(state, { recursive: true, mode: 0o755 });
    mkdirSync(writable, { mode: 0o700 });
    chownSync(writable, 1000, 1000);
    writeFileSync(features, "BLITZ_LODY_SESSIONS=0\n", { mode: 0o644 });
    writeFileSync(replacement, "BLITZ_LODY_SESSIONS=1\n", { mode: 0o644 });
    chownSync(replacement, 1000, 1000);
    const boxEnvironment = { ...process.env, FEATURES: features, REPLACEMENT: replacement };

    expect(asBoxUser('printf "BLITZ_LODY_SESSIONS=1\\n" >"$FEATURES"', boxEnvironment))
      .not.toBe(0);
    expect(asBoxUser('mv "$FEATURES" "$FEATURES.moved"', boxEnvironment)).not.toBe(0);
    expect(asBoxUser('mv "$REPLACEMENT" "$FEATURES"', boxEnvironment)).not.toBe(0);
    unlinkSync(features);
    expect(asBoxUser('printf "BLITZ_LODY_SESSIONS=1\\n" >"$FEATURES"', boxEnvironment))
      .not.toBe(0);

    const sentinel = path.join(root, "sourced-junk");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "sleep"),
      "#!/bin/sh\nprintf 'sleep:%s\\n' \"$*\"\n",
      { mode: 0o755 },
    );
    chmodSync(path.join(bin, "sleep"), 0o755);
    writeFileSync(
      features,
      "BLITZ_LODY_SESSIONS=1\ntouch \"$BLITZ_TEST_FEATURE_SENTINEL\"\n",
      { mode: 0o644 },
    );
    for (const service of readerNames) {
      const run = spawnSync("bash", [path.join(servicesRoot, service, "run")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          BLITZ_FEATURES_FILE: features,
          BLITZ_TEST_FEATURE_SENTINEL: sentinel,
        },
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(
        `${service}: disabled by /opt/blitz/payload/state/features`,
      );
      expect(run.stdout).toContain("sleep:infinity");
      expect(existsSync(sentinel)).toBe(false);
    }
  });
});
