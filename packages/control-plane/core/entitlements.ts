import { bearerToken, safeEqualSecret } from "./crypto.js";
import { first, transaction } from "./db.js";
import type { Db } from "./db.js";
import {
  HttpError,
  isRecord,
  positiveInteger,
  readJson,
  type JsonObject,
} from "./http.js";
import type { Principal } from "./principals.js";
import type {
  CoreContext,
  CoreRouter,
  CoreRuntime,
  RuntimeFactory,
  RuntimeVariables,
} from "./runtime.js";

/**
 * The entitlements seam.
 *
 * A private billing service owns plans. It translates a plan into integers and
 * pushes them here through one route. Core stores integers and enforces
 * integers; no plan name ever crosses this boundary, so no branch in core can
 * ever ask which plan an organization is on.
 *
 * The seam is off by default. Without the ENTITLEMENTS_API_KEY secret there is
 * no billing service, `PUT /orgs/:id/entitlements` does not exist, and no seat
 * gate runs — which is what a self-host deployment gets.
 */

/** Seats an organization has when no billing service has written a row for it.
 * One: a solo organization is free, and the second person is the pay gate. */
const FREE_SEAT_LIMIT = 1;

/** How long a checkout handoff token stays valid. */
const HANDOFF_TOKEN_TTL_SECONDS = 15 * 60;

const SEAT_LIMIT_MESSAGE = "seat limit reached";

/** Workspace phases that hold a VM slot. Written once and read by both the
 * create-path predicate in core/workspaces.ts and the usage report below, so
 * the number a person is shown and the number they are stopped by are the
 * same number. */
export const VM_SLOT_PHASES = "'creating', 'ready', 'destroying', 'error'";

/** The billing key, or undefined where no billing service is attached. */
function billingKey(vars: RuntimeVariables): string | undefined {
  const key = vars.entitlementsApiKey ?? "";
  return key === "" ? undefined : key;
}

/** Whether seat gating runs at all. False on every deployment that has not
 * attached a billing service, which must behave exactly as it did before this
 * module existed. */
export function seatGateEnabled(vars: RuntimeVariables): boolean {
  return billingKey(vars) !== undefined;
}

/**
 * SQL that is true while the organization still has an unused seat.
 *
 * A fragment rather than a query, because a seat gate is only sound when it is
 * evaluated inside the statement that grants the seat: two requests that both
 * read "one seat left" would both be granted it. `orgParameter` is a
 * positional placeholder the caller writes ("?4"), never request data.
 */
export function seatAvailable(orgParameter: string): string {
  return `(SELECT COUNT(*) FROM memberships
             WHERE org_id = ${orgParameter} AND status = 'active')
          < COALESCE(
              (SELECT seat_limit FROM org_entitlements WHERE org_id = ${orgParameter}),
              ${FREE_SEAT_LIMIT})`;
}

/** Active memberships: the seats an organization is using right now. */
async function activeSeats(db: Db, orgId: string): Promise<number> {
  const row = await first<{ count: number }>(db, {
    q: `SELECT COUNT(*) AS count FROM memberships
        WHERE org_id = ?1 AND status = 'active'`,
    v: [orgId],
  });
  return row?.count ?? 0;
}

/** The seat cap in force, or null where seat gating is off. */
async function seatLimit(runtime: CoreRuntime, orgId: string): Promise<number | null> {
  if (!seatGateEnabled(runtime.vars)) return null;
  const row = await first<{ seat_limit: number }>(runtime.db, {
    q: "SELECT seat_limit FROM org_entitlements WHERE org_id = ?1 LIMIT 1",
    v: [orgId],
  });
  return row?.seat_limit ?? FREE_SEAT_LIMIT;
}

/** Whether the organization has no unused seat. Gates read this to name the
 * reason a write was refused; the refusal itself is decided inside the
 * statement. It asks the gate's own predicate rather than re-deriving the
 * comparison, so the message and the refusal cannot disagree. */
export async function seatsExhausted(runtime: CoreRuntime, orgId: string): Promise<boolean> {
  if (!seatGateEnabled(runtime.vars)) return false;
  const free = await first<{ ok: number }>(runtime.db, {
    q: `SELECT 1 AS ok WHERE ${seatAvailable("?1")}`,
    v: [orgId],
  });
  return free === null;
}

/**
 * Claims of the checkout handoff token.
 *
 * A handoff, not an authorization. It says which organization hit which wall
 * and who was standing there; the billing service authenticates the buyer
 * through its own session before it accepts money. `role` is the role the
 * person holds (or, at invite redemption, is being admitted with).
 */
export interface HandoffClaims {
  org: string;
  user: string;
  role: "admin" | "member";
  exp: number;
}

/** Thrown by a seat gate. Rendered as the 402 deny envelope by core/app.ts. */
export class SeatLimitReached extends Error {
  public constructor(readonly paymentUrl: string | null) {
    super(SEAT_LIMIT_MESSAGE);
    this.name = "SeatLimitReached";
  }
}

