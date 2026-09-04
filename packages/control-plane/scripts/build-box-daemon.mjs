#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readLodyDaemonMetadata } from "./lib/box-daemon.mjs";
import { createDeterministicTarGzip, hashFile } from "./lib/deterministic-archive.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIRECTORY, "../../..");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (piece) => {
      stdout += piece;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

export async function stageDaemonArchive(sourceDirectory, outputPath) {
  const required = [
    path.join(sourceDirectory, "bin/lody"),
    path.join(sourceDirectory, "lib/node_modules/lody"),
  ];
  for (const requiredPath of required) {
    if (await stat(requiredPath).catch(() => null) === null) {
      throw new Error(`daemon prefix is missing ${path.relative(sourceDirectory, requiredPath)}`);
    }
  }
  if (await stat(outputPath).catch(() => null) !== null) {
    throw new Error(`refusing to overwrite daemon archive: ${outputPath}`);
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await createDeterministicTarGzip(sourceDirectory, outputPath, ["bin", "lib"]);
  return hashFile(outputPath);
}

function usage() {
  return `Build the patched Lody prefix as a deterministic daemon.tar.gz.

Usage:
  node packages/control-plane/scripts/build-box-daemon.mjs --out <daemon.tar.gz> [options]

Options:
  --out <file>      Output archive. Required.
  --repo <dir>      Repository root (default: current repository).
  --image <tag>     Copy the daemon prefix from an existing Docker image instead
                    of building the Dockerfile's daemon target.
  --json <file>     Also write {version,protocolVersion,sha256,bytes,path}.
  --help, -h        Print this text.`;
}

function parseCli(argv) {
  const options = {
    outPath: undefined,
    repo: DEFAULT_REPO,
    image: undefined,
    jsonPath: undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      return options;
    }
    if (!["--out", "--repo", "--image", "--json"].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === "--out") options.outPath = path.resolve(value);
    else if (flag === "--repo") options.repo = path.resolve(value);
    else if (flag === "--image") options.image = value;
    else options.jsonPath = path.resolve(value);
  }
  if (options.outPath === undefined) throw new Error("--out is required");
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "blitz-box-daemon-"));
  const temporaryImage = options.image === undefined
    ? `blitz-box-daemon-stage:${process.pid}`
    : undefined;
  const image = options.image ?? temporaryImage;
  let container;
  try {
    if (temporaryImage !== undefined) {
      await run("docker", [
        "build",
        "--platform", "linux/amd64",
        "--target", "daemon",
        "--file", path.join(options.repo, "packages/box/Dockerfile"),
        "--tag", temporaryImage,
        options.repo,
      ]);
    }
    container = await output("docker", ["create", image]);
    const prefix = path.join(temporary, "prefix");
    await mkdir(prefix);
    await run("docker", ["cp", `${container}:/opt/blitz/lody/baked/.`, prefix]);
    const archive = await stageDaemonArchive(prefix, options.outPath);
    const metadata = await readLodyDaemonMetadata(options.repo);
    const result = { ...metadata, ...archive, path: options.outPath };
    const json = `${JSON.stringify(result)}\n`;
    if (options.jsonPath !== undefined) await writeFile(options.jsonPath, json, "utf8");
    process.stdout.write(json);
  } finally {
    if (container !== undefined) await output("docker", ["rm", "-f", container]).catch(() => {});
    if (temporaryImage !== undefined) {
      await output("docker", ["image", "rm", temporaryImage]).catch(() => {});
    }
    await rm(temporary, { recursive: true, force: true });
  }
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
