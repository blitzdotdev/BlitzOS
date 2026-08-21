import { hashSecret, randomToken, safeEqualSecret } from "../crypto.js";
import type { Db } from "../db.js";
import { first, rows, transaction } from "../db.js";
import { HttpError, isRecord, isString } from "../http.js";
import {
  cookieValue,
  sessionCookie,
} from "../principals.js";
import { fetchBoundedJson, type JsonValue } from "../compute/json-fetch.js";
import type { CoreRouter, RuntimeFactory, RuntimeVariables } from "../runtime.js";
import {
  clearGoogleOAuthStateCookie,
  createGoogleOAuthState,
  GOOGLE_OAUTH_COOKIE,
  verifyGoogleOAuthStateCookie,
} from "../oauth-state.js";
import { availableOrgSlug, DEFAULT_ORG_VM_LIMIT } from "./orgs.js";
import { inviteCodeHash, redeemInviteSession } from "./invites.js";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

interface GoogleProfile {
  googleUserId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

interface UserRow {
  id: string;
  platform_operator: number;
  name: string;
}

interface MembershipRow {
  id: string;
}

function providerObject(value: JsonValue | null, label: string): Record<string, JsonValue> {
  if (!isRecord(value)) throw new Error(`${label} returned an invalid response`);
  return value;
}

function providerString(
  value: JsonValue | undefined,
  field: string,
  maxLength = 4_096,
): string {
  if (!isString(value) || value === "" || value.length > maxLength) {
    throw new Error(`Google response has invalid ${field}`);
  }
  return value;
}

function parseGoogleProfile(value: JsonValue | null): GoogleProfile {
  const profile = providerObject(value, "Google userinfo");
  if (profile.email_verified !== true) {
    throw new HttpError(401, "Google email is not verified");
  }
  const email = providerString(profile.email, "email", 320).trim().toLowerCase();
  const avatarUrl = profile.picture === undefined
    ? null
    : providerString(profile.picture, "picture", 4_096);
  return {
    googleUserId: providerString(profile.sub, "sub", 256),
    email,
    name: providerString(profile.name, "name", 256).trim(),
    avatarUrl,
  };
}

async function googleProfile(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<GoogleProfile> {
  const tokenResult = await fetchBoundedJson(
    globalThis.fetch,
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }),
    },
    {
      responseLabel: "Google token exchange",
      bodyDisposition: () => "read",
      invalidJsonDisposition: () => "provider-error",
    },
  );
  if (!tokenResult.response.ok) throw new HttpError(502, "Google token exchange failed");
  const token = providerObject(tokenResult.body, "Google token exchange");
  const accessToken = providerString(token.access_token, "access_token");
  const userinfo = await fetchBoundedJson(
    globalThis.fetch,
    GOOGLE_USERINFO_URL,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    {
      responseLabel: "Google userinfo",
      bodyDisposition: () => "read",
      invalidJsonDisposition: () => "provider-error",
    },
  );
  if (!userinfo.response.ok) throw new HttpError(502, "Google userinfo failed");
  return parseGoogleProfile(userinfo.body);
}

/** Signup gate, parsed once per callback from the runtime vars.
 *
 * Semantics shipped here:
 * - `signupMode` "invite": a Google sign-in that would CREATE a user is
 *   refused unless it carries a redeemable invite or the verified bootstrap
 *   secret. Existing users always sign in.
 * - `allowedEmailDomains` non-empty: EVERY sign-in (new or existing user,
 *   invited or bootstrap) is refused when the email domain is not listed.
 *   Blocking existing users outright is deliberate — an allowlist that only
 *   gated signup would keep grandfathered accounts alive forever.
 * - Both vars absent (older runtimes omit them entirely) = open signup, any
 *   domain: exactly the pre-gate behavior. */
interface SignupPolicy {
  inviteOnly: boolean;
  allowedEmailDomains: readonly string[];
}

function signupPolicyFor(vars: RuntimeVariables): SignupPolicy {
  return {
    inviteOnly: (vars.signupMode ?? "open") === "invite",
    allowedEmailDomains: vars.allowedEmailDomains ?? [],
  };
}

