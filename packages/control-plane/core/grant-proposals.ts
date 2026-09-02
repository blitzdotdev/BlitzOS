import { boxCaller } from "./agent-routes.js";
import { first, rows, type Db, type Query } from "./db.js";
import {
  HttpError,
  isBoolean,
  isRecord,
  readJson,
  requiredString,
  type JsonValue,
} from "./http.js";
import {
  callerFor,
  invalidGrantSubjects,
  orgCredentialAccess,
  orgCredentialByName,
  parseGrant,
  replaceOrgCredentialGrantSets,
  requestedOrgId,
  type OrgCredential,
  type OrgCredentialCaller,
  type OrgCredentialGrantRow,
} from "./org-credentials.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "./runtime.js";
import type {
  GrantChange,
  GrantProposalState,
  GrantProposalView,
  ListGrantProposalsResponse,
  OrgCredentialGrantView,
  ProposeGrantChangesRequest,
  ProposeGrantChangesResponse,
  ResolveGrantProposalRequest,
  ResolveGrantProposalResponse,
} from "./wire.js";

/**
 * Agent-driven grant operations (plans/ORG-CREDENTIALS.md §7a).
 *
 * An agent may propose any grant change its person could make, but nothing
 * applies without that person (or an org admin) approving it — and what
 * applies is what they approve, which may be narrower than what was asked.
 *
 * A proposal is one row in `grant_proposals` (migration 0049): the agent
 * files it on one request and a person answers it on another, and on Workers
 * those land on whichever isolate is awake, so the hand-off needs the one
 * store both reach. The row is the hand-off, not an audit — the durable
 * record of an approval is still the grant rows it writes and their
 * `credential_events`. Expiry is lazy: a pending row read past its TTL flips
 * to `expired` on the spot, and inserts sweep rows nobody will read again.
 */

interface GrantProposal {
  id: string;
  orgId: string;
  /** Which machine asked. */
  machineId: string;
  /** The acting member; the approver. */
  membershipId: string;
  /** Shown verbatim in the dialog. */
  reason: string;
  proposed: GrantChange[];
  /** What actually went through. */
  applied: GrantChange[] | null;
  state: GrantProposalState;
  createdAt: number;
}

/** How long a proposal waits for a person before it expires. */
export const GRANT_PROPOSAL_TTL_MS = 60 * 60 * 1000;

/** How many changes one proposal may carry: a proposal is one intent, not a
 * migration. */
export const GRANT_PROPOSAL_MAX_CHANGES = 200;

/** The row as D1 hands it back. `proposed` and `applied` are the JSON change
 * lists exactly as the wire carries them. */
interface GrantProposalRow {
  id: string;
  org_id: string;
  machine_id: string;
  membership_id: string;
  reason: string;
  proposed: string;
  applied: string | null;
  state: GrantProposalState;
  created_at: number;
}

const PROPOSAL_COLUMNS =
  "id, org_id, machine_id, membership_id, reason, proposed, applied, state, created_at";

/** Our own writes, read back through the same parser the wire uses, so a
 * row never yields a shape the routes did not accept. */
function proposalFromRow(row: GrantProposalRow): GrantProposal {
  return {
    id: row.id,
    orgId: row.org_id,
    machineId: row.machine_id,
    membershipId: row.membership_id,
    reason: row.reason,
    proposed: parseGrantChanges(JSON.parse(row.proposed), "proposed"),
    applied: row.applied === null ? null : parseGrantChanges(JSON.parse(row.applied), "applied"),
    state: row.state,
    createdAt: row.created_at,
  };
}

/** The one read. Expiry is enforced here, lazily, with no timer: a pending
 * proposal read past its TTL flips to `expired` on the spot, on the row too,
 * so every later reader agrees. */
