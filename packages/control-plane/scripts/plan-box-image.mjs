#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  boxImagePrefix,
  boxImageReleaseId,
  boxImageTag,
  readBoxImageInputIds,
} from "./box-image-key.mjs";
import { validateBoxImageManifest } from "./lib/asset-pack.mjs";

function usage() {
  return `Plan whether the content-derived box image needs to be published.

Usage:
  node packages/control-plane/scripts/plan-box-image.mjs --url <origin> [options]

Options:
  --url <origin>    Control-plane origin whose R2-backed route should be probed.
  --rev <revision>  Git revision whose image inputs should be read (default: HEAD).
  --repo <dir>      Repository containing the revision (default: repository root).
  --json <file>     Also write the JSON result to this file.
  --help, -h        Print this text.`;
}

function manifestReference(origin, prefix) {
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`--url must be an HTTP(S) origin: ${origin}`);
  }
  return new URL(`/${prefix}/manifest.json`, parsed).href;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function planBoxImage({
  url,
  rev = "HEAD",
  repo,
  fetchImpl = fetch,
}) {
  const entries = await readBoxImageInputIds({ repo, rev });
  const releaseId = boxImageReleaseId(entries);
  const imageTag = boxImageTag(releaseId);
  const prefix = boxImagePrefix(releaseId);
  const ref = manifestReference(url, prefix);

  let response;
  try {
    response = await fetchImpl(ref, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(`GET ${ref} failed: ${errorMessage(error)}`);
  }

  if (response.status === 404) {
    return { published: false, releaseId, imageTag, prefix, ref };
  }
  if (response.status !== 200) {
    throw new Error(`GET ${ref} answered ${response.status}; refusing to treat it as unpublished`);
  }

  let manifest;
  try {
    manifest = validateBoxImageManifest(await response.json());
  } catch (error) {
    throw new Error(`GET ${ref} returned an invalid box-image manifest: ${errorMessage(error)}`);
  }
  if (manifest.imageTag !== imageTag) {
    throw new Error(
      `GET ${ref} returned imageTag ${manifest.imageTag}, expected ${imageTag}`,
    );
  }
  return {
    published: true,
    releaseId,
    imageTag,
    prefix,
    ref,
    sha256: manifest.totalSha256,
  };
}

function parseCli(argv) {
  const options = {
    url: undefined,
    rev: "HEAD",
    repo: undefined,
    jsonPath: undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      return options;
    }
    if (!["--url", "--rev", "--repo", "--json"].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === "--url") options.url = value;
    else if (flag === "--rev") options.rev = value;
    else if (flag === "--repo") options.repo = path.resolve(value);
    else options.jsonPath = path.resolve(value);
  }
  if (options.url === undefined) throw new Error("--url is required");
  return options;
}

export async function main(argv = process.argv.slice(2), fetchImpl = fetch) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await planBoxImage({ ...options, fetchImpl });
  const json = `${JSON.stringify(result)}\n`;
  if (options.jsonPath !== undefined) await writeFile(options.jsonPath, json, "utf8");
  process.stdout.write(json);
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
