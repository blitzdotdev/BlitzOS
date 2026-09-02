import { HttpError, isRecord, isString, type JsonObject } from "../http.js";
import type { Connection } from "./types.js";

/** The manifest is stored verbatim in D1 (workspaces.manifest), so its
 * `integrations` key is a persisted document format, not a renameable client
 * field; it deliberately keeps the old noun. */
export interface CredentialManifest {
  integrations: Record<string, JsonObject>;
}

/** Scope lists reach this module as JSON arrays out of D1 — on grants, on
 * leases, on requests. Unreadable stored data grants nothing, which is the
 * direction a credential system is allowed to fail in. */
export function scopesFromJson(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((scope) => isString(scope))
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isString(item) && item.length > 0)
  );
}

export function parseManifest(value: unknown): CredentialManifest {
  if (!isRecord(value) || !isRecord(value.integrations)) {
    throw new HttpError(400, "manifest.integrations must be an object");
  }
  const integrations: CredentialManifest["integrations"] = {};
  for (const [name, ceiling] of Object.entries(value.integrations)) {
    if (name.length === 0 || !isRecord(ceiling)) {
      throw new HttpError(400, "each manifest integration must be an object");
    }
    if (ceiling.scopes !== undefined && !stringArray(ceiling.scopes)) {
      throw new HttpError(400, "manifest integration scopes must be strings");
    }
    integrations[name] = ceiling;
  }
  return { integrations };
}

export function manifestJson(value: unknown): string {
  parseManifest(value);
  return JSON.stringify(value);
}

/** Per-workspace enablement maps onto the ceiling primitive that already
 * exists: a grant must not flow into every workspace its owner has just
 * because they hold it. An explicit ceiling wins on conflict — the provision
 * list can only enable what the ceiling already allows.
 *
 * Every workspace gets a manifest, including a workspace made with no template
 * and no named connections. That workspace allows nothing, which is the honest
 * statement of what it was asked for. Writing NULL instead is what made a bare
 * workspace allow every provider its owner had ever authorized. */
export function enablementManifestJson(
  ceiling: CredentialManifest | undefined,
  connections: readonly string[],
): string {
  if (ceiling !== undefined) return manifestJson(ceiling);
  const manifest: CredentialManifest = { integrations: {} };
  for (const name of connections) manifest.integrations[name] = {};
  return JSON.stringify(manifest);
}

function parsedStoredManifest(value: string): CredentialManifest | null {
  try {
    return parseManifest(JSON.parse(value));
  } catch {
    return null;
  }
}

/** The stored ceiling, or an empty one. A NULL column and an unreadable
 * document both mean the same thing here: this workspace allows nothing. */
function ceilingOrEmpty(storedManifest: string | null): CredentialManifest {
  if (storedManifest === null) return { integrations: {} };
  return parsedStoredManifest(storedManifest) ?? { integrations: {} };
}

/** Connect, applied to one workspace. An entry that is already there keeps its
 * scope ceiling: a template that stipulated a narrow list must not be widened
 * by a click that only meant "turn this on here". */
export function manifestWithConnection(
  storedManifest: string | null,
  connectionName: string,
): string {
  const manifest = ceilingOrEmpty(storedManifest);
  manifest.integrations[connectionName] ??= {};
  return JSON.stringify(manifest);
}

/** Disconnect, applied to one workspace. The member's grant is untouched, so
 * their other workspaces keep working; this workspace stops being allowed to
 * ask, which is what the next pull checks. */
export function manifestWithoutConnection(
  storedManifest: string | null,
  connectionName: string,
): string {
  const manifest = ceilingOrEmpty(storedManifest);
  delete manifest.integrations[connectionName];
  return JSON.stringify(manifest);
}

/** Connection names a stored ceiling enables; [] for null or unreadable.
 * This is the workspace's stipulated set — what the template named plus what
 * the create request added — independent of whether anything minted yet. */
export function manifestConnectionNames(storedManifest: string | null): string[] {
  if (storedManifest === null) return [];
  const manifest = parsedStoredManifest(storedManifest);
  return manifest === null ? [] : Object.keys(manifest.integrations);
}

/** The gate every pull passes. A workspace allows a provider only when its own
 * manifest names it.
 *
 * A NULL column denies. It used to allow everything, and that default is what
 * a workspace created before this column existed still carries: a box in one
 * such workspace could mint any provider its owner had ever authorized, in a
 * workspace nobody ever connected that provider to. Denying is also what makes
 * Disconnect mean something — removing the last entry leaves `{}`, and `{}`
 * has to refuse. */
export function manifestAllows(
  storedManifest: string | null,
  connectionName: string,
  requestedScopes: readonly string[],
): boolean {
  if (storedManifest === null) return false;
  const manifest = parsedStoredManifest(storedManifest);
  if (manifest === null) return false;
  const ceiling = manifest.integrations[connectionName];
  if (ceiling === undefined) return false;
  if (ceiling.scopes === undefined) return true;
  if (!stringArray(ceiling.scopes)) return false;
  const allowed = new Set(ceiling.scopes);
  return requestedScopes.every((scope) => allowed.has(scope));
}

export function connectionDefaultScopes(connection: Connection): string[] {
  try {
    const value: unknown = JSON.parse(connection.config);
    if (!isRecord(value) || value.default_scopes === undefined) return [];
    return stringArray(value.default_scopes) ? value.default_scopes : [];
  } catch {
    return [];
  }
}
