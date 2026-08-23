import { nodeFetch } from "./skill-code.js";
import type { OAuthProviderManifest, SkillRenderInput } from "./types.js";

const HOUR_MS = 60 * 60 * 1_000;

function skill(input: SkillRenderInput): string {
  const base = input.baseUrlEnv === null ? input.baseUrl : `$${input.baseUrlEnv}`;
  const header = `${input.tokenHeader.name}: ${input.tokenHeader.prefix}$${input.tokenEnv}`;
  return `---
name: ${input.connection}
description: Read and write Linear issues, projects, and comments through the GraphQL API.
---

# ${input.connection}

Linear access for this workspace. Everything the agent does renders as
"you (via the app)" in Linear's activity feed.

## Auth

Send \`${header}\` on every call.

${input.mode === "proxy"
    ? `\`$${input.tokenEnv}\` is a lease token, not a Linear credential: it only works against \`${base}\`, and the control plane swaps in the real key on the way out. Nothing on this disk is a Linear credential.`
    : `\`$${input.tokenEnv}\` is the Linear credential itself. Do not echo it, and do not send it anywhere but api.linear.app.`}

Linear has exactly one endpoint. There is no REST API.

## Canonical calls

\`\`\`sh
# Who am I
${nodeFetch(input, {
    path: "/graphql",
    method: "POST",
    body: `{query: "{ viewer { id name email } }"}`,
  })}

# My open issues
${nodeFetch(input, {
    path: "/graphql",
    method: "POST",
    body: `{query: "{ issues(filter:{assignee:{isMe:{eq:true}}}, first:20){ nodes { identifier title state { name } } } }"}`,
  })}

# Create an issue
${nodeFetch(input, {
    path: "/graphql",
    method: "POST",
    body: `{query: "mutation($t:String!,$team:String!){ issueCreate(input:{title:$t,teamId:$team}){ issue { identifier url } } }", variables: {t: "...", team: "..."}}`,
  })}
\`\`\`

## Reach and limits

- Scopes recorded for this connection: ${input.scopes.length === 0 ? "none recorded" : input.scopes.join(", ")}. A pasted key carries whatever
  reach its owner gave it; nothing here narrows that.
- 5,000 requests per hour on an OAuth token, 2,500 on a personal API key.
- Webhooks need the \`admin\` scope. Without it, poll instead of subscribing.
- Official MCP server: \`https://mcp.linear.app/mcp\` (streamable HTTP). It
  accepts a pre-supplied bearer token, so this connection's value works there.

## When a call fails

Linear answers 200 with an \`errors\` array for most failures — check it, do
not trust the status alone. A genuine 401 means the lease expired: start a new
login shell and retry once.
`;
}

/** Lightest admin friction of the three: any member may authorize, and the
 * personal API key path needs no app registration at all. */
export const linearManifest = {
  id: "linear",
  title: "Linear",
  summary: "Issues, projects, and comments through Linear's single GraphQL endpoint.",
  docsUrl: "https://developers.linear.app/docs/oauth/authentication",
  custody: "proxy",
  // Rotating refresh with a 30-minute replay grace: a lost race survives, so
  // refreshes need no cross-request lock, only a compare-and-set.
  rotation: "graceful",
  tokenHeader: { name: "Authorization", prefix: "Bearer " },
  baseUrl: "https://api.linear.app",
  auth: {
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    clientIdVar: "LINEAR_CLIENT_ID",
    clientSecretVar: "LINEAR_CLIENT_SECRET",
    pkce: true,
    // actor=user keeps attribution on the human. actor=app is the agent-identity
    // path, parked with installation tokens.
    authorizeParams: [{ name: "actor", value: "user" }],
    scopeDelimiter: ",",
    accessTtlMs: 24 * HOUR_MS,
    redirectPath: "/connect/linear/callback",
  },
  personalToken: {
    label: "Personal API key",
    help: "linear.app → Settings → Security & access → Personal API keys. Keys do not expire and can be scoped per team. Admins can disable key creation for members.",
    // The header quirk this manifest field exists for: personal API keys take
    // a raw Authorization value, with no Bearer prefix.
    header: { name: "Authorization", prefix: "" },
    baseUrlLabel: null,
  },
  adminForm: null,
  scopes: [
    { id: "read", title: "Read", detail: "Read issues, projects, comments, and team structure." },
    { id: "write", title: "Write", detail: "Create and edit issues, projects, and comments." },
    { id: "issues:create", title: "Create issues only", detail: "Narrower than write: file issues without editing existing ones." },
    { id: "comments:create", title: "Comment only", detail: "Narrower than write: comment without editing issues." },
    { id: "admin", title: "Admin", detail: "Workspace administration, including webhook management. Grant only when change observation is needed." },
  ],
  defaultScopes: ["read", "write"],
  surfaces: {
    env: [
      { name: "LINEAR_API_KEY", fill: "token" },
      // The <PROVIDER>_TOKEN alias, for the same reason github carries three.
      { name: "LINEAR_TOKEN", fill: "token" },
      { name: "LINEAR_API_URL", fill: "proxy-url" },
    ],
    skill: { path: ".claude/skills/<provider>/SKILL.md", render: skill },
  },
  probe: {
    request: (input) => ({
      method: "POST",
      url: `${input.baseUrl}/graphql`,
      headers: [
        { name: input.header.name, value: `${input.header.prefix}${input.token}` },
        { name: "Content-Type", value: "application/json" },
      ],
      body: '{"query":"{ viewer { id name } }"}',
    }),
    expect: { status: 200, jsonFields: ["data.viewer.id"] },
  },
  probeFixtures: [
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
  fixtures: [
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
} satisfies OAuthProviderManifest;
