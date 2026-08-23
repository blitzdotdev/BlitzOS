import type { OAuthProviderManifest, SkillRenderInput } from "./types.js";

const HOUR_MS = 60 * 60 * 1_000;

function skill(input: SkillRenderInput): string {
  const header = `${input.tokenHeader.name}: ${input.tokenHeader.prefix}$${input.tokenEnv}`;
  // Two different credentials wear the same environment variable, and they are
  // wrong about each other in ways an agent cannot guess. The App token dies
  // in eight hours and reaches whatever the installation covers; a pasted
  // fine-grained PAT has its own expiry (often none of ours) and reaches only
  // the repositories the person listed when they created it.
  const pasted = input.grantKind === "pat";
  const auth = input.mode === "proxy"
    ? `Send \`${header}\` to \`${input.baseUrl}\`, which swaps in the real token server-side. The token itself never lands on this disk.`
    : pasted
      ? `Send \`${header}\`. The token is a personal access token the workspace owner pasted. It carries whatever reach and lifetime they gave it — this workspace neither narrows it nor expires it.`
      : `Send \`${header}\`. The token is a GitHub App user access token: it expires 8 hours after issue and is replaced at the next shell login.`;
  const reach = pasted
    ? `- The token reaches exactly the repositories its own list names, with the
  permissions chosen when it was created. **A 403 or 404 on a repository
  almost always means the repository is outside that list**, not that it is
  missing or that the account lacks access.
- \`git clone\` over HTTPS reports an out-of-scope repository as
  \`remote: Write access to repository not granted\` even for a read. That
  wording is GitHub's, and it means out-of-scope, not read-only. Ask for the
  repository to be added to the token instead of retrying.`
    : `- The token reaches the intersection of the App installation's repositories
  and permissions with the connecting person's own access. A 404 on a repo
  usually means the App was never installed there, not that the repo is gone.`;
  return `---
name: ${input.connection}
description: Read and write GitHub through the REST API and the gh CLI, acting as the workspace owner.
---

# ${input.connection}

This workspace holds a GitHub credential. Actions attribute to the human who
connected it, badged with the app that issued the token.

## Auth

${auth}

\`gh\` reads \`$${input.tokenEnv}\` natively, and \`git\` reads it through this
box's credential helper, so \`gh pr create\`, \`git clone\`, and \`git push\`
over HTTPS all work with no extra setup.

## Canonical calls

\`\`\`sh
# Who the token acts as
gh api user

# Repositories the token can reach
curl -sS -H '${header}' "${input.baseUrl}/user/repos?per_page=20"

# Open a pull request
gh api repos/{owner}/{repo}/pulls --method POST \\
  --field title=... --field head=... --field base=main
\`\`\`

## Reach and limits

${reach}
- Permissions recorded for this connection: ${input.scopes.length === 0 ? "none recorded" : input.scopes.join(", ")}. This records the provider's own
  vocabulary, not a narrowing: the token's own ceiling is the ceiling.
- 5,000 requests per hour.

## When a call returns 401

The lease expired. Run \`blitz-cred sync\` (or start a new login shell) and
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
  custody: "cp",
  // GitHub refresh tokens are single-use: a refresh re-issues both tokens and
  // kills the old pair. Nothing here serializes refreshes — one shared refresh
  // path runs them, and the compare-and-set in `rotateGrantTokens` guards the
  // database write alone. A loser re-reads the row and uses the winner's token.
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
  },
  personalToken: {
    label: "Fine-grained personal access token",
    help: "github.com → Settings → Developer settings → Personal access tokens → Fine-grained. Scope it to the repositories the agent needs. Some organizations require an owner to approve each token.",
    header: { name: "Authorization", prefix: "Bearer " },
    baseUrlLabel: null,
  },
  // The org path: a GitHub App credential PUT as kind app-jwt (app id,
  // installation id, private key). It satisfies a template's github with no
  // member step; a member's own OAuth grant still wins at mint.
  adminForm: {
    rootLabel: "App private key (.pem)",
    rootHelp: "github.com → Settings → Developer settings → GitHub Apps → your app → Private keys → Generate a private key. Drop the downloaded .pem file here — it works as-is. Install the app on the repositories agents should reach.",
    app: {
      appIdLabel: "App ID",
      installationIdLabel: "Installation ID",
    },
  },
  // Empty on purpose. GitHub App user tokens carry no OAuth scope string:
  // reach comes from the App's installation permissions, GitHub ignores the
  // `scope` parameter on authorize, and the org-app mint narrows from the
  // connection row's config rather than from here. This list once held six
  // display entries for a scope-checkbox UI; that UI is gone, so nothing could
  // select them and a pasted token recorded a vocabulary it never carried.
  scopes: [],
  // Kept because a live consumer reads it: the OAuth callback records these on
  // the grant, and the skill prints them as what this connection asked for.
  defaultScopes: ["metadata:read", "contents:read", "contents:write", "pull_requests:write"],
  delivery: {
    env: [
      { name: "GH_TOKEN", fill: "token" },
      { name: "GITHUB_TOKEN", fill: "token" },
      { name: "GITHUB_PERSONAL_ACCESS_TOKEN", fill: "token" },
    ],
    skill: { path: ".claude/skills/<provider>/SKILL.md", render: skill },
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
} satisfies OAuthProviderManifest;
