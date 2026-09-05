import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { boxPayloadPrefix } from "../scripts/box-payload-key.mjs";
import {
  buildPlannedPayload,
  planBoxPayload,
} from "../scripts/plan-box-payload.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const temporaryDirectories = [];

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function binaries(suffix = "") {
  const directory = temporaryDirectory("blitz-box-payload-plan-binaries-");
  for (const name of ["blitz-box-gateway"]) {
    const filePath = path.join(directory, name);
    writeFileSync(filePath, `binary:${name}${suffix}\n`);
    chmodSync(filePath, 0o755);
  }
  return directory;
}

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test.after(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function expected(binariesDirectory) {
  const version = await buildPlannedPayload({ repo: repoRoot, binariesDirectory });
  const prefix = boxPayloadPrefix(version);
  return { version, prefix, ref: `https://cp.example/${prefix}/manifest.json` };
}

function manifest(version) {
  return {
    version,
    createdAt: 1,
    minUpdater: 2,
    files: [
      { path: "rootfs/usr/local/bin/blitz", sha256: "a".repeat(64), mode: "0755" },
      {
        path: "rootfs/etc/s6-overlay/s6-rc.d/gateway/run",
        sha256: "c".repeat(64),
        mode: "0755",
      },
      {
        path: "rootfs/etc/s6-overlay/s6-rc.d/gateway/type",
        sha256: "d".repeat(64),
        mode: "0644",
      },
    ],
    directories: ["rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d"],
    archive: {
      url: `https://cp.example/box-payload/${version}/payload.tar.gz`,
      sha256: "b".repeat(64),
      bytes: 1,
    },
    restart: {},
  };
}

test("a matching manifest is reused and reports the archive digest", async () => {
  const binariesDirectory = binaries();
  const release = await expected(binariesDirectory);
  const requested = [];
  const result = await planBoxPayload({
    url: "https://cp.example",
    repo: repoRoot,
    binariesDirectory,
    fetchImpl: async (url, init) => {
      requested.push({ url, accept: init.headers.accept });
      return new Response(JSON.stringify(manifest(release.version)), { status: 200 });
    },
  });
  assert.deepEqual(result, { published: true, ...release, sha256: "b".repeat(64) });
  assert.deepEqual(requested, [{ url: release.ref, accept: "application/json" }]);
});

test("a protocol 1 manifest is never reused as current publisher output", async () => {
  const binariesDirectory = binaries();
  const release = await expected(binariesDirectory);
  const protocol1 = manifest(release.version);
  protocol1.minUpdater = 1;

  await assert.rejects(() => planBoxPayload({
    url: "https://cp.example",
    repo: repoRoot,
    binariesDirectory,
    fetchImpl: async () => new Response(JSON.stringify(protocol1), { status: 200 }),
  }), /outside the publisher protocol 2 shape/u);
});

test("a protocol 2 manifest missing publisher-required fields is never reused", async () => {
  const binariesDirectory = binaries();
  const release = await expected(binariesDirectory);
  const incomplete = manifest(release.version);
  delete incomplete.directories;

  await assert.rejects(() => planBoxPayload({
    url: "https://cp.example",
    repo: repoRoot,
    binariesDirectory,
    fetchImpl: async () => new Response(JSON.stringify(incomplete), { status: 200 }),
  }), /outside the publisher protocol 2 shape/u);
});

test("404 plans a publish while other responses fail closed", async () => {
  const binariesDirectory = binaries();
  const release = await expected(binariesDirectory);
  assert.deepEqual(await planBoxPayload({
    url: "https://cp.example",
    repo: repoRoot,
    binariesDirectory,
    fetchImpl: async () => new Response("missing", { status: 404 }),
  }), { published: false, ...release });
  await assert.rejects(() => planBoxPayload({
    url: "https://cp.example",
    repo: repoRoot,
    binariesDirectory,
    fetchImpl: async () => new Response("unavailable", { status: 500 }),
  }), /answered 500; refusing to treat it as unpublished/u);
});

test("a malformed or mismatched manifest is never reused", async () => {
  const binariesDirectory = binaries();
  await assert.rejects(() => planBoxPayload({
    url: "https://cp.example",
    repo: repoRoot,
    binariesDirectory,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  }), /invalid box-payload manifest/u);
  await assert.rejects(() => planBoxPayload({
    url: "https://cp.example",
    repo: repoRoot,
    binariesDirectory,
    fetchImpl: async () => new Response(JSON.stringify(manifest("another")), { status: 200 }),
  }), /returned version another, expected/u);
  const release = await expected(binariesDirectory);
  const unknownService = manifest(release.version);
  unknownService.restart["future-service"] = ["rootfs/usr/local/bin/blitz"];
  await assert.rejects(() => planBoxPayload({
    url: "https://cp.example",
    repo: repoRoot,
    binariesDirectory,
    fetchImpl: async () => new Response(JSON.stringify(unknownService), { status: 200 }),
  }), /restart names a service without a tree longrun: future-service/u);
});

test("identical built content keeps its version while a binary change moves it", async () => {
  const first = await buildPlannedPayload({ repo: repoRoot, binariesDirectory: binaries() });
  const second = await buildPlannedPayload({ repo: repoRoot, binariesDirectory: binaries() });
  const changed = await buildPlannedPayload({ repo: repoRoot, binariesDirectory: binaries("-changed") });
  assert.equal(second, first);
  assert.notEqual(changed, first);
});

test("base edits stay stable while service graphs and source modes move the payload version", async () => {
  const parent = temporaryDirectory("blitz-box-payload-commits-");
  const repository = path.join(parent, "repo");
  git(parent, ["clone", "-q", "--shared", repoRoot, repository]);
  git(repository, ["config", "user.email", "box-payload-test@example.com"]);
  git(repository, ["config", "user.name", "Box Payload Test"]);
  writeFileSync(
    path.join(repository, "packages/box/rootfs/etc/s6-overlay/s6-rc.d/user/type"),
    "bundle\n",
  );
  mkdirSync(
    path.join(repository, "packages/box/rootfs/etc/s6-overlay/s6-rc.d/user2"),
    { recursive: true },
  );
  writeFileSync(
    path.join(repository, "packages/box/rootfs/etc/s6-overlay/s6-rc.d/user2/type"),
    "bundle\n",
  );
  const binariesDirectory = binaries();
  const before = await buildPlannedPayload({ repo: repository, binariesDirectory });
  appendFileSync(
    path.join(repository, "packages/box/rootfs/usr/local/libexec/blitz-payload"),
    "\n// base-only test edit\n",
  );
  git(repository, ["add", "packages/box/rootfs"]);
  git(repository, ["commit", "-qm", "edit base-owned payload updater"]);

  const after = await buildPlannedPayload({ repo: repository, binariesDirectory });

  assert.equal(after, before);
  appendFileSync(
    path.join(repository, "packages/box/rootfs/etc/s6-overlay/s6-rc.d/payload/run"),
    "\n# payload-owned service edit\n",
  );
  const afterServiceEdit = await buildPlannedPayload({ repo: repository, binariesDirectory });
  assert.notEqual(afterServiceEdit, before);

  const serviceRoot = path.join(
    repository,
    "packages/box/rootfs/etc/s6-overlay/s6-rc.d/hello",
  );
  mkdirSync(serviceRoot, { recursive: true });
  writeFileSync(path.join(serviceRoot, "type"), "longrun\n");
  writeFileSync(path.join(serviceRoot, "run"), "#!/bin/sh\nexec /usr/local/bin/blitz\n");
  chmodSync(path.join(serviceRoot, "run"), 0o755);
  writeFileSync(
    path.join(repository, "packages/box/rootfs/etc/s6-overlay/s6-rc.d/user/contents.d/hello"),
    "",
  );
  const withService = await buildPlannedPayload({ repo: repository, binariesDirectory });
  assert.notEqual(withService, afterServiceEdit);

  mkdirSync(path.join(serviceRoot, "dependencies.d"));
  writeFileSync(path.join(serviceRoot, "dependencies.d/register"), "");
  const withDependency = await buildPlannedPayload({ repo: repository, binariesDirectory });
  assert.notEqual(withDependency, withService);
  rmSync(path.join(serviceRoot, "dependencies.d"), { recursive: true });
  const withoutDependency = await buildPlannedPayload({ repo: repository, binariesDirectory });
  assert.equal(withoutDependency, withService);

  chmodSync(path.join(serviceRoot, "run"), 0o644);
  const withModeOnlyChange = await buildPlannedPayload({ repo: repository, binariesDirectory });
  assert.notEqual(withModeOnlyChange, withService);

  rmSync(serviceRoot, { recursive: true });
  rmSync(
    path.join(repository, "packages/box/rootfs/etc/s6-overlay/s6-rc.d/user/contents.d/hello"),
  );
  const withoutService = await buildPlannedPayload({ repo: repository, binariesDirectory });
  assert.equal(withoutService, afterServiceEdit);
});

test("--print-version dry-builds the Docker stamp without probing an origin", () => {
  const run = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/plan-box-payload.mjs", import.meta.url)),
    "--repo", repoRoot,
    "--binaries", binaries(),
    "--print-version",
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^[a-f0-9]{64}\n$/u);
});