function assertAllowedEmailDomain(policy: SignupPolicy, email: string): void {
  if (policy.allowedEmailDomains.length === 0) return;
  const separator = email.lastIndexOf("@");
  const domain = separator === -1 ? "" : email.slice(separator + 1);
  if (!policy.allowedEmailDomains.includes(domain)) {
    throw new HttpError(
      403,
      "this email domain is not allowed to sign in on this deployment",
    );
  }
}

/** Pre-check used only in invite mode, BEFORE the user row is created.
 * Without it, a well-formed but bogus invite code would still create the
 * user (redemption fails later), and the next plain sign-in would pass the
 * gate as an "existing user". Redemption itself stays transactional in
 * redeemInviteSession and re-validates everything checked here. */
async function hasRedeemableInvite(
  db: Db,
  inviteCode: string | undefined,
  email: string,
  now: number,
): Promise<boolean> {
  if (inviteCode === undefined) return false;
  const invite = await first<{ id: string }>(db, {
    q: `SELECT id FROM invites
        WHERE code_hash = ?1 AND state = 'ready' AND expires_at > ?2
          AND (email IS NULL OR email = ?3)
        LIMIT 1`,
    v: [await inviteCodeHash(inviteCode), now, email],
  });
  return invite !== null;
}

async function activeMembership(db: Db, userId: string): Promise<MembershipRow | null> {
  return first<MembershipRow>(db, {
    q: `SELECT m.id FROM memberships m
        WHERE m.user_id = ?1 AND m.status = 'active'
        ORDER BY COALESCE((
          SELECT MAX(s.created_at) FROM sessions s WHERE s.membership_id = m.id
        ), 0) DESC, m.rowid DESC
        LIMIT 1`,
    v: [userId],
  });
}

/** Removes the rows a sign-in just created. Called only when the invite that
 * admitted a brand-new account then fails to redeem: the account must not
 * outlive its invite, because the existing-user branch of resolveUser never
 * consults the signup gate again, and a survivor is grandfathered into an
 * invite-only deployment forever. A fresh account owns nothing else, so the
 * four tables below are the whole footprint. */
async function deleteProvisionalUser(db: Db, userId: string): Promise<void> {
  await transaction(db, [
    { q: "DELETE FROM sessions WHERE principal_id = ?1", v: [userId] },
    { q: "DELETE FROM memberships WHERE user_id = ?1", v: [userId] },
    { q: "DELETE FROM users WHERE id = ?1", v: [userId] },
    { q: "DELETE FROM principals WHERE id = ?1", v: [userId] },
  ]);
}

async function resolveUser(
  db: Db,
  profile: GoogleProfile,
  now: number,
  bootstrapEnabled: boolean,
  gate: { requireInvite: boolean; inviteCode: string | undefined },
): Promise<{ user: UserRow; created: boolean }> {
  let user = await first<UserRow>(db, {
    q: "SELECT id, platform_operator, name FROM users WHERE google_user_id = ?1 LIMIT 1",
    v: [profile.googleUserId],
  });
  const created = user === null;
  if (user !== null) {
    const emailOwner = await first<{ id: string }>(db, {
      q: "SELECT id FROM users WHERE email = ?1 LIMIT 1",
      v: [profile.email],
    });
    if (emailOwner !== null && emailOwner.id !== user.id) {
      throw new HttpError(409, "email belongs to another Google identity");
    }
    await rows(db, {
      q: `UPDATE users SET email = ?1, name = ?2, avatar_url = ?3, updated_at = ?4
          WHERE id = ?5`,
      v: [profile.email, profile.name, profile.avatarUrl, now, user.id],
    });
    if (bootstrapEnabled) {
      // The bootstrap secret was already verified at /auth/google/start, so
      // this only widens WHICH user can become the first operator: an
      // existing row now promotes exactly like the insert branch below. The
      // NOT EXISTS guard keeps promotion first-operator-only, and a wrong or
      // absent secret still never reaches this branch.
      await rows(db, {
        q: `UPDATE users SET platform_operator = 1, updated_at = ?2
            WHERE id = ?1 AND NOT EXISTS (
              SELECT 1 FROM users WHERE platform_operator = 1
            )`,
        v: [user.id, now],
      });
    }
  } else {
    if (
      gate.requireInvite
      && !(await hasRedeemableInvite(db, gate.inviteCode, profile.email, now))
    ) {
      throw new HttpError(
        403,
        "sign-ups are invite-only on this deployment; ask an organization admin for an invite link",
      );
    }
    const emailOwner = await first<{ id: string }>(db, {
      q: "SELECT id FROM users WHERE email = ?1 LIMIT 1",
      v: [profile.email],
    });
    if (emailOwner !== null) {
      throw new HttpError(409, "email belongs to another Google identity");
    }
    const id = crypto.randomUUID();
    await rows(db, {
      q: `INSERT INTO users
          (id, google_user_id, email, name, avatar_url, platform_operator,
           created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5,
            CASE WHEN ?6 = 1
                   AND NOT EXISTS (SELECT 1 FROM users WHERE platform_operator = 1)
                 THEN 1 ELSE 0 END,
            ?7, ?7)`,
      v: [
        id,
        profile.googleUserId,
        profile.email,
        profile.name,
        profile.avatarUrl,
        bootstrapEnabled ? 1 : 0,
        now,
      ],
    });
    user = { id, platform_operator: 0, name: profile.name };
  }
  await rows(db, {
    q: `INSERT INTO principals (id, unix_name, harnesses)
        VALUES (?1, 'blitz', '["claude","codex"]')
        ON CONFLICT(id) DO UPDATE SET unix_name = 'blitz', harnesses = '["claude","codex"]'`,
    v: [user.id],
  });
  const refreshed = await first<UserRow>(db, {
    q: "SELECT id, platform_operator, name FROM users WHERE id = ?1 LIMIT 1",
    v: [user.id],
  });
  if (refreshed === null) throw new Error("Google user disappeared during login");
  return { user: refreshed, created };
}

