#!/usr/bin/env node

// Packages a local Docker image as the multipart box-image archive the control
// plane serves from R2 (docs/BOX-IMAGE.md modes B/C). The consumers are
// core/box-images.ts (serving) and the bootstrap's embedded Python validator
// (core/bootstrap.ts); the manifest contract is pinned by the fixture corpus
// in packages/schema/fixtures/box-image-manifest/. This producer builds its
// manifest through validateBoxImageManifest — the same parser the consuming
// toolchain uses — and re-verifies every staged part with
// createBoxImageAssetSet before anything is uploaded.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";
import { parse as parseToml } from "smol-toml";
import { createBoxImageAssetSet, validateBoxImageManifest } from "./lib/asset-pack.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..");
const WRANGLER_CONFIG_PATH = path.join(PACKAGE_DIR, "wrangler.toml");
const WRANGLER_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "wrangler");
const DEFAULT_BUCKET = "blitz-box-images";
const DEFAULT_PART_SIZE_MIB = 95;
const MIB = 1024 * 1024;

function usage() {
  return `Publish a local Docker image as the multipart R2 box-image archive.

Runs docker save | gzip, splits the archive into parts, hashes every part and
the concatenation, writes the fixture-pinned manifest.json, uploads everything
to R2 with wrangler, and prints the BOX_IMAGE_* values for wrangler.toml.

Usage:
  node packages/control-plane/scripts/publish-box-image.mjs --image <docker-tag> [options]

Options:
  --image <tag>        Docker image tag to package (docker save <tag>). Becomes the
                       manifest imageTag and the printed BOX_IMAGE_TAG. Required.
  --archive <file>     Split an existing gzipped docker-save archive instead of
                       invoking docker.
  --out <dir>          Stage parts + manifest.json in this directory and keep them
                       (default: a temporary directory, removed afterwards).
  --bucket <name>      R2 bucket to upload into (default: the BOX_IMAGES bucket_name
                       in wrangler.toml, else ${DEFAULT_BUCKET}).
  --app-url <origin>   Control-plane origin used in the printed BOX_IMAGE_REF
                       (default: APP_URL in wrangler.toml).
  --part-size-mb <n>   Part size in MiB, at least 1 (default ${DEFAULT_PART_SIZE_MIB}).
  --dry-run            Build and verify the release and print the values; skip the
                       upload.`;
}

export function boxImagePartName(index) {
  return `part-${String(index).padStart(3, "0")}`;
}

/** Builds the canonical manifest for already-hashed parts. The result comes
 * from validateBoxImageManifest, the consumer-side parser, so this producer
 * cannot emit a document the fixture-pinned contract rejects. */
export function buildBoxImageManifest(parts, totalSha256, imageTag) {
  return validateBoxImageManifest({
    parts: parts.map((part) => ({ name: part.name, sha256: part.sha256 })),
    totalSha256,
    imageTag,
  });
}

/** Streams `source` into sequential part files under `outDir`, hashing each
 * part and the concatenation. Returns { parts: [{ name, sha256, sizeBytes }],
 * totalSha256 } with parts in concatenation order. */
export async function writeBoxImageParts(source, outDir, partSizeBytes) {
  if (!Number.isInteger(partSizeBytes) || partSizeBytes <= 0) {
    throw new Error("part size must be a positive integer number of bytes");
  }
  const aggregate = createHash("sha256");
  const parts = [];
  let current = null;

  const writeChunk = (stream, chunk) =>
    new Promise((resolveWrite, rejectWrite) => {
      stream.write(chunk, (error) => (error ? rejectWrite(error) : resolveWrite()));
    });
  const closeCurrentPart = async () => {
    const part = current;
    current = null;
    await new Promise((resolveEnd, rejectEnd) => {
      part.stream.once("error", rejectEnd);
      part.stream.end(resolveEnd);
    });
    parts.push({ name: part.name, sha256: part.hash.digest("hex"), sizeBytes: part.sizeBytes });
  };

  for await (const data of source) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    aggregate.update(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      if (current === null) {
        const name = boxImagePartName(parts.length);
        current = {
          name,
          hash: createHash("sha256"),
          sizeBytes: 0,
          stream: createWriteStream(path.join(outDir, name), { mode: 0o644 }),
        };
      }
      const take = Math.min(partSizeBytes - current.sizeBytes, chunk.length - offset);
      const slice = chunk.subarray(offset, offset + take);
      current.hash.update(slice);
      await writeChunk(current.stream, slice);
      current.sizeBytes += take;
      offset += take;
      if (current.sizeBytes === partSizeBytes) await closeCurrentPart();
    }
  }
  if (current !== null) await closeCurrentPart();
  if (parts.length === 0) throw new Error("image archive was empty; nothing to package");
  return { parts, totalSha256: aggregate.digest("hex") };
}

