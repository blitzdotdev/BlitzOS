#!/usr/bin/env node

// Writes the derived assets.run_worker_first list into wrangler.toml.example.
//
// A deployment's own wrangler.toml never needs this: scripts/deploy.mjs patches
// the derived list in immediately before `wrangler deploy`, so the stored
// CANARY_WRANGLER_TOML / PROD_WRANGLER_TOML secrets can hold anything.
//
// The committed example still carries a copy, because two consumers read the
// file rather than the generator: `wrangler types` and the vitest Workers pool.
// test/route-prefixes.test.ts fails when the copy falls behind, and names this
// script. Run it after adding, removing, or renaming a core route:
//
//   npm run routes:sync -w packages/control-plane
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRunWorkerFirst } from "./lib/worker-first-routes.mjs";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_WORKER_FIRST_BLOCK = /^run_worker_first = \[[^\]]*\]$/mu;

/**
 * The TOML fragment for one generated run_worker_first array.
 *
 * @param {readonly string[]} entries derived run_worker_first entries
 * @returns {string} `run_worker_first = [ ... ]`, one entry per line
 */
export function runWorkerFirstToml(entries) {
  return `run_worker_first = [\n${entries.map((entry) => `  ${JSON.stringify(entry)},`).join("\n")}\n]`;
}

/**
 * Replaces the run_worker_first array in an example config, leaving every
 * comment and every other key exactly where it was.
 *
 * @param {string} exampleToml contents of wrangler.toml.example
 * @param {readonly string[]} entries derived run_worker_first entries
 * @returns {string} the updated file contents
 */
export function withGeneratedRunWorkerFirst(exampleToml, entries) {
  if (!RUN_WORKER_FIRST_BLOCK.test(exampleToml)) {
    throw new Error("wrangler.toml.example has no run_worker_first array to replace");
  }
  return exampleToml.replace(RUN_WORKER_FIRST_BLOCK, runWorkerFirstToml(entries));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const examplePath = path.join(PACKAGE_DIR, "wrangler.toml.example");
  const before = readFileSync(examplePath, "utf8");
  const after = withGeneratedRunWorkerFirst(before, deriveRunWorkerFirst());
  if (before === after) {
    console.log("wrangler.toml.example already carries the derived run_worker_first list");
  } else {
    writeFileSync(examplePath, after);
    console.log("wrote the derived run_worker_first list into wrangler.toml.example");
  }
}