async function bootstrapMembership(
  db: Db,
  user: UserRow,
  now: number,
): Promise<MembershipRow> {
  const orgId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const slug = await availableOrgSlug(db, user.name);
  const result = await transaction(db, [
    {
      q: `INSERT INTO orgs (id, slug, name, vm_limit, created_at, updated_at)
          SELECT ?1, ?2, ?3, ?4, ?5, ?5
          WHERE EXISTS (
            SELECT 1 FROM users
            WHERE id = ?6 AND platform_operator = 1
          ) AND NOT EXISTS (
            SELECT 1 FROM memberships
            WHERE user_id = ?6 AND status = 'active'
          )
          RETURNING id`,
      v: [orgId, slug, user.name, DEFAULT_ORG_VM_LIMIT, now, user.id],
    },
    {
      q: `INSERT INTO memberships (id, user_id, org_id, role, status)
          SELECT ?1, ?2, ?3, 'admin', 'active'
          WHERE EXISTS (SELECT 1 FROM orgs WHERE id = ?3)
          RETURNING id`,
      v: [membershipId, user.id, orgId],
    },
    {
      q: `UPDATE workspaces
          SET owner_id = ?1, org_id = ?2, owner_membership_id = ?3
          WHERE owner_id = 'operator'`,
      v: [user.id, orgId, membershipId],
    },
    {
      q: "UPDATE boxes SET principal_id = ?1 WHERE principal_id = 'operator'",
      v: [user.id],
    },
    {
      q: "UPDATE webapp_state SET principal_id = ?1 WHERE principal_id = 'operator'",
      v: [user.id],
    },
    {
      q: `UPDATE connections SET org_id = ?1, created_by = ?2,
              created_by_membership_id = ?3
          WHERE created_by = 'operator' AND org_id IS NULL`,
      v: [orgId, user.id, membershipId],
    },
    {
      q: `INSERT OR IGNORE INTO volume_ownership
          (volume_id, org_id, created_by_membership_id, created_at)
          SELECT DISTINCT volume_id, ?1, ?2, ?3 FROM workspaces
          WHERE owner_id = ?4 AND volume_id IS NOT NULL`,
      v: [orgId, membershipId, now, user.id],
    },
  ]);
  if (result[0]?.length !== 1 || result[1]?.length !== 1) {
    const existing = await activeMembership(db, user.id);
    if (existing === null) throw new Error("operator bootstrap did not create a membership");
    return existing;
  }
  return { id: membershipId };
}

