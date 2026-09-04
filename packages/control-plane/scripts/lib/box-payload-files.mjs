#!/usr/bin/env node

// The one source of truth for files that move with an in-place box payload.
// Archive paths always start at `rootfs/`; source paths are derived from that
// prefix except for env.defaults, which lives at the repository root.
//
// Keep this list explicit. test/box-payload-files.test.mjs discovers every
// eligible source file independently and fails when a new script is not given
// payload ownership here.

import { readFile, mkdir, copyFile, chmod, lstat, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PAYLOAD_ROOTFS_PATHS = Object.freeze([
  "etc/s6-overlay/s6-rc.d/cgroups/up",
  "etc/s6-overlay/s6-rc.d/cloudflared/run",
  "etc/s6-overlay/s6-rc.d/dockerd/run",
  "etc/s6-overlay/s6-rc.d/dufs/run",
  "etc/s6-overlay/s6-rc.d/enroll/up",
  "etc/s6-overlay/s6-rc.d/gateway/run",
  "etc/s6-overlay/s6-rc.d/init-state/up",
  "etc/s6-overlay/s6-rc.d/lody-bridge/run",
  "etc/s6-overlay/s6-rc.d/lody-daemon/run",
  "etc/s6-overlay/s6-rc.d/lody-projects/run",
  "etc/s6-overlay/s6-rc.d/lody-watchdog/run",
  "etc/s6-overlay/s6-rc.d/machine-stats/run",
  "etc/s6-overlay/s6-rc.d/register/up",
  "etc/s6-overlay/s6-rc.d/remote-control/run",
  "etc/s6-overlay/s6-rc.d/rules/up",
  "etc/s6-overlay/s6-rc.d/sshd/run",
  "etc/s6-overlay/s6-rc.d/ttyd/run",
  "etc/s6-overlay/s6-rc.d/watch/run",
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
  "usr/local/libexec/blitz-enroll",
  "usr/local/libexec/blitz-git-credential",
  "usr/local/libexec/blitz-healthcheck",
  "usr/local/libexec/blitz-init-state",
  "usr/local/libexec/blitz-lody-bridge",
  "usr/local/libexec/blitz-lody-projects",
  "usr/local/libexec/blitz-recipe-invocation",
  "usr/local/libexec/blitz-register",
  "usr/local/libexec/blitz-rules-boot",
  "usr/local/libexec/blitz-ssh-session",
  "usr/local/libexec/blitz-term",
]);

export const PAYLOAD_GENERATED_PATHS = Object.freeze([
  "rootfs/usr/local/bin/blitz-box-gateway",
  "rootfs/usr/local/bin/blitz-cred",
]);

export const PAYLOAD_FILES = Object.freeze([
  "rootfs/etc/blitz/env.defaults",
  ...PAYLOAD_ROOTFS_PATHS.map((relativePath) => `rootfs/${relativePath}`),
  ...PAYLOAD_GENERATED_PATHS,
].sort());

export const PAYLOAD_SERVICES = Object.freeze([...new Set(PAYLOAD_ROOTFS_PATHS
  .map((relativePath) =>
    /^etc\/s6-overlay\/s6-rc\.d\/([^/]+)\/(?:run|up)$/u.exec(relativePath)?.[1])
  .filter((service) => service !== undefined))].sort());

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

const SERVICE_SCRIPT_PATTERN =
  /^rootfs\/etc\/s6-overlay\/s6-rc\.d\/([^/]+)\/(?:run|up)$/u;
const LIVE_PAYLOAD_PATH_PATTERN =
  /\/(?:usr\/local\/(?:bin|libexec)|opt\/blitz\/skel|etc\/blitz)\/[A-Za-z0-9._/-]+/gu;

export function payloadSourcePath(repoRoot, archivePath) {
  if (archivePath === "rootfs/etc/blitz/env.defaults") {
    return path.join(repoRoot, "env.defaults");
  }
  if (PAYLOAD_GENERATED_PATHS.includes(archivePath)) return null;
  return path.join(repoRoot, "packages/box", archivePath);
}

export function payloadMode(archivePath) {
  if (
    archivePath.startsWith("rootfs/usr/local/bin/")
    || archivePath.startsWith("rootfs/usr/local/libexec/")
    || archivePath.endsWith("/run")
  ) return 0o755;
  return 0o644;
}

function uncommentedSource(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
}

/** Derives service -> payload dependencies from the real s6 source scripts. */
export async function readPayloadRestartMap(repoRoot) {
  const serviceScripts = PAYLOAD_FILES.filter((archivePath) =>
    SERVICE_SCRIPT_PATTERN.test(archivePath),
  );
  const sources = await Promise.all(serviceScripts.map(async (archivePath) => ({
    archivePath,
    source: uncommentedSource(await readFile(payloadSourcePath(repoRoot, archivePath), "utf8")),
  })));
  const dependencies = new Map();
  for (const { archivePath } of sources) {
    const service = SERVICE_SCRIPT_PATTERN.exec(archivePath)?.[1];
    if (service === undefined) throw new Error(`invalid payload service script: ${archivePath}`);
    dependencies.set(service, new Set([archivePath]));
  }

  for (const archivePath of PAYLOAD_FILES) {
    const overridden = PAYLOAD_SERVICE_OVERRIDES[archivePath];
    const livePath = archivePath.startsWith("rootfs/") ? archivePath.slice("rootfs".length) : null;
    const services = overridden ?? (livePath === null ? [] : sources
      .filter(({ source }) => [...source.matchAll(LIVE_PAYLOAD_PATH_PATTERN)]
        .some((match) => match[0] === livePath))
      .map(({ archivePath: scriptPath }) => SERVICE_SCRIPT_PATTERN.exec(scriptPath)?.[1])
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
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([service, paths]) => [service, [...paths].sort()]));
}

export async function copyPayloadSources(repoRoot, destination) {
  for (const archivePath of PAYLOAD_FILES) {
    const sourcePath = payloadSourcePath(repoRoot, archivePath);
    if (sourcePath === null) continue;
    const targetPath = path.join(destination, archivePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, payloadMode(archivePath));
  }
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
  for (const archivePath of PAYLOAD_FILES) {
    const targetPath = path.join(imageRoot, archivePath.slice("rootfs/".length));
    const payloadPath = `${currentRoot}/${archivePath}`;
    const serviceMatch = SERVICE_SCRIPT_PATTERN.exec(archivePath);
    if (serviceMatch === null) {
      await replaceWithSymlink(targetPath, payloadPath);
      continue;
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    const wrapper = archivePath.endsWith("/run")
      ? `#!/command/with-contenv bash\nexec ${payloadPath} "$@"\n`
      : `/command/execlineb -P ${payloadPath}\n`;
    await writeFile(targetPath, wrapper, { mode: payloadMode(archivePath) });
    await chmod(targetPath, payloadMode(archivePath));
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
