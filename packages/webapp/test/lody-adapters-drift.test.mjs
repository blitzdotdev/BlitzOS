import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  ADAPTER_MANIFEST_NAME,
  adapterContentSha256,
  adapterDriftErrors,
  adapterGitContentSha256,
  adapterManifestBytes,
  adapterManifestEntries,
  DEFAULT_REPOSITORY,
  destinationHasLocalChanges,
  LODY_ADAPTER_NAMES,
  verifyAdapterManifest,
} from "../../../scripts/lody-sync-adapters.mjs";

function dockerignoreRules(source) {
  return source.split(/\r?\n/u).flatMap((sourceLine) => {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#")) return [];
    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1) : line;
    const directoryOnly = pattern.endsWith("/");
    const normalized = pattern.replace(/^\/+|\/+$/gu, "");
    return [{
      negated,
      directoryOnly,
      segments: normalized.split("/"),
    }];
  });
}

function matchesSegment(pattern, value) {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, "[^/]*")
    .replace(/\?/gu, "[^/]");
  return new RegExp(`^${expression}$`, "u").test(value);
}

function matchesSegments(pattern, candidate) {
  const memo = new Map();
  function match(patternIndex, candidateIndex) {
    const key = `${patternIndex}:${candidateIndex}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (patternIndex === pattern.length) {
      result = candidateIndex === candidate.length;
    } else if (pattern[patternIndex] === "**") {
      result = match(patternIndex + 1, candidateIndex)
        || (candidateIndex < candidate.length && match(patternIndex, candidateIndex + 1));
    } else {
      result = candidateIndex < candidate.length
        && matchesSegment(pattern[patternIndex], candidate[candidateIndex])
        && match(patternIndex + 1, candidateIndex + 1);
    }
    memo.set(key, result);
    return result;
  }
  return match(0, 0);
}

function ruleMatchesPath(rule, file) {
  const segments = file.split("/");
  return segments.some((_segment, index) => {
    const directory = index < segments.length - 1;
    if (rule.directoryOnly && !directory) return false;
    return matchesSegments(rule.segments, segments.slice(0, index + 1));
  });
}

function isDockerIgnored(file, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatchesPath(rule, file)) ignored = !rule.negated;
  }
  return ignored;
}

test("the reviewed Lody adapters match their gitlinks and stamps", () => {
  expect(LODY_ADAPTER_NAMES).toEqual([
    "core",
    "claude",
    "codex",
    "dsh",
    "grok",
  ]);
  expect(adapterDriftErrors(DEFAULT_REPOSITORY)).toEqual([]);
});

test("the box build context includes every tracked Lody builder input", () => {
  const ignoreFile = path.join(
    DEFAULT_REPOSITORY,
    "packages/box/Dockerfile.dockerignore",
  );
  const rules = dockerignoreRules(readFileSync(ignoreFile, "utf8"));
  const trackedInputs = execFileSync(
    "git",
    [
      "ls-files",
      "--",
      "vendor/lody-adapters",
      "vendor/lody",
      "scripts/lody-*",
    ],
    { cwd: DEFAULT_REPOSITORY, encoding: "utf8" },
  ).trim().split("\n").filter((file) => file !== "");

  expect(
    isDockerIgnored("vendor/lody-adapters/dsh/dist/index.js", rules),
    "the committed DSH dist must be re-included after the broad dist rule",
  ).toBe(false);
  expect(
    isDockerIgnored(
      "vendor/lody-adapters/dsh/node_modules/local-install.js",
      rules,
    ),
    "a local install inside an adapter snapshot must stay excluded",
  ).toBe(true);
  expect(
    trackedInputs.filter((file) => isDockerIgnored(file, rules)),
    "Dockerfile.dockerignore excludes tracked input copied by the Lody builder",
  ).toEqual([]);
});

test("an untracked non-empty adapter destination is a local change", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "lody-adapter-status-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repository });
    const destination = path.join(repository, "vendor/lody-adapters/core");
    mkdirSync(destination, { recursive: true });
    writeFileSync(
      path.join(destination, "work-in-progress.ts"),
      "export {};\n",
    );

    expect(destinationHasLocalChanges(repository, "core")).toBe(true);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("an ignored-only adapter destination is a local change", () => {
  const repository = mkdtempSync(
    path.join(tmpdir(), "lody-adapter-ignored-status-"),
  );
  try {
    execFileSync("git", ["init", "-q"], { cwd: repository });
    writeFileSync(
      path.join(repository, ".gitignore"),
      "vendor/lody-adapters/core/dist/\n",
    );
    const destination = path.join(repository, "vendor/lody-adapters/core/dist");
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(destination, "generated.js"), "export {};\n");

    expect(destinationHasLocalChanges(repository, "core")).toBe(true);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("adapter hashes use Git modes, symlink targets, and index blob content", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "lody-adapter-hash-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repository });
    const root = path.join(repository, "vendor/lody-adapters/core");
    mkdirSync(path.join(root, "src"), { recursive: true });
    const source = path.join(root, "src/index.ts");
    writeFileSync(source, "export const answer = 42;\n");
    writeFileSync(path.join(root, "AGENTS.md"), "adapter rules\n");
    symlinkSync("AGENTS.md", path.join(root, "CLAUDE.md"));
    writeFileSync(path.join(root, "UPSTREAM.md"), "excluded stamp\n");
    execFileSync("git", ["add", "vendor/lody-adapters/core"], { cwd: repository });

    const indexed = adapterGitContentSha256(repository, "core");
    expect(adapterContentSha256(root)).toBe(indexed);

    chmodSync(source, 0o600);
    expect(adapterContentSha256(root), "non-executable permission detail is ignored").toBe(indexed);
    chmodSync(source, 0o755);
    expect(adapterContentSha256(root), "the executable bit is Git mode 100755").not.toBe(indexed);
    chmodSync(source, 0o644);
    writeFileSync(source, "export const answer = 43;\n");
    expect(adapterGitContentSha256(repository, "core"), "the index blob stays authoritative").toBe(
      indexed,
    );
    expect(adapterContentSha256(root), "working-tree drift remains detectable").not.toBe(indexed);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("adapter manifests use canonical lines in UTF-8 byte path order", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lody-adapter-manifest-"));
  try {
    writeFileSync(path.join(root, "é.txt"), "non-ASCII\n");
    writeFileSync(path.join(root, "z.txt"), "ASCII\n");
    writeFileSync(path.join(root, "UPSTREAM.md"), "excluded stamp\n");
    writeFileSync(path.join(root, ADAPTER_MANIFEST_NAME), "excluded manifest\n");
    symlinkSync("z.txt", path.join(root, "link"));

    const entries = adapterManifestEntries(root);
    expect(entries.map((entry) => entry.path)).toEqual([
      "link",
      "z.txt",
      "é.txt",
    ]);
    const manifest = adapterManifestBytes(entries);
    expect(manifest.toString("utf8").split("\n").slice(0, -1)).toEqual(
      entries.map(
        (entry) => `${entry.sha256}  ${entry.mode}  ${entry.path}`,
      ),
    );
    expect(adapterContentSha256(root)).toBe(
      createHash("sha256").update(manifest).digest("hex"),
    );
    expect(
      entries.find((entry) => entry.path === "link"),
    ).toMatchObject({
      mode: "120000",
      sha256: createHash("sha256").update("z.txt").digest("hex"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapter manifest drift names missing, extra, and changed files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lody-adapter-report-"));
  try {
    writeFileSync(path.join(root, "changed.txt"), "alpha\n");
    writeFileSync(path.join(root, "missing.txt"), "gone\n");
    const expected = adapterManifestEntries(root);
    writeFileSync(
      path.join(root, ADAPTER_MANIFEST_NAME),
      adapterManifestBytes(expected),
    );

    writeFileSync(path.join(root, "changed.txt"), "alpha\r\n");
    chmodSync(path.join(root, "changed.txt"), 0o755);
    unlinkSync(path.join(root, "missing.txt"));
    writeFileSync(path.join(root, "extra.txt"), "new\n");

    const report = verifyAdapterManifest(root, expected).errors.join("\n");
    expect(report).toContain("missing files:\n    - missing.txt");
    expect(report).toContain("extra files:\n    + extra.txt");
    expect(report).toContain("changed files:\n    ~ changed.txt");
    expect(report).toContain(
      `expected: mode 100644, sha256 ${createHash("sha256").update("alpha\n").digest("hex")}, size 6 bytes, CR no`,
    );
    expect(report).toContain(
      `actual:   mode 100755, sha256 ${createHash("sha256").update("alpha\r\n").digest("hex")}, size 7 bytes, CR yes`,
    );
    const sourceModeReport = verifyAdapterManifest(root).errors.join("\n");
    expect(sourceModeReport).toContain(
      "adapter tree differs from MANIFEST.sha256",
    );
    expect(sourceModeReport).toContain(
      `expected: mode 100644, sha256 ${createHash("sha256").update("alpha\n").digest("hex")}, size not recorded, CR not recorded`,
    );
    expect(sourceModeReport).toContain(
      `actual:   mode 100755, sha256 ${createHash("sha256").update("alpha\r\n").digest("hex")}, size 7 bytes, CR yes`,
    );
    expect(readFileSync(path.join(root, ADAPTER_MANIFEST_NAME))).toEqual(
      adapterManifestBytes(expected),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
