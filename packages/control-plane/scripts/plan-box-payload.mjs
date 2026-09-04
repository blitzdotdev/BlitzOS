#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  boxPayloadPrefix,
  boxPayloadVersion,
  readBoxPayloadInputIds,
} from "./box-payload-key.mjs";
import { validateBoxPayloadManifest } from "./lib/box-payload-manifest.mjs";

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

export async function planBoxPayload({
  url,
  rev = "HEAD",
  repo,
  fetchImpl = fetch,
}) {
  const entries = await readBoxPayloadInputIds({ repo, rev });
  const version = boxPayloadVersion(entries);
  const prefix = boxPayloadPrefix(version);
  const ref = manifestReference(url, prefix);
  let response;
  try {
    response = await fetchImpl(ref, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(`GET ${ref} failed: ${errorMessage(error)}`);
  }
  if (response.status === 404) return { published: false, version, prefix, ref };
  if (response.status !== 200) {
    throw new Error(`GET ${ref} answered ${response.status}; refusing to treat it as unpublished`);
  }
  let manifest;
  try {
    manifest = validateBoxPayloadManifest(await response.json());
  } catch (error) {
    throw new Error(`GET ${ref} returned an invalid box-payload manifest: ${errorMessage(error)}`);
  }
  if (manifest.version !== version) {
    throw new Error(`GET ${ref} returned version ${manifest.version}, expected ${version}`);
  }
  const result = {
    published: true,
    version,
    prefix,
    ref,
    sha256: manifest.archive.sha256,
  };
  if (manifest.daemon !== undefined) result.daemonVersion = manifest.daemon.version;
  return result;
}

function usage() {
  return `Plan whether the content-derived box payload needs to be published.

Usage:
  node packages/control-plane/scripts/plan-box-payload.mjs --url <origin> [options]

Options:
  --url <origin>    Control-plane origin whose R2-backed route should be probed.
  --rev <revision>  Git revision whose payload inputs should be read (default: HEAD).
  --repo <dir>      Repository containing the revision (default: repository root).
  --json <file>     Also write the JSON result to this file.
  --help, -h        Print this text.`;
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
  const result = await planBoxPayload({ ...options, fetchImpl });
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
