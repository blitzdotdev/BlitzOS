#!/usr/bin/env node

// The one source of truth for files that move with an in-place box payload.
// Archive paths always start at `rootfs/`; source paths are derived from that
// prefix.
//
// Keep this list explicit. test/box-payload-files.test.mjs discovers every
// eligible source file independently and fails when a new script is not given
// payload ownership here.

import { readFile, readdir, mkdir, copyFile, chmod, lstat, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PAYLOAD_ROOTFS_PATHS = Object.freeze([
  "etc/s6-overlay/s6-rc.d/cgroups/type",
  "etc/s6-overlay/s6-rc.d/cgroups/up",
  "etc/s6-overlay/s6-rc.d/cloudflared/dependencies.d/init-state",
  "etc/s6-overlay/s6-rc.d/cloudflared/run",
  "etc/s6-overlay/s6-rc.d/cloudflared/type",
  "etc/s6-overlay/s6-rc.d/dockerd/dependencies.d/register",
  "etc/s6-overlay/s6-rc.d/dockerd/run",
  "etc/s6-overlay/s6-rc.d/dockerd/type",
  "etc/s6-overlay/s6-rc.d/dufs/dependencies.d/register",
  "etc/s6-overlay/s6-rc.d/dufs/run",
  "etc/s6-overlay/s6-rc.d/dufs/type",
  "etc/s6-overlay/s6-rc.d/gateway/dependencies.d/dufs",
  "etc/s6-overlay/s6-rc.d/gateway/run",
  "etc/s6-overlay/s6-rc.d/gateway/type",
  "etc/s6-overlay/s6-rc.d/init-state/dependencies.d/cgroups",
  "etc/s6-overlay/s6-rc.d/init-state/type",
  "etc/s6-overlay/s6-rc.d/init-state/up",
  "etc/s6-overlay/s6-rc.d/lody-bridge/dependencies.d/lody-daemon",
  "etc/s6-overlay/s6-rc.d/lody-bridge/run",
  "etc/s6-overlay/s6-rc.d/lody-bridge/type",
  "etc/s6-overlay/s6-rc.d/lody-daemon/dependencies.d/register",
  "etc/s6-overlay/s6-rc.d/lody-daemon/run",
  "etc/s6-overlay/s6-rc.d/lody-daemon/type",
  "etc/s6-overlay/s6-rc.d/lody-projects/dependencies.d/lody-daemon",
  "etc/s6-overlay/s6-rc.d/lody-projects/run",
  "etc/s6-overlay/s6-rc.d/lody-projects/type",
  "etc/s6-overlay/s6-rc.d/lody-watchdog/dependencies.d/lody-daemon",
  "etc/s6-overlay/s6-rc.d/lody-watchdog/run",
  "etc/s6-overlay/s6-rc.d/lody-watchdog/type",
  "etc/s6-overlay/s6-rc.d/machine-stats/dependencies.d/register",
  "etc/s6-overlay/s6-rc.d/machine-stats/run",
  "etc/s6-overlay/s6-rc.d/machine-stats/type",
  "etc/s6-overlay/s6-rc.d/payload/dependencies.d/init-state",
  "etc/s6-overlay/s6-rc.d/payload/run",
  "etc/s6-overlay/s6-rc.d/payload/type",
  "etc/s6-overlay/s6-rc.d/register/dependencies.d/init-state",
  "etc/s6-overlay/s6-rc.d/register/type",
  "etc/s6-overlay/s6-rc.d/register/up",
  "etc/s6-overlay/s6-rc.d/remote-control/dependencies.d/register",
  "etc/s6-overlay/s6-rc.d/remote-control/run",
  "etc/s6-overlay/s6-rc.d/remote-control/type",
  "etc/s6-overlay/s6-rc.d/rules/dependencies.d/register",
  "etc/s6-overlay/s6-rc.d/rules/type",
  "etc/s6-overlay/s6-rc.d/rules/up",
  "etc/s6-overlay/s6-rc.d/sshd/dependencies.d/register",
  "etc/s6-overlay/s6-rc.d/sshd/run",
  "etc/s6-overlay/s6-rc.d/sshd/type",
  "etc/s6-overlay/s6-rc.d/ttyd/dependencies.d/register",
  "etc/s6-overlay/s6-rc.d/ttyd/run",
  "etc/s6-overlay/s6-rc.d/ttyd/type",
  "etc/s6-overlay/s6-rc.d/user/contents.d/cgroups",
  "etc/s6-overlay/s6-rc.d/user/contents.d/cloudflared",
  "etc/s6-overlay/s6-rc.d/user/contents.d/dockerd",
  "etc/s6-overlay/s6-rc.d/user/contents.d/dufs",
  "etc/s6-overlay/s6-rc.d/user/contents.d/gateway",
  "etc/s6-overlay/s6-rc.d/user/contents.d/init-state",
  "etc/s6-overlay/s6-rc.d/user/contents.d/lody-bridge",
  "etc/s6-overlay/s6-rc.d/user/contents.d/lody-daemon",
  "etc/s6-overlay/s6-rc.d/user/contents.d/lody-projects",
  "etc/s6-overlay/s6-rc.d/user/contents.d/lody-watchdog",
  "etc/s6-overlay/s6-rc.d/user/contents.d/machine-stats",
  "etc/s6-overlay/s6-rc.d/user/contents.d/payload",
  "etc/s6-overlay/s6-rc.d/user/contents.d/register",
  "etc/s6-overlay/s6-rc.d/user/contents.d/remote-control",
  "etc/s6-overlay/s6-rc.d/user/contents.d/rules",
  "etc/s6-overlay/s6-rc.d/user/contents.d/sshd",
  "etc/s6-overlay/s6-rc.d/user/contents.d/ttyd",
  "etc/s6-overlay/s6-rc.d/user/contents.d/watch",
  "etc/s6-overlay/s6-rc.d/user/type",
  "etc/s6-overlay/s6-rc.d/user2/type",
  "etc/s6-overlay/s6-rc.d/watch/dependencies.d/register",
  "etc/s6-overlay/s6-rc.d/watch/run",
  "etc/s6-overlay/s6-rc.d/watch/type",
  "opt/blitz/skel/agent-rules.md",
  "usr/local/bin/blitz",
  "usr/local/bin/blitz-cgroup",
  "usr/local/bin/blitz-cred-claude",
  "usr/local/bin/blitz-cred-codex",
  "usr/local/bin/blitz-machine-stats",
  "usr/local/bin/blitz-rules",
  "usr/local/bin/claude",
  "usr/local/bin/codex",
  "usr/local/libexec/blitz-codex-session",
  "usr/local/libexec/blitz-git-credential",
  "usr/local/libexec/blitz-healthcheck",
  "usr/local/libexec/blitz-init-state",
  "usr/local/libexec/blitz-lody-bridge",
  "usr/local/libexec/blitz-lody-projects",
  "usr/local/libexec/blitz-register",
  "usr/local/libexec/blitz-rules-boot",
  "usr/local/libexec/blitz-ssh-session",
  "usr/local/libexec/blitz-term",
]);

export const PAYLOAD_GENERATED_PATHS = Object.freeze([
  "rootfs/usr/local/bin/blitz-box-gateway",
]);

// top/contents.d names user2. s6-rc-compile refuses a bundle without contents.d.
export const PAYLOAD_DIRECTORIES = Object.freeze([
  "rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d",
]);

export const PAYLOAD_FILES = Object.freeze([
  ...PAYLOAD_ROOTFS_PATHS.map((relativePath) => `rootfs/${relativePath}`),
  ...PAYLOAD_GENERATED_PATHS,
].sort());

const NON_SERVICE_PAYLOAD_ROOTFS_PATHS = Object.freeze(PAYLOAD_ROOTFS_PATHS
  .filter((relativePath) => !relativePath.startsWith("etc/s6-overlay/s6-rc.d/")));

// Most executable dependencies can be read directly from the service source.
// These three are the exceptions worth spelling out. The gateway binary is
// generated rather than present under rootfs; the bridge override documents
// its service boundary explicitly; and blitz-term is resolved by ttyd for each
// new connection, so changing it must NOT bounce ttyd or existing terminals.
export const PAYLOAD_SERVICE_OVERRIDES = Object.freeze({
  "rootfs/usr/local/bin/blitz-box-gateway": Object.freeze(["gateway"]),
  "rootfs/usr/local/libexec/blitz-lody-bridge": Object.freeze(["lody-bridge"]),
  "rootfs/usr/local/libexec/blitz-term": Object.freeze([]),
});

const LONGRUN_SCRIPT_PATTERN =
  /^rootfs\/etc\/s6-overlay\/s6-rc\.d\/([^/]+)\/run$/u;
const SERVICE_TREE_PREFIX = "rootfs/etc/s6-overlay/s6-rc.d/";
const LIVE_PAYLOAD_PATH_PATTERN =
  /\/(?:usr\/local\/(?:bin|libexec)|opt\/blitz\/skel|etc\/blitz)\/[A-Za-z0-9._/-]+/gu;

export function payloadSourcePath(repoRoot, archivePath) {
  if (PAYLOAD_GENERATED_PATHS.includes(archivePath)) return null;
  return path.join(repoRoot, "packages/box", archivePath);
}

export async function payloadMode(repoRoot, archivePath) {
  if (PAYLOAD_GENERATED_PATHS.includes(archivePath)) return 0o755;
  const sourcePath = payloadSourcePath(repoRoot, archivePath);
  const metadata = await lstat(sourcePath);
  if (!metadata.isFile()) {
    throw new Error(`payload source is not a regular file: ${archivePath}`);
  }
  // Git records one executable bit, and every supported release checkout
  // preserves it. Canonical payload modes therefore come from source metadata.
  return (metadata.mode & 0o111) === 0 ? 0o644 : 0o755;
}

async function filesBelow(root, relative = "") {
  const result = [];
  const entries = await readdir(
    path.join(root, relative),
    { withFileTypes: true },
  );
  for (const entry of entries) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await filesBelow(root, child));
    else if (entry.isFile()) result.push(child);
    else throw new Error(`payload service-tree source is not a regular file: ${child}`);
  }
  return result;
}

