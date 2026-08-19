import { randomToken, safeEqualSecret } from "./crypto.js";
import { isNumber, isRecord, isString, type JsonValue } from "./http.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
export const GOOGLE_OAUTH_COOKIE = "blitz_google_oauth";
/** Connect uses its own cookie and path so a login round trip and a provider
 * round trip can never consume each other's state. */
export const CONNECT_OAUTH_COOKIE = "blitz_connect_oauth";
const CONNECT_COOKIE_PATH = "/connect";

export interface GoogleOAuthStateV1 {
  version: 1;
  state: string;
  codeVerifier: string;
  expiresAt: number;
  bootstrap?: true;
  inviteCode?: string;
}

export interface CreatedGoogleOAuthState {
  state: string;
  codeChallenge: string;
  cookie: string;
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

function parseState(value: string): GoogleOAuthStateV1 | null {
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
    || (parsed.bootstrap !== undefined && parsed.bootstrap !== true)
    || (parsed.inviteCode !== undefined && (!isString(parsed.inviteCode) || !/^[A-Za-z0-9_-]{43}$/u.test(parsed.inviteCode)))
  ) return null;
  const state: GoogleOAuthStateV1 = {
    version: 1,
    state: parsed.state,
    codeVerifier: parsed.codeVerifier,
    expiresAt: parsed.expiresAt,
  };
  if (parsed.bootstrap === true) state.bootstrap = true;
  if (isString(parsed.inviteCode)) state.inviteCode = parsed.inviteCode;
  return state;
}

function stateCookie(value: string, maxAgeSeconds: number): string {
  return `${GOOGLE_OAUTH_COOKIE}=${encodeURIComponent(value)}; Path=/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export async function createGoogleOAuthState(
  signingSecret: string,
  now = Date.now(),
  bootstrap = false,
  inviteCode?: string,
): Promise<CreatedGoogleOAuthState> {
  const state: GoogleOAuthStateV1 = {
    version: 1,
    state: randomToken(),
    codeVerifier: randomToken(),
    expiresAt: now + OAUTH_STATE_TTL_MS,
  };
  if (bootstrap) state.bootstrap = true;
  if (inviteCode !== undefined) state.inviteCode = inviteCode;
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(state)));
  const signature = await hmac(payload, signingSecret);
  const verifierDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(state.codeVerifier),
  );
  return {
    state: state.state,
    codeChallenge: base64Url(new Uint8Array(verifierDigest)),
    cookie: stateCookie(`${payload}.${signature}`, OAUTH_STATE_TTL_MS / 1_000),
  };
}

export async function verifyGoogleOAuthStateCookie(
  signedCookie: string,
  returnedState: string,
  signingSecret: string,
  now = Date.now(),
): Promise<GoogleOAuthStateV1 | null> {
  const separator = signedCookie.indexOf(".");
  if (separator < 1 || separator === signedCookie.length - 1) return null;
  const payload = signedCookie.slice(0, separator);
  const signature = signedCookie.slice(separator + 1);
  if (!(await safeEqualSecret(signature, await hmac(payload, signingSecret)))) return null;
  const state = parseState(payload);
  if (state === null || state.expiresAt <= now) return null;
  if (!(await safeEqualSecret(returnedState, state.state))) return null;
  return state;
}

export function clearGoogleOAuthStateCookie(): string {
  return stateCookie("", 0);
}

export interface ConnectOAuthStateV1 {
  version: 1;
  state: string;
  codeVerifier: string;
  expiresAt: number;
  provider: string;
}

export interface CreatedConnectOAuthState {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  cookie: string;
}

function connectCookie(value: string, maxAgeSeconds: number): string {
  return `${CONNECT_OAUTH_COOKIE}=${encodeURIComponent(value)}; Path=${CONNECT_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function parseConnectState(value: string): ConnectOAuthStateV1 | null {
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
    || !isString(parsed.provider)
    || parsed.provider.length === 0
    || !isNumber(parsed.expiresAt)
    || !Number.isSafeInteger(parsed.expiresAt)
  ) return null;
  return {
    version: 1,
    state: parsed.state,
    codeVerifier: parsed.codeVerifier,
    expiresAt: parsed.expiresAt,
    provider: parsed.provider,
  };
}

/** The provider is bound into the signed state, so a callback cannot be
 * replayed against a different provider's token endpoint. */
export async function createConnectOAuthState(
  signingSecret: string,
  provider: string,
  now = Date.now(),
): Promise<CreatedConnectOAuthState> {
  const state: ConnectOAuthStateV1 = {
    version: 1,
    state: randomToken(),
    codeVerifier: randomToken(),
    expiresAt: now + OAUTH_STATE_TTL_MS,
    provider,
  };
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(state)));
  const signature = await hmac(payload, signingSecret);
  const verifierDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(state.codeVerifier),
  );
  return {
    state: state.state,
    codeVerifier: state.codeVerifier,
    codeChallenge: base64Url(new Uint8Array(verifierDigest)),
    cookie: connectCookie(`${payload}.${signature}`, OAUTH_STATE_TTL_MS / 1_000),
  };
}

export async function verifyConnectOAuthStateCookie(
  signedCookie: string,
  returnedState: string,
  provider: string,
  signingSecret: string,
  now = Date.now(),
): Promise<ConnectOAuthStateV1 | null> {
  const separator = signedCookie.indexOf(".");
  if (separator < 1 || separator === signedCookie.length - 1) return null;
  const payload = signedCookie.slice(0, separator);
  const signature = signedCookie.slice(separator + 1);
  if (!(await safeEqualSecret(signature, await hmac(payload, signingSecret)))) return null;
  const state = parseConnectState(payload);
  if (state === null || state.expiresAt <= now || state.provider !== provider) return null;
  if (!(await safeEqualSecret(returnedState, state.state))) return null;
  return state;
}

export function clearConnectOAuthStateCookie(): string {
  return connectCookie("", 0);
}
