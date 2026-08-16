import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBootstrapScript } from "../dist/core/bootstrap.js";

const fixturesDirectory = fileURLToPath(
  new URL("../../schema/fixtures/box-image-manifest/", import.meta.url),
);

test("embedded Python validator matches every box-image manifest fixture", (context) => {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    console.warn("SKIP: python3 is missing from PATH; box-image manifest conformance did not run");
    context.skip("python3 is missing from PATH");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);

  const bootstrap = buildBootstrapScript({
    boxImageSha256: "b".repeat(64),
    boxImageRef: "https://cp.example/box-image/manifest.json",
    boxImageTag: "blitz-box:release",
    phoneHomeUrl: "https://cp.example/workspaces/workspace/phone-home/token",
    sshPublicKey: "ssh-ed25519 AAAAcaller",
  });
  const validator = bootstrap.match(
    /python3 - "\$manifest_path" "\$manifest_parts_path" >"\$manifest_metadata_path" <<'PYTHON'\n(?<source>[\s\S]*?)\nPYTHON/u,
  )?.groups?.source;
  assert.ok(validator, "embedded manifest validator was not found");

  const validNames = readdirSync(path.join(fixturesDirectory, "valid")).sort();
  const invalidNames = readdirSync(path.join(fixturesDirectory, "invalid")).sort();
  const directory = mkdtempSync(path.join(tmpdir(), "blitz-manifest-python-"));
  try {
    for (const name of validNames) {
      const result = spawnSync(
        "python3",
        [
          "-",
          path.join(fixturesDirectory, "valid", name),
          path.join(directory, "parts.tsv"),
        ],
        { input: validator, encoding: "utf8" },
      );
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
    for (const name of invalidNames) {
      const result = spawnSync(
        "python3",
        [
          "-",
          path.join(fixturesDirectory, "invalid", name),
          path.join(directory, "parts.tsv"),
        ],
        { input: validator, encoding: "utf8" },
      );
      assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  console.log(
    `box-image manifest Python conformance: ${validNames.length} valid + ${invalidNames.length} invalid fixtures`,
  );
});
