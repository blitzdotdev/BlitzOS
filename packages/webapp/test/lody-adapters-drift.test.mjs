import { execFileSync } from "node:child_process";
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
  adapterCheckoutHasDrift,
  adapterDriftErrors,
  adapterGitEntries,
  adapterTreeEntries,
  DEFAULT_REPOSITORY,
  destinationHasLocalChanges,
  LODY_ADAPTER_NAMES,
  verifyAdapterCheckout,
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

test("checkout drift compares the working tree to the Git index", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "lody-adapter-index-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repository });
    const root = path.join(repository, "vendor/lody-adapters/core");
    mkdirSync(root, { recursive: true });
    const packageFile = path.join(root, "package.json");
    writeFileSync(packageFile, "{}\n");
    execFileSync("git", ["add", "vendor/lody-adapters/core"], { cwd: repository });

    expect(adapterCheckoutHasDrift(repository, "core")).toBe(false);
    writeFileSync(packageFile, "{\"name\":\"changed\"}\n");
    expect(adapterCheckoutHasDrift(repository, "core")).toBe(true);
    execFileSync("git", ["add", "vendor/lody-adapters/core"], { cwd: repository });
    expect(adapterCheckoutHasDrift(repository, "core")).toBe(false);
    writeFileSync(path.join(root, "untracked.txt"), "new\n");
    expect(adapterCheckoutHasDrift(repository, "core")).toBe(true);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("checkout comparison uses Git modes, symlinks, and index blobs", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "lody-adapter-content-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repository });
    const root = path.join(repository, "vendor/lody-adapters/core");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), "{}\n");
    const source = path.join(root, "src/index.ts");
    writeFileSync(source, "export const answer = 42;\n");
    writeFileSync(path.join(root, "AGENTS.md"), "adapter rules\n");
    symlinkSync("AGENTS.md", path.join(root, "CLAUDE.md"));
    writeFileSync(path.join(root, "UPSTREAM.md"), "excluded stamp\n");
    execFileSync("git", ["add", "vendor/lody-adapters/core"], { cwd: repository });

    const indexed = adapterGitEntries(repository, "core");
    expect(verifyAdapterCheckout(root, indexed).errors).toEqual([]);

    chmodSync(source, 0o600);
    expect(verifyAdapterCheckout(root, indexed).errors).toEqual([]);
    chmodSync(source, 0o755);
    expect(verifyAdapterCheckout(root, indexed).errors.join("\n")).toContain(
      "changed files:\n    ~ src/index.ts",
    );
    chmodSync(source, 0o644);
    writeFileSync(source, "export const answer = 43;\n");
    expect(
      adapterGitEntries(repository, "core").find((entry) => entry.path === "src/index.ts").bytes,
      "the index blob stays authoritative",
    ).toEqual(Buffer.from("export const answer = 42;\n"));
    expect(verifyAdapterCheckout(root, indexed).errors.join("\n")).toContain(
      "changed files:\n    ~ src/index.ts",
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("checkout comparison names missing, extra, and changed files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lody-adapter-report-"));
  try {
    writeFileSync(path.join(root, "package.json"), "{}\n");
    writeFileSync(path.join(root, "changed.txt"), "alpha\n");
    writeFileSync(path.join(root, "missing.txt"), "gone\n");
    const expected = adapterTreeEntries(root);

    writeFileSync(path.join(root, "changed.txt"), "alpha\r\n");
    chmodSync(path.join(root, "changed.txt"), 0o755);
    unlinkSync(path.join(root, "missing.txt"));
    writeFileSync(path.join(root, "extra.txt"), "new\n");

    const report = verifyAdapterCheckout(root, expected).errors.join("\n");
    expect(report).toContain("missing files:\n    - missing.txt");
    expect(report).toContain("extra files:\n    + extra.txt");
    expect(report).toContain("changed files:\n    ~ changed.txt");
    expect(report).toContain("expected: mode 100644, size 6 bytes, CR no");
    expect(report).toContain("actual:   mode 100755, size 7 bytes, CR yes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Git-free preflight requires a non-empty package file", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "lody-adapter-package-"));
  try {
    const root = path.join(parent, "adapter");
    expect(verifyAdapterCheckout(root).errors).toEqual(["missing adapter directory"]);
    mkdirSync(root);
    expect(verifyAdapterCheckout(root).errors).toEqual(["missing or empty package.json"]);
    writeFileSync(path.join(root, "package.json"), "");
    expect(verifyAdapterCheckout(root).errors).toEqual(["missing or empty package.json"]);
    writeFileSync(path.join(root, "package.json"), "{}\n");
    expect(verifyAdapterCheckout(root).errors).toEqual([]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
