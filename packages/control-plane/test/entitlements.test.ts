import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seatAvailable } from "../core/entitlements.js";
import { inviteCodeHash } from "../core/identity/invites.js";
import {
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
  sameOrgSession,
  userSession,
} from "./helpers.js";

const KEY = "test-entitlements-key";

/** The two bindings this seam adds, overridden per request the way the Worker
 * would receive them. */
interface BillingBindings {
  ENTITLEMENTS_API_KEY?: string;
  PAYMENT_URL?: string;
}

const BILLING = { ENTITLEMENTS_API_KEY: KEY, PAYMENT_URL: "https://billing.test" };

type App = ReturnType<typeof harness>["app"];

function oauthCookie(setCookie: string): string {
  const match = setCookie.match(/blitz_google_oauth=([^;]+)/u);
  if (match?.[1] === undefined) throw new Error("OAuth cookie missing");
  return `blitz_google_oauth=${match[1]}`;
}

/** A real sign-in that redeems an invite code, which is the only way to reach
 * the redemption statements the way a person does. */
async function redeem(
  app: App,
  email: string,
  code: string,
  bindings: BillingBindings,
): Promise<Response> {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "google-token" }))
    .mockResolvedValueOnce(Response.json({
      sub: `sub-${email}`,
      email,
      email_verified: true,
      name: `Google ${email}`,
      picture: "https://images.example/avatar.png",
    }));
  const start = await appRequest(app, `/auth/google/start?invite=${code}`, undefined, bindings);
  const location = new URL(start.headers.get("location") ?? "");
  return appRequest(
    app,
    `/auth/google/callback?code=code&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`,
    { headers: { Cookie: oauthCookie(start.headers.get("set-cookie") ?? "") } },
    bindings,
  );
}

async function mintInvite(app: App, cookie: string, bindings: BillingBindings) {
  const response = await appRequest(app, "/invites", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "member" }),
  }, bindings);
  return { status: response.status, body: await response.json<{ code?: string; error?: string }>() };
}

async function setLimits(
  app: App,
  orgId: string,
  seatLimit: number,
  vmLimit = 10,
): Promise<number> {
  const response = await appRequest(app, `/orgs/${orgId}/entitlements`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ seatLimit, vmLimit }),
  }, BILLING);
  return response.status;
}

async function activeCount(orgId: string): Promise<number> {
  return (await env.DB
    .prepare("SELECT COUNT(*) AS count FROM memberships WHERE org_id = ?1 AND status = 'active'")
    .bind(orgId)
    .first<number>("count")) ?? 0;
}

async function inviteState(code: string): Promise<string | null> {
  return env.DB
    .prepare("SELECT state FROM invites WHERE code_hash = ?1")
    .bind(await inviteCodeHash(code))
    .first<string>("state");
}

