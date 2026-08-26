import type { Custody, TokenHeader } from "../types.js";

export type { TokenHeader };

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
  /** Fallback lifetime for an exchange that omits `expires_in`. No recorded
   * exchange has ever omitted it, so no fixture exercises this number: it is
   * the documented lifetime, kept so a provider that starts omitting the field
   * writes a plausible expiry instead of `NaN`. */
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

export interface ProviderEnvDelivery {
  name: string;
  fill: PlacementFill;
}

/** The environment names a pulled credential answers to. Nothing writes them
 * to disk: `blitz-cred env <provider>` prints them, and the agent scopes them
 * to one command. The names still matter because vendor tooling reads them by
 * name — `gh` looks for `GH_TOKEN` and nothing else. */
export interface ProviderDelivery {
  env: readonly ProviderEnvDelivery[];
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

interface ProviderManifestBase {
  id: string;
  title: string;
  summary: string;
  custody: Custody;
  /** Header shape for OAuth-issued tokens. */
  tokenHeader: TokenHeader;
  /** Vendor API root, or null for an instance-hosted vendor whose URL only the
   * organization knows (YouTrack). Null is not a default to fall back through:
   * every reader must refuse it by name, because a placeholder host is a real
   * credential sent to a machine nobody owns. */
  baseUrl: string | null;
  personalToken: ProviderPersonalToken | null;
  /** Non-null for providers an org admin configures once, org-wide. */
  adminForm: ProviderAdminForm | null;
  /** The provider's own scope vocabulary, and only the entries something can
   * still reach: the authorize URL selects from it, and a pasted key records
   * it. Empty where the provider has no such vocabulary. */
  scopes: readonly ProviderScope[];
  defaultScopes: readonly string[];
  delivery: ProviderDelivery;
  probe: ProviderProbe;
}

export interface OAuthProviderManifest extends ProviderManifestBase {
  auth: ProviderAuth;
}

/** No authorize endpoint: the credential is pasted, not redirected for. */
export interface StaticProviderManifest extends ProviderManifestBase {
  auth: null;
}

export type ProviderManifest = OAuthProviderManifest | StaticProviderManifest;
