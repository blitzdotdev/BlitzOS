// @vitest-environment node

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cacheModule = pathToFileURL(join(here, "lody-build-cache.ts")).href;
const scratch: string[] = [];

const resolverProgram = String.raw`
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [moduleUrl, cachePath, barrier, resultPath, holdSource] = process.argv.slice(1);
const { resolveAtomicBuildCache } = await import(moduleUrl);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
process.stdout.write("READY\n");
while (!existsSync(barrier)) await pause(5);

let built = false;
await resolveAtomicBuildCache({
  cachePath,
  waitMs: 10_000,
  validate: (candidate) => existsSync(join(candidate, "dist", "BUILD.json")),
  build: async (staging) => {
    built = true;
    const lockPath = cachePath + ".lock";
    const ownerAtStart = readFileSync(lockPath, "utf8");
    writeFileSync(resultPath + ".entered", ownerAtStart);
    await pause(Number.parseInt(holdSource, 10));
    if (readFileSync(lockPath, "utf8") !== ownerAtStart) {
      throw new Error("another waiter replaced the active build lock");
    }
    mkdirSync(join(staging, "dist"), { recursive: true });
    writeFileSync(join(staging, "dist", "BUILD.json"), process.pid + "\n");
  },
});
writeFileSync(resultPath, built ? "built\n" : "reused\n");
`;

interface ResolverChild {
  ready: Promise<void>;
  done: Promise<void>;
}

function startResolver(
  cachePath: string,
  barrier: string,
  resultPath: string,
  holdMs: number,
): ResolverChild {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "--eval",
      resolverProgram,
      cacheModule,
      cachePath,
      barrier,
      resultPath,
      String(holdMs),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (output.includes("READY\n")) resolveReady();
  });
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
  });
  child.once("exit", (code, signal) => {
    if (output.includes("READY\n")) resolveReady();
    else {
      rejectReady(
        new Error(
          `resolver exited before ready (${code ?? signal ?? "unknown"}): ${errors}`,
        ),
      );
    }
  });
  child.once("error", rejectReady);
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `resolver exited ${code ?? signal ?? "without status"}: ${errors}`,
          ),
        );
      }
    });
  });
  return { ready, done };
}

async function raceResolvers(
  root: string,
  cachePath: string,
  count: number,
  holdMs: number,
): Promise<string[]> {
  const barrier = join(root, "start");
  const results = Array.from({ length: count }, (_, index) =>
    join(root, `result-${index}`),
  );
  const children = results.map((result) =>
    startResolver(cachePath, barrier, result, holdMs),
  );
  await Promise.all(children.map((child) => child.ready));
  writeFileSync(barrier, "go\n");
  await Promise.all(children.map((child) => child.done));
  return results.map((result) => readFileSync(result, "utf8").trim());
}

function writeDeadOwner(lockPath: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      String.raw`
import { readFileSync } from "node:fs";
let startTime = "";
if (process.platform === "linux") {
  const source = readFileSync("/proc/" + process.pid + "/stat", "utf8");
  const fields = source.slice(source.lastIndexOf(")") + 1).trim().split(/\s+/u);
  startTime = fields[19];
}
process.stdout.write(process.pid + "\n" + startTime + "\n");
`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`dead-owner helper failed: ${result.stderr}`);
  }
  const [pidSource, startTime = ""] = result.stdout.split("\n");
  const pid = Number.parseInt(pidSource ?? "", 10);
  if (!Number.isInteger(pid)) {
    throw new Error(
      `dead-owner helper returned invalid output: ${result.stdout}`,
    );
  }
  writeFileSync(
    lockPath,
    `${JSON.stringify({
      pid,
      startTime: startTime === "" ? null : startTime,
      hostname: hostname(),
      fingerprint: "dead-owner",
    })}\n`,
  );
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the on-demand Lody build cache", () => {
  it("serializes racing processes and makes every waiter reuse the winner", async () => {
    const root = mkdtempSync(join(tmpdir(), "lody-build-cache-race-"));
    scratch.push(root);
    const cachePath = join(root, "upstream-sha", "source-fingerprint");

    const outcomes = await raceResolvers(root, cachePath, 3, 300);

    expect(outcomes.filter((outcome) => outcome === "built")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "reused")).toHaveLength(2);
    expect(readFileSync(join(cachePath, "dist", "BUILD.json"), "utf8")).toMatch(
      /^\d+\n$/u,
    );
    expect(existsSync(`${cachePath}.lock`)).toBe(false);
  }, 15_000);

  it("reclaims a lock carrying the identity of a process that exited", async () => {
    const root = mkdtempSync(join(tmpdir(), "lody-build-cache-dead-"));
    scratch.push(root);
    const cachePath = join(root, "upstream-sha", "source-fingerprint");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeDeadOwner(`${cachePath}.lock`);

    await expect(raceResolvers(root, cachePath, 1, 0)).resolves.toEqual([
      "built",
    ]);
    expect(existsSync(`${cachePath}.lock`)).toBe(false);
  }, 15_000);

  it.skipIf(process.platform !== "linux")(
    "treats a live PID with a different process start time as stale",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lody-build-cache-reused-pid-"));
      scratch.push(root);
      const cachePath = join(root, "upstream-sha", "source-fingerprint");
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(
        `${cachePath}.lock`,
        `${JSON.stringify({
          pid: process.pid,
          startTime: "0",
          hostname: hostname(),
          fingerprint: "old-pid-generation",
        })}\n`,
      );

      await expect(raceResolvers(root, cachePath, 1, 0)).resolves.toEqual([
        "built",
      ]);
    },
    15_000,
  );

  it("gives concurrent stale reclamation to one winner without losing its lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "lody-build-cache-reclaim-"));
    scratch.push(root);
    const cachePath = join(root, "upstream-sha", "source-fingerprint");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeDeadOwner(`${cachePath}.lock`);

    const outcomes = await raceResolvers(root, cachePath, 2, 500);

    expect(outcomes.filter((outcome) => outcome === "built")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "reused")).toHaveLength(1);
    expect(
      readdirSync(dirname(cachePath)).filter((entry) =>
        entry.startsWith("source-fingerprint.lock"),
      ),
    ).toEqual([]);
  }, 15_000);
});
