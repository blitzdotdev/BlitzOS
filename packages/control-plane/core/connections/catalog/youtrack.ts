import { nodeFetch } from "./skill-code.js";
import type { SkillRenderInput, StaticProviderManifest } from "./types.js";

function skill(input: SkillRenderInput): string {
  const base = input.baseUrlEnv === null ? input.baseUrl : `$${input.baseUrlEnv}`;
  const header = `${input.tokenHeader.name}: ${input.tokenHeader.prefix}$${input.tokenEnv}`;
  return `---
name: ${input.connection}
description: Read and write YouTrack issues, comments, and work items through the REST API.
---

# ${input.connection}

YouTrack access for this workspace. The credential is the workspace owner's
own permanent token: every action attributes to that member, and their
YouTrack account's permissions are the boundary of what the agent can reach.

## Auth

Send \`${header}\` on every call.

${input.mode === "proxy"
    ? `\`$${input.tokenEnv}\` is a lease token, not a YouTrack credential: it only works against \`${base}\`, and the control plane swaps in the member's real permanent token on the way out. The token itself stays in the control plane and never lands on this disk.`
    : `\`$${input.tokenEnv}\` is the member's permanent token itself. Do not echo it, and do not send it anywhere but the instance in \`${base}\`.`}

## Canonical calls

\`\`\`sh
# Who does the token act as
${nodeFetch(input, {
    path: "/api/users/me?fields=id,login,name",
    headers: { Accept: "application/json" },
  })}

# Unresolved issues assigned to the token's user
${nodeFetch(input, {
    path: "/api/issues?query=for:%20me%20%23Unresolved&fields=idReadable,summary,project(shortName)",
    headers: { Accept: "application/json" },
  })}

# Create an issue (project id from /api/admin/projects?fields=id,shortName)
${nodeFetch(input, {
    path: "/api/issues?fields=idReadable",
    method: "POST",
    body: `{project: {id: "..."}, summary: "...", description: "..."}`,
  })}

# Comment on an issue
${nodeFetch(input, {
    path: "/api/issues/DEMO-1/comments?fields=id",
    method: "POST",
    body: `{text: "..."}`,
  })}
\`\`\`

## Reach and limits

- Scopes recorded for this connection: ${input.scopes.length === 0 ? "none — the member's own YouTrack permissions are the boundary" : input.scopes.join(", ")}.
- Actions render as the member who connected the token in YouTrack's
  activity feed.
- Always pass \`fields=\` — YouTrack returns only ids without it.

## When a call fails

A 401 means the lease expired: start a new login shell (or run
\`blitz-cred sync\`) and retry once. If it still fails, the member's token was
revoked in YouTrack — say so instead of retrying. A 404 on an issue is
usually a project the member cannot see, not a missing issue.
`;
}

/** Per-member permanent tokens, linear-style: each member pastes their own
 * token and every action attributes to them, bounded by their YouTrack
 * account. Custody is proxy, so the pasted token stays in the control plane
 * and a box only ever holds a lease token.
 *
 * YouTrack is instance-hosted, so the paste form also collects the instance
 * URL (`personalToken.baseUrlLabel`). The first member's URL lands on the org
 * connection row; later members inherit it — their form prefills and locks
 * it, and their grants resolve through the row at proxy time. */
export const youtrackManifest = {
  id: "youtrack",
  title: "YouTrack",
  summary: "Issues, comments, and work items on your organization's YouTrack instance.",
  docsUrl: "https://www.jetbrains.com/help/youtrack/devportal/api-authentication.html",
  custody: "proxy",
  // A permanent token neither expires nor rotates; the member revokes it in
  // YouTrack's own UI and re-pastes to replace it here.
  rotation: "none",
  tokenHeader: { name: "Authorization", prefix: "Bearer " },
  // Placeholder, like the generic entry's: every YouTrack instance has its
  // own URL. The real one lives on the grant (`vendor.baseUrl`) or on the org
  // connection row's `config.proxy.base_url`, and the proxy resolves in that
  // order.
  baseUrl: "https://youtrack.invalid",
  auth: null,
  personalToken: {
    label: "Permanent token",
    help: "Your instance → profile avatar → Account Security → Tokens → New token. The token acts as you: agents reach exactly the projects your account can.",
    header: { name: "Authorization", prefix: "Bearer " },
    baseUrlLabel: "Instance URL",
  },
  adminForm: null,
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