describe("entitlements", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe("with no billing service attached", () => {
    it("keeps the write route invisible and every gate open", async () => {
      const { app } = harness();
      const admin = await operatorSession(app);
      // One active member and no entitlements row: the very state that is
      // "free tier, full" once a key exists.
      expect(await activeCount("personal")).toBe(1);

      const write = await appRequest(app, "/orgs/personal/entitlements", {
        method: "PUT",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ seatLimit: 9, vmLimit: 9 }),
      });
      expect(write.status).toBe(404);
      expect(await write.json()).toEqual({ error: "not found", retryAction: null });

      const invite = await mintInvite(app, admin, {});
      expect(invite.status).toBe(201);
      expect(invite.body.code).toMatch(/^[A-Za-z0-9_-]{43}$/u);

      const disabled = await sameOrgSession("erin", "member", "disabled");
      const reactivated = await appRequest(app, `/members/${disabled.membershipId}`, {
        method: "PATCH",
        headers: { Cookie: admin, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      expect(reactivated.status).toBe(200);
      expect(await activeCount("personal")).toBe(2);
    });

    it("reports usage with a null seat limit", async () => {
      const { app } = harness();
      const owner = await userSession("dana");
      const usage = await appRequest(app, "/orgs/dana-org/usage", { headers: { Cookie: owner } });
      expect(await usage.json()).toEqual({
        seatsUsed: 1,
        seatLimit: null,
        vmsUsed: 0,
        vmLimit: 10,
      });
    });
  });

  describe("the write route", () => {
    it("refuses a wrong key and answers 404 for an organization that is not there", async () => {
      const { app } = harness();
      await operatorSession(app);
      const wrongKey = await appRequest(app, "/orgs/personal/entitlements", {
        method: "PUT",
        headers: { Authorization: "Bearer not-the-key", "Content-Type": "application/json" },
        body: JSON.stringify({ seatLimit: 3, vmLimit: 3 }),
      }, BILLING);
      expect(wrongKey.status).toBe(401);
      const noKey = await appRequest(app, "/orgs/personal/entitlements", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seatLimit: 3, vmLimit: 3 }),
      }, BILLING);
      expect(noKey.status).toBe(401);
      expect(await setLimits(app, "no-such-org", 3)).toBe(404);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM org_entitlements").first<number>("count"),
      ).toBe(0);
    });

    it("overwrites both numbers on a second write", async () => {
      const { app } = harness();
      await operatorSession(app);
      expect(await setLimits(app, "personal", 3, 12)).toBe(204);
      expect(await setLimits(app, "personal", 7, 30)).toBe(204);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM org_entitlements").first<number>("count"),
      ).toBe(1);
      expect(
        await env.DB.prepare("SELECT seat_limit FROM org_entitlements WHERE org_id = 'personal'")
          .first<number>("seat_limit"),
      ).toBe(7);
      expect(
        await env.DB.prepare("SELECT vm_limit FROM orgs WHERE id = 'personal'").first<number>("vm_limit"),
      ).toBe(30);
    });
  });

  describe("the seat predicate", () => {
    // The gates embed this fragment in the statement that grants the seat.
    // Evaluated on its own here, against the real database, it is the thing
    // being trusted: no scheduler involved, just the question the statement
    // asks at the moment it writes.
    it("is false exactly when every seat is taken", async () => {
      const { app } = harness();
      await operatorSession(app);
      const ask = async () =>
        env.DB.prepare(`SELECT 1 AS ok WHERE ${seatAvailable("?1")}`).bind("personal").first();

      // One active member, no row: the free tier is one seat, so it is full.
      expect(await ask()).toBeNull();
      expect(await setLimits(app, "personal", 2)).toBe(204);
      expect(await ask()).toEqual({ ok: 1 });
      await sameOrgSession("bob");
      expect(await activeCount("personal")).toBe(2);
      expect(await ask()).toBeNull();
      // A disabled member holds no seat.
      await env.DB.prepare("UPDATE memberships SET status = 'disabled' WHERE id = 'bob-membership'").run();
      expect(await ask()).toEqual({ ok: 1 });
    });
  });

  describe("the three gates", () => {
    it("refuses to mint an invite the organization has no seat for", async () => {
      const { app } = harness();
      const admin = await operatorSession(app);
      const denied = await mintInvite(app, admin, BILLING);
      expect(denied.status).toBe(402);
      expect(denied.body.error).toBe("seat limit reached");
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM invites").first<number>("count"),
      ).toBe(0);

      expect(await setLimits(app, "personal", 2)).toBe(204);
      expect((await mintInvite(app, admin, BILLING)).status).toBe(201);
    });

    it("refuses a stockpiled code to a person who has never been a member", async () => {
      const { app } = harness();
      const admin = await operatorSession(app);
      expect(await setLimits(app, "personal", 2)).toBe(204);
      const first = await mintInvite(app, admin, BILLING);
      const stockpiled = await mintInvite(app, admin, BILLING);
      expect((await redeem(app, "bob@example.com", first.body.code ?? "", BILLING)).status).toBe(302);
      expect(await activeCount("personal")).toBe(2);

      const refused = await redeem(app, "carol@example.com", stockpiled.body.code ?? "", BILLING);
      expect(refused.status).toBe(402);
      expect(await activeCount("personal")).toBe(2);
      expect(await inviteState(stockpiled.body.code ?? "")).toBe("ready");
      // The sign-in created no account it could not admit.
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'carol@example.com'")
          .first<number>("count"),
      ).toBe(0);
    });

    // The trapdoor. Gating invite creation alone is bypassable: mint codes
    // while seats are free, then redeem them once they are not. Redemption
    // reaches a disabled member through ON CONFLICT DO UPDATE, which is the
    // branch that turns an old code into a seat nobody paid for.
    it("blocks a stockpiled code from re-activating a disabled member, and keeps the code", async () => {
      const { app } = harness();
      const admin = await operatorSession(app);
      expect(await setLimits(app, "personal", 2)).toBe(204);

      // Two codes minted while the second seat is still free.
      const first = await mintInvite(app, admin, BILLING);
      const stockpiled = await mintInvite(app, admin, BILLING);
      expect(first.status).toBe(201);
      expect(stockpiled.status).toBe(201);
      const stockpiledCode = stockpiled.body.code ?? "";

      // Bob takes the second seat, then loses it.
      expect((await redeem(app, "bob@example.com", first.body.code ?? "", BILLING)).status).toBe(302);
      expect(await activeCount("personal")).toBe(2);
      const bobMembership = await env.DB.prepare(
        "SELECT id FROM memberships WHERE org_id = 'personal' AND user_id != 'operator'",
      ).first<string>("id");
      await env.DB.prepare("UPDATE memberships SET status = 'disabled' WHERE id = ?1")
        .bind(bobMembership).run();
      expect(await activeCount("personal")).toBe(1);

      // Carol takes the freed seat. The organization is full again.
      const carolInvite = await mintInvite(app, admin, BILLING);
      expect((await redeem(app, "carol@example.com", carolInvite.body.code ?? "", BILLING)).status)
        .toBe(302);
      expect(await activeCount("personal")).toBe(2);

      // Bob comes back with the code he was holding.
      const refused = await redeem(app, "bob@example.com", stockpiledCode, BILLING);
      expect(refused.status).toBe(402);
      expect(await refused.json()).toMatchObject({
        error: "seat limit reached",
        retryAction: "upgrade",
      });
      expect(await activeCount("personal")).toBe(2);
      expect(
        await env.DB.prepare("SELECT status FROM memberships WHERE id = ?1").bind(bobMembership)
          .first<string>("status"),
      ).toBe("disabled");
      // The refusal must not spend the code either: burning it while admitting
      // nobody would lose the invite to a limit that may lift tomorrow.
      expect(await inviteState(stockpiledCode)).toBe("ready");

      // One more seat, and the same code works.
      expect(await setLimits(app, "personal", 3)).toBe(204);
      expect((await redeem(app, "bob@example.com", stockpiledCode, BILLING)).status).toBe(302);
      expect(await activeCount("personal")).toBe(3);
      expect(await inviteState(stockpiledCode)).toBe("redeemed");
    });

    it("refuses to re-activate a member past the limit, and never touches the others", async () => {
      const { app } = harness();
      const admin = await operatorSession(app);
      expect(await setLimits(app, "personal", 2)).toBe(204);
      const bob = await sameOrgSession("bob");
      const erin = await sameOrgSession("erin", "member", "disabled");
      expect(await activeCount("personal")).toBe(2);

      const denied = await appRequest(app, `/members/${erin.membershipId}`, {
        method: "PATCH",
        headers: { Cookie: admin, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      }, BILLING);
      expect(denied.status).toBe(402);
      expect(await denied.json()).toMatchObject({ error: "seat limit reached" });
      expect(await activeCount("personal")).toBe(2);

      // A full organization can still change an active member's role: that is
      // not growth, so it never asks for a seat.
      const promoted = await appRequest(app, `/members/${bob.membershipId}`, {
        method: "PATCH",
        headers: { Cookie: admin, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      }, BILLING);
      expect(promoted.status).toBe(200);
      expect(await activeCount("personal")).toBe(2);

      // And it can still shrink.
      const disabled = await appRequest(app, `/members/${bob.membershipId}`, {
        method: "PATCH",
        headers: { Cookie: admin, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "disabled" }),
      }, BILLING);
      expect(disabled.status).toBe(200);
      expect(await activeCount("personal")).toBe(1);
    });
  });

  describe("a downgrade below the seats already in use", () => {
    it("blocks growth and disables nobody", async () => {
      const { app } = harness();
      const admin = await operatorSession(app);
      await sameOrgSession("bob");
      await sameOrgSession("carol");
      expect(await activeCount("personal")).toBe(3);

      expect(await setLimits(app, "personal", 1)).toBe(204);
      expect(await activeCount("personal")).toBe(3);
      expect((await mintInvite(app, admin, BILLING)).status).toBe(402);
      expect(await activeCount("personal")).toBe(3);

      const usage = await appRequest(app, "/orgs/personal/usage", {
        headers: { Cookie: admin },
      }, BILLING);
      expect(await usage.json()).toMatchObject({ seatsUsed: 3, seatLimit: 1 });
    });
  });

  describe("the usage route", () => {
    it("answers a member of the organization and nobody else", async () => {
      const { app } = harness();
      const admin = await operatorSession(app);
      const outsider = await userSession("dana");
      expect((await appRequest(app, "/orgs/personal/usage", { headers: { Cookie: outsider } })).status)
        .toBe(404);
      expect((await appRequest(app, "/orgs/no-such-org/usage", { headers: { Cookie: admin } })).status)
        .toBe(404);
      expect((await appRequest(app, "/orgs/personal/usage")).status).toBe(401);
    });

    it("resolves self to the organization the session is scoped to", async () => {
      const { app } = harness();
      const admin = await operatorSession(app);
      const byId = await appRequest(app, "/orgs/personal/usage", { headers: { Cookie: admin } });
      const bySelf = await appRequest(app, "/orgs/self/usage", { headers: { Cookie: admin } });
      expect(bySelf.status).toBe(200);
      expect(await bySelf.json()).toEqual(await byId.json());
    });
  });

  describe("the billing links", () => {
    it("mints one hop an admin can follow into the billing service", async () => {
      const { app } = harness();
      const admin = await operatorSession(app);

      const response = await appRequest(app, "/orgs/self/billing", {
        headers: { Cookie: admin, Referer: "https://cp.example/settings/invites" },
      }, BILLING);
      expect(response.status).toBe(200);
      const billing = await response.json<{ url: string }>();

      const token = new URL(billing.url).hash.slice("#token=".length);
      // One destination. The billing service reads the hop and decides whether
      // this organization is buying or managing what it already bought.
      expect(billing.url).toBe(`https://billing.test/checkout#token=${token}`);

      const claims = JSON.parse(
        atob((token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/")),
      ) as { org: string; role: string; returnTo: string };
      expect(claims.org).toBe("personal");
      expect(claims.role).toBe("admin");
      // The page they left, so Checkout returns them to it.
      expect(claims.returnTo).toBe("/settings/invites");
    });

    it("refuses a member, because the billing service would refuse the token", async () => {
      const { app } = harness();
      await operatorSession(app);
      const member = await sameOrgSession("erin", "member");
      const response = await appRequest(app, "/orgs/self/billing", {
        headers: { Cookie: member.cookie },
      }, BILLING);
      expect(response.status).toBe(403);
    });

    it("does not exist where no billing service is attached", async () => {
      const { app } = harness();
      const admin = await operatorSession(app);
      expect((await appRequest(app, "/orgs/self/billing", { headers: { Cookie: admin } })).status)
        .toBe(404);
      // A key without a checkout surface is the same answer: there is nowhere
      // to send a person, so there is no link to give them.
      expect((await appRequest(app, "/orgs/self/billing", {
        headers: { Cookie: admin },
      }, { ENTITLEMENTS_API_KEY: KEY })).status).toBe(404);
    });
  });
});
