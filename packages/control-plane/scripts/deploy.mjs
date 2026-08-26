#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  experimental_patchConfig as patchWranglerConfig,
  experimental_readRawConfig as readRawWranglerConfig,
} from "wrangler";
import {
  CONFIG_PATH,
  commandFailureMessage,
  deployControlPlane,
  overrideVarsFromEnvironment,
} from "./deploy-helpers.mjs";
import { assertPublishedAssets } from "../../webapp/scripts/check-published-assets.mjs";
import { assertConfigMatchesExample, repairConfigFromExample } from "./config-drift.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const configAbsolute = path.resolve(REPO_ROOT, CONFIG_PATH);

function run(tool, args, { capture, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const reason = signal === null ? `exit ${code}` : `signal ${signal}`;
      reject(new Error(commandFailureMessage(tool, args, reason, stderr)));
    });
  });
}

if (!existsSync(configAbsolute)) {
  process.stderr.write(
    `${CONFIG_PATH} not found — generate it with \`npm run config -w packages/control-plane\` and fill in your values.\n`,
  );
  process.exit(1);
}

/**
 * Writes a partial config into wrangler.toml.
 *
 * The same door the D1 database_id, the generated route list, and the repaired
 * keys all go through.
 *
 * @param {object} patch a partial wrangler config
 * @param {string} what named in the failure message
 * @param {string} recovery what a rerun does, when that is worth saying
 */
function patchConfig(patch, what, recovery = "") {
  try {
    patchWranglerConfig(configAbsolute, patch, false);
  } catch (error) {
    throw new Error(
      `writing ${what} into ${CONFIG_PATH} failed: ${error instanceof Error ? error.message : "config patch failed"}\n`
      + (recovery === "" ? "" : `${recovery}\n`)
      + "wrangler cannot patch a config that holds comments — strip them, or regenerate the config with "
      + "`npm run config -w packages/control-plane`, then rerun.",
    );
  }
}

// Before anything reaches Cloudflare. The build copies packages/webapp/public/
// into the assets the Worker serves, so a file missing here un-publishes a
// live page — and nothing imports those files, so no other step would notice.
// Checking now means a failure costs nothing: no migration has been applied.
try {
  assertPublishedAssets();
  // wrangler.toml is per-deployment and gitignored, so a config generated
  // before the example gained a key keeps the old shape and the deploy
  // succeeds with a route that 404s. Fill those keys in from the example
  // rather than refusing: a deployment config that lives in a secret is
  // otherwise re-pasted by hand for every new var. Only the values a deployer
  // alone can know stop the deploy, and this reads no value out of the
  // deployment config — the example is the only file it copies from.
  for (const { path: key, value } of repairConfigFromExample(configAbsolute, (patch) =>
    patchConfig(patch, "keys missing from wrangler.toml.example"),
  )) {
    console.log(`filled ${key} = ${JSON.stringify(value)} into ${CONFIG_PATH} from wrangler.toml.example`);
  }
  // The repair leaves nothing behind. If it did, say so before deploying.
  assertConfigMatchesExample(configAbsolute);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "pre-deploy check failed"}\n`);
  process.exit(1);
}

// The commit the deploy ships, reported afterwards by GET /version. A shallow
// CI checkout still answers rev-parse; only a tarball without .git does not.
function checkedOutCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? "";
  }
}

const rawConfig = readRawWranglerConfig({ config: configAbsolute }).rawConfig;

deployControlPlane({
  configPath: CONFIG_PATH,
  rawConfig,
  run,
  gitCommitSha: checkedOutCommit(),
  overrideVars: overrideVarsFromEnvironment(process.env),
  patchConfig: (patch) =>
    patchConfig(
      patch,
      "the D1 database_id and the derived assets.run_worker_first",
      "The database already exists and rerunning the deploy reuses it.",
    ),
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "deployment failed"}\n`);
  process.exitCode = 1;
});
