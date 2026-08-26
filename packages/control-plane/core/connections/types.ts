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

/** What a minter hands back. Everything beyond `MintResult` is control-plane
 * bookkeeping that `mintOne` consumes and strips before serialization — it can
 * never ride the frozen wire. */
export interface MinterResult extends MintResult {
  tokenHash?: string;
  grantedScopes?: string[];
}

export interface Connection {
  id: string;
  name: string;
  provider: string;
  kind: MintKind;
  custody: Custody;
  config: string;
  root_ciphertext: string | null;
  usable_by: string | null;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  org_id: string | null;
  created_by_membership_id: string | null;
}

export interface MintRequest {
  workspaceId: string;
  /** The box that asked, or null when a person did: the webApp mints a lease
   * from the connect grid and no box is involved in that click. */
  boxId: string | null;
  principalId: string;
  scopes: string[];
  now: number;
  origin: string;
  leaseId: string;
}

export interface Minter {
  kind: MintKind;
  providers?: string[];
  mint(
    root: string | null,
    connection: Connection,
    request: MintRequest,
  ): Promise<MinterResult>;
}

export interface Lease {
  id: string;
  workspaceId: string;
  boxId: string | null;
  connection: string;
  userId: string | null;
  scopes: string[];
  mode: "inject" | "proxy";
  issuedAt: number;
  expiresAt: number;
  state: "active" | "revoked" | "expired";
}

/** One org connection row as `GET /connections` lists it. */
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
   * deployment has not named an app. */
  platformAppInstallUrl: string | null;
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

export interface ProviderHealthView {
  provider: string;
  state: "healthy" | "unhealthy" | "unchecked";
  detail: string | null;
  checkedAt: number | null;
  /** Round trip of the last probe. Null when nothing has been checked, or
   * when the probe never left — no token to present is not a slow vendor. */
  latencyMs: number | null;
}
