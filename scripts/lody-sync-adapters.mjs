#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY = path.resolve(SCRIPT_DIRECTORY, "..");
export const LODY_ADAPTER_NAMES = Object.freeze(["core", "claude", "codex", "dsh", "grok"]);
export const ADAPTER_MANIFEST_NAME = "MANIFEST.sha256";
const GIT_SHA = /^[a-f0-9]{40}$/u;
const HTTPS_URL = /^https:\/\/[^\s]+$/u;
const ADAPTER_METADATA_FILES = new Set(["UPSTREAM.md", ADAPTER_MANIFEST_NAME]);

function usage() {
  return `Vendor the five Lody CLI adapters at the subtree's gitlink pins.

Usage:
  node scripts/lody-sync-adapters.mjs [--check]

Options:
  --check     Verify checked-in adapter trees without network access.
  --help, -h  Print this text.`;
}

function runText(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail === "" ? "" : `: ${detail}`}`);
  }
  return result.stdout;
}

function runBinary(command, args, cwd, input) {
  const result = spawnSync(command, args, { cwd, input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    const detail = (result.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail === "" ? "" : `: ${detail}`}`);
  }
  return result.stdout;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareEntryPaths(left, right) {
  return compareUtf8(left.path, right.path);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestEntry(file) {
  return {
    path: file.path,
    mode: file.mode,
    sha256: sha256(file.bytes),
    size: file.bytes.length,
    hasCarriageReturn: file.bytes.includes(0x0d),
  };
}

export function adapterManifestBytes(entries) {
  const sorted = [...entries].sort(compareEntryPaths);
  for (const entry of sorted) {
    if (entry.path.startsWith("/") || /[\r\n]/u.test(entry.path)) {
      throw new Error(`adapter path cannot be represented in the manifest: ${entry.path}`);
    }
  }
  return Buffer.from(
    sorted
      .map((entry) => `${entry.sha256}  ${entry.mode}  ${entry.path}\n`)
      .join(""),
  );
}

function contentSha256(entries) {
  return sha256(adapterManifestBytes(entries));
}

function gitText(repository, args) {
  const stdout = runText("git", args, repository);
  return stdout.trim();
}

function gitlinkSha(repository, name, treeish = "HEAD") {
  const entry = gitText(repository, [
    "ls-tree",
    `${treeish}:vendor/lody/packages`,
    `acp-extension-${name}`,
  ]);
  const match = /^160000 commit ([a-f0-9]{40})\tacp-extension-[a-z]+$/u.exec(entry);
  if (match === null) throw new Error(`Lody adapter ${name} is not a gitlink at ${treeish}`);
  return match[1];
}

function adapterUrl(repository, name) {
  const modules = path.join(repository, "vendor/lody/.gitmodules");
  const url = gitText(repository, [
    "config",
    "-f",
    modules,
    "--get",
    `submodule.packages/acp-extension-${name}.url`,
  ]);
  if (!HTTPS_URL.test(url)) throw new Error(`Lody adapter ${name} has an invalid public URL`);
  return url;
}

function walkFiles(root, directory, files) {
  const directoryEntries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of directoryEntries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (ADAPTER_METADATA_FILES.has(relative)) continue;
    if (entry.isDirectory()) {
      walkFiles(root, absolute, files);
      continue;
    }
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) {
      const target = path.resolve(path.dirname(absolute), readlinkSync(absolute));
      const rootRealPath = realpathSync(root);
      const targetRealPath = realpathSync(target);
      const rootPrefix = `${rootRealPath}${path.sep}`;
      if (targetRealPath !== rootRealPath && !targetRealPath.startsWith(rootPrefix)) {
        throw new Error(`adapter symlink escapes its root: ${relative}`);
      }
      files.push({ path: relative, mode: "120000", bytes: Buffer.from(readlinkSync(absolute)) });
      continue;
    }
    if (!metadata.isFile()) throw new Error(`adapter has unsupported entry: ${relative}`);
    const mode = (metadata.mode & 0o111) === 0 ? "100644" : "100755";
    files.push({ path: relative, mode, bytes: readFileSync(absolute) });
  }
}