test("a committed checkout and its git archive produce identical payload versions", async () => {
  const directory = temporaryDirectory("blitz-box-payload-git-archive-");
  const repository = path.join(directory, "repository");
  const archivedCheckout = path.join(directory, "archived-checkout");
  const archivePath = path.join(directory, "fixture.tar");
  mkdirSync(path.join(repository, "packages/box"), { recursive: true });
  cpSync(
    path.join(repoRoot, "packages/box/rootfs"),
    path.join(repository, "packages/box/rootfs"),
    { recursive: true },
  );
  const serviceRoot = path.join(
    repository,
    "packages/box/rootfs/etc/s6-overlay/s6-rc.d/gateway",
  );
  const executable = path.join(serviceRoot, "archive-executable");
  const nonExecutable = path.join(serviceRoot, "archive-non-executable");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  writeFileSync(nonExecutable, "plain payload source\n");
  chmodSync(nonExecutable, 0o644);
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.email", "box-payload-test@example.com"]);
  git(repository, ["config", "user.name", "Box Payload Test"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "payload mode fixture"]);

  const archived = spawnSync(
    "git",
    ["archive", "--format=tar", "--output", archivePath, "HEAD"],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(archived.status, 0, archived.stderr);
  mkdirSync(archivedCheckout);
  const extracted = spawnSync(
    "tar",
    ["-xf", archivePath, "-C", archivedCheckout],
    { encoding: "utf8" },
  );
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.notEqual(statSync(executable).mode & 0o111, 0);
  assert.equal(statSync(nonExecutable).mode & 0o111, 0);
  assert.notEqual(
    statSync(path.join(archivedCheckout, path.relative(repository, executable))).mode & 0o111,
    0,
  );
  assert.equal(
    statSync(path.join(archivedCheckout, path.relative(repository, nonExecutable))).mode & 0o111,
    0,
  );
  assert.equal(existsSync(path.join(archivedCheckout, "node_modules")), false);

  const binariesDirectory = binaries();
  const checkoutVersion = await buildPlannedPayload({ repo: repository, binariesDirectory });
  const archiveVersion = await buildPlannedPayload({
    repo: archivedCheckout,
    binariesDirectory,
  });
  assert.equal(archiveVersion, checkoutVersion);
});
