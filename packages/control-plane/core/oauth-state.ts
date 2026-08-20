import { randomToken, safeEqualSecret } from "./crypto.js";
import { isNumber, isRecord, isString, type JsonObject, type JsonValue } from "./http.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
export const GOOGLE_OAUTH_COOKIE = "blitz_google_oauth";
const GOOGLE_COOKIE_PATH = "/auth/google";
/** Connect uses its own cookie and path so a login round trip and a provider
 * round trip can never consume each other's state. */
export const CONNECT_OAUTH_COOKIE = "blitz_connect_oauth";
const CONNECT_COOKIE_PATH = "/connect";

/** Every signed OAuth state carries these; a flow adds whatever else it needs
 * to bind into the signature. */
interface OAuthStateBase {
  version: 1;
  state: string;
  codeVerifier: string;
  expiresAt: number;
}

export interface CreatedOAuthState {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  cookie: string;
}

/** All that separates one signed-state flow from another: which cookie holds
 * it, which path scopes that cookie, and which extra fields ride inside the
 * signature. Base64url, HMAC, TTL and the constant-time comparisons are the
 * same protocol whichever flow is asking. */
interface OAuthStateFlow<Extra> {
  cookieName: string;
  cookiePath: string;
  /** The flow's own fields, ready to be signed alongside the base ones. */
  bind(extra: Extra): JsonObject;
  /** Reads them back off a parsed payload, or null when they are absent or
   * malformed — which rejects the whole cookie, since they are signed too. */
  read(parsed: JsonObject): Extra | null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function stateCookie(
  flow: OAuthStateFlow<unknown>,
  value: string,
  maxAgeSeconds: number,
): string {
  return `${flow.cookieName}=${encodeURIComponent(value)}; Path=${flow.cookiePath}; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(maxAgeSeconds)}`;
}

function parseBase(value: string): { base: OAuthStateBase; parsed: JsonObject } | null {
  const bytes = decodeBase64Url(value);
  if (bytes === null) return null;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || !isString(parsed.state)
    || !isString(parsed.codeVerifier)
    || !isNumber(parsed.expiresAt)
    || !Number.isSafeInteger(parsed.expiresAt)
  ) return null;
  return {
    base: {
      version: 1,
      state: parsed.state,
      codeVerifier: parsed.codeVerifier,
      expiresAt: parsed.expiresAt,
    },
    parsed,
  };
}

async function createOAuthState<Extra>(
  flow: OAuthStateFlow<Extra>,
  signingSecret: string,
  extra: Extra,
  now: number,
): Promise<CreatedOAuthState> {
  const base: OAuthStateBase = {
    version: 1,
    state: randomToken(),
    codeVerifier: randomToken(),
    expiresAt: now + OAUTH_STATE_TTL_MS,
  };
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify({ ...base, ...flow.bind(extra) })),
  );
  const signature = await hmac(payload, signingSecret);
  const verifierDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(base.codeVerifier),
  );
  return {
    state: base.state,
    codeVerifier: base.codeVerifier,
    codeChallenge: base64Url(new Uint8Array(verifierDigest)),
    cookie: stateCookie(flow, `${payload}.${signature}`, OAUTH_STATE_TTL_MS / 1_000),
  };
}

async function verifyOAuthStateCookie<Extra>(
  flow: OAuthStateFlow<Extra>,
  signedCookie: string,
  returnedState: string,
  signingSecret: string,
  now: number,
): Promise<(OAuthStateBase & Extra) | null> {
  const separator = signedCookie.indexOf(".");
  if (separator < 1 || separator === signedCookie.length - 1) return null;
  const payload = signedCookie.slice(0, separator);
  const signature = signedCookie.slice(separator + 1);
  if (!(await safeEqualSecret(signature, await hmac(payload, signingSecret)))) return null;
  const decoded = parseBase(payload);
  if (decoded === null || decoded.base.expiresAt <= now) return null;
  const extra = flow.read(decoded.parsed);
  if (extra === null) return null;
  if (!(await safeEqualSecret(returnedState, decoded.base.state))) return null;
  return { ...decoded.base, ...extra };
}

