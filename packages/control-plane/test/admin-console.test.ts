import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminOrgView } from "../core/admin.js";
import { inviteCodeHash } from "../core/identity/invites.js";
import {
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
  userSession,
} from "./helpers.js";

const KEY = "test-entitlements-key";
const BILLING = { ENTITLEMENTS_API_KEY: KEY, PAYMENT_URL: "https://billing.test" };

type App = ReturnType<typeof harness>["app"];

interface AdminOrgsBody {
  orgs: AdminOrgView[];
}

interface TrialOrgBody {
  org: { id: string; slug: string; name: string; vmLimit: number };
  invite: { id: string; email: string | null; role: string; state: string; expiresAt: number };
  code: string;
  ttlDays: number;
  trialExpiresAt: number;
}

interface EntitlementsRow {
  seat_limit: number;
  platform_compute: number;
  trial_expires_at: number | null;
}

async function entitlementsRow(orgId: string): Promise<EntitlementsRow | null> {
  return env.DB.prepare(
    "SELECT seat_limit, platform_compute, trial_expires_at FROM org_entitlements WHERE org_id = ?1",
  ).bind(orgId).first<EntitlementsRow>();
}

async function listOrgs(app: App, cookie: string): Promise<AdminOrgsBody> {
  const response = await appRequest(app, "/admin/orgs", { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  return await response.json() as AdminOrgsBody;
}

async function createTrial(
  app: App,
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return appRequest(app, "/admin/trial-orgs", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("operator console", () => {
  beforeEach(resetDatabase);

  it("refuses anyone but a platform operator", async () => {
    const { app } = harness();
    const anonymous = await appRequest(app, "/admin/orgs");
    expect(anonymous.status).toBe(401);
    const member = await appRequest(app, "/admin/orgs", {
      headers: { Cookie: await userSession("alice") },
    });
    expect(member.status).toBe(403);
    const trial = await createTrial(app, await userSession("bob"), { name: "Nope" });
    expect(trial.status).toBe(403);
  });

  it("lists every organization with members, invites, and workspaces", async () => {
    const { app } = harness();
    const operator = await operatorSession();
    const alice = await userSession("alice");
    // One invite in alice's org, minted through the product route.
    const invited = await appRequest(app, "/invites", {
      method: "POST",
      headers: { Cookie: alice, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member", email: "friend@example.com" }),
    });
    expect(invited.status).toBe(201);
    // One live workspace and one destroyed one; the destroyed row is history,
    // not estate, and must not be listed.
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspaces
         (id, owner_id, org_id, name, phase, revision, machine_type_id, created_at, updated_at)
         VALUES ('ws-live', 'alice', 'alice-org', 'dev box', 'ready', 1, 'fake-4c8g', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO workspaces
         (id, owner_id, org_id, name, phase, revision, machine_type_id, created_at, updated_at)
         VALUES ('ws-gone', 'alice', 'alice-org', 'old box', 'destroyed', 1, 'fake-4c8g', ?1, ?1)`,
      ).bind(now),
    ]);
    const body = await listOrgs(app, operator);
    const names = body.orgs.map((org) => org.slug);
    expect(names).toContain("personal");
    expect(names).toContain("alice-org");
    const aliceOrg = body.orgs.find((org) => org.slug === "alice-org");
    expect(aliceOrg?.createdBy).toBe(null);
    expect(aliceOrg?.seatLimit).toBe(null);
    expect(aliceOrg?.platformCompute).toBe(false);
    expect(aliceOrg?.members).toEqual([
      { email: "alice@example.com", name: "alice", role: "admin", status: "active" },
    ]);
    expect(aliceOrg?.invites).toHaveLength(1);
    expect(aliceOrg?.invites[0]?.email).toBe("friend@example.com");
    expect(aliceOrg?.invites[0]?.state).toBe("ready");
    expect(aliceOrg?.workspaces).toEqual([{
      id: "ws-live",
      name: "dev box",
      phase: "ready",
      machineTypeId: "fake-4c8g",
      credentialSource: "deployment",
      createdAt: now,
    }]);
  });

  it("seeds a sponsored trial organization behind one invite link", async () => {
    const { app } = harness();
    const operator = await operatorSession();
    const before = Date.now();
    const response = await createTrial(app, operator, {
      name: "Prospect Co",
      email: "ceo@prospect.example",
      trialDays: 30,
    });
    expect(response.status).toBe(201);
    const body = await response.json() as TrialOrgBody;
    expect(body.org.slug).toBe("prospect-co");
    expect(body.org.vmLimit).toBe(2);
    expect(body.invite.role).toBe("admin");
    expect(body.invite.email).toBe("ceo@prospect.example");
    expect(body.trialExpiresAt).toBeGreaterThanOrEqual(before + 29 * 24 * 60 * 60 * 1_000);
    // The entitlement row is written in the same transaction: the prospect
    // lands already sponsored, with no billing write anywhere.
    const entitlements = await entitlementsRow(body.org.id);
    expect(entitlements?.platform_compute).toBe(1);
    expect(entitlements?.seat_limit).toBe(5);
    expect(entitlements?.trial_expires_at).toBe(body.trialExpiresAt);
    // The returned code is the real invite: its hash is the stored row, and
    // the public landing view resolves it to the new organization.
    const hash = await inviteCodeHash(body.code);
    const stored = await env.DB.prepare(
      "SELECT id FROM invites WHERE code_hash = ?1",
    ).bind(hash).first<{ id: string }>();
    expect(stored?.id).toBe(body.invite.id);
    const landing = await appRequest(app, `/invite/${body.code}`);
    expect(landing.status).toBe(200);
    const landingBody = await landing.json() as { invite: { org: { name: string } } };
    expect(landingBody.invite.org.name).toBe("Prospect Co");
    // The console reports the trial as such.
    const listed = await listOrgs(app, operator);
    const trialOrg = listed.orgs.find((org) => org.id === body.org.id);
    expect(trialOrg?.platformCompute).toBe(true);
    expect(trialOrg?.trialExpiresAt).toBe(body.trialExpiresAt);
  });

  it("ends an expired trial when the console reads it", async () => {
    const { app } = harness();
    const operator = await operatorSession();
    const created = await createTrial(app, operator, { name: "Sleepy" });
    const body = await (created.json() as Promise<TrialOrgBody>);
    await env.DB.prepare(
      "UPDATE org_entitlements SET trial_expires_at = ?2 WHERE org_id = ?1",
    ).bind(body.org.id, Date.now() - 1_000).run();
    const listed = await listOrgs(app, operator);
    const org = listed.orgs.find((item) => item.id === body.org.id);
    // Sponsorship is gone; the clock stays as the record that it ran out.
    expect(org?.platformCompute).toBe(false);
    expect(org?.trialExpiresAt).not.toBe(null);
    const entitlements = await entitlementsRow(body.org.id);
    expect(entitlements?.platform_compute).toBe(0);
  });

  it("lets a billing write supersede the trial clock", async () => {
    const { app } = harness();
    const operator = await operatorSession();
    const created = await createTrial(app, operator, { name: "Converted" });
    const body = await (created.json() as Promise<TrialOrgBody>);
    const paid = await appRequest(app, `/orgs/${body.org.id}/entitlements`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ seatLimit: 10, vmLimit: 10, platformCompute: true }),
    }, BILLING);
    expect(paid.status).toBe(204);
    const entitlements = await entitlementsRow(body.org.id);
    expect(entitlements?.trial_expires_at).toBe(null);
    expect(entitlements?.platform_compute).toBe(1);
    expect(entitlements?.seat_limit).toBe(10);
  });

  it("caps the trial length", async () => {
    const { app } = harness();
    const operator = await operatorSession();
    const response = await createTrial(app, operator, { name: "Forever", trialDays: 91 });
    expect(response.status).toBe(400);
  });
});
