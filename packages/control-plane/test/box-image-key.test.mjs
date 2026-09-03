import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  boxImagePrefix,
  boxImageReleaseId,
  boxImageTag,
  readBoxImageInputIds,
} from "../scripts/box-image-key.mjs";
import { BOX_IMAGE_INPUTS } from "../scripts/lib/box-image-inputs.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/box-image-key.mjs", import.meta.url));
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
  return result.stdout.trim();
}

function createInputRepository() {
  const repository = temporaryDirectory("blitz-box-image-key-");
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.email", "box-image-test@example.com"]);
  git(repository, ["config", "user.name", "Box Image Test"]);
  const files = new Map([
    ["packages/box/Dockerfile", "FROM scratch\n"],
    ["packages/broker/main.go", "package main\n"],
    ["packages/schema/fixtures/example.json", "{}\n"],
    ["env.defaults", "BLITZ_LODY_SESSIONS=0\n"],
  ]);
  for (const [relativePath, contents] of files) {
    const filePath = path.join(repository, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "fixture"]);
  return repository;
}

test("release id hashes the ordered path and object-id records", () => {
  assert.equal(Object.isFrozen(BOX_IMAGE_INPUTS), true);
  const entries = BOX_IMAGE_INPUTS.map((inputPath, index) => ({
    path: inputPath,
    id: String(index + 1).repeat(40),
  }));
  const expected = createHash("sha256")
    .update(entries.map(({ path: inputPath, id }) => `${inputPath}\t${id}\n`).join(""))
    .digest("hex");

  assert.equal(boxImageReleaseId(entries), expected);
  assert.equal(boxImageTag(expected), `blitz-box:${expected}`);
  assert.equal(boxImagePrefix(expected), `box-image/${expected}`);
});

test("reads real tree and blob ids in Dockerfile input order from a depth-one checkout", async () => {
  const source = createInputRepository();
  const cloneRoot = temporaryDirectory("blitz-box-image-key-clone-");
  const clone = path.join(cloneRoot, "repo");
  git(cloneRoot, ["clone", "-q", "--depth", "1", `file://${source}`, clone]);

  const entries = await readBoxImageInputIds({ repo: clone, rev: "HEAD" });
  assert.deepEqual(entries.map(({ path: inputPath }) => inputPath), BOX_IMAGE_INPUTS);
  assert.deepEqual(
    entries.map(({ id }) => id),
    BOX_IMAGE_INPUTS.map((inputPath) => git(clone, ["rev-parse", `HEAD:${inputPath}`])),
  );
  assert.equal(git(clone, ["rev-list", "--count", "HEAD"]), "1");
});

test("a missing input at the requested revision is a hard error", async () => {
  const repository = createInputRepository();
  git(repository, ["rm", "-q", "env.defaults"]);
  git(repository, ["commit", "-qm", "remove required input"]);

  await assert.rejects(
    () => readBoxImageInputIds({ repo: repository, rev: "HEAD" }),
    /box-image input is missing at HEAD: env\.defaults/u,
  );
});

test("CLI prints the contracted JSON and mirrors it to --json", () => {
  const repository = createInputRepository();
  const jsonPath = path.join(temporaryDirectory("blitz-box-image-key-json-"), "key.json");
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--repo", repository, "--rev", "HEAD", "--json", jsonPath],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(stdout), ["releaseId", "imageTag", "prefix"]);
  assert.match(stdout.releaseId, /^[a-f0-9]{64}$/u);
  assert.equal(stdout.imageTag, `blitz-box:${stdout.releaseId}`);
  assert.equal(stdout.prefix, `box-image/${stdout.releaseId}`);
  assert.deepEqual(JSON.parse(readFileSync(jsonPath, "utf8")), stdout);
});
