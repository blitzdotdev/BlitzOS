import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKER_SOURCE, createBoxImageAssetSet, managedFileId } from "../scripts/build-blitzdev.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("managed box-image file attempt", () => {
  it("preserves manifest/part logical keys, verifies hashes, and activates the manifest last", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "blitz-box-files-"));
    temporaryDirectories.push(directory);
    const parts = [
      { name: "archive.part1", body: "first" },
      { name: "archive.part2", body: "second" },
    ];
    for (const part of parts) await writeFile(path.join(directory, part.name), part.body);
    const manifest = {
      parts: parts.map((part) => ({ name: part.name, sha256: digest(part.body) })),
      totalSha256: digest(parts.map(({ body }) => body).join("")),
      imageTag: "blitz-box:test",
    };
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));

    const assets = await createBoxImageAssetSet(manifestPath);
    expect(assets.releaseId).toBe(manifest.totalSha256);
    expect(assets.files.map(({ logicalPath }) => logicalPath)).toEqual([
      "box-image/archive.part1",
      "box-image/archive.part2",
      "box-image/manifest.json",
    ]);
    expect(assets.files.at(-1)?.mediaType).toBe("application/json; charset=utf-8");
    expect(managedFileId("box-image", "box-image/manifest.json")).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a part before upload when the immutable manifest hash does not match", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "blitz-box-files-invalid-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "archive.part1"), "changed");
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      parts: [{ name: "archive.part1", sha256: digest("expected") }],
      totalSha256: digest("expected"),
      imageTag: "blitz-box:test",
    }));

    await expect(createBoxImageAssetSet(manifestPath)).rejects.toThrow("part SHA-256 mismatch");
  });

  it("routes the existing core box-image keys through the managed file store while preserving external fallback vars", () => {
    expect(WORKER_SOURCE).toContain('managedBlobStore(context.get("$db") as $Database, "box-image")');
    expect(WORKER_SOURCE).toContain("boxImageRef: env.BOX_IMAGE_REF");
    expect(WORKER_SOURCE).toContain("boxImageSha256: env.BOX_IMAGE_SHA256");
    expect(WORKER_SOURCE).toContain("boxImageTag: env.BOX_IMAGE_TAG");
  });
});