/** The login flow's extras: both optional, both signed, because a tampered
 * bootstrap flag or invite code would grant what neither was issued for. */
export interface GoogleOAuthExtra {
  bootstrap?: true;
  inviteCode?: string;
}

export type GoogleOAuthStateV1 = OAuthStateBase & GoogleOAuthExtra;
export type CreatedGoogleOAuthState = CreatedOAuthState;

const INVITE_CODE = /^[A-Za-z0-9_-]{43}$/u;

const googleFlow: OAuthStateFlow<GoogleOAuthExtra> = {
  cookieName: GOOGLE_OAUTH_COOKIE,
  cookiePath: GOOGLE_COOKIE_PATH,
  bind(extra) {
    const bound: JsonObject = {};
    if (extra.bootstrap === true) bound.bootstrap = true;
    if (extra.inviteCode !== undefined) bound.inviteCode = extra.inviteCode;
    return bound;
  },
  read(parsed) {
    if (parsed.bootstrap !== undefined && parsed.bootstrap !== true) return null;
    if (
      parsed.inviteCode !== undefined
      && (!isString(parsed.inviteCode) || !INVITE_CODE.test(parsed.inviteCode))
    ) return null;
    const extra: GoogleOAuthExtra = {};
    if (parsed.bootstrap === true) extra.bootstrap = true;
    if (isString(parsed.inviteCode)) extra.inviteCode = parsed.inviteCode;
    return extra;
  },
};

export async function createGoogleOAuthState(
  signingSecret: string,
  now = Date.now(),
  bootstrap = false,
  inviteCode?: string,
): Promise<CreatedGoogleOAuthState> {
  const extra: GoogleOAuthExtra = {};
  if (bootstrap) extra.bootstrap = true;
  if (inviteCode !== undefined) extra.inviteCode = inviteCode;
  return createOAuthState(googleFlow, signingSecret, extra, now);
}

export async function verifyGoogleOAuthStateCookie(
  signedCookie: string,
  returnedState: string,
  signingSecret: string,
  now = Date.now(),
): Promise<GoogleOAuthStateV1 | null> {
  return verifyOAuthStateCookie(googleFlow, signedCookie, returnedState, signingSecret, now);
}

export function clearGoogleOAuthStateCookie(): string {
  return stateCookie(googleFlow, "", 0);
}

/** The provider is bound into the signed state, so a callback cannot be
 * replayed against a different provider's token endpoint. */
export interface ConnectOAuthExtra {
  provider: string;
}

export type ConnectOAuthStateV1 = OAuthStateBase & ConnectOAuthExtra;
export type CreatedConnectOAuthState = CreatedOAuthState;

const connectFlow: OAuthStateFlow<ConnectOAuthExtra> = {
  cookieName: CONNECT_OAUTH_COOKIE,
  cookiePath: CONNECT_COOKIE_PATH,
  bind: ({ provider }) => ({ provider }),
  read(parsed) {
    if (!isString(parsed.provider) || parsed.provider.length === 0) return null;
    return { provider: parsed.provider };
  },
};

export async function createConnectOAuthState(
  signingSecret: string,
  provider: string,
  now = Date.now(),
): Promise<CreatedConnectOAuthState> {
  return createOAuthState(connectFlow, signingSecret, { provider }, now);
}

export async function verifyConnectOAuthStateCookie(
  signedCookie: string,
  returnedState: string,
  provider: string,
  signingSecret: string,
  now = Date.now(),
): Promise<ConnectOAuthStateV1 | null> {
  const state = await verifyOAuthStateCookie(
    connectFlow,
    signedCookie,
    returnedState,
    signingSecret,
    now,
  );
  return state === null || state.provider !== provider ? null : state;
}

export function clearConnectOAuthStateCookie(): string {
  return stateCookie(connectFlow, "", 0);
}
