import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_OAUTH_COOKIE } from "../core/identity/oauth-state.js";
import {
  allowedEmailDomainsFromEnv,
  signupModeFromEnv,
} from "../core/runtime.js";
import {
  OPERATOR_KEY,
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
} from "./helpers.js";

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

interface SignInOptions {
  sub?: string;
  startPath?: string;
  bindings?: Record<string, unknown>;
}

/** Runs the full Google start/callback dance with the provider mocked and
 * the given Worker bindings (SIGNUP_MODE, ALLOWED_EMAIL_DOMAINS) applied to
 * both requests. Returns the callback response, or the start response when
 * the start already refused. */
async function signIn(
  app: ReturnType<typeof harness>["app"],
  email: string,
  { sub = `google-${email}`, startPath = "/auth/google/start", bindings = {} }: SignInOptions = {},
): Promise<Response> {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "transient-token" }))
    .mockResolvedValueOnce(Response.json({
      sub,
      email,
      email_verified: true,
      name: `User ${email}`,
    }));
  const start = await appRequest(app, startPath, undefined, bindings);
  if (start.status !== 302) return start;
  const location = new URL(start.headers.get("location") ?? "");
  return appRequest(
    app,
    `/auth/google/callback?code=google-code&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`,
    { headers: { Cookie: oauthCookie(start.headers.get("set-cookie") ?? "") } },
    bindings,
  );
}

async function userCount(googleUserId: string): Promise<number> {
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM users WHERE google_user_id = ?1",
  ).bind(googleUserId).first<number>("count");
  return count ?? 0;
}

async function seedUser(id: string, email: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO principals (id, unix_name, harnesses)
       VALUES (?1, 'blitz', '["claude","codex"]')`,
    ).bind(id),
    env.DB.prepare(
      `INSERT INTO users
       (id, google_user_id, email, name, avatar_url, platform_operator, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Seeded User', NULL, 0, ?4, ?4)`,
    ).bind(id, `google-${id}`, email, now),
  ]);
}

