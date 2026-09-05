// Keeps a deployment's wrangler.toml in step with wrangler.toml.example, and
// repairs it rather than refusing to deploy.
//
// wrangler.toml is per-deployment and gitignored, so every hosted instance
// keeps its own copy — for blitz.dev, inside the CANARY_WRANGLER_TOML and
// PROD_WRANGLER_TOML deployment secrets. ensure-wrangler-config.mjs generates
// one only when none exists, and never touches it again. So when the example
// gained a var or an [[rules]] block, someone had to paste both secrets by
// hand or the deploy stopped. That happened twice in one evening, for one new
// var and one new route, which is not a workflow anybody keeps up.
//
// Now the deploy fills the gaps in. configRepairPlan names every key the
// example declares and the config omits, with the example's own value, and
// scripts/deploy.mjs patches them in before it reads the config. The stored
// secrets are left holding what only they can hold: account_id, database_id,
// zone ids, APP_URL — the account-specific identifiers a developer never edits.
//
// The example is the shape of record. This module reads key paths and the
// entries of the one list it still compares. It never reads a value that
// identifies an account, a database, or a zone out of a deployment config, so
// it can run against a real one and disclose nothing.
//
// assets.run_worker_first is deliberately absent from both comparisons. It is
// generated now — scripts/lib/worker-first-routes.mjs derives it from core's
// route registrations and the deploy patches it in on every run — so comparing
// a stored copy against the example would fail the deploy on drift that the
// same deploy is about to repair. The check that used to live here has moved
// to test/route-prefixes.test.ts, where it belongs: the generator must cover
// every core route, on every push, instead of at deploy time.
//
// triggers.crons is still compared entry by entry. A cron the config lacks is
// a sweep that silently never runs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { PLACEHOLDER_VALUE_PATTERN } from "./deploy-helpers.mjs";
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
 * Key paths the deploy generates, so a stored config is never asked for them.
 *
 * assets.run_worker_first is derived from core's route registrations and
 * written into the config immediately before `wrangler deploy`. Requiring a
 * deployment secret to already carry it would fail the deploy over the exact
 * value the deploy is about to supply.
 */
export const GENERATED_KEY_PATHS = Object.freeze(["assets.run_worker_first"]);

/**
 * Lists whose entries change behaviour, compared entry by entry rather than by
 * presence of the key.
 *
 * Cron expressions only. They identify nothing about the account the config
 * belongs to, and a missing one is a sweep that never runs.
 */
