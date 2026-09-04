import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const image = process.env.BLITZ_BOX_IMAGE;
const bundle = process.env.LODY_BUNDLE;
const externalStamp = process.env.LODY_BUILD_STAMP;
const binary = process.env.LODY_BINARY;
const enabled =
  image !== undefined ||
  (bundle !== undefined && externalStamp !== undefined && binary !== undefined);
const imageIt = enabled ? it : it.skip;

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const serviceRun = join(
  repoRoot,
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/run",
);

describe("the box carries the stamped tree-built Lody daemon", () => {
  imageIt(
    "matches both stamp copies, starts the CLI, and preserves the s6 binary path",
    () => {
      if (image !== undefined) {
        const script = String.raw`set -eu
test -f /opt/blitz/lody/BUILD.json
test -f /opt/blitz/npm/lib/node_modules/lody/dist/BUILD.json
node -e 'const fs=require("node:fs"); const outer=JSON.parse(fs.readFileSync("/opt/blitz/lody/BUILD.json","utf8")); const inner=JSON.parse(fs.readFileSync("/opt/blitz/npm/lib/node_modules/lody/dist/BUILD.json","utf8")); if (JSON.stringify(outer)!==JSON.stringify(inner)) process.exit(1)'
/opt/blitz/npm/bin/lody --help >/dev/null
grep -Eq '^[[:space:]]*/opt/blitz/npm/bin/lody start$' /etc/s6-overlay/s6-rc.d/lody-daemon/run`;
        const result = spawnSync(
          "docker",
          ["run", "--rm", "--entrypoint", "/bin/sh", image, "-c", script],
          { encoding: "utf8" },
        );
        expect(result.status, result.stderr || result.stdout).toBe(0);
        return;
      }

      const packageStamp = JSON.parse(
        readFileSync(join(bundle!, "dist", "BUILD.json"), "utf8"),
      ) as unknown;
      const imageStamp = JSON.parse(
        readFileSync(externalStamp!, "utf8"),
      ) as unknown;
      expect(imageStamp).toEqual(packageStamp);

      const help = spawnSync(binary!, ["--help"], { encoding: "utf8" });
      expect(help.status, help.stderr || help.stdout).toBe(0);

      const executableServiceLines = readFileSync(serviceRun, "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"));
      expect(executableServiceLines).toContain(
        "\t/opt/blitz/npm/bin/lody start",
      );
    },
  );
});
