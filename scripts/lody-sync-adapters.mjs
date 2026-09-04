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
const GIT_SHA = /^[a-f0-9]{40}$/u;
const HTTPS_URL = /^https:\/\/[^\s]+$/u;

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
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative === "UPSTREAM.md") continue;
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

export function adapterContentSha256(root) {
  const files = [];
  walkFiles(root, root, files);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const aggregate = createHash("sha256");
  for (const file of files) {
    const digest = createHash("sha256").update(file.bytes).digest("hex");
    aggregate.update(`${file.path}\0${file.mode}\0${digest}\n`);
  }
  return aggregate.digest("hex");
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
    .sort();
  const expected = [...LODY_ADAPTER_NAMES].sort();
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
      const contentSha256 = adapterContentSha256(root);
      if (stamp.name !== name) errors.push(`${name}: stamp names ${stamp.name}`);
      if (stamp.sha !== sha) errors.push(`${name}: stamp ${stamp.sha} differs from gitlink ${sha}`);
      if (stamp.url !== url) errors.push(`${name}: stamp URL differs from .gitmodules`);
      if (stamp.contentSha256 !== contentSha256) {
        errors.push(`${name}: content hash ${contentSha256} differs from stamp ${stamp.contentSha256}`);
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

function destinationHasLocalChanges(repository, name) {
  const relative = `vendor/lody-adapters/${name}`;
  const tracked = gitText(repository, ["ls-files", relative]);
  if (tracked === "") return false;
  return gitText(repository, ["status", "--porcelain=v1", "--untracked-files=all", "--", relative]) !== "";
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
  const contentSha256 = adapterContentSha256(tree);
  return { name, sha, url, commitDate, contentSha256, tree };
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
