// Answers one question: does this deploy need a new box image?
//
// Base-owned inputs require a replacement image. Payload and daemon inputs are
// intentionally excluded: the in-place updater delivers those to old boxes,
// and a newly created box converges from its baked payload to the current pin.
// Worker and webapp changes ride the deploy and reach every workspace at once.
//
// The self-host runbook offers this advisory before a manual image publish.
// It needs the deployed SHA, which is what GET /version reports, so an operator
// does not have to reconstruct the comparison by hand.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOX_IMAGE_INPUTS } from "./lib/box-image-inputs.mjs";
import { isNonEmptyString } from "./lib/values.mjs";

// Keep the old export because callers used this advisory before image keys
// shared the Dockerfile input list.
export const IMAGE_PATHS = BOX_IMAGE_INPUTS;

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
      reason: `No base-image path changed since ${deployedCommit}. The current box image pin still stands; payload changes ship in place.`,
      paths: [],
    };
  }
  return {
    rebuild: true,
    reason: `${touched.length} base-image file(s) changed since ${deployedCommit}. Publish a new image, or the change reaches no workspace. A v* tag does this for you.`,
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
