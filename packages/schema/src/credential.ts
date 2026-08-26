export type MintKind = "app-jwt" | "oauth" | "static";

/** Where the real credential sits while a workspace uses it: `cp` injects
 * it into the box, `proxy` keeps it in the control plane and hands the box a
 * lease token instead. */
export type Custody = "cp" | "proxy";

/** Bearer material is not always a Bearer: Linear personal API keys go in a
 * raw `Authorization: <key>` header, so the prefix belongs to the provider. */
export interface TokenHeader {
  name: string;
  prefix: string;
}

/** One environment name a provider's own tooling reads, already filled. `gh`
 * reads `GH_TOKEN` and no other name, so the box has to be told the name to
 * print. The box prints these and stores none of them. */
export interface ConnectionEnv {
  name: string;
  value: string;
}

/** What one pull answers with. The agent asks at the moment of use, so this
 * body is read once and never written to disk: `blitz-cred get` prints
 * `token`, and `blitz-cred env` prints `env`. */
export interface MintResult {
  connection: string;
  mode: "inject" | "proxy";
  /** The value the agent presents to the vendor. */
  token: string;
  env: ConnectionEnv[];
  header: TokenHeader;
  expiresAt: number;
}

/** The providers one workspace may pull. This is the workspace manifest, read
 * live: `blitz-cred list` prints one name per line. */
export interface WorkspaceConnectionsResponse {
  connections: string[];
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

/** An env entry for `config.placements` on `PUT /connections/:id`, sent by
 * the admin form verbatim. Distinct from `ConnectionEnv`: this is a template
 * with a fill, not a filled value. */
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
  /** The GitHub App shape: non-null when the form collects an app id and an
   * installation id beside the PEM private key, and the PUT goes out as
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
  custody: Custody;
  oauthAvailable: boolean;
  oauthConfigured: boolean;
  personalTokenLabel: string | null;
  personalTokenHelp: string | null;
  /** Non-null when the paste form also collects an instance URL (YouTrack).
   * Prefilled and locked from the org connection row when one carries it. */
  personalTokenBaseUrlLabel: string | null;
  /** Non-null for providers an org admin configures once, org-wide. */
  adminForm: CatalogAdminFormView | null;
  /** Where an admin installs the deployment's own app for this provider,
   * instead of registering one and pasting its private key. Null when the
   * deployment has not named an app, which is every self-hosted install by
   * default — the bring-your-own path stays the only one there. */
  platformAppInstallUrl: string | null;
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
  label?: string;
  /** Instance-hosted providers (YouTrack) name the instance the token belongs
   * to. Every other catalog provider ignores it. */
  vendor?: {
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
