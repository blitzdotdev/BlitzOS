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
  tokenHeader: { name: "Authorization", prefix: "Bearer " },
  baseUrl: "https://api.github.com",
  auth: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientIdVar: "GITHUB_APP_CLIENT_ID",
    clientSecretVar: "GITHUB_APP_CLIENT_SECRET",
    authorizeParams: [],
    scopeDelimiter: " ",
    accessTtlMs: 8 * HOUR_MS,
  },
  personalToken: {
    label: "Fine-grained personal access token",
    help: "github.com → Settings → Developer settings → Personal access tokens → Fine-grained. Scope it to the repositories the agent needs. Some organizations require an owner to approve each token.",
    header: { name: "Authorization", prefix: "Bearer " },
    baseUrlLabel: null,
  },
  // The org path: a GitHub App credential PUT as kind app-jwt (app id,
  // installation id, PKCS#8 key). It satisfies a template's github with no
  // member step; a member's own OAuth grant still wins at mint.
  adminForm: {
    rootLabel: "App private key (PKCS#8 PEM)",
    rootHelp: "github.com → Settings → Developer settings → GitHub Apps → your app → Private keys → Generate a private key. Convert the downloaded PKCS#1 file with: openssl pkcs8 -topk8 -nocrypt. Install the app on the repositories agents should reach.",
    baseUrlLabel: null,
    app: {
      appIdLabel: "App ID",
      installationIdLabel: "Installation ID",
    },
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
    skill,
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
    expect: { jsonFields: ["login"] },
  },
} satisfies OAuthProviderManifest;
