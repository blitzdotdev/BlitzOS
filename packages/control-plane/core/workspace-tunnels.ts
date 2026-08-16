import type { Db } from "./db.js";
import { rows } from "./db.js";
import {
  CloudflareTunnels,
  type SurfaceCleanupResult,
} from "./providers/cloudflare-tunnels.js";
import type { Fetcher } from "./providers/json-fetch.js";
import type { SurfacePort } from "./providers/types.js";

export const SURFACE_TOKEN_HEADER = "X-Blitz-Surface-Token";

export interface WorkspaceTunnelsEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
  WORKSPACE_SURFACE_ZONE?: string;
  CLOUDFLARE_API_TOKEN?: string;
  SURFACE_TOKEN_SECRET?: string;
}

export interface WorkspaceTunnelRow {
  id: string;
  tunnel_id: string | null;
  surface_hostname: string | null;
  dns_record_id: string | null;
}

export interface ProvisionedTunnel {
  hostname: string;
  tunnelToken: string;
  surfaceToken: string;
}

/** Per-workspace tunnels for providers that cannot proxy their own
 * surfaces (cloud VMs). Everything Cloudflare-specific stays behind this
 * module. */
export class WorkspaceTunnels {
  private readonly client: CloudflareTunnels;
  private readonly zone: string;
  private readonly secret: string;
  private readonly fetcher: Fetcher;

  constructor(
    client: CloudflareTunnels,
    zone: string,
    surfaceTokenSecret: string,
    fetcher: Fetcher = fetch,
  ) {
    this.client = client;
    this.zone = zone;
    this.secret = surfaceTokenSecret;
    this.fetcher = fetcher;
  }

  hostnameFor(workspaceId: string): string {
    return `ws-${workspaceId}.${this.zone}`;
  }

  async surfaceTokenFor(workspaceId: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(workspaceId),
    );
    return btoa(String.fromCharCode(...new Uint8Array(mac)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  }

  /** Creates tunnel + DNS for the workspace and persists the identifiers on
   * its row immediately, so a later crash can never orphan them. */
  async provision(db: Db, workspaceId: string): Promise<ProvisionedTunnel> {
    const hostname = this.hostnameFor(workspaceId);
    const created = await this.client.createForWorkspace(
      `ws-${workspaceId}`,
      hostname,
    );
    await rows(db, {
      q: `UPDATE workspaces
          SET tunnel_id = ?1, surface_hostname = ?2, dns_record_id = ?3,
              updated_at = ?4
          WHERE id = ?5`,
      v: [created.tunnelId, hostname, created.dnsRecordId, Date.now(), workspaceId],
    });
    return {
      hostname,
      tunnelToken: created.tunnelToken,
      surfaceToken: await this.surfaceTokenFor(workspaceId),
    };
  }

  /** Deletes surface resources, clearing each column only after its
   * confirmed deletion. Callers log the returned errors; anything left
   * behind stays on the row for the janitor to retry. */
  async cleanup(db: Db, row: WorkspaceTunnelRow): Promise<SurfaceCleanupResult> {
    if (row.tunnel_id === null && row.dns_record_id === null) {
      return { dnsDeleted: true, tunnelDeleted: true, errors: [] };
    }
    const result: SurfaceCleanupResult = await this.client.cleanup(
      row.tunnel_id,
      row.dns_record_id,
    );
    const assignments: string[] = [];
    if (result.dnsDeleted) assignments.push("dns_record_id = NULL");
    if (result.tunnelDeleted) {
      assignments.push("tunnel_id = NULL", "surface_hostname = NULL");
    }
    if (assignments.length > 0) {
      await rows(db, {
        q: `UPDATE workspaces SET ${assignments.join(", ")}, updated_at = ?1
            WHERE id = ?2`,
        v: [Date.now(), row.id],
      });
    }
    return result;
  }

  /** Proxies one surface request through the workspace tunnel. Port 7444
   * maps to the gateway's /acp prefix; 7445 passes through unchanged. */
  async proxy(
    hostname: string,
    workspaceId: string,
    port: SurfacePort,
    pathAndQuery: string,
    request: Request,
  ): Promise<Response> {
    const upstreamPath = port === 7444 ? `/acp${pathAndQuery}` : pathAndQuery;
    const headers = new Headers(request.headers);
    headers.delete("Cookie");
    headers.delete("Host");
    headers.delete("Authorization");
    headers.set(SURFACE_TOKEN_HEADER, await this.surfaceTokenFor(workspaceId));
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const fetcher = this.fetcher;
    return fetcher(`https://${hostname}${upstreamPath}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      signal: request.signal,
    });
  }
}

export function workspaceTunnelsFromEnv(
  env: WorkspaceTunnelsEnv,
): WorkspaceTunnels | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const zoneId = env.CLOUDFLARE_ZONE_ID ?? "";
  const zone = env.WORKSPACE_SURFACE_ZONE ?? "";
  const apiToken = env.CLOUDFLARE_API_TOKEN ?? "";
  const secret = env.SURFACE_TOKEN_SECRET ?? "";
  if (accountId === "" || zoneId === "" || zone === "" || apiToken === "" || secret === "") {
    return undefined;
  }
  return new WorkspaceTunnels(
    new CloudflareTunnels({ accountId, zoneId, apiToken }),
    zone,
    secret,
  );
}
