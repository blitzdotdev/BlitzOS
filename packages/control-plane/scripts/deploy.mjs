#!/usr/bin/env node

import { spawn } from "node:child_process";
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

const rawConfig = readRawWranglerConfig({ config: configAbsolute }).rawConfig;

deployControlPlane({
  configPath: CONFIG_PATH,
  rawConfig,
  run,
  patchConfig(patch) {
    patchWranglerConfig(configAbsolute, patch, false);
  },
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "deployment failed"}\n`);
  process.exitCode = 1;
});
