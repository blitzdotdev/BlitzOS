#!/usr/bin/env node

import { spawn } from "node:child_process";
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
import {
  boxPayloadVersion,
  boxPayloadPrefix,
  readBoxPayloadContent,
  readBoxPayloadCreatedAt,
  writeBoxPayloadVersionStamp,
} from "./box-payload-key.mjs";
import {
  LODY_DAEMON_BUILD_STAMP,
  LODY_DAEMON_VERSION_PATTERN,
  parseLodyDaemonBuildStamp,
  readLodyDaemonProtocolVersion,
  readLodyUpstreamPin,
} from "./lib/box-daemon.mjs";
import { validateBoxPayloadManifest } from "./lib/box-payload-manifest.mjs";
import { createDeterministicTarGzip, hashFile } from "./lib/deterministic-archive.mjs";
import {
  copyPayloadSources,
  PAYLOAD_SERVICES,
} from "./lib/box-payload-files.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_REPO = path.resolve(PACKAGE_DIRECTORY, "../..");
const WRANGLER_CONFIG_PATH = path.join(PACKAGE_DIRECTORY, "wrangler.toml");
const DEFAULT_BUCKET = "blitz-box-images";
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (piece) => {
      stderr += piece;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
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
  const segments = prefix.split("/");
  if (
    prefix.length > 180
    || !PREFIX_PATTERN.test(prefix)
    || prefix.endsWith("/")
    || prefix.includes("//")
    || segments.includes(".")
    || segments.includes("..")
  ) {
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
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.username !== ""
    || parsed.password !== ""
  ) {
    throw new Error(`--app-url must be an HTTP(S) origin: ${value}`);
  }
  return parsed.href.replace(/\/$/u, "");
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
    "build", "-buildvcs=false", "-trimpath", "-ldflags=-s -w",
    "-o", path.join(destination, "blitz-box-gateway"),
    ".",
  ], { cwd: path.join(repoRoot, "packages/box/gateway"), env: buildEnvironment });
}

async function copyPayloadBinaries(binariesDirectory, stagingDirectory) {
  for (const name of ["blitz-box-gateway"]) {
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
    child.once("close", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(
        `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`
        + (stderr.trim() === "" ? "" : `: ${stderr.trim()}`),
      ));
    });
  });
}

/** Reads the daemon identity from the archive's own stamps, and refuses an
 * archive that does not belong to this tree: its packed build stamp must name
 * the upstream commit `vendor/lody` is pinned to, and its protocol stamp must
 * be the version the vendored schema declares. The version token itself is
 * the builder's: `build-box-daemon.mjs` derives it from the build stamp, and
 * the payload lab suffixes it to make a distinct daemon from the same bytes. */
async function readDaemonArchiveMetadata(daemonPath, repoRoot) {
  const listing = await commandOutput("tar", ["-tzf", daemonPath]);
  const entries = listing.split("\n").filter((entry) => entry !== "");
  if (!entries.includes("bin/lody")) throw new Error("daemon archive is missing bin/lody");
  if (!entries.includes("daemon-version")) {
    throw new Error("daemon archive is missing daemon-version");
  }
  if (!entries.includes("daemon-protocol-version")) {
    throw new Error("daemon archive is missing daemon-protocol-version");
  }
  if (!entries.some((entry) => entry.startsWith("lib/node_modules/lody/"))) {
    throw new Error("daemon archive is missing lib/node_modules/lody");
  }
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/u, "");
    if (
      normalized === "bin"
      || normalized === "bin/lody"
      || normalized === "daemon-version"
      || normalized === "daemon-protocol-version"
      || normalized === "lib"
      || normalized === "lib/node_modules"
      || normalized === "lib/node_modules/lody"
      || normalized.startsWith("lib/node_modules/lody/")
    ) continue;
    throw new Error(`daemon archive contains a path outside the lody prefix: ${entry}`);
  }
  if (!entries.includes(LODY_DAEMON_BUILD_STAMP)) {
    throw new Error(`daemon archive is missing ${LODY_DAEMON_BUILD_STAMP}`);
  }
  const [versionStamp, protocolStamp, buildStamp, protocolVersion, pinnedUpstream] =
    await Promise.all([
      commandOutput("tar", ["-xOzf", daemonPath, "daemon-version"]),
      commandOutput("tar", ["-xOzf", daemonPath, "daemon-protocol-version"]),
      commandOutput("tar", ["-xOzf", daemonPath, LODY_DAEMON_BUILD_STAMP]),
      readLodyDaemonProtocolVersion(repoRoot),
      readLodyUpstreamPin(repoRoot),
    ]);
  const version = versionStamp.slice(0, -1);
  if (!versionStamp.endsWith("\n") || !LODY_DAEMON_VERSION_PATTERN.test(version)) {
    throw new Error(`daemon archive version stamp is not a version token: ${JSON.stringify(versionStamp)}`);
  }
  if (protocolStamp !== `${protocolVersion}\n`) {
    throw new Error(
      `daemon archive protocol stamp ${JSON.stringify(protocolStamp)}`
      + ` does not match ${JSON.stringify(`${protocolVersion}\n`)}`,
    );
  }
  const stamp = parseLodyDaemonBuildStamp(buildStamp, `daemon archive ${LODY_DAEMON_BUILD_STAMP}`);
  if (stamp.upstreamSha !== pinnedUpstream) {
    throw new Error(
      `daemon archive was built from upstream ${stamp.upstreamSha},`
      + ` but vendor/lody/UPSTREAM.md pins ${pinnedUpstream}`,
    );
  }
  return {
    version,
    protocolVersion,
    upstreamSha: stamp.upstreamSha,
    distSha256: stamp.distSha256,
  };
}

