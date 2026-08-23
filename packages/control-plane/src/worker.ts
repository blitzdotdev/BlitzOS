import type { DatabaseSettings } from "teenybase";
import type { $Env } from "teenybase/worker";
import { $Database, teenyHono } from "teenybase/worker";
import { rawDb } from "./raw-db.js";
import {
  allowedEmailDomainsFromEnv,
  awsProviderFromEnv,
  credentialMasterKeyFor,
  HetznerProvider,
  installControlPlaneRoutes,
  isString,
  MicrovmPoolProvider,
  maybeScheduleLazySweep,
  runScheduledMaintenance,
  sessionTtlMsFromEnv,
  signupModeFromEnv,
  workspaceTunnelsFromEnv,
  workspaceWebAppAuthFromEnv,
  VmProviderRegistry,
  type BlobStore,
  type CoreContext,
  type CoreRouter,
  type CoreRuntime,
  type Db,
} from "../core/index.js";
import config from "../teenybase.js";

type WorkerBindings = Env & {
  ASSETS: { fetch(request: Request): Promise<Response> };
  HETZNER_API_TOKEN: string;
  HETZNER_MACHINE_TYPES?: string;
  OPERATOR_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MICROVM_HOSTS: string;
  SESSION_TTL_DAYS: string;
  SIGNUP_MODE?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  CRED_MASTER_KEY: string;
  CLOUDFLARE_API_TOKEN?: string;
  WEBAPP_TOKEN_SECRET?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  AWS_REGION?: string;
  AWS_IMAGE_ID?: string;
  AWS_SUBNET_ID?: string;
  AWS_SECURITY_GROUP_IDS?: string;
  RESPOND_WITH_ERRORS: string | boolean;
  RESPOND_WITH_QUERY_LOG: string | boolean;
};

type WorkerEnv = $Env<WorkerBindings> & {
  Variables: $Env<WorkerBindings>["Variables"] & {
    settings: DatabaseSettings;
    $credentialMasterKey: CryptoKey;
  };
};

