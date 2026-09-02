import type { ConnectionEnv, TokenHeader } from "./credential.js";

/** The org credential plane (plans/ORG-CREDENTIALS.md §5-§7).
 *
 * One static store per organization; access rides an explicit allowlist of
 * grants. Org admins implicitly read and write everything, so a grant row is
 * never written for them. */

/** Who a grant covers. `'org'` is everybody in the organization
 * (`subjectId` null); the other kinds name a workspace or a membership. */
export type OrgCredentialGrantSubjectKind = "org" | "workspace" | "membership";

export type OrgCredentialAccess = "read" | "write";

export interface OrgCredentialGrantView {
  subjectKind: OrgCredentialGrantSubjectKind;
  /** Null iff `subjectKind === 'org'`. */
  subjectId: string | null;
  /** Write implies read. */
  access: OrgCredentialAccess;
}

/** One org credential, name and metadata only — a value never crosses the
 * wire after the write that stored it. `grants` is the full set for writers
 * and org admins, and `[]` for plain readers. */
export interface OrgCredentialView {
  id: string;
  name: string;
  comment: string | null;
  createdByMembershipId: string;
  createdAt: number;
  updatedAt: number;
  grants: OrgCredentialGrantView[];
}

export interface ListOrgCredentialsResponse {
  credentials: OrgCredentialView[];
}

/** Create or rotate: one live row per (org, name), so a second write to a
 * live name replaces its value.
 *
 * `comment` is tri-state: absent keeps the live row's comment across a
 * rotation, an explicit null clears it, a string sets it. Rotation changes
 * the secret, not what the secret is for.
 *
 * `grants` replaces the credential's whole grant set when present; absent
 * leaves the set alone. Create always adds an implicit `write` grant for the
 * creator's membership (§12). */
export interface PutOrgCredentialRequest {
  name: string;
  value: string;
  comment?: string | null;
  grants?: OrgCredentialGrantView[];
}

export interface PutOrgCredentialResponse {
  credential: OrgCredentialView;
}

/** `PUT /orgs/:id/credentials/:name/grants`: replaces the grant set
 * atomically. What is sent is what holds afterwards. */
export interface ReplaceOrgCredentialGrantsRequest {
  grants: OrgCredentialGrantView[];
}

export interface ReplaceOrgCredentialGrantsResponse {
  credential: OrgCredentialView;
}

/** A dotenv text to store key by key at org scope. The importer sets no
 * comment — `comment` is the one human-facing annotation and it belongs to a
 * deliberate single-key write. `dryRun` parses and reports without writing. */
export interface ImportOrgCredentialsRequest {
  text: string;
  dryRun?: boolean;
}

/**
 * What one KEY=value line became. Store-level facts only: `rotated` says a
 * live row held this name and its value changed, `unchanged` says the
 * incoming value equals the stored one, so nothing was written. A refused
 * line names its reason and the rest of the file still imports.
 */
export interface OrgCredentialImportResult {
  name: string;
  line: number;
  outcome: "stored" | "rotated" | "unchanged" | "refused";
  reason?: string;
}

export interface ImportOrgCredentialsResponse {
  results: OrgCredentialImportResult[];
  linesRead: number;
}

/** The agent plane (plans/ORG-CREDENTIALS.md §4), box-authed under
 * `/agent/`. */

export type AgentCredentialScope = "connection" | "org";

/** One name an agent may ask for. `scope: 'connection'` rows come from the
 * workspace connection manifest (comment null, writable false); `'org'` rows
 * are org credentials the machine's member may read, `writable` when they may
 * also rotate it. */
export interface AgentCredentialEntry {
  name: string;
  scope: AgentCredentialScope;
  comment: string | null;
  writable: boolean;
}

export interface AgentCredentialsResponse {
  credentials: AgentCredentialEntry[];
}

/** What `POST /agent/credentials/:name/token` answers with, for both tiers.
 * The agent reads it once and stores nothing: `token` is what it presents,
 * `env` names the variables the provider's own tooling reads, `header` is how
 * the token travels in HTTP. `expiresAt` says "ask again" — pulls are
 * per-use, and a rotation or revoke takes effect on the next one. */
export interface AgentCredentialTokenResponse {
  name: string;
  scope: AgentCredentialScope;
  token: string;
  env: ConnectionEnv[];
  header: TokenHeader;
  expiresAt: number;
}

/** `PUT /agent/credentials/:name`: create (201) or rotate (200) an org
 * credential from a machine. Same tri-state `comment` as the session plane. */
export interface PutAgentCredentialRequest {
  value: string;
  comment?: string | null;
}