export function adapterManifestEntries(root) {
  const files = [];
  walkFiles(root, root, files);
  return files.map(manifestEntry).sort(compareEntryPaths);
}

export function adapterContentSha256(root) {
  return contentSha256(adapterManifestEntries(root));
}

function readBatchBlobs(repository, entries) {
  if (entries.length === 0) return [];
  const input = Buffer.from(`${entries.map((entry) => entry.object).join("\n")}\n`);
  const output = runBinary("git", ["cat-file", "--batch"], repository, input);
  const blobs = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new Error(`could not read adapter blob ${entry.object}`);
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^([a-f0-9]+) blob ([0-9]+)$/u.exec(header);
    if (match === null || match[1] !== entry.object) {
      throw new Error(`invalid adapter blob response for ${entry.object}`);
    }
    const size = Number.parseInt(match[2], 10);
    const start = headerEnd + 1;
    const end = start + size;
    if (output[end] !== 0x0a) throw new Error(`truncated adapter blob ${entry.object}`);
    blobs.push(output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error("unexpected trailing adapter blob content");
  return blobs;
}

function parseGitAdapterEntries(repository, name, treeish) {
  const root = `vendor/lody-adapters/${name}`;
  const prefix = `${root}/`;
  const args = treeish === null
    ? ["ls-files", "--stage", "-z", "--", root]
    : ["ls-tree", "-rz", treeish, "--", root];
  const output = runBinary("git", args, repository).toString("utf8");
  return output.split("\0").filter((entry) => entry !== "").flatMap((entry) => {
    const match = treeish === null
      ? /^(100644|100755|120000) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/u.exec(entry)
      : /^(100644|100755|120000) blob ([a-f0-9]+)\t([\s\S]+)$/u.exec(entry);
    if (match === null) throw new Error(`${name}: invalid Git adapter entry`);
    const mode = match[1];
    const object = match[2];
    const stage = treeish === null ? match[3] : "0";
    const file = treeish === null ? match[4] : match[3];
    if (stage !== "0") throw new Error(`${name}: adapter index has an unresolved entry: ${file}`);
    if (!file.startsWith(prefix)) throw new Error(`${name}: adapter Git path escapes its root`);
    const relative = file.slice(prefix.length);
    if (ADAPTER_METADATA_FILES.has(relative)) return [];
    return [{ path: relative, mode, object }];
  });
}

/** Read adapter bytes and modes stored in Git's index, or in a committed tree. */
export function adapterGitManifestEntries(repository, name, treeish = null) {
  const entries = parseGitAdapterEntries(repository, name, treeish);
  const blobs = readBatchBlobs(repository, entries);
  return entries.map((entry, index) => manifestEntry({
    path: entry.path,
    mode: entry.mode,
    bytes: blobs[index],
  })).sort(compareEntryPaths);
}

export function adapterGitManifestBytes(repository, name, treeish = null) {
  return adapterManifestBytes(adapterGitManifestEntries(repository, name, treeish));
}

/** Hash the canonical manifest for Git's index, or for a committed tree. */
export function adapterGitContentSha256(repository, name, treeish = null) {
  return sha256(adapterGitManifestBytes(repository, name, treeish));
}

export function parseAdapterManifest(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("adapter manifest is not valid UTF-8");
  if (text !== "" && !text.endsWith("\n")) {
    throw new Error("adapter manifest must end with a newline");
  }
  const entries = text === "" ? [] : text.slice(0, -1).split("\n").map((line) => {
    const match = /^([a-f0-9]{64})  (100644|100755|120000)  (.+)$/u.exec(line);
    if (match === null) throw new Error(`invalid adapter manifest line: ${line}`);
    const entryPath = match[3];
    if (
      entryPath.startsWith("/")
      || entryPath.split("/").some((part) => part === "" || part === "." || part === "..")
      || ADAPTER_METADATA_FILES.has(entryPath)
    ) {
      throw new Error(`invalid adapter manifest path: ${entryPath}`);
    }
    return {
      path: entryPath,
      mode: match[2],
      sha256: match[1],
      size: null,
      hasCarriageReturn: null,
    };
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (compareEntryPaths(entries[index - 1], entries[index]) >= 0) {
      throw new Error("adapter manifest paths are duplicated or not in UTF-8 byte order");
    }
  }
  if (!adapterManifestBytes(entries).equals(bytes)) {
    throw new Error("adapter manifest is not in canonical format");
  }
  return entries;
}

function describeEntry(entry) {
  const size = entry.size === null ? "not recorded" : `${entry.size} bytes`;
  const carriageReturns = entry.hasCarriageReturn === null
    ? "not recorded"
    : (entry.hasCarriageReturn ? "yes" : "no");
  return `mode ${entry.mode}, sha256 ${entry.sha256}, size ${size}, CR ${carriageReturns}`;
}

export function adapterManifestDiff(expected, actual) {
  const missing = [];
  const extra = [];
  const changed = [];
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])].sort(compareUtf8);
  for (const entryPath of paths) {
    const expectedEntry = expectedByPath.get(entryPath);
    const actualEntry = actualByPath.get(entryPath);
    if (actualEntry === undefined) missing.push(expectedEntry);
    else if (expectedEntry === undefined) extra.push(actualEntry);
    else if (
      expectedEntry.mode !== actualEntry.mode
      || expectedEntry.sha256 !== actualEntry.sha256
    ) {
      changed.push({ path: entryPath, expected: expectedEntry, actual: actualEntry });
    }
  }
  return { missing, extra, changed };
}

