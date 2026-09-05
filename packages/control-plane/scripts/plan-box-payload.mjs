#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boxPayloadPrefix } from "./box-payload-key.mjs";
import { validateBoxPayloadManifest } from "./lib/box-payload-manifest.mjs";
import {
  buildGoPayloadBinaries,
  stageBoxPayloadRelease,
} from "./publish-box-payload.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIRECTORY, "../../..");

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
  repo = DEFAULT_REPO,
  binariesDirectory,
  daemonPath,
  fetchImpl = fetch,
}) {
  const version = await buildPlannedPayload({
    repo,
    binariesDirectory,
    daemonPath,
    appUrl: url,
  });
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
  if (manifest.minUpdater !== 2 || manifest.directories === undefined) {
    throw new Error(
      `GET ${ref} returned a release outside the publisher protocol 2 shape`,
    );
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

export async function buildPlannedPayload({
  repo = DEFAULT_REPO,
  binariesDirectory,
  daemonPath,
  appUrl = "https://payload.invalid",
}) {
  const temporary = await mkdtemp(path.join(tmpdir(), "blitz-box-payload-plan-"));
  const builtBinaries = binariesDirectory ?? path.join(temporary, "binaries");
  try {
    if (binariesDirectory === undefined) await buildGoPayloadBinaries(repo, builtBinaries);
    const staged = await stageBoxPayloadRelease({
      repoRoot: repo,
      stagingDirectory: path.join(temporary, "payload"),
      outputDirectory: path.join(temporary, "release"),
      binariesDirectory: builtBinaries,
      daemonPath,
      // createdAt is informational and excluded from the content version.
      // Planning therefore does not require Git metadata (git archives have
      // none); publishing reads the real commit time when it emits a manifest.
      createdAt: 1,
      appUrl,
    });
    return staged.version;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function usage() {
  return `Plan whether the content-derived box payload needs to be published.

Usage:
  node packages/control-plane/scripts/plan-box-payload.mjs --url <origin> [options]

Options:
  --url <origin>    Control-plane origin whose R2-backed route should be probed.
  --repo <dir>      Repository whose current payload content is built.
  --daemon <file>   Include this daemon archive's SHA-256 in the version.
  --binaries <dir>  Use a prebuilt blitz-box-gateway binary.
  --json <file>     Also write the JSON result to this file.
  --print-version   Dry-build the release and print only its content version.
  --help, -h        Print this text.`;
}

function parseCli(argv) {
  const options = {
    url: undefined,
    repo: undefined,
    daemonPath: undefined,
    binariesDirectory: undefined,
    jsonPath: undefined,
    printVersion: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      return options;
    }
    if (flag === "--print-version") {
      options.printVersion = true;
      continue;
    }
    if (!["--url", "--repo", "--daemon", "--binaries", "--json"].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === "--url") options.url = value;
    else if (flag === "--repo") options.repo = path.resolve(value);
    else if (flag === "--daemon") options.daemonPath = path.resolve(value);
    else if (flag === "--binaries") options.binariesDirectory = path.resolve(value);
    else options.jsonPath = path.resolve(value);
  }
  if (options.url === undefined && !options.printVersion) throw new Error("--url is required");
  return options;
}

export async function main(argv = process.argv.slice(2), fetchImpl = fetch) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.printVersion) {
    const version = await buildPlannedPayload({
      repo: options.repo ?? DEFAULT_REPO,
      daemonPath: options.daemonPath,
      binariesDirectory: options.binariesDirectory,
    });
    process.stdout.write(`${version}\n`);
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
