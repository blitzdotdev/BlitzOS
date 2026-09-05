import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { boxPayloadPrefix } from "../scripts/box-payload-key.mjs";
import { PAYLOAD_ROOTFS_PATHS } from "../scripts/lib/box-payload-files.mjs";
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
    minUpdater: 1,
    files: [{ path: "rootfs/usr/local/bin/blitz", sha256: "a".repeat(64), mode: "0755" }],
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
  }), /restart names unknown service: future-service/u);
});

test("identical built content keeps its version while a binary change moves it", async () => {
  const first = await buildPlannedPayload({ repo: repoRoot, binariesDirectory: binaries() });
  const second = await buildPlannedPayload({ repo: repoRoot, binariesDirectory: binaries() });
  const changed = await buildPlannedPayload({ repo: repoRoot, binariesDirectory: binaries("-changed") });
  assert.equal(second, first);
  assert.notEqual(changed, first);
});

test("base-owned updater edits across commits do not move an identical payload", async () => {
  const parent = temporaryDirectory("blitz-box-payload-commits-");
  const repository = path.join(parent, "repo");
  git(parent, ["clone", "-q", "--shared", repoRoot, repository]);
  git(repository, ["config", "user.email", "box-payload-test@example.com"]);
  git(repository, ["config", "user.name", "Box Payload Test"]);
  // A no-commit merge can add payload files that `git clone` cannot see yet.
  // Mirror the current payload inventory into the fixture so both builds use
  // the same working-tree content the imported planner owns.
  for (const relativePath of PAYLOAD_ROOTFS_PATHS) {
    const source = path.join(repoRoot, "packages/box/rootfs", relativePath);
    const destination = path.join(repository, "packages/box/rootfs", relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  const binariesDirectory = binaries();
  const before = await buildPlannedPayload({ repo: repository, binariesDirectory });
  appendFileSync(
    path.join(repository, "packages/box/rootfs/usr/local/libexec/blitz-payload"),
    "\n// base-only test edit\n",
  );
  appendFileSync(
    path.join(repository, "packages/box/rootfs/etc/s6-overlay/s6-rc.d/payload/run"),
    "\n# base-only test edit\n",
  );
  git(repository, ["add", "packages/box/rootfs"]);
  git(repository, ["commit", "-qm", "edit base-owned payload updater"]);

  const after = await buildPlannedPayload({ repo: repository, binariesDirectory });

  assert.equal(after, before);
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

test("--print-version runs from a git archive without workspace dependencies", () => {
  const directory = temporaryDirectory("blitz-box-payload-clean-archive-");
  const archivePath = path.join(directory, "head.tar");
  const checkout = path.join(directory, "checkout");
  const archived = spawnSync("git", ["archive", "--format=tar", "--output", archivePath, "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync("tar", ["-xf", archivePath, "-C", directory], { encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);
  // Move the extracted tree under one explicit root so the absence assertion
  // cannot accidentally inspect this test's dependency-bearing checkout.
  mkdirSync(checkout);
  for (const entry of readdirSync(directory)) {
    if (entry === "checkout" || entry === "head.tar") continue;
    renameSync(path.join(directory, entry), path.join(checkout, entry));
  }
  assert.equal(existsSync(path.join(checkout, "node_modules")), false);

  const run = spawnSync(process.execPath, [
    path.join(checkout, "packages/control-plane/scripts/plan-box-payload.mjs"),
    "--repo", checkout,
    "--binaries", binaries(),
    "--print-version",
  ], { cwd: checkout, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^[a-f0-9]{64}\n$/u);
});
