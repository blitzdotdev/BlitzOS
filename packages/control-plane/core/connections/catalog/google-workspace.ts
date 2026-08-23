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

Send \`${header}\` on every call.

${input.mode === "proxy"
    ? `\`$${input.tokenEnv}\` is a lease token, not a Google credential: it works only against \`${base}\`, and the control plane swaps in a fresh access token on the way out. That swap is why an access token can never go stale mid-task.`
    : `\`$${input.tokenEnv}\` is a Google access token. It lives one hour and is replaced at the next shell login.`}

## Canonical calls

\`\`\`sh
# Drive — only files this app created or the user picked
curl -sS -H '${header}' "${base}/drive/v3/files?pageSize=10&fields=files(id,name)"

# Calendar — next events
curl -sS -H '${header}' "${base}/calendar/v3/calendars/primary/events?maxResults=10&singleEvents=true&orderBy=startTime"

# Gmail — send only, never read
curl -sS -X POST -H '${header}' "${base}/gmail/v1/users/me/messages/send" \\
  -H 'Content-Type: application/json' \\
  -d '{"raw":"<base64url RFC 2822 message>"}'
\`\`\`

## Reach and limits

- Granted scopes: ${input.scopes.length === 0 ? "none recorded" : input.scopes.join(", ")}.
- \`drive.file\` is per-file: the agent sees files it created or the person
  explicitly picked, not the whole Drive. Listing an unrelated document and
  finding nothing is the scope working, not a bug.
- \`gmail.send\` cannot read mail. Do not attempt a mailbox search.

## When a call returns 401 or 403

401 means the lease expired — start a new login shell and retry once. 403 with
\`insufficientPermissions\` means the scope was never granted; report which
scope is missing instead of retrying.
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
  tokenHeader: { name: "Authorization", prefix: "Bearer " },
  baseUrl: "https://www.googleapis.com",
  auth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdVar: "GOOGLE_CONNECT_CLIENT_ID",
    clientSecretVar: "GOOGLE_CONNECT_CLIENT_SECRET",
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
  surfaces: {
    env: [
      { name: "GOOGLE_OAUTH_TOKEN", fill: "token" },
      { name: "GOOGLE_API_BASE_URL", fill: "proxy-url" },
    ],
    skill,
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
    expect: { jsonFields: ["user.emailAddress"] },
  },
} satisfies OAuthProviderManifest;
