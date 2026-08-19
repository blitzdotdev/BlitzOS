import type { OAuthProviderManifest, SkillRenderInput } from "./types.js";

const HOUR_MS = 60 * 60 * 1_000;

function skill(input: SkillRenderInput): string {
  const header = `${input.tokenHeader.name}: ${input.tokenHeader.prefix}$${input.tokenEnv}`;
  const auth = input.mode === "proxy"
    ? `Send \`${header}\` to \`${input.baseUrl}\`, which swaps in the real token server-side. The token itself never lands on this disk.`
    : `Send \`${header}\`. The token is a GitHub App user access token: it expires 8 hours after issue and is replaced at the next shell login.`;
  return `---
name: ${input.connection}
description: Read and write GitHub through the REST API and the gh CLI, acting as the workspace owner.
---

# ${input.connection}

This workspace holds a GitHub credential. Actions attribute to the human who
connected it, badged with the app that issued the token.

## Auth

${auth}

\`gh\` and \`git\` read \`$${input.tokenEnv}\` natively, so \`gh pr create\` and
\`git push\` work with no extra setup.

## Canonical calls

\`\`\`sh
gh api user
gh api repos/{owner}/{repo}/pulls --method POST --field title=... --field head=... --field base=...
curl -sS -H '${header}' ${input.baseUrl}/user/repos
\`\`\`

## Reach and limits

- The token reaches the intersection of the App installation's repositories
  and permissions with the connecting person's own access. A 404 on a repo
  usually means the App was never installed there, not that the repo is gone.
- Granted permissions here: ${input.scopes.length === 0 ? "none recorded" : input.scopes.join(", ")}.
- 5,000 requests per hour.

## When a call returns 401

The lease expired. Start a new login shell (or run \`blitz-cred sync\`) and
retry once. If it still fails, the grant needs reconnecting from the
Connections panel — say so instead of retrying.
`;
}

/** GitHub App **user access tokens**, not installation tokens: every action
 * attributes to a person. Custody is `cp` because git talks to github.com
 * directly and cannot ride the proxy; the on-disk token is only ever the
 * 8-hour `ghu_`. */
export const githubManifest = {
  id: "github",
  title: "GitHub",
  summary: "Repos, pull requests, and issues as you, through a GitHub App user token.",
  docsUrl: "https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app",
  custody: "cp",
  // Refresh tokens are strictly single-use: every refresh re-issues both
  // tokens and kills the old pair, so refreshes serialize per grant.
  rotation: "strict",
  tokenHeader: { name: "Authorization", prefix: "Bearer " },
  baseUrl: "https://api.github.com",
  auth: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientIdVar: "GITHUB_APP_CLIENT_ID",
    clientSecretVar: "GITHUB_APP_CLIENT_SECRET",
    pkce: true,
    authorizeParams: [],
    scopeDelimiter: " ",
    accessTtlMs: 8 * HOUR_MS,
    redirectPath: "/connect/github/callback",
  },
  personalToken: {
    label: "Fine-grained personal access token",
    help: "github.com → Settings → Developer settings → Personal access tokens → Fine-grained. Scope it to the repositories the agent needs. Some organizations require an owner to approve each token.",
    header: { name: "Authorization", prefix: "Bearer " },
  },
  // GitHub App user tokens carry no OAuth scope string: reach comes from the
  // App's installation permissions. These entries name what the person is
  // consenting to hand an agent, and double as the mint ceiling.
  scopes: [
    { id: "metadata:read", title: "Repository metadata", detail: "See which repositories the agent may touch." },
    { id: "contents:read", title: "Read code", detail: "Clone and read file contents on the installed repositories." },
    { id: "contents:write", title: "Write code", detail: "Push commits and branches." },
    { id: "pull_requests:write", title: "Pull requests", detail: "Open, comment on, and update pull requests." },
    { id: "issues:write", title: "Issues", detail: "Open and comment on issues." },
    { id: "workflows:write", title: "Actions workflows", detail: "Change workflow files, which can change what CI runs." },
  ],
  defaultScopes: ["metadata:read", "contents:read", "contents:write", "pull_requests:write"],
  surfaces: {
    env: [
      { name: "GH_TOKEN", fill: "token" },
      { name: "GITHUB_TOKEN", fill: "token" },
      { name: "GITHUB_PERSONAL_ACCESS_TOKEN", fill: "token" },
    ],
    skill: { path: ".claude/skills/<provider>/SKILL.md", render: skill },
    mcp: {
      name: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      command: null,
      args: [],
      envFrom: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    },
  },
  probe: {
    request: (input) => ({
      method: "GET",
      url: `${input.baseUrl}/user`,
      headers: [
        { name: input.header.name, value: `${input.header.prefix}${input.token}` },
        { name: "Accept", value: "application/vnd.github+json" },
        { name: "User-Agent", value: "blitz-control-plane" },
      ],
      body: null,
    }),
    expect: { status: 200, jsonFields: ["login"] },
  },
  probeFixtures: [
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
  fixtures: [
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
} satisfies OAuthProviderManifest;
