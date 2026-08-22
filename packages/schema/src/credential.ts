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
  /** The vendor URL a proxy-custody row points at (the org's YouTrack
   * instance, say); null for cp custody. Never any other part of the config. */
  proxyBaseUrl: string | null;
  /** True when the row seals an org credential (an admin-stored root). A row
   * declared by a member connect carries no root and reads false, so
   * "configured" surfaces never mistake a declaration for a credential. */
  orgCredential: boolean;
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

/** What connecting a provider from the webApp hands back: the lease that is
 * now live in the workspace. */
export interface MintWorkspaceConnectionResponse {
  lease: CredentialLeaseView;
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

/** An env entry for `config.placements` on `PUT /connections/:id`, sent by
 * the admin form verbatim. Distinct from `Placement`: this is a template with
 * a fill, not a filled value. */
export interface CatalogAdminPlacement {
  kind: "env";
  name: string;
  fill: "token" | "proxy-url";
}

/** How the admin form configures an org-custody provider: labels for the
 * form plus exactly what the PUT body needs. Carries no secret. */
export interface CatalogAdminFormView {
  rootLabel: string;
  rootHelp: string;
  placements: CatalogAdminPlacement[];
  /** Present exactly when custody is "proxy": the collected URL becomes
   * `config.proxy.base_url` and the header pair rides along unchanged. */
  proxy: { baseUrlLabel: string; tokenHeader: string; tokenPrefix: string } | null;
  /** The GitHub App shape: non-null when the form collects an app id and an
   * installation id beside the PKCS#8 private key, and the PUT goes out as
   * kind "app-jwt" instead of a static root. Coexists with member OAuth —
   * grants win at mint, the app credential is the org fallback. */
  app: { appIdLabel: string; installationIdLabel: string } | null;
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
  /** Non-null when the paste form also collects an instance URL (YouTrack).
   * Prefilled and locked from the org connection row when one carries it. */
  personalTokenBaseUrlLabel: string | null;
  /** The generic entry needs the person to name the variable and base URL. */
  needsVendorConfig: boolean;
  /** Non-null for providers an org admin configures once, org-wide. */
  adminForm: CatalogAdminFormView | null;
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
  /** The generic entry requires `envName` (and may name a base URL);
   * instance-hosted catalog providers (YouTrack) take `baseUrl` alone. Other
   * catalog providers ignore it. */
  vendor?: {
    envName?: string;
    baseUrlEnvName?: string | null;
    baseUrl?: string | null;
  };
}

export interface ProviderHealthView {
  provider: string;
  state: "healthy" | "unhealthy" | "unchecked";
  detail: string | null;
  checkedAt: number | null;
  /** Round trip of the last probe. Null when nothing has been checked, or
   * when the probe never left — no token to present is not a slow vendor. */
  latencyMs: number | null;
}

export interface ListProviderHealthResponse {
  providers: ProviderHealthView[];
}
import type { JsonObject, JsonValue } from "./json.js";
