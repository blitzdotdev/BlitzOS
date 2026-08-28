import { randomToken } from "./crypto.js";
import { rows, transaction } from "./db.js";
import {
  HttpError,
  isRecord,
  positiveInteger,
  readJson,
  requiredString,
  type JsonValue,
} from "./http.js";
import {
  expireInvites,
  INVITE_TTL_MS,
  inviteCodeHash,
  optionalEmail,
} from "./identity/invites.js";
import { availableOrgSlug } from "./identity/orgs.js";
import { runTrialExpirySweep } from "./janitors.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import { INVITE_TTL_DAYS } from "./wire.js";

/**
 * The platform operator's console: every organization on the deployment, and
 * the one write an operator makes — seeding a sponsored trial organization.
 *
 * These routes are the deployment owner's view, not a member's, so they are
 * the one deliberate exception to "every query is scoped to the principal's
 * organization". The gate is users.platform_operator, the same flag that
 * gates /operator-tokens. A read-only operator token never reaches here:
 * its scope check refuses everything outside GET /workspaces*.
 */

/** A trial should end before its bill is interesting. Two weeks by default,
 * a quarter at most; an operator who wants longer writes a new trial. */
const DEFAULT_TRIAL_DAYS = 14;
const MAX_TRIAL_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Small on purpose: a trial is one person kicking tires, not a rollout.
 * The operator can pass larger numbers when the prospect is a team. */
const DEFAULT_TRIAL_SEAT_LIMIT = 5;
const DEFAULT_TRIAL_VM_LIMIT = 2;

type MemberRole = "admin" | "member";
type MemberStatus = "invited" | "active" | "disabled";
type InviteState = "ready" | "redeemed" | "revoked" | "expired";

interface AdminOrgRow {
  id: string;
  slug: string;
  name: string;
  created_at: number;
  vm_limit: number;
  created_by: string | null;
  seat_limit: number | null;
  platform_compute: number | null;
  trial_expires_at: number | null;
}

interface AdminMemberRow {
  org_id: string;
  email: string;
  name: string;
  role: MemberRole;
  status: MemberStatus;
}

interface AdminInviteRow {
  id: string;
  target_org_id: string;
  email: string | null;
  role: MemberRole;
  state: InviteState;
  created_at: number;
  expires_at: number;
  redeemed_at: number | null;
}

interface AdminWorkspaceRow {
  id: string;
  org_id: string;
  name: string | null;
  phase: "creating" | "ready" | "destroying" | "destroyed" | "error";
  machine_type_id: string;
  compute_credential_source: "org" | "deployment" | null;
  created_at: number;
}

export interface AdminOrgView {
  id: string;
  slug: string;
  name: string;
  createdAt: number;
  /** Email of the user who created the organization; null for the bootstrap
   * organization, whose creator predates the column. */
  createdBy: string | null;
  vmLimit: number;
  /** Null where no billing service has written a row: the free tier. */
  seatLimit: number | null;
  platformCompute: boolean;
  trialExpiresAt: number | null;
  members: Array<{ email: string; name: string; role: MemberRole; status: MemberStatus }>;
  invites: Array<{
    id: string;
    email: string | null;
    role: MemberRole;
    state: InviteState;
    createdAt: number;
    expiresAt: number;
    redeemedAt: number | null;
  }>;
  /** Everything but destroyed rows: the live estate plus its failures. */
  workspaces: Array<{
    id: string;
    name: string | null;
    phase: AdminWorkspaceRow["phase"];
    machineTypeId: string;
    credentialSource: "org" | "deployment";
    createdAt: number;
  }>;
}

interface TrialOrgRequest {
  name: string;
  email: string | null;
  seatLimit: number;
  vmLimit: number;
  trialDays: number;
}

function trialOrgRequest(value: JsonValue): TrialOrgRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const name = requiredString(value.name, "name", 120).trim();
  if (name === "") throw new HttpError(400, "name must be a non-empty string");
  const trialDays = value.trialDays === undefined
    ? DEFAULT_TRIAL_DAYS
    : positiveInteger(value.trialDays, "trialDays");
  if (trialDays > MAX_TRIAL_DAYS) {
    throw new HttpError(400, `trialDays must be at most ${MAX_TRIAL_DAYS}`);
  }
  return {
    name,
    email: optionalEmail(value.email),
    seatLimit: value.seatLimit === undefined
      ? DEFAULT_TRIAL_SEAT_LIMIT
      : positiveInteger(value.seatLimit, "seatLimit"),
    vmLimit: value.vmLimit === undefined
      ? DEFAULT_TRIAL_VM_LIMIT
      : positiveInteger(value.vmLimit, "vmLimit"),
    trialDays,
  };
}

