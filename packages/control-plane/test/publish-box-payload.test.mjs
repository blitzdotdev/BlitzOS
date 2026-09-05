import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { PAYLOAD_DIRECTORIES, PAYLOAD_FILES } from "../scripts/lib/box-payload-files.mjs";
import {
  lodyDaemonVersion,
  readLodyDaemonMetadata,
  readLodyUpstreamPin,
} from "../scripts/lib/box-daemon.mjs";
import { boxPayloadVersion } from "../scripts/box-payload-key.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureRoot = path.join(repoRoot, "packages/schema/fixtures/box-payload");
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

const V1_RESTART_SERVICES = new Set([
  "cloudflared", "dockerd", "dufs", "gateway", "lody-bridge", "lody-daemon",
  "lody-projects", "lody-watchdog", "remote-control", "sshd", "ttyd", "watch",
]);

// Frozen protocol 1 grammar. Unknown top-level fields are deliberately ignored.
function validateWithFrozenV1Grammar(manifest) {
  const requiredRecord = (value, label) => {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label);
    return value;
  };
  const validVersion = (value) => String(value) === value
    && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value);
  const validDigest = (value) => String(value) === value && /^[a-f0-9]{64}$/u.test(value);
  assert.ok(Number.isSafeInteger(manifest.createdAt) && manifest.createdAt > 0);
  assert.ok(Number.isSafeInteger(manifest.minUpdater) && manifest.minUpdater > 0);
  assert.ok(validVersion(manifest.version));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  const validPath = (value) => String(value) === value
    && value.startsWith("rootfs/")
    && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
  const validArchive = (value, label) => {
    const archive = requiredRecord(value, label);
    assert.ok(String(archive.url) === archive.url && /^https?:\/\/[^/\s?#]+(?:[/?][^\s#]*)?$/u.test(archive.url));
    assert.ok(validDigest(archive.sha256));
    assert.ok(Number.isSafeInteger(archive.bytes) && archive.bytes > 0);
  };
  for (const entry of manifest.files) {
    requiredRecord(entry, "file");
    assert.ok(validPath(entry.path));
    assert.ok(validDigest(entry.sha256));
    assert.match(entry.mode, /^[0-7]{4}$/u);
  }
  validArchive(manifest.archive, "archive");
  if (manifest.daemon !== undefined) {
    const daemon = requiredRecord(manifest.daemon, "daemon");
    assert.ok(validVersion(daemon.version));
    assert.ok(Number.isSafeInteger(daemon.protocolVersion) && daemon.protocolVersion > 0);
    validArchive(daemon, "daemon archive");
  }
  for (const [service, dependencies] of Object.entries(requiredRecord(manifest.restart, "restart"))) {
    assert.ok(V1_RESTART_SERVICES.has(service), service);
    assert.ok(Array.isArray(dependencies));
    for (const dependency of dependencies) assert.ok(validPath(dependency));
  }
}

test("publisher manifest validation matches the entire shared corpus", () => {
  for (const accepted of [true, false]) {
    const directory = path.join(fixtureRoot, accepted ? "valid" : "invalid");
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
      const manifest = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
      const validate = () => validateBoxPayloadManifest(manifest);
      if (accepted) assert.doesNotThrow(validate, name);
      else assert.throws(validate, undefined, name);
    }
  }
});

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
    directories: manifest.directories,
    restart: manifest.restart,
  }));
  assert.equal(first.version, second.version);
  assert.deepEqual(manifest.files.map((entry) => entry.path), PAYLOAD_FILES);
  assert.deepEqual(manifest.directories, PAYLOAD_DIRECTORIES);
  assert.equal(manifest.minUpdater, 2);
  assert.equal(manifest.daemon, undefined);
  assert.equal(manifest.files.some((entry) => entry.path === "rootfs/etc/blitz/env.defaults"), false);
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
  for (const directory of manifest.directories) {
    const extractedPath = path.join(extracted, directory);
    assert.ok(statSync(extractedPath).isDirectory(), directory);
    assert.equal(statSync(extractedPath).mode & 0o777, 0o755, directory);
    assert.deepEqual(readdirSync(extractedPath), [], directory);
  }
  assert.ok(manifest.restart.gateway.includes("rootfs/usr/local/bin/blitz-box-gateway"));
  assert.ok(manifest.restart.sshd.includes("rootfs/etc/blitz/sshd_config"));
  assert.equal(manifest.restart["machine-stats"], undefined);
  assert.equal(
    manifest.restart.ttyd.includes("rootfs/usr/local/libexec/blitz-term"),
    false,
  );
  for (const oneshot of ["cgroups", "init-state", "register", "rules"]) {
    assert.equal(manifest.restart[oneshot], undefined);
  }
});