/** Splits `source` into parts, writes manifest.json, and re-verifies the whole
 * staged release with createBoxImageAssetSet — the exact loader the upload
 * toolchain consumes. Returns { manifest, manifestPath, parts, assetSet }. */
export async function stageBoxImageRelease({ source, outDir, imageTag, partSizeBytes }) {
  await mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "manifest.json");
  for (const staged of [manifestPath, path.join(outDir, boxImagePartName(0))]) {
    const existing = await stat(staged).catch(() => null);
    if (existing !== null) {
      throw new Error(`refusing to overwrite an already staged release: ${staged}`);
    }
  }
  const { parts, totalSha256 } = await writeBoxImageParts(source, outDir, partSizeBytes);
  const manifest = buildBoxImageManifest(parts, totalSha256, imageTag);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const assetSet = await createBoxImageAssetSet(manifestPath);
  return { manifest, manifestPath, parts, assetSet };
}

function tomlString(value) {
  return String(value) === value ? value : undefined;
}

function tomlRecord(value) {
  return value !== null && Object(value) === value && !Array.isArray(value) ? value : undefined;
}

async function wranglerConfigDefaults() {
  let text;
  try {
    text = await readFile(WRANGLER_CONFIG_PATH, "utf8");
  } catch {
    return { bucket: undefined, appUrl: undefined };
  }
  const config = tomlRecord(parseToml(text)) ?? {};
  const buckets = Array.isArray(config.r2_buckets) ? config.r2_buckets : [];
  const boxImages = buckets
    .map(tomlRecord)
    .find((bucket) => bucket !== undefined && bucket.binding === "BOX_IMAGES");
  return {
    bucket: boxImages === undefined ? undefined : tomlString(boxImages.bucket_name),
    appUrl: tomlString((tomlRecord(config.vars) ?? {}).APP_URL),
  };
}