async function normalizePayloadDirectories(root) {
  await chmod(root, 0o755);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await normalizePayloadDirectories(path.join(root, entry.name));
    }
  }
}

/** Resolves the service-tree portion against the selected repository. This
 * lets release assembly add and remove services without changing a second
 * inventory. The exported constants still describe this checkout exactly. */
export async function payloadFilesForRepo(repoRoot) {
  const serviceRoot = path.join(
    repoRoot,
    "packages/box/rootfs/etc/s6-overlay/s6-rc.d",
  );
  const servicePaths = (await filesBelow(serviceRoot))
    .map((relativePath) => `rootfs/etc/s6-overlay/s6-rc.d/${relativePath}`);
  return [
    ...NON_SERVICE_PAYLOAD_ROOTFS_PATHS.map((relativePath) => `rootfs/${relativePath}`),
    ...servicePaths,
    ...PAYLOAD_GENERATED_PATHS,
  ].sort();
}

function uncommentedSource(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
}

/** Derives service -> payload dependencies from the real s6 source scripts. */
export async function readPayloadRestartMap(repoRoot) {
  const payloadFiles = await payloadFilesForRepo(repoRoot);
  const serviceScripts = payloadFiles.filter((archivePath) =>
    LONGRUN_SCRIPT_PATTERN.test(archivePath) && !archivePath.endsWith("/payload/run"),
  );
  const sources = await Promise.all(serviceScripts.map(async (archivePath) => ({
    archivePath,
    source: uncommentedSource(await readFile(payloadSourcePath(repoRoot, archivePath), "utf8")),
  })));
  const dependencies = new Map();
  for (const { archivePath } of sources) {
    const service = LONGRUN_SCRIPT_PATTERN.exec(archivePath)?.[1];
    if (service === undefined) throw new Error(`invalid payload service script: ${archivePath}`);
    const typePath = path.join(
      repoRoot,
      "packages/box/rootfs/etc/s6-overlay/s6-rc.d",
      service,
      "type",
    );
    if ((await readFile(typePath, "utf8")).trim() !== "longrun") {
      throw new Error(`payload restart service is not a longrun: ${service}`);
    }
    dependencies.set(service, new Set());
  }

  for (const archivePath of payloadFiles) {
    const overridden = PAYLOAD_SERVICE_OVERRIDES[archivePath];
    const livePath = archivePath.startsWith("rootfs/") ? archivePath.slice("rootfs".length) : null;
    const services = overridden ?? (livePath === null ? [] : sources
      .filter(({ source }) => [...source.matchAll(LIVE_PAYLOAD_PATH_PATTERN)]
        .some((match) => match[0] === livePath))
      .map(({ archivePath: scriptPath }) => LONGRUN_SCRIPT_PATTERN.exec(scriptPath)?.[1])
      .filter((service) => service !== undefined));
    for (const service of services) {
      const serviceDependencies = dependencies.get(service);
      if (serviceDependencies === undefined) {
        throw new Error(`payload dependency names unknown service ${service}`);
      }
      serviceDependencies.add(archivePath);
    }
  }

  return Object.fromEntries([...dependencies.entries()]
    .filter(([, paths]) => paths.size > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([service, paths]) => [service, [...paths].sort()]));
}

