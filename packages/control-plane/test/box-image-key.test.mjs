import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import {
  BOX_IMAGE_INPUTS,
  BOX_PAYLOAD_SOURCE_INPUTS,
} from "../scripts/lib/box-image-inputs.mjs";
import { PAYLOAD_ROOTFS_PATHS } from "../scripts/lib/box-payload-files.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/box-image-key.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
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
  for (const [index, relativePath] of BOX_IMAGE_INPUTS.entries()) {
    const filePath = path.join(repository, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `base input ${index}\n`);
  }
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "fixture"]);
  return repository;
}

/** Build-context sources of every COPY instruction; `--from` stages are not
 * repository inputs and are skipped. */
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

function coveredBy(inputs, relativePath) {
  return inputs.some((input) => relativePath === input || relativePath.startsWith(`${input}/`));
}

function filesBelow(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...filesBelow(path.join(directory, entry.name))
        .map((file) => path.join(entry.name, file)));
    } else {
      found.push(entry.name);
    }
  }
  return found;
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

// A COPY source that is neither a base input nor a payload input would bake
// bytes into the image that no release key names: the image would not rebuild
// when they change, and no payload would carry them either.
test("every build-context Dockerfile COPY source is a base input or a payload input", () => {
  const dockerfile = readFileSync(path.join(repositoryRoot, "packages/box/Dockerfile"), "utf8");
  const payloadInputs = [
    ...BOX_PAYLOAD_SOURCE_INPUTS,
    ...PAYLOAD_ROOTFS_PATHS.map((relativePath) => `packages/box/rootfs/${relativePath}`),
  ];
  const owned = (relativePath) =>
    coveredBy(BOX_IMAGE_INPUTS, relativePath) || coveredBy(payloadInputs, relativePath);
  const uncovered = [];
  for (const source of dockerfileCopySources(dockerfile)) {
    const normalized = source.replace(/^\.\//u, "").replace(/\/$/u, "");
    if (owned(normalized)) continue;
    // A directory split between the two owners (packages/box/rootfs) is
    // covered when every file below it is.
    const absolute = path.join(repositoryRoot, normalized);
    if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) {
      uncovered.push(normalized);
      continue;
    }
    for (const file of filesBelow(absolute)) {
      const relative = `${normalized}/${file}`;
      if (!owned(relative)) uncovered.push(relative);
    }
  }
  assert.deepEqual(uncovered, []);
});

// The key reads every declared input's Git object id at the release commit
// and refuses a missing one. The fixture repositories above are built FROM the
// list, so only this check notices when a deleted file stays declared: the
// `enroll` service left the tree in #213 while its two entries stayed here,
// and the canary image job would have died at the plan step.
test("every declared input exists in this repository", () => {
  const missing = [...BOX_IMAGE_INPUTS, ...BOX_PAYLOAD_SOURCE_INPUTS]
    .filter((input) => !existsSync(path.join(repositoryRoot, input)));
  assert.deepEqual(missing, []);
});

test("base inputs and payload source inputs do not overlap", () => {
  assert.equal(Object.isFrozen(BOX_PAYLOAD_SOURCE_INPUTS), true);
  for (const input of BOX_PAYLOAD_SOURCE_INPUTS) {
    assert.equal(coveredBy(BOX_IMAGE_INPUTS, input), false, input);
  }
  for (const input of BOX_IMAGE_INPUTS) {
    assert.equal(coveredBy(BOX_PAYLOAD_SOURCE_INPUTS, input), false, input);
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

test("payload, box configuration, daemon, and env.defaults keep the base image release id", async () => {
  const repository = createInputRepository();
  const before = boxImageReleaseId(await readBoxImageInputIds({ repo: repository }));
  for (const [relativePath, contents] of [
    ["packages/box/rootfs/usr/local/bin/blitz", "payload edit\n"],
    ["packages/box/rootfs/etc/s6-overlay/s6-rc.d/gateway/run", "payload run edit\n"],
    ["packages/box/rootfs/etc/s6-overlay/s6-rc.d/gateway/type", "longrun\n"],
    ["packages/box/rootfs/etc/s6-overlay/s6-rc.d/user/contents.d/new-service", ""],
    ["packages/box/rootfs/etc/blitz/sshd_config", "payload sshd config\n"],
    ["packages/box/rootfs/etc/gitconfig", "payload git config\n"],
    ["packages/box/rootfs/etc/profile.d/blitz-npm.sh", "payload profile\n"],
    ["packages/box/rootfs/etc/tmux.conf", "payload tmux config\n"],
    ["packages/box/gateway/main.go", "gateway edit\n"],
    ["vendor/lody/UPSTREAM.md", "daemon edit\n"],
    ["vendor/lody-adapters/core/package.json", "adapter edit\n"],
    ["scripts/lody-build-package.mjs", "build script edit\n"],
  ]) {
    const filePath = path.join(repository, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "payload only"]);

  assert.equal(boxImageReleaseId(await readBoxImageInputIds({ repo: repository })), before);

  writeFileSync(path.join(repository, "env.defaults"), "changed non-box defaults\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "documented defaults change"]);
  assert.equal(boxImageReleaseId(await readBoxImageInputIds({ repo: repository })), before);
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
