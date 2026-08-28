import type { Db } from "./db.js";
import { rows } from "./db.js";
import {
  CloudflareTunnels,
  type SurfaceCleanupResult,
} from "./compute/cloudflare-tunnels.js";
import type { Fetcher } from "./compute/json-fetch.js";
import type { WebAppPort } from "./compute/types.js";
import { WEBAPP_TOKEN_HEADER, WorkspaceWebAppAuth } from "./webapp-tickets.js";

export { WEBAPP_TOKEN_HEADER } from "./webapp-tickets.js";

export interface WorkspaceTunnelsEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
  WORKSPACE_TUNNEL_ZONE?: string;
  CLOUDFLARE_API_TOKEN?: string;
  WEBAPP_TOKEN_SECRET?: string;
}

export interface WorkspaceTunnelRow {
  id: string;
  tunnel_id: string | null;
  tunnel_hostname: string | null;
  dns_record_id: string | null;
}

export interface ProvisionedTunnel {
  workspaceId: string;
  hostname: string;
  tunnelToken: string;
  webAppToken: string;
}

/** Per-workspace tunnels for providers that cannot proxy their own
 * webApp endpoints (cloud VMs). Everything Cloudflare-specific stays behind this
 * module. */
export class WorkspaceTunnels {
  private readonly client: CloudflareTunnels;
  private readonly zone: string;
  private readonly auth: WorkspaceWebAppAuth;
  private readonly fetcher: Fetcher;

  constructor(
    client: CloudflareTunnels,
    zone: string,
    webAppTokenSecret: string,
    fetcher: Fetcher = fetch,
  ) {
    this.client = client;
    this.zone = zone;
    this.auth = new WorkspaceWebAppAuth(webAppTokenSecret);
    this.fetcher = fetcher;
  }

  hostnameFor(workspaceId: string): string {
    return `ws-${workspaceId}.${this.zone}`;
  }

  async webAppTokenFor(workspaceId: string): Promise<string> {
    return this.auth.tokenFor(workspaceId);
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
          SET tunnel_id = ?1, tunnel_hostname = ?2, dns_record_id = ?3,
              updated_at = ?4
          WHERE id = ?5`,
      v: [created.tunnelId, hostname, created.dnsRecordId, Date.now(), workspaceId],
    });
    return {
      workspaceId,
      hostname,
      tunnelToken: created.tunnelToken,
      webAppToken: await this.webAppTokenFor(workspaceId),
    };
  }

  /** Deletes tunnel resources, clearing each column only after its
   * confirmed deletion. Never throws, like the client it wraps: callers log
   * the returned errors, and anything left behind stays on the row for the
   * janitor to retry. */
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
      assignments.push("tunnel_id = NULL", "tunnel_hostname = NULL");
    }
    if (assignments.length > 0) {
      try {
        await rows(db, {
          q: `UPDATE workspaces SET ${assignments.join(", ")}, updated_at = ?1
              WHERE id = ?2`,
          v: [Date.now(), row.id],
        });
      } catch (error) {
        // The client never throws and neither may this, because destroy calls
        // cleanup AFTER the VM is gone: a throw here answered 500 for work
        // that had already half-succeeded irreversibly, and left the caller
        // with no way to tell that from a destroy which did nothing.
        //
        // Not clearing the columns is the safe half of this failure. Both
        // deletes tolerate an already-deleted resource, so the janitor's retry
        // is a no-op against Cloudflare and clears the columns then.
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  }

  /** Proxies one webapp request through the workspace tunnel. Port 7444
   * maps to the gateway's /acp prefix; 7445 passes through unchanged. */
  async proxy(
    hostname: string,
    workspaceId: string,
    port: WebAppPort,
    pathAndQuery: string,
    request: Request,
    credential?: string,
  ): Promise<Response> {
    const upstreamPath = port === 7444 ? `/acp${pathAndQuery}` : pathAndQuery;
    const headers = new Headers(request.headers);
    headers.delete("Cookie");
    headers.delete("Host");
    headers.delete("Authorization");
    headers.set(WEBAPP_TOKEN_HEADER, credential ?? await this.webAppTokenFor(workspaceId));
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
  const zone = env.WORKSPACE_TUNNEL_ZONE ?? "";
  const apiToken = env.CLOUDFLARE_API_TOKEN ?? "";
  const secret = env.WEBAPP_TOKEN_SECRET ?? "";
  if (accountId === "" || zoneId === "" || zone === "" || apiToken === "" || secret === "") {
    return undefined;
  }
  return new WorkspaceTunnels(
    new CloudflareTunnels({ accountId, zoneId, apiToken }),
    zone,
    secret,
  );
}
