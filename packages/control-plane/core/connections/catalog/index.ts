import type {
  CatalogAdminFormView,
  CatalogEntryView,
} from "../types.js";
import { discordManifest } from "./discord.js";
import { genericManifest } from "./generic.js";
import { githubManifest } from "./github.js";
import { googleWorkspaceManifest } from "./google-workspace.js";
import { linearManifest } from "./linear.js";
import { youtrackManifest } from "./youtrack.js";
import type { ProviderManifest } from "./types.js";

/** Add a provider by adding a module here. Everything else — conformance
 * tests, the picker, the canary, the surfaces — reads the manifest. */
export const CATALOG: readonly ProviderManifest[] = [
  githubManifest,
  googleWorkspaceManifest,
  linearManifest,
  discordManifest,
  youtrackManifest,
  genericManifest,
];

export const GENERIC_MANIFEST_ID = genericManifest.id;

export function providerManifest(id: string): ProviderManifest | null {
  return CATALOG.find((manifest) => manifest.id === id) ?? null;
}

/** The admin form, compiled so the panel can submit `PUT /connections/:id`
 * without knowing anything about manifests: the placements come from the env
 * surfaces, and proxy custody carries the base-URL field plus the header the
 * proxy re-signs with. An `app` block flips the PUT to kind app-jwt, whose
 * config carries the ids instead of placements. */
function adminFormView(manifest: ProviderManifest): CatalogAdminFormView | null {
  const form = manifest.adminForm;
  if (form === null) return null;
  return {
    rootLabel: form.rootLabel,
    rootHelp: form.rootHelp,
    placements: manifest.surfaces.env.map(({ name, fill }) => ({
      kind: "env" as const,
      name,
      fill,
    })),
    proxy: manifest.custody === "proxy" && form.baseUrlLabel !== null
      ? {
          baseUrlLabel: form.baseUrlLabel,
          tokenHeader: manifest.tokenHeader.name,
          tokenPrefix: manifest.tokenHeader.prefix,
        }
      : null,
    app: form.app,
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
    docsUrl: manifest.docsUrl,
    custody: manifest.custody,
    rotation: manifest.rotation,
    oauthAvailable: auth !== null,
    oauthConfigured: configured,
    personalTokenLabel: manifest.personalToken?.label ?? null,
    personalTokenHelp: manifest.personalToken?.help ?? null,
    personalTokenBaseUrlLabel: manifest.personalToken?.baseUrlLabel ?? null,
    // Identity, not shape: every other call site asks the same question by id,
    // and "has no authorize endpoint" would answer yes for the next pasted-key
    // provider that knows its own vendor perfectly well.
    needsVendorConfig: manifest.id === GENERIC_MANIFEST_ID,
    adminForm: adminFormView(manifest),
    environmentNames: manifest.surfaces.env.map((surface) => surface.name),
  };
}

export function catalogViews(
  secret: (name: string) => string | undefined,
): CatalogEntryView[] {
  return CATALOG.map((manifest) => catalogView(manifest, secret));
}
