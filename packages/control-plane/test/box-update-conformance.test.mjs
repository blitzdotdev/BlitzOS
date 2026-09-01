import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BOX_IMAGE_MANIFEST_PARSER,
  buildBootstrapScript,
} from "../dist/core/bootstrap.js";
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
  for (const marker of ["BOX_RUN", "BOX_UPDATER", "BOX_IMAGE_INSTALL"]) {
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
  // Acquire first, remove second, on BOTH install paths: a registry pull or a
  // manifest install that fails must leave the old container running.
  const removal = updater.indexOf("docker rm -f blitz-box");
  assert.ok(removal > 0, "the updater no longer removes the container");
  for (const acquire of ['docker pull "$next_image"', "blitz-box-image install"]) {
    const at = updater.indexOf(acquire);
    assert.ok(at > 0, `the updater no longer runs: ${acquire}`);
    assert.ok(at < removal, `the updater must run ${acquire} before removing the container`);
  }
});

// The first boot and the host updater install the same image the same way, so
// they run the SAME host script rather than two copies of one pipeline. Two
// copies would be two chances to verify a digest differently — and both used
// to ride in cloud-init user-data, which Hetzner caps at 32 KiB.
test("one host installer serves both the first boot and the updater", () => {
  const manifestBootstrap = buildBootstrapScript({
    boxImageSha256: "a".repeat(64),
    boxImageRef: "https://r2.example/box-image/manifest.json",
    boxImageTag: "blitz-box:2026-08-31",
    phoneHomeUrl: "https://cp.example/workspaces/workspace/phone-home/token",
  });
  // Exactly one copy of the manifest parser is emitted, and it is the shared
  // constant.
  const copies = manifestBootstrap.split("manifest totalSha256 must be a SHA-256 digest").length - 1;
  assert.equal(copies, 1, "the manifest parser is emitted more than once");
  assert.equal(
    `${embeddedSection(manifestBootstrap, "MANIFEST_PARSER")}\n`,
    BOX_IMAGE_MANIFEST_PARSER,
  );
  // Both callers reach it by the one path.
  assert.match(manifestBootstrap, /\/usr\/local\/sbin\/blitz-box-image "\$box_image_action"/u);
  assert.match(
    embeddedSection(manifestBootstrap, "BOX_UPDATER"),
    /\/usr\/local\/sbin\/blitz-box-image resolve "\$next_ref"/u,
  );
});

// The failure this closes: a 15-minute box token, a 5-minute timer, and a
// consumer that could not rotate. Every poll after the first expiry 401d for
// good, so the update flag never cleared and the button that set it died
// silently. The updater has to hold its own credential.
test("the updater can rotate the box credential it reads", () => {
  const updater = embeddedSection(bootstrap, "BOX_UPDATER");
  assert.match(updater, /"\$current_origin\/oauth\/token"/u);
  assert.match(updater, /grant_type=refresh_token/u);
  // Under the same lock the in-container Go client takes, beside the file,
  // because the file is replaced by rename.
  assert.match(updater, /flock --exclusive --timeout 30 9/u);
  assert.match(updater, /9>"\$CREDENTIAL_LOCK"/u);
  assert.ok(updater.includes('readonly CREDENTIAL_LOCK="$STATE_DIR/box-credential.lock"'));
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
    const { ref, outcome, tag } = fixture.request;
    const result = spawnSync("python3", ["-", ref, outcome, tag ?? ""], {
      input: writer,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    // The producer emits the two required contract keys, plus `tag` when the
    // host has an image to name. Other extra keys in a fixture exist to pin
    // the CONSUMER's tolerance, never this producer.
    const expected = tag === undefined ? { ref, outcome } : { ref, outcome, tag };
    assert.equal(result.stdout, JSON.stringify(expected), `${name}: body mismatch`);
  }

  // No running container means no image to name, and the producer omits the
  // key rather than reporting an empty one.
  const noContainer = spawnSync(
    "python3",
    ["-", "ghcr.io/blitzdotdev/blitz-box:v2", "start-failed", ""],
    { input: writer, encoding: "utf8" },
  );
  assert.equal(noContainer.status, 0, noContainer.stderr);
  assert.equal(
    noContainer.stdout,
    JSON.stringify({ ref: "ghcr.io/blitzdotdev/blitz-box:v2", outcome: "start-failed" }),
  );
  console.log(`update-result producer conformance: ${accepted.length} accepted fixtures`);
});
