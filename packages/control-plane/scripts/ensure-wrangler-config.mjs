#!/usr/bin/env node

// wrangler.toml is per-deployment and gitignored, but the vitest workers pool
// loads ./wrangler.toml for bindings. On a fresh clone this script copies the
// committed example into place so `npm test` runs without manual setup. The
// copy carries placeholder values; the deploy script refuses to deploy it.

import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(packageDir, "wrangler.toml");
const examplePath = path.join(packageDir, "wrangler.toml.example");

if (!existsSync(configPath)) {
  if (!existsSync(examplePath)) {
    process.stderr.write(
      "packages/control-plane/wrangler.toml is missing and wrangler.toml.example was not found to restore it from.\n",
    );
    process.exit(1);
  }
  copyFileSync(examplePath, configPath);
  process.stdout.write(
    "created packages/control-plane/wrangler.toml from wrangler.toml.example (placeholder values — fill them in before deploying)\n",
  );
}
