#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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
const GIT_SHA = /^[a-f0-9]{40}$/u;
const HTTPS_URL = /^https:\/\/[^\s]+$/u;
const ADAPTER_METADATA_FILES = new Set(["UPSTREAM.md"]);

function usage() {
  return `Vendor the five Lody CLI adapters at the subtree's gitlink pins.

Usage:
  node scripts/lody-sync-adapters.mjs [--check [--fetch]]

Options:
  --check     Verify the checked-in adapter trees against Git's index.
  --fetch     With --check, compare the tracked trees to their upstream commits.
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

function gitText(repository, args) {
  return runText("git", args, repository).trim();
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

export function adapterTreeEntries(root) {
  const files = [];
  walkFiles(root, root, files);
  return files.sort(compareEntryPaths);
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
export function adapterGitEntries(repository, name, treeish = null) {
  const entries = parseGitAdapterEntries(repository, name, treeish);
  const blobs = readBatchBlobs(repository, entries);
  return entries.map((entry, index) => ({
    path: entry.path,
    mode: entry.mode,
    bytes: blobs[index],
  })).sort(compareEntryPaths);
}

export function adapterEntryDiff(expected, actual) {
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
      || !expectedEntry.bytes.equals(actualEntry.bytes)
    ) {
      changed.push({ path: entryPath, expected: expectedEntry, actual: actualEntry });
    }
  }
  return { missing, extra, changed };
}

function describeEntry(entry) {
  const carriageReturns = entry.bytes.includes(0x0d) ? "yes" : "no";
  return `mode ${entry.mode}, size ${entry.bytes.length} bytes, CR ${carriageReturns}`;
}

function formatEntryDiff(label, report) {
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

export function verifyAdapterCheckout(root, gitEntries = null) {
  if (!existsSync(root)) return { errors: ["missing adapter directory"] };
  const packageFile = path.join(root, "package.json");
  if (
    !existsSync(packageFile)
    || !lstatSync(packageFile).isFile()
    || lstatSync(packageFile).size === 0
  ) {
    return { errors: ["missing or empty package.json"] };
  }
  if (gitEntries === null) {
    // Docker builder contexts have no .git, so only snapshot existence is checkable here.
    return { errors: [] };
  }
  const report = adapterEntryDiff(gitEntries, adapterTreeEntries(root));
  return {
    errors: reportHasChanges(report)
      ? [formatEntryDiff("adapter checkout differs from Git content", report)]
      : [],
  };
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

export function adapterCheckoutHasDrift(repository, name) {
  const relative = `vendor/lody-adapters/${name}`;
  const diff = spawnSync("git", ["diff", "--quiet", "--", relative], {
    cwd: repository,
    stdio: "ignore",
  });
  if (diff.status !== 0 && diff.status !== 1) {
    throw new Error(`${name}: could not compare the adapter checkout to Git's index`);
  }
  if (diff.status === 1) return true;
  return gitText(repository, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    relative,
  ]) !== "";
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
    try {
      const checkout = verifyAdapterCheckout(root);
      errors.push(...checkout.errors.map((error) => `${name}: ${error}`));
      if (checkout.errors.length > 0) continue;
      const stamp = readAdapterStamp(path.join(root, "UPSTREAM.md"));
      const sha = gitlinkSha(repository, name);
      const url = adapterUrl(repository, name);
      if (stamp.name !== name) errors.push(`${name}: stamp names ${stamp.name}`);
      if (stamp.sha !== sha) {
        errors.push(`${name}: recorded upstream ${stamp.sha} differs from gitlink ${sha}`);
      }
      if (stamp.url !== url) errors.push(`${name}: stamp URL differs from .gitmodules`);
      if (adapterCheckoutHasDrift(repository, name)) {
        errors.push(`${name}: checkout drifted from Git index`);
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

function writeStamp(root, name, url, sha, commitDate) {
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
  return { name, sha, url, commitDate, tree };
}

export function adapterFetchErrors(repository = DEFAULT_REPOSITORY) {
  const errors = [];
  const scratch = mkdtempSync(path.join(tmpdir(), "lody-adapters-check-"));
  try {
    for (const name of LODY_ADAPTER_NAMES) {
      try {
        const fetched = fetchAdapter(scratch, repository, name);
        const report = adapterEntryDiff(
          adapterTreeEntries(fetched.tree),
          adapterGitEntries(repository, name),
        );
        if (reportHasChanges(report)) {
          errors.push(formatEntryDiff(
            `${name}: tracked snapshot differs from upstream ${fetched.sha}`,
            report,
          ));
        }
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : "upstream check failed"}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return errors;
}

function snapshotPaths(root) {
  if (!existsSync(root)) return new Set();
  const paths = new Set(adapterTreeEntries(root).map((entry) => entry.path));
  if (existsSync(path.join(root, "UPSTREAM.md"))) paths.add("UPSTREAM.md");
  return paths;
}

export function syncAdapters(repository = DEFAULT_REPOSITORY) {
  const previous = new Map();
  for (const name of LODY_ADAPTER_NAMES) {
    if (destinationHasLocalChanges(repository, name)) {
      throw new Error(`${name}: vendor/lody-adapters has local changes; commit or remove them before syncing`);
    }
    const root = path.join(repository, "vendor/lody-adapters", name);
    previous.set(name, {
      sha: existsSync(path.join(root, "UPSTREAM.md"))
        ? readAdapterStamp(path.join(root, "UPSTREAM.md")).sha
        : "none",
      paths: snapshotPaths(root),
    });
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
      writeStamp(destination, adapter.name, adapter.url, adapter.sha, adapter.commitDate);
      const nextPaths = snapshotPaths(destination);
      const before = previous.get(adapter.name);
      const removed = [...before.paths].filter((entry) => !nextPaths.has(entry)).length;
      process.stdout.write(
        `${adapter.name}: old ${before.sha}; new ${adapter.sha}; wrote ${nextPaths.size} files; removed ${removed} files\n`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  let check = false;
  let fetch = false;
  let help = false;
  for (const flag of argv) {
    if (flag === "--check") check = true;
    else if (flag === "--fetch") fetch = true;
    else if (flag === "--help" || flag === "-h") help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (fetch && !check) throw new Error("--fetch requires --check");
  return { check, fetch, help };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.check) {
    syncAdapters();
    return;
  }
  const errors = adapterDriftErrors();
  if (options.fetch && errors.length === 0) errors.push(...adapterFetchErrors());
  if (errors.length > 0) throw new Error(`Lody adapter drift:\n- ${errors.join("\n- ")}`);
  process.stdout.write(
    `verified ${LODY_ADAPTER_NAMES.length} Lody adapter trees${options.fetch ? " against upstream" : ""}\n`,
  );
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
