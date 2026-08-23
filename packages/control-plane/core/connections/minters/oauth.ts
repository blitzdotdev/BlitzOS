import { fetchBoundedText } from "../../compute/json-fetch.js";
import type { Db } from "../../db.js";
import { HttpError, isNumber, isRecord, isString } from "../../http.js";
import type { OAuthProviderManifest } from "../catalog/types.js";
import type { GrantRow } from "../user-grants.js";
import { grantFor, openGrantSecret, rotateGrantTokens } from "../user-grants.js";

/** Refresh this far ahead of expiry so a mint never hands out a token that
 * dies mid-call.
 *
 * This margin is also the floor on an OAuth lease: `leaseExpiry` in the grant
 * minter hands the access token's own death back as the lease expiry, so a
 * mint that reuses a stored token issues a lease with exactly the token's
 * remaining life. At two minutes a box syncing on the tail of an hour-long
 * Google token got a two-minute lease and the agent's next call 401'd
 * mid-turn. Ten minutes is the floor, enforced here rather than at mint
 * because one constant does it: refreshing early is the only way to make the
 * lease longer, since the lease may never outlive the token it carries. */
const REFRESH_MARGIN_MS = 10 * 60 * 1_000;

export interface ExchangeInput {
  manifest: OAuthProviderManifest;
  clientId: string;
  clientSecret: string;
  /** Only an authorization_code exchange sends one; a refresh never does. */
  redirectUri: string | null;
  grantType: "authorization_code" | "refresh_token";
  code: string | null;
  codeVerifier: string | null;
  refreshToken: string | null;
}

export interface ExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresInMs: number;
}

/** The whole request, built from the manifest and nothing else. Kept pure so
 * the conformance suite can assert it field by field against a recorded
 * exchange instead of calling a provider. */
export function exchangeForm(input: ExchangeInput): URLSearchParams {
  const form = new URLSearchParams();
  form.set("grant_type", input.grantType);
  if (input.grantType === "authorization_code") {
    if (input.code === null) throw new Error("authorization_code exchange needs a code");
    form.set("code", input.code);
  } else {
    if (input.refreshToken === null) throw new Error("refresh exchange needs a refresh token");
    form.set("refresh_token", input.refreshToken);
  }
  form.set("client_id", input.clientId);
  form.set("client_secret", input.clientSecret);
  if (input.grantType === "authorization_code") {
    if (input.redirectUri === null) {
      throw new Error("authorization_code exchange needs a redirect URI");
    }
    form.set("redirect_uri", input.redirectUri);
    if (input.manifest.auth.pkce) {
      if (input.codeVerifier === null) throw new Error("PKCE exchange needs a code verifier");
      form.set("code_verifier", input.codeVerifier);
    }
  }
  return form;
}

/** Reads one recorded provider answer. Rejections are provider truth, not
 * transport failures: a replayed single-use refresh answers 200 with an
 * `error` member, and treating that as success would store a dead token. */
export function parseExchangeResponse(
  manifest: OAuthProviderManifest,
  body: string,
): ExchangeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(502, `${manifest.id} returned a non-JSON token response`);
  }
  if (!isRecord(parsed)) {
    throw new HttpError(502, `${manifest.id} returned an invalid token response`);
  }
  if (isString(parsed.error)) {
    throw new HttpError(502, `${manifest.id} rejected the token exchange: ${parsed.error}`);
  }
  if (!isString(parsed.access_token) || parsed.access_token.length === 0) {
    throw new HttpError(502, `${manifest.id} returned no access token`);
  }
  const expiresIn = isNumber(parsed.expires_in) && Number.isFinite(parsed.expires_in)
    ? parsed.expires_in * 1_000
    : manifest.auth.accessTtlMs;
  // A provider that rotates omits nothing; one that does not rotate omits the
  // refresh token, and the stored one stands.
  const refreshToken = isString(parsed.refresh_token) && parsed.refresh_token.length > 0
    ? parsed.refresh_token
    : null;
  return { accessToken: parsed.access_token, refreshToken, expiresInMs: expiresIn };
}

export async function exchangeTokens(input: ExchangeInput): Promise<ExchangeResult> {
  const { response, body } = await fetchBoundedText(
    fetch,
    input.manifest.auth.tokenUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "blitz-control-plane",
      },
      body: exchangeForm(input).toString(),
    },
    {
      responseLabel: `${input.manifest.id} token`,
      bodyDisposition: () => "read",
    },
  );
  if (body === null) {
    throw new HttpError(502, `${input.manifest.id} returned an empty token response`);
  }
  if (response.status >= 500) {
    throw new HttpError(502, `${input.manifest.id} token endpoint failed`);
  }
  return parseExchangeResponse(input.manifest, body);
}

export interface RefreshContext {
  db: Db;
  key: CryptoKey;
  clientId: string;
  clientSecret: string;
  redirectUri: string | null;
}

function fresh(grant: GrantRow, now: number): boolean {
  return grant.access_expires_at !== null
    && grant.access_expires_at - REFRESH_MARGIN_MS > now;
}

/** An access token and the moment it dies. The expiry travels with the token
 * because a refresh rotates it: the caller's `GrantRow` was read before the
 * rotation, so its `access_expires_at` is the expiry of a token that no longer
 * exists, and a lease cut from it would be born expired. */
export interface RefreshedAccess {
  accessToken: string;
  accessExpiresAt: number;
}

async function storedAccess(
  key: CryptoKey,
  grant: GrantRow,
): Promise<RefreshedAccess | null> {
  const access = await openGrantSecret(key, grant, "access");
  if (access === null || grant.access_expires_at === null) return null;
  return { accessToken: access, accessExpiresAt: grant.access_expires_at };
}

/** Exchanges the owner's refresh token for an access token, storing the
 * result under compare-and-set.
 *
 * One path serves every provider: nothing serializes the exchanges, and the
 * compare-and-set guards the database write alone. Two concurrent refreshes
 * both call the provider; the loser re-reads the row and uses whatever the
 * winner stored. That is safe wherever the provider is, because the loser's
 * own material is the part that may already be dead. */
export async function refreshedAccessToken(
  context: RefreshContext,
  manifest: OAuthProviderManifest,
  grant: GrantRow,
  now = Date.now(),
): Promise<RefreshedAccess | null> {
  if (fresh(grant, now)) return storedAccess(context.key, grant);
  const refreshToken = await openGrantSecret(context.key, grant, "refresh");
  if (refreshToken === null) return null;
  const exchanged = await exchangeTokens({
    manifest,
    clientId: context.clientId,
    clientSecret: context.clientSecret,
    redirectUri: context.redirectUri,
    grantType: "refresh_token",
    code: null,
    codeVerifier: null,
    refreshToken,
  });
  const accessExpiresAt = now + exchanged.expiresInMs;
  const stored = await rotateGrantTokens(
    context.db,
    context.key,
    grant,
    exchanged.accessToken,
    accessExpiresAt,
    exchanged.refreshToken,
    now,
  );
  if (stored) return { accessToken: exchanged.accessToken, accessExpiresAt };
  // Another request wrote first. Its material is the live one; ours may
  // already be invalidated at a provider that issues single-use refreshes.
  const current = await grantFor(context.db, grant.user_id, grant.provider);
  if (current === null || !fresh(current, now)) return null;
  return storedAccess(context.key, current);
}
