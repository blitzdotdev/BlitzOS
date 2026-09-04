#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import {
  boxPayloadPrefix,
  boxPayloadVersion,
  readBoxPayloadCreatedAt,
  readBoxPayloadInputIds,
} from "./box-payload-key.mjs";
import { readLodyDaemonMetadata } from "./lib/box-daemon.mjs";
import { validateBoxPayloadManifest } from "./lib/box-payload-manifest.mjs";
import { createDeterministicTarGzip, hashFile } from "./lib/deterministic-archive.mjs";
import {
  copyPayloadSources,
  PAYLOAD_FILES,
  payloadMode,
  readPayloadRestartMap,
} from "./lib/box-payload-files.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_REPO = path.resolve(PACKAGE_DIRECTORY, "../..");
const WRANGLER_CONFIG_PATH = path.join(PACKAGE_DIRECTORY, "wrangler.toml");
const DEFAULT_BUCKET = "blitz-box-images";
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9._-]$/u;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (piece) => {
      stderr += piece;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        const detail = stderr.trim().split("\n").at(-1) ?? "";
        reject(new Error(
          `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`
          + (detail === "" ? "" : `: ${detail}`),
        ));
      }
    });
  });
}

function validatePrefix(prefix) {
  if (prefix.length > 180 || !PREFIX_PATTERN.test(prefix) || prefix.includes("//")) {
    throw new Error(`--prefix is invalid: ${prefix}`);
  }
}

function validatedOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`--app-url must be an HTTP(S) origin: ${value}`);
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.pathname !== "/") {
    throw new Error(`--app-url must be an HTTP(S) origin: ${value}`);
  }
  return parsed.href.replace(/\/$/u, "");
}

async function hashPayloadFile(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

export async function buildGoPayloadBinaries(repoRoot, destination) {
  await mkdir(destination, { recursive: true });
  const buildEnvironment = {
    ...process.env,
    CGO_ENABLED: "0",
    GOOS: "linux",
    GOARCH: "amd64",
  };
  await run("go", [
    "build", "-trimpath", "-ldflags=-s -w",
    "-o", path.join(destination, "blitz-box-gateway"),
    ".",
  ], { cwd: path.join(repoRoot, "packages/box/gateway"), env: buildEnvironment });
  await run("go", [
    "build", "-trimpath", "-ldflags=-s -w",
    "-o", path.join(destination, "blitz-cred"),
    "./cmd/blitz-cred",
  ], { cwd: path.join(repoRoot, "packages/broker"), env: buildEnvironment });
}

async function copyPayloadBinaries(binariesDirectory, stagingDirectory) {
  for (const name of ["blitz-box-gateway", "blitz-cred"]) {
    const sourcePath = path.join(binariesDirectory, name);
    const targetPath = path.join(stagingDirectory, "rootfs/usr/local/bin", name);
    if (await stat(sourcePath).catch(() => null) === null) {
      throw new Error(`payload binary is missing: ${sourcePath}`);
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, 0o755);
  }
}

async function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (piece) => {
      stdout += piece;
    });
    child.stderr.on("data", (piece) => {
      stderr += piece;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(
        `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`
        + (stderr.trim() === "" ? "" : `: ${stderr.trim()}`),
      ));
    });
  });
}

async function verifyDaemonArchive(daemonPath) {
  const listing = await commandOutput("tar", ["-tzf", daemonPath]);
  const entries = listing.split("\n").filter((entry) => entry !== "");
  if (!entries.includes("bin/lody")) throw new Error("daemon archive is missing bin/lody");
  if (!entries.some((entry) => entry.startsWith("lib/node_modules/lody/"))) {
    throw new Error("daemon archive is missing lib/node_modules/lody");
  }
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/u, "");
    if (
      normalized === "bin"
      || normalized === "bin/lody"
      || normalized === "lib"
      || normalized === "lib/node_modules"
      || normalized === "lib/node_modules/lody"
      || normalized.startsWith("lib/node_modules/lody/")
    ) continue;
    throw new Error(`daemon archive contains a path outside the lody prefix: ${entry}`);
  }
}

