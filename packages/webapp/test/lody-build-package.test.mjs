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
  packageManifestReport,
  publishPackageOutput,
  readPackageManifest,
} from "../../../scripts/lody-build-package.mjs";
import {
  createLodyNpmShrinkwrap,
  pnpmIgnoredBuildDependencies,
} from "../../../scripts/lody-npm-shrinkwrap.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

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
      "22.20.0",
      "10.20.0",
    );

    expect(Object.keys(stamp)).toEqual([
      "upstreamSha",
      "subtreeCommit",
      "adapterShas",
      "lockfileSha256",
      "distSha256",
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
  it("requires only fixed runtime assets and hashed WASM glue", () => {
    const expected = readPackageManifest();
    expect(expected).toHaveLength(15);
    const actual = expected.map((entry) =>
      entry.replace("[hash]", "Br-Fa9wV"),
    );
    expect(packageManifestReport(expected, actual)).toEqual({
      missing: [],
    });
  });

  it("fails closed on missing entries and permits unrelated chunks", () => {
    const expected = [
      "package/dist/index.js",
      "package/dist/chunks/acp-[hash].js",
    ];
    expect(packageManifestReport(expected, ["package/dist/index.js"])).toEqual({
      missing: ["package/dist/chunks/acp-[hash].js"],
    });
    expect(
      packageManifestReport(expected, [
        "package/dist/index.js",
        "package/dist/chunks/acp-Abcd1234.js",
        "package/dist/new-worker.js",
      ]),
    ).toEqual({ missing: [] });
  });
});

describe("the Lody npm shrinkwrap", () => {
  it("pins the real CLI production graph to pnpm versions and integrities", () => {
    const lodyRoot = path.join(repositoryRoot, "vendor/lody");
    const shrinkwrap = createLodyNpmShrinkwrap(
      readFileSync(path.join(lodyRoot, "pnpm-lock.yaml"), "utf8"),
      JSON.parse(
        readFileSync(
          path.join(lodyRoot, "apps/cli/package.json"),
          "utf8",
        ),
      ),
      pnpmIgnoredBuildDependencies(
        readFileSync(path.join(lodyRoot, "pnpm-workspace.yaml"), "utf8"),
      ),
    );

    expect(shrinkwrap.lockfileVersion).toBe(3);
    expect(shrinkwrap.packages[""].dependencies).toEqual({
      "@lydell/node-pty": "1.2.0-beta.14",
      "better-sqlite3": "^13.0.2",
      "loro-crdt": "1.15.1",
      "shell-env": "^4.0.3",
      tinypool: "^1.0.0",
      typescript: "^5.9.3",
    });
    expect(shrinkwrap.packages["node_modules/better-sqlite3"]).toMatchObject({
      version: "13.0.3",
      resolved: "https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz",
      integrity:
        "sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==",
      gypfile: false,
    });
    expect(shrinkwrap.packages["node_modules/@lydell/node-pty-linux-arm64"]).toMatchObject({
      version: "1.2.0-beta.14",
      cpu: ["arm64"],
      os: ["linux"],
      optional: true,
    });
    expect(Object.values(shrinkwrap.packages).slice(1)).toHaveLength(32);
    for (const entry of Object.values(shrinkwrap.packages).slice(1)) {
      expect(entry.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//u);
      expect(entry.integrity).toMatch(/^sha512-/u);
    }
  });

  it("nests a transitive version that conflicts with the hoisted version", () => {
    const lockfile = `lockfileVersion: '9.0'

importers:
  apps/cli:
    dependencies:
      first:
        specifier: 1.0.0
        version: 1.0.0
      second:
        specifier: 1.0.0
        version: 1.0.0

packages:
  first@1.0.0:
    resolution: {integrity: sha512-first}
  second@1.0.0:
    resolution: {integrity: sha512-second}
  shared@1.0.0:
    resolution: {integrity: sha512-shared-one}
  shared@2.0.0:
    resolution: {integrity: sha512-shared-two}

snapshots:
  first@1.0.0:
    dependencies:
      shared: 1.0.0
  second@1.0.0:
    dependencies:
      shared: 2.0.0
  shared@1.0.0: {}
  shared@2.0.0: {}
`;
    const shrinkwrap = createLodyNpmShrinkwrap(lockfile, {
      name: "fixture",
      version: "1.0.0",
      dependencies: { first: "1.0.0", second: "1.0.0" },
    });
    expect(shrinkwrap.packages["node_modules/shared"].version).toBe("1.0.0");
    expect(
      shrinkwrap.packages["node_modules/second/node_modules/shared"].version,
    ).toBe("2.0.0");
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
