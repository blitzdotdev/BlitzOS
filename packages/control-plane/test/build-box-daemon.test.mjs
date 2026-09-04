import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stageDaemonArchive } from "../scripts/build-box-daemon.mjs";
import { readLodyDaemonMetadata } from "../scripts/lib/box-daemon.mjs";

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

test("daemon metadata reads the upstream pin and z.literal-backed protocol", async () => {
  assert.deepEqual(await readLodyDaemonMetadata(repoRoot), {
    npmVersion: "0.88.1",
    version: "0.88.1+blitz.3",
    protocolVersion: 7,
  });
});

test("daemon staging emits only the installed lody prefix deterministically", async () => {
  const prefix = temporaryDirectory("blitz-daemon-prefix-");
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  mkdirSync(path.join(prefix, "lib/node_modules/lody/dist"), { recursive: true });
  writeFileSync(path.join(prefix, "lib/node_modules/lody/dist/index.js"), "daemon\n");
  symlinkSync("../lib/node_modules/lody/dist/index.js", path.join(prefix, "bin/lody"));
  const first = path.join(temporaryDirectory("blitz-daemon-one-"), "daemon.tar.gz");
  const second = path.join(temporaryDirectory("blitz-daemon-two-"), "daemon.tar.gz");
  const metadata = await readLodyDaemonMetadata(repoRoot);
  const firstResult = await stageDaemonArchive(prefix, first, metadata);
  const secondResult = await stageDaemonArchive(prefix, second, metadata);
  assert.deepEqual(firstResult, secondResult);
  const listing = spawnSync("tar", ["-tzf", first], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /^bin\/lody$/mu);
  assert.match(listing.stdout, /^daemon-protocol-version$/mu);
  assert.match(listing.stdout, /^daemon-version$/mu);
  assert.match(listing.stdout, /^lib\/node_modules\/lody\/dist\/index\.js$/mu);
  assert.equal(readFileSync(path.join(prefix, "daemon-version"), "utf8"), `${metadata.version}\n`);
  assert.equal(
    readFileSync(path.join(prefix, "daemon-protocol-version"), "utf8"),
    `${metadata.protocolVersion}\n`,
  );
});
