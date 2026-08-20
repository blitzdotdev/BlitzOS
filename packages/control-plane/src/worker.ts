import type { DatabaseSettings } from "teenybase";
import type { $Env } from "teenybase/worker";
import { $Database, $DatabaseRawImpl, teenyHono } from "teenybase/worker";
import {
  awsProviderFromEnv,
  credentialMasterKeyFor,
  createSessionPrincipalSource,
  HetznerProvider,
  installControlPlaneRoutes,
  isString,
  MicrovmPoolProvider,
  maybeScheduleLazySweep,
  maxConcurrentWorkspacesFromEnv,
  runInvariantSweep,
  runFileSyncSweep,
  runLeaseSweep,
  runOrphanSweep,
  runProviderCanary,
  runSessionSweep,
  runWorkspaceTunnelSweep,
  sessionTtlMsFromEnv,
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

/** Must stay one of wrangler.toml's `triggers.crons` entries verbatim: the
 * scheduled handler routes on the literal expression Cloudflare hands back. */
const HOURLY_CRON = "0 * * * *";

type WorkerBindings = Env & {
  ASSETS: { fetch(request: Request): Promise<Response> };
  HETZNER_API_TOKEN: string;
  JWT_SECRET_MAIN: string;
  OPERATOR_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MICROVM_HOSTS: string;
  SESSION_TTL_DAYS: string;
  MAX_CONCURRENT_WORKSPACES: string;
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
  const hetzner = new HetznerProvider(env.HETZNER_API_TOKEN);
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
      connectSecret: (name) => connectSecretFrom(env, name),
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
      connectSecret: (name) => connectSecretFrom(env, name),
    },
    providers,
    principalSource: createSessionPrincipalSource(),
    waitUntil: (promise) => executionContext.waitUntil(promise),
    reportError: (event, error) => console.error(JSON.stringify({ event, error: error.message })),
  };
}

let lastSyncedHostsConfig: string | undefined;

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
    const db = new $DatabaseRawImpl(env.DB);
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
        if (event.cron !== HOURLY_CRON && event.cron !== "0 3 * * *") {
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
        // The canary is the one sweep that costs an authenticated call to a
        // third party per provider, so it takes the hourly tick alone. On the
        // daily tick as well it would be counted twice against the same rate
        // limit for no extra signal.
        if (event.cron === HOURLY_CRON) {
          const probed = await runProviderCanary(runtime);
          console.log(JSON.stringify({ event: "provider_canary_tick", cron: event.cron, probed }));
        }
        const swept = await runFileSyncSweep(runtime);
        console.log(JSON.stringify({ event: "file_sync_tick", cron: event.cron, ...swept }));
      })(),
    );
  },
} satisfies ExportedHandler<WorkerBindings>;
