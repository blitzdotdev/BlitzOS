import type { StaticProviderManifest } from "./types.js";


/** A personal access token, and nothing else. Every action attributes to the
 * person whose token it is, which is the whole point — a shared org credential
 * attributes to the app instead.
 *
 * The GitHub App paths that used to live here are gone: user OAuth, and an org
 * credential minting installation tokens. Both worked, and both cost an
 * install dance and a second class of credential to reach the attribution one
 * pasted token already gives. Custody stays `cp` because git talks to
 * github.com directly and cannot ride the proxy. */
export const githubManifest = {
  id: "github",
  title: "GitHub",
  summary: "Repos, pull requests, and issues as you, through a personal access token.",
  custody: "cp",
  // GitHub refresh tokens are single-use: a refresh re-issues both tokens and
  // kills the old pair. Nothing here serializes refreshes — one shared refresh
  // path runs them, and the compare-and-set in `rotateGrantTokens` guards the
  // database write alone. A loser re-reads the row and uses the winner's token.
  tokenHeader: { name: "Authorization", prefix: "Bearer " },
  baseUrl: "https://api.github.com",
  auth: null,
  personalToken: {
    label: "Fine-grained personal access token",
    help: "github.com → Settings → Developer settings → Personal access tokens → Fine-grained. Scope it to the repositories the agent needs. Some organizations require an owner to approve each token.",
    header: { name: "Authorization", prefix: "Bearer " },
    baseUrlLabel: null,
  },
  adminForm: null,
  // Empty on purpose. A fine-grained token carries its reach in the token
  // itself, chosen on github.com; nothing here can narrow or widen it. This
  // list once held display entries for a scope-checkbox UI that no longer
  // exists, so a pasted token recorded a vocabulary it never carried.
  scopes: [],
  // Kept because a live consumer reads it: the lease records these as what
  // this connection asked for.
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
} satisfies StaticProviderManifest;
