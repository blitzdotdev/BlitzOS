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
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const temporaryDirectories = [];
const NEW_LODY_INPUTS = Object.freeze([
  "vendor/lody",
  "vendor/lody-adapters",
  "scripts/lody-build-package.mjs",
  "scripts/lody-npm-shrinkwrap.mjs",
  "scripts/lody-sync-adapters.mjs",
  "scripts/lody-package-manifest.json",
]);
const INPUT_FILES = Object.freeze({
  "packages/box": "packages/box/Dockerfile",
  "packages/broker": "packages/broker/main.go",
  "packages/schema/fixtures": "packages/schema/fixtures/example.json",
  "vendor/lody": "vendor/lody/package.json",
  "vendor/lody-adapters": "vendor/lody-adapters/core/package.json",
  "scripts/lody-build-package.mjs": "scripts/lody-build-package.mjs",
  "scripts/lody-npm-shrinkwrap.mjs": "scripts/lody-npm-shrinkwrap.mjs",
  "scripts/lody-sync-adapters.mjs": "scripts/lody-sync-adapters.mjs",
  "scripts/lody-package-manifest.json": "scripts/lody-package-manifest.json",
  "env.defaults": "env.defaults",
});

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
  for (const [index, relativePath] of BOX_IMAGE_INPUTS.entries()) {
    const filePath = path.join(repository, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `base input ${index}\n`);
  }
  const gitlink = path.join(repository, "vendor/lody/packages/example-adapter");
  mkdirSync(gitlink, { recursive: true });
  git(gitlink, ["init", "-q"]);
  git(gitlink, ["config", "user.email", "box-image-test@example.com"]);
  git(gitlink, ["config", "user.name", "Box Image Test"]);
  writeFileSync(path.join(gitlink, "package.json"), "{}\n");
  git(gitlink, ["add", "package.json"]);
  git(gitlink, ["commit", "-qm", "gitlink fixture"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "fixture"]);
  return repository;
}

function dockerfileCopySources(source) {
  const instructions = source.replaceAll(/\\\r?\n/gu, " ").split(/\r?\n/u);
  const sources = [];
  for (const instruction of instructions) {
    const trimmed = instruction.trim();
    if (!/^COPY\s/iu.test(trimmed)) continue;
    const body = trimmed.replace(/^COPY\s+/iu, "");
    if (body.startsWith("[")) {
      const paths = JSON.parse(body);
      sources.push(...paths.slice(0, -1));
      continue;
    }
    const words = body.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/gu) ?? [];
    if (words.some((word) => word === "--from" || word.startsWith("--from="))) continue;
    while (words[0]?.startsWith("--")) words.shift();
    for (const input of words.slice(0, -1)) {
      const unquoted = input.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2");
      if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(unquoted)) sources.push(unquoted);
    }
  }
  return sources;
}

function inputCoversSource(input, source) {
  const normalized = source.replace(/^\.\//u, "").replace(/\/$/u, "");
  return normalized === input || normalized.startsWith(`${input}/`);
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
  assert.match(
    git(source, ["ls-tree", "HEAD", "vendor/lody/packages/example-adapter"]),
    /^160000 commit [a-f0-9]{40}\t/u,
  );
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

test("every build-context Dockerfile COPY source is a release-key input", () => {
  const dockerfile = readFileSync(path.join(repositoryRoot, "packages/box/Dockerfile"), "utf8");
  const uncovered = dockerfileCopySources(dockerfile).filter(
    (source) => !BOX_IMAGE_INPUTS.some((input) => inputCoversSource(input, source)),
  );
  assert.deepEqual(uncovered, []);
});

test("a change under every Lody build input moves the release id", async () => {
  const repository = createInputRepository();
  const baseline = boxImageReleaseId(
    await readBoxImageInputIds({ repo: repository, rev: "HEAD" }),
  );

  for (const input of NEW_LODY_INPUTS) {
    const relativePath = INPUT_FILES[input];
    assert.notEqual(relativePath, undefined);
    const file = path.join(repository, relativePath);
    const original = readFileSync(file, "utf8");
    writeFileSync(file, `${original}changed\n`);
    git(repository, ["add", relativePath]);
    git(repository, ["commit", "-qm", `change ${input}`]);
    const changed = boxImageReleaseId(
      await readBoxImageInputIds({ repo: repository, rev: "HEAD" }),
    );
    assert.notEqual(changed, baseline, input);

    writeFileSync(file, original);
    git(repository, ["add", relativePath]);
    git(repository, ["commit", "-qm", `restore ${input}`]);
    const restored = boxImageReleaseId(
      await readBoxImageInputIds({ repo: repository, rev: "HEAD" }),
    );
    assert.equal(restored, baseline, input);
  }
});

test("a missing input at the requested revision is a hard error", async () => {
  const repository = createInputRepository();
  const missing = "packages/box/rootfs/usr/local/libexec/blitz-payload";
  git(repository, ["rm", "-q", missing]);
  git(repository, ["commit", "-qm", "remove required input"]);

  await assert.rejects(
    () => readBoxImageInputIds({ repo: repository, rev: "HEAD" }),
    new RegExp(`box-image input is missing at HEAD: ${missing}`, "u"),
  );
});

test("payload and daemon-only commits keep the base image release id", async () => {
  const repository = createInputRepository();
  const before = boxImageReleaseId(await readBoxImageInputIds({ repo: repository }));
  for (const [relativePath, contents] of [
    ["packages/box/rootfs/usr/local/bin/blitz", "payload edit\n"],
    ["packages/box/rootfs/etc/s6-overlay/s6-rc.d/gateway/run", "payload run edit\n"],
    ["vendor/lody/UPSTREAM.md", "daemon edit\n"],
  ]) {
    const filePath = path.join(repository, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "payload only"]);

  assert.equal(boxImageReleaseId(await readBoxImageInputIds({ repo: repository })), before);

  writeFileSync(path.join(repository, "env.defaults"), "changed base defaults\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "base defaults change"]);
  assert.notEqual(boxImageReleaseId(await readBoxImageInputIds({ repo: repository })), before);
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
