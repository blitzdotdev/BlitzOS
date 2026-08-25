import type { StaticProviderManifest } from "./types.js";

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
  custody: "proxy",
  tokenHeader: { name: "Authorization", prefix: "Bearer " },
  // No fixed root: every YouTrack instance has its own URL. The real one lives
  // on the grant (`vendor.baseUrl`) or on the org connection row's
  // `config.proxy.base_url`, and the proxy resolves in that order. A reader
  // that reaches this null refuses rather than inventing a host.
  baseUrl: null,
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
  delivery: {
    env: [
      { name: "YOUTRACK_TOKEN", fill: "token" },
      { name: "YOUTRACK_BASE_URL", fill: "proxy-url" },
    ],
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
} satisfies StaticProviderManifest;
