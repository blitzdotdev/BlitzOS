import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  adapterDriftErrors,
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
