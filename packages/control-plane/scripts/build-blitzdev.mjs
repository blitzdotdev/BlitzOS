#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createBoxImageAssetSet,
  createWebAppAssetSet,
} from "./lib/asset-pack.mjs";
import {
  projectAccess,
  uploadManagedAssets,
  uploadManagedSet,
  writeRedacted,
} from "./lib/managed-api.mjs";
import { emitUploadSet } from "./lib/worker-source.mjs";

export * from "./lib/asset-pack.mjs";
export * from "./lib/managed-api.mjs";
export * from "./lib/module-graph.mjs";
export * from "./lib/source-utils.mjs";
export * from "./lib/worker-source.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_DIST_DIR = path.join(PACKAGE_DIR, ".managed-dist");
const DEFAULT_UI_DIST_DIR = path.resolve(PACKAGE_DIR, "../webapp/dist");

function printManifest(uploadSet) {
  for (const file of uploadSet.files) {
    writeRedacted(`${file.path}\t${file.bytes}\t${file.sha256}\n`);
  }
  writeRedacted(`release\t${uploadSet.files.length}\t${uploadSet.releaseHash}\n`);
}

function parseCli(argv) {
  const options = {
    upload: false,
    noCommit: false,
    commit: false,
    uploadWebApp: false,
    attemptBoxImage: false,
    probeFile: undefined,
    projectPasswordFile: undefined,
    boxImageManifest: undefined,
    distDir: DEFAULT_DIST_DIR,
    uiDistDir: DEFAULT_UI_DIST_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") continue;
    if (arg === "--upload") options.upload = true;
    else if (arg === "--no-commit") options.noCommit = true;
    else if (arg === "--commit") options.commit = true;
    else if (arg === "--upload-webapp") options.uploadWebApp = true;
    else if (arg === "--attempt-box-image") options.attemptBoxImage = true;
    else if (["--probe-file", "--project-password-file", "--box-image-manifest", "--dist", "--ui-dist"].includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--probe-file") options.probeFile = value;
      else if (arg === "--project-password-file") options.projectPasswordFile = value;
      else if (arg === "--box-image-manifest") options.boxImageManifest = path.resolve(value);
      else if (arg === "--ui-dist") options.uiDistDir = path.resolve(value);
      else options.distDir = path.resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.commit && !options.upload) throw new Error("--commit is invalid without --upload");
  if (options.noCommit && !options.upload) throw new Error("--no-commit is invalid without --upload");
  if (options.upload && options.commit === options.noCommit) {
    throw new Error("--upload requires exactly one of --no-commit or --commit");
  }
  if (options.upload && options.probeFile === undefined) throw new Error("--upload requires --probe-file");
  if ((options.uploadWebApp || options.attemptBoxImage) && options.probeFile === undefined) {
    throw new Error("managed file upload requires --probe-file");
  }
  if ((options.uploadWebApp || options.attemptBoxImage) && options.projectPasswordFile === undefined) {
    throw new Error("managed file upload requires --project-password-file");
  }
  if (options.attemptBoxImage && options.boxImageManifest === undefined) {
    throw new Error("--attempt-box-image requires --box-image-manifest");
  }
  if (options.noCommit && (options.uploadWebApp || options.attemptBoxImage)) {
    throw new Error("data uploads cannot run before the schema is committed");
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const emitted = await emitUploadSet({ distDir: options.distDir });
  printManifest(emitted);
  if (options.upload) await uploadManagedSet(emitted, options.probeFile, { commit: options.commit });
  if (options.uploadWebApp || options.attemptBoxImage) {
    const access = await projectAccess(options.probeFile);
    const projectPassword = (await readFile(options.projectPasswordFile, "utf8")).replace(/[\r\n]+$/u, "");
    if (options.uploadWebApp) {
      const webApp = await createWebAppAssetSet(options.uiDistDir);
      const result = await uploadManagedAssets(webApp, access, projectPassword);
      writeRedacted(`webapp-assets\t${webApp.files.length}\t${webApp.releaseId}\t${JSON.stringify(result)}\n`);
    }
    if (options.attemptBoxImage) {
      writeRedacted("box-image-attempt\texplicit\texternal-fallback-retained\n");
      const boxImage = await createBoxImageAssetSet(options.boxImageManifest);
      const result = await uploadManagedAssets(boxImage, access, projectPassword);
      writeRedacted(`box-image-assets\t${boxImage.files.length}\t${boxImage.releaseId}\t${JSON.stringify(result)}\n`);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    writeRedacted(`${error instanceof Error ? error.message : error}\n`, process.stderr);
    process.exitCode = 1;
  });
}
