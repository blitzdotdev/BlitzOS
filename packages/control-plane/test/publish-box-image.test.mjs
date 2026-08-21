import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  boxImagePartName,
  buildBoxImageManifest,
  stageBoxImageRelease,
  writeBoxImageParts,
} from "../scripts/publish-box-image.mjs";
import { createBoxImageAssetSet, validateBoxImageManifest } from "../scripts/lib/asset-pack.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/publish-box-image.mjs", import.meta.url));
const fixturesDirectory = fileURLToPath(
  new URL("../../schema/fixtures/box-image-manifest/", import.meta.url),
);

const temporaryDirectories = [];

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

test.after(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function chunked(bytes, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize));
  }
  return chunks;
}

test("stages a release whose manifest conforms to the shared fixture contract", async () => {
  const payload = randomBytes(10_000);
  const outDir = temporaryDirectory("blitz-publish-stage-");
  const staged = await stageBoxImageRelease({
    source: chunked(payload, 1000),
    outDir,
    imageTag: "blitz-box:conformance-test",
    partSizeBytes: 4096,
  });

  assert.deepEqual(
    staged.parts.map(({ name, sizeBytes }) => ({ name, sizeBytes })),
    [
      { name: "part-000", sizeBytes: 4096 },
      { name: "part-001", sizeBytes: 4096 },
      { name: "part-002", sizeBytes: 1808 },
    ],
  );
  assert.equal(staged.manifest.totalSha256, sha256Hex(payload));

  // The written document must re-parse through the consumer-side validator
  // and survive a JSON round trip unchanged.
  const written = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
  assert.deepEqual(validateBoxImageManifest(written), staged.manifest);
  assert.deepEqual(JSON.parse(JSON.stringify(staged.manifest)), staged.manifest);

  // Field-for-field conformance with the fixture corpus: same top-level keys
  // and same part keys as the canonical valid fixture.
  const fixture = JSON.parse(
    readFileSync(path.join(fixturesDirectory, "valid", "multiple-parts.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(written).sort(), Object.keys(fixture).sort());
  for (const part of written.parts) {
    assert.deepEqual(Object.keys(part).sort(), Object.keys(fixture.parts[0]).sort());
    assert.match(part.sha256, /^[a-f0-9]{64}$/u);
  }
  assert.match(written.totalSha256, /^[a-f0-9]{64}$/u);

  // Per-part digests and byte-for-byte reassembly.
  const reassembled = Buffer.concat(
    staged.parts.map((part) => readFileSync(path.join(outDir, part.name))),
  );
  assert.deepEqual(reassembled, payload);
  for (const part of staged.parts) {
    assert.equal(sha256Hex(readFileSync(path.join(outDir, part.name))), part.sha256);
  }

  // The consumer-side loader accepts the staged release and derives the
  // documented R2 object layout from it.
  const assetSet = await createBoxImageAssetSet(staged.manifestPath);
  assert.equal(assetSet.releaseId, staged.manifest.totalSha256);
  assert.deepEqual(
    assetSet.files.map(({ logicalPath }) => logicalPath),
    [
      "box-image/part-000",
      "box-image/part-001",
      "box-image/part-002",
      "box-image/manifest.json",
    ],
  );
  assert.equal(assetSet.files.at(-1)?.mediaType, "application/json; charset=utf-8");
});

test("splits exact multiples and undersized archives correctly", async () => {
  const exact = randomBytes(8192);
  const exactDir = temporaryDirectory("blitz-publish-exact-");
  const exactResult = await writeBoxImageParts([exact], exactDir, 4096);
  assert.deepEqual(exactResult.parts.map(({ name, sizeBytes }) => ({ name, sizeBytes })), [
    { name: "part-000", sizeBytes: 4096 },
    { name: "part-001", sizeBytes: 4096 },
  ]);
  assert.equal(exactResult.totalSha256, sha256Hex(exact));
  assert.deepEqual(readdirSync(exactDir).sort(), ["part-000", "part-001"]);

  const tiny = randomBytes(10);
  const tinyDir = temporaryDirectory("blitz-publish-tiny-");
  const tinyResult = await writeBoxImageParts([tiny], tinyDir, 4096);
  assert.deepEqual(tinyResult.parts.map(({ name, sizeBytes }) => ({ name, sizeBytes })), [
    { name: "part-000", sizeBytes: 10 },
  ]);
  assert.equal(tinyResult.parts[0].sha256, sha256Hex(tiny));
});

test("rejects an empty archive and normalizes digests through the shared parser", async () => {
  const outDir = temporaryDirectory("blitz-publish-empty-");
  await assert.rejects(
    () => writeBoxImageParts([], outDir, 4096),
    /archive was empty/u,
  );

  const manifest = buildBoxImageManifest(
    [{ name: "part-000", sha256: "A".repeat(64) }],
    "B".repeat(64),
    "blitz-box:normalize",
  );
  assert.equal(manifest.parts[0].sha256, "a".repeat(64));
  assert.equal(manifest.totalSha256, "b".repeat(64));
  assert.throws(() => buildBoxImageManifest([], "b".repeat(64), "blitz-box:normalize"));
  assert.throws(() =>
    buildBoxImageManifest(
      [{ name: "part-000", sha256: "a".repeat(64) }],
      "b".repeat(64),
      "bad tag",
    ));
});

test("partNumbers stay valid manifest part names as the index grows", () => {
  assert.equal(boxImagePartName(0), "part-000");
  assert.equal(boxImagePartName(42), "part-042");
  assert.equal(boxImagePartName(1234), "part-1234");
  for (const index of [0, 42, 1234]) {
    const manifest = buildBoxImageManifest(
      [{ name: boxImagePartName(index), sha256: "a".repeat(64) }],
      "b".repeat(64),
      "blitz-box:names",
    );
    assert.equal(manifest.parts[0].name, boxImagePartName(index));
  }
});

test("CLI --dry-run stages, verifies, and prints the wrangler.toml values without docker", () => {
  const archiveDir = temporaryDirectory("blitz-publish-cli-src-");
  const outDir = temporaryDirectory("blitz-publish-cli-out-");
  const payload = randomBytes(5000);
  const archivePath = path.join(archiveDir, "synthetic.tar.gz");
  writeFileSync(archivePath, payload);

  const run = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--image", "blitz-box:cli-dry-run",
      "--archive", archivePath,
      "--out", outDir,
      "--app-url", "https://cp.example/",
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^BOX_IMAGE_REF = "https:\/\/cp\.example\/box-image\/manifest\.json"$/mu);
  assert.match(run.stdout, /^BOX_IMAGE_TAG = "blitz-box:cli-dry-run"$/mu);
  assert.match(
    run.stdout,
    new RegExp(`^BOX_IMAGE_SHA256 = "${sha256Hex(payload)}"$`, "mu"),
  );
  assert.match(run.stderr, /dry run: skipped uploading 2 objects/u);

  const written = JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  assert.deepEqual(validateBoxImageManifest(written), {
    parts: [{ name: "part-000", sha256: sha256Hex(payload) }],
    totalSha256: sha256Hex(payload),
    imageTag: "blitz-box:cli-dry-run",
  });

  const rerun = spawnSync(
    process.execPath,
    [scriptPath, "--image", "blitz-box:cli-dry-run", "--archive", archivePath, "--out", outDir, "--dry-run"],
    { encoding: "utf8" },
  );
  assert.equal(rerun.status, 1);
  assert.match(rerun.stderr, /refusing to overwrite an already staged release/u);
});

test("CLI rejects a tag the manifest contract rejects, before any work happens", () => {
  const run = spawnSync(
    process.execPath,
    [scriptPath, "--image", "bad tag", "--dry-run"],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--image is not a valid image tag/u);
  assert.match(run.stderr, /Usage:/u);
});

// docs/BOX-IMAGE.md sends readers here for the option list, so --help is a
// documented entry point: it must print usage on stdout and exit 0, not fall
// through to the unknown-argument path.
test("CLI --help prints the option list and succeeds", () => {
  for (const flag of ["--help", "-h"]) {
    const run = spawnSync(process.execPath, [scriptPath, flag], { encoding: "utf8" });
    assert.equal(run.status, 0, flag);
    assert.equal(run.stderr, "", flag);
    assert.match(run.stdout, /Usage:/u);
    assert.match(run.stdout, /--part-size-mb/u);
  }
});
