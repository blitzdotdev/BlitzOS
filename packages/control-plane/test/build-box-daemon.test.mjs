import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stageDaemonArchive } from "../scripts/build-box-daemon.mjs";
import { lodyDaemonVersion, readLodyDaemonMetadata } from "../scripts/lib/box-daemon.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scriptPath = fileURLToPath(new URL("../scripts/build-box-daemon.mjs", import.meta.url));
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

const STAMP = Object.freeze({
  upstreamSha: "f4b1ba259eb754cd954da776d8e7384a8c30f1c9",
  distSha256: "3c1e9a7b5d20".padEnd(64, "0"),
});

/** A prefix the way the Dockerfile's daemon stage leaves it: the package with
 * the build stamp scripts/lody-build-package.mjs packs, and the bin link. */
function createStampedPrefix(stamp = STAMP) {
  const prefix = temporaryDirectory("blitz-daemon-prefix-");
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  mkdirSync(path.join(prefix, "lib/node_modules/lody/dist"), { recursive: true });
  writeFileSync(path.join(prefix, "lib/node_modules/lody/dist/index.js"), "daemon\n");
  writeFileSync(
    path.join(prefix, "lib/node_modules/lody/dist/BUILD.json"),
    `${JSON.stringify({ ...stamp, node: "22.20.0", pnpm: "10.20.0" })}\n`,
  );
  symlinkSync("../lib/node_modules/lody/dist/index.js", path.join(prefix, "bin/lody"));
  return prefix;
}

test("daemon metadata names the upstream commit and dist digest from the build stamp, and the z.literal-backed protocol", async () => {
  const prefix = createStampedPrefix();
  assert.deepEqual(await readLodyDaemonMetadata(repoRoot, prefix), {
    upstreamSha: STAMP.upstreamSha,
    distSha256: STAMP.distSha256,
    version: "f4b1ba259eb7+dist.3c1e9a7b5d20",
    protocolVersion: 7,
  });
  assert.equal(lodyDaemonVersion(STAMP), "f4b1ba259eb7+dist.3c1e9a7b5d20");
  // The version is also the updater's install directory name.
  assert.match(lodyDaemonVersion(STAMP), /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u);
});

test("daemon metadata refuses a prefix without a valid build stamp", async () => {
  const unstamped = temporaryDirectory("blitz-daemon-unstamped-");
  await assert.rejects(
    () => readLodyDaemonMetadata(repoRoot, unstamped),
    /could not read the lody build stamp/u,
  );
  const malformed = createStampedPrefix({ upstreamSha: "not-a-sha", distSha256: STAMP.distSha256 });
  await assert.rejects(
    () => readLodyDaemonMetadata(repoRoot, malformed),
    /upstreamSha is not a valid hash/u,
  );
});

test("rejects the removed unverified --image archive path before invoking Docker", () => {
  const outputPath = path.join(temporaryDirectory("blitz-daemon-cli-"), "daemon.tar.gz");
  const result = spawnSync(process.execPath, [
    scriptPath,
    "--out", outputPath,
    "--image", "unverified:latest",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument: --image/u);
});

test("daemon staging emits only the installed lody prefix deterministically", async () => {
  const prefix = createStampedPrefix();
  const first = path.join(temporaryDirectory("blitz-daemon-one-"), "daemon.tar.gz");
  const second = path.join(temporaryDirectory("blitz-daemon-two-"), "daemon.tar.gz");
  const metadata = await readLodyDaemonMetadata(repoRoot, prefix);
  const firstResult = await stageDaemonArchive(prefix, first, metadata);
  const secondResult = await stageDaemonArchive(prefix, second, metadata);
  assert.deepEqual(firstResult, secondResult);
  const listing = spawnSync("tar", ["-tzf", first], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /^bin\/lody$/mu);
  assert.match(listing.stdout, /^daemon-protocol-version$/mu);
  assert.match(listing.stdout, /^daemon-version$/mu);
  assert.match(listing.stdout, /^lib\/node_modules\/lody\/dist\/index\.js$/mu);
  assert.match(listing.stdout, /^lib\/node_modules\/lody\/dist\/BUILD\.json$/mu);
  assert.equal(readFileSync(path.join(prefix, "daemon-version"), "utf8"), `${metadata.version}\n`);
  assert.equal(
    readFileSync(path.join(prefix, "daemon-protocol-version"), "utf8"),
    `${metadata.protocolVersion}\n`,
  );
});