function formatManifestDiff(label, report) {
  const lines = [`${label}:`];
  if (report.missing.length > 0) {
    lines.push("  missing files:");
    for (const entry of report.missing) {
      lines.push(`    - ${entry.path}`);
      lines.push(`      expected: ${describeEntry(entry)}`);
    }
  }
  if (report.extra.length > 0) {
    lines.push("  extra files:");
    for (const entry of report.extra) {
      lines.push(`    + ${entry.path}`);
      lines.push(`      actual: ${describeEntry(entry)}`);
    }
  }
  if (report.changed.length > 0) {
    lines.push("  changed files:");
    for (const entry of report.changed) {
      lines.push(`    ~ ${entry.path}`);
      lines.push(`      expected: ${describeEntry(entry.expected)}`);
      lines.push(`      actual:   ${describeEntry(entry.actual)}`);
    }
  }
  return lines.join("\n");
}

function reportHasChanges(report) {
  return report.missing.length > 0 || report.extra.length > 0 || report.changed.length > 0;
}

export function verifyAdapterManifest(root, gitEntries = null) {
  const manifestFile = path.join(root, ADAPTER_MANIFEST_NAME);
  if (!existsSync(manifestFile)) {
    return {
      contentSha256: null,
      errors: [`missing ${ADAPTER_MANIFEST_NAME}`],
    };
  }
  const manifestBytes = readFileSync(manifestFile);
  const manifestContentSha256 = sha256(manifestBytes);
  let manifestEntries;
  try {
    manifestEntries = parseAdapterManifest(manifestBytes);
  } catch (error) {
    return {
      contentSha256: manifestContentSha256,
      errors: [error instanceof Error ? error.message : "invalid adapter manifest"],
    };
  }

  const errors = [];
  if (gitEntries !== null) {
    const manifestReport = adapterManifestDiff(gitEntries, manifestEntries);
    if (reportHasChanges(manifestReport)) {
      errors.push(formatManifestDiff("manifest differs from Git content", manifestReport));
    }
  }
  const expected = gitEntries ?? manifestEntries;
  const treeReport = adapterManifestDiff(expected, adapterManifestEntries(root));
  if (reportHasChanges(treeReport)) {
    errors.push(formatManifestDiff(
      `adapter tree differs from ${gitEntries === null ? ADAPTER_MANIFEST_NAME : "Git content"}`,
      treeReport,
    ));
  }
  return { contentSha256: manifestContentSha256, errors };
}

