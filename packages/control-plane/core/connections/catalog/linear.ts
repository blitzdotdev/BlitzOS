import type { OAuthProviderManifest } from "./types.js";

const HOUR_MS = 60 * 60 * 1_000;

/** Lightest admin friction of the three: any member may authorize, and the
 * personal API key path needs no app registration at all. */
export const linearManifest = {
  id: "linear",
  title: "Linear",
  summary: "Issues, projects, and comments through Linear's single GraphQL endpoint.",
  custody: "proxy",
  // Linear rotates the refresh token on every exchange. One shared refresh
  // path runs the exchange, and the compare-and-set in `rotateGrantTokens`
  // guards the database write alone; nothing here serializes the calls.
  tokenHeader: { name: "Authorization", prefix: "Bearer " },
  baseUrl: "https://api.linear.app",
  auth: {
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    clientIdVar: "LINEAR_CLIENT_ID",
    clientSecretVar: "LINEAR_CLIENT_SECRET",
    pkce: true,
    // actor=user keeps attribution on the human. actor=app is the agent-identity
    // path, parked.
    authorizeParams: [{ name: "actor", value: "user" }],
    scopeDelimiter: ",",
    accessTtlMs: 24 * HOUR_MS,
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
  // Exactly the entries `defaultScopes` names, and no more. Linear enforces
  // this list server-side because it rides the authorize URL, which is the one
  // place a provider scope still reaches. The narrower entries this list used
  // to carry (issues:create, comments:create, admin) were selectable only from
  // a scope-checkbox UI that no longer exists.
  scopes: [
    { id: "read", title: "Read", detail: "Read issues, projects, comments, and team structure." },
    { id: "write", title: "Write", detail: "Create and edit issues, projects, and comments." },
  ],
  defaultScopes: ["read", "write"],
  delivery: {
    env: [
      { name: "LINEAR_API_KEY", fill: "token" },
      // The <PROVIDER>_TOKEN alias, for the same reason github carries three.
      { name: "LINEAR_TOKEN", fill: "token" },
      { name: "LINEAR_API_URL", fill: "proxy-url" },
    ],
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
} satisfies OAuthProviderManifest;
