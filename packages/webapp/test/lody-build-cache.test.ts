// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAtomicBuildCache } from "./lody-build-cache.js";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the on-demand Lody build cache", () => {
  it("serializes concurrent resolvers and makes the waiter reuse the winner", async () => {
    const root = mkdtempSync(join(tmpdir(), "lody-build-cache-test-"));
    scratch.push(root);
    const cachePath = join(root, "upstream-sha", "source-fingerprint");
    let releaseBuild!: () => void;
    const buildMayFinish = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const build = vi.fn(async (staging: string) => {
      await buildMayFinish;
      mkdirSync(join(staging, "dist"), { recursive: true });
      writeFileSync(join(staging, "dist", "BUILD.json"), "winner\n");
    });
    const validate = (candidate: string): boolean =>
      existsSync(join(candidate, "dist", "BUILD.json"));

    const first = resolveAtomicBuildCache({ cachePath, build, validate });
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    const second = resolveAtomicBuildCache({ cachePath, build, validate });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(build).toHaveBeenCalledTimes(1);
    releaseBuild();

    await expect(Promise.all([first, second])).resolves.toEqual([
      cachePath,
      cachePath,
    ]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(cachePath, "dist", "BUILD.json"), "utf8")).toBe(
      "winner\n",
    );
    expect(existsSync(`${cachePath}.lock`)).toBe(false);
  });

  it("reclaims a lock whose owner process is gone", async () => {
    const root = mkdtempSync(join(tmpdir(), "lody-build-cache-stale-test-"));
    scratch.push(root);
    const cachePath = join(root, "upstream-sha", "source-fingerprint");
    mkdirSync(`${cachePath}.lock`, { recursive: true });
    writeFileSync(join(`${cachePath}.lock`, "pid"), "2147483647\n");
    const build = vi.fn((staging: string) => {
      mkdirSync(join(staging, "dist"), { recursive: true });
      writeFileSync(join(staging, "dist", "BUILD.json"), "recovered\n");
    });

    await expect(
      resolveAtomicBuildCache({
        cachePath,
        build,
        validate: (candidate) =>
          existsSync(join(candidate, "dist", "BUILD.json")),
      }),
    ).resolves.toBe(cachePath);
    expect(build).toHaveBeenCalledTimes(1);
    expect(existsSync(`${cachePath}.lock`)).toBe(false);
  });
});