export function addGoogleAuthRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  router.get("/auth/google/start", async (context) => {
    const runtime = runtimeFactory(context);
    const requestUrl = new URL(context.req.url);
    const presentedBootstrap = requestUrl.searchParams.get("bootstrap");
    const inviteCode = requestUrl.searchParams.get("invite") ?? undefined;
    if (inviteCode !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(inviteCode)) {
      throw new HttpError(400, "invalid invite code");
    }
    const bootstrap = presentedBootstrap !== null;
    if (presentedBootstrap !== null) {
      const matches = await safeEqualSecret(
        presentedBootstrap,
        runtime.vars.bootstrapSecret,
      );
      if (runtime.vars.bootstrapSecret === "" || !matches) {
        throw new HttpError(401, "unauthorized");
      }
    }
    const oauth = await createGoogleOAuthState(
      runtime.vars.googleClientSecret,
      Date.now(),
      bootstrap,
      inviteCode,
    );
    const redirectUri = `${requestUrl.origin}/auth/google/callback`;
    const authorize = new URL(GOOGLE_AUTHORIZE_URL);
    authorize.search = new URLSearchParams({
      client_id: runtime.vars.googleClientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: oauth.state,
      code_challenge: oauth.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return context.body(null, 302, {
      Location: authorize.toString(),
      "Set-Cookie": oauth.cookie,
    });
  });

  router.get("/auth/google/callback", async (context) => {
    const runtime = runtimeFactory(context);
    const requestUrl = new URL(context.req.url);
    const code = requestUrl.searchParams.get("code");
    const returnedState = requestUrl.searchParams.get("state");
    const signedState = cookieValue(context.req.raw, GOOGLE_OAUTH_COOKIE);
    if (code === null || returnedState === null || signedState === null) {
      throw new HttpError(401, "invalid Google OAuth callback");
    }
    const state = await verifyGoogleOAuthStateCookie(
      signedState,
      returnedState,
      runtime.vars.googleClientSecret,
    );
    if (state === null) throw new HttpError(401, "invalid Google OAuth state");
    const redirectUri = `${requestUrl.origin}/auth/google/callback`;
    const profile = await googleProfile(
      code,
      state.codeVerifier,
      redirectUri,
      runtime.vars.googleClientId,
      runtime.vars.googleClientSecret,
    );
    const now = Date.now();
    const policy = signupPolicyFor(runtime.vars);
    assertAllowedEmailDomain(policy, profile.email);
    const bootstrapEnabled =
      state.bootstrap === true && runtime.vars.bootstrapSecret !== "";
    const { user, created } = await resolveUser(
      runtime.db,
      profile,
      now,
      bootstrapEnabled,
      {
        // The verified bootstrap secret is the operator credential, so it
        // may create the first account on an invite-only deployment; the
        // domain allowlist above still applies even to bootstrap.
        requireInvite: policy.inviteOnly && !bootstrapEnabled,
        inviteCode: state.inviteCode,
      },
    );
    let membership = await activeMembership(runtime.db, user.id);
    if (membership === null && user.platform_operator === 1) {
      membership = await bootstrapMembership(runtime.db, user, now);
    }
    const token = randomToken();
    if (state.inviteCode !== undefined) {
      try {
        await redeemInviteSession(
          runtime.db,
          state.inviteCode,
          user.id,
          profile.email,
          await hashSecret(token),
          runtime.vars.sessionTtlMs,
          now,
        );
      } catch (error) {
        // hasRedeemableInvite only pre-checked the invite; redemption can
        // still lose a race for a single-use code, or find the invite
        // revoked. The account this invite admitted must not survive it.
        if (created) await deleteProvisionalUser(runtime.db, user.id);
        throw error;
      }
    } else {
      await rows(runtime.db, {
        q: `INSERT INTO sessions
            (token_hash, principal_id, created_at, expires_at, membership_id)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
        v: [
          await hashSecret(token),
          user.id,
          now,
          now + runtime.vars.sessionTtlMs,
          membership?.id ?? null,
        ],
      });
    }
    context.header("Set-Cookie", sessionCookie(token, runtime.vars.sessionTtlMs));
    context.header("Set-Cookie", clearGoogleOAuthStateCookie(), { append: true });
    return context.body(null, 302, { Location: "/" });
  });
}