function parseCli(argv) {
  const options = {
    imageTag: undefined,
    archivePath: undefined,
    outDir: undefined,
    bucket: undefined,
    appUrl: undefined,
    partSizeMib: DEFAULT_PART_SIZE_MIB,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!["--image", "--archive", "--out", "--bucket", "--app-url", "--part-size-mb"].includes(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    index += 1;
    if (arg === "--image") options.imageTag = value;
    else if (arg === "--archive") options.archivePath = path.resolve(value);
    else if (arg === "--out") options.outDir = path.resolve(value);
    else if (arg === "--bucket") options.bucket = value;
    else if (arg === "--app-url") options.appUrl = value;
    else options.partSizeMib = Number(value);
  }
  if (options.imageTag === undefined) throw new Error("--image is required");
  if (!Number.isInteger(options.partSizeMib) || options.partSizeMib <= 0) {
    throw new Error("--part-size-mb must be a positive integer");
  }
  // Validate the tag early through the shared contract parser (a probe part
  // stands in for the not-yet-built archive) so an invalid tag fails before
  // the expensive docker save instead of after it.
  try {
    validateBoxImageManifest({
      parts: [{ name: "probe", sha256: "a".repeat(64) }],
      totalSha256: "a".repeat(64),
      imageTag: options.imageTag,
    });
  } catch {
    throw new Error(`--image is not a valid image tag for the manifest contract: ${options.imageTag}`);
  }
  return options;
}

function dockerSaveSource(imageTag) {
  const child = spawn("docker", ["save", imageTag], { stdio: ["ignore", "pipe", "pipe"] });
  let stderrText = "";
  let settled = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (piece) => {
    stderrText += piece;
  });
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", (error) => {
      settled = true;
      rejectExit(new Error(`docker is unavailable: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      settled = true;
      resolveExit({ code, signal });
    });
  });
  const completionError = async () => {
    const { code, signal } = await exit;
    if (code === 0) return null;
    const detail = stderrText.trim().split("\n").at(-1) ?? "";
    const reason = signal === null ? `exit ${code}` : `signal ${signal}`;
    return new Error(`docker save ${imageTag} failed (${reason})${detail === "" ? "" : `: ${detail}`}`);
  };
  const gzip = createGzip();
  child.stdout.pipe(gzip);
  return {
    stream: gzip,
    async assertCompleted() {
      const error = await completionError();
      if (error !== null) throw error;
    },
    /** Returns docker's own error when it already failed; kills a
     * still-running docker (so nothing hangs on backpressure) and returns
     * null when the failure was ours. */
    async failure() {
      if (!settled) {
        child.kill("SIGKILL");
        await exit.catch(() => null);
        return null;
      }
      return completionError().catch((error) => error);
    },
  };
}

function archiveFileSource(archivePath) {
  const stream = createReadStream(archivePath);
  return {
    stream,
    async assertCompleted() {},
    async failure() {
      stream.destroy();
      return null;
    },
  };
}

async function runWrangler(args) {
  const binary = await stat(WRANGLER_BIN).catch(() => null);
  if (binary === null) {
    throw new Error(`wrangler binary is missing at ${WRANGLER_BIN}; run npm install first`);
  }
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(WRANGLER_BIN, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`wrangler ${args.join(" ")} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function uploadRelease(assetSet, bucket) {
  // assetSet.files already orders every part before manifest.json, so a
  // half-finished upload never activates a release.
  for (const file of assetSet.files) {
    process.stderr.write(`uploading ${bucket}/${file.logicalPath} (${file.sizeBytes} bytes)\n`);
    await runWrangler([
      "r2", "object", "put", `${bucket}/${file.logicalPath}`,
      "--file", file.sourcePath,
      "--content-type", file.mediaType,
      "--remote",
    ]);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const defaults = await wranglerConfigDefaults();
  const bucket = options.bucket ?? defaults.bucket ?? DEFAULT_BUCKET;
  // wrangler.toml may still hold the wrangler.toml.example placeholder text;
  // only a real origin is worth echoing into BOX_IMAGE_REF.
  const configAppUrl = defaults.appUrl !== undefined && /^https?:\/\//u.test(defaults.appUrl)
    ? defaults.appUrl
    : undefined;
  const appUrl = (options.appUrl ?? configAppUrl ?? "").replace(/\/+$/u, "");
  const partSizeBytes = options.partSizeMib * MIB;
  const keepStaged = options.outDir !== undefined;
  const outDir = options.outDir ?? (await mkdtemp(path.join(tmpdir(), "blitz-box-image-")));
  try {
    const source = options.archivePath === undefined
      ? dockerSaveSource(options.imageTag)
      : archiveFileSource(options.archivePath);
    process.stderr.write(options.archivePath === undefined
      ? `packaging docker image ${options.imageTag} (docker save | gzip)\n`
      : `packaging archive ${options.archivePath} as ${options.imageTag}\n`);

    let staged;
    try {
      staged = await stageBoxImageRelease({
        source: source.stream,
        outDir,
        imageTag: options.imageTag,
        partSizeBytes,
      });
    } catch (stageError) {
      // A docker failure truncates the stream; its error explains the
      // staging failure, so it wins when both are present.
      throw (await source.failure()) ?? stageError;
    }
    await source.assertCompleted();

    const totalBytes = staged.parts.reduce((total, part) => total + part.sizeBytes, 0);
    process.stderr.write(`staged ${staged.parts.length} part(s), ${totalBytes} bytes total, in ${outDir}\n`);
    process.stderr.write(`verified against the box-image manifest contract (totalSha256 ${staged.manifest.totalSha256})\n`);

    if (options.dryRun) {
      process.stderr.write(`dry run: skipped uploading ${staged.assetSet.files.length} objects to bucket ${bucket}\n`);
    } else {
      await uploadRelease(staged.assetSet, bucket);
      process.stderr.write(`uploaded ${staged.assetSet.files.length} objects to bucket ${bucket}\n`);
    }

    const origin = appUrl === "" ? "https://<your-worker-origin>" : appUrl;
    process.stdout.write(`
Set these in packages/control-plane/wrangler.toml [vars], then redeploy:

BOX_IMAGE_REF = "${origin}/box-image/manifest.json"
BOX_IMAGE_TAG = "${staged.manifest.imageTag}"
BOX_IMAGE_SHA256 = "${staged.manifest.totalSha256}"
`);
  } finally {
    if (!keepStaged) await rm(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (/^(unknown argument|--)/u.test(message)) {
      process.stderr.write(`\n${usage()}\n`);
    }
    process.exitCode = 1;
  });
}
