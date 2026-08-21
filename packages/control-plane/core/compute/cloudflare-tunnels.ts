import { isNumber, isRecord, isString } from "../http.js";
import { fetchBoundedJson, type Fetcher, type JsonValue } from "./json-fetch.js";

const API = "https://api.cloudflare.com/client/v4";
const ERROR_MESSAGE_MAX_LENGTH = 300;

export interface CloudflareTunnelsOptions {
  accountId: string;
  zoneId: string;
  apiToken: string;
  fetcher?: Fetcher;
}

export interface CreatedTunnel {
  tunnelId: string;
  dnsRecordId: string;
  tunnelToken: string;
}

export interface SurfaceCleanupResult {
  dnsDeleted: boolean;
  tunnelDeleted: boolean;
  errors: string[];
}

function cloudflareErrorMessage(body: JsonValue | null): string | null {
  if (!isRecord(body) || !Array.isArray(body.errors)) return null;
  const parts: string[] = [];
  for (const error of body.errors) {
    if (!isRecord(error)) continue;
    const code = isNumber(error.code) ? `${error.code}: ` : "";
    if (isString(error.message)) parts.push(`${code}${error.message}`);
  }
  if (parts.length === 0) return null;
  return parts.join("; ").slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

function resultRecord(body: JsonValue | null): Record<string, JsonValue> {
  if (isRecord(body) && isRecord(body.result)) return body.result;
  return {};
}

export class CloudflareTunnels {
  private readonly accountId: string;
  private readonly zoneId: string;
  private readonly apiToken: string;
  private readonly fetcher: Fetcher;

  constructor(options: CloudflareTunnelsOptions) {
    if (options.accountId === "") throw new Error("Cloudflare account id is required");
    if (options.zoneId === "") throw new Error("Cloudflare zone id is required");
    if (options.apiToken === "") throw new Error("Cloudflare API token is required");
    this.accountId = options.accountId;
    this.zoneId = options.zoneId;
    this.apiToken = options.apiToken;
    this.fetcher = options.fetcher ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    body?: JsonValue,
    tolerate404 = false,
  ): Promise<JsonValue | null> {
    const headers = new Headers({ Authorization: `Bearer ${this.apiToken}` });
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }
    const { response, body: parsed } = await fetchBoundedJson(
      this.fetcher,
      `${API}${path}`,
      init,
      {
        responseLabel: "Cloudflare",
        bodyDisposition: () => "read",
        invalidJsonDisposition: () => "provider-error",
      },
    );
    if (tolerate404 && response.status === 404) return null;
    if (!response.ok) {
      const message = cloudflareErrorMessage(parsed);
      throw new Error(
        message === null
          ? `Cloudflare API request failed with status ${response.status}`
          : `Cloudflare API: ${message}`,
      );
    }
    return parsed;
  }

  /** Creates the tunnel, its ingress to the box gateway, and the proxied
   * DNS record for one workspace, returning every identifier plus the run
   * token the box needs. */
  async createForWorkspace(name: string, hostname: string): Promise<CreatedTunnel> {
    const created = resultRecord(
      await this.request("POST", `/accounts/${this.accountId}/cfd_tunnel`, {
        name,
        config_src: "cloudflare",
      }),
    );
    const tunnelId = created.id;
    if (!isString(tunnelId) || tunnelId === "") {
      throw new Error("Cloudflare tunnel create returned no tunnel id");
    }
    await this.request(
      "PUT",
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/configurations`,
      {
        config: {
          ingress: [
            { hostname, service: "http://127.0.0.1:7445" },
            { service: "http_status:404" },
          ],
        },
      },
    );
    const record = resultRecord(
      await this.request("POST", `/zones/${this.zoneId}/dns_records`, {
        type: "CNAME",
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
      }),
    );
    const dnsRecordId = record.id;
    if (!isString(dnsRecordId) || dnsRecordId === "") {
      throw new Error("Cloudflare DNS create returned no record id");
    }
    const token = await this.request(
      "GET",
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/token`,
    );
    const tunnelToken = isRecord(token) ? token.result : null;
    if (!isString(tunnelToken) || tunnelToken === "") {
      throw new Error("Cloudflare tunnel token response was not a string");
    }
    return { tunnelId, dnsRecordId, tunnelToken };
  }

  /** Deletes both tunnel resources, tolerating already-deleted ones.
   * Never throws: the caller decides what a partial failure means. */
  async cleanup(
    tunnelId: string | null,
    dnsRecordId: string | null,
  ): Promise<SurfaceCleanupResult> {
    const result: SurfaceCleanupResult = {
      dnsDeleted: dnsRecordId === null,
      tunnelDeleted: tunnelId === null,
      errors: [],
    };
    if (dnsRecordId !== null) {
      try {
        await this.request(
          "DELETE",
          `/zones/${this.zoneId}/dns_records/${dnsRecordId}`,
          undefined,
          true,
        );
        result.dnsDeleted = true;
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (tunnelId !== null) {
      try {
        await this.request(
          "DELETE",
          `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}?cascade=true`,
          undefined,
          true,
        );
        result.tunnelDeleted = true;
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  }
}
