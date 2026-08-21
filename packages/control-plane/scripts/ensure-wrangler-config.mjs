#!/usr/bin/env node

// wrangler.toml is per-deployment and gitignored, but the vitest workers pool
// loads ./wrangler.toml for bindings and the deploy reads it. This script
// generates it from the committed example so a fresh clone needs no manual
// setup. The generated file carries placeholder values; the deploy script
// refuses to deploy it.
//
// The generated file carries no comments. wrangler.toml.example documents
// every var inline for humans, but wrangler's experimental_patchConfig — how
// the deploy writes the new D1 database_id back — rejects any TOML holding
// comments ("cannot patch .toml config if comments are present"), so a
// verbatim copy of the example made the first deploy fail for everyone.
// Re-serializing the parsed example keeps every key, section, and value and
// drops only the comments.

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "smol-toml";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, "..");

export function deployableConfigToml(exampleToml) {
  return stringify(parse(exampleToml));
}

/** Resolves true when it wrote the file, false when one was already there. */
export async function ensureWranglerConfig(packageRoot = packageDirectory) {
  const root = path.resolve(packageRoot);
  const configPath = path.join(root, "wrangler.toml");
  const examplePath = path.join(root, "wrangler.toml.example");
  try {
    await access(configPath);
    return false;
  } catch {
    // No config yet — generate one below.
  }
  let example;
  try {
    example = await readFile(examplePath, "utf8");
  } catch {
    throw new Error(
      "packages/control-plane/wrangler.toml is missing and wrangler.toml.example was not found to generate it from.",
    );
  }
  // wx never clobbers a config an operator already filled in.
  try {
    await writeFile(configPath, deployableConfigToml(example), { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  return true;
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  try {
    if (await ensureWranglerConfig()) {
      process.stdout.write(
        "created packages/control-plane/wrangler.toml from wrangler.toml.example (placeholder values — fill them in before deploying; wrangler.toml.example documents every var)\n",
      );
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "could not generate wrangler.toml"}\n`,
    );
    process.exit(1);
  }
}
