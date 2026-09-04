#!/usr/bin/env node

// A payload version names only bytes a box can install. The publisher and
// planner both stage the exact archive file set (including the built Go
// binaries) before calling this module, so their keys agree without treating
// build scripts, the base-owned updater, or Git history as payload content.
//
// The payload archive digest itself cannot participate because the archive
// contains payload-version. Instead the key covers the sorted path/digest/mode
// records that the manifest verifies, the daemon archive digest (or "none"),
// and the canonical restart map. The planner deliberately pays the cost of a
// dry release build; that keeps it on the publisher's byte-for-byte path.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PAYLOAD_FILES,
  payloadMode,
  readPayloadRestartMap,
} from "./lib/box-payload-files.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIRECTORY, "../../..");
const PAYLOAD_VERSION_PATTERN = /^[a-f0-9]{64}$/u;
const MODE_PATTERN = /^0[0-7]{3}$/u;

function checkedDigest(value, label) {
  if (String(value) !== value || !PAYLOAD_VERSION_PATTERN.test(value)) {
    throw new Error(`${label} must be a 64-character lowercase hexadecimal digest`);
  }
  return value;
}

function checkedMode(value, label) {
  if (String(value) !== value || !MODE_PATTERN.test(value)) {
    throw new Error(`${label} must be a four-character octal mode`);
  }
  return value;
}

function canonicalPayloadContent({ files, daemonSha256, restart }) {
  const sortedFiles = [...files].sort((left, right) => left.path.localeCompare(right.path));
  for (const [index, entry] of sortedFiles.entries()) {
    if (String(entry.path) !== entry.path || entry.path === "") {
      throw new Error(`files[${index}].path must be a non-empty string`);
    }
    if (index > 0 && sortedFiles[index - 1].path === entry.path) {
      throw new Error(`payload file path is duplicated: ${entry.path}`);
    }
    checkedDigest(entry.sha256, `files[${index}].sha256`);
    checkedMode(entry.mode, `files[${index}].mode`);
  }
  const restartEntries = Object.entries(restart)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([service, dependencies]) => [service, [...dependencies].sort()]);
  return {
    files: sortedFiles.map((entry) => [entry.path, entry.sha256, entry.mode]),
    daemon: daemonSha256 === undefined ? "none" : checkedDigest(daemonSha256, "daemon sha256"),
    restart: restartEntries,
  };
}

export function boxPayloadVersion(content) {
  const source = `${JSON.stringify(canonicalPayloadContent(content))}\n`;
  return createHash("sha256").update(source).digest("hex");
}

export function boxPayloadPrefix(version) {
  return `box-payload/${checkedDigest(version, "payload version")}`;
}

async function hashPayloadFile(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

export async function readBoxPayloadContent({
  repoRoot = DEFAULT_REPO,
  payloadRoot,
  daemonPath,
}) {
  if (payloadRoot === undefined) throw new Error("payloadRoot is required");
  const files = [];
  for (const archivePath of PAYLOAD_FILES) {
    files.push({
      path: archivePath,
      sha256: await hashPayloadFile(path.join(payloadRoot, archivePath)),
      mode: payloadMode(archivePath).toString(8).padStart(4, "0"),
    });
  }
  return {
    files,
    daemonSha256: daemonPath === undefined ? undefined : await hashPayloadFile(daemonPath),
    restart: await readPayloadRestartMap(repoRoot),
  };
}

export async function resolveBoxPayloadVersion(options) {
  const content = await readBoxPayloadContent(options);
  const derived = boxPayloadVersion(content);
  if (
    options.providedVersion !== undefined
    && checkedDigest(options.providedVersion, "BLITZ_PAYLOAD_VERSION") !== derived
  ) {
    throw new Error("BLITZ_PAYLOAD_VERSION does not match the staged payload content");
  }
  return derived;
}

export async function writeBoxPayloadVersionStamp(destination, version) {
  const checked = checkedDigest(version, "payload version");
  await writeFile(path.join(destination, "payload-version"), `${checked}\n`, "utf8");
}

function gitOutput(repo, args, failureMessage) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(new Error(failureMessage));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function readBoxPayloadCreatedAt({ repo = DEFAULT_REPO, rev = "HEAD" } = {}) {
  const seconds = await gitOutput(
    repo,
    ["show", "-s", "--format=%ct", rev],
    `could not read commit time for ${rev}`,
  );
  if (!/^[0-9]+$/u.test(seconds)) throw new Error(`git returned an invalid commit time for ${rev}`);
  const milliseconds = Number(seconds) * 1000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`commit time for ${rev} is out of range`);
  return milliseconds;
}

function usage() {
  return `Compute the content-derived release key for a staged box payload.

Usage:
  node packages/control-plane/scripts/box-payload-key.mjs --payload-root <dir> [options]

Options:
  --payload-root <dir>  Staged archive root containing every payload file. Required.
  --daemon <file>       Include this daemon archive's SHA-256 in the version.
  --repo <dir>          Repository used to derive the restart map.
  --json <file>         Also write the JSON result to this file.
  --help, -h            Print this text.`;
}

function parseCli(argv) {
  const options = {
    repoRoot: DEFAULT_REPO,
    payloadRoot: undefined,
    daemonPath: undefined,
    jsonPath: undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      return options;
    }
    if (!["--payload-root", "--daemon", "--repo", "--json"].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === "--payload-root") options.payloadRoot = path.resolve(value);
    else if (flag === "--daemon") options.daemonPath = path.resolve(value);
    else if (flag === "--repo") options.repoRoot = path.resolve(value);
    else options.jsonPath = path.resolve(value);
  }
  if (options.payloadRoot === undefined) throw new Error("--payload-root is required");
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const version = await resolveBoxPayloadVersion(options);
  const result = { version, prefix: boxPayloadPrefix(version) };
  const json = `${JSON.stringify(result)}\n`;
  if (options.jsonPath !== undefined) await writeFile(options.jsonPath, json, "utf8");
  process.stdout.write(json);
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
