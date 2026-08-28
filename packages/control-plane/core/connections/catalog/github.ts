import type { OAuthProviderManifest } from "./types.js";

const HOUR_MS = 60 * 60 * 1_000;

/** Installing the App once on an organization gives every authorized member
 * reach to their own intersection of its repositories. That replaces one
 * fine-grained-token approval per member with one organization-owner action.
 *
 * Authorization still yields the member's user-to-server token. Blitz never
 * mints an installation token, so commits keep the member's identity rather
 * than the App's. Custody stays `cp` because git talks to github.com directly
 * and cannot ride the proxy. */
export const githubManifest = {
  id: "github",
  title: "GitHub",
  summary: "Repos, pull requests, and issues as you, through the BlitzOS App or a personal token.",
  custody: "cp",
  // GitHub refresh tokens rotate on use. The shared refresher's compare-and-set
  // protects the database write, but it does not serialize provider exchanges;
  // concurrent refreshes can still race before either request reaches that
  // write. This manifest cannot repair that generic minter constraint.
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
  adminForm: null,
  // Empty on purpose. GitHub App user tokens and fine-grained personal tokens
  // carry permissions chosen on github.com; neither has an OAuth scope
  // vocabulary this manifest can narrow or widen.
  scopes: [],
  defaultScopes: [],
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