export async function prepareBoxPayloadContent({
  repoRoot,
  stagingDirectory,
  binariesDirectory,
  daemonPath,
}) {
  await copyPayloadSources(repoRoot, stagingDirectory);
  await copyPayloadBinaries(binariesDirectory, stagingDirectory);
  let daemonMetadata;
  let daemonArchive;
  if (daemonPath !== undefined) {
    daemonMetadata = await readDaemonArchiveMetadata(daemonPath, repoRoot);
    daemonArchive = await hashFile(daemonPath);
  }
  const content = await readBoxPayloadContent({ repoRoot, payloadRoot: stagingDirectory });
  if (daemonArchive !== undefined) content.daemonSha256 = daemonArchive.sha256;
  return {
    ...content,
    version: boxPayloadVersion(content),
    daemonMetadata,
    daemonArchive,
  };
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
  preparedContent,
}) {
  const prepared = preparedContent ?? await prepareBoxPayloadContent({
    repoRoot,
    stagingDirectory,
    binariesDirectory,
    daemonPath,
  });
  if (version !== undefined && version !== prepared.version) {
    throw new Error(`provided payload version ${version} does not match ${prepared.version}`);
  }
  const releaseVersion = prepared.version;
  const releasePrefix = prefix ?? boxPayloadPrefix(releaseVersion);
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
  await writeBoxPayloadVersionStamp(stagingDirectory, releaseVersion);
  await createDeterministicTarGzip(
    stagingDirectory,
    payloadArchivePath,
    ["payload-version", "rootfs"],
  );
  const payloadArchive = await hashFile(payloadArchivePath);
  const manifest = {
    version: releaseVersion,
    createdAt,
    minUpdater: 1,
    files: prepared.files,
    archive: {
      url: `${appUrl}/${releasePrefix}/payload.tar.gz`,
      ...payloadArchive,
    },
  };
  if (daemonPath !== undefined) {
    const daemon = prepared.daemonMetadata;
    if (daemon === undefined || prepared.daemonArchive === undefined) {
      throw new Error("prepared payload content is missing daemon metadata");
    }
    await copyFile(daemonPath, daemonArchivePath);
    manifest.daemon = {
      version: daemon.version,
      protocolVersion: daemon.protocolVersion,
      url: `${appUrl}/${releasePrefix}/daemon.tar.gz`,
      ...prepared.daemonArchive,
    };
  }
  manifest.restart = prepared.restart;
  validateBoxPayloadManifest(manifest, new Set(PAYLOAD_SERVICES));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    version: releaseVersion,
    prefix: releasePrefix,
    manifest,
    manifestPath,
    payloadArchivePath,
    daemonArchivePath,
  };
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
  // Publishing is the only path that reads wrangler.toml. Keep this dependency
  // lazy so the planner's --print-version path works in clean release jobs.
  const { parse: parseToml } = await import("smol-toml");
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

export function payloadUploadObjects(prefix, staged) {
  // The manifest is deliberately last: an interrupted upload is not pinnable.
  const objects = [
    ["payload.tar.gz", staged.payloadArchivePath, "application/gzip"],
  ];
  if (staged.manifest.daemon !== undefined) {
    objects.push(["daemon.tar.gz", staged.daemonArchivePath, "application/gzip"]);
  }
  objects.push(["manifest.json", staged.manifestPath, "application/json; charset=utf-8"]);
  return objects.map(([name, sourcePath, contentType]) => ({
    logicalPath: `${prefix}/${name}`,
    sourcePath,
    contentType,
  }));
}

async function uploadRelease(repoRoot, bucket, prefix, staged) {
  const objects = payloadUploadObjects(prefix, staged);
  for (const { logicalPath, sourcePath, contentType } of objects) {
    await uploadObject(repoRoot, bucket, logicalPath, sourcePath, contentType);
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
  --binaries <dir>    Use a prebuilt blitz-box-gateway binary.
  --out <dir>         Staging directory to keep. With --dry-run, defaults to
                      ./box-payload/<derived-version>.
  --bucket <name>     R2 bucket (default: wrangler BOX_IMAGES bucket).
  --repo <dir>        Repository root (default: current repository).
  --rev <revision>    Git revision used only for informational createdAt (default: HEAD).
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
  const configAppUrl = defaults.appUrl !== undefined && /^https?:\/\//u.test(defaults.appUrl)
    ? defaults.appUrl
    : undefined;
  const appUrl = validatedOrigin(options.appUrl ?? configAppUrl ?? "");
  const bucket = options.bucket ?? defaults.bucket ?? DEFAULT_BUCKET;
  const createdAt = await readBoxPayloadCreatedAt({ repo: options.repoRoot, rev: options.rev });
  const temporary = await mkdtemp(path.join(tmpdir(), "blitz-box-payload-"));
  const binariesDirectory = options.binariesDirectory ?? path.join(temporary, "binaries");
  try {
    if (options.binariesDirectory === undefined) {
      await buildGoPayloadBinaries(options.repoRoot, binariesDirectory);
    }
    const stagingDirectory = path.join(temporary, "payload");
    const preparedContent = await prepareBoxPayloadContent({
      repoRoot: options.repoRoot,
      stagingDirectory,
      binariesDirectory,
      daemonPath: options.daemonPath,
    });
    const version = preparedContent.version;
    const prefix = options.prefix ?? boxPayloadPrefix(version);
    validatePrefix(prefix);
    const outputDirectory = options.outputDirectory
      ?? (options.dryRun ? path.resolve("box-payload", version) : path.join(temporary, "release"));
    const staged = await stageBoxPayloadRelease({
      repoRoot: options.repoRoot,
      stagingDirectory,
      outputDirectory,
      binariesDirectory,
      daemonPath: options.daemonPath,
      createdAt,
      appUrl,
      prefix,
      preparedContent,
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
