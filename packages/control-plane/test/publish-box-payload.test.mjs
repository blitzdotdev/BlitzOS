import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stageDaemonArchive } from "../scripts/build-box-daemon.mjs";
import {
  payloadUploadObjects,
  stageBoxPayloadRelease,
} from "../scripts/publish-box-payload.mjs";
import { validateBoxPayloadManifest } from "../scripts/lib/box-payload-manifest.mjs";
import { PAYLOAD_FILES } from "../scripts/lib/box-payload-files.mjs";
import { readLodyDaemonMetadata } from "../scripts/lib/box-daemon.mjs";
import { boxPayloadVersion } from "../scripts/box-payload-key.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function binaries() {
  const directory = temporaryDirectory("blitz-payload-binaries-");
  for (const name of ["blitz-box-gateway"]) {
    const filePath = path.join(directory, name);
    writeFileSync(filePath, `binary:${name}\n`);
    chmodSync(filePath, 0o755);
  }
  return directory;
}

async function stage(outputDirectory, stagingDirectory, extra = {}) {
  return stageBoxPayloadRelease({
    repoRoot,
    stagingDirectory,
    outputDirectory,
    binariesDirectory: extra.binariesDirectory ?? binaries(),
    daemonPath: extra.daemonPath,
    createdAt: extra.createdAt ?? 1_788_550_000_000,
    appUrl: "https://cp.example",
  });
}

test("stages a deterministic payload archive and a self-verifying manifest", async () => {
  const binaryDirectory = binaries();
  const first = await stage(
    temporaryDirectory("blitz-payload-release-one-"),
    temporaryDirectory("blitz-payload-stage-one-"),
    { binariesDirectory: binaryDirectory },
  );
  const second = await stage(
    temporaryDirectory("blitz-payload-release-two-"),
    temporaryDirectory("blitz-payload-stage-two-"),
    { binariesDirectory: binaryDirectory },
  );
  const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
  assert.equal(validateBoxPayloadManifest(manifest), manifest);
  assert.equal(manifest.version, boxPayloadVersion({
    files: manifest.files,
    restart: manifest.restart,
  }));
  assert.equal(first.version, second.version);
  assert.deepEqual(manifest.files.map((entry) => entry.path), PAYLOAD_FILES);
  assert.equal(manifest.daemon, undefined);
  assert.equal(
    manifest.archive.sha256,
    sha256(readFileSync(first.payloadArchivePath)),
  );
  assert.equal(manifest.archive.bytes, statSync(first.payloadArchivePath).size);
  assert.deepEqual(readFileSync(first.payloadArchivePath), readFileSync(second.payloadArchivePath));

  const differentCommitTime = await stage(
    temporaryDirectory("blitz-payload-release-created-at-"),
    temporaryDirectory("blitz-payload-stage-created-at-"),
    { binariesDirectory: binaryDirectory, createdAt: 1_788_550_999_000 },
  );
  assert.equal(differentCommitTime.version, first.version);
  assert.deepEqual(
    readFileSync(differentCommitTime.payloadArchivePath),
    readFileSync(first.payloadArchivePath),
  );

  const extracted = temporaryDirectory("blitz-payload-extracted-");
  const extract = spawnSync("tar", ["-xzf", first.payloadArchivePath, "-C", extracted], {
    encoding: "utf8",
  });
  assert.equal(extract.status, 0, extract.stderr);
  assert.equal(readFileSync(path.join(extracted, "payload-version"), "utf8"), `${manifest.version}\n`);
  assert.equal(manifest.files.some((entry) => entry.path === "payload-version"), false);
  for (const entry of manifest.files) {
    const extractedPath = path.join(extracted, entry.path);
    assert.equal(sha256(readFileSync(extractedPath)), entry.sha256, entry.path);
    assert.equal(
      (statSync(extractedPath).mode & 0o777).toString(8).padStart(4, "0"),
      entry.mode,
      entry.path,
    );
  }
  assert.ok(manifest.restart.gateway.includes("rootfs/usr/local/bin/blitz-box-gateway"));
  assert.equal(
    manifest.restart.ttyd.includes("rootfs/usr/local/libexec/blitz-term"),
    false,
  );
});

test("an optional daemon archive fills all daemon contract fields", async () => {
  const prefix = temporaryDirectory("blitz-payload-daemon-prefix-");
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  mkdirSync(path.join(prefix, "lib/node_modules/lody/dist"), { recursive: true });
  writeFileSync(path.join(prefix, "lib/node_modules/lody/dist/index.js"), "daemon\n");
  symlinkSync("../lib/node_modules/lody/dist/index.js", path.join(prefix, "bin/lody"));
  const daemonPath = path.join(temporaryDirectory("blitz-payload-daemon-archive-"), "daemon.tar.gz");
  await stageDaemonArchive(prefix, daemonPath, await readLodyDaemonMetadata(repoRoot));

  const staged = await stage(
    temporaryDirectory("blitz-payload-with-daemon-"),
    temporaryDirectory("blitz-payload-with-daemon-stage-"),
    { daemonPath },
  );
  const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
  assert.equal(manifest.version, boxPayloadVersion({
    files: manifest.files,
    daemonSha256: sha256(readFileSync(staged.daemonArchivePath)),
    restart: manifest.restart,
  }));
  assert.deepEqual(manifest.daemon, {
    version: "0.88.1+blitz.3",
    protocolVersion: 7,
    url: `https://cp.example/box-payload/${manifest.version}/daemon.tar.gz`,
    sha256: sha256(readFileSync(staged.daemonArchivePath)),
    bytes: statSync(staged.daemonArchivePath).size,
  });
  assert.equal(validateBoxPayloadManifest(manifest), manifest);
  const extracted = temporaryDirectory("blitz-payload-daemon-extracted-");
  const extract = spawnSync("tar", ["-xzf", staged.daemonArchivePath, "-C", extracted], {
    encoding: "utf8",
  });
  assert.equal(extract.status, 0, extract.stderr);
  assert.equal(readFileSync(path.join(extracted, "daemon-version"), "utf8"), "0.88.1+blitz.3\n");
  assert.equal(readFileSync(path.join(extracted, "daemon-protocol-version"), "utf8"), "7\n");
  assert.deepEqual(
    payloadUploadObjects("box-payload/version", staged).map(({ logicalPath }) => logicalPath),
    [
      "box-payload/version/payload.tar.gz",
      "box-payload/version/daemon.tar.gz",
      "box-payload/version/manifest.json",
    ],
  );
});
