import { readFile } from "node:fs/promises";
import path from "node:path";

// This is a release serial, not a count of patch scripts. Bump it whenever the
// installed daemon bytes change without an upstream npm version bump.
export const LODY_PATCHSET_SERIAL = 3;

export async function readLodyDaemonMetadata(repoRoot) {
  const [upstream, protocolSource] = await Promise.all([
    readFile(path.join(repoRoot, "vendor/lody/UPSTREAM.md"), "utf8"),
    readFile(
      path.join(repoRoot, "vendor/lody/packages/shared/src/local-loro-data-plane.ts"),
      "utf8",
    ),
  ]);
  const npmVersion = /\| npm `lody` \(daemon\) \| ([0-9]+\.[0-9]+\.[0-9]+) \|/u
    .exec(upstream)?.[1];
  if (npmVersion === undefined) {
    throw new Error("could not read the lody npm version from vendor/lody/UPSTREAM.md");
  }
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
  return {
    npmVersion,
    version: `${npmVersion}+blitz.${LODY_PATCHSET_SERIAL}`,
    protocolVersion,
  };
}

