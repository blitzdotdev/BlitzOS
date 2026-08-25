// Rolls the Worker back to the version that ran before the current one.
//
// A deploy goes to full traffic at once, so recovery means one thing: put the
// previous version back. A Worker version carries its own vars, so the rollback
// restores BOX_IMAGE_REF with it — new workspaces return to the old box image
// without a second step.
//
// Prints the plan and stops. Pass --yes to run it. A rollback is the wrong
// moment to discover that a tool guessed.
//
// It does NOT roll back D1. Migrations are forward-only here, and rolling the
// Worker back past a migration that dropped a column breaks the old code's
// writes, because that code still targets the dropped column. The plan names
// this every time; read plans/DEPLOY-RUNBOOK.md before you answer it.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isNonEmptyString, isTable } from "./lib/values.mjs";

export const CONFIG_PATH = "packages/control-plane/wrangler.toml";

/**
 * Reads the version ids a deployment serves.
 *
 * @param {unknown} deployment one entry of `wrangler deployments list --json`
 * @returns {string[]} version ids, empty when the shape is unreadable
 */
export function deploymentVersionIds(deployment) {
  if (!isTable(deployment) || !Array.isArray(deployment.versions)) return [];
  return deployment.versions
    .map((version) => (isTable(version) ? version.version_id ?? version.id : undefined))
    .filter((id) => isNonEmptyString(id));
}

/**
 * Picks the version to roll back to.
 *
 * Takes the newest deployment as current, then walks back to the first
 * deployment that served exactly one different version. A split deployment is
 * skipped: with two versions live, "the previous one" has no single answer, and
 * this tool refuses to guess.
 *
 * @param {unknown} listed parsed `wrangler deployments list --json`
 * @returns {{current: string, target: string}}
 */
export function rollbackTarget(listed) {
  if (!Array.isArray(listed) || listed.length === 0) {
    throw new Error("`wrangler deployments list --json` returned no deployments.");
  }
  const ordered = [...listed].sort((left, right) =>
    String(right?.created_on ?? "").localeCompare(String(left?.created_on ?? "")),
  );

  const currentIds = deploymentVersionIds(ordered[0]);
  if (currentIds.length === 0) {
    throw new Error("The newest deployment lists no version id. Read `wrangler deployments list` by hand.");
  }
  if (currentIds.length > 1) {
    throw new Error(
      `The newest deployment serves ${currentIds.length} versions at once. Pick the target by hand: wrangler rollback <version-id> --config ${CONFIG_PATH}`,
    );
  }
  const current = currentIds[0];

  for (const deployment of ordered.slice(1)) {
    const ids = deploymentVersionIds(deployment);
    if (ids.length !== 1) continue;
    if (ids[0] === current) continue;
    return { current, target: ids[0] };
  }
  throw new Error(
    `Found no earlier deployment that served a single version other than ${current}. There is nothing to roll back to.`,
  );
}

const wrangler = (args) =>
  execFileSync("npx", ["wrangler", ...args, "--config", CONFIG_PATH], {
    encoding: "utf8",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const execute = process.argv.includes("--yes");
  try {
    const { current, target } = rollbackTarget(JSON.parse(wrangler(["deployments", "list", "--json"])));
    console.log(`current version: ${current}`);
    console.log(`rollback target: ${target}`);
    console.log("");
    console.log("The Worker version carries its vars, so BOX_IMAGE_REF returns to its earlier value.");
    console.log("D1 does NOT roll back. If a migration since that version dropped a column,");
    console.log("the restored code will write to a column that is gone. Check the migrations first:");
    console.log(`  npm run migrations:pending -w packages/control-plane`);
    console.log("");
    if (!execute) {
      console.log("Plan only. To run it:");
      console.log(`  npx wrangler rollback ${target} --config ${CONFIG_PATH}`);
      console.log("  or rerun this script with --yes");
      process.exit(0);
    }
    console.log(wrangler(["rollback", target, "--message", "rollback.mjs"]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "rollback failed");
    process.exit(1);
  }
}