export async function copyPayloadSources(repoRoot, destination) {
  await mkdir(destination, { recursive: true, mode: 0o755 });
  for (const directory of PAYLOAD_DIRECTORIES) {
    await mkdir(path.join(destination, directory), { recursive: true, mode: 0o755 });
    await chmod(path.join(destination, directory), 0o755);
  }
  for (const archivePath of await payloadFilesForRepo(repoRoot)) {
    const sourcePath = payloadSourcePath(repoRoot, archivePath);
    if (sourcePath === null) continue;
    const targetPath = path.join(destination, archivePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, await payloadMode(repoRoot, archivePath));
  }
  await normalizePayloadDirectories(destination);
}

async function replaceWithSymlink(targetPath, linkTarget) {
  const existing = await lstat(targetPath).catch(() => null);
  if (existing !== null) await rm(targetPath, { recursive: existing.isDirectory(), force: true });
  await mkdir(path.dirname(targetPath), { recursive: true });
  await symlink(linkTarget, targetPath);
}

/** Turns the image's payload-owned paths into stable indirections to current. */
export async function installPayloadIndirections(imageRoot) {
  const currentRoot = "/opt/blitz/payload/current";
  await replaceWithSymlink(
    path.join(imageRoot, "etc/s6-overlay/s6-rc.d"),
    `${currentRoot}/rootfs/etc/s6-overlay/s6-rc.d`,
  );
  for (const archivePath of PAYLOAD_FILES) {
    if (archivePath.startsWith(SERVICE_TREE_PREFIX)) continue;
    const targetPath = path.join(imageRoot, archivePath.slice("rootfs/".length));
    const payloadPath = `${currentRoot}/${archivePath}`;
    await replaceWithSymlink(targetPath, payloadPath);
  }
}

function usage() {
  return "usage: box-payload-files.mjs copy <repo-root> <destination> | install <image-root>";
}

async function main(argv) {
  const [command, first, second] = argv;
  if (command === "copy" && first !== undefined && second !== undefined && argv.length === 3) {
    await copyPayloadSources(path.resolve(first), path.resolve(second));
    return;
  }
  if (command === "install" && first !== undefined && argv.length === 2) {
    await installPayloadIndirections(path.resolve(first));
    return;
  }
  throw new Error(usage());
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
