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
// The example is the shape of record. This check reads key paths, and the
// entries of the two lists that route requests. It never reads a value that
// identifies an account, a database, or a zone, so it can run against a real
// deployment config and disclose nothing.
//
// Key paths alone were not enough. run_worker_first is a key both files always
// have, so a config missing one entry looked identical — and a core route that
// is not in that list gets served by the asset handler, which answers the SPA
// shell with status 200 instead of the route. That shipped: /version was added
// to the example and to neither deployment, and this check passed them both.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { isNonEmptyString, isTable } from "./lib/values.mjs";

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
 * Lists whose entries route requests, so a missing entry changes behaviour.
 * Each is compared entry by entry, not just by presence of the key.
 *
 * They hold route patterns and cron expressions. Neither identifies anything
 * about the account the config belongs to.
 */
export const COMPARED_LISTS = Object.freeze([
  ["assets", "run_worker_first"],
  ["triggers", "crons"],
]);

const listAt = (config, [table, key]) => {
  const parent = config[table];
  if (!isTable(parent)) return [];
  const value = parent[key];
  return Array.isArray(value) ? value.filter((entry) => isNonEmptyString(entry)) : [];
};

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
 * Entries the example lists and the config omits, for each routing list.
 *
 * A config may hold extra entries: a deployment can route something the
 * example never mentions. Only what the example requires and the config lacks
 * is drift.
 *
 * @param {string} exampleToml contents of wrangler.toml.example
 * @param {string} configToml contents of a deployment wrangler.toml
 * @returns {{path: string, missing: string[]}[]} one entry per list that lacks something
 */
export function missingListEntries(exampleToml, configToml) {
  const example = parse(exampleToml);
  const config = parse(configToml);
  const problems = [];
  for (const list of COMPARED_LISTS) {
    const present = new Set(listAt(config, list));
    const missing = listAt(example, list).filter((entry) => !present.has(entry));
    if (missing.length > 0) problems.push({ path: list.join("."), missing });
  }
  return problems;
}

/**
 * Throws when the config lacks a key the example declares.
 *
 * @param {string} configPath path to the deployment wrangler.toml
 * @param {string} packageDir path to packages/control-plane
 */
export function assertConfigMatchesExample(configPath, packageDir = PACKAGE_DIR) {
  const examplePath = path.join(packageDir, "wrangler.toml.example");
  const example = readFileSync(examplePath, "utf8");
  const config = readFileSync(configPath, "utf8");
  const missing = missingConfigKeys(example, config);
  const lists = missingListEntries(example, config);
  if (missing.length === 0 && lists.length === 0) return 0;

  const report = [];
  if (missing.length > 0) {
    report.push("missing keys:", ...missing.map((key) => `  ${key}`));
  }
  for (const { path: listPath, missing: entries } of lists) {
    report.push(`missing entries in ${listPath}:`, ...entries.map((entry) => `  ${entry}`));
  }
  throw new Error(
    `${configPath} does not match wrangler.toml.example:\n` +
      report.join("\n") +
      "\nThis config predates a change to the example. Copy the new keys and entries " +
      "across, then rerun. A core route absent from run_worker_first is served the SPA " +
      "shell with status 200 instead of the route, so nothing else will report it.",
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
