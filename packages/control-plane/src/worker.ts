import type { DatabaseSettings } from "teenybase";
import type { $Env } from "teenybase/worker";
import { $Database, $DatabaseRawImpl, teenyHono } from "teenybase/worker";
import {
  createOperatorPrincipalSource,
  HetznerProvider,
  installControlPlaneRoutes,
  maybeScheduleLazySweep,
  maxConcurrentWorkspacesFromEnv,
  runInvariantSweep,
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
  SESSION_TTL_DAYS?: string;
  MAX_CONCURRENT_WORKSPACES?: string;
  RESPOND_WITH_ERRORS: string | boolean;
  RESPOND_WITH_QUERY_LOG: string | boolean;
};

type WorkerEnv = $Env<WorkerBindings> & {
  Variables: $Env<WorkerBindings>["Variables"] & {
    settings: DatabaseSettings;
  };
};

interface TargetContext {
  readonly env: WorkerBindings;
  get(name: string): unknown;
  readonly executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

function runtimeFor(context: CoreContext): CoreRuntime;
function runtimeFor(context: TargetContext): CoreRuntime;
function runtimeFor(context: CoreContext | TargetContext): CoreRuntime {
  const env = context.env as WorkerBindings;
  const provider = new HetznerProvider(env.HETZNER_API_TOKEN);
  return {
    db: context.get("$db") as Db,
    blobs: env.BOX_IMAGES as BlobStore,
    vars: {
      boxImageRef: env.BOX_IMAGE_REF,
      boxImageSha256: env.BOX_IMAGE_SHA256,
      boxImageTag: env.BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(env.SESSION_TTL_DAYS),
      maxConcurrentWorkspaces: maxConcurrentWorkspacesFromEnv(
        env.MAX_CONCURRENT_WORKSPACES,
      ),
    },
    providers: { vm: provider, volume: provider },
    principalSource: createOperatorPrincipalSource(env.OPERATOR_API_KEY),
    waitUntil: (promise) => context.executionCtx.waitUntil(promise),
  };
}

function runtimeForScheduled(
  env: WorkerBindings,
  db: Db,
  executionContext: ExecutionContext,
): CoreRuntime {
  const provider = new HetznerProvider(env.HETZNER_API_TOKEN);
  return {
    db,
    blobs: env.BOX_IMAGES as BlobStore,
    vars: {
      boxImageRef: env.BOX_IMAGE_REF,
      boxImageSha256: env.BOX_IMAGE_SHA256,
      boxImageTag: env.BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(env.SESSION_TTL_DAYS),
      maxConcurrentWorkspaces: maxConcurrentWorkspacesFromEnv(
        env.MAX_CONCURRENT_WORKSPACES,
      ),
    },
    providers: { vm: provider, volume: provider },
    principalSource: createOperatorPrincipalSource(env.OPERATOR_API_KEY),
    waitUntil: (promise) => executionContext.waitUntil(promise),
  };
}

const app = teenyHono<WorkerEnv>(
  async (context) =>
    new $Database(context, config, context.env.DB, context.env.BOX_IMAGES),
  undefined,
  { cors: false, logger: true },
  async (context) => {
    maybeScheduleLazySweep(runtimeFor(context), context.req.path);
  },
);

installControlPlaneRoutes(app as unknown as CoreRouter, runtimeFor);

export default {
  fetch(
    request: Request,
    env: WorkerBindings,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    return app.fetch(request, env, executionContext);
  },
  async scheduled(
    _event: ScheduledController,
    env: WorkerBindings,
    executionContext: ExecutionContext,
  ): Promise<void> {
    const db = new $DatabaseRawImpl(env.DB);
    executionContext.waitUntil(
      (async () => {
        const runtime = runtimeForScheduled(env, db, executionContext);
        await runSessionSweep(runtime);
        await runInvariantSweep(runtime);
        await runOrphanSweep(runtime);
      })(),
    );
  },
} satisfies ExportedHandler<WorkerBindings>;
