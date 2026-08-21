#!/usr/bin/env node

// Pins the box image [vars] in wrangler.toml to a digest-pinned registry
// reference (Mode A in docs/BOX-IMAGE.md): BOX_IMAGE_REF gets the reference,
// and BOX_IMAGE_TAG / BOX_IMAGE_SHA256 become "" because they are Mode B
// archive fields. The release workflow runs this between writing the
// deployment's wrangler.toml and `npm run deploy`, so a tag push deploys the
// exact image it just built.
//
// Re-serializing through smol-toml drops comments, which the deploy requires
// anyway: its experimental_patchConfig rejects TOML that holds comments.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "smol-toml";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(path.resolve(scriptDirectory, ".."), "wrangler.toml");

// Registry references are pinned by digest, never by tag: the VM pulls
// whatever the reference resolves to at boot, and only a digest is immutable.
const DIGEST_REFERENCE_PATTERN =
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/u;

export function isDigestPinnedImageReference(reference) {
  return DIGEST_REFERENCE_PATTERN.test(reference);
}

export function withBoxImageReference(configToml, reference) {
  if (!isDigestPinnedImageReference(reference)) {
    throw new Error(
      `box image reference must be a lowercase digest-pinned registry reference (registry/name@sha256:<64 hex>), got: ${reference}`,
    );
  }
  const config = parse(configToml);
  const vars = config.vars;
  if (!(vars instanceof Object) || Array.isArray(vars)) {
    throw new Error("wrangler config must define a [vars] table");
  }
  return stringify({
    ...config,
    vars: { ...vars, BOX_IMAGE_REF: reference, BOX_IMAGE_TAG: "", BOX_IMAGE_SHA256: "" },
  });
}

function parseArguments(argv) {
  const options = { reference: undefined, configPath: defaultConfigPath };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--ref") options.reference = value;
    else if (flag === "--config") options.configPath = path.resolve(value);
    else {
      throw new Error(
        `unknown option: ${flag}\nusage: set-box-image-ref.mjs --ref <registry/name@sha256:digest> [--config <wrangler.toml>]`,
      );
    }
  }
  if (options.reference === undefined) throw new Error("--ref is required");
  return options;
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const configToml = await readFile(options.configPath, "utf8");
    await writeFile(options.configPath, withBoxImageReference(configToml, options.reference));
    process.stdout.write(`BOX_IMAGE_REF pinned to ${options.reference} in ${options.configPath}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "could not set the box image reference"}\n`,
    );
    process.exit(1);
  }
}