export function addAdminRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  async function requirePlatformOperator(context: CoreContext): Promise<Principal> {
    const principal = await requirePrincipal(context);
    if (!principal.platformOperator) throw new HttpError(403, "platform operator required");
    return principal;
  }

  router.get("/admin/orgs", async (context) => {
    await requirePlatformOperator(context);
    const runtime = runtimeFactory(context);
    const now = Date.now();
    // The console reports state, so it settles the two lazy clocks first:
    // ready invites past their expiry, and trials past theirs. Without this a
    // trial that ended overnight still reads as sponsored until some other
    // request happens to sweep.
    await expireInvites(runtime.db, now);
    await runTrialExpirySweep(runtime, now);
    const orgs = await rows<AdminOrgRow>(runtime.db, {
      q: `SELECT o.id, o.slug, o.name, o.created_at, o.vm_limit,
                 creator.email AS created_by,
                 e.seat_limit, e.platform_compute, e.trial_expires_at
          FROM orgs o
          LEFT JOIN users creator ON creator.id = o.created_by_user_id
          LEFT JOIN org_entitlements e ON e.org_id = o.id
          ORDER BY o.created_at DESC, o.id`,
      v: [],
    });
    const members = await rows<AdminMemberRow>(runtime.db, {
      q: `SELECT m.org_id, u.email, u.name, m.role, m.status
          FROM memberships m JOIN users u ON u.id = m.user_id
          ORDER BY m.role, u.email`,
      v: [],
    });
    const invites = await rows<AdminInviteRow>(runtime.db, {
      q: `SELECT id, target_org_id, email, role, state, created_at, expires_at, redeemed_at
          FROM invites ORDER BY created_at DESC, id`,
      v: [],
    });
    const workspaces = await rows<AdminWorkspaceRow>(runtime.db, {
      q: `SELECT id, org_id, name, phase, machine_type_id, compute_credential_source, created_at
          FROM workspaces WHERE org_id IS NOT NULL AND phase != 'destroyed'
          ORDER BY created_at DESC, id`,
      v: [],
    });
    const views = orgs.map((org): AdminOrgView => ({
      id: org.id,
      slug: org.slug,
      name: org.name,
      createdAt: org.created_at,
      createdBy: org.created_by,
      vmLimit: org.vm_limit,
      seatLimit: org.seat_limit,
      platformCompute: org.platform_compute === 1,
      trialExpiresAt: org.trial_expires_at,
      members: members
        .filter((member) => member.org_id === org.id)
        .map(({ email, name, role, status }) => ({ email, name, role, status })),
      invites: invites
        .filter((invite) => invite.target_org_id === org.id)
        .map((invite) => ({
          id: invite.id,
          email: invite.email,
          role: invite.role,
          state: invite.state,
          createdAt: invite.created_at,
          expiresAt: invite.expires_at,
          redeemedAt: invite.redeemed_at,
        })),
      workspaces: workspaces
        .filter((workspace) => workspace.org_id === org.id)
        .map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          phase: workspace.phase,
          machineTypeId: workspace.machine_type_id,
          credentialSource: workspace.compute_credential_source ?? "deployment",
          createdAt: workspace.created_at,
        })),
    }));
    return context.json({ orgs: views });
  });

  // Seeds a sponsored trial: a fresh organization already entitled to the
  // deployment's cloud credential, and an admin invite into it. The operator
  // sends the returned link; the prospect lands with machines they can
  // create, and never sees a BYOK form.
  //
  // This writes org_entitlements directly, which is otherwise the billing
  // service's column. The invariant that matters survives: what lands in the
  // row is integers and an instant, never a plan name — and a later billing
  // write replaces the whole row and clears the trial clock.
  router.post("/admin/trial-orgs", async (context) => {
    const principal = await requirePlatformOperator(context);
    // The invite row names its creator by membership, so an operator between
    // organizations has nothing to sign it with — same rule as minting an
    // operator token.
    if (principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const runtime = runtimeFactory(context);
    const request = trialOrgRequest(await readJson(context.req.raw));
    const orgId = crypto.randomUUID();
    const inviteId = crypto.randomUUID();
    const slug = await availableOrgSlug(runtime.db, request.name);
    const code = randomToken(32);
    const now = Date.now();
    const trialExpiresAt = now + request.trialDays * DAY_MS;
    const inviteExpiresAt = now + INVITE_TTL_MS;
    const result = await transaction(runtime.db, [
      {
        q: `INSERT INTO orgs
            (id, slug, name, vm_limit, created_by_user_id, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
            RETURNING id`,
        v: [orgId, slug, request.name, request.vmLimit, principal.id, now],
      },
      {
        q: `INSERT INTO org_entitlements
            (org_id, seat_limit, platform_compute, trial_expires_at, updated_at)
            VALUES (?1, ?2, 1, ?3, ?4)
            RETURNING org_id`,
        v: [orgId, request.seatLimit, trialExpiresAt, now],
      },
      {
        q: `INSERT INTO invites
            (id, code_hash, email, target_org_id, role, state,
             created_by_membership_id, redeemed_by_user_id, created_at,
             expires_at, redeemed_at)
            VALUES (?1, ?2, ?3, ?4, 'admin', 'ready', ?5, NULL, ?6, ?7, NULL)
            RETURNING id`,
        v: [
          inviteId,
          await inviteCodeHash(code),
          request.email,
          orgId,
          principal.membershipId,
          now,
          inviteExpiresAt,
        ],
      },
    ]);
    if (result[0]?.length !== 1 || result[1]?.length !== 1 || result[2]?.length !== 1) {
      throw new HttpError(409, "trial organization could not be created");
    }
    return context.json({
      org: { id: orgId, slug, name: request.name, vmLimit: request.vmLimit },
      invite: {
        id: inviteId,
        email: request.email,
        role: "admin",
        state: "ready",
        createdAt: now,
        expiresAt: inviteExpiresAt,
      },
      code,
      ttlDays: INVITE_TTL_DAYS,
      trialExpiresAt,
    }, 201);
  });
}
