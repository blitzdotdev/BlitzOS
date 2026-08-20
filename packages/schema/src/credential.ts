export type MintKind = "app-jwt" | "oauth" | "static";

export type Custody = "cp" | "broker" | "proxy";

export type Placement =
  | { kind: "env"; name: string; value: string }
  | { kind: "file"; path: string; value: string; mode?: number }
  | { kind: "unset-env"; name: string };

/** FROZEN box wire: the Go broker baked into the shipped box image decodes
 * POST /workspaces/self/credentials with DisallowUnknownFields, so the
 * `integration` key (and mode/placements/expiresAt) must keep these exact
 * names even though the product noun is now "connection". Nothing else may
 * appear here: an extra key fails the box's decode and aborts the whole sync. */
export interface MintResult {
  integration: string;
  mode: "inject" | "proxy";
  placements: Placement[];
  expiresAt: number;
}

export type LeaseState = "active" | "revoked" | "expired";

export interface CredentialLeaseView {
  id: string;
  workspaceId: string;
  boxId: string | null;
  connection: string;
  userId: string | null;
  scopes: string[];
  mode: MintResult["mode"];
  issuedAt: number;
  expiresAt: number;
  state: LeaseState;
}

export interface ConnectionView {
  name: string;
  provider: string;
  kind: MintKind;
  custody: Custody;
  status: "active" | "revoked";
  createdBy: string;
}

export interface ListConnectionsResponse {
  connections: ConnectionView[];
}

export interface PutConnectionRequest {
  provider: string;
  kind: MintKind;
  custody: Custody;
  config: JsonObject;
  root: string;
  usable_by?: { owners: string[] } | null;
}

/** The manifest is stored verbatim in D1 (workspaces.manifest), so its
 * `integrations` key is a persisted document format, not a renameable
 * client field; it deliberately keeps the old noun. */
export interface CredentialManifest {
  integrations: Record<string, JsonObject>;
}

export interface ListCredentialLeasesResponse {
  leases: CredentialLeaseView[];
}

export interface CredentialRequestView {
  id: string;
  workspace_id: string;
  connection_name: string;
  requested_scopes: string[];
  created_at: number;
  requester: { boxId: string; userId: string } | null;
}

export interface ListCredentialRequestsResponse {
  requests: CredentialRequestView[];
}

export interface CredentialEventView {
  id: number;
  leaseId: string | null;
  event: "minted" | "revoked" | "denied" | "approved";
  detail: JsonValue | null;
  createdAt: number;
}

export interface ListCredentialEventsResponse {
  events: CredentialEventView[];
}

export interface CatalogScopeView {
  id: string;
  title: string;
  detail: string;
  default: boolean;
}

/** What the connect picker renders. Carries no secret and no binding value —
 * `oauthConfigured` is the presence answer, not the credential. */
export interface CatalogEntryView {
  id: string;
  title: string;
  summary: string;
  docsUrl: string;
  custody: Custody;
  rotation: "strict" | "graceful" | "none";
  oauthAvailable: boolean;
  oauthConfigured: boolean;
  personalTokenLabel: string | null;
  personalTokenHelp: string | null;
  /** The generic entry needs the person to name the variable and base URL. */
  needsVendorConfig: boolean;
  environmentNames: string[];
  scopes: CatalogScopeView[];
}

export interface ListCatalogResponse {
  providers: CatalogEntryView[];
}

/** One member's authorization of one provider. The token itself never leaves
 * the control plane, so no field here can carry it. */
export interface UserGrantView {
  provider: string;
  manifestId: string;
  kind: "pat" | "oauth";
  label: string | null;
  scopes: string[];
  createdAt: number;
  updatedAt: number;
  /** Access-token expiry for oauth grants; null when nothing has been minted. */
  accessExpiresAt: number | null;
}

export interface ListUserGrantsResponse {
  grants: UserGrantView[];
}

export interface PutUserGrantRequest {
  manifestId: string;
  /** Personal access token or API key. Never returned by any route. */
  token: string;
  scopes?: string[];
  label?: string;
  /** Required by the generic entry, ignored by catalog providers. */
  vendor?: {
    envName: string;
    baseUrlEnvName?: string | null;
    baseUrl?: string | null;
  };
}

export interface ProviderHealthView {
  provider: string;
  state: "healthy" | "unhealthy" | "unchecked";
  detail: string | null;
  checkedAt: number | null;
}

export interface ListProviderHealthResponse {
  providers: ProviderHealthView[];
}
import type { JsonObject, JsonValue } from "./json.js";
