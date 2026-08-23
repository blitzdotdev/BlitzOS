import type { ProviderParam } from "../core/connections/catalog/types.js";

/** A recorded provider probe answer, replayed against `evaluateProbe`. */
export interface ProbeFixture {
  name: string;
  status: number;
  response: string;
  healthy: boolean;
}

export interface ExchangeExpectation {
  accessToken: string;
  refreshToken: string | null;
  expiresInMs: number;
}

/** A recorded token-endpoint round trip. The generic exchange is only ever
 * proven against these, never against a live provider, so the conformance
 * suite demands at least one per OAuth manifest. */
export interface ExchangeFixture {
  name: string;
  grantType: "authorization_code" | "refresh_token";
  /** Form fields the exchange must send, asserted field by field. */
  request: readonly ProviderParam[];
  response: string;
  /** `null` records a rejection the exchange must surface as an error —
   * a replayed single-use refresh is a fixture, not a hypothetical. */
  expect: ExchangeExpectation | null;
}

/** Keyed by manifest id; the conformance suite asserts the key set matches
 * the catalog exactly, so a new provider cannot land without recordings. */
export const PROBE_FIXTURES: ReadonlyMap<
  string,
  readonly [ProbeFixture, ...ProbeFixture[]]
> = new Map<string, readonly [ProbeFixture, ...ProbeFixture[]]>([
  [
    "github",
    [
      {
        name: "authenticated user",
        status: 200,
        response: '{"login":"blitz-canary","id":4242,"type":"User"}',
        healthy: true,
      },
      {
        name: "expired user token",
        status: 401,
        response: '{"message":"Bad credentials","status":"401"}',
        healthy: false,
      },
    ],
  ],
  [
    "google-workspace",
    [
      {
        name: "drive about",
        status: 200,
        response: '{"user":{"kind":"drive#user","emailAddress":"canary@example.com"}}',
        healthy: true,
      },
      {
        name: "revoked grant",
        status: 401,
        response: '{"error":{"code":401,"message":"Invalid Credentials","status":"UNAUTHENTICATED"}}',
        healthy: false,
      },
    ],
  ],
  [
    "linear",
    [
      {
        name: "viewer",
        status: 200,
        response: '{"data":{"viewer":{"id":"6e5c1f7a-0000-4000-8000-000000000000","name":"Blitz Canary"}}}',
        healthy: true,
      },
      {
        name: "authenticated 200 carrying an error array",
        status: 200,
        response: '{"errors":[{"message":"Authentication required, not authenticated"}]}',
        healthy: false,
      },
    ],
  ],
  [
    "discord",
    [
      {
        name: "the bot's own user",
        status: 200,
        response: '{"id":"1029384756000000000","username":"blitz-canary","bot":true}',
        healthy: true,
      },
      {
        name: "reset bot token",
        status: 401,
        response: '{"message":"401: Unauthorized","code":0}',
        healthy: false,
      },
    ],
  ],
  [
    "youtrack",
    [
      {
        name: "token's own user",
        status: 200,
        response: '{"id":"1-1","login":"blitz-canary","name":"Blitz Canary","$type":"Me"}',
        healthy: true,
      },
      {
        name: "revoked permanent token",
        status: 401,
        response: '{"error":"Unauthorized","error_description":"Cannot find user by authentication data"}',
        healthy: false,
      },
    ],
  ],
  [
    "generic",
    [
      { name: "reachable", status: 200, response: "{}", healthy: true },
      { name: "rejected key", status: 401, response: '{"error":"unauthorized"}', healthy: false },
    ],
  ],
]);

/** Keyed by manifest id; the conformance suite asserts the key set matches
 * the catalog's OAuth manifests exactly. */
export const EXCHANGE_FIXTURES: ReadonlyMap<
  string,
  readonly [ExchangeFixture, ...ExchangeFixture[]]
