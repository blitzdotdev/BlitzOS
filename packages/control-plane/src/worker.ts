import type { DatabaseSettings } from "teenybase";
import type { $Env } from "teenybase/worker";
import { $Database, teenyHono } from "teenybase/worker";
import { rawDb } from "./raw-db.js";
import {
  allowedEmailDomainsFromEnv,
  credentialMasterKeyFor,
  createSessionPrincipalSource,
  HetznerProvider,
  installControlPlaneRoutes,
  MicrovmPoolProvider,
  maybeScheduleLazySweep,
  maxConcurrentWorkspacesFromEnv,
  runInvariantSweep,
  runFileSyncSweep,
  runLeaseSweep,
  runOrphanSweep,
  runSessionSweep,
  runWorkspaceTunnelSweep,
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
  MAX_CONCURRENT_WORKSPACES: string;
  SIGNUP_MODE?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  CRED_MASTER_KEY: string;
  CLOUDFLARE_API_TOKEN?: string;
  WEBAPP_TOKEN_SECRET?: string;
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
  return {
    vmRegistry: new VmProviderRegistry([hetzner, microvm]),
    volume: hetzner,
    microvm,
    workspaceTunnels: workspaceTunnelsFromEnv(env),
    webAppAuth: workspaceWebAppAuthFromEnv(env),
  };
}

function runtimeFor(context: CoreContext): CoreRuntime;
function runtimeFor(context: TargetContext): CoreRuntime;
function runtimeFor(context: CoreContext | TargetContext): CoreRuntime {
  // SAFETY: Both routed Hono context variants carry the declared WorkerBindings environment.
  const env = context.env as WorkerBindings;
  // SAFETY: The database middleware installs a Db instance under $db before routed handlers run.
  const db = context.get("$db") as Db;
  return {
    db,
    // SAFETY: WorkerBindings declares BOX_IMAGES as the configured R2 bucket implementing BlobStore.
    blobs: env.BOX_IMAGES as BlobStore,
    fileObjects: env.BOX_IMAGES,
    // SAFETY: Authentication middleware installs the imported CryptoKey under $credentialMasterKey.
    credentialMasterKey: context.get("$credentialMasterKey") as CryptoKey,
    vars: {
      boxImageRef: env.BOX_IMAGE_REF,
      boxImageSha256: env.BOX_IMAGE_SHA256,
      boxImageTag: env.BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(env.SESSION_TTL_DAYS),
      maxConcurrentWorkspaces: maxConcurrentWorkspacesFromEnv(
        env.MAX_CONCURRENT_WORKSPACES,
      ),
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      bootstrapSecret: env.OPERATOR_API_KEY,
      signupMode: signupModeFromEnv(env.SIGNUP_MODE),
      allowedEmailDomains: allowedEmailDomainsFromEnv(env.ALLOWED_EMAIL_DOMAINS),
    },
    providers: providersFor(env, db),
    principalSource: createSessionPrincipalSource(),
    assets: { fetch: (request) => env.ASSETS.fetch(request) },
    waitUntil: (promise) => context.executionCtx.waitUntil(promise),
    reportError: (event, error) => console.error(JSON.stringify({ event, error: error.message })),
  };
}

function runtimeForScheduled(
  env: WorkerBindings,
  db: Db,
  executionContext: ExecutionContext,
  credentialMasterKey: CryptoKey,
): CoreRuntime {
  const providers = providersFor(env, db);
  return {
    db,
    // SAFETY: WorkerBindings declares BOX_IMAGES as the configured R2 bucket implementing BlobStore.
    blobs: env.BOX_IMAGES as BlobStore,
    fileObjects: env.BOX_IMAGES,
    credentialMasterKey,
    vars: {
      boxImageRef: env.BOX_IMAGE_REF,
      boxImageSha256: env.BOX_IMAGE_SHA256,
      boxImageTag: env.BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(env.SESSION_TTL_DAYS),
      maxConcurrentWorkspaces: maxConcurrentWorkspacesFromEnv(
        env.MAX_CONCURRENT_WORKSPACES,
      ),
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      bootstrapSecret: env.OPERATOR_API_KEY,
      signupMode: signupModeFromEnv(env.SIGNUP_MODE),
      allowedEmailDomains: allowedEmailDomainsFromEnv(env.ALLOWED_EMAIL_DOMAINS),
    },
    providers,
    principalSource: createSessionPrincipalSource(),
    waitUntil: (promise) => executionContext.waitUntil(promise),
    reportError: (event, error) => console.error(JSON.stringify({ event, error: error.message })),
  };
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
    const db = rawDb(env.DB);
    executionContext.waitUntil(
      (async () => {
        const runtime =  runtimeForScheduled(
          env,
          db,
          executionContext,
          await credentialMasterKeyFor(env.CRED_MASTER_KEY),
        );
        // Only the hourly and daily schedules run the full janitor set. Any
        // other tick (the */5 backstop today) converges folder sync alone, so
        // renaming that cron can never silently multiply the heavy sweeps.
        if (event.cron !== "0 * * * *" && event.cron !== "0 3 * * *") {
          const swept = await runFileSyncSweep(runtime);
          console.log(JSON.stringify({ event: "file_sync_tick", cron: event.cron, ...swept }));
          return;
        }
        await runtime.providers.microvm?.syncStaticHosts();
        await runSessionSweep(runtime);
        await runLeaseSweep(runtime);
        await runInvariantSweep(runtime);
        await runOrphanSweep(runtime);
        await runWorkspaceTunnelSweep(runtime);
        const swept = await runFileSyncSweep(runtime);
        console.log(JSON.stringify({ event: "file_sync_tick", cron: event.cron, ...swept }));
      })(),
    );
  },
} satisfies ExportedHandler<WorkerBindings>;