async function grantProposalById(
  db: Db,
  id: string,
  now = Date.now(),
): Promise<GrantProposal | null> {
  const row = await first<GrantProposalRow>(db, {
    q: `SELECT ${PROPOSAL_COLUMNS} FROM grant_proposals WHERE id = ?1 LIMIT 1`,
    v: [id],
  });
  if (row === null) return null;
  const proposal = proposalFromRow(row);
  if (proposal.state === "pending" && now - proposal.createdAt > GRANT_PROPOSAL_TTL_MS) {
    await rows(db, {
      q: `UPDATE grant_proposals SET state = 'expired', resolved_at = ?1
          WHERE id = ?2 AND state = 'pending'`,
      v: [now, id],
    });
    proposal.state = "expired";
  }
  return proposal;
}

async function pendingGrantProposalsForOrg(
  db: Db,
  orgId: string,
  now: number,
): Promise<GrantProposal[]> {
  const pending = await rows<GrantProposalRow>(db, {
    q: `SELECT ${PROPOSAL_COLUMNS} FROM grant_proposals
        WHERE org_id = ?1 AND state = 'pending' AND created_at > ?2
        ORDER BY created_at`,
    v: [orgId, now - GRANT_PROPOSAL_TTL_MS],
  });
  return pending.map(proposalFromRow);
}

/** Inserts sweep what nobody will read again: anything past its TTL has
 * either been resolved and polled or has expired. */
async function evictStaleProposals(db: Db, now: number): Promise<void> {
  await rows(db, {
    q: "DELETE FROM grant_proposals WHERE created_at <= ?1",
    v: [now - GRANT_PROPOSAL_TTL_MS],
  });
}

/** The row update that settles a proposal, shaped to ride inside the same
 * transaction as the grant rows an approval writes. The state guard makes a
 * second resolve of the same row change nothing. */
function settleProposalQuery(
  id: string,
  state: Exclude<GrantProposalState, "pending">,
  applied: GrantChange[] | null,
  now: number,
): Query {
  return {
    q: `UPDATE grant_proposals SET state = ?1, applied = ?2, resolved_at = ?3
        WHERE id = ?4 AND state = 'pending'`,
    v: [state, applied === null ? null : JSON.stringify(applied), now, id],
  };
}

function grantProposalView(proposal: GrantProposal): GrantProposalView {
  return {
    id: proposal.id,
    state: proposal.state,
    machineId: proposal.machineId,
    membershipId: proposal.membershipId,
    reason: proposal.reason,
    proposed: proposal.proposed,
    applied: proposal.applied,
    createdAt: proposal.createdAt,
  };
}

function parseGrantChange(value: JsonValue, field: string): GrantChange {
  if (!isRecord(value)) throw new HttpError(400, `${field} must be an object`);
  const name = requiredString(value.name, `${field}.name`, 128);
  const { action } = value;
  if (action !== "add" && action !== "remove") {
    throw new HttpError(400, `${field}.action must be add or remove`);
  }
  return { name, action, ...parseGrant(value, field) };
}

