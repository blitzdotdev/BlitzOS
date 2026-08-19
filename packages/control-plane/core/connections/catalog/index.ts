import type { CatalogEntryView, CatalogScopeView } from "../types.js";
import { genericManifest } from "./generic.js";
import { githubManifest } from "./github.js";
import { googleWorkspaceManifest } from "./google-workspace.js";
import { linearManifest } from "./linear.js";
import type { ProviderManifest } from "./types.js";

/** Add a provider by adding a module here. Everything else — conformance
 * tests, the picker, the canary, the surfaces — reads the manifest. */
export const CATALOG: readonly ProviderManifest[] = [
  githubManifest,
  googleWorkspaceManifest,
  linearManifest,
  genericManifest,
];

export const GENERIC_MANIFEST_ID = genericManifest.id;

export function providerManifest(id: string): ProviderManifest | null {
  return CATALOG.find((manifest) => manifest.id === id) ?? null;
}

function scopeViews(manifest: ProviderManifest): CatalogScopeView[] {
  return manifest.scopes.map((scope) => ({
    id: scope.id,
    title: scope.title,
    detail: scope.detail,
    default: manifest.defaultScopes.includes(scope.id),
  }));
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
    needsVendorConfig: manifest.auth === null,
    environmentNames: manifest.surfaces.env.map((surface) => surface.name),
    scopes: scopeViews(manifest),
  };
}

export function catalogViews(
  secret: (name: string) => string | undefined,
): CatalogEntryView[] {
  return CATALOG.map((manifest) => catalogView(manifest, secret));
}
