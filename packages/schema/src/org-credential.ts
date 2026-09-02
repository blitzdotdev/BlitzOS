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

/** What `POST /agent/credentials/:name/token` answers with. Both tiers expose
 * the value and environment projection; only a minted connection can promise
 * an HTTP presentation rule or expiry. */
interface AgentCredentialTokenBase {
  name: string;
  token: string;
  env: ConnectionEnv[];
}

export type AgentCredentialTokenResponse = AgentCredentialTokenBase & ({
  scope: "connection";
  header: TokenHeader;
  expiresAt: number;
} | { scope: "org" });

/** `PUT /agent/credentials/:name`: create (201) or rotate (200) an org
 * credential from a machine. Same tri-state `comment` as the session plane. */
export interface PutAgentCredentialRequest {
  value: string;
  comment?: string | null;
}

/** The 404 of `POST /agent/credentials/:name/token`: the name is not
 * connected in this workspace, or not granted to the machine's member. The
 * miss files a `credential_requests` row, and `request_id` names it — the
 * connect inbox resolves that id once a person connects or grants the name.
 * The recovery is `blitz connections open <provider>`, then asking again. */
export interface CredentialRequestFiledError {
  error: string;
  request_id: string;
}

/** Agent-driven grant operations (plans/ORG-CREDENTIALS.md §7a): an agent
 * proposes an explicit change list, a person approves what applies. */

export type GrantChangeAction = "add" | "remove";

/** One grant edit on one named credential. `add` writes the grant (replacing
 * whatever grant the same subject already held); `remove` deletes exactly
 * the grant named. Subject rules are `OrgCredentialGrantView`'s. */
export interface GrantChange {
  name: string;
  action: GrantChangeAction;
  subjectKind: OrgCredentialGrantSubjectKind;
  subjectId: string | null;
  access: OrgCredentialAccess;
}

/** `POST /agent/credentials/grant-proposals`. Every change must sit within
 * the acting member's own write authority, or the whole proposal is refused
 * with a 403 that names the offending changes. `reason` is shown to the
 * person verbatim. */
export interface ProposeGrantChangesRequest {
  changes: GrantChange[];
  reason: string;
}

export type GrantProposalState = "pending" | "approved" | "denied" | "expired";

export interface ProposeGrantChangesResponse {
  id: string;
  state: GrantProposalState;
}

/** One proposal as both planes read it: the agent's poll and the approval
 * feed. `applied` is what actually went through — null until approval, and
 * possibly narrower than `proposed`, because the person edits before
 * approving and a credential revoked meanwhile drops out. */
export interface GrantProposalView {
  id: string;
  state: GrantProposalState;
  machineId: string;
  membershipId: string;
  reason: string;
  proposed: GrantChange[];
  applied: GrantChange[] | null;
  createdAt: number;
}

/** `GET /orgs/:id/grant-proposals`: the pending proposals addressed
 * to the caller, plus every one in the org for an org admin. */
export interface ListGrantProposalsResponse {
  proposals: GrantProposalView[];
}

/** `POST /orgs/:id/grant-proposals/:pid/resolve`. On approve, `changes` is
 * the edited set that applies — checked against the approver's own write
 * authority like any grant write. On deny it is ignored and nothing changes. */
export interface ResolveGrantProposalRequest {
  approve: boolean;
  changes: GrantChange[];
}

export interface ResolveGrantProposalResponse {
  proposal: GrantProposalView;
}
