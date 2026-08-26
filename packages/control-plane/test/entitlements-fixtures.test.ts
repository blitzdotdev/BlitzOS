import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../core/http.js";
import { handoffToken, type HandoffClaims } from "../core/entitlements.js";
import { appRequest, harness, operatorSession, resetDatabase, userSession } from "./helpers.js";

/** The control-plane half of the entitlements contract. The private billing
 * service copies packages/schema/fixtures/entitlements/ verbatim and reads the
 * same files, so a field renamed on one side fails here rather than turning
 * into a checkout page nobody can reach. */

interface FixtureContext {
  entitlementsApiKey: string;
  paymentUrl: string;
  controlPlaneOrigin: string;
  returnTo: string;
  issuedAtSeconds: number;
}

interface WriteRequest {
  body: JsonObject;
  status: number;
}

interface RejectedWriteRequests {
  status: number;
  cases: Array<{ note: string; body: JsonValue }>;
}

interface SeatLimitDenial {
  status: number;
  body: JsonObject;
  withoutPaymentUrl: JsonObject;
}

interface UsageResponse {
  body: JsonObject;
  gatingOff: JsonObject;
}

const sources = import.meta.glob<string>("../../schema/fixtures/entitlements/*.json", {
  eager: true,
  import: "default",
  query: "?raw",
});

function fixture<Value>(name: string): Value {
  const source = sources[`../../schema/fixtures/entitlements/${name}`];
  if (source === undefined) throw new Error(`missing fixture: ${name}`);
  // SAFETY: Each fixture is read into the interface written for that file, and
  // every field the interface names is asserted against a live response below;
  // a corpus that stopped matching fails in this suite rather than silently.
  return JSON.parse(source) as Value;
}

const context = fixture<FixtureContext>("context.json");
const write = fixture<WriteRequest>("write-request.json");
const rejected = fixture<RejectedWriteRequests>("write-request-rejected.json");
const denial = fixture<SeatLimitDenial>("seat-limit-denial.json");
const claims = fixture<{ claims: HandoffClaims }>("handoff-claims.json").claims;
const usage = fixture<UsageResponse>("usage.json");

const billing = {
  ENTITLEMENTS_API_KEY: context.entitlementsApiKey,
  PAYMENT_URL: context.paymentUrl,
};

function billingWrite(body: JsonValue): RequestInit {
  return {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${context.entitlementsApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

describe("entitlements fixture conformance", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("accepts the written body and stores each number exactly once", async () => {
    const { app } = harness();
    await operatorSession(app);
    const response = await appRequest(
      app,
      "/orgs/personal/entitlements",
      billingWrite(write.body),
      billing,
    );
    expect(response.status).toBe(write.status);
    expect(await response.text()).toBe("");
    expect(
      await env.DB.prepare("SELECT seat_limit FROM org_entitlements WHERE org_id = 'personal'")
        .first<number>("seat_limit"),
    ).toBe(write.body.seatLimit);
    expect(
      await env.DB.prepare("SELECT vm_limit FROM orgs WHERE id = 'personal'")
        .first<number>("vm_limit"),
    ).toBe(write.body.vmLimit);
    // vmLimit lives in orgs.vm_limit and nowhere else. A second copy would be
    // a second answer to one question, and the enforcing statement in
    // core/workspaces.ts reads the orgs column.
    const columns = await env.DB.prepare("PRAGMA table_info(org_entitlements)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      "org_id",
      "seat_limit",
      "updated_at",
    ]);
  });

  for (const rejectedCase of rejected.cases) {
    it(`refuses the write: ${rejectedCase.note}`, async () => {
      const { app } = harness();
      await operatorSession(app);
      const response = await appRequest(
        app,
        "/orgs/personal/entitlements",
        billingWrite(rejectedCase.body),
        billing,
      );
      expect(response.status).toBe(rejected.status);
    });
  }

  it("mints the exact checkout link the denial fixture carries", async () => {
    const token = await handoffToken(context.entitlementsApiKey, claims);
    expect(claims.exp - context.issuedAtSeconds).toBe(15 * 60);
    expect(denial.body.paymentUrl).toBe(`${context.paymentUrl}/checkout#token=${token}`);
  });

  it("answers the denial fixture when the second person is invited", async () => {
    const { app } = harness();
    const admin = await operatorSession(app);
    const response = await appRequest(app, "/invites", {
      method: "POST",
      headers: {
        Cookie: admin,
        "Content-Type": "application/json",
        Referer: `${context.controlPlaneOrigin}${context.returnTo}`,
      },
      body: JSON.stringify({ role: "member" }),
    }, { ...billing, APP_URL: context.controlPlaneOrigin });
    expect(response.status).toBe(denial.status);
    const body = await response.json<JsonObject>();
    expect(Object.keys(body).sort()).toEqual(Object.keys(denial.body).sort());
    expect(body.error).toBe(denial.body.error);
    expect(body.retryAction).toBe(denial.body.retryAction);
    expect(body.paymentUrl).toMatch(
      new RegExp(`^${context.paymentUrl}/checkout#token=[\\w-]+\\.[\\w-]+\\.[\\w-]+$`, "u"),
    );
    if (typeof body.paymentUrl !== "string") throw new Error("denial omitted paymentUrl");
    const encodedPayload = new URL(body.paymentUrl).hash.split(".")[1];
    if (encodedPayload === undefined) throw new Error("handoff token omitted its payload");
    const payload = encodedPayload.replaceAll("-", "+").replaceAll("_", "/");
    expect(JSON.parse(atob(payload))).toMatchObject({
      controlPlaneOrigin: context.controlPlaneOrigin,
      returnTo: context.returnTo,
    });
  });

  it("drops paymentUrl, and nothing else, when no checkout surface is configured", async () => {
    const { app } = harness();
    const admin = await operatorSession(app);
    const response = await appRequest(app, "/invites", {
      method: "POST",
      headers: { Cookie: admin, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    }, { ENTITLEMENTS_API_KEY: context.entitlementsApiKey, PAYMENT_URL: "" });
    expect(response.status).toBe(denial.status);
    expect(await response.json()).toEqual(denial.withoutPaymentUrl);
  });

  it("reports usage in the fixture's fields with gating on and off", async () => {
    const { app } = harness();
    const owner = await userSession("dana");
    await appRequest(
      app,
      "/orgs/dana-org/entitlements",
      billingWrite({ seatLimit: usage.body.seatLimit, vmLimit: usage.body.vmLimit }),
      billing,
    );
    const gated = await appRequest(app, "/orgs/dana-org/usage", {
      headers: { Cookie: owner },
    }, billing);
    expect(gated.status).toBe(200);
    expect(await gated.json()).toEqual({
      seatsUsed: 1,
      seatLimit: usage.body.seatLimit,
      vmsUsed: 0,
      vmLimit: usage.body.vmLimit,
    });
    const ungated = await appRequest(app, "/orgs/dana-org/usage", { headers: { Cookie: owner } });
    expect(await ungated.json()).toEqual({
      seatsUsed: 1,
      seatLimit: null,
      vmsUsed: 0,
      vmLimit: usage.body.vmLimit,
    });
    expect(Object.keys(usage.gatingOff).sort()).toEqual(Object.keys(usage.body).sort());
  });
});
