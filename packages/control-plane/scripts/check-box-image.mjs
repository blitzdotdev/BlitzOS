// Answers one question: does this deploy need a new box image?
//
// Box and broker changes ride the image, and a box never upgrades in place, so
// they reach new workspaces only. Worker and webapp changes ride the deploy and
// reach every workspace at once. Mixing the two up ships half a change.
//
// The runbook asks a human to run `git diff --stat <deployed-sha>..HEAD` before
// each deploy. That step needs the deployed SHA, which is what GET /version now
// reports, so the whole check runs unattended.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isNonEmptyString } from "./lib/values.mjs";

// Everything baked into the image. packages/box holds the gateway and the
// rootfs; packages/broker holds the credential broker binary.
export const IMAGE_PATHS = Object.freeze(["packages/box", "packages/broker"]);

/**
 * Decides whether an image rebuild is due.
 *
 * @param {string} deployedCommit the SHA the target deployment reports
 * @param {string[]} changedPaths repository paths changed since that SHA
 * @returns {{rebuild: boolean, reason: string, paths: string[]}}
 */
export function boxImageDecision(deployedCommit, changedPaths) {
  const touched = changedPaths.filter((file) =>
    IMAGE_PATHS.some((root) => file === root || file.startsWith(`${root}/`)),
  );
  if (touched.length === 0) {
    return {
      rebuild: false,
      reason: `No image path changed since ${deployedCommit}. A worker-only deploy is enough, and the current box image pin still stands.`,
      paths: [],
    };
  }
  return {
    rebuild: true,
    reason: `${touched.length} file(s) under ${IMAGE_PATHS.join(" and ")} changed since ${deployedCommit}. Publish a new image, or the change reaches no workspace. A v* tag does this for you.`,
    paths: touched,
  };
}

/**
 * Reads the deployed commit from a running deployment.
 *
 * @param {string} origin e.g. https://blitzos.com
 * @returns {Promise<string>} the commit SHA
 */
export async function deployedCommit(origin) {
  const url = new URL("/version", origin);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(
      `GET ${url} answered ${response.status}. A deployment older than the /version route cannot report its commit — pass --since <sha> instead.`,
    );
  }
  const body = await response.json();
  const commit = body?.commit;
  if (!isNonEmptyString(commit)) {
    throw new Error(`GET ${url} returned no commit field.`);
  }
  return commit;
}

const changedPathsSince = (commit, repoRoot) =>
  execFileSync("git", ["diff", "--name-only", `${commit}..HEAD`, "--", ...IMAGE_PATHS], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };

  try {
    const since = valueOf("--since") ?? (await deployedCommit(valueOf("--url") ?? "https://blitzos.com"));
    const decision = boxImageDecision(since, changedPathsSince(since, repoRoot));
    console.log(decision.reason);
    for (const file of decision.paths.slice(0, 20)) console.log(`  ${file}`);
    if (decision.paths.length > 20) console.log(`  ...and ${decision.paths.length - 20} more`);
    process.exit(decision.rebuild ? 2 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "box image check failed");
    process.exit(1);
  }
}
