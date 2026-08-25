import type { OAuthProviderManifest } from "./types.js";

const HOUR_MS = 60 * 60 * 1_000;

/** Google's cost is paperwork, not protocol: the scope posture below
 * (drive.file + calendar + gmail.send) is the widest set that needs no CASA
 * assessment. Restricted Gmail read is deliberately absent. */
export const googleWorkspaceManifest = {
  id: "google-workspace",
  title: "Google Workspace",
  summary: "Drive file handoff, calendar scheduling, and outbound mail as you.",
  custody: "proxy",
  // One refresh token mints unlimited parallel access tokens; nothing rotates.
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
  delivery: {
    env: [
      { name: "GOOGLE_OAUTH_TOKEN", fill: "token" },
      // The <PROVIDER>_TOKEN alias every other provider answers to. An agent
      // that guesses a variable name guesses this one first, and guessing
      // wrong reads as "not connected".
      { name: "GOOGLE_TOKEN", fill: "token" },
      { name: "GOOGLE_API_BASE_URL", fill: "proxy-url" },
    ],
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
} satisfies OAuthProviderManifest;