describe("identity signup gate", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  it("invite mode refuses a brand-new Google user with no invite", async () => {
    const { app } = harness();
    const callback = await signIn(app, "newcomer@example.com", {
      bindings: { SIGNUP_MODE: "invite" },
    });
    expect(callback.status).toBe(403);
    await expect(callback.json()).resolves.toMatchObject({
      error: expect.stringContaining("invite-only"),
    });
    expect(await userCount("google-newcomer@example.com")).toBe(0);
  });

  it("invite mode refuses a well-formed unknown invite code without creating the user", async () => {
    const { app } = harness();
    const callback = await signIn(app, "forger@example.com", {
      startPath: `/auth/google/start?invite=${"A".repeat(43)}`,
      bindings: { SIGNUP_MODE: "invite" },
    });
    expect(callback.status).toBe(403);
    expect(await userCount("google-forger@example.com")).toBe(0);
  });

  it("invite mode admits a brand-new user through a valid invite", async () => {
    const { app } = harness();
    const operatorCookie = await operatorSession(app);
    const minted = await appRequest(app, "/invites", {
      method: "POST",
      headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    });
    expect(minted.status).toBe(201);
    const { code } = await minted.json<{ code: string }>();
    const callback = await signIn(app, "invitee@example.com", {
      startPath: `/auth/google/start?invite=${code}`,
      bindings: { SIGNUP_MODE: "invite" },
    });
    expect(callback.status).toBe(302);
    const membership = await env.DB.prepare(
      `SELECT m.role, m.status FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE u.google_user_id = 'google-invitee@example.com'`,
    ).first<{ role: string; status: string }>();
    expect(membership).toEqual({ role: "member", status: "active" });
  });

  it("invite mode still signs in an existing user without an invite", async () => {
    const { app } = harness();
    await seedUser("veteran", "veteran@example.com");
    const callback = await signIn(app, "veteran@example.com", {
      sub: "google-veteran",
      bindings: { SIGNUP_MODE: "invite" },
    });
    expect(callback.status).toBe(302);
    const me = await appRequest(app, "/me", {
      headers: { Cookie: sessionCookie(callback.headers.get("set-cookie") ?? "") },
    });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      user: { id: "veteran", email: "veteran@example.com" },
    });
  });

  it("invite mode lets the verified bootstrap secret create the first user", async () => {
    const { app } = harness();
    const callback = await signIn(app, "founder@example.com", {
      startPath: `/auth/google/start?bootstrap=${encodeURIComponent(OPERATOR_KEY)}`,
      bindings: { SIGNUP_MODE: "invite" },
    });
    expect(callback.status).toBe(302);
    expect(await env.DB.prepare(
      "SELECT platform_operator FROM users WHERE google_user_id = 'google-founder@example.com'",
    ).first<number>("platform_operator")).toBe(1);
  });

  it("domain allowlist refuses unlisted domains for new and existing users", async () => {
    const { app } = harness();
    const refusedNew = await signIn(app, "eve@outsider.test", {
      bindings: { ALLOWED_EMAIL_DOMAINS: "example.com" },
    });
    expect(refusedNew.status).toBe(403);
    await expect(refusedNew.json()).resolves.toMatchObject({
      error: expect.stringContaining("domain"),
    });
    expect(await userCount("google-eve@outsider.test")).toBe(0);

    await seedUser("sam", "sam@legacy.test");
    const refusedExisting = await signIn(app, "sam@legacy.test", {
      sub: "google-sam",
      bindings: { ALLOWED_EMAIL_DOMAINS: "example.com" },
    });
    expect(refusedExisting.status).toBe(403);
  });

  it("domain allowlist admits listed domains and normalizes the configured list", async () => {
    const { app } = harness();
    const callback = await signIn(app, "alice@example.com", {
      bindings: { ALLOWED_EMAIL_DOMAINS: " Example.COM ,corp.test, " },
    });
    expect(callback.status).toBe(302);
    expect(await userCount("google-alice@example.com")).toBe(1);
  });

  it("open mode with the vars unset creates a new user exactly as before", async () => {
    const { app } = harness();
    const unset = await signIn(app, "open1@example.com");
    expect(unset.status).toBe(302);
    const empty = await signIn(app, "open2@example.com", {
      bindings: { SIGNUP_MODE: "", ALLOWED_EMAIL_DOMAINS: "" },
    });
    expect(empty.status).toBe(302);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM users",
    ).first<number>("count")).toBe(2);
  });

  it("bootstrap promotes an existing ordinary user when no operator exists", async () => {
    const { app } = harness();
    await seedUser("early-adopter", "early@example.com");
    const callback = await signIn(app, "early@example.com", {
      sub: "google-early-adopter",
      startPath: `/auth/google/start?bootstrap=${encodeURIComponent(OPERATOR_KEY)}`,
    });
    expect(callback.status).toBe(302);
    expect(await env.DB.prepare(
      "SELECT platform_operator FROM users WHERE id = 'early-adopter'",
    ).first<number>("platform_operator")).toBe(1);
    const membership = await env.DB.prepare(
      "SELECT role, status FROM memberships WHERE user_id = 'early-adopter'",
    ).first<{ role: string; status: string }>();
    expect(membership).toEqual({ role: "admin", status: "active" });
  });

  it("bootstrap leaves an existing user ordinary once an operator exists", async () => {
    const { app } = harness();
    await operatorSession(app);
    await seedUser("latecomer", "late@example.com");
    const callback = await signIn(app, "late@example.com", {
      sub: "google-latecomer",
      startPath: `/auth/google/start?bootstrap=${encodeURIComponent(OPERATOR_KEY)}`,
    });
    expect(callback.status).toBe(302);
    expect(await env.DB.prepare(
      "SELECT platform_operator FROM users WHERE id = 'latecomer'",
    ).first<number>("platform_operator")).toBe(0);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memberships WHERE user_id = 'latecomer'",
    ).first<number>("count")).toBe(0);
  });

  it("parses SIGNUP_MODE and ALLOWED_EMAIL_DOMAINS at the boundary", () => {
    expect(signupModeFromEnv(undefined)).toBe("open");
    expect(signupModeFromEnv("")).toBe("open");
    expect(signupModeFromEnv(" open ")).toBe("open");
    expect(signupModeFromEnv("Invite")).toBe("invite");
    expect(() => signupModeFromEnv("bogus")).toThrow(/SIGNUP_MODE/u);

    expect(allowedEmailDomainsFromEnv(undefined)).toEqual([]);
    expect(allowedEmailDomainsFromEnv("  ")).toEqual([]);
    expect(allowedEmailDomainsFromEnv(" Example.COM ,corp.test,")).toEqual([
      "example.com",
      "corp.test",
    ]);
    for (const invalid of ["alice@example.com", "gmail", "bad domain.com", "-bad.com"]) {
      expect(() => allowedEmailDomainsFromEnv(invalid)).toThrow(/ALLOWED_EMAIL_DOMAINS/u);
    }
  });
});
