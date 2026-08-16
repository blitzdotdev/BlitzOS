export type MintKind = "app-jwt" | "oauth" | "static";

export type Custody = "cp" | "broker" | "proxy";

export type Placement =
  | { kind: "env"; name: string; value: string }
  | { kind: "file"; path: string; value: string; mode?: number }
  | { kind: "unset-env"; name: string };

export interface MintResult {
  integration: string;
  mode: "inject" | "proxy";
  placements: Placement[];
  expiresAt: number;
  grantedScopes?: string[];
}

export interface MinterResult extends MintResult {
  tokenHash?: string;
}

export interface Integration {
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
    integration: Integration,
    request: MintRequest,
  ): Promise<MinterResult>;
}

export interface Lease {
  id: string;
  workspaceId: string;
  boxId: string | null;
  integration: string;
  userId: string | null;
  scopes: string[];
  mode: "inject" | "proxy";
  issuedAt: number;
  expiresAt: number;
  state: "active" | "revoked" | "expired";
}
