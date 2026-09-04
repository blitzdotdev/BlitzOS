import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  adapterContentSha256,
  adapterDriftErrors,
  adapterGitContentSha256,
  DEFAULT_REPOSITORY,
  destinationHasLocalChanges,
  LODY_ADAPTER_NAMES,
} from "../../../scripts/lody-sync-adapters.mjs";

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
