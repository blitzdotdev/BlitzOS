import type { SkillRenderInput, StaticProviderManifest } from "./types.js";

function skill(input: SkillRenderInput): string {
  const base = input.baseUrlEnv === null ? input.baseUrl : `$${input.baseUrlEnv}`;
  const header = `${input.tokenHeader.name}: ${input.tokenHeader.prefix}$${input.tokenEnv}`;
  return `---
name: ${input.connection}
description: Read and write YouTrack issues, comments, and work items through the REST API.
---

# ${input.connection}

YouTrack access for this workspace, configured once by an organization admin.
Every workspace of this organization that enables the connection gets it — no
per-member authorization step exists or is needed.

## Auth

Send \`${header}\` on every call.

${input.mode === "proxy"
    ? `\`$${input.tokenEnv}\` is a lease token, not a YouTrack credential: it only works against \`${base}\`, and the control plane swaps in the real permanent token on the way out. Nothing on this disk is a YouTrack credential.`
    : `\`$${input.tokenEnv}\` is the YouTrack permanent token itself. Do not echo it, and do not send it anywhere but the instance in \`${base}\`.`}

## Canonical calls

\`\`\`sh
# Who does the token act as
curl -sS -H '${header}' -H 'Accept: application/json' \\
  "${base}/api/users/me?fields=id,login,name"

# Unresolved issues assigned to the token's user
curl -sS -H '${header}' -H 'Accept: application/json' \\
  "${base}/api/issues?query=for:%20me%20%23Unresolved&fields=idReadable,summary,project(shortName)"

# Create an issue (project id from /api/admin/projects?fields=id,shortName)
curl -sS -X POST -H '${header}' -H 'Content-Type: application/json' \\
  "${base}/api/issues?fields=idReadable" \\
  -d '{"project":{"id":"..."},"summary":"...","description":"..."}'

# Comment on an issue
curl -sS -X POST -H '${header}' -H 'Content-Type: application/json' \\
  "${base}/api/issues/DEMO-1/comments?fields=id" \\
  -d '{"text":"..."}'
\`\`\`

## Reach and limits

- Scopes recorded for this connection: ${input.scopes.length === 0 ? "none — the token's own YouTrack permissions are the boundary" : input.scopes.join(", ")}.
- The token acts as the account the admin created it under; actions attribute
  to that account in YouTrack's activity feed.
- Always pass \`fields=\` — YouTrack returns only ids without it.

## When a call fails

A 401 means the lease expired: start a new login shell (or run
\`blitz-cred sync\`) and retry once. A 404 on an issue is usually a project
the token's account cannot see, not a missing issue.
`;
}

/** Admin-configured only: YouTrack instances are per-organization (their URL
 * is part of the credential's identity), and the canonical automation
 * credential is a permanent token created by an admin. There is no per-member
 * connect step — `personalToken: null` makes the grants route refuse pastes —
 * so the org admin stores the token once:
 *
 *   PUT /connections/youtrack  kind=static custody=proxy root=<permanent token>
 *     config.placements = the two env surfaces below
 *     config.proxy.base_url = https://<org>.youtrack.cloud
 *
 * Proxy custody is what lets one connection carry both the token and the
 * instance URL: the box sees a lease token plus a proxy URL, and the control
 * plane rewrites calls onto the real instance with the real token. The
 * permanent token never lands on a box disk. */
export const youtrackManifest = {
  id: "youtrack",
  title: "YouTrack",
  summary: "Issues, comments, and work items on your organization's YouTrack instance.",
  docsUrl: "https://www.jetbrains.com/help/youtrack/devportal/api-authentication.html",
  custody: "proxy",
  // A permanent token neither expires nor rotates; the admin revokes it in
  // YouTrack's own UI and deletes the connection here.
  rotation: "none",
  tokenHeader: { name: "Authorization", prefix: "Bearer " },
  // Placeholder, like the generic entry's: every YouTrack instance has its own
  // URL, and the real one lives in the admin connection's config.proxy.base_url.
  baseUrl: "https://youtrack.invalid",
  auth: null,
  personalToken: null,
  scopes: [],
  defaultScopes: [],
  surfaces: {
    env: [
      { name: "YOUTRACK_TOKEN", fill: "token" },
      { name: "YOUTRACK_BASE_URL", fill: "proxy-url" },
    ],
    skill: { path: ".claude/skills/<provider>/SKILL.md", render: skill },
  },
  probe: {
    // fields= is mandatory: without it YouTrack answers with ids only and the
    // login assertion below would read a healthy instance as broken.
    request: (input) => ({
      method: "GET",
      url: `${input.baseUrl}/api/users/me?fields=id,login,name`,
      headers: [
        { name: input.header.name, value: `${input.header.prefix}${input.token}` },
        { name: "Accept", value: "application/json" },
      ],
      body: null,
    }),
    expect: { status: 200, jsonFields: ["login"] },
  },
  probeFixtures: [
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
  fixtures: [],
} satisfies StaticProviderManifest;
