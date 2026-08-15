import type { DatabaseSettings } from "teenybase";
import type { $Env } from "teenybase/worker";
import { $Database, $DatabaseRawImpl, teenyHono } from "teenybase/worker";
import {
  CompositeVmProvider,
  credentialMasterKeyFor,
  createOperatorPrincipalSource,
  HetznerProvider,
  installControlPlaneRoutes,
  MicrovmPoolProvider,
  maybeScheduleLazySweep,
  maxConcurrentWorkspacesFromEnv,
  runInvariantSweep,
  runLeaseSweep,
  runOrphanSweep,
  runSessionSweep,
  sessionTtlMsFromEnv,
  type BlobStore,
  type CoreContext,
  type CoreRouter,
  type CoreRuntime,
  type Db,
} from "../core/index.js";
import config from "../teenybase.js";

type WorkerBindings = Env & {
  HETZNER_API_TOKEN: string;
  JWT_SECRET_MAIN: string;
  OPERATOR_API_KEY: string;
  MICROVM_HOSTS?: string;
  SESSION_TTL_DAYS?: string;
  MAX_CONCURRENT_WORKSPACES?: string;
  CRED_MASTER_KEY: string;
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
  get(name: string): unknown;
  readonly executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

function dynamicBinding(env: WorkerBindings, name: string): unknown {
  return Reflect.get(env, name);
}

function providersFor(env: WorkerBindings, db: Db): CoreRuntime["providers"] {
  const hetzner = new HetznerProvider(env.HETZNER_API_TOKEN);
  const microvm = new MicrovmPoolProvider(
    env.MICROVM_HOSTS,
    (tokenVar) => dynamicBinding(env, tokenVar),
    { db },
  );
  return {
    vm: new CompositeVmProvider(hetzner, microvm),
    volume: hetzner,
    microvm,
  };
}

function runtimeFor(context: CoreContext): CoreRuntime;
function runtimeFor(context: TargetContext): CoreRuntime;
function runtimeFor(context: CoreContext | TargetContext): CoreRuntime {
  const env = context.env as WorkerBindings;
  const db = context.get("$db") as Db;
  return {
    db,
    blobs: env.BOX_IMAGES as BlobStore,
    credentialMasterKey: context.get("$credentialMasterKey") as CryptoKey,
    vars: {
      boxImageRef: env.BOX_IMAGE_REF,
      boxImageSha256: env.BOX_IMAGE_SHA256,
      boxImageTag: env.BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(env.SESSION_TTL_DAYS),
      maxConcurrentWorkspaces: maxConcurrentWorkspacesFromEnv(
        env.MAX_CONCURRENT_WORKSPACES,
      ),
    },
    providers: providersFor(env, db),
    principalSource: createOperatorPrincipalSource(env.OPERATOR_API_KEY),
    waitUntil: (promise) => context.executionCtx.waitUntil(promise),
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
    blobs: env.BOX_IMAGES as BlobStore,
    credentialMasterKey,
    vars: {
      boxImageRef: env.BOX_IMAGE_REF,
      boxImageSha256: env.BOX_IMAGE_SHA256,
      boxImageTag: env.BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(env.SESSION_TTL_DAYS),
      maxConcurrentWorkspaces: maxConcurrentWorkspacesFromEnv(
        env.MAX_CONCURRENT_WORKSPACES,
      ),
    },
    providers,
    principalSource: createOperatorPrincipalSource(env.OPERATOR_API_KEY),
    waitUntil: (promise) => executionContext.waitUntil(promise),
  };
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
    await runtime.providers.microvm?.syncStaticHosts();
    maybeScheduleLazySweep(runtime, context.req.path);
  },
);

installControlPlaneRoutes(app as unknown as CoreRouter, runtimeFor);

export default {
  fetch(
    request: Request,
    env: WorkerBindings,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, executionContext));
  },
  async scheduled(
    _event: ScheduledController,
    env: WorkerBindings,
    executionContext: ExecutionContext,
  ): Promise<void> {
    const db = new $DatabaseRawImpl(env.DB);
    executionContext.waitUntil(
      (async () => {
        const runtime = runtimeForScheduled(
          env,
          db,
          executionContext,
          await credentialMasterKeyFor(env.CRED_MASTER_KEY),
        );
        await runtime.providers.microvm?.syncStaticHosts();
        await runSessionSweep(runtime);
        await runLeaseSweep(runtime);
        await runInvariantSweep(runtime);
        await runOrphanSweep(runtime);
      })(),
    );
  },
} satisfies ExportedHandler<WorkerBindings>;
