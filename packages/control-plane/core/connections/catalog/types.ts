import type { Custody, Placement } from "../types.js";

/** Bearer material is not always a Bearer: Linear personal API keys go in a
 * raw `Authorization: <key>` header, so the prefix belongs to the provider. */
export interface TokenHeader {
  name: string;
  prefix: string;
}

export interface ProviderParam {
  name: string;
  value: string;
}

/** One consent line. `detail` is what the person reads before granting, so it
 * states what an agent holding the scope can do, not what the API is called. */
export interface ProviderScope {
  id: string;
  title: string;
  detail: string;
}

/** Every catalog OAuth flow runs PKCE, and the registered redirect URI is
 * always `connectRedirectPath(manifest.id)` — both are facts of the connect
 * routes, not per-provider choices, so neither is declared here. */
export interface ProviderAuth {
  authorizeUrl: string;
  tokenUrl: string;
  /** Worker binding names, never values. An instance without them configured
   * fails /connect with a message instead of redirecting into a broken flow. */
  clientIdVar: string;
  clientSecretVar: string;
  /** Sent verbatim on the authorize redirect (Google offline consent, Linear actor). */
  authorizeParams: readonly ProviderParam[];
  /** Documented access-token lifetime, used when an exchange omits expires_in. */
  accessTtlMs: number;
  /** How the provider joins requested scopes. Linear wants commas, the rest
   * want spaces, and getting it wrong reads as "invalid scope". */
  scopeDelimiter: " " | ",";
}

/** The day-one path: a key the person creates in the provider's own UI. */
export interface ProviderPersonalToken {
  label: string;
  help: string;
  /** Personal keys can want a different header shape than OAuth tokens. */
  header: TokenHeader;
  /** Non-null for instance-hosted vendors (YouTrack): the paste form also
   * collects the instance URL. It rides the grant as `vendor.baseUrl`, or is
   * inherited from the org connection row when one already carries it. */
  baseUrlLabel: string | null;
}

export type PlacementFill = "token" | "proxy-url";

export interface ProviderEnvSurface {
  name: string;
  fill: PlacementFill;
}

export interface SkillRenderInput {
  connection: string;
  scopes: readonly string[];
  mode: "inject" | "proxy";
  tokenEnv: string;
  baseUrlEnv: string | null;
  baseUrl: string;
  /** The header the agent must send. In proxy mode that is the lease token's
   * inbound shape, which need not match what the vendor finally receives. */
  tokenHeader: TokenHeader;
}

export interface ProviderSurfaces {
  env: readonly ProviderEnvSurface[];
  /** Rendered into the lease as a `file` placement at `skillPath(connection)`.
   * A skill named `<provider>` is what makes "use @<provider>" resolve in any
   * harness that reads skills. Null exactly for admin-only providers (no
   * OAuth, no personal token): they cannot back a grant, and grant mints are
   * the only path that renders a skill — the static org-root minter fills the
   * connection row's own placements instead. */
  skill: ((input: SkillRenderInput) => string) | null;
}

/** Declares the org-admin path: an admin stores one static root through
 * `PUT /connections/:id` and every workspace of the organization mints from
 * it, with no per-member step. The settings panel renders its whole form from
 * this block — one secret input for the root, plus the instance URL when
 * custody is proxy. Everything else the PUT needs (kind, custody, placements,
 * the proxy header) is already on the manifest. */
export interface ProviderAdminForm {
  /** What the secret input is called, e.g. "Permanent token". */
  rootLabel: string;
  /** Where the admin creates the credential, shown under the input. */
  rootHelp: string;
  /** Label for the instance-URL input, which becomes `config.proxy.base_url`.
   * Non-null exactly when custody is "proxy" (the conformance suite pins it). */
  baseUrlLabel: string | null;
  /** The GitHub App shape: non-null when the admin credential is an app-jwt
   * root (app id + installation id + PKCS#8 key), not a static token. The
   * only admin form allowed to coexist with member OAuth — grants win at
   * mint, the app credential is the org fallback (the conformance suite pins
   * both rules). */
  app: { appIdLabel: string; installationIdLabel: string } | null;
}

export interface ProbeInput {
  token: string;
  baseUrl: string;
  header: TokenHeader;
}

export interface ProbeRequest {
  method: "GET" | "POST";
  url: string;
  headers: readonly ProviderParam[];
  body: string | null;
}

/** The shape a healthy answer has beyond the 200 every probe requires.
 * `jsonFields` are dotted paths that must resolve to a non-empty string; an
 * empty list means the status is the whole contract. */
export interface ProbeExpectation {
  jsonFields: readonly string[];
}

export interface ProviderProbe {
  request(input: ProbeInput): ProbeRequest;
  expect: ProbeExpectation;
}

interface ProviderManifestBase {
  id: string;
  title: string;
  summary: string;
  docsUrl: string;
  custody: Custody;
  /** Header shape for OAuth-issued tokens. */
  tokenHeader: TokenHeader;
  /** Vendor API root; proxy custody rewrites box calls onto it. */
  baseUrl: string;
  personalToken: ProviderPersonalToken | null;
  /** Non-null for providers an org admin configures once, org-wide. */
  adminForm: ProviderAdminForm | null;
  scopes: readonly ProviderScope[];
  defaultScopes: readonly string[];
  surfaces: ProviderSurfaces;
  probe: ProviderProbe;
}

/** Recorded provider answers proving each probe and exchange live in test
 * land (test/connections-catalog-fixtures.ts), keyed by manifest id; the
 * conformance suite refuses a manifest that has none. */
export interface OAuthProviderManifest extends ProviderManifestBase {
  auth: ProviderAuth;
}

/** No authorize endpoint: the credential is pasted, not redirected for. */
export interface StaticProviderManifest extends ProviderManifestBase {
  auth: null;
}

export type ProviderManifest = OAuthProviderManifest | StaticProviderManifest;

/** Per-grant configuration for manifests that cannot know the vendor up front
 * (the generic entry). Catalog providers ignore it. */
export interface SurfaceOverrides {
  envName: string;
  baseUrlEnvName: string | null;
  baseUrl: string | null;
}

export interface SurfaceInput {
  connection: string;
  scopes: readonly string[];
  mode: "inject" | "proxy";
  /** Real credential for inject custody, lease token for proxy custody. */
  token: string;
  proxyUrl: string;
  /** Header the box-side caller must send with `token`. */
  tokenHeader: TokenHeader;
  overrides: SurfaceOverrides | null;
}

export type CompiledSurfaces = Placement[];
