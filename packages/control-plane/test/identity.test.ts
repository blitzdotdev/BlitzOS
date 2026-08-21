import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashSecret, randomToken } from "../core/crypto.js";
import {
  createGoogleOAuthState,
  GOOGLE_OAUTH_COOKIE,
  verifyGoogleOAuthStateCookie,
} from "../core/oauth-state.js";
import {
  OPERATOR_KEY,
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
} from "./helpers.js";

async function identityOnlySession(userId: string): Promise<string> {
  const now = Date.now();
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO principals (id, unix_name, harnesses)
       VALUES (?1, 'blitz', '["claude","codex"]')`,
    ).bind(userId),
    env.DB.prepare(
      `INSERT INTO users
       (id, google_user_id, email, name, avatar_url, platform_operator, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'New User', NULL, 0, ?4, ?4)`,
    ).bind(userId, `google-${userId}`, `${userId}@example.com`, now),
    env.DB.prepare(
      `INSERT INTO sessions
       (token_hash, principal_id, created_at, expires_at, membership_id)
       VALUES (?1, ?2, ?3, ?4, NULL)`,
    ).bind(await hashSecret(token), userId, now, now + 60_000),
  ]);
  return `blitz_session=${token}`;
}

function oauthCookie(setCookie: string): string {
  const match = setCookie.match(new RegExp(`${GOOGLE_OAUTH_COOKIE}=([^;]+)`, "u"));
  if (match?.[1] === undefined) throw new Error("OAuth state cookie is missing");
  return `${GOOGLE_OAUTH_COOKIE}=${match[1]}`;
}

function sessionCookie(setCookie: string): string {
  const match = setCookie.match(/blitz_session=([^;]+)/u);
  if (match?.[1] === undefined) throw new Error("session cookie is missing");
  return `blitz_session=${match[1]}`;
}

describe("identity phase 1", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  it("signs OAuth state, compares it constant-time, and enforces the ten-minute expiry", async () => {
    const created = await createGoogleOAuthState("state-secret", 1_000, true);
    const cookie = decodeURIComponent(
      oauthCookie(created.cookie).slice(`${GOOGLE_OAUTH_COOKIE}=`.length),
    );
    await expect(
      verifyGoogleOAuthStateCookie(cookie, created.state, "state-secret", 600_999),
    ).resolves.toMatchObject({
      version: 1,
      state: created.state,
      expiresAt: 601_000,
      bootstrap: true,
    });
    await expect(
      verifyGoogleOAuthStateCookie(cookie, "wrong-state", "state-secret", 2_000),
    ).resolves.toBeNull();
    await expect(
      verifyGoogleOAuthStateCookie(`${cookie}x`, created.state, "state-secret", 2_000),
    ).resolves.toBeNull();
    await expect(
      verifyGoogleOAuthStateCookie(cookie, created.state, "state-secret", 601_001),
    ).resolves.toBeNull();
    await expect(
      verifyGoogleOAuthStateCookie(cookie, created.state, "state-secret", 601_000),
    ).resolves.toBeNull();
  });

  it("does not authenticate requests with OPERATOR_API_KEY", async () => {
    const { app } = harness();
    for (const headers of [
      { Authorization: `Bearer ${OPERATOR_KEY}` },
      { "x-operator-key": OPERATOR_KEY },
    ]) {
      expect((await appRequest(app, "/machine-types", { headers })).status).toBe(401);
    }
    expect((await appRequest(app, "/sessions", {
      method: "POST",
      headers: { "x-operator-key": OPERATOR_KEY },
    })).status).toBe(404);
  });

  it("gates create-org to an identity-only session and rebinds that session", async () => {
    const { app } = harness();
    const cookie = await identityOnlySession("new-user");
    const before = await appRequest(app, "/me", { headers: { Cookie: cookie } });
    await expect(before.json()).resolves.toMatchObject({ membership: null, org: null });

    const created = await appRequest(app, "/orgs", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme Tools" }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      org: { slug: "acme-tools", name: "Acme Tools", vmLimit: 10 },
      membership: { role: "admin", status: "active" },
    });
    await expect(appRequest(app, "/me", {
      headers: { Cookie: cookie },
    }).then((response) => response.json())).resolves.toMatchObject({
      user: { id: "new-user", email: "new-user@example.com" },
      org: { slug: "acme-tools" },
      membership: { role: "admin", status: "active" },
    });
    expect((await appRequest(app, "/orgs", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Org" }),
    })).status).toBe(409);

    const collisionCookie = await identityOnlySession("collision-user");
    const collision = await appRequest(app, "/orgs", {
      method: "POST",
      headers: { Cookie: collisionCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme Tools" }),
    });
    expect(collision.status).toBe(201);
    await expect(collision.json()).resolves.toMatchObject({
      org: { slug: expect.stringMatching(/^acme-tools-[0-9a-f]{6}$/u) },
    });

    const memberCookie = await operatorSession(app);
    expect((await appRequest(app, "/orgs", {
      method: "POST",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Not Allowed" }),
    })).status).toBe(409);
  });

  it("keeps bootstrap login ordinary after a platform operator exists", async () => {
    const { app } = harness();
    await operatorSession(app);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "transient-token" }))
      .mockResolvedValueOnce(Response.json({
        sub: "google-no-membership",
        email: "new@example.com",
        email_verified: true,
        name: "New Person",
      }));

    const start = await appRequest(
      app,
      `/auth/google/start?bootstrap=${encodeURIComponent(OPERATOR_KEY)}`,
    );
    const location = new URL(start.headers.get("location") ?? "");
    const callback = await appRequest(
      app,
      `/auth/google/callback?code=google-code&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`,
      { headers: { Cookie: oauthCookie(start.headers.get("set-cookie") ?? "") } },
    );
    expect(callback.status).toBe(302);
    const cookie = sessionCookie(callback.headers.get("set-cookie") ?? "");
    const me = await appRequest(app, "/me", { headers: { Cookie: cookie } });
    await expect(me.json()).resolves.toEqual({
      user: {
        id: expect.any(String),
        email: "new@example.com",
        name: "New Person",
        avatarUrl: null,
        platformOperator: false,
      },
      membership: null,
      org: null,
      organizations: [],
    });
    expect(await env.DB.prepare(
      "SELECT membership_id FROM sessions WHERE principal_id = (SELECT id FROM users WHERE google_user_id = 'google-no-membership') ORDER BY created_at DESC LIMIT 1",
    ).first<string>("membership_id")).toBeNull();
  });

  it("creates an ordinary first Google user when bootstrap is absent", async () => {
    const { app } = harness();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "transient-token" }))
      .mockResolvedValueOnce(Response.json({
        sub: "google-ordinary-first",
        email: "ordinary@example.com",
        email_verified: true,
        name: "Ordinary Person",
      }));

    const start = await appRequest(app, "/auth/google/start");
    const location = new URL(start.headers.get("location") ?? "");
    const callback = await appRequest(
      app,
      `/auth/google/callback?code=google-code&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`,
      { headers: { Cookie: oauthCookie(start.headers.get("set-cookie") ?? "") } },
    );

    expect(callback.status).toBe(302);
    expect(await env.DB.prepare(
      "SELECT platform_operator FROM users WHERE google_user_id = 'google-ordinary-first'",
    ).first<number>("platform_operator")).toBe(0);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memberships",
    ).first<number>("count")).toBe(0);
  });

  it("rejects a wrong bootstrap secret at the Google start boundary", async () => {
    const { app } = harness();
    const start = await appRequest(app, "/auth/google/start?bootstrap=wrong-secret");
    expect(start.status).toBe(401);
    await expect(start.json()).resolves.toEqual({ error: "unauthorized", retryAction: null });

    const disabled = await appRequest(
      app,
      `/auth/google/start?bootstrap=${encodeURIComponent(OPERATOR_KEY)}`,
      undefined,
      { OPERATOR_API_KEY: "" },
    );
    expect(disabled.status).toBe(401);
  });

  it("demotes bootstrap auth to the first Google login and backfills operator-owned rows", async () => {
    const { app } = harness();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO principals (id, unix_name, harnesses)
         VALUES ('operator', 'operator', '["claude","codex"]')`,
      ),
      env.DB.prepare(
        `INSERT INTO workspaces
         (id, owner_id, machine_type_id, phase, revision, created_at, updated_at)
         VALUES ('legacy-workspace', 'operator', 'small', 'ready', 1, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO boxes (id, principal_id, workspace_id, is_broker, created_at)
         VALUES ('legacy-box', 'operator', 'legacy-workspace', 0, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO webapp_state (principal_id, workspace_id, doc, updated_at)
         VALUES ('operator', NULL, '{"version":1,"activeWorkspaceId":"legacy-workspace","order":["legacy-workspace"]}', ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO webapp_state (principal_id, workspace_id, doc, updated_at)
         VALUES ('operator', 'legacy-workspace', '{"version":1}', ?1)`,
      ).bind(now),
    ]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "transient-google-token" }))
      .mockResolvedValueOnce(Response.json({
        sub: "google-user-123",
        email: "Alice@Example.com",
        email_verified: true,
        name: "Alice Example",
        picture: "https://images.example/alice.png",
      }));

    const start = await appRequest(
      app,
      `/auth/google/start?bootstrap=${encodeURIComponent(OPERATOR_KEY)}`,
    );
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") ?? "");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = await appRequest(
      app,
      `/auth/google/callback?code=google-code&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`,
      { headers: { Cookie: oauthCookie(start.headers.get("set-cookie") ?? "") } },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");

    const user = await env.DB.prepare(
      "SELECT id, email, platform_operator FROM users WHERE google_user_id = 'google-user-123'",
    ).first<{ id: string; email: string; platform_operator: number }>();
    expect(user).toMatchObject({ email: "alice@example.com", platform_operator: 1 });
    const membership = await env.DB.prepare(
      "SELECT id, org_id, role, status FROM memberships WHERE user_id = ?1",
    ).bind(user?.id).first<{ id: string; org_id: string; role: string; status: string }>();
    expect(membership).toMatchObject({ role: "admin", status: "active" });
    expect(await env.DB.prepare(
      "SELECT owner_id, org_id, owner_membership_id FROM workspaces WHERE id = 'legacy-workspace'",
    ).first()).toEqual({
      owner_id: user?.id,
      org_id: membership?.org_id,
      owner_membership_id: membership?.id,
    });
    expect(await env.DB.prepare(
      "SELECT principal_id FROM boxes WHERE id = 'legacy-box'",
    ).first<string>("principal_id")).toBe(user?.id);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM webapp_state WHERE principal_id = ?1",
    ).bind(user?.id).first<number>("count")).toBe(2);
    expect(await env.DB.prepare(
      "SELECT membership_id FROM sessions WHERE principal_id = ?1",
    ).bind(user?.id).first<string>("membership_id")).toBe(membership?.id);
  });
});
