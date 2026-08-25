// Reports keys that wrangler.toml.example has and a deployment's wrangler.toml
// does not.
//
// wrangler.toml is per-deployment and gitignored, so every hosted instance
// keeps its own copy. ensure-wrangler-config.mjs generates one only when none
// exists, and never touches it again. When the example gains a var, an
// [[rules]] block, or a run_worker_first entry, each existing config keeps the
// old shape. The deploy still succeeds, and the new route 404s or the worker
// build fails at run time instead.
//
// The example is the shape of record. This check compares key paths, never
// values, so it can run against a config full of account IDs and never read
// one.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { isTable } from "./lib/values.mjs";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Flattens a parsed TOML tree to dotted key paths.
 *
 * An array of tables contributes the union of its elements' key paths under a
 * single `[]` segment. Two deployments can list a different number of R2
 * buckets or cron triggers without either one counting as drift.
 *
 * @param {unknown} value parsed TOML
 * @param {string} prefix internal, the path so far
 * @returns {Set<string>} every key path in the tree
 */
export function configKeyPaths(value, prefix = "") {
  const paths = new Set();
  if (isTable(value)) {
    for (const [key, child] of Object.entries(value)) {
      const here = prefix === "" ? key : `${prefix}.${key}`;
      paths.add(here);
      for (const nested of configKeyPaths(child, here)) paths.add(nested);
    }
    return paths;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      if (!isTable(element)) continue;
      for (const nested of configKeyPaths(element, `${prefix}[]`)) paths.add(nested);
    }
  }
  return paths;
}

/**
 * Key paths the example declares and the config omits.
 *
 * @param {string} exampleToml contents of wrangler.toml.example
 * @param {string} configToml contents of a deployment wrangler.toml
 * @returns {string[]} sorted missing key paths
 */
export function missingConfigKeys(exampleToml, configToml) {
  const expected = configKeyPaths(parse(exampleToml));
  const actual = configKeyPaths(parse(configToml));
  return [...expected].filter((key) => !actual.has(key)).sort();
}

/**
 * Throws when the config lacks a key the example declares.
 *
 * @param {string} configPath path to the deployment wrangler.toml
 * @param {string} packageDir path to packages/control-plane
 */
export function assertConfigMatchesExample(configPath, packageDir = PACKAGE_DIR) {
  const examplePath = path.join(packageDir, "wrangler.toml.example");
  const missing = missingConfigKeys(
    readFileSync(examplePath, "utf8"),
    readFileSync(configPath, "utf8"),
  );
  if (missing.length === 0) return 0;
  throw new Error(
    `${configPath} is missing keys that wrangler.toml.example declares:\n` +
      missing.map((key) => `  ${key}`).join("\n") +
      "\nThis config predates a change to the example. Copy the new keys across, " +
      "then rerun. Compare against wrangler.toml.example, which documents each one.",
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const configPath = process.argv[2] ?? path.join(PACKAGE_DIR, "wrangler.toml");
  try {
    assertConfigMatchesExample(configPath);
    console.log(`${configPath} carries every key wrangler.toml.example declares`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "config drift check failed");
    process.exit(1);
  }
}
