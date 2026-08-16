import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./source-utils.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_UI_DIST_DIR = path.resolve(PACKAGE_DIR, "../ui/dist");

const MEDIA_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
});

export function mediaTypeForPath(filePath) {
  return MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function managedFileId(kind, logicalPath) {
  if (kind !== "cockpit" && kind !== "box-image") throw new Error(`unsupported file kind: ${kind}`);
  return sha256(`${kind}\0${logicalPath}`);
}

async function sha256File(filePath, aggregate) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
    aggregate?.update(chunk);
  }
  return digest.digest("hex");
}

async function walkRegularFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walkRegularFiles(directory, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

function assetReleaseId(files) {
  return sha256(files.map((file) =>
    `${file.logicalPath}\0${file.sizeBytes}\0${file.sha256}\0${file.mediaType}\n`).join(""));
}

export async function createCockpitAssetSet(distDir = DEFAULT_UI_DIST_DIR) {
  const relativePaths = await walkRegularFiles(distDir);
  if (!relativePaths.includes("index.html")) throw new Error(`cockpit build is missing ${path.join(distDir, "index.html")}`);
  const files = await Promise.all(relativePaths.map(async (relativePath) => {
    const sourcePath = path.join(distDir, relativePath);
    const metadata = await stat(sourcePath);
    return {
      kind: "cockpit",
      logicalPath: `/${relativePath.split(path.sep).join("/")}`,
      mediaType: mediaTypeForPath(relativePath),
      sizeBytes: metadata.size,
      sha256: await sha256File(sourcePath),
      sourcePath,
    };
  }));
  const releaseId = assetReleaseId(files);
  const uploadFiles = [
    ...files.filter(({ logicalPath }) => logicalPath !== "/index.html"),
    ...files.filter(({ logicalPath }) => logicalPath === "/index.html"),
  ];
  return {
    kind: "cockpit",
    releaseId,
    files: uploadFiles.map((file) => ({ ...file, releaseId })),
  };
}

const BOX_IMAGE_PART_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const BOX_IMAGE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;

/* oxlint-disable anti-slop/no-runtime-typeof -- The CLI reads an untyped JSON manifest and validates every primitive before file access. */
export function validateBoxImageManifest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("box-image manifest must be an object");
  }
  if (!Array.isArray(value.parts) || value.parts.length === 0) {
    throw new Error("box-image manifest parts must be a non-empty array");
  }
  if (typeof value.totalSha256 !== "string" || !SHA256_PATTERN.test(value.totalSha256)) {
    throw new Error("box-image manifest totalSha256 must be a SHA-256 digest");
  }
  if (typeof value.imageTag !== "string" || !BOX_IMAGE_TAG_PATTERN.test(value.imageTag)) {
    throw new Error("box-image manifest imageTag is invalid");
  }
  const parts = value.parts.map((part, index) => {
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      throw new Error(`box-image manifest part ${index} must be an object`);
    }
    if (typeof part.name !== "string" || !BOX_IMAGE_PART_NAME_PATTERN.test(part.name)) {
      throw new Error(`box-image manifest part ${index} name is invalid`);
    }
    if (typeof part.sha256 !== "string" || !SHA256_PATTERN.test(part.sha256)) {
      throw new Error(`box-image manifest part ${index} sha256 is invalid`);
    }
    return { name: part.name, sha256: part.sha256.toLowerCase() };
  });
  return {
    parts,
    totalSha256: value.totalSha256.toLowerCase(),
    imageTag: value.imageTag,
  };
}
/* oxlint-enable anti-slop/no-runtime-typeof */

export async function createBoxImageAssetSet(manifestPath) {
  const manifest = validateBoxImageManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const directory = path.dirname(manifestPath);
  const aggregate = createHash("sha256");
  const partFiles = [];
  for (const part of manifest.parts) {
    const sourcePath = path.join(directory, part.name);
    const metadata = await stat(sourcePath);
    const actual = await sha256File(sourcePath, aggregate);
    if (actual !== part.sha256) throw new Error(`box-image part SHA-256 mismatch: ${part.name}`);
    partFiles.push({
      kind: "box-image",
      logicalPath: `box-image/${part.name}`,
      mediaType: "application/octet-stream",
      sizeBytes: metadata.size,
      sha256: actual,
      sourcePath,
      releaseId: manifest.totalSha256,
    });
  }
  if (aggregate.digest("hex") !== manifest.totalSha256) throw new Error("box-image aggregate SHA-256 mismatch");
  const manifestMetadata = await stat(manifestPath);
  const manifestFile = {
    kind: "box-image",
    logicalPath: "box-image/manifest.json",
    mediaType: "application/json; charset=utf-8",
    sizeBytes: manifestMetadata.size,
    sha256: await sha256File(manifestPath),
    sourcePath: manifestPath,
    releaseId: manifest.totalSha256,
  };
  return { kind: "box-image", releaseId: manifest.totalSha256, files: [...partFiles, manifestFile] };
}

