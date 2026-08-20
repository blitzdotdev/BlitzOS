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
  boxId: string;
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
