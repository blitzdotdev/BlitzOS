#!/usr/bin/env node
// Applies the subset of Lody's `patchedDependencies` that the vendored
// renderer needs (plans/LODY-SESSIONS.md §5.2).
//
// Lody is a pnpm workspace and declares these in `pnpm-workspace.yaml` under
// `patchedDependencies`; npm has no equivalent, so this runs from postinstall.
//
// Two deliberate choices:
//
//   - The patch files are read straight out of `vendor/lody/patches/`. Copying
//     them under `patches/` would create a second copy to keep in step with
//     every `git subtree pull`, and §5.4 already makes auditing those files
//     part of the merge routine — a diff of the vendor tree is that audit.
//   - `git apply` does the work rather than `patch-package`. patch-package
//     refuses all four of these files (it fails before reporting a reason);
//     `git apply` takes them exactly as upstream wrote them, so the bytes we
//     apply are the bytes they maintain.
//
// `GIT_CEILING_DIRECTORIES` is load-bearing, not decoration. `node_modules` is
// inside this repository and is git-ignored, and `git apply` SILENTLY SKIPS an
// ignored path while still exiting 0 — it prints "Skipped patch" and changes
// nothing. Stopping git's upward search at `node_modules` makes it treat the
// package directory as plain files, which is what we want to patch.
//
// Idempotent: a patch that already applies in reverse is treated as applied,
// so re-running `npm install` is a no-op.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patchDir = join(repoRoot, "vendor", "lody", "patches");
const modulesDir = join(repoRoot, "node_modules");

/**
 * package name -> { version, patch, why }
 *
 * Only the patches the vendored renderer actually needs. Their remaining four
 * (`@better-auth/api-key`, `@better-auth/electron`, `@tanstack/router-generator`,
 * `node-pty`, `acp-extension-claude`) cover Electron, the Lody cloud login and
 * their build tooling, none of which we run. `remend@1.3.0` is skipped because
 * npm resolves 1.3.1 and the patch does not target it.
 */
const PATCHES = [
  {
    name: "loro-repo",
    version: "0.20.0",
    file: "loro-repo.patch",
    why: "ready() must start the metadata live monitor before the persister; the browser transport depends on it",
  },
  {
    name: "@pierre/diffs",
    version: "1.0.10",
    file: "@pierre__diffs@1.0.10.patch",
    why: "replaces a lookbehind regex Safari cannot parse",
  },
  {
    name: "react-photo-view",
    version: "1.2.7",
    file: "react-photo-view@1.2.7.patch",
    why: "image viewer behaviour the vendored ZoomableImageViewer assumes",
  },
  {
    name: "mdast-util-gfm-autolink-literal",
    version: "2.0.1",
    file: "mdast-util-gfm-autolink-literal@2.0.1.patch",
    why: "drops a Unicode-property lookbehind from the email autolink regex",
  },
];

function installedVersion(name) {
  const manifest = join(modulesDir, name, "package.json");
  if (!existsSync(manifest)) return null;
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}

function runGitApply(cwd, patchPath, args) {
  try {
    execFileSync("git", ["apply", "--no-index", "-p1", ...args, patchPath], {
      cwd,
      stdio: "pipe",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: modulesDir },
    });
    return true;
  } catch {
    return false;
  }
}

function gitApply(cwd, patchPath, extraArgs = []) {
  if (runGitApply(cwd, patchPath, extraArgs)) return true;
  // `loro-repo.patch` is a zero-context diff (every line of the hunk is a `-`
  // or a `+`), which `git apply` refuses without being told the diff was
  // generated with `-U0`. Retrying is safe because the strict pass ran first.
  return runGitApply(cwd, patchPath, [...extraArgs, "--unidiff-zero"]);
}

let failed = false;
for (const patch of PATCHES) {
  const version = installedVersion(patch.name);
  if (version === null) {
    console.log(`[vendor-patches] skip ${patch.name}: not installed`);
    continue;
  }
  if (version !== patch.version) {
    console.warn(
      `[vendor-patches] skip ${patch.name}: installed ${version}, patch targets ${patch.version}`,
    );
    continue;
  }
  const patchPath = join(patchDir, patch.file);
  if (!existsSync(patchPath)) {
    console.warn(`[vendor-patches] skip ${patch.name}: ${patch.file} missing from the subtree`);
    continue;
  }
  const cwd = join(modulesDir, patch.name);
  if (gitApply(cwd, patchPath, ["--check", "--reverse"])) {
    console.log(`[vendor-patches] ${patch.name}@${version} already patched`);
    continue;
  }
  if (gitApply(cwd, patchPath)) {
    console.log(`[vendor-patches] patched ${patch.name}@${version} — ${patch.why}`);
    continue;
  }
  console.error(`[vendor-patches] FAILED to patch ${patch.name}@${version} with ${patch.file}`);
  failed = true;
}

if (failed) process.exit(1);
