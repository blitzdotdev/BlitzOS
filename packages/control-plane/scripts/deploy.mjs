#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  experimental_patchConfig as patchWranglerConfig,
  experimental_readRawConfig as readRawWranglerConfig,
} from "wrangler";
import { CONFIG_PATH, deployControlPlane } from "./deploy-helpers.mjs";

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
      reject(new Error(`${tool} ${args.join(" ")} failed with ${reason}`));
    });
  });
}

if (!existsSync(configAbsolute)) {
  process.stderr.write(
    `${CONFIG_PATH} not found — generate it with \`npm run config -w packages/control-plane\` and fill in your values.\n`,
  );
  process.exit(1);
}

const rawConfig = readRawWranglerConfig({ config: configAbsolute }).rawConfig;

deployControlPlane({
  configPath: CONFIG_PATH,
  rawConfig,
  run,
  patchConfig(patch) {
    try {
      patchWranglerConfig(configAbsolute, patch, false);
    } catch (error) {
      // The D1 database exists by now, so name the recovery: a rerun reuses it.
      throw new Error(
        `writing the D1 database_id into ${CONFIG_PATH} failed: ${error instanceof Error ? error.message : "config patch failed"}\nThe database already exists and rerunning the deploy reuses it. wrangler cannot patch a config that holds comments — strip them, or regenerate the config with \`npm run config -w packages/control-plane\`, then rerun.`,
      );
    }
  },
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "deployment failed"}\n`);
  process.exitCode = 1;
});
