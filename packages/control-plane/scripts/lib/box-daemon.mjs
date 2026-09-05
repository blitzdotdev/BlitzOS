import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const GIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
/** The stamp scripts/lody-build-package.mjs packs into every daemon tarball,
 * relative to the installed prefix. */
export const LODY_DAEMON_BUILD_STAMP = "lib/node_modules/lody/dist/BUILD.json";
/** What a daemon version stamp may look like; the manifest schema and the
 * updater's install directory both rely on it. */
export const LODY_DAEMON_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const PROTOCOL_SOURCE = "vendor/lody/packages/shared/src/local-loro-data-plane.ts";
const UPSTREAM_PIN = "vendor/lody/UPSTREAM.md";

/** The daemon's identity is the upstream commit and the built dist digest
 * (docs/LODY-MERGE.md), never the stale `apps/cli/package.json` version.
 * Twelve hex characters of each keep the token readable in a machine view
 * and distinct per build. The updater also uses it as the directory name a
 * daemon release is installed under, so it must stay a plain version token
 * (`[A-Za-z0-9][A-Za-z0-9._+-]*`). */
export function lodyDaemonVersion(stamp) {
  return `${stamp.upstreamSha.slice(0, 12)}+dist.${stamp.distSha256.slice(0, 12)}`;
}

function hash(value, pattern, label) {
  if (String(value) !== value || !pattern.test(value)) {
    throw new Error(`${label} is not a valid hash`);
  }
  return value;
}

/** The two stamp fields the daemon identity is made of. `label` names the
 * stamp's origin in errors. */
export function parseLodyDaemonBuildStamp(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || Object(parsed) !== parsed || Array.isArray(parsed)) {
    throw new Error(`${label} is not an object`);
  }
  return {
    upstreamSha: hash(parsed.upstreamSha, GIT_SHA, `${label} upstreamSha`),
    distSha256: hash(parsed.distSha256, SHA256, `${label} distSha256`),
  };
}

/** Reads the build stamp of the package installed under `prefix`. */
export async function readLodyDaemonBuildStamp(prefix) {
  const stampPath = path.join(prefix, LODY_DAEMON_BUILD_STAMP);
  let text;
  try {
    text = await readFile(stampPath, "utf8");
  } catch (error) {
    throw new Error(
      `could not read the lody build stamp at ${stampPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseLodyDaemonBuildStamp(text, stampPath);
}

/** The upstream commit `vendor/lody` is pinned to. A daemon archive built
 * from another commit does not belong to this tree. */
export async function readLodyUpstreamPin(repoRoot) {
  const upstream = await readFile(path.join(repoRoot, UPSTREAM_PIN), "utf8");
  const pinned = /\| Pinned commit \| `([a-f0-9]{40})` \|/u.exec(upstream)?.[1];
  if (pinned === undefined) {
    throw new Error(`could not read the pinned upstream commit from ${UPSTREAM_PIN}`);
  }
  return pinned;
}

/** Reads the data-plane protocol version from the source that declares it as
 * a `z.literal`, so the stamp cannot drift from the schema. */
export async function readLodyDaemonProtocolVersion(repoRoot) {
  const protocolSource = await readFile(path.join(repoRoot, PROTOCOL_SOURCE), "utf8");
  const protocolMatch =
    /export const LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION\s*=\s*([0-9]+);/u
      .exec(protocolSource);
  if (
    protocolMatch === null
    || !protocolSource.includes("z.literal(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION)")
  ) {
    throw new Error("could not read the z.literal-backed lody data-plane protocol version");
  }
  const protocolVersion = Number(protocolMatch[1]);
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion <= 0) {
    throw new Error("lody data-plane protocol version must be a positive integer");
  }
  return protocolVersion;
}

/** Everything the version stamps beside an installed daemon prefix say:
 * `repoRoot` supplies the protocol source, `prefix` the built package. */
export async function readLodyDaemonMetadata(repoRoot, prefix) {
  const [stamp, protocolVersion] = await Promise.all([
    readLodyDaemonBuildStamp(prefix),
    readLodyDaemonProtocolVersion(repoRoot),
  ]);
  return {
    upstreamSha: stamp.upstreamSha,
    distSha256: stamp.distSha256,
    version: lodyDaemonVersion(stamp),
    protocolVersion,
  };
}

export async function writeLodyDaemonVersionStamps(destination, metadata) {
  await Promise.all([
    writeFile(path.join(destination, "daemon-version"), `${metadata.version}\n`, "utf8"),
    writeFile(
      path.join(destination, "daemon-protocol-version"),
      `${metadata.protocolVersion}\n`,
      "utf8",
    ),
  ]);
}