function stampValue(source, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\| ${escaped} \\| \x60?([^|\x60]+?)\x60? \\|$`, "mu").exec(source);
  if (match === null) throw new Error(`adapter UPSTREAM.md is missing ${field}`);
  return match[1].trim();
}

export function readAdapterStamp(file) {
  const source = readFileSync(file, "utf8");
  const stamp = {
    name: stampValue(source, "Adapter"),
    url: stampValue(source, "Repository"),
    sha: stampValue(source, "Commit"),
    commitDate: stampValue(source, "Commit date"),
    syncDate: stampValue(source, "Synced on"),
    contentSha256: stampValue(source, "Content SHA-256"),
  };
  if (!LODY_ADAPTER_NAMES.includes(stamp.name)) throw new Error("adapter stamp has an invalid name");
  if (!HTTPS_URL.test(stamp.url)) throw new Error(`${stamp.name} stamp has an invalid URL`);
  if (!GIT_SHA.test(stamp.sha)) throw new Error(`${stamp.name} stamp has an invalid commit`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/u.test(stamp.commitDate)) {
    throw new Error(`${stamp.name} stamp has an invalid commit date`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(stamp.syncDate)) {
    throw new Error(`${stamp.name} stamp has an invalid sync date`);
  }
  if (!/^[a-f0-9]{64}$/u.test(stamp.contentSha256)) {
    throw new Error(`${stamp.name} stamp has an invalid content hash`);
  }
  return stamp;
}

function checkWorkspaceExclusion(repository, errors) {
  const kimiSha = gitlinkSha(repository, "kimi");
  if (!GIT_SHA.test(kimiSha)) errors.push("Kimi is not pinned by a gitlink");
  const workspace = readFileSync(path.join(repository, "vendor/lody/pnpm-workspace.yaml"), "utf8");
  if (!workspace.includes("- '!packages/acp-extension-kimi'")) {
    errors.push("Kimi is no longer explicitly excluded by vendor/lody/pnpm-workspace.yaml");
  }
}

export function adapterDriftErrors(repository = DEFAULT_REPOSITORY) {
  const errors = [];
  const adaptersRoot = path.join(repository, "vendor/lody-adapters");
  if (!existsSync(adaptersRoot)) return ["missing reviewed adapter directory: vendor/lody-adapters"];
  const materialized = readdirSync(adaptersRoot, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort(compareUtf8);
  const expected = [...LODY_ADAPTER_NAMES].sort(compareUtf8);
  if (materialized.join("\n") !== expected.join("\n")) {
    errors.push(`materialized adapters are ${materialized.join(", ")}; expected ${expected.join(", ")}`);
  }
  if (materialized.includes("kimi")) errors.push("Kimi must not be vendored");

  for (const name of LODY_ADAPTER_NAMES) {
    const root = path.join(adaptersRoot, name);
    if (!existsSync(root)) {
      errors.push(`${name}: missing vendored adapter directory`);
      continue;
    }
    try {
      const stamp = readAdapterStamp(path.join(root, "UPSTREAM.md"));
      const sha = gitlinkSha(repository, name);
      const url = adapterUrl(repository, name);
      const gitEntries = adapterGitManifestEntries(repository, name);
      const manifest = verifyAdapterManifest(root, gitEntries);
      if (stamp.name !== name) errors.push(`${name}: stamp names ${stamp.name}`);
      if (stamp.sha !== sha) errors.push(`${name}: stamp ${stamp.sha} differs from gitlink ${sha}`);
      if (stamp.url !== url) errors.push(`${name}: stamp URL differs from .gitmodules`);
      errors.push(...manifest.errors.map((error) => `${name}: ${error}`));
      if (
        manifest.contentSha256 !== null
        && stamp.contentSha256 !== manifest.contentSha256
      ) {
        errors.push(
          `${name}: manifest hash ${manifest.contentSha256} differs from stamp ${stamp.contentSha256}`,
        );
      }
      if (existsSync(path.join(root, ".git"))) errors.push(`${name}: vendored tree contains .git`);
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : "adapter check failed"}`);
    }
  }
  try {
    checkWorkspaceExclusion(repository, errors);
  } catch (error) {
    errors.push(`kimi: ${error instanceof Error ? error.message : "workspace check failed"}`);
  }
  return errors;
}

