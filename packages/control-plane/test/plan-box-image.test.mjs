import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
import { planBoxImage } from "../scripts/plan-box-image.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/plan-box-image.mjs", import.meta.url));
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
  const repository = temporaryDirectory("blitz-box-image-plan-");
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

async function expectedImage(repository) {
  const releaseId = boxImageReleaseId(
    await readBoxImageInputIds({ repo: repository, rev: "HEAD" }),
  );
  return {
    releaseId,
    imageTag: boxImageTag(releaseId),
    prefix: boxImagePrefix(releaseId),
    ref: `https://cp.example/${boxImagePrefix(releaseId)}/manifest.json`,
  };
}

function manifest(imageTag) {
  return {
    parts: [{ name: "part-000", sha256: "a".repeat(64) }],
    totalSha256: "b".repeat(64),
    imageTag,
  };
}

test("200 with a valid matching manifest reports the published digest", async () => {
  const repository = createInputRepository();
  const expected = await expectedImage(repository);
  const requested = [];
  const result = await planBoxImage({
    url: "https://cp.example/",
    repo: repository,
    fetchImpl: async (url, init) => {
      requested.push({ url, accept: init.headers.accept });
      return new Response(JSON.stringify(manifest(expected.imageTag)), { status: 200 });
    },
  });

  assert.deepEqual(result, { published: true, ...expected, sha256: "b".repeat(64) });
  assert.deepEqual(requested, [{ url: expected.ref, accept: "application/json" }]);
});

test("200 with a valid manifest for another tag is an error", async () => {
  const repository = createInputRepository();
  await assert.rejects(
    () => planBoxImage({
      url: "https://cp.example",
      repo: repository,
      fetchImpl: async () => new Response(
        JSON.stringify(manifest("blitz-box:another-release")),
        { status: 200 },
      ),
    }),
    /returned imageTag blitz-box:another-release, expected blitz-box:/u,
  );
});

test("200 with an invalid manifest is an error", async () => {
  const repository = createInputRepository();
  await assert.rejects(
    () => planBoxImage({
      url: "https://cp.example",
      repo: repository,
      fetchImpl: async () => new Response('{"parts":[]}', { status: 200 }),
    }),
    /invalid box-image manifest/u,
  );
});

test("404 reports unpublished without a digest", async () => {
  const repository = createInputRepository();
  const expected = await expectedImage(repository);
  const result = await planBoxImage({
    url: "https://cp.example",
    repo: repository,
    fetchImpl: async () => new Response("missing", { status: 404 }),
  });

  assert.deepEqual(result, { published: false, ...expected });
  assert.equal("sha256" in result, false);
});

test("500 is an error rather than an unpublished plan", async () => {
  const repository = createInputRepository();
  await assert.rejects(
    () => planBoxImage({
      url: "https://cp.example",
      repo: repository,
      fetchImpl: async () => new Response("unavailable", { status: 500 }),
    }),
    /answered 500; refusing to treat it as unpublished/u,
  );
});

test("network failures retain the probed URL and fail the plan", async () => {
  const repository = createInputRepository();
  const expected = await expectedImage(repository);
  await assert.rejects(
    () => planBoxImage({
      url: "https://cp.example",
      repo: repository,
      fetchImpl: async () => {
        throw new Error("connection reset");
      },
    }),
    new RegExp(`GET ${expected.ref} failed: connection reset`, "u"),
  );
});

function runProcess(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

test("CLI writes the same unpublished plan to stdout and --json", async () => {
  const repository = createInputRepository();
  const jsonPath = path.join(temporaryDirectory("blitz-box-image-plan-json-"), "plan.json");
  const server = createServer((_request, response) => {
    response.writeHead(404).end("missing");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || String(address) === address) {
      throw new Error("test HTTP server did not bind a TCP port");
    }
    const result = await runProcess([
      scriptPath,
      "--url", `http://127.0.0.1:${address.port}`,
      "--repo", repository,
      "--json", jsonPath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(jsonPath, "utf8")), JSON.parse(result.stdout));
    assert.equal(JSON.parse(result.stdout).published, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }));
  }
});
