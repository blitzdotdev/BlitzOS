import { boxCaller, type MachineCaller } from "./agent-routes.js";
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
  replaceOrgCredentialGrants,
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
 * Proposals live in memory on the CP runtime. Nothing is persisted: the
 * durable record of an approval is the grant rows it writes and their
 * `credential_events`. A worker recycle drops a pending proposal, which the
 * agent sees as a 404 on its next poll and answers by proposing again.
 */

export interface GrantProposal {
  id: string;
  orgId: string;
  /** Which machine asked. */
  machineId: string;
  /** The acting member; the approver. */
  membershipId: string;
  /** Shown verbatim in the dialog. */
  reason: string | null;
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

const proposals = new Map<string, GrantProposal>();

/** Test seam: the store is module state, so a suite empties it between cases
 * the way `resetDatabase` empties the tables. */
export function clearGrantProposals(): void {
  proposals.clear();
}

/** The one read. Expiry is enforced here, lazily, with no timer: a pending
 * proposal read past its TTL flips to `expired` on the spot. Unknown ids
 * answer null — including ids a recycle forgot. */
export function grantProposalById(id: string, now = Date.now()): GrantProposal | null {
  const proposal = proposals.get(id);
  if (proposal === undefined) return null;
  if (proposal.state === "pending" && now - proposal.createdAt > GRANT_PROPOSAL_TTL_MS) {
    proposal.state = "expired";
  }
  return proposal;
}

function grantProposalsForOrg(orgId: string, now: number): GrantProposal[] {
  return [...proposals.keys()]
    .flatMap((id) => {
      const proposal = grantProposalById(id, now);
      return proposal !== null && proposal.orgId === orgId ? [proposal] : [];
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Inserts sweep what nobody will read again: anything past its TTL has
 * either been resolved and polled or has expired, and `grantProposalById`
 * already answers null for a forgotten id. */
function evictStaleProposals(now: number): void {
  for (const [id, proposal] of proposals) {
    if (now - proposal.createdAt > GRANT_PROPOSAL_TTL_MS) proposals.delete(id);
  }
}

export function grantProposalView(proposal: GrantProposal): GrantProposalView {
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

const GRANT_PROPOSAL_STATES: readonly GrantProposalState[] = [
  "pending", "approved", "denied", "expired",
];

function parseGrantChange(value: JsonValue, field: string): GrantChange {
  if (!isRecord(value)) throw new HttpError(400, `${field} must be an object`);
  const name = requiredString(value.name, `${field}.name`, 128);
  const { action } = value;
  if (action !== "add" && action !== "remove") {
    throw new HttpError(400, `${field}.action must be add or remove`);
  }
  return { name, action, ...parseGrant(value, field) };
}

export function parseGrantChanges(value: JsonValue | undefined, field = "changes"): GrantChange[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array`);
  if (value.length > GRANT_PROPOSAL_MAX_CHANGES) {
    throw new HttpError(
      400,
      `a proposal may carry at most ${String(GRANT_PROPOSAL_MAX_CHANGES)} changes`,
    );
  }
  return value.map((entry, index) => parseGrantChange(entry, `${field}[${String(index)}]`));
}

export function parseProposeGrantChangesRequest(value: JsonValue): ProposeGrantChangesRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const changes = parseGrantChanges(value.changes);
  if (changes.length === 0) throw new HttpError(400, "changes must name at least one change");
  return { changes, reason: requiredString(value.reason, "reason", 1024) };
}

export function parseResolveGrantProposalRequest(value: JsonValue): ResolveGrantProposalRequest {
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

export interface ProposeGrantChangesInput {
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
export async function proposeGrantChanges(
  runtime: CoreRuntime,
  input: ProposeGrantChangesInput,
  now = Date.now(),
): Promise<GrantProposal> {
  const credentials = await credentialsNamed(runtime, input.orgId, input.changes);
  refusePastAuthority(changesPastAuthority(input.changes, credentials, input.caller));
  await refuseInvalidSubjects(runtime, input.orgId, input.changes);
  evictStaleProposals(now);
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
  proposals.set(proposal.id, proposal);
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
 * made a difference. An add replaces whatever the same subject held (the
 * store allows one grant per subject); a remove deletes the exact grant
 * named. A change that alters nothing is not "applied". */
function applyChangesToGrantSet(
  current: readonly OrgCredentialGrantView[],
  changes: readonly GrantChange[],
): GrantSetEdit {
  let next = [...current];
  const effective: GrantChange[] = [];
  for (const change of changes) {
    const grant = changeGrant(change);
    if (change.action === "add") {
      if (next.some((held) => sameGrant(held, grant))) continue;
      next = [...next.filter((held) => subjectKey(held) !== subjectKey(grant)), grant];
    } else {
      if (!next.some((held) => sameGrant(held, grant))) continue;
      next = next.filter((held) => !sameGrant(held, grant));
    }
    effective.push(change);
  }
  return { next, effective };
}

export interface ResolveGrantProposalInput {
  approver: OrgCredentialCaller & { membershipId: string };
  approve: boolean;
  changes: GrantChange[];
}

/** Resolves a pending proposal. Deny changes nothing. Approve applies the
 * SUBMITTED changes — the person's edit of the proposal — under the same
 * write-authority check as any grant write, revalidated against the live
 * store: a name revoked meanwhile, or a subject that left the org, drops out
 * of `applied` rather than failing the rest. Survivors apply per credential
 * through `replaceOrgCredentialGrants`, which writes the `credential_events`;
 * every input it could refuse is filtered first, so it never refuses
 * mid-apply and a proposal never sticks half-applied in `pending`. */
export async function resolveGrantProposal(
  runtime: CoreRuntime,
  proposal: GrantProposal,
  input: ResolveGrantProposalInput,
  now = Date.now(),
): Promise<GrantProposal> {
  if (proposal.state !== "pending") {
    throw new HttpError(409, `grant proposal is ${proposal.state}`);
  }
  if (!input.approve) {
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
  // been disabled would refuse the whole set at write time.
  const invalid = await invalidGrantSubjects(runtime.db, proposal.orgId, [
    ...live.map(changeGrant),
    ...liveCredentials.flatMap((credential) => credential.grants.map(heldGrant)),
  ]);
  const survivors = live.filter((change) => !invalid.has(subjectKey(change)));
  refusePastAuthority(changesPastAuthority(survivors, credentials, input.approver));
  const applied: GrantChange[] = [];
  for (const credential of liveCredentials) {
    const { next, effective } = applyChangesToGrantSet(
      credential.grants.map(heldGrant),
      survivors.filter((change) => change.name === credential.name),
    );
    // Nothing to write, or a stale kept grant the store would refuse: this
    // credential is left exactly as it was, and its changes are not applied.
    if (effective.length === 0 || next.some((grant) => invalid.has(subjectKey(grant)))) continue;
    await replaceOrgCredentialGrants(runtime, credential, input.approver.membershipId, next, now);
    applied.push(...effective);
  }
  proposal.applied = applied;
  proposal.state = "approved";
  return proposal;
}

/** SAFETY: boxCaller refused a workspace whose org_id is null immediately
 * after loading it, so every caller past that point holds an org id. */
function orgIdOf(caller: MachineCaller): string {
  const orgId = caller.workspace.org_id;
  if (orgId === null) throw new HttpError(409, "workspace has no organization");
  return orgId;
}

/** A proposal the session route names, inside the caller's org. Another
 * org's id, an unknown id and a forgotten id all read the same: 404. */
function requestedProposal(context: CoreContext, orgId: string, now: number): GrantProposal {
  const id = requiredString(context.req.param("pid"), "pid", 64);
  const proposal = grantProposalById(id, now);
  if (proposal === null || proposal.orgId !== orgId) {
    throw new HttpError(404, "grant proposal not found");
  }
  return proposal;
}

function requestedState(context: CoreContext): GrantProposalState | null {
  const state = new URL(context.req.url).searchParams.get("state");
  if (state === null) return null;
  const known = GRANT_PROPOSAL_STATES.find((candidate) => candidate === state);
  if (known === undefined) throw new HttpError(400, "state must be a proposal state");
  return known;
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
      orgId: orgIdOf(caller),
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
    const proposal = grantProposalById(id);
    if (proposal === null || proposal.orgId !== orgIdOf(caller)) {
      throw new HttpError(404, "grant proposal not found");
    }
    return context.json<GrantProposalView>(grantProposalView(proposal));
  });

  /** The approval feed: what is addressed to the caller, and for an org
   * admin everything in the organization. */
  router.get("/orgs/:id/grant-proposals", async (context) => {
    const principal = await requirePrincipal(context);
    const orgId = requestedOrgId(context, principal);
    const membershipId = activeMembership(principal);
    const state = requestedState(context);
    const visible = grantProposalsForOrg(orgId, Date.now()).filter((proposal) =>
      (state === null || proposal.state === state)
      && (principal.role === "admin" || proposal.membershipId === membershipId));
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
    const proposal = requestedProposal(context, orgId, now);
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