function parseGrantChanges(value: JsonValue | undefined, field = "changes"): GrantChange[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array`);
  if (value.length > GRANT_PROPOSAL_MAX_CHANGES) {
    throw new HttpError(
      400,
      `a proposal may carry at most ${String(GRANT_PROPOSAL_MAX_CHANGES)} changes`,
    );
  }
  return value.map((entry, index) => parseGrantChange(entry, `${field}[${String(index)}]`));
}

function parseProposeGrantChangesRequest(value: JsonValue): ProposeGrantChangesRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const changes = parseGrantChanges(value.changes);
  if (changes.length === 0) throw new HttpError(400, "changes must name at least one change");
  return { changes, reason: requiredString(value.reason, "reason", 1024) };
}

function parseResolveGrantProposalRequest(value: JsonValue): ResolveGrantProposalRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const { approve } = value;
  if (!isBoolean(approve)) throw new HttpError(400, "approve must be a boolean");
  return { approve, changes: parseGrantChanges(value.changes ?? []) };
}

/** How a refusal names a change: enough for the agent to find it in its own
 * list, and nothing a person needs to decode. */
function describeChange(change: GrantChange): string {
  const subject = change.subjectId === null
    ? change.subjectKind
    : `${change.subjectKind}:${change.subjectId}`;
  return `${change.name} ${change.action} ${subject} ${change.access}`;
}

const uniqueNames = (changes: readonly GrantChange[]): string[] =>
  [...new Set(changes.map(({ name }) => name))];

/** The credentials a change list names, keyed by name; a name with no live
 * credential maps to null. One lookup per distinct name. */
async function credentialsNamed(
  runtime: CoreRuntime,
  orgId: string,
  changes: readonly GrantChange[],
): Promise<Map<string, OrgCredential | null>> {
  const named = new Map<string, OrgCredential | null>();
  for (const name of uniqueNames(changes)) {
    named.set(name, await orgCredentialByName(runtime.db, orgId, name));
  }
  return named;
}

/** The changes past the caller's authority: any that names no live
 * credential, or one the caller may not write. `write` is the same §6
 * decision every grant write makes — there is no proposal-specific rule. */
function changesPastAuthority(
  changes: readonly GrantChange[],
  credentials: ReadonlyMap<string, OrgCredential | null>,
  caller: OrgCredentialCaller,
): GrantChange[] {
  return changes.filter((change) => {
    const credential = credentials.get(change.name);
    return credential === null || credential === undefined
      || !orgCredentialAccess(credential, caller).write;
  });
}

function refusePastAuthority(offenders: readonly GrantChange[]): void {
  if (offenders.length === 0) return;
  throw new HttpError(
    403,
    `changes past your authority: ${offenders.map(describeChange).join("; ")}`,
  );
}

const subjectKey = (grant: Pick<OrgCredentialGrantView, "subjectKind" | "subjectId">): string =>
  `${grant.subjectKind}:${grant.subjectId ?? ""}`;

const changeGrant = (change: GrantChange): OrgCredentialGrantView => ({
  subjectKind: change.subjectKind,
  subjectId: change.subjectId,
  access: change.access,
});

const heldGrant = (grant: OrgCredentialGrantRow): OrgCredentialGrantView => ({
  subjectKind: grant.subject_kind,
  subjectId: grant.subject_id,
  access: grant.access,
});

/** The same subject rule `replaceOrgCredentialGrants` enforces — a workspace
 * live in this org, a membership active in it — asked of the change list
 * before it is filed, so the person is never handed a proposal the store
 * would refuse. */
async function refuseInvalidSubjects(
  runtime: CoreRuntime,
  orgId: string,
  changes: readonly GrantChange[],
): Promise<void> {
  const invalid = await invalidGrantSubjects(runtime.db, orgId, changes.map(changeGrant));
  const offenders = changes.filter((change) => invalid.has(subjectKey(change)));
  if (offenders.length === 0) return;
  throw new HttpError(
    400,
    `changes name subjects outside this organization: ${offenders.map(describeChange).join("; ")}`,
  );
}

interface ProposeGrantChangesInput {
  orgId: string;
  machineId: string;
  membershipId: string;
  caller: OrgCredentialCaller;
  changes: GrantChange[];
  reason: string;
}

/** Files one proposal, after the whole list passes the proposer's authority:
 * every change must name a live credential the acting member may write.
 * Anything past that refuses the whole proposal with a 403 that names the
 * offenders, and nothing is stored — the agent narrows and retries. */
async function proposeGrantChanges(
  runtime: CoreRuntime,
  input: ProposeGrantChangesInput,
  now = Date.now(),
): Promise<GrantProposal> {
  const credentials = await credentialsNamed(runtime, input.orgId, input.changes);
  refusePastAuthority(changesPastAuthority(input.changes, credentials, input.caller));
  await refuseInvalidSubjects(runtime, input.orgId, input.changes);
  await evictStaleProposals(runtime.db, now);
  const proposal: GrantProposal = {
    id: crypto.randomUUID(),
    orgId: input.orgId,
    machineId: input.machineId,
    membershipId: input.membershipId,
    reason: input.reason,
    proposed: input.changes,
    applied: null,
    state: "pending",
    createdAt: now,
  };
  await rows(runtime.db, {
    q: `INSERT INTO grant_proposals
        (id, org_id, machine_id, membership_id, reason, proposed, applied, state, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'pending', ?7)`,
    v: [
      proposal.id,
      proposal.orgId,
      proposal.machineId,
      proposal.membershipId,
      proposal.reason,
      JSON.stringify(proposal.proposed),
      proposal.createdAt,
    ],
  });
  return proposal;
}

const sameGrant = (a: OrgCredentialGrantView, b: OrgCredentialGrantView): boolean =>
  subjectKey(a) === subjectKey(b) && a.access === b.access;

/** One credential's grant set after a change list, and the changes that
 * made a difference to it. */
interface GrantSetEdit {
  next: OrgCredentialGrantView[];
  effective: GrantChange[];
}

/** Applies a change list to one grant set, in order, and says which changes
 * made a difference. The store allows one grant per subject, so an add
 * replaces what the same subject held — but only upward: an add never
 * lowers access. A subject that holds write keeps it when a proposal adds
 * read, because the approver reads "add read" as widening, not as the
 * revocation of a write they granted themselves; lowering is what `remove`
 * says out loud. A remove deletes the exact grant named. A change that
 * alters nothing is not "applied". */
function applyChangesToGrantSet(
  current: readonly OrgCredentialGrantView[],
  changes: readonly GrantChange[],
): GrantSetEdit {
  let next = [...current];
  const effective: GrantChange[] = [];
  for (const change of changes) {
    const grant = changeGrant(change);
    if (change.action === "add") {
      const held = next.find((candidate) => subjectKey(candidate) === subjectKey(grant));
      if (held !== undefined && (held.access === grant.access || held.access === "write")) continue;
      next = [...next.filter((candidate) => subjectKey(candidate) !== subjectKey(grant)), grant];
    } else {
      if (!next.some((held) => sameGrant(held, grant))) continue;
      next = next.filter((held) => !sameGrant(held, grant));
    }
    effective.push(change);
  }
  return { next, effective };
}

interface ResolveGrantProposalInput {
  approver: OrgCredentialCaller & { membershipId: string };
  approve: boolean;
  changes: GrantChange[];
}

/** Resolves a pending proposal. Deny changes nothing. Approve revalidates the
 * person's edited set against the live store, drops revoked credentials and
 * invalid subjects, then commits every surviving credential and audit event
 * in one transaction. */
async function resolveGrantProposal(
  runtime: CoreRuntime,
  proposal: GrantProposal,
  input: ResolveGrantProposalInput,
  now = Date.now(),
): Promise<GrantProposal> {
  if (proposal.state !== "pending") {
    throw new HttpError(409, `grant proposal is ${proposal.state}`);
  }
  if (!input.approve) {
    await rows(runtime.db, settleProposalQuery(proposal.id, "denied", null, now));
    proposal.state = "denied";
    return proposal;
  }
  const credentials = await credentialsNamed(runtime, proposal.orgId, input.changes);
  // A credential revoked since the proposal is a no-op, not a refusal; only
  // a live one the approver may not write is past their authority.
  const liveCredentials = [...credentials.values()].flatMap((credential) =>
    credential === null ? [] : [credential]);
  const live = input.changes.filter((change) =>
    liveCredentials.some((credential) => credential.name === change.name));
  // One subject check over everything the replace will see: the changes AND
  // the grants they leave in place, since a kept grant whose member has since
  // been disabled makes that credential a no-op.
  const invalid = await invalidGrantSubjects(runtime.db, proposal.orgId, [
    ...live.map(changeGrant),
    ...liveCredentials.flatMap((credential) => credential.grants.map(heldGrant)),
  ]);
  const survivors = live.filter((change) => !invalid.has(subjectKey(change)));
  refusePastAuthority(changesPastAuthority(survivors, credentials, input.approver));
  const applied: GrantChange[] = [];
  const replacements = liveCredentials.flatMap((credential) => {
    const { next, effective } = applyChangesToGrantSet(
      credential.grants.map(heldGrant),
      survivors.filter((change) => change.name === credential.name),
    );
    if (effective.length === 0 || next.some((grant) => invalid.has(subjectKey(grant)))) return [];
    applied.push(...effective);
    return [{ credential, grants: next }];
  });
  // The row settles in the same transaction as the grants it approved, so a
  // worker that dies between the two cannot leave an applied proposal pending.
  await replaceOrgCredentialGrantSets(
    runtime,
    proposal.orgId,
    input.approver.membershipId,
    replacements,
    now,
    [settleProposalQuery(proposal.id, "approved", applied, now)],
  );
  proposal.applied = applied;
  proposal.state = "approved";
  return proposal;
}

/** A proposal the session route names, inside the caller's org. Another
 * org's id, an unknown id and a forgotten id all read the same: 404. */
async function requestedProposal(
  db: Db,
  context: CoreContext,
  orgId: string,
  now: number,
): Promise<GrantProposal> {
  const id = requiredString(context.req.param("pid"), "pid", 64);
  const proposal = await grantProposalById(db, id, now);
  if (proposal === null || proposal.orgId !== orgId) {
    throw new HttpError(404, "grant proposal not found");
  }
  return proposal;
}

function activeMembership(principal: Principal): string {
  if (principal.membershipId === null) throw new HttpError(403, "active membership required");
  return principal.membershipId;
}

export function addGrantProposalRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  /** The agent's ask. Authority is the machine's member, resolved at call
   * time like every other agent route. */
  router.post("/agent/credentials/grant-proposals", async (context) => {
    const runtime = runtimeFactory(context);
    const caller = await boxCaller(runtime, context.req.raw);
    const membershipId = activeMembership(caller.principal);
    const input = parseProposeGrantChangesRequest(await readJson(context.req.raw));
    const proposal = await proposeGrantChanges(runtime, {
      orgId: caller.workspace.org_id,
      machineId: caller.machineId,
      membershipId,
      caller: {
        workspaceId: caller.workspace.id,
        membershipId,
        orgRole: caller.principal.role,
      },
      changes: input.changes,
      reason: input.reason,
    });
    return context.json<ProposeGrantChangesResponse>(
      { id: proposal.id, state: proposal.state },
      201,
    );
  });

  /** The agent's poll, until `state` leaves pending. Scoped to the
   * proposing machine's own organization. */
  router.get("/agent/grant-proposals/:id", async (context) => {
    const runtime = runtimeFactory(context);
    const caller = await boxCaller(runtime, context.req.raw);
    const id = requiredString(context.req.param("id"), "id", 64);
    const proposal = await grantProposalById(runtime.db, id);
    if (proposal === null || proposal.orgId !== caller.workspace.org_id) {
      throw new HttpError(404, "grant proposal not found");
    }
    return context.json<GrantProposalView>(grantProposalView(proposal));
  });

  /** The approval feed: what is addressed to the caller, and for an org
   * admin everything in the organization. */
  router.get("/orgs/:id/grant-proposals", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const orgId = requestedOrgId(context, principal);
    const membershipId = activeMembership(principal);
    const pending = await pendingGrantProposalsForOrg(runtime.db, orgId, Date.now());
    const visible = pending.filter((proposal) =>
      principal.role === "admin" || proposal.membershipId === membershipId);
    return context.json<ListGrantProposalsResponse>({
      proposals: visible.map(grantProposalView),
    });
  });

  /** The person's answer. The approver is the acting member or an org admin;
   * what they submit is what applies, under their own write authority. */
  router.post("/orgs/:id/grant-proposals/:pid/resolve", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const orgId = requestedOrgId(context, principal);
    const membershipId = activeMembership(principal);
    const now = Date.now();
    const proposal = await requestedProposal(runtime.db, context, orgId, now);
    if (principal.role !== "admin" && proposal.membershipId !== membershipId) {
      throw new HttpError(403, "only the acting member or an org admin may resolve this proposal");
    }
    const input = parseResolveGrantProposalRequest(await readJson(context.req.raw));
    const resolved = await resolveGrantProposal(runtime, proposal, {
      approver: { ...callerFor(principal), membershipId },
      approve: input.approve,
      changes: input.changes,
    }, now);
    return context.json<ResolveGrantProposalResponse>({ proposal: grantProposalView(resolved) });
  });
}
