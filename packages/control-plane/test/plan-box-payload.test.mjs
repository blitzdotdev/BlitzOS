import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BOX_PAYLOAD_INPUTS,
  boxPayloadPrefix,
  boxPayloadVersion,
  readBoxPayloadInputIds,
} from "../scripts/box-payload-key.mjs";
import { planBoxPayload } from "../scripts/plan-box-payload.mjs";

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

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function createInputRepository() {
  const repository = temporaryDirectory("blitz-box-payload-plan-");
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.email", "box-payload-test@example.com"]);
  git(repository, ["config", "user.name", "Box Payload Test"]);
  for (const inputPath of BOX_PAYLOAD_INPUTS) {
    const fileLike = /(?:Dockerfile|env\.defaults|go\.mod|\.(?:md|mjs|ts))$/u.test(inputPath);
    const filePath = fileLike ? inputPath : path.join(inputPath, "fixture");
    const absolute = path.join(repository, filePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${inputPath}\n`);
  }
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "fixture"]);
  return repository;
}

async function expected(repository) {
  const version = boxPayloadVersion(await readBoxPayloadInputIds({ repo: repository }));
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
  const repository = createInputRepository();
  const release = await expected(repository);
  const requested = [];
  const result = await planBoxPayload({
    url: "https://cp.example",
    repo: repository,
    fetchImpl: async (url, init) => {
      requested.push({ url, accept: init.headers.accept });
      return new Response(JSON.stringify(manifest(release.version)), { status: 200 });
    },
  });
  assert.deepEqual(result, { published: true, ...release, sha256: "b".repeat(64) });
  assert.deepEqual(requested, [{ url: release.ref, accept: "application/json" }]);
});

test("404 plans a publish while other responses fail closed", async () => {
  const repository = createInputRepository();
  const release = await expected(repository);
  assert.deepEqual(await planBoxPayload({
    url: "https://cp.example",
    repo: repository,
    fetchImpl: async () => new Response("missing", { status: 404 }),
  }), { published: false, ...release });
  await assert.rejects(() => planBoxPayload({
    url: "https://cp.example",
    repo: repository,
    fetchImpl: async () => new Response("unavailable", { status: 500 }),
  }), /answered 500; refusing to treat it as unpublished/u);
});

test("a malformed or mismatched manifest is never reused", async () => {
  const repository = createInputRepository();
  await assert.rejects(() => planBoxPayload({
    url: "https://cp.example",
    repo: repository,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  }), /invalid box-payload manifest/u);
  await assert.rejects(() => planBoxPayload({
    url: "https://cp.example",
    repo: repository,
    fetchImpl: async () => new Response(JSON.stringify(manifest("another")), { status: 200 }),
  }), /returned version another, expected/u);
  const release = await expected(repository);
  const unknownService = manifest(release.version);
  unknownService.restart["future-service"] = ["rootfs/usr/local/bin/blitz"];
  await assert.rejects(() => planBoxPayload({
    url: "https://cp.example",
    repo: repository,
    fetchImpl: async () => new Response(JSON.stringify(unknownService), { status: 200 }),
  }), /restart names unknown service: future-service/u);
});

test("--print-version derives the Docker build stamp without probing an origin", () => {
  const repository = createInputRepository();
  const run = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/plan-box-payload.mjs", import.meta.url)),
    "--repo", repository,
    "--print-version",
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^[a-f0-9]{64}\n$/u);
});
