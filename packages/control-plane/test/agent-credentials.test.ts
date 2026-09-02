import type {
  AgentCredentialsResponse,
  AgentCredentialTokenResponse,
  ImportOrgCredentialsResponse,
  PutOrgCredentialResponse,
  WorkspaceView,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
  sameOrgSession,
  workspacePhoneHomeUrl,
} from "./helpers.js";

const LINEAR_KEY = "lin_api_test-only-personal-key";

type Harness = ReturnType<typeof harness>;

function json(body: object, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function createWorkspaceWith(
  app: Harness["app"],
  cookie: string,
  body: Record<string, unknown> = {},
): Promise<WorkspaceView> {
  const created = await appRequest(app, "/workspaces", {
    ...json({ machineTypeId: "small", ...body }),
    headers: { Cookie: cookie, "Content-Type": "application/json" },
  });
  expect(created.status).toBe(201);
  return (await created.json<{ workspace: WorkspaceView }>()).workspace;
}

/** One member's machine credential, through the machine's own phone-home. */
async function machineToken(
  app: Harness["app"],
  providers: Harness["providers"],
  workspaceId: string,
  membershipId = "personal",
): Promise<string> {
  const url = await workspacePhoneHomeUrl(providers, workspaceId, membershipId);
  const ready = await appRequest(app, new URL(url).pathname, {
    ...json({ pub_key_ed25519: "ssh-ed25519 AAAAhost" }),
  });
  expect(ready.status).toBe(200);
  return (await ready.json<{ access_token: string }>()).access_token;
}

async function storeOrgCredential(
  app: Harness["app"],
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return appRequest(app, "/orgs/self/credentials", {
    ...json(body, "PUT"),
    headers: { Cookie: cookie, "Content-Type": "application/json" },
  });
}

async function replaceGrants(
  app: Harness["app"],
  cookie: string,
  name: string,
  grants: object[],
): Promise<Response> {
  return appRequest(app, `/orgs/self/credentials/${name}/grants`, {
    ...json({ grants }, "PUT"),
    headers: { Cookie: cookie, "Content-Type": "application/json" },
  });
}

async function pull(
  app: Harness["app"],
  token: string,
  name: string,
): Promise<Response> {
  return appRequest(app, `/agent/credentials/${name}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function list(
  app: Harness["app"],
  token: string,
): Promise<AgentCredentialsResponse["credentials"]> {
  const response = await appRequest(app, "/agent/credentials", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json<AgentCredentialsResponse>()).credentials;
}

describe("agent credentials (plans/ORG-CREDENTIALS.md §4)", () => {
  beforeEach(resetDatabase);

  it("lists both planes and serves both tiers through the one token door", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    // The personal plane: a connection in the ceiling, backed by a grant.
    expect((await appRequest(app, "/connections/grants/linear", {
      ...json({ manifestId: "linear", token: LINEAR_KEY }, "PUT"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(204);
    const workspace = await createWorkspaceWith(app, cookie, {
      manifest: { integrations: { linear: {} } },
    });
    // The org plane: one stored static.
    expect((await storeOrgCredential(app, cookie, {
      name: "STRIPE_API_KEY",
      value: "sk_live_value",
      comment: "billing key",
    })).status).toBe(201);
    const token = await machineToken(app, providers, workspace.id);

    // Both planes on one list: connection names from the manifest, org names
    // the member may read. The operator is an org admin, so writable is true.
    await expect(list(app, token)).resolves.toEqual([
      { name: "STRIPE_API_KEY", scope: "org", comment: "billing key", writable: true },
      { name: "linear", scope: "connection", comment: null, writable: false },
    ]);

    // Tier 2: the static org credential has no invented HTTP presentation or expiry.
    const orgPull = await pull(app, token, "STRIPE_API_KEY");
    expect(orgPull.status).toBe(200);
    const orgResult = await orgPull.json<AgentCredentialTokenResponse>();
    expect(orgResult).toEqual({
      name: "STRIPE_API_KEY",
      scope: "org",
      token: "sk_live_value",
      env: [{ name: "STRIPE_API_KEY", value: "sk_live_value" }],
    });
    // The lease-less use row: audit without a connection row to hang it on.
    const used = await env.DB.prepare(
      `SELECT detail FROM credential_events
       WHERE event = 'minted' AND lease_id IS NULL
         AND detail LIKE '%org_credential%' LIMIT 1`,
    ).first<{ detail: string }>();
    // SAFETY: recordOrgCredentialUse wrote this row and serializes an object.
    expect(JSON.parse(used?.detail ?? "{}")).toMatchObject({
      org_credential: "STRIPE_API_KEY",
      workspace_id: workspace.id,
    });

    // Tier 1: the personal connection grant, minted exactly as before, worn
    // in the same envelope. Proxy custody: the personal key never crosses.
    const linearPull = await pull(app, token, "linear");
    expect(linearPull.status).toBe(200);
    const linearResult = await linearPull.json<AgentCredentialTokenResponse>();
    expect(linearResult.name).toBe("linear");
    expect(linearResult.scope).toBe("connection");
    expect(linearResult.token).not.toBe(LINEAR_KEY);
    expect(JSON.stringify(linearResult)).not.toContain(LINEAR_KEY);

    // A rotation is visible on the very next read — no sync, no restart.
    expect((await storeOrgCredential(app, cookie, {
      name: "STRIPE_API_KEY",
      value: "sk_rotated_value",
    })).status).toBe(200);
    await expect(pull(app, token, "STRIPE_API_KEY").then((r) => r.json()))
      .resolves.toMatchObject({ token: "sk_rotated_value" });
  });

  it("grades machine reads by workspace and membership grants, filing misses", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const member = await sameOrgSession("agent-member");
    const workspaceA = await createWorkspaceWith(app, cookie, {
      members: [{ membershipId: member.membershipId, role: "member" }],
    });
    const workspaceB = await createWorkspaceWith(app, cookie, {
      members: [{ membershipId: member.membershipId, role: "member" }],
    });
    expect((await storeOrgCredential(app, cookie, {
      name: "WS_KEY", value: "ws-value",
    })).status).toBe(201);
    expect((await storeOrgCredential(app, cookie, {
      name: "ME_KEY", value: "me-value",
    })).status).toBe(201);
    const memberTokenA = await machineToken(app, providers, workspaceA.id, member.membershipId);
    const memberTokenB = await machineToken(app, providers, workspaceB.id, member.membershipId);
    const adminToken = await machineToken(app, providers, workspaceA.id);

    // No grant covers the member yet: the miss files a request the person can
    // answer, and the 404 names it.
    const refused = await pull(app, memberTokenA, "WS_KEY");
    expect(refused.status).toBe(404);
    const refusal = await refused.json<{ error: string; request_id: string }>();
    expect(refusal.request_id).toMatch(/./u);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM credential_requests WHERE connection_name = 'WS_KEY'",
    ).first<number>("count")).toBe(1);

    // A workspace grant serves every member machine in THAT workspace.
    expect((await replaceGrants(app, cookie, "WS_KEY", [
      { subjectKind: "workspace", subjectId: workspaceA.id, access: "read" },
    ])).status).toBe(200);
    await expect(pull(app, memberTokenA, "WS_KEY").then((r) => r.json()))
      .resolves.toMatchObject({ token: "ws-value", scope: "org" });
    // Readable, not writable, on the list.
    await expect(list(app, memberTokenA)).resolves.toEqual([
      { name: "WS_KEY", scope: "org", comment: null, writable: false },
    ]);
    // The same member's machine in an UNGRANTED workspace stays refused.
    expect((await pull(app, memberTokenB, "WS_KEY")).status).toBe(404);

    // A membership grant follows the person onto any of their machines.
    expect((await replaceGrants(app, cookie, "ME_KEY", [
      { subjectKind: "membership", subjectId: member.membershipId, access: "read" },
    ])).status).toBe(200);
    await expect(pull(app, memberTokenA, "ME_KEY").then((r) => r.json()))
      .resolves.toMatchObject({ token: "me-value" });
    await expect(pull(app, memberTokenB, "ME_KEY").then((r) => r.json()))
      .resolves.toMatchObject({ token: "me-value" });

    // An org admin's machine reads everything, no grant row anywhere.
    await expect(pull(app, adminToken, "WS_KEY").then((r) => r.json()))
      .resolves.toMatchObject({ token: "ws-value" });
    await expect(pull(app, adminToken, "ME_KEY").then((r) => r.json()))
      .resolves.toMatchObject({ token: "me-value" });
  });

  it("gives nothing to a machine whose member left the org", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const member = await sameOrgSession("leaver");
    const workspace = await createWorkspaceWith(app, cookie, {
      members: [{ membershipId: member.membershipId, role: "member" }],
    });
    expect((await storeOrgCredential(app, cookie, {
      name: "ORG_WIDE_KEY", value: "for-everyone",
    })).status).toBe(201);
    expect((await replaceGrants(app, cookie, "ORG_WIDE_KEY", [
      { subjectKind: "org", subjectId: null, access: "read" },
    ])).status).toBe(200);
    const token = await machineToken(app, providers, workspace.id, member.membershipId);
    expect((await pull(app, token, "ORG_WIDE_KEY")).status).toBe(200);

    // The membership dies; the machine credential survives — and resolves to
    // nobody, so even an org-wide grant serves nothing (§6).
    await env.DB.prepare("UPDATE memberships SET status = 'disabled' WHERE id = ?1")
      .bind(member.membershipId).run();
    expect((await pull(app, token, "ORG_WIDE_KEY")).status).toBe(404);
    await expect(list(app, token)).resolves.toEqual([]);
  });

  it("creates and rotates through PUT, gating rotation on write", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const author = await sameOrgSession("author");
    const rival = await sameOrgSession("rival");
    const workspace = await createWorkspaceWith(app, cookie, {
      members: [
        { membershipId: author.membershipId, role: "member" },
        { membershipId: rival.membershipId, role: "member" },
      ],
    });
    const authorToken = await machineToken(app, providers, workspace.id, author.membershipId);
    const rivalToken = await machineToken(app, providers, workspace.id, rival.membershipId);

    // Any active member may create; the creator's write grant arrives with it.
    const created = await appRequest(app, "/agent/credentials/TEAM_KEY", {
      ...json({ value: "v1", comment: "the team's key" }, "PUT"),
      headers: { Authorization: `Bearer ${authorToken}` },
    });
    expect(created.status).toBe(201);
    expect((await created.json<PutOrgCredentialResponse>()).credential.grants).toEqual([
      { subjectKind: "membership", subjectId: author.membershipId, access: "write" },
    ]);
    await expect(list(app, authorToken)).resolves.toEqual([
      { name: "TEAM_KEY", scope: "org", comment: "the team's key", writable: true },
    ]);

    // No grant covers the rival: they cannot see it, read it, or rotate it.
    await expect(list(app, rivalToken)).resolves.toEqual([]);
    expect((await pull(app, rivalToken, "TEAM_KEY")).status).toBe(404);
    expect((await appRequest(app, "/agent/credentials/TEAM_KEY", {
      ...json({ value: "hijacked" }, "PUT"),
      headers: { Authorization: `Bearer ${rivalToken}` },
    })).status).toBe(403);

    // Rotate keeps the comment (tri-state) and answers on the next read.
    const rotated = await appRequest(app, "/agent/credentials/TEAM_KEY", {
      ...json({ value: "v2" }, "PUT"),
      headers: { Authorization: `Bearer ${authorToken}` },
    });
    expect(rotated.status).toBe(200);
    expect((await rotated.json<PutOrgCredentialResponse>()).credential.comment)
      .toBe("the team's key");
    await expect(pull(app, authorToken, "TEAM_KEY").then((r) => r.json()))
      .resolves.toMatchObject({ token: "v2" });

    expect((await appRequest(app, "/agent/credentials/1BAD_NAME", {
      ...json({ value: "x" }, "PUT"),
      headers: { Authorization: `Bearer ${authorToken}` },
    })).status).toBe(400);
  });

  it("imports a dotenv through the agent door", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const member = await sameOrgSession("env-importer");
    const workspace = await createWorkspaceWith(app, cookie, {
      members: [{ membershipId: member.membershipId, role: "member" }],
    });
    const token = await machineToken(app, providers, workspace.id, member.membershipId);

    const imported = await appRequest(app, "/agent/credentials/dotenv", {
      ...json({ text: "A_KEY=alpha\nB_KEY=beta\nbroken\n" }),
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(imported.status).toBe(200);
    expect((await imported.json<ImportOrgCredentialsResponse>()).results).toEqual([
      { name: "A_KEY", line: 1, outcome: "stored" },
      { name: "B_KEY", line: 2, outcome: "stored" },
      { name: "broken", line: 3, outcome: "refused", reason: "not a NAME=value line" },
    ]);
    // The importer holds the creator grant, so the keys serve at once.
    await expect(pull(app, token, "A_KEY").then((r) => r.json()))
      .resolves.toMatchObject({ token: "alpha" });
    await expect(pull(app, token, "B_KEY").then((r) => r.json()))
      .resolves.toMatchObject({ token: "beta" });
  });
});
