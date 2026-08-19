import { HttpError, requiredString } from "../http.js";
import {
  clearConnectOAuthStateCookie,
  CONNECT_OAUTH_COOKIE,
  createConnectOAuthState,
  verifyConnectOAuthStateCookie,
} from "../oauth-state.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { providerManifest } from "./catalog/index.js";
import type { OAuthProviderManifest, ProviderManifest } from "./catalog/types.js";
import { exchangeTokens } from "./minters/oauth.js";
import { ensureCatalogConnection } from "./registry.js";
import { grantCustody, grantOverrides, storeGrant } from "./user-grants.js";
import type { GrantConfig } from "./user-grants.js";

/** Where the browser lands after a round trip, success or failure. The panel
 * reads the query and says what happened. */
const CONNECT_RETURN_PATH = "/settings/connections";

interface ConfiguredProvider {
  manifest: OAuthProviderManifest;
  clientId: string;
  clientSecret: string;
}

function oauthManifest(id: string): OAuthProviderManifest {
  const manifest: ProviderManifest | null = providerManifest(id);
  if (manifest === null) throw new HttpError(404, `provider ${id} is not in the catalog`);
  if (manifest.auth === null) {
    throw new HttpError(400, `${manifest.title} has no authorize endpoint; paste a token instead`);
  }
  return manifest;
}

/** Client ids and secrets are per-deployment worker bindings, named by the
 * manifest. An instance that never registered the app is a normal state, not
 * an error condition to paper over. */
function configuredProvider(
  id: string,
  secret: (name: string) => string | undefined,
): ConfiguredProvider {
  const manifest = oauthManifest(id);
  const clientId = secret(manifest.auth.clientIdVar);
  const clientSecret = secret(manifest.auth.clientSecretVar);
  if (clientId === undefined || clientSecret === undefined) {
    throw new HttpError(
      409,
      `${manifest.title} is not configured on this instance: set ${manifest.auth.clientIdVar} and ${manifest.auth.clientSecretVar}`,
    );
  }
  return { manifest, clientId, clientSecret };
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

function returnUrl(origin: string, status: string, provider: string): string {
  const url = new URL(CONNECT_RETURN_PATH, origin);
  url.searchParams.set("connect", status);
  url.searchParams.set("provider", provider);
  return url.toString();
}

function catalogGrantConfig(manifest: ProviderManifest): GrantConfig {
  return {
    envName: null,
    baseUrlEnvName: null,
    baseUrl: null,
    tokenHeader: manifest.tokenHeader,
  };
}

export function addConnectRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/connect/:provider/start", async (context) => {
    await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const id = requiredString(context.req.param("provider"), "provider", 64);
    const { manifest, clientId } = configuredProvider(id, runtime.vars.connectSecret);
    const origin = new URL(context.req.url).origin;
    const oauth = await createConnectOAuthState(
      runtime.vars.googleClientSecret,
      manifest.id,
    );
    const authorize = new URL(manifest.auth.authorizeUrl);
    const parameters = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${origin}${manifest.auth.redirectPath}`,
      response_type: "code",
      scope: manifest.defaultScopes.join(manifest.auth.scopeDelimiter),
      state: oauth.state,
    });
    if (manifest.auth.pkce) {
      parameters.set("code_challenge", oauth.codeChallenge);
      parameters.set("code_challenge_method", "S256");
    }
    for (const parameter of manifest.auth.authorizeParams) {
      parameters.set(parameter.name, parameter.value);
    }
    authorize.search = parameters.toString();
    context.header("Set-Cookie", oauth.cookie, { append: true });
    return context.body(null, 302, { Location: authorize.toString() });
  });

  router.get("/connect/:provider/callback", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const runtime = runtimeFactory(context);
    const id = requiredString(context.req.param("provider"), "provider", 64);
    const origin = new URL(context.req.url).origin;
    const query = new URL(context.req.url).searchParams;
    context.header("Set-Cookie", clearConnectOAuthStateCookie(), { append: true });
    if (query.get("error") !== null) {
      return context.body(null, 302, { Location: returnUrl(origin, "denied", id) });
    }
    const { manifest, clientId, clientSecret } = configuredProvider(
      id,
      runtime.vars.connectSecret,
    );
    const signedState = cookieValue(context.req.raw, CONNECT_OAUTH_COOKIE);
    const returnedState = query.get("state");
    if (signedState === null || returnedState === null) {
      throw new HttpError(400, "connect state is missing");
    }
    const state = await verifyConnectOAuthStateCookie(
      signedState,
      returnedState,
      manifest.id,
      runtime.vars.googleClientSecret,
    );
    if (state === null) throw new HttpError(400, "connect state is invalid or expired");
    const code = query.get("code");
    if (code === null) throw new HttpError(400, "connect callback is missing the code");

    const now = Date.now();
    const exchanged = await exchangeTokens({
      manifest,
      clientId,
      clientSecret,
      redirectUri: `${origin}${manifest.auth.redirectPath}`,
      grantType: "authorization_code",
      code,
      codeVerifier: state.codeVerifier,
      refreshToken: null,
    });
    const config = catalogGrantConfig(manifest);
    await ensureCatalogConnection(
      runtime.db,
      principal.orgId,
      manifest.id,
      manifest,
      grantCustody(manifest, config),
      grantOverrides(manifest, config),
      principal,
      now,
    );
    await storeGrant(
      runtime.db,
      runtime.credentialMasterKey,
      {
        userId: principal.id,
        provider: manifest.id,
        manifestId: manifest.id,
        kind: "oauth",
        label: null,
        config,
        scopes: manifest.defaultScopes,
        refresh: exchanged.refreshToken,
        access: exchanged.accessToken,
        accessExpiresAt: now + exchanged.expiresInMs,
      },
      now,
    );
    return context.body(null, 302, { Location: returnUrl(origin, "ok", manifest.id) });
  });
}
