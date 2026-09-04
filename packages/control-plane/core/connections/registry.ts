import type {
  Connection,
  ConnectionView,
  ListConnectionsResponse,
} from "./types.js";
import type { Db } from "../db.js";
import { first, rows } from "../db.js";
import { HttpError, isRecord, isString } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { manifestBaseUrl } from "./catalog/index.js";
import type { ProviderManifest } from "./catalog/types.js";

type PlacementFill = "token" | "proxy-url";

/** An environment name a connection row delivers under, and what fills it.
 * `file` and `unset-env` kinds went with the delivery pipeline they served:
 * nothing writes a box file for a connection any more, so a stored template
 * naming one would name a delivery that cannot happen. */
interface EnvPlacementTemplate {
  kind: "env";
  name: string;
  fill?: PlacementFill;
}

interface ParsedProxyConfig {
  base_url: string;
  token_header: string;
  token_prefix: string;
}

interface ParsedStaticConfig {
  placements: EnvPlacementTemplate[];
  default_scopes?: string[];
  proxy?: ParsedProxyConfig;
}

/** The connection row is the provider *declaration*, never a secret. Stock
 * providers land here with zero ceremony the first time a member connects, so
 * every existing lease, audit, proxy, and ceiling join keeps working against
 * one table. The row used to be able to carry a sealed org root as well; that
 * slot is gone (plans/ORG-CREDENTIALS.md §6a) — an org-shared static is an
 * org credential now, and a connection row is only ever a declaration. */
export async function ensureCatalogConnection(
  db: Db,
  orgId: string,
  provider: string,
  manifest: ProviderManifest,
  principal: Principal,
  /** The org's instance URL for instance-hosted vendors (YouTrack): rides
   * `config.proxy.base_url` on the declared row so later members inherit it. */
  instanceBaseUrl: string | null = null,
  now = Date.now(),
): Promise<Connection> {
  const custody = manifest.custody;
  const placements = manifest.delivery.env.map((delivery) => ({
    kind: "env" as const,
    name: delivery.name,
    fill: delivery.fill,
  }));
  const config: ParsedStaticConfig & { manifest_id: string } = {
    manifest_id: manifest.id,
    placements,
    default_scopes: [...manifest.defaultScopes],
  };
  if (custody === "proxy") {
    // The row is where the proxy reads its destination, so a row written with
    // no destination would 502 every call. An instance-hosted vendor supplies
    // the URL from the paste; everyone else declares one on the manifest.
    config.proxy = {
      base_url: instanceBaseUrl ?? manifestBaseUrl(manifest, "proxy custody"),
      token_header: manifest.tokenHeader.name,
      token_prefix: manifest.tokenHeader.prefix,
    };
  }
  await rows(db, {
    q: `INSERT INTO connections
        (id, name, scoped_name, provider, kind, custody, config, created_by,
         created_at, revoked_at, org_id, created_by_membership_id)
        VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10)
        ON CONFLICT(org_id, scoped_name) DO UPDATE SET
          provider = excluded.provider,
          kind = excluded.kind,
          custody = excluded.custody,
          config = excluded.config,
          revoked_at = NULL`,
    v: [
      crypto.randomUUID(),
      provider,
      manifest.id,
      manifest.auth === null ? "static" : "oauth",
      custody,
      JSON.stringify(config),
      principal.id,
      now,
      orgId,
      principal.membershipId,
    ],
  });
  const connection = await connectionByName(db, provider, orgId, false);
  if (connection === null) throw new Error("catalog connection disappeared");
  return connection;
}

/** The non-secret vendor URL a proxy-custody row points at, or null. Shown to
 * members (the paste form prefills from it) and used to validate that a new
 * grant will have somewhere to resolve. */
export function connectionProxyBaseUrl(config: string): string | null {
  try {
    const value: unknown = JSON.parse(config);
    if (!isRecord(value) || !isRecord(value.proxy) || !isString(value.proxy.base_url)) {
      return null;
    }
    return new URL(value.proxy.base_url).protocol === "https:"
      ? value.proxy.base_url
      : null;
  } catch {
    return null;
  }
}

export async function connectionByName(
  db: Db,
  name: string,
  orgId: string,
  activeOnly = true,
): Promise<Connection | null> {
  return first<Connection>(db, {
    q: `SELECT id, scoped_name AS name, provider, kind, custody, config,
               created_by, created_at, revoked_at, org_id, created_by_membership_id
        FROM connections
        WHERE scoped_name = ?1 AND org_id = ?2${activeOnly ? " AND revoked_at IS NULL" : ""}
        LIMIT 1`,
    v: [name, orgId],
  });
}

export async function activeConnections(db: Db, orgId: string): Promise<Connection[]> {
  return rows<Connection>(db, {
    q: `SELECT id, scoped_name AS name, provider, kind, custody, config,
               created_by, created_at, revoked_at, org_id, created_by_membership_id
        FROM connections
        WHERE org_id = ?1 AND revoked_at IS NULL ORDER BY created_at, scoped_name`,
    v: [orgId],
  });
}

/** The org's connection rows, read-only. The admin write routes that used to
 * sit beside this (`PUT`/`DELETE /connections/:name`) existed to store and
 * revoke an org root; with that slot gone they had no purpose left, and rows
 * are declared by member connects alone. */
export function addConnectionRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  const listConnections = async (context: CoreContext) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const connections = await rows<
      Pick<Connection, "name" | "provider" | "kind" | "custody" | "config" | "revoked_at" | "created_by">
    >(runtimeFactory(context).db, {
      q: `SELECT scoped_name AS name, provider, kind, custody, config, revoked_at, created_by
          FROM connections WHERE org_id = ?1 ORDER BY created_at, scoped_name`,
      v: [principal.orgId],
    });
    const response: ListConnectionsResponse = {
      connections: connections.map((connection): ConnectionView => ({
        name: connection.name,
        provider: connection.provider,
        kind: connection.kind,
        custody: connection.custody,
        status: connection.revoked_at === null ? "active" : "revoked",
        createdBy: connection.created_by,
        // The vendor URL only, never the config itself: the paste form
        // prefills the instance URL for members from this.
        proxyBaseUrl: connectionProxyBaseUrl(connection.config),
      })),
    };
    return context.json(response);
  };

  router.get("/connections", listConnections);
  // Alias path: the subsystem was called "integrations" before the rename.
  // Old bookmarks and scripts keep working; the same handler serves both.
  router.get("/integrations", listConnections);
}
