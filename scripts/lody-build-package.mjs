#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  adapterContentSha256,
  adapterGitContentSha256,
  LODY_ADAPTER_NAMES,
  readAdapterStamp,
} from "./lody-sync-adapters.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_MANIFEST = path.join(
  SCRIPT_DIRECTORY,
  "lody-package-manifest.json",
);
const GIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CHUNK_PATH = /^(package\/dist\/chunks\/.+)-[A-Za-z0-9_-]{8}\.js$/u;

function usage() {
  return `Build and stamp the Lody daemon package from the reviewed tree.

Usage:
  node scripts/lody-build-package.mjs [options]

Options:
  --out <dir>       Write the tarball and BUILD.json to a nonexistent or empty
                    directory (default: ./lody-build).
  --tree-ish <rev>  Export <rev>:vendor/lody and its adapter snapshots (default: HEAD).
  --source <dir>    Copy an already-materialized Lody tree instead of using Git.
  --scratch <dir>   Build in this new directory and preserve it for seam tests.
  --keep-scratch    Keep and print the disposable build directory.
  --json            Print the completed BUILD.json stamp.
  --help, -h        Print this text.

--source needs no Git. Provenance comes from <dir>/UPSTREAM.md, and adapter
provenance comes from vendor/lody-adapters beside this script's repository root.`;
}

function runText(command, args, cwd, environment) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout;
}

function runBinary(command, args, cwd, input) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout;
}