export const COMPARED_LISTS = Object.freeze([
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
  const generated = new Set(GENERATED_KEY_PATHS);
  return [...expected].filter((key) => !actual.has(key) && !generated.has(key)).sort();
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
 * Why a missing key cannot be filled in from the example, or null when it can.
 *
 * Two classes, and only two.
 *
 * Repairable — everything the example ships a real value for. Every var in the
 * example is deployable as written: the ones that can only be filled in after a
 * first deploy (APP_URL, BOX_IMAGE_*, the CLOUDFLARE_* zone ids) ship as "",
 * which the Worker reads as "not configured yet" and the feature that needs it
 * stays off. Copying an empty string in therefore restores the shape without
 * turning anything on, and the deploy keeps failing on the things that would
 * actually break it — a required secret that is not set, or a SIGNUP_MODE the
 * Worker would 500 on.
 *
 * Not repairable — a key whose example value is a documentation placeholder
 * ("<your zone id>"). Only the operator knows the value, and writing the
 * placeholder in would trip placeholderVars one step later with a worse
 * message. The example ships none today; this is the guard for the day one is
 * added.
 *
 * @param {unknown} exampleValue the example's value for the missing key
 * @returns {string | null} the reason, or null when the value can be copied
 */
function unfillableReason(exampleValue) {
  return isNonEmptyString(exampleValue) && PLACEHOLDER_VALUE_PATTERN.test(exampleValue)
    ? `the example ships the placeholder ${exampleValue}, which only you can replace`
    : null;
}

/**
 * Walks the example against the config, collecting a patch of missing leaves.
 *
 * @param {object} example a table from the parsed example
 * @param {unknown} config the matching table from the parsed config
 * @param {string} prefix dotted path of `example`
 * @param {{path: string, value: unknown}[]} filled out: keys that will be written
 * @param {{path: string, reason: string}[]} unfillable out: keys that cannot be
 * @returns {object} the patch for this table, empty when nothing is missing
 */
function missingLeafPatch(example, config, prefix, filled, unfillable) {
  const patch = {};
  for (const [key, exampleValue] of Object.entries(example)) {
    const here = prefix === "" ? key : `${prefix}.${key}`;
    if (GENERATED_KEY_PATHS.includes(here)) continue;
    const configValue = isTable(config) ? config[key] : undefined;
    // A whole missing table recurses with nothing on the other side, so every
    // leaf inside it is judged one at a time. Copying the table wholesale
    // instead would have carried a placeholder in with it.
    if (isTable(exampleValue)) {
      const nested = missingLeafPatch(exampleValue, configValue, here, filled, unfillable);
      if (Object.keys(nested).length > 0) patch[key] = nested;
      continue;
    }
    if (configValue === undefined) {
      const reason = unfillableReason(exampleValue);
      if (reason === null) {
        patch[key] = exampleValue;
        filled.push({ path: here, value: exampleValue });
      } else {
        unfillable.push({ path: here, reason });
      }
      continue;
    }
    // An array of tables that both files have: [[r2_buckets]], [[d1_databases]],
    // [[rules]]. A key missing from one of its entries cannot be defaulted,
    // because nothing here can say which entry it belongs to. Report it.
    if (Array.isArray(exampleValue) && exampleValue.some((entry) => isTable(entry))) {
      const actual = configKeyPaths(configValue, here);
      for (const nestedPath of configKeyPaths(exampleValue, here)) {
        if (actual.has(nestedPath)) continue;
        unfillable.push({
          path: nestedPath,
          reason: "it sits inside an array of tables, so nothing can tell which entry it belongs to",
        });
      }
    }
  }
  return patch;
}

/**
 * What the deploy must write into a config before it can deploy it.
 *
 * `patches` are wrangler `experimental_patchConfig` patches, in order. Cron
 * entries take two: wrangler writes an array element by element and leaves
 * whatever sat past the end of the new one in place, so the key is removed
 * first and the union written back whole. The union is deliberate — a
 * deployment may run a cron the example never mentions, and repairing must not
 * be a way to lose it.
 *
 * @param {string} exampleToml contents of wrangler.toml.example
 * @param {string} configToml contents of a deployment wrangler.toml
 * @returns {{patches: object[], filled: {path: string, value: unknown}[], unfillable: {path: string, reason: string}[]}}
 */
export function configRepairPlan(exampleToml, configToml) {
  const example = parse(exampleToml);
  const config = parse(configToml);
  const filled = [];
  const unfillable = [];
  const patches = [];

  const patch = missingLeafPatch(example, config, "", filled, unfillable);
  if (Object.keys(patch).length > 0) patches.push(patch);

  for (const list of COMPARED_LISTS) {
    const [table, key] = list;
    const present = listAt(config, list);
    const missing = listAt(example, list).filter((entry) => !present.includes(entry));
    if (missing.length === 0) continue;
    // The table itself was just added by the patch above, values and all.
    const listPath = `${table}.${key}`;
    if (present.length === 0
      && filled.some(({ path: filledPath }) => filledPath === table || filledPath === listPath)) continue;
    if (present.length > 0) patches.push({ [table]: { [key]: undefined } });
    patches.push({ [table]: { [key]: [...present, ...missing] } });
    for (const entry of missing) filled.push({ path: `${listPath}[]`, value: entry });
  }

  return { patches, filled, unfillable };
}

/**
 * Repairs a deployment config in place, and names every key it wrote.
 *
 * @param {string} configPath path to the deployment wrangler.toml
 * @param {(patch: object) => void} applyPatch wrangler's experimental_patchConfig, bound to configPath
 * @param {string} packageDir path to packages/control-plane
 * @returns {{path: string, value: unknown}[]} the keys written, in order
 */
export function repairConfigFromExample(configPath, applyPatch, packageDir = PACKAGE_DIR) {
  const example = readFileSync(path.join(packageDir, "wrangler.toml.example"), "utf8");
  const plan = configRepairPlan(example, readFileSync(configPath, "utf8"));
  if (plan.unfillable.length > 0) {
    throw new Error(
      `${configPath} is missing keys that only you can supply:\n` +
        plan.unfillable.map(({ path: key, reason }) => `  ${key} — ${reason}`).join("\n") +
        "\nAdd them (wrangler.toml.example documents each one), then rerun.",
    );
  }
  for (const patch of plan.patches) applyPatch(patch);
  return plan.filled;
}

/**
 * Throws when the config lacks a key the example declares, or a compared list
 * entry. The deploy runs the repair above first, so reaching this with
 * anything to report means the repair could not be applied.
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
      "\nThis config predates a change to the example. `npm run deploy -w packages/control-plane` " +
      "fills these in from the example before it deploys; run it, or copy them across by hand. " +
      "A cron absent from triggers.crons is a sweep that silently never runs, so nothing else " +
      "will report it.",
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
