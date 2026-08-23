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
import { redeemableInvite, redeemInviteSession } from "./invites.js";

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

const INVITE_ONLY_MESSAGE =
  "sign-ups are invite-only on this deployment; ask an organization admin for an invite link";

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

async function assertEmailUnclaimed(
  db: Db,
  email: string,
  ownerId: string | null,
): Promise<void> {
  const emailOwner = await first<{ id: string }>(db, {
    q: "SELECT id FROM users WHERE email = ?1 LIMIT 1",
    v: [email],
  });
  if (emailOwner !== null && emailOwner.id !== ownerId) {
    throw new HttpError(409, "email belongs to another Google identity");
  }
}

async function upsertLoginPrincipal(db: Db, userId: string): Promise<void> {
  await rows(db, {
    q: `INSERT INTO principals (id, unix_name, harnesses)
        VALUES (?1, 'blitz', '["claude","codex"]')
        ON CONFLICT(id) DO UPDATE SET unix_name = 'blitz', harnesses = '["claude","codex"]'`,
    v: [userId],
  });
}

async function userById(db: Db, id: string): Promise<UserRow> {
  const user = await first<UserRow>(db, {
    q: "SELECT id, platform_operator, name FROM users WHERE id = ?1 LIMIT 1",
    v: [id],
  });
  if (user === null) throw new Error("Google user disappeared during login");
  return user;
}

/** Refreshes the account this Google identity already owns, or returns null
 * for a first sign-in. */
async function refreshExistingUser(
  db: Db,
  profile: GoogleProfile,
  now: number,
  bootstrapEnabled: boolean,
): Promise<UserRow | null> {
  const user = await first<UserRow>(db, {
    q: "SELECT id, platform_operator, name FROM users WHERE google_user_id = ?1 LIMIT 1",
    v: [profile.googleUserId],
  });
  if (user === null) return null;
  await assertEmailUnclaimed(db, profile.email, user.id);
  await rows(db, {
    q: `UPDATE users SET email = ?1, name = ?2, avatar_url = ?3, updated_at = ?4
        WHERE id = ?5`,
    v: [profile.email, profile.name, profile.avatarUrl, now, user.id],
  });
  if (bootstrapEnabled) {
    // The bootstrap secret was already verified at /auth/google/start, so
    // this only widens WHICH user can become the first operator: an
    // existing row now promotes exactly like a created one. The NOT EXISTS
    // guard keeps promotion first-operator-only, and a wrong or absent
    // secret still never reaches this branch.
    await rows(db, {
      q: `UPDATE users SET platform_operator = 1, updated_at = ?2
          WHERE id = ?1 AND NOT EXISTS (
            SELECT 1 FROM users WHERE platform_operator = 1
          )`,
      v: [user.id, now],
    });
  }
  await upsertLoginPrincipal(db, user.id);
  return userById(db, user.id);
}

/** Creates the account for a sign-up that needs no invite: open signup or
 * the verified bootstrap secret. Invite-admitted accounts are instead
 * created inside the redemption batch (redeemInviteSession), conditional on
 * the invite, so no account ever outlives the invite that admitted it. */
async function createOpenUser(
  db: Db,
  profile: GoogleProfile,
  now: number,
  bootstrapEnabled: boolean,
): Promise<UserRow> {
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
  await upsertLoginPrincipal(db, id);
  return userById(db, id);
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
    // The verified bootstrap secret is the operator credential, so it may
    // create the first account on an invite-only deployment; the domain
    // allowlist above still applies even to bootstrap.
    const requireInvite = policy.inviteOnly && !bootstrapEnabled;
    const token = randomToken();
    const existing = await refreshExistingUser(
      runtime.db,
      profile,
      now,
      bootstrapEnabled,
    );
    if (existing === null && state.inviteCode !== undefined) {
      // First sign-in arriving with an invite: the user row is created by
      // the redemption batch itself, conditional on the invite. A brand-new
      // operator (bootstrap secret while no operator exists) who also
      // presents a valid invite therefore joins only the inviting org — no
      // personal org is bootstrapped, because the account exists only once
      // its invite membership does.
      if (requireInvite) {
        // The invite-only gate answers uniformly: a sign-up presenting a
        // bad invite learns it needs a working one, not what became of the
        // code it tried.
        try {
          await redeemableInvite(runtime.db, state.inviteCode, profile.email, now);
        } catch {
          throw new HttpError(403, INVITE_ONLY_MESSAGE);
        }
      }
      await assertEmailUnclaimed(runtime.db, profile.email, null);
      await redeemInviteSession(
        runtime.db,
        state.inviteCode,
        crypto.randomUUID(),
        profile.email,
        await hashSecret(token),
        runtime.vars.sessionTtlMs,
        now,
        {
          googleUserId: profile.googleUserId,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
          bootstrapOperator: bootstrapEnabled,
        },
      );
    } else {
      let user = existing;
      if (user === null) {
        if (requireInvite) throw new HttpError(403, INVITE_ONLY_MESSAGE);
        await assertEmailUnclaimed(runtime.db, profile.email, null);
        user = await createOpenUser(runtime.db, profile, now, bootstrapEnabled);
      }
      let membership = await activeMembership(runtime.db, user.id);
      if (membership === null && user.platform_operator === 1) {
        membership = await bootstrapMembership(runtime.db, user, now);
      }
      if (state.inviteCode !== undefined) {
        await redeemInviteSession(
          runtime.db,
          state.inviteCode,
          user.id,
          profile.email,
          await hashSecret(token),
          runtime.vars.sessionTtlMs,
          now,
        );
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
    }
    context.header("Set-Cookie", sessionCookie(token, runtime.vars.sessionTtlMs));
    context.header("Set-Cookie", clearGoogleOAuthStateCookie(), { append: true });
    return context.body(null, 302, { Location: "/" });
  });
}