function runLogged(command, args, cwd, environment) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status ?? "without status"}`,
    );
}

function gitText(args) {
  return runText("git", args, REPOSITORY, process.env).trim();
}

function archiveGitTree(revision, destination) {
  mkdirSync(destination, { recursive: true });
  const archive = runBinary(
    "git",
    ["archive", "--format=tar", revision],
    REPOSITORY,
  );
  runBinary("tar", ["-x", "-C", destination], REPOSITORY, archive);
}

function field(source, pattern, label) {
  const value = pattern.exec(source)?.[1];
  if (value === undefined)
    throw new Error(`vendor/lody/UPSTREAM.md is missing ${label}`);
  return value;
}

export function parseLodyUpstream(source) {
  const upstreamSha = field(
    source,
    /\| Pinned commit \| `([a-f0-9]{40})` \|/u,
    "Pinned commit",
  );
  const subtreeCommit = field(
    source,
    /\| Subtree squash commit \| `([a-f0-9]{40})` \|/u,
    "Subtree squash commit",
  );
  const adapterShas = {};
  for (const name of LODY_ADAPTER_NAMES) {
    adapterShas[name] = field(
      source,
      new RegExp(
        `^\\| \x60acp-extension-${name}\x60 \\| \x60([a-f0-9]{40})\x60 \\|`,
        "mu",
      ),
      `acp-extension-${name}`,
    );
  }
  return { upstreamSha, subtreeCommit, adapterShas };
}

function sourceProvenance(lodyRoot, treeish) {
  const declared = parseLodyUpstream(
    readFileSync(path.join(lodyRoot, "UPSTREAM.md"), "utf8"),
  );
  if (treeish === null) return declared;
  const found = gitText([
    "log",
    treeish,
    "--fixed-strings",
    `--grep=git-subtree-split: ${declared.upstreamSha}`,
    "--format=%H",
    "-1",
  ]);
  if (!GIT_SHA.test(found))
    throw new Error(
      `no reachable subtree squash carries ${declared.upstreamSha}`,
    );
  const message = gitText(["show", "-s", "--format=%B", found]);
  if (
    !message.includes("git-subtree-dir: vendor/lody") ||
    !message.includes(`git-subtree-split: ${declared.upstreamSha}`)
  ) {
    throw new Error(
      `${found} is not the matching vendor/lody subtree squash commit`,
    );
  }
  if (found !== declared.subtreeCommit) {
    throw new Error(
      `UPSTREAM.md subtree commit ${declared.subtreeCommit} differs from reachable squash ${found}`,
    );
  }
  return declared;
}

function materializeLody(lodyRoot, source, treeish) {
  if (source !== null) {
    if (!existsSync(source))
      throw new Error(`source directory does not exist: ${source}`);
    cpSync(source, lodyRoot, { recursive: true, verbatimSymlinks: true });
    return;
  }
  archiveGitTree(`${treeish}:vendor/lody`, lodyRoot);
}

function materializeAdapter(name, destination, sourceMode, treeish) {
  const relative = `vendor/lody-adapters/${name}`;
  if (sourceMode) {
    const source = path.join(REPOSITORY, relative);
    if (!existsSync(source))
      throw new Error(`missing adapter directory: ${relative}`);
    cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    return;
  }
  const revision = `${treeish}:${relative}`;
  const exists = spawnSync("git", ["cat-file", "-e", revision], {
    cwd: REPOSITORY,
  });
  if (exists.status !== 0)
    throw new Error(`missing adapter directory: ${relative} at ${treeish}`);
  archiveGitTree(revision, destination);
}

function hasGitIndex() {
  return spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: REPOSITORY,
    stdio: "ignore",
  }).status === 0;
}

function overlayAdapters(lodyRoot, provenance, sourceMode, treeish) {
  const adapterShas = {};
  for (const name of LODY_ADAPTER_NAMES) {
    const destination = path.join(
      lodyRoot,
      "packages",
      `acp-extension-${name}`,
    );
    rmSync(destination, { recursive: true, force: true });
    materializeAdapter(name, destination, sourceMode, treeish);
    const stampFile = path.join(destination, "UPSTREAM.md");
    const stamp = readAdapterStamp(stampFile);
    const checkoutContentSha256 = adapterContentSha256(destination);
    const contentSha256 = sourceMode
      ? (hasGitIndex()
          ? adapterGitContentSha256(REPOSITORY, name)
          : checkoutContentSha256)
      : adapterGitContentSha256(REPOSITORY, name, treeish);
    if (stamp.name !== name)
      throw new Error(`${name}: adapter stamp names ${stamp.name}`);
    if (stamp.sha !== provenance.adapterShas[name]) {
      throw new Error(
        `${name}: adapter stamp ${stamp.sha} differs from UPSTREAM.md ${provenance.adapterShas[name]}`,
      );
    }
    if (checkoutContentSha256 !== contentSha256) {
      throw new Error(
        `${name}: adapter checkout ${checkoutContentSha256} differs from Git content ${contentSha256}`,
      );
    }
    if (contentSha256 !== stamp.contentSha256) {
      throw new Error(
        `${name}: adapter content ${contentSha256} differs from stamp ${stamp.contentSha256}`,
      );
    }
    adapterShas[name] = stamp.sha;
    rmSync(stampFile);
  }
  return adapterShas;
}

function walkRegularFiles(root, directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkRegularFiles(root, absolute, files);
      continue;
    }
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative === "BUILD.json") continue;
    if (!lstatSync(absolute).isFile())
      throw new Error(`dist contains a non-file entry: ${relative}`);
    files.push({ absolute, relative });
  }
}

export function distContentSha256(root) {
  const files = [];
  walkRegularFiles(root, root, files);
  files.sort((left, right) =>
    left.relative.localeCompare(right.relative, "en"),
  );
  const aggregate = createHash("sha256");
  for (const file of files) {
    const digest = createHash("sha256")
      .update(readFileSync(file.absolute))
      .digest("hex");
    aggregate.update(`${file.relative}\0${digest}\n`);
  }
  return aggregate.digest("hex");
}

function removeUnpublishedSourceMaps(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) removeUnpublishedSourceMaps(absolute);
    else if (entry.name.endsWith(".map")) rmSync(absolute);
  }
}

function assertHash(value, pattern, label) {
  if (!pattern.test(value)) throw new Error(`${label} has an invalid hash`);
}

export function createBuildStamp(
  upstreamSha,
  subtreeCommit,
  adapterShas,
  lockfileSha256,
  distSha256,
  builtAt,
  node,
  pnpm,
) {
  assertHash(upstreamSha, GIT_SHA, "upstreamSha");
  assertHash(subtreeCommit, GIT_SHA, "subtreeCommit");
  assertHash(lockfileSha256, SHA256, "lockfileSha256");
  assertHash(distSha256, SHA256, "distSha256");
  if (Number.isNaN(Date.parse(builtAt)))
    throw new Error("builtAt is not an ISO-8601 timestamp");
  if (!/^\d+\.\d+\.\d+/u.test(node))
    throw new Error("node has an invalid version");
  if (!/^\d+\.\d+\.\d+/u.test(pnpm))
    throw new Error("pnpm has an invalid version");
  const orderedAdapters = {};
  for (const name of LODY_ADAPTER_NAMES) {
    const sha = adapterShas[name];
    assertHash(sha, GIT_SHA, `adapterShas.${name}`);
    orderedAdapters[name] = sha;
  }
  return {
    upstreamSha,
    subtreeCommit,
    adapterShas: orderedAdapters,
    lockfileSha256,
    distSha256,
    builtAt,
    node,
    pnpm,
  };
}

export function normalizePackagePath(file) {
  const match = CHUNK_PATH.exec(file);
  return match === null ? file : `${match[1]}-[hash].js`;
}

function counts(entries) {
  const found = new Map();
  for (const entry of entries) found.set(entry, (found.get(entry) ?? 0) + 1);
  return found;
}

export function packageManifestReport(expected, actual) {
  const wanted = counts(expected);
  const packed = counts(actual.map(normalizePackagePath));
  const missing = [];
  const extra = [];
  for (const [entry, count] of wanted) {
    for (let index = packed.get(entry) ?? 0; index < count; index += 1)
      missing.push(entry);
  }
  for (const [entry, count] of packed) {
    for (let index = wanted.get(entry) ?? 0; index < count; index += 1)
      extra.push(entry);
  }
  return { missing, extra };
}

export function readPackageManifest(file = DEFAULT_MANIFEST) {
  const decoded = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(decoded))
    throw new Error("lody-package-manifest.json must be an array");
  return decoded.map((entry) => {
    if (Object.prototype.toString.call(entry) !== "[object String]") {
      throw new Error("lody-package-manifest.json entries must be strings");
    }
    const packagePath = String(entry);
    if (!packagePath.startsWith("package/")) {
      throw new Error(
        "lody-package-manifest.json entries must be package paths",
      );
    }
    return packagePath;
  });
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function parseCli(argv) {
  const options = {
    out: path.resolve("lody-build"),
    treeish: "HEAD",
    source: null,
    scratch: null,
    keepScratch: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--keep-scratch") options.keepScratch = true;
    else if (flag === "--json") options.json = true;
    else if (
      flag === "--out" ||
      flag === "--source" ||
      flag === "--scratch" ||
      flag === "--tree-ish"
    ) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      index += 1;
      if (flag === "--out") options.out = path.resolve(value);
      else if (flag === "--source") options.source = path.resolve(value);
      else if (flag === "--scratch") options.scratch = path.resolve(value);
      else options.treeish = value;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (options.source !== null && argv.includes("--tree-ish")) {
    throw new Error("--source and --tree-ish are mutually exclusive");
  }
  return options;
}

function hasErrorCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertEmptyOutputDirectory(outputDirectory) {
  if (!existsSync(outputDirectory)) return;
  if (!lstatSync(outputDirectory).isDirectory()) {
    throw new Error(
      `--out must name a nonexistent or empty directory; ${outputDirectory} is not a directory`,
    );
  }
  if (readdirSync(outputDirectory).length !== 0) {
    throw new Error(
      `--out must name a nonexistent or empty directory; refusing non-empty ${outputDirectory}`,
    );
  }
}

function reserveEmptyOutputDirectory(outputDirectory) {
  assertEmptyOutputDirectory(outputDirectory);
  if (!existsSync(outputDirectory)) {
    try {
      mkdirSync(outputDirectory);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
  }
  assertEmptyOutputDirectory(outputDirectory);

  const reservation = path.join(outputDirectory, ".lody-publish.lock");
  let descriptor;
  try {
    descriptor = openSync(reservation, "wx", 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error(
        `--out must name a nonexistent or empty directory; refusing non-empty ${outputDirectory}`,
      );
    }
    throw error;
  }
  closeSync(descriptor);
  return reservation;
}

/** Publish one verified tarball and its stamp into a fresh output directory. */
export function publishPackageOutput(
  scratchTarball,
  stampJson,
  outputDirectory,
) {
  const parent = path.dirname(outputDirectory);
  const base = path.basename(outputDirectory);
  mkdirSync(parent, { recursive: true });
  const reservation = reserveEmptyOutputDirectory(outputDirectory);
  const staging = mkdtempSync(path.join(parent, `.${base}.publish-`));
  try {
    const stagedTarball = path.join(staging, path.basename(scratchTarball));
    cpSync(scratchTarball, stagedTarball);
    const stagedStamp = path.join(staging, "BUILD.json");
    writeFileSync(stagedStamp, stampJson);
    chmodSync(stagedStamp, 0o444);
    const tarballs = readdirSync(staging).filter((entry) =>
      /^lody-.+\.tgz$/u.test(entry),
    );
    if (tarballs.length !== 1) {
      throw new Error(
        `staged Lody output contains ${tarballs.length} tarballs; expected exactly one`,
      );
    }

    renameSync(
      stagedTarball,
      path.join(outputDirectory, path.basename(scratchTarball)),
    );
    renameSync(stagedStamp, path.join(outputDirectory, "BUILD.json"));
    const publishedTarballs = readdirSync(outputDirectory).filter((entry) =>
      /^lody-.+\.tgz$/u.test(entry),
    );
    if (publishedTarballs.length !== 1) {
      throw new Error(
        `published Lody output contains ${publishedTarballs.length} tarballs; expected exactly one`,
      );
    }
    return {
      tarball: path.join(outputDirectory, path.basename(scratchTarball)),
      stampFile: path.join(outputDirectory, "BUILD.json"),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(reservation, { force: true });
  }
}

function packageTarball(lodyRoot, packRoot, environment) {
  runText(
    "corepack",
    ["pnpm", "--filter", "lody", "pack", "--pack-destination", packRoot],
    lodyRoot,
    environment,
  );
  const tarballs = readdirSync(packRoot).filter((entry) =>
    /^lody-.+\.tgz$/u.test(entry),
  );
  // Upstream's private workspace root and publishable CLI are both named
  // `lody`, and pnpm currently packs both. The package carrying dist/index.js
  // is the CLI requested by the filter; the private source archive is ignored.
  const cliTarballs = tarballs.filter((entry) => {
    const listing = runText(
      "tar",
      ["-tzf", path.join(packRoot, entry)],
      lodyRoot,
      process.env,
    );
    return listing.split("\n").includes("package/dist/index.js");
  });
  if (cliTarballs.length !== 1) {
    throw new Error(
      `pnpm pack produced ${cliTarballs.length} CLI tarballs from ${tarballs.length} archives`,
    );
  }
  return path.join(packRoot, cliTarballs[0]);
}

function verifyTarball(tarball, scratch, expected, stamp) {
  const listing = runText("tar", ["-tzf", tarball], scratch, process.env)
    .split("\n")
    .filter((entry) => entry !== "" && !entry.endsWith("/"));
  const report = packageManifestReport(expected, listing);
  if (report.missing.length > 0) {
    throw new Error(
      `packed Lody package is missing:\n- ${report.missing.join("\n- ")}`,
    );
  }
  if (report.extra.length > 0) {
    process.stderr.write(
      `warning: packed Lody package has extra entries:\n- ${report.extra.join("\n- ")}\n`,
    );
  }
  const packedRoot = path.join(scratch, "packed");
  mkdirSync(packedRoot);
  runBinary("tar", ["-xzf", tarball, "-C", packedRoot], scratch);
  const packedDist = path.join(packedRoot, "package/dist");
  if (distContentSha256(packedDist) !== stamp.distSha256) {
    throw new Error("packed dist content differs from BUILD.json distSha256");
  }
  const packedStamp = JSON.parse(
    readFileSync(path.join(packedDist, "BUILD.json"), "utf8"),
  );
  if (JSON.stringify(packedStamp) !== JSON.stringify(stamp)) {
    throw new Error("packed dist/BUILD.json differs from the output stamp");
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  // Refuse replacement before doing the expensive install and build. The
  // publisher checks again and reserves the directory against another writer.
  assertEmptyOutputDirectory(options.out);
  const started = Date.now();
  let scratch;
  if (options.scratch === null) {
    scratch = mkdtempSync(path.join(tmpdir(), "lody-build-"));
  } else {
    mkdirSync(path.dirname(options.scratch), { recursive: true });
    mkdirSync(options.scratch);
    scratch = options.scratch;
  }
  try {
    const lodyRoot = path.join(scratch, "lody");
    const packRoot = path.join(scratch, "out");
    mkdirSync(packRoot);
    materializeLody(lodyRoot, options.source, options.treeish);
    const provenance = sourceProvenance(
      lodyRoot,
      options.source === null ? options.treeish : null,
    );
    const adapterShas = overlayAdapters(
      lodyRoot,
      provenance,
      options.source !== null,
      options.treeish,
    );

    const shim = path.join(scratch, "corepack-bin");
    mkdirSync(shim);
    runLogged(
      "corepack",
      ["enable", "--install-directory", shim],
      lodyRoot,
      process.env,
    );
    const environment = {
      ...process.env,
      PATH: `${shim}:${process.env.PATH ?? ""}`,
    };
    runLogged(
      "corepack",
      ["pnpm", "install", "--filter", "lody...", "--frozen-lockfile"],
      lodyRoot,
      environment,
    );
    runLogged(
      "corepack",
      ["pnpm", "--filter", "lody", "build"],
      lodyRoot,
      environment,
    );

    const dist = path.join(lodyRoot, "apps/cli/dist");
    cpSync(
      path.join(lodyRoot, "THIRD_PARTY_NOTICES.md"),
      path.join(dist, "THIRD_PARTY_NOTICES.md"),
    );
    // The package manifest names LICENSE, but the CLI directory relies on the
    // workspace-root copy. Materialize it only in this disposable pack tree.
    cpSync(
      path.join(lodyRoot, "LICENSE"),
      path.join(lodyRoot, "apps/cli/LICENSE"),
    );
    // package.json excludes source maps. Remove them before hashing so the
    // digest describes the installed dist tree, not unpublished build output.
    removeUnpublishedSourceMaps(dist);
    const pnpm = runText(
      "corepack",
      ["pnpm", "--version"],
      lodyRoot,
      environment,
    ).trim();
    const stamp = createBuildStamp(
      provenance.upstreamSha,
      provenance.subtreeCommit,
      adapterShas,
      sha256File(path.join(lodyRoot, "pnpm-lock.yaml")),
      distContentSha256(dist),
      new Date().toISOString(),
      process.versions.node,
      pnpm,
    );
    const stampJson = `${JSON.stringify(stamp, null, 2)}\n`;
    const distStamp = path.join(dist, "BUILD.json");
    writeFileSync(distStamp, stampJson);
    chmodSync(distStamp, 0o444);

    const scratchTarball = packageTarball(lodyRoot, packRoot, environment);
    verifyTarball(scratchTarball, scratch, readPackageManifest(), stamp);
    const { tarball, stampFile } = publishPackageOutput(
      scratchTarball,
      stampJson,
      options.out,
    );

    const elapsed = ((Date.now() - started) / 1_000).toFixed(2);
    const summary =
      `built Lody ${provenance.upstreamSha.slice(0, 12)} in ${elapsed}s (${sha256File(tarball).slice(0, 12)} tarball)\n` +
      `tarball: ${tarball}\nBUILD.json: ${stampFile}\n` +
      (options.keepScratch || options.scratch !== null
        ? `scratch: ${scratch}\n`
        : "");
    if (options.json) {
      process.stdout.write(stampJson);
      process.stderr.write(summary);
    } else {
      process.stdout.write(summary);
    }
  } finally {
    if (!options.keepScratch && options.scratch === null) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "could not build Lody"}\n`,
    );
    process.exitCode = 1;
  }
}