export async function stageBoxPayloadRelease({
  repoRoot,
  stagingDirectory,
  outputDirectory,
  binariesDirectory,
  daemonPath,
  version,
  createdAt,
  appUrl,
  prefix,
}) {
  const payloadArchivePath = path.join(outputDirectory, "payload.tar.gz");
  const daemonArchivePath = path.join(outputDirectory, "daemon.tar.gz");
  const manifestPath = path.join(outputDirectory, "manifest.json");
  const outputs = daemonPath === undefined
    ? [payloadArchivePath, manifestPath]
    : [payloadArchivePath, daemonArchivePath, manifestPath];
  for (const outputPath of outputs) {
    if (await stat(outputPath).catch(() => null) !== null) {
      throw new Error(`refusing to overwrite staged payload release: ${outputPath}`);
    }
  }
  await mkdir(outputDirectory, { recursive: true });
  await copyPayloadSources(repoRoot, stagingDirectory);
  await copyPayloadBinaries(binariesDirectory, stagingDirectory);

  const files = [];
  for (const archivePath of PAYLOAD_FILES) {
    const filePath = path.join(stagingDirectory, archivePath);
    files.push({
      path: archivePath,
      sha256: await hashPayloadFile(filePath),
      mode: payloadMode(archivePath).toString(8).padStart(4, "0"),
    });
  }
  await createDeterministicTarGzip(stagingDirectory, payloadArchivePath, ["rootfs"]);
  const payloadArchive = await hashFile(payloadArchivePath);
  const manifest = {
    version,
    createdAt,
    minUpdater: 1,
    files,
    archive: {
      url: `${appUrl}/${prefix}/payload.tar.gz`,
      ...payloadArchive,
    },
  };
  if (daemonPath !== undefined) {
    await verifyDaemonArchive(daemonPath);
    await copyFile(daemonPath, daemonArchivePath);
    const daemonArchive = await hashFile(daemonArchivePath);
    const daemon = await readLodyDaemonMetadata(repoRoot);
    manifest.daemon = {
      version: daemon.version,
      protocolVersion: daemon.protocolVersion,
      url: `${appUrl}/${prefix}/daemon.tar.gz`,
      ...daemonArchive,
    };
  }
  manifest.restart = await readPayloadRestartMap(repoRoot);
  validateBoxPayloadManifest(manifest, new Set(Object.keys(manifest.restart)));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, manifestPath, payloadArchivePath, daemonArchivePath };
}

function tomlRecord(value) {
  return value !== null && Object(value) === value && !Array.isArray(value) ? value : undefined;
}

function tomlString(value) {
  return String(value) === value ? value : undefined;
}

async function wranglerDefaults() {
  const text = await readFile(WRANGLER_CONFIG_PATH, "utf8").catch(() => null);
  if (text === null) return { bucket: undefined, appUrl: undefined };
  const config = tomlRecord(parseToml(text)) ?? {};
  const buckets = Array.isArray(config.r2_buckets) ? config.r2_buckets : [];
  const boxImages = buckets.map(tomlRecord)
    .find((bucket) => bucket !== undefined && bucket.binding === "BOX_IMAGES");
  return {
    bucket: boxImages === undefined ? undefined : tomlString(boxImages.bucket_name),
    appUrl: tomlString((tomlRecord(config.vars) ?? {}).APP_URL),
  };
}

