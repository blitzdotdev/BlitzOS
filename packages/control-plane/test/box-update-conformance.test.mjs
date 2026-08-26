import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBootstrapScript } from "../dist/core/bootstrap.js";
import { embeddedSection } from "./emitted-script.mjs";

// Host side of the `box config v1` cross-runtime contract. The updater the
// bootstrap emits onto the VM host (`blitz-box-update`) parses the box-config
// response with embedded Python and produces the update-result body the same
// way; both are pinned against packages/schema/fixtures/box-config/ here,
// with real python3, exactly as the control-plane side is pinned in
// test/box-config-conformance.test.ts.

const fixturesDirectory = fileURLToPath(
  new URL("../../schema/fixtures/box-config/", import.meta.url),
);

const bootstrap = buildBootstrapScript({
  boxImageSha256: "",
  boxImageRef: "ghcr.io/blitzdotdev/blitz-box:test",
  boxImageTag: "",
  phoneHomeUrl: "https://cp.example/workspaces/workspace/phone-home/token",
  sshPublicKey: "ssh-ed25519 AAAAcaller",
});

function fixtures(prefix) {
  return readdirSync(fixturesDirectory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .map((name) => [
      name,
      JSON.parse(readFileSync(path.join(fixturesDirectory, name), "utf8")),
    ]);
}

function python3Available() {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    console.warn("SKIP: python3 is missing from PATH; box-config conformance did not run");
    return false;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
  return true;
}

test("the emitted host scripts are valid bash", () => {
  for (const marker of ["BOX_RUN", "BOX_UPDATER"]) {
    const result = spawnSync("bash", ["-n"], {
      input: embeddedSection(bootstrap, marker),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${marker}: ${result.stderr}`);
  }
});

test("the updater and the initial start share the one blitz-box-run path", () => {
  const updater = embeddedSection(bootstrap, "BOX_UPDATER");
  assert.match(updater, /\/usr\/local\/bin\/blitz-box-run "\$1"/u);
  assert.ok(bootstrap.includes('/usr/local/bin/blitz-box-run "$box_image"'));
  // Pull first, remove second: a failed pull must leave the old container
  // running.
  assert.ok(
    updater.indexOf('docker pull "$next_ref"') < updater.indexOf("docker rm -f blitz-box"),
    "the updater must pull before it removes the running container",
  );
});

test("embedded box-config parser matches every config fixture", (context) => {
  if (!python3Available()) {
    context.skip("python3 is missing from PATH");
    return;
  }
  const parser = embeddedSection(bootstrap, "BOX_CONFIG_PARSER");
  const directory = mkdtempSync(path.join(tmpdir(), "blitz-box-config-"));
  const entries = fixtures("config-");
  try {
    for (const [name, fixture] of entries) {
      const responsePath = path.join(directory, name);
      writeFileSync(responsePath, JSON.stringify(fixture.response));
      const result = spawnSync("python3", ["-", responsePath], {
        input: parser,
        encoding: "utf8",
      });
      if (fixture.accepts) {
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
        const { boxImageRef, controlPlaneOrigin, updateRequested } = fixture.response;
        assert.equal(
          result.stdout,
          `${boxImageRef}\t${controlPlaneOrigin}\t${updateRequested}\n`,
          `${name}: parsed TSV mismatch`,
        );
      } else {
        assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  console.log(`box-config parser conformance: ${entries.length} fixtures`);
});

test("embedded update-result producer emits bytes the control plane accepts", (context) => {
  if (!python3Available()) {
    context.skip("python3 is missing from PATH");
    return;
  }
  const writer = embeddedSection(bootstrap, "RESULT_WRITER");
  const accepted = fixtures("result-").filter(([, fixture]) => fixture.accepts);
  assert.ok(accepted.length > 0, "no accepted update-result fixtures");
  for (const [name, fixture] of accepted) {
    const { ref, outcome } = fixture.request;
    const result = spawnSync("python3", ["-", ref, outcome], {
      input: writer,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    // The producer emits exactly the two contract keys; extra keys in a
    // fixture exist to pin the CONSUMER's tolerance, never this producer.
    assert.equal(result.stdout, JSON.stringify({ ref, outcome }), `${name}: body mismatch`);
  }
  console.log(`update-result producer conformance: ${accepted.length} accepted fixtures`);
});