function writeStamp(root, name, url, sha, commitDate, contentSha256) {
  const syncDate = new Date().toISOString().slice(0, 10);
  const contents = `# ${name} ACP adapter upstream pin

This directory is generated by \`node scripts/lody-sync-adapters.mjs\`.
Do not edit its contents by hand.

| Field | Value |
|---|---|
| Adapter | \`${name}\` |
| Repository | ${url} |
| Commit | \`${sha}\` |
| Commit date | ${commitDate} |
| Synced on | ${syncDate} |
| Content SHA-256 | \`${contentSha256}\` |
`;
  writeFileSync(path.join(root, "UPSTREAM.md"), contents);
}

export function destinationHasLocalChanges(repository, name) {
  const relative = `vendor/lody-adapters/${name}`;
  return gitText(repository, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored",
    "--",
    relative,
  ]) !== "";
}

function fetchAdapter(scratch, repository, name) {
  const sha = gitlinkSha(repository, name);
  const url = adapterUrl(repository, name);
  const checkout = path.join(scratch, `${name}-git`);
  const tree = path.join(scratch, `${name}-tree`);
  mkdirSync(checkout);
  mkdirSync(tree);
  gitText(checkout, ["init", "-q"]);
  gitText(checkout, ["remote", "add", "origin", url]);
  gitText(checkout, ["fetch", "-q", "--depth=1", "origin", sha]);
  const fetched = gitText(checkout, ["rev-parse", "FETCH_HEAD"]);
  if (fetched !== sha) throw new Error(`${name}: fetched ${fetched}, expected ${sha}`);
  const archive = runBinary("git", ["archive", "--format=tar", sha], checkout);
  runBinary("tar", ["-x", "-C", tree], scratch, archive);
  const commitDate = gitText(checkout, ["show", "-s", "--format=%cI", sha]);
  const manifest = adapterManifestBytes(adapterManifestEntries(tree));
  const contentSha256 = sha256(manifest);
  return { name, sha, url, commitDate, contentSha256, manifest, tree };
}

export function syncAdapters(repository = DEFAULT_REPOSITORY) {
  for (const name of LODY_ADAPTER_NAMES) {
    if (destinationHasLocalChanges(repository, name)) {
      throw new Error(`${name}: vendor/lody-adapters has local changes; commit or remove them before syncing`);
    }
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "lody-adapters-"));
  try {
    const fetched = LODY_ADAPTER_NAMES.map((name) => fetchAdapter(scratch, repository, name));
    const adaptersRoot = path.join(repository, "vendor/lody-adapters");
    mkdirSync(adaptersRoot, { recursive: true });
    for (const adapter of fetched) {
      const destination = path.join(adaptersRoot, adapter.name);
      rmSync(destination, { recursive: true, force: true });
      cpSync(adapter.tree, destination, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      writeFileSync(path.join(destination, ADAPTER_MANIFEST_NAME), adapter.manifest);
      writeStamp(
        destination,
        adapter.name,
        adapter.url,
        adapter.sha,
        adapter.commitDate,
        adapter.contentSha256,
      );
      process.stdout.write(`${adapter.name} ${adapter.sha} ${adapter.contentSha256}\n`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  let check = false;
  let help = false;
  for (const flag of argv) {
    if (flag === "--check") check = true;
    else if (flag === "--help" || flag === "-h") help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return { check, help };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.check) syncAdapters();
  const errors = adapterDriftErrors();
  if (errors.length > 0) throw new Error(`Lody adapter drift:\n- ${errors.join("\n- ")}`);
  process.stdout.write(`verified ${LODY_ADAPTER_NAMES.length} Lody adapter trees\n`);
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "could not sync Lody adapters"}\n`);
    process.exitCode = 1;
  }
}