> = new Map<string, readonly [ExchangeFixture, ...ExchangeFixture[]]>([
  [
    "github",
    [
      {
        name: "authorization code exchange",
        grantType: "authorization_code",
        request: [
          { name: "grant_type", value: "authorization_code" },
          { name: "code", value: "recorded-authorization-code" },
          { name: "client_id", value: "recorded-client-id" },
          { name: "client_secret", value: "recorded-client-secret" },
          { name: "redirect_uri", value: "https://cp.example/connect/github/callback" },
          { name: "code_verifier", value: "recorded-code-verifier" },
        ],
        response: '{"access_token":"ghu_recorded_first","expires_in":28800,"refresh_token":"ghr_recorded_first","refresh_token_expires_in":15811200,"scope":"","token_type":"bearer"}',
        expect: {
          accessToken: "ghu_recorded_first",
          refreshToken: "ghr_recorded_first",
          expiresInMs: 28_800_000,
        },
      },
      {
        name: "single-use refresh rotation",
        grantType: "refresh_token",
        request: [
          { name: "grant_type", value: "refresh_token" },
          { name: "refresh_token", value: "ghr_recorded_first" },
          { name: "client_id", value: "recorded-client-id" },
          { name: "client_secret", value: "recorded-client-secret" },
        ],
        response: '{"access_token":"ghu_recorded_second","expires_in":28800,"refresh_token":"ghr_recorded_second","refresh_token_expires_in":15811200,"scope":"","token_type":"bearer"}',
        expect: {
          accessToken: "ghu_recorded_second",
          refreshToken: "ghr_recorded_second",
          expiresInMs: 28_800_000,
        },
      },
      {
        name: "replayed single-use refresh",
        grantType: "refresh_token",
        request: [
          { name: "grant_type", value: "refresh_token" },
          { name: "refresh_token", value: "ghr_recorded_first" },
          { name: "client_id", value: "recorded-client-id" },
          { name: "client_secret", value: "recorded-client-secret" },
        ],
        response: '{"error":"bad_refresh_token","error_description":"The refresh token passed is incorrect or expired."}',
        expect: null,
      },
    ],
  ],
  [
    "google-workspace",
    [
      {
        name: "authorization code exchange",
        grantType: "authorization_code",
        request: [
          { name: "grant_type", value: "authorization_code" },
          { name: "code", value: "recorded-authorization-code" },
          { name: "client_id", value: "recorded-client-id" },
          { name: "client_secret", value: "recorded-client-secret" },
          { name: "redirect_uri", value: "https://cp.example/connect/google-workspace/callback" },
          { name: "code_verifier", value: "recorded-code-verifier" },
        ],
        response: '{"access_token":"ya29.recorded-first","expires_in":3599,"refresh_token":"1//recorded-refresh","scope":"https://www.googleapis.com/auth/drive.file","token_type":"Bearer"}',
        expect: {
          accessToken: "ya29.recorded-first",
          refreshToken: "1//recorded-refresh",
          expiresInMs: 3_599_000,
        },
      },
      {
        name: "refresh keeps the same refresh token",
        grantType: "refresh_token",
        request: [
          { name: "grant_type", value: "refresh_token" },
          { name: "refresh_token", value: "1//recorded-refresh" },
          { name: "client_id", value: "recorded-client-id" },
          { name: "client_secret", value: "recorded-client-secret" },
        ],
        // No refresh_token field: Google never rotates, so the stored one stands.
        response: '{"access_token":"ya29.recorded-second","expires_in":3599,"scope":"https://www.googleapis.com/auth/drive.file","token_type":"Bearer"}',
        expect: {
          accessToken: "ya29.recorded-second",
          refreshToken: null,
          expiresInMs: 3_599_000,
        },
      },
      {
        name: "refresh token revoked at the account",
        grantType: "refresh_token",
        request: [
          { name: "grant_type", value: "refresh_token" },
          { name: "refresh_token", value: "1//recorded-refresh" },
          { name: "client_id", value: "recorded-client-id" },
          { name: "client_secret", value: "recorded-client-secret" },
        ],
        response: '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
        expect: null,
      },
    ],
  ],
  [
    "linear",
    [
      {
        name: "authorization code exchange",
        grantType: "authorization_code",
        request: [
          { name: "grant_type", value: "authorization_code" },
          { name: "code", value: "recorded-authorization-code" },
          { name: "client_id", value: "recorded-client-id" },
          { name: "client_secret", value: "recorded-client-secret" },
          { name: "redirect_uri", value: "https://cp.example/connect/linear/callback" },
          { name: "code_verifier", value: "recorded-code-verifier" },
        ],
        response: '{"access_token":"lin_oauth_recorded_first","token_type":"Bearer","expires_in":86400,"refresh_token":"lin_refresh_recorded_first","scope":"read,write"}',
        expect: {
          accessToken: "lin_oauth_recorded_first",
          refreshToken: "lin_refresh_recorded_first",
          expiresInMs: 86_400_000,
        },
      },
      {
        name: "rotating refresh inside the grace window",
        grantType: "refresh_token",
        request: [
          { name: "grant_type", value: "refresh_token" },
          { name: "refresh_token", value: "lin_refresh_recorded_first" },
          { name: "client_id", value: "recorded-client-id" },
          { name: "client_secret", value: "recorded-client-secret" },
        ],
        response: '{"access_token":"lin_oauth_recorded_second","token_type":"Bearer","expires_in":86400,"refresh_token":"lin_refresh_recorded_second","scope":"read,write"}',
        expect: {
          accessToken: "lin_oauth_recorded_second",
          refreshToken: "lin_refresh_recorded_second",
          expiresInMs: 86_400_000,
        },
      },
      {
        name: "refresh past the grace window",
        grantType: "refresh_token",
        request: [
          { name: "grant_type", value: "refresh_token" },
          { name: "refresh_token", value: "lin_refresh_recorded_first" },
          { name: "client_id", value: "recorded-client-id" },
          { name: "client_secret", value: "recorded-client-secret" },
        ],
        response: '{"error":"invalid_grant","error_description":"Refresh token is invalid or expired"}',
        expect: null,
      },
    ],
  ],
]);
