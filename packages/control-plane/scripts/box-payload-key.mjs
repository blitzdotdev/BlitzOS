#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIRECTORY, "../../..");
const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

// Directory object IDs keep this list compact while still hashing every file
// that can affect the payload, its two Go binaries, or the optional daemon.
export const BOX_PAYLOAD_INPUTS = Object.freeze([
  "env.defaults",
  "packages/box/Dockerfile",
  "packages/box/gateway",
  "packages/box/patches",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d",
  "packages/box/rootfs/opt/blitz/skel",
  "packages/box/rootfs/usr/local/bin",
  "packages/box/rootfs/usr/local/libexec",
  "packages/broker/cmd/blitz-cred",
  "packages/broker/go.mod",
  "packages/broker/internal",
  "packages/control-plane/scripts/lib/box-daemon.mjs",
  "packages/control-plane/scripts/lib/box-payload-files.mjs",
  "vendor/lody/UPSTREAM.md",
  "vendor/lody/packages/shared/src/local-loro-data-plane.ts",
]);

export function boxPayloadVersion(entries) {
  const source = entries.map(({ path: inputPath, id }) => `${inputPath}\t${id}\n`).join("");
  return createHash("sha256").update(source).digest("hex");
}

export function boxPayloadPrefix(version) {
  return `box-payload/${version}`;
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

export async function readBoxPayloadInputIds({ repo = DEFAULT_REPO, rev = "HEAD" } = {}) {
  const ids = await Promise.all(BOX_PAYLOAD_INPUTS.map(async (inputPath) => {
    const id = await gitOutput(
      repo,
      ["rev-parse", "--verify", `${rev}:${inputPath}`],
      `box-payload input is missing at ${rev}: ${inputPath}`,
    );
    if (!GIT_OBJECT_ID_PATTERN.test(id)) {
      throw new Error(`git returned an invalid object id for ${rev}:${inputPath}`);
    }
    return id;
  }));
  return BOX_PAYLOAD_INPUTS.map((inputPath, index) => ({ path: inputPath, id: ids[index] }));
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
  return `Compute the content-derived release key for the box payload.

Usage:
  node packages/control-plane/scripts/box-payload-key.mjs [options]

Options:
  --rev <revision>  Git revision whose payload inputs should be read (default: HEAD).
  --repo <dir>      Repository containing the revision (default: repository root).
  --json <file>     Also write the JSON result to this file.
  --help, -h        Print this text.`;
}

function parseCli(argv) {
  const options = { rev: "HEAD", repo: DEFAULT_REPO, jsonPath: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      return options;
    }
    if (!["--rev", "--repo", "--json"].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === "--rev") options.rev = value;
    else if (flag === "--repo") options.repo = path.resolve(value);
    else options.jsonPath = path.resolve(value);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const entries = await readBoxPayloadInputIds(options);
  const version = boxPayloadVersion(entries);
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