async function uploadObject(repoRoot, bucket, logicalPath, sourcePath, contentType) {
  const wrangler = path.join(repoRoot, "node_modules/.bin/wrangler");
  if (await stat(wrangler).catch(() => null) === null) {
    throw new Error(`wrangler binary is missing at ${wrangler}; run npm install first`);
  }
  process.stderr.write(`uploading ${bucket}/${logicalPath}\n`);
  await run(wrangler, [
    "r2", "object", "put", `${bucket}/${logicalPath}`,
    "--file", sourcePath,
    "--content-type", contentType,
    "--remote",
    "--config", WRANGLER_CONFIG_PATH,
  ], {
    cwd: repoRoot,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
}

async function uploadRelease(repoRoot, bucket, prefix, staged) {
  // The manifest is deliberately last: an interrupted upload is not pinnable.
  const objects = [
    ["payload.tar.gz", staged.payloadArchivePath, "application/gzip"],
    ...(staged.manifest.daemon === undefined
      ? []
      : [["daemon.tar.gz", staged.daemonArchivePath, "application/gzip"]]),
    ["manifest.json", staged.manifestPath, "application/json; charset=utf-8"],
  ];
  for (const [name, sourcePath, contentType] of objects) {
    await uploadObject(repoRoot, bucket, `${prefix}/${name}`, sourcePath, contentType);
  }
}

function usage() {
  return `Build and publish a content-derived box payload.

Usage:
  node packages/control-plane/scripts/publish-box-payload.mjs --app-url <origin> [options]

Options:
  --app-url <origin>  Origin used for artifact URLs (default: wrangler APP_URL).
  --prefix <prefix>   R2 key prefix (default: box-payload/<derived-version>).
  --daemon <file>     Include this prebuilt daemon.tar.gz and its metadata.
  --binaries <dir>    Use prebuilt blitz-box-gateway and blitz-cred binaries.
  --out <dir>         Staging directory to keep. With --dry-run, defaults to
                      ./box-payload/<derived-version>.
  --bucket <name>     R2 bucket (default: wrangler BOX_IMAGES bucket).
  --repo <dir>        Repository root (default: current repository).
  --rev <revision>    Git revision used for version and createdAt (default: HEAD).
  --json <file>       Also write {version,ref,prefix,archive,daemon?}.
  --dry-run           Build and verify locally without uploading to R2.
  --help, -h          Print this text.`;
}

function parseCli(argv) {
  const options = {
    appUrl: undefined,
    prefix: undefined,
    daemonPath: undefined,
    binariesDirectory: undefined,
    outputDirectory: undefined,
    bucket: undefined,
    repoRoot: DEFAULT_REPO,
    rev: "HEAD",
    jsonPath: undefined,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      return options;
    }
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (![
      "--app-url", "--prefix", "--daemon", "--binaries", "--out",
      "--bucket", "--repo", "--rev", "--json",
    ].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === "--app-url") options.appUrl = value;
    else if (flag === "--prefix") options.prefix = value;
    else if (flag === "--daemon") options.daemonPath = path.resolve(value);
    else if (flag === "--binaries") options.binariesDirectory = path.resolve(value);
    else if (flag === "--out") options.outputDirectory = path.resolve(value);
    else if (flag === "--bucket") options.bucket = value;
    else if (flag === "--repo") options.repoRoot = path.resolve(value);
    else if (flag === "--rev") options.rev = value;
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
  const defaults = await wranglerDefaults();
  const inputIds = await readBoxPayloadInputIds({ repo: options.repoRoot, rev: options.rev });
  const version = boxPayloadVersion(inputIds);
  const prefix = options.prefix ?? boxPayloadPrefix(version);
  validatePrefix(prefix);
  const configAppUrl = defaults.appUrl !== undefined && /^https?:\/\//u.test(defaults.appUrl)
    ? defaults.appUrl
    : undefined;
  const appUrl = validatedOrigin(options.appUrl ?? configAppUrl ?? "");
  const bucket = options.bucket ?? defaults.bucket ?? DEFAULT_BUCKET;
  const createdAt = await readBoxPayloadCreatedAt({ repo: options.repoRoot, rev: options.rev });
  const temporary = await mkdtemp(path.join(tmpdir(), "blitz-box-payload-"));
  const outputDirectory = options.outputDirectory
    ?? (options.dryRun ? path.resolve("box-payload", version) : path.join(temporary, "release"));
  const binariesDirectory = options.binariesDirectory ?? path.join(temporary, "binaries");
  try {
    if (options.binariesDirectory === undefined) {
      await buildGoPayloadBinaries(options.repoRoot, binariesDirectory);
    }
    const staged = await stageBoxPayloadRelease({
      repoRoot: options.repoRoot,
      stagingDirectory: path.join(temporary, "payload"),
      outputDirectory,
      binariesDirectory,
      daemonPath: options.daemonPath,
      version,
      createdAt,
      appUrl,
      prefix,
    });
    if (options.dryRun) {
      process.stderr.write(`dry run: wrote verified payload release to ${outputDirectory}\n`);
    } else {
      await uploadRelease(options.repoRoot, bucket, prefix, staged);
      process.stderr.write(`uploaded payload release ${version} to ${bucket}/${prefix}\n`);
    }
    const published = {
      version,
      ref: `${appUrl}/${prefix}/manifest.json`,
      prefix,
      archive: staged.manifest.archive,
    };
    if (staged.manifest.daemon !== undefined) published.daemon = staged.manifest.daemon;
    if (options.jsonPath !== undefined) {
      await writeFile(options.jsonPath, `${JSON.stringify(published)}\n`, "utf8");
    }
    process.stdout.write(`BOX_PAYLOAD_REF = "${published.ref}"\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (/^(unknown argument|--)/u.test(message)) process.stderr.write(`\n${usage()}\n`);
    process.exitCode = 1;
  });
}
