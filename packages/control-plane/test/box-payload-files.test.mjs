import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  copyPayloadSources,
  installPayloadIndirections,
  PAYLOAD_DIRECTORIES,
  PAYLOAD_FILES,
  PAYLOAD_GENERATED_PATHS,
  PAYLOAD_ROOTFS_PATHS,
  payloadMode,
  payloadFilesForRepo,
  readPayloadRestartMap,
} from "../scripts/lib/box-payload-files.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rootfs = path.join(repoRoot, "packages/box/rootfs");
const temporaryDirectories = [];
// This file is the recovery mechanism, not content it manages. Pin the
// exception just as explicitly as the payload inventory so a new box script
// cannot accidentally escape ownership by joining an open-ended allowlist.
const BASE_OWNED_ROOTFS_PATHS = [
  "usr/local/libexec/blitz-payload",
];
const BASE_OWNED_GENERATED_PATHS = ["rootfs/usr/local/bin/blitz-cred"];

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

function filesBelow(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) found.push(path.relative(rootfs, absolute));
    }
  };
  walk(directory);
  return found;
}

test("the payload inventory owns the complete s6 tree and every eligible rootfs file", () => {
  const discovered = [
    ...filesBelow(path.join(rootfs, "usr/local/bin")),
    ...filesBelow(path.join(rootfs, "usr/local/libexec")),
    ...filesBelow(path.join(rootfs, "opt/blitz/skel")),
    ...filesBelow(path.join(rootfs, "etc/s6-overlay/s6-rc.d")),
  ].filter((relativePath) => !BASE_OWNED_ROOTFS_PATHS.includes(relativePath)).sort();
  assert.deepEqual(PAYLOAD_ROOTFS_PATHS, discovered);
  for (const basePath of BASE_OWNED_ROOTFS_PATHS) {
    assert.ok(!PAYLOAD_FILES.includes(`rootfs/${basePath}`));
    assert.ok(statSync(path.join(rootfs, basePath)).isFile());
  }
  for (const basePath of BASE_OWNED_GENERATED_PATHS) {
    assert.ok(!PAYLOAD_FILES.includes(basePath));
  }
  assert.deepEqual(PAYLOAD_GENERATED_PATHS, ["rootfs/usr/local/bin/blitz-box-gateway"]);
  assert.deepEqual(PAYLOAD_DIRECTORIES, [
    "rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d",
  ]);
  assert.equal(new Set(PAYLOAD_FILES).size, PAYLOAD_FILES.length);
  assert.deepEqual(PAYLOAD_FILES, [...PAYLOAD_FILES].sort());
  assert.ok(!PAYLOAD_FILES.includes("rootfs/etc/blitz/env.defaults"));
  for (const service of ["cgroups", "init-state", "register", "rules"]) {
    assert.ok(PAYLOAD_FILES.includes(`rootfs/etc/s6-overlay/s6-rc.d/${service}/up`));
  }
});

test("restart dependencies come from service sources plus the narrow override table", async () => {
  const restart = await readPayloadRestartMap(repoRoot);
  const servicesWithPayloadScripts = PAYLOAD_ROOTFS_PATHS
    .map((relativePath) => /^etc\/s6-overlay\/s6-rc\.d\/([^/]+)\/run$/u.exec(relativePath)?.[1])
    .filter((service) => service !== undefined && service !== "payload")
    .sort();
  for (const service of Object.keys(restart)) {
    assert.ok(servicesWithPayloadScripts.includes(service), service);
  }
  assert.ok(restart.gateway.includes("rootfs/usr/local/bin/blitz-box-gateway"));
  assert.ok(restart["lody-bridge"].includes("rootfs/usr/local/libexec/blitz-lody-bridge"));
  assert.ok(restart["machine-stats"].includes("rootfs/usr/local/bin/blitz-machine-stats"));
  assert.equal(restart.watch.includes("rootfs/usr/local/bin/blitz-cred"), false);
  assert.equal(restart.ttyd.includes("rootfs/usr/local/libexec/blitz-term"), false);
  for (const oneshot of ["cgroups", "init-state", "register", "rules"]) {
    assert.equal(restart[oneshot], undefined);
  }
  for (const dependencies of Object.values(restart)) {
    assert.deepEqual(dependencies, [...dependencies].sort());
    for (const dependency of dependencies) assert.ok(PAYLOAD_FILES.includes(dependency));
  }
});

test("image installation symlinks the complete s6 tree and ordinary payload paths", async () => {
  const payload = temporaryDirectory("blitz-payload-copy-");
  await copyPayloadSources(repoRoot, payload);
  assert.equal(
    statSync(path.join(payload, "rootfs/usr/local/libexec/blitz-lody-bridge")).mode & 0o777,
    await payloadMode(repoRoot, "rootfs/usr/local/libexec/blitz-lody-bridge"),
  );
  assert.equal(
    statSync(path.join(payload, "rootfs/etc/s6-overlay/s6-rc.d/gateway/run")).mode & 0o777,
    0o755,
  );
  assert.equal(
    statSync(path.join(payload, "rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d")).mode & 0o777,
    0o755,
  );
  assert.equal(statSync(path.join(payload, "rootfs/usr/local/libexec")).mode & 0o777, 0o755);

  const imageRoot = temporaryDirectory("blitz-payload-links-");
  await copyPayloadSources(repoRoot, imageRoot);
  await installPayloadIndirections(imageRoot);
  assert.equal(
    readlinkSync(path.join(imageRoot, "usr/local/bin/blitz")),
    "/opt/blitz/payload/current/rootfs/usr/local/bin/blitz",
  );
  assert.equal(
    readlinkSync(path.join(imageRoot, "etc/s6-overlay/s6-rc.d")),
    "/opt/blitz/payload/current/rootfs/etc/s6-overlay/s6-rc.d",
  );
});

test("source executable bits define modes for non-run service files", async () => {
  const repository = temporaryDirectory("blitz-payload-mode-repo-");
  const copiedRootfs = path.join(repository, "packages/box/rootfs");
  cpSync(rootfs, copiedRootfs, { recursive: true });
  const finish = path.join(copiedRootfs, "etc/s6-overlay/s6-rc.d/gateway/finish");
  writeFileSync(finish, "#!/bin/sh\nexit 0\n");
  chmodSync(finish, 0o755);
  const destination = temporaryDirectory("blitz-payload-mode-copy-");

  assert.ok((await payloadFilesForRepo(repository)).includes(
    "rootfs/etc/s6-overlay/s6-rc.d/gateway/finish",
  ));
  await copyPayloadSources(repository, destination);

  assert.equal(
    statSync(path.join(destination, "rootfs/etc/s6-overlay/s6-rc.d/gateway/finish")).mode & 0o777,
    0o755,
  );
});
