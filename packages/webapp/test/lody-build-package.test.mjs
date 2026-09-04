import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBuildStamp,
  distContentSha256,
  normalizePackagePath,
  packageManifestReport,
  publishPackageOutput,
  readPackageManifest,
} from "../../../scripts/lody-build-package.mjs";

const scratch = [];

afterEach(() => {
  for (const directory of scratch.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("the Lody package build stamp", () => {
  it("has the reviewed field order and five adapter pins", () => {
    const adapterShas = {
      core: "3".repeat(40),
      claude: "4".repeat(40),
      codex: "5".repeat(40),
      dsh: "6".repeat(40),
      grok: "7".repeat(40),
    };
    const stamp = createBuildStamp(
      "1".repeat(40),
      "2".repeat(40),
      adapterShas,
      "8".repeat(64),
      "9".repeat(64),
      "2026-09-04T00:00:00.000Z",
      "22.20.0",
      "10.20.0",
    );

    expect(Object.keys(stamp)).toEqual([
      "upstreamSha",
      "subtreeCommit",
      "adapterShas",
      "lockfileSha256",
      "distSha256",
      "builtAt",
      "node",
      "pnpm",
    ]);
    expect(stamp.adapterShas).toEqual(adapterShas);
  });

  it("hashes every dist file except the self-referential stamp", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lody-dist-hash-"));
    scratch.push(root);
    mkdirSync(path.join(root, "chunks"));
    writeFileSync(path.join(root, "index.js"), "first\n");
    writeFileSync(path.join(root, "chunks", "worker.js"), "worker\n");
    writeFileSync(path.join(root, "BUILD.json"), "one\n");
    const first = distContentSha256(root);
    writeFileSync(path.join(root, "BUILD.json"), "two\n");
    expect(distContentSha256(root)).toBe(first);
    writeFileSync(path.join(root, "index.js"), "second\n");
    expect(distContentSha256(root)).not.toBe(first);
  });
});

describe("the reviewed Lody package manifest", () => {
  it("normalizes only Vite chunk hashes and preserves multiplicity", () => {
    expect(normalizePackagePath("package/dist/chunks/index-C9ZZe-9e.js")).toBe(
      "package/dist/chunks/index-[hash].js",
    );
    expect(normalizePackagePath("package/dist/index.js")).toBe(
      "package/dist/index.js",
    );

    const expected = readPackageManifest();
    let chunk = 0;
    const actual = expected.map((entry) => {
      if (!entry.includes("[hash]")) return entry;
      chunk += 1;
      return entry.replace("[hash]", `h${String(chunk).padStart(7, "0")}`);
    });
    expect(packageManifestReport(expected, actual)).toEqual({
      missing: [],
      extra: [],
    });
  });

  it("fails closed on missing entries while reporting additions separately", () => {
    const expected = [
      "package/dist/index.js",
      "package/dist/chunks/acp-[hash].js",
    ];
    expect(packageManifestReport(expected, ["package/dist/index.js"])).toEqual({
      missing: ["package/dist/chunks/acp-[hash].js"],
      extra: [],
    });
    expect(
      packageManifestReport(expected, [
        "package/dist/index.js",
        "package/dist/chunks/acp-Abcd1234.js",
        "package/dist/new-worker.js",
      ]),
    ).toEqual({ missing: [], extra: ["package/dist/new-worker.js"] });
  });
});

describe("Lody package publication", () => {
  it("publishes into an empty output despite an interrupted sibling staging directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lody-publish-"));
    scratch.push(root);
    const sourceTarball = path.join(root, "lody-2.0.0.tgz");
    const output = path.join(root, "artifact");
    writeFileSync(sourceTarball, "new tarball\n");
    mkdirSync(output);
    const interrupted = path.join(root, ".artifact.publish-interrupted");
    mkdirSync(interrupted);
    writeFileSync(
      path.join(interrupted, "lody-1.0.0.tgz"),
      "partial tarball\n",
    );

    const published = publishPackageOutput(
      sourceTarball,
      '{"upstreamSha":"new"}\n',
      output,
    );

    expect(readdirSync(output).sort()).toEqual([
      "BUILD.json",
      "lody-2.0.0.tgz",
    ]);
    expect(readFileSync(published.tarball, "utf8")).toBe("new tarball\n");
    expect(readFileSync(published.stampFile, "utf8")).toBe(
      '{"upstreamSha":"new"}\n',
    );
    expect(readFileSync(path.join(interrupted, "lody-1.0.0.tgz"), "utf8")).toBe(
      "partial tarball\n",
    );
  });

  it("refuses a non-empty output directory without replacing its contents", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lody-publish-refuse-"));
    scratch.push(root);
    const sourceTarball = path.join(root, "lody-2.0.0.tgz");
    const output = path.join(root, "artifact");
    writeFileSync(sourceTarball, "new tarball\n");
    mkdirSync(output);
    writeFileSync(path.join(output, "BUILD.json"), "existing stamp\n");

    expect(() =>
      publishPackageOutput(sourceTarball, '{"upstreamSha":"new"}\n', output),
    ).toThrow(/--out must name a nonexistent or empty directory/u);
    expect(readdirSync(output)).toEqual(["BUILD.json"]);
    expect(readFileSync(path.join(output, "BUILD.json"), "utf8")).toBe(
      "existing stamp\n",
    );
  });
});
