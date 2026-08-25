import type { BlobStore } from "./blobs.js";
import type { Db } from "./db.js";
import { isNumber } from "./http.js";
import type { PrincipalSource } from "./principals.js";
import type { MicrovmPoolProvider } from "./compute/microvm.js";
import type { VmProviderRegistry } from "./compute/registry.js";
import type { VolumeProvider } from "./compute/types.js";
import type { WorkspaceTunnels } from "./workspace-tunnels.js";
import type { WorkspaceWebAppAuth } from "./webapp-tickets.js";

export interface CoreRequest {
  readonly raw: Request;
  readonly url: string;
  readonly path: string;
  header(name: string): string | undefined;
  param(name: string): string;
}

export interface CoreContext {
  readonly req: CoreRequest;
  readonly env: object;
  get(name: string): Db | CryptoKey | undefined;
  json<T>(value: T, status?: number): Response;
  text(value: string, status?: number): Response;
  body(
    value: BodyInit | null,
    status?: number,
    headers?: Record<string, string>,
  ): Response;
  header(name: string, value: string, options?: { append?: boolean }): void;
  readonly executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

export type CoreHandler = (
  context: CoreContext,
) => Response | Promise<Response>;

export interface CoreRouter {
  all(path: string, handler: CoreHandler): CoreRouter;
  get(path: string, handler: CoreHandler): CoreRouter;
  post(path: string, handler: CoreHandler): CoreRouter;
  patch(path: string, handler: CoreHandler): CoreRouter;
  put(path: string, handler: CoreHandler): CoreRouter;
  delete(path: string, handler: CoreHandler): CoreRouter;
  notFound(handler: CoreHandler): CoreRouter;
  onError(
    handler: (error: Error, context: CoreContext) => Response | Promise<Response>,
  ): CoreRouter;
}

export type SignupMode = "open" | "invite";

export interface RuntimeVariables {
  boxImageRef: string;
  boxImageSha256: string;
  boxImageTag: string;
  sessionTtlMs: number;
  maxConcurrentWorkspaces: number;
  googleClientId: string;
  googleClientSecret: string;
  bootstrapSecret: string;
  /** Reads a provider's OAuth client binding by the name its catalog manifest
   * declares. Returning undefined is the supported answer: an instance that
   * never registered an app simply has no Connect button for that provider. */
  connectSecret(name: string): string | undefined;
  /** Git commit the deploy shipped, from GIT_COMMIT_SHA. Absent on a
   * deployment whose config predates the var, and on the managed worker
   * source; GET /version reports "unknown" for it. */
  gitCommitSha?: string;
  /** Signup gate mode parsed from SIGNUP_MODE. Runtimes that predate the
   * var (the managed worker source) omit it; absent means "open", which is
   * the pre-gate behavior. */
  signupMode?: SignupMode;
  /** Lowercased bare domains parsed from ALLOWED_EMAIL_DOMAINS. Absent or
   * empty means any email domain may sign in. */
  allowedEmailDomains?: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function sessionTtlMsFromEnv(value: string | number | null | undefined): number {
  const days = isNumber(value) ? value : Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3_650) {
    throw new Error("SESSION_TTL_DAYS must be an integer from 1 through 3650");
  }
  return days * DAY_MS;
}

export function maxConcurrentWorkspacesFromEnv(value: string | number | null | undefined): number {
  const limit = isNumber(value) ? value : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("MAX_CONCURRENT_WORKSPACES must be an integer from 1 through 1000");
  }
  return limit;
}

// Re-exported, not reimplemented: scripts/deploy-helpers.mjs imports the same
// module to reject a bad SIGNUP_MODE or ALLOWED_EMAIL_DOMAINS at deploy time.
export { allowedEmailDomainsFromEnv, signupModeFromEnv } from "./signup-config.js";

export interface CoreRuntime {
  db: Db;
  blobs: BlobStore;
  fileObjects: R2Bucket;
  credentialMasterKey: CryptoKey;
  vars: RuntimeVariables;
  providers: {
    vmRegistry: VmProviderRegistry;
    volume: VolumeProvider;
    microvm?: MicrovmPoolProvider;
    workspaceTunnels?: WorkspaceTunnels;
    webAppAuth?: WorkspaceWebAppAuth;
  };
  principalSource: PrincipalSource;
  /** Serves the webApp shell for browser navigations that land on API paths
   * shared with SPA pages (a refresh on /workspaces/:id). Absent where the
   * deployment has no programmatic asset access. */
  assets?: { fetch(request: Request): Promise<Response> };
  waitUntil(promise: Promise<unknown>): void;
  reportError(event: string, error: Error): void;
}

export type RuntimeFactory = (context: CoreContext) => CoreRuntime;
