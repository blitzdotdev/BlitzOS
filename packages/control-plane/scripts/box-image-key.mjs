#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BOX_IMAGE_INPUTS } from "./lib/box-image-inputs.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIRECTORY, "../../..");
const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function usage() {
  return `Compute the content-derived release key for the box image.

Usage:
  node packages/control-plane/scripts/box-image-key.mjs [options]

Options:
  --rev <revision>  Git revision whose image inputs should be read (default: HEAD).
  --repo <dir>      Repository containing the revision (default: repository root).
  --json <file>     Also write the JSON result to this file.
  --help, -h        Print this text.`;
}

export function boxImageReleaseId(entries) {
  const source = entries.map(({ path: inputPath, id }) => `${inputPath}\t${id}\n`).join("");
  return createHash("sha256").update(source).digest("hex");
}

export function boxImageTag(releaseId) {
  return `blitz-box:${releaseId}`;
}

export function boxImagePrefix(releaseId) {
  return `box-image/${releaseId}`;
}

function gitObjectId(repo, rev, inputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["rev-parse", "--verify", `${rev}:${inputPath}`],
      { cwd: repo, encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(`box-image input is missing at ${rev}: ${inputPath}`));
          return;
        }
        const id = stdout.trim();
        if (!GIT_OBJECT_ID_PATTERN.test(id)) {
          reject(new Error(`git returned an invalid object id for ${rev}:${inputPath}`));
          return;
        }
        resolve(id);
      },
    );
  });
}

export async function readBoxImageInputIds({ repo = DEFAULT_REPO, rev = "HEAD" } = {}) {
  // Resolve each path independently because Git can read these objects from a
  // depth-one checkout without needing a merge base or any earlier commit.
  const ids = await Promise.all(
    BOX_IMAGE_INPUTS.map((inputPath) => gitObjectId(repo, rev, inputPath)),
  );
  return BOX_IMAGE_INPUTS.map((inputPath, index) => ({ path: inputPath, id: ids[index] }));
}

function parseCli(argv) {
  const options = { rev: "HEAD", repo: DEFAULT_REPO, jsonPath: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      return options;
    }
    if (!["--rev", "--repo", "--json"].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
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
  const entries = await readBoxImageInputIds(options);
  const releaseId = boxImageReleaseId(entries);
  const result = {
    releaseId,
    imageTag: boxImageTag(releaseId),
    prefix: boxImagePrefix(releaseId),
  };
  const json = `${JSON.stringify(result)}\n`;
  if (options.jsonPath !== undefined) await writeFile(options.jsonPath, json, "utf8");
  process.stdout.write(json);
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "could not compute box-image key"}\n`);
    process.exitCode = 1;
  });
}
