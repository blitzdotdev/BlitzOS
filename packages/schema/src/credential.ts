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

export type LeaseState = "active" | "revoked" | "expired";

export interface CredentialLeaseView {
  id: string;
  workspaceId: string;
  boxId: string | null;
  integration: string;
  userId: string | null;
  scopes: string[];
  mode: MintResult["mode"];
  issuedAt: number;
  expiresAt: number;
  state: LeaseState;
}

export interface IntegrationView {
  name: string;
  provider: string;
  kind: MintKind;
  custody: Custody;
  status: "active" | "revoked";
}

export interface ListIntegrationsResponse {
  integrations: IntegrationView[];
}

export interface PutIntegrationRequest {
  provider: string;
  kind: MintKind;
  custody: Custody;
  config: JsonObject;
  root: string;
  usable_by?: { owners: string[] } | null;
}

export interface CredentialManifest {
  integrations: Record<string, JsonObject>;
}

export interface ListCredentialLeasesResponse {
  leases: CredentialLeaseView[];
}

export interface CredentialRequestView {
  id: string;
  workspace_id: string;
  integration_name: string;
  requested_scopes: string[];
  created_at: number;
}

export interface ListCredentialRequestsResponse {
  requests: CredentialRequestView[];
}
import type { JsonObject } from "./json.js";