interface TargetContext {
  readonly env: WorkerBindings;
  get(name: string): Db | CryptoKey | undefined;
  readonly executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

function dynamicBinding(env: WorkerBindings, name: string): unknown {
  // SAFETY: The key assertion only enables ordinary bracket lookup; a missing binding still yields undefined and is rejected by the token resolver.
  return env[name as keyof WorkerBindings];
}

/** Connection OAuth client bindings are named by the provider catalog, not by
 * this file, so they are read by name and narrowed to a string here. */
function connectSecretFrom(env: WorkerBindings, name: string): string | undefined {
  const value = dynamicBinding(env, name);
  return isString(value) && value.length > 0 ? value : undefined;
}

function providersFor(env: WorkerBindings, db: Db): CoreRuntime["providers"] {
  const hetzner = new HetznerProvider(env.HETZNER_API_TOKEN, {
    machineTypeCatalog: env.HETZNER_MACHINE_TYPES,
    warn: (warning) => console.warn(JSON.stringify(warning)),
  });
  const microvm = new MicrovmPoolProvider(
    env.MICROVM_HOSTS,
    (tokenVar) => dynamicBinding(env, tokenVar),
    { db },
  );
  // AWS joins the registry only when its variables are configured, so
  // deployments without AWS keep exactly the providers they had. Volumes still
  // route to Hetzner: `providers.volume` is single-valued.
  const aws = awsProviderFromEnv(env);
  const vmProviders = aws === undefined
    ? [hetzner, microvm]
    : [hetzner, microvm, aws];
  return {
    vmRegistry: new VmProviderRegistry(vmProviders),
    volume: hetzner,
    microvm,
    workspaceTunnels: workspaceTunnelsFromEnv(env),
    webAppAuth: workspaceWebAppAuthFromEnv(env),
  };
}

interface RuntimeSeed {
  env: WorkerBindings;
  db: Db;
  credentialMasterKey: CryptoKey;
  waitUntil(promise: Promise<unknown>): void;
  /** The routed fetch path serves the SPA shell; cron runs have no assets. */
  assets?: CoreRuntime["assets"];
}

/** The one place a CoreRuntime is assembled from Worker bindings: the routed
 * fetch path and the cron path feed different context shapes in, but the vars
 * block and provider wiring exist exactly once. */
function buildRuntime(seed: RuntimeSeed): CoreRuntime {
  const { env, db } = seed;
  return {
    db,
    // SAFETY: WorkerBindings declares BOX_IMAGES as the configured R2 bucket implementing BlobStore.
    blobs: env.BOX_IMAGES as BlobStore,
    fileObjects: env.BOX_IMAGES,
    credentialMasterKey: seed.credentialMasterKey,
    vars: {
      boxImageRef: env.BOX_IMAGE_REF,
      boxImageSha256: env.BOX_IMAGE_SHA256,
      boxImageTag: env.BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(env.SESSION_TTL_DAYS),
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      bootstrapSecret: env.OPERATOR_API_KEY,
      connectSecret: (name) => connectSecretFrom(env, name),
      signupMode: signupModeFromEnv(env.SIGNUP_MODE),
      allowedEmailDomains: allowedEmailDomainsFromEnv(env.ALLOWED_EMAIL_DOMAINS),
    },
    providers: providersFor(env, db),
    assets: seed.assets,
    waitUntil: seed.waitUntil,
    reportError: (event, error) => console.error(JSON.stringify({ event, error: error.message })),
  };
}

function runtimeFor(context: CoreContext): CoreRuntime;
function runtimeFor(context: TargetContext): CoreRuntime;
function runtimeFor(context: CoreContext | TargetContext): CoreRuntime {
  // SAFETY: Both routed Hono context variants carry the declared WorkerBindings environment.
  const env = context.env as WorkerBindings;
  return buildRuntime({
    env,
    // SAFETY: The database middleware installs a Db instance under $db before routed handlers run.
    db: context.get("$db") as Db,
    // SAFETY: Authentication middleware installs the imported CryptoKey under $credentialMasterKey.
    credentialMasterKey: context.get("$credentialMasterKey") as CryptoKey,
    waitUntil: (promise) => context.executionCtx.waitUntil(promise),
    assets: { fetch: (request) => env.ASSETS.fetch(request) },
  });
}

let lastSyncedHostsConfig: string | undefined;
let checkedWorkspaceTunnelsConfig = false;

// Cloud-VM providers have no proxyWebApp of their own: without configured
// workspace tunnels their workspaces boot with no browser access at all.
// Misconfigured forks hit this constantly, so say it once per isolate.
function warnOnceIfWorkspaceTunnelsUnconfigured(runtime: CoreRuntime): void {
  if (checkedWorkspaceTunnelsConfig) return;
  checkedWorkspaceTunnelsConfig = true;
  if (runtime.providers.workspaceTunnels !== undefined) return;
  const blindProviderIds = runtime.providers.vmRegistry
    .all()
    .filter((provider) => provider.proxyWebApp === undefined)
    .map((provider) => provider.id);
  if (blindProviderIds.length === 0) return;
  runtime.reportError(
    "workspace_tunnels_unconfigured",
    new Error(
      `workspace tunnels are not configured (set WORKSPACE_TUNNEL_ZONE, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID vars and the CLOUDFLARE_API_TOKEN, WEBAPP_TOKEN_SECRET secrets); workspaces from providers without proxyWebApp have no browser access: ${blindProviderIds.join(", ")}`,
    ),
  );
}

const app = teenyHono<WorkerEnv>(
  async (context) => {
    context.set(
      "$credentialMasterKey",
      await credentialMasterKeyFor(context.env.CRED_MASTER_KEY),
    );
    return new $Database(context, config, context.env.DB, context.env.BOX_IMAGES);
  },
  undefined,
  { cors: false, logger: true },
  async (context) => {
    const runtime = runtimeFor(context);
    warnOnceIfWorkspaceTunnelsUnconfigured(runtime);
    // Static host URLs only move when MICROVM_HOSTS changes, so sync once
    // per isolate per config value instead of paying D1 on every request.
    // SAFETY: teenyHono routes this app with the declared WorkerBindings environment.
    const hostsConfig = (context.env as WorkerBindings).MICROVM_HOSTS;
    if (hostsConfig !== lastSyncedHostsConfig) {
      lastSyncedHostsConfig = hostsConfig;
      await runtime.providers.microvm?.syncStaticHosts();
    }
    maybeScheduleLazySweep(runtime, context.req.path);
  },
);

// SAFETY: The Hono app and CoreRouter expose the same route-registration methods consumed by installControlPlaneRoutes.
installControlPlaneRoutes(app as typeof app & CoreRouter, runtimeFor);

export default {
  fetch(
    request: Request,
    env: WorkerBindings,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, executionContext));
  },
  async scheduled(
    event: ScheduledController,
    env: WorkerBindings,
    executionContext: ExecutionContext,
  ): Promise<void> {
    executionContext.waitUntil(
      (async () => {
        const runtime = buildRuntime({
          env,
          db: rawDb(env.DB),
          credentialMasterKey: await credentialMasterKeyFor(env.CRED_MASTER_KEY),
          waitUntil: (promise) => executionContext.waitUntil(promise),
        });
        await runScheduledMaintenance(runtime, event.cron);
      })(),
    );
  },
} satisfies ExportedHandler<WorkerBindings>;
