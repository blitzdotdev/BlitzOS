import { HttpError, isRecord, isString } from "../http.js";
import type { Connection } from "./types.js";

/** The manifest is stored verbatim in D1 (workspaces.manifest), so its
 * `integrations` key is a persisted document format, not a renameable client
 * field; it deliberately keeps the old noun. */
type CredentialManifest = {
  integrations: Record<string, Record<string, unknown>>;
};

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
  const integrations: Record<string, Record<string, unknown>> = {};
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

function parsedStoredManifest(value: string): CredentialManifest | null {
  try {
    return parseManifest(JSON.parse(value));
  } catch {
    return null;
  }
}

export function manifestAllows(
  storedManifest: string | null,
  connectionName: string,
  requestedScopes: readonly string[],
): boolean {
  if (storedManifest === null) return true;
  const manifest = parsedStoredManifest(storedManifest);
  if (manifest === null) return false;
  const ceiling = manifest.integrations[connectionName];
  if (ceiling === undefined) return false;
  if (ceiling.scopes === undefined) return true;
  if (!stringArray(ceiling.scopes)) return false;
  const allowed = new Set(ceiling.scopes);
  return requestedScopes.every((scope) => allowed.has(scope));
}

export function usableByAllows(
  connection: Connection,
  principalId: string,
): boolean {
  if (connection.usable_by === null) return true;
  try {
    const value: unknown = JSON.parse(connection.usable_by);
    return (
      isRecord(value) &&
      stringArray(value.owners) &&
      value.owners.includes(principalId)
    );
  } catch {
    return false;
  }
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