test("publisher protocol 2 output remains valid under the frozen protocol 1 grammar", async () => {
  const staged = await stage(
    temporaryDirectory("blitz-payload-v1-grammar-release-"),
    temporaryDirectory("blitz-payload-v1-grammar-stage-"),
  );

  validateWithFrozenV1Grammar(staged.manifest);
  assert.equal(staged.manifest.minUpdater, 2);
  assert.deepEqual(staged.manifest.directories, PAYLOAD_DIRECTORIES);
});

/** A prefix the way the Dockerfile's daemon stage leaves it, stamped with the
 * upstream commit this tree pins unless a test says otherwise. */
async function stampedDaemonPrefix(upstreamSha) {
  const prefix = temporaryDirectory("blitz-payload-daemon-prefix-");
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  mkdirSync(path.join(prefix, "lib/node_modules/lody/dist"), { recursive: true });
  writeFileSync(path.join(prefix, "lib/node_modules/lody/dist/index.js"), "daemon\n");
  const stamp = {
    upstreamSha: upstreamSha ?? await readLodyUpstreamPin(repoRoot),
    distSha256: "3c1e9a7b5d20".padEnd(64, "0"),
  };
  writeFileSync(
    path.join(prefix, "lib/node_modules/lody/dist/BUILD.json"),
    `${JSON.stringify({ ...stamp, node: "22.20.0", pnpm: "10.20.0" })}\n`,
  );
  symlinkSync("../lib/node_modules/lody/dist/index.js", path.join(prefix, "bin/lody"));
  return { prefix, stamp };
}

test("an optional daemon archive fills all daemon contract fields", async () => {
  const { prefix, stamp } = await stampedDaemonPrefix();
  const daemonPath = path.join(temporaryDirectory("blitz-payload-daemon-archive-"), "daemon.tar.gz");
  await stageDaemonArchive(prefix, daemonPath, await readLodyDaemonMetadata(repoRoot, prefix));

  const staged = await stage(
    temporaryDirectory("blitz-payload-with-daemon-"),
    temporaryDirectory("blitz-payload-with-daemon-stage-"),
    { daemonPath },
  );
  const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
  assert.equal(manifest.version, boxPayloadVersion({
    files: manifest.files,
    directories: manifest.directories,
    daemonSha256: sha256(readFileSync(staged.daemonArchivePath)),
    restart: manifest.restart,
  }));
  assert.deepEqual(manifest.daemon, {
    version: lodyDaemonVersion(stamp),
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
  assert.equal(
    readFileSync(path.join(extracted, "daemon-version"), "utf8"),
    `${lodyDaemonVersion(stamp)}\n`,
  );
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

test("a daemon archive built from another upstream commit is refused", async () => {
  const { prefix } = await stampedDaemonPrefix("0".repeat(40));
  const daemonPath = path.join(temporaryDirectory("blitz-payload-foreign-daemon-"), "daemon.tar.gz");
  await stageDaemonArchive(prefix, daemonPath, await readLodyDaemonMetadata(repoRoot, prefix));
  await assert.rejects(
    () => stage(
      temporaryDirectory("blitz-payload-foreign-"),
      temporaryDirectory("blitz-payload-foreign-stage-"),
      { daemonPath },
    ),
    /daemon archive was built from upstream 0{40}, but vendor\/lody\/UPSTREAM\.md pins/u,
  );
});
