import type { Placement } from "../types.js";
import type {
  ProviderEnvSurface,
  ProviderManifest,
  SurfaceInput,
  SurfaceOverrides,
} from "./types.js";

/** The shipped box image sets HOME here (packages/box/Dockerfile). File
 * placements are written verbatim — the box does no `~` expansion — so the
 * catalog's home-relative surface paths are resolved against this constant. */
export const BOX_HOME = "/var/lib/blitz/home";

/** Phase B reads this path; Phase A only renders the entry into the skill so
 * an agent can wire the server itself. Named here so both phases agree. */
export const BOX_MCP_PATH = "/var/lib/blitz/connections/mcp.json";

const SKILL_MODE = 0o600;

function envSurfaces(
  manifest: ProviderManifest,
  overrides: SurfaceOverrides | null,
): ProviderEnvSurface[] {
  if (overrides === null) return [...manifest.surfaces.env];
  const surfaces: ProviderEnvSurface[] = [
    { name: overrides.envName, fill: "token" },
  ];
  if (overrides.baseUrlEnvName !== null) {
    surfaces.push({ name: overrides.baseUrlEnvName, fill: "proxy-url" });
  }
  return surfaces;
}

function baseUrlFor(input: SurfaceInput, manifest: ProviderManifest): string {
  if (input.mode === "proxy") return input.proxyUrl;
  return input.overrides?.baseUrl ?? manifest.baseUrl;
}

export function skillPath(manifest: ProviderManifest, connection: string): string {
  return `${BOX_HOME}/${manifest.surfaces.skill.path.replace("<provider>", connection)}`;
}

/** Escaped by hand: the file is a JSON document the box writes verbatim, and
 * core may not pull a serializer dependency for three fields. */
export function renderMcpEntry(
  manifest: ProviderManifest,
  input: SurfaceInput,
): string {
  const server = manifest.surfaces.mcp;
  const entry =
    server.transport === "http"
      ? { type: "http", url: server.url, headers: { Authorization: `${manifest.tokenHeader.prefix}${input.token}` } }
      : { type: "stdio", command: server.command, args: [...server.args], env: Object.fromEntries(server.envFrom.map((name) => [name, `\${${name}}`])) };
  return JSON.stringify({ mcpServers: { [server.name]: entry } }, null, 2);
}

/** Everything a lease delivers beyond the raw credential, compiled into the
 * frozen `placements` array. No top-level mint-response key is ever added:
 * the shipped box decodes with DisallowUnknownFields. */
export function compileSurfaces(
  manifest: ProviderManifest,
  input: SurfaceInput,
): Placement[] {
  const placements: Placement[] = [];
  const baseUrl = baseUrlFor(input, manifest);
  const surfaces = envSurfaces(manifest, input.overrides);
  for (const surface of surfaces) {
    placements.push({
      kind: "env",
      name: surface.name,
      value: surface.fill === "proxy-url" ? baseUrl : input.token,
    });
  }
  const tokenEnv = surfaces.find((surface) => surface.fill === "token");
  const baseUrlEnv = surfaces.find((surface) => surface.fill === "proxy-url");
  placements.push({
    kind: "file",
    path: skillPath(manifest, input.connection),
    value: manifest.surfaces.skill.render({
      connection: input.connection,
      scopes: input.scopes,
      mode: input.mode,
      tokenEnv: tokenEnv?.name ?? "BLITZ_CONNECTION_TOKEN",
      baseUrlEnv: baseUrlEnv?.name ?? null,
      baseUrl,
      tokenHeader: input.tokenHeader,
    }),
    mode: SKILL_MODE,
  });
  return placements;
}

/** Revocation symmetry, Phase A: the running box image has no `remove-file`
 * placement, so a dead connection's surfaces are overwritten empty and its
 * environment names are unset. A stale skill for a dead connection would
 * gaslight the agent into retrying a credential that no longer exists. */
export function tombstoneSurfaces(
  manifest: ProviderManifest,
  connection: string,
  overrides: SurfaceOverrides | null,
): Placement[] {
  const placements: Placement[] = [];
  for (const surface of envSurfaces(manifest, overrides)) {
    placements.push({ kind: "unset-env", name: surface.name });
  }
  placements.push({
    kind: "file",
    path: skillPath(manifest, connection),
    value: "",
    mode: SKILL_MODE,
  });
  return placements;
}
