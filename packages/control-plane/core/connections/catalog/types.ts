import type { Custody, Placement } from "../types.js";

/** How a provider treats the refresh token it hands back.
 *  - `strict`   single-use: every refresh invalidates the previous token, so
 *               refreshes must serialize per grant (GitHub).
 *  - `graceful` rotating with a replay window, so a lost race is survivable
 *               (Linear, 30 minutes).
 *  - `none`     one refresh token mints access tokens forever (Google). */
export type RotationMode = "strict" | "graceful" | "none";

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

export interface ProviderAuth {
  authorizeUrl: string;
  tokenUrl: string;
  /** Worker binding names, never values. An instance without them configured
   * fails /connect with a message instead of redirecting into a broken flow. */
  clientIdVar: string;
  clientSecretVar: string;
  pkce: boolean;
  /** Sent verbatim on the authorize redirect (Google offline consent, Linear actor). */
  authorizeParams: readonly ProviderParam[];
  /** Documented access-token lifetime, used when an exchange omits expires_in. */
  accessTtlMs: number;
  /** How the provider joins requested scopes. Linear wants commas, the rest
   * want spaces, and getting it wrong reads as "invalid scope". */
  scopeDelimiter: " " | ",";
  /** Redirect URI path registered with the provider, for the ops runbook. */
  redirectPath: string;
}

/** The day-one path: a key the person creates in the provider's own UI. */
export interface ProviderPersonalToken {
  label: string;
  help: string;
  /** Personal keys can want a different header shape than OAuth tokens. */
  header: TokenHeader;
}

export type PlacementFill = "token" | "proxy-url";

export interface ProviderEnvSurface {
  name: string;
  fill: PlacementFill;
}

/** Rendered into the lease as a `file` placement. A skill named `<provider>`
 * is what makes "use @<provider>" resolve in any harness that reads skills. */
export interface ProviderSkillSurface {
  /** Relative to the box HOME; the compiler makes it absolute. */
  path: string;
  render(input: SkillRenderInput): string;
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

/** Phase B reads this out of the rendered mcp.json; Phase A only renders it. */
export interface ProviderMcpSurface {
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: readonly string[];
  /** Environment names the server reads, matched against the env surfaces. */
  envFrom: readonly string[];
}

export interface ProviderSurfaces {
  env: readonly ProviderEnvSurface[];
  skill: ProviderSkillSurface;
  mcp: ProviderMcpSurface;
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

/** The shape a healthy answer has. `jsonFields` are dotted paths that must
 * resolve to a non-empty string; an empty list means the status is the whole
 * contract. */
export interface ProbeExpectation {
  status: number;
  jsonFields: readonly string[];
}

export interface ProviderProbe {
  request(input: ProbeInput): ProbeRequest;
  expect: ProbeExpectation;
}

export interface ProbeFixture {
  name: string;
  status: number;
  response: string;
  healthy: boolean;
}

export interface ExchangeExpectation {
  accessToken: string;
  refreshToken: string | null;
  expiresInMs: number;
}

/** A recorded provider answer. The generic exchange is only ever proven
 * against these, never against a live provider, so they are mandatory. */
export interface ExchangeFixture {
  name: string;
  grantType: "authorization_code" | "refresh_token";
  /** Form fields the exchange must send, asserted field by field. */
  request: readonly ProviderParam[];
  response: string;
  /** `null` records a rejection the exchange must surface as an error —
   * a replayed single-use refresh is a fixture, not a hypothetical. */
  expect: ExchangeExpectation | null;
}

interface ProviderManifestBase {
  id: string;
  title: string;
  summary: string;
  docsUrl: string;
  custody: Custody;
  rotation: RotationMode;
  /** Header shape for OAuth-issued tokens. */
  tokenHeader: TokenHeader;
  /** Vendor API root; proxy custody rewrites box calls onto it. */
  baseUrl: string;
  personalToken: ProviderPersonalToken | null;
  scopes: readonly ProviderScope[];
  defaultScopes: readonly string[];
  surfaces: ProviderSurfaces;
  probe: ProviderProbe;
  probeFixtures: readonly [ProbeFixture, ...ProbeFixture[]];
}

export interface OAuthProviderManifest extends ProviderManifestBase {
  auth: ProviderAuth;
  fixtures: readonly [ExchangeFixture, ...ExchangeFixture[]];
}

/** No authorize endpoint: the credential is pasted, not redirected for. */
export interface StaticProviderManifest extends ProviderManifestBase {
  auth: null;
  fixtures: readonly [];
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
