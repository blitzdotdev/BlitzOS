import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  copyPayloadSources,
  installPayloadIndirections,
  PAYLOAD_FILES,
  PAYLOAD_GENERATED_PATHS,
  PAYLOAD_ROOTFS_PATHS,
  payloadMode,
  readPayloadRestartMap,
} from "../scripts/lib/box-payload-files.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rootfs = path.join(repoRoot, "packages/box/rootfs");
const temporaryDirectories = [];
// These two files are the recovery mechanism, not content it manages. Pin the
// exception just as explicitly as the payload inventory so a new box script
// cannot accidentally escape ownership by joining an open-ended allowlist.
const BASE_OWNED_ROOTFS_PATHS = [
  "etc/s6-overlay/s6-rc.d/payload/run",
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

test("the checked-in inventory owns every eligible rootfs file", () => {
  const discovered = [
    ...filesBelow(path.join(rootfs, "usr/local/bin")),
    ...filesBelow(path.join(rootfs, "usr/local/libexec")),
    ...filesBelow(path.join(rootfs, "opt/blitz/skel")),
    ...filesBelow(path.join(rootfs, "etc/s6-overlay/s6-rc.d"))
      .filter((relativePath) => /\/(?:run|up)$/u.test(relativePath)),
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
  assert.equal(new Set(PAYLOAD_FILES).size, PAYLOAD_FILES.length);
  assert.deepEqual(PAYLOAD_FILES, [...PAYLOAD_FILES].sort());
  assert.ok(PAYLOAD_FILES.includes("rootfs/etc/blitz/env.defaults"));
});

test("restart dependencies come from service sources plus the narrow override table", async () => {
  const restart = await readPayloadRestartMap(repoRoot);
  const servicesWithPayloadScripts = PAYLOAD_ROOTFS_PATHS
    .map((relativePath) => /^etc\/s6-overlay\/s6-rc\.d\/([^/]+)\/(?:run|up)$/u.exec(relativePath)?.[1])
    .filter((service) => service !== undefined)
    .sort();
  assert.deepEqual(Object.keys(restart), servicesWithPayloadScripts);
  assert.ok(restart.gateway.includes("rootfs/usr/local/bin/blitz-box-gateway"));
  assert.ok(restart["lody-bridge"].includes("rootfs/usr/local/libexec/blitz-lody-bridge"));
  assert.ok(restart["machine-stats"].includes("rootfs/usr/local/bin/blitz-machine-stats"));
  assert.equal(restart.watch.includes("rootfs/usr/local/bin/blitz-cred"), false);
  assert.equal(restart.ttyd.includes("rootfs/usr/local/libexec/blitz-term"), false);
  for (const dependencies of Object.values(restart)) {
    assert.deepEqual(dependencies, [...dependencies].sort());
    for (const dependency of dependencies) assert.ok(PAYLOAD_FILES.includes(dependency));
  }
});

test("copy and image installation use the canonical modes and current indirections", async () => {
  const payload = temporaryDirectory("blitz-payload-copy-");
  await copyPayloadSources(repoRoot, payload);
  assert.equal(
    statSync(path.join(payload, "rootfs/usr/local/libexec/blitz-lody-bridge")).mode & 0o777,
    payloadMode("rootfs/usr/local/libexec/blitz-lody-bridge"),
  );
  assert.equal(
    statSync(path.join(payload, "rootfs/etc/s6-overlay/s6-rc.d/gateway/run")).mode & 0o777,
    0o755,
  );

  const imageRoot = temporaryDirectory("blitz-payload-links-");
  await copyPayloadSources(repoRoot, imageRoot);
  await installPayloadIndirections(imageRoot);
  assert.equal(
    readlinkSync(path.join(imageRoot, "usr/local/bin/blitz")),
    "/opt/blitz/payload/current/rootfs/usr/local/bin/blitz",
  );
  assert.match(
    readFileSync(path.join(imageRoot, "etc/s6-overlay/s6-rc.d/gateway/run"), "utf8"),
    /exec \/opt\/blitz\/payload\/current\/rootfs\/etc\/s6-overlay\/s6-rc\.d\/gateway\/run "\$@"/u,
  );
});
