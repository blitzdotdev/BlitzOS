import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import {
  isDigestPinnedImageReference,
  withBoxImageReference,
} from "../scripts/set-box-image-ref.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/set-box-image-ref.mjs", import.meta.url));

const DIGEST = `sha256:${"ab".repeat(32)}`;
const REFERENCE = `ghcr.io/acme/blitz-box@${DIGEST}`;

const MODE_B_CONFIG = [
  'name = "blitz-control-plane"',
  'main = "src/worker.ts"',
  "",
  "[vars]",
  'APP_URL = "https://cp.example"',
  'BOX_IMAGE_REF = "https://cp.example/box-image/manifest.json"',
  'BOX_IMAGE_TAG = "blitz-box:20260818a-amd64"',
  `BOX_IMAGE_SHA256 = "${"c".repeat(64)}"`,
  "",
  "[[d1_databases]]",
  'binding = "DB"',
  'database_name = "blitz-control-plane"',
  'database_id = "51bebbfa-dc55-4f64-bbbe-e71c02a9c899"',
  "",
  "[[r2_buckets]]",
  'binding = "BOX_IMAGES"',
  'bucket_name = "blitz-box-images"',
  "",
].join("\n");

test("pins the reference and clears the Mode B archive vars", () => {
  const config = parse(withBoxImageReference(MODE_B_CONFIG, REFERENCE));
  assert.equal(config.vars.BOX_IMAGE_REF, REFERENCE);
  assert.equal(config.vars.BOX_IMAGE_TAG, "");
  assert.equal(config.vars.BOX_IMAGE_SHA256, "");
});

test("leaves every other key of the config intact", () => {
  const config = parse(withBoxImageReference(MODE_B_CONFIG, REFERENCE));
  assert.equal(config.name, "blitz-control-plane");
  assert.equal(config.main, "src/worker.ts");
  assert.equal(config.vars.APP_URL, "https://cp.example");
  assert.deepEqual(config.d1_databases, [
    {
      binding: "DB",
      database_name: "blitz-control-plane",
      database_id: "51bebbfa-dc55-4f64-bbbe-e71c02a9c899",
    },
  ]);
  assert.deepEqual(config.r2_buckets, [
    { binding: "BOX_IMAGES", bucket_name: "blitz-box-images" },
  ]);
});

test("is idempotent: pinning twice yields the same config", () => {
  const once = withBoxImageReference(MODE_B_CONFIG, REFERENCE);
  assert.equal(withBoxImageReference(once, REFERENCE), once);
});

test("rejects tag references — only digests are immutable", () => {
  assert.throws(
    () => withBoxImageReference(MODE_B_CONFIG, "ghcr.io/acme/blitz-box:latest"),
    /digest-pinned/u,
  );
});

test("rejects a config without a [vars] table", () => {
  assert.throws(() => withBoxImageReference('name = "x"\n', REFERENCE), /\[vars\] table/u);
});

test("digest reference validation truth table", () => {
  assert.equal(isDigestPinnedImageReference(REFERENCE), true);
  assert.equal(isDigestPinnedImageReference(`registry.example:5000/a/b/c@${DIGEST}`), true);
  for (const bad of [
    "ghcr.io/acme/blitz-box",
    `blitz-box@${DIGEST}`,
    `ghcr.io/acme/blitz-box@sha256:${"ab".repeat(16)}`,
    `ghcr.io/Acme/blitz-box@${DIGEST}`,
    `https://cp.example/box-image/manifest.json`,
    "",
  ]) {
    assert.equal(isDigestPinnedImageReference(bad), false, bad);
  }
});

test("CLI pins a config file in place", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "set-box-image-ref-"));
  try {
    const configPath = path.join(directory, "wrangler.toml");
    writeFileSync(configPath, MODE_B_CONFIG);
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--ref", REFERENCE, "--config", configPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const config = parse(readFileSync(configPath, "utf8"));
    assert.equal(config.vars.BOX_IMAGE_REF, REFERENCE);
    assert.equal(config.vars.BOX_IMAGE_TAG, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI refuses a tag reference and leaves the file unchanged", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "set-box-image-ref-"));
  try {
    const configPath = path.join(directory, "wrangler.toml");
    writeFileSync(configPath, MODE_B_CONFIG);
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--ref", "ghcr.io/acme/blitz-box:latest", "--config", configPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /digest-pinned/u);
    assert.equal(readFileSync(configPath, "utf8"), MODE_B_CONFIG);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
