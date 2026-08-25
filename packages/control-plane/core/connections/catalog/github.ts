import type { OAuthProviderManifest } from "./types.js";

const HOUR_MS = 60 * 60 * 1_000;

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
  // the grant, and the lease records them as what this connection asked for.
  defaultScopes: ["metadata:read", "contents:read", "contents:write", "pull_requests:write"],
  delivery: {
    env: [
      { name: "GH_TOKEN", fill: "token" },
      { name: "GITHUB_TOKEN", fill: "token" },
      { name: "GITHUB_PERSONAL_ACCESS_TOKEN", fill: "token" },
    ],
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
