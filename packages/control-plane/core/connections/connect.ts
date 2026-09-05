import { first } from "../db.js";
import { HttpError, requiredString } from "../http.js";
import {
  isWorkspaceAdmin,
  workspaceAccess,
  type WorkspaceAccessRow,
} from "../workspace-access.js";
import {
  clearConnectOAuthStateCookie,
  connectReturnTo,
  CONNECT_OAUTH_COOKIE,
  createConnectOAuthState,
  verifyConnectOAuthStateCookie,
} from "../oauth-state.js";
import type { ConnectReturnTo } from "../oauth-state.js";
import { cookieValue, findStatePrincipal } from "../principals.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { providerManifest, providerRedirectPath } from "./catalog/index.js";
import type { OAuthProviderManifest, ProviderManifest } from "./catalog/types.js";
import { exchangeTokens } from "./minters/oauth.js";
import { ensureCatalogConnection } from "./registry.js";
import { storeGrant } from "./user-grants.js";
import type { GrantConfig } from "./user-grants.js";

/** Where the browser lands after a round trip, success or failure. The panel
 * reads the query and says what happened. */
const CONNECT_RETURN_PATH = "/settings/connections";

/** Turns the grant this round trip just stored into a lease in the workspace it
 * started from. Injected by the mint module, which owns every path that writes
 * a lease. Answers false when the workspace refuses — the grant still stands. */
export type ConnectAfterGrant = (
  runtime: ReturnType<RuntimeFactory>,
  input: {
    workspaceId: string;
    principal: Principal;
    origin: string;
    connectionName: string;
  },
) => Promise<boolean>;

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

/** A round trip that began in a workspace ends there. Other named surfaces
 * resolve from a closed state value, and the settings path remains the default
 * for callers that genuinely started there. */
function returnUrl(
  origin: string,
  status: string,
  provider: string,
  workspaceId: string | null = null,
  returnTo: ConnectReturnTo | null = null,
): string {
  let path = CONNECT_RETURN_PATH;
  if (returnTo === "workspace-new") path = "/workspaces/new";
  // A workspace id grants a lease after authorization, so it keeps precedence
  // over a return surface even if a caller supplies both query parameters.
  if (workspaceId !== null) path = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const url = new URL(path, origin);
  url.searchParams.set("connect", status);
  url.searchParams.set("provider", provider);
  return url.toString();
}

/** The workspace a connect round trip may be aimed at. An id the caller cannot
 * control never reaches the signed state, so the callback cannot be talked into
 * minting into somebody else's workspace. */
async function controllableWorkspace(
  runtime: ReturnType<RuntimeFactory>,
  principal: Principal,
  requested: string | null,
): Promise<string | null> {
  if (requested === null) return null;
  const id = requiredString(requested, "workspaceId", 64);
  const workspace = await first<WorkspaceAccessRow>(runtime.db, {
    q: "SELECT id, org_id, owner_membership_id FROM workspaces WHERE id = ?1 LIMIT 1",
    v: [id],
  });
  if (workspace === null || workspace.org_id !== principal.orgId) {
    throw new HttpError(404, "workspace not found");
  }
  if (!isWorkspaceAdmin(await workspaceAccess(runtime.db, principal, workspace))) {
    throw new HttpError(403, "forbidden");
  }
  return id;
}

function requestedReturnTo(value: string | null): ConnectReturnTo | null {
  if (value === null) return null;
  const parsed = connectReturnTo(value);
  if (parsed === null) throw new HttpError(400, "returnTo is invalid");
  return parsed;
}

function catalogGrantConfig(manifest: ProviderManifest): GrantConfig {
  return {
    baseUrl: null,
    tokenHeader: manifest.tokenHeader,
  };
}

export function addConnectRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
  connectAfterGrant: ConnectAfterGrant,
): void {
  router.get("/connect/:provider/start", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const runtime = runtimeFactory(context);
    const id = requiredString(context.req.param("provider"), "provider", 64);
    const { manifest, clientId } = configuredProvider(id, runtime.vars.connectSecret);
    const origin = new URL(context.req.url).origin;
    // Only the connect grid inside a workspace sends this, and only the person
    // who may control that workspace gets it signed into their state.
    const workspaceId = await controllableWorkspace(
      runtime,
      principal,
      new URL(context.req.url).searchParams.get("workspaceId"),
    );
    const returnTo = requestedReturnTo(new URL(context.req.url).searchParams.get("returnTo"));
    const oauth = await createConnectOAuthState(
      runtime.vars.googleClientSecret,
      manifest.id,
      principal.id,
      principal.membershipId,
      workspaceId,
      returnTo,
    );
    const authorize = new URL(manifest.auth.authorizeUrl);
    const parameters = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${origin}${providerRedirectPath(manifest)}`,
      response_type: "code",
      state: oauth.state,
    });
    if (manifest.defaultScopes.length > 0) {
      parameters.set("scope", manifest.defaultScopes.join(manifest.auth.scopeDelimiter));
    }
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
    // No requirePrincipal here: the redirect comes from the provider, so the
    // ambient session is not what authorizes it. The principal comes from the
    // signed state created at /start instead.
    const runtime = runtimeFactory(context);
    const id = requiredString(context.req.param("provider"), "provider", 64);
    const origin = new URL(context.req.url).origin;
    const query = new URL(context.req.url).searchParams;
    context.header("Set-Cookie", clearConnectOAuthStateCookie(), { append: true });
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
    if (query.get("error") !== null) {
      return context.body(null, 302, {
        Location: returnUrl(origin, "denied", id, state.workspaceId, state.returnTo),
      });
    }
    const principal = await findStatePrincipal(runtime.db, state.userId, state.membershipId);
    if (principal === null || principal.orgId === null) {
      throw new HttpError(403, "active membership required");
    }
    const code = query.get("code");
    if (code === null) throw new HttpError(400, "connect callback is missing the code");

    const now = Date.now();
    const exchanged = await exchangeTokens({
      manifest,
      clientId,
      clientSecret,
      redirectUri: `${origin}${providerRedirectPath(manifest)}`,
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
      principal,
      null,
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
    // Started in settings: authorizing the account is the whole errand.
    if (state.workspaceId === null) {
      return context.body(null, 302, {
        Location: returnUrl(origin, "ok", manifest.id, null, state.returnTo),
      });
    }
    // Started in a workspace: the errand was connecting it, so the grant is
    // only half of it. A ceiling that refuses leaves the grant standing and
    // says "authorized" rather than claiming a connection nobody has.
    const leaseLive = await connectAfterGrant(runtime, {
      workspaceId: state.workspaceId,
      principal,
      origin,
      connectionName: manifest.id,
    });
    return context.body(null, 302, {
      Location: returnUrl(
        origin,
        leaseLive ? "ok" : "authorized",
        manifest.id,
        state.workspaceId,
      ),
    });
  });
}
