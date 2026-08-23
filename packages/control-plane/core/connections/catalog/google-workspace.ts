import { nodeFetch } from "./skill-code.js";
import type { OAuthProviderManifest, SkillRenderInput } from "./types.js";

const HOUR_MS = 60 * 60 * 1_000;

function skill(input: SkillRenderInput): string {
  const base = input.baseUrlEnv === null ? input.baseUrl : `$${input.baseUrlEnv}`;
  const header = `${input.tokenHeader.name}: ${input.tokenHeader.prefix}$${input.tokenEnv}`;
  return `---
name: ${input.connection}
description: Use Google Drive, Calendar, and Gmail send on behalf of the workspace owner.
---

# ${input.connection}

Google Workspace access for this workspace, acting as the person who connected it.

## Auth

Send \`${header}\` on every call, to \`${base}\`. That base URL is this
workspace's Google connection — **it is the only Google access here.** Do not
look for a claude.ai connector and do not run \`/mcp\`: neither is wired into a
workspace session, and reaching for them wastes a turn.

${input.mode === "proxy"
    ? `\`$${input.tokenEnv}\` is a lease token, not a Google credential: it works only against \`${base}\`, and the control plane swaps in the access token on the way out. The access token is refreshed when the lease is minted, not on every call, so a long turn can still outlive it — a 401 means re-sync, not re-plan.`
    : `\`$${input.tokenEnv}\` is a Google access token. It lives one hour and is replaced at the next mint.`}

## Canonical calls

\`\`\`sh
# Drive — only files this app created or the user picked
${nodeFetch(input, { path: "/drive/v3/files?pageSize=10&fields=files(id,name)" })}

# Calendar — next events
${nodeFetch(input, {
    path: "/calendar/v3/calendars/primary/events?maxResults=10&singleEvents=true&orderBy=startTime",
  })}

# Gmail — send only, never read
${nodeFetch(input, {
    path: "/gmail/v1/users/me/messages/send",
    method: "POST",
    body: `{raw: "<base64url RFC 2822 message>"}`,
  })}
\`\`\`

## Reach and limits

- Scopes recorded for this connection: ${input.scopes.length === 0 ? "none recorded" : input.scopes.join(", ")}.
- \`drive.file\` is per-file: the agent sees files it created or the person
  explicitly picked, not the whole Drive. Listing an unrelated document and
  finding nothing is the scope working, not a bug.
- \`gmail.send\` cannot read mail. Do not attempt a mailbox search.

## When a call returns 401 or 403

401 means the credential behind the lease expired — run \`blitz-cred sync\`
(or start a new login shell) and retry once. 403 with
\`insufficientPermissions\` means the scope was never granted; report which
scope is missing instead of retrying. 403 with \`accessNotConfigured\` is a
different thing entirely: the API itself is switched off on the Google Cloud
project behind this deployment. No amount of reconnecting fixes it — report
that the operator must enable that API, and name which one.
`;
}

/** Google's cost is paperwork, not protocol: the scope posture below
 * (drive.file + calendar + gmail.send) is the widest set that needs no CASA
 * assessment. Restricted Gmail read is deliberately absent. */
export const googleWorkspaceManifest = {
  id: "google-workspace",
  title: "Google Workspace",
  summary: "Drive file handoff, calendar scheduling, and outbound mail as you.",
  docsUrl: "https://developers.google.com/identity/protocols/oauth2/web-server",
  custody: "proxy",
  // One refresh token mints unlimited parallel access tokens; nothing rotates.
  rotation: "none",
  tokenHeader: { name: "Authorization", prefix: "Bearer " },
  baseUrl: "https://www.googleapis.com",
  auth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdVar: "GOOGLE_CONNECT_CLIENT_ID",
    clientSecretVar: "GOOGLE_CONNECT_CLIENT_SECRET",
    pkce: true,
    // Without both of these Google returns no refresh token on re-consent,
    // and the grant silently becomes a one-hour connection.
    authorizeParams: [
      { name: "access_type", value: "offline" },
      { name: "prompt", value: "consent" },
      { name: "include_granted_scopes", value: "true" },
    ],
    scopeDelimiter: " ",
    accessTtlMs: HOUR_MS,
    redirectPath: "/connect/google-workspace/callback",
  },
  // Google issues no user-createable API key for Workspace APIs.
  personalToken: null,
  adminForm: null,
  scopes: [
    {
      id: "https://www.googleapis.com/auth/drive.file",
      title: "Drive files the agent creates",
      detail: "Create and edit files the agent makes or you explicitly pick. Not your whole Drive; needs no security assessment.",
    },
    {
      id: "https://www.googleapis.com/auth/calendar",
      title: "Calendar",
      detail: "Read and write events on your calendars. Sensitive scope: the client needs Google app review.",
    },
    {
      id: "https://www.googleapis.com/auth/gmail.send",
      title: "Send mail",
      detail: "Send mail as you. Cannot read your mailbox. Sensitive scope: the client needs Google app review.",
    },
  ],
  defaultScopes: [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/gmail.send",
  ],
  surfaces: {
    env: [
      { name: "GOOGLE_OAUTH_TOKEN", fill: "token" },
      // The <PROVIDER>_TOKEN alias every other provider answers to. An agent
      // that guesses a variable name guesses this one first, and guessing
      // wrong reads as "not connected".
      { name: "GOOGLE_TOKEN", fill: "token" },
      { name: "GOOGLE_API_BASE_URL", fill: "proxy-url" },
    ],
    skill: { path: ".claude/skills/<provider>/SKILL.md", render: skill },
  },
  probe: {
    request: (input) => ({
      method: "GET",
      url: `${input.baseUrl}/drive/v3/about?fields=user%2FemailAddress`,
      headers: [
        { name: input.header.name, value: `${input.header.prefix}${input.token}` },
      ],
      body: null,
    }),
    expect: { status: 200, jsonFields: ["user.emailAddress"] },
  },
  probeFixtures: [
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
  fixtures: [
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
} satisfies OAuthProviderManifest;
