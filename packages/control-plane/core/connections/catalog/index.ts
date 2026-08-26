import type {
  CatalogAdminFormView,
  CatalogEntryView,
} from "../types.js";
import { discordManifest } from "./discord.js";
import { githubManifest } from "./github.js";
import { googleWorkspaceManifest } from "./google-workspace.js";
import { linearManifest } from "./linear.js";
import { youtrackManifest } from "./youtrack.js";
import type { ProviderManifest } from "./types.js";

/** Add a provider by adding a module here. Everything else — conformance
 * tests, the picker, the canary, the delivery — reads the manifest. */
export const CATALOG: readonly ProviderManifest[] = [
  githubManifest,
  googleWorkspaceManifest,
  linearManifest,
  discordManifest,
  youtrackManifest,
];

export function providerManifest(id: string): ProviderManifest | null {
  return CATALOG.find((manifest) => manifest.id === id) ?? null;
}

/** The redirect URI this instance registers with a provider. It is derived, not
 * declared: every provider has always used the same shape, and a manifest field
 * holding a constant invites the one typo the OAuth round trip cannot survive. */
export function providerRedirectPath(manifest: ProviderManifest): string {
  return `/connect/${manifest.id}/callback`;
}

/** Raised when a caller needs a vendor root that the manifest does not have.
 * Instance-hosted vendors declare `baseUrl: null`, and the organization's own
 * URL rides the connection row instead. Falling back to a placeholder host
 * would point a live credential at a machine nobody owns, so this throws. */
export class MissingBaseUrlError extends Error {
  constructor(manifest: ProviderManifest, purpose: string) {
    super(`${manifest.id} declares no base URL; ${purpose} needs the instance URL from its connection row`);
    this.name = "MissingBaseUrlError";
  }
}

/** The vendor root a manifest declares, or a loud failure. */
export function manifestBaseUrl(
  manifest: ProviderManifest,
  purpose: string,
): string {
  const baseUrl = manifest.baseUrl;
  if (baseUrl === null) throw new MissingBaseUrlError(manifest, purpose);
  return baseUrl;
}

/** The admin form, compiled so the panel can submit `PUT /connections/:id`
 * without knowing anything about manifests: the placements come from the env
 * deliveries. */
function adminFormView(manifest: ProviderManifest): CatalogAdminFormView | null {
  const form = manifest.adminForm;
  if (form === null) return null;
  return {
    rootLabel: form.rootLabel,
    rootHelp: form.rootHelp,
    placements: manifest.delivery.env.map(({ name, fill }) => ({
      kind: "env" as const,
      name,
      fill,
    })),
  };
}

/** What the connect picker needs, and nothing that names a secret value.
 * `oauthConfigured` is the honest answer to "will the Connect button work on
 * this instance", computed from the presence of the declared bindings. */
export function catalogView(
  manifest: ProviderManifest,
  secret: (name: string) => string | undefined,
): CatalogEntryView {
  const auth = manifest.auth;
  const configured =
    auth !== null &&
    (secret(auth.clientIdVar) ?? "") !== "" &&
    (secret(auth.clientSecretVar) ?? "") !== "";
  return {
    id: manifest.id,
    title: manifest.title,
    summary: manifest.summary,
    custody: manifest.custody,
    oauthAvailable: auth !== null,
    oauthConfigured: configured,
    personalTokenLabel: manifest.personalToken?.label ?? null,
    personalTokenHelp: manifest.personalToken?.help ?? null,
    personalTokenBaseUrlLabel: manifest.personalToken?.baseUrlLabel ?? null,
    adminForm: adminFormView(manifest),
  };
}

export function catalogViews(
  secret: (name: string) => string | undefined,
): CatalogEntryView[] {
  return CATALOG.map((manifest) => catalogView(manifest, secret));
}