/** The 402 body. `paymentUrl` is absent where PAYMENT_URL is unset: a
 * deployment with a billing service but no checkout surface still refuses the
 * seat, it just has nowhere to send the person. */
export function seatLimitEnvelope(error: SeatLimitReached): JsonObject {
  if (error.paymentUrl === null) {
    return { error: SEAT_LIMIT_MESSAGE, retryAction: "upgrade" };
  }
  return { error: SEAT_LIMIT_MESSAGE, retryAction: "upgrade", paymentUrl: error.paymentUrl };
}

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** An HS256 JWT signed with ENTITLEMENTS_API_KEY — the same secret the
 * billing service authenticates the write route with, so it can verify this
 * without a second key exchange. WebCrypto only; no dependency. */
export async function handoffToken(secret: string, claims: HandoffClaims): Promise<string> {
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/** Builds the refusal a seat gate throws, minting the checkout link. */
export async function seatLimitReached(
  runtime: CoreRuntime,
  claims: Omit<HandoffClaims, "exp">,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<SeatLimitReached> {
  const key = billingKey(runtime.vars);
  // A base URL is routinely configured with a trailing slash; "//checkout" is
  // a 404 at the worst possible moment.
  const base = (runtime.vars.paymentUrl ?? "").replace(/\/+$/u, "");
  if (key === undefined || base === "") return new SeatLimitReached(null);
  const token = await handoffToken(key, {
    org: claims.org,
    user: claims.user,
    role: claims.role,
    exp: nowSeconds + HANDOFF_TOKEN_TTL_SECONDS,
  });
  return new SeatLimitReached(`${base}/checkout#token=${token}`);
}

/** The billing service, or nobody. An unattached deployment answers 404 rather
 * than 401: the route does not exist there, and saying so is not a hint. */
async function requireBillingCaller(context: CoreContext, runtime: CoreRuntime): Promise<void> {
  const key = billingKey(runtime.vars);
  if (key === undefined) throw new HttpError(404, "not found");
  const presented = bearerToken(context.req.raw);
  if (presented === null || !(await safeEqualSecret(presented, key))) {
    throw new HttpError(401, "unauthorized");
  }
}

export function addEntitlementsRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  // The one write. The billing service turns a plan into these two integers;
  // core never learns which plan produced them.
  router.put("/orgs/:id/entitlements", async (context) => {
    const runtime = runtimeFactory(context);
    await requireBillingCaller(context, runtime);
    const value = await readJson(context.req.raw);
    if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
    const seats = positiveInteger(value.seatLimit, "seatLimit");
    const vms = positiveInteger(value.vmLimit, "vmLimit");
    const orgId = context.req.param("id");
    const now = Date.now();
    // vmLimit lands in orgs.vm_limit, the column core/workspaces.ts has always
    // enforced. Storing it here as well would be a second source of truth for
    // one limit, and the enforcing statement would keep reading the other one.
    const written = await transaction<{ id: string }>(runtime.db, [
      {
        q: `INSERT INTO org_entitlements (org_id, seat_limit, updated_at)
            SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM orgs WHERE id = ?1)
            ON CONFLICT(org_id) DO UPDATE SET
              seat_limit = excluded.seat_limit, updated_at = excluded.updated_at
            RETURNING org_id AS id`,
        v: [orgId, seats, now],
      },
      {
        q: "UPDATE orgs SET vm_limit = ?2, updated_at = ?3 WHERE id = ?1 RETURNING id",
        v: [orgId, vms, now],
      },
    ]);
    if (written[0]?.length !== 1 || written[1]?.length !== 1) {
      throw new HttpError(404, "organization not found");
    }
    return context.body(null, 204);
  });

  // What the limits are and how much of them is used. Session-authed: this is
  // the seat counter a member sees, not a billing read.
  router.get("/orgs/:id/usage", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const orgId = context.req.param("id");
    // 404, not 403: a non-member learns nothing about which organizations
    // exist from this route.
    const org = await first<{ vm_limit: number; vms_used: number }>(runtime.db, {
      q: `SELECT o.vm_limit,
                 (SELECT COUNT(*) FROM workspaces
                  WHERE org_id = o.id AND phase IN (${VM_SLOT_PHASES})) AS vms_used
          FROM orgs o
          WHERE o.id = ?1 AND EXISTS (
            SELECT 1 FROM memberships
            WHERE org_id = o.id AND user_id = ?2 AND status = 'active'
          ) LIMIT 1`,
      v: [orgId, principal.id],
    });
    if (org === null) throw new HttpError(404, "organization not found");
    return context.json({
      seatsUsed: await activeSeats(runtime.db, orgId),
      seatLimit: await seatLimit(runtime, orgId),
      vmsUsed: org.vms_used,
      vmLimit: org.vm_limit,
    });
  });
}
