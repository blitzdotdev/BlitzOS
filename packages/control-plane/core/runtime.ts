import type { BlobStore } from "./blobs.js";
import type { Db } from "./db.js";
import type { PrincipalSource } from "./principals.js";
import type { VmProvider, VolumeProvider } from "./providers/types.js";

export interface CoreRequest {
  readonly raw: Request;
  readonly url: string;
  readonly path: string;
  header(name: string): string | undefined;
  param(name: string): string;
}

export interface CoreContext {
  readonly req: CoreRequest;
  readonly env: unknown;
  get(name: string): unknown;
  json<T>(value: T, status?: number): Response;
  text(value: string, status?: number): Response;
  body(
    value: BodyInit | null,
    status?: number,
    headers?: Record<string, string>,
  ): Response;
  header(name: string, value: string): void;
  readonly executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

export type CoreHandler = (
  context: CoreContext,
) => Response | Promise<Response>;

export interface CoreRouter {
  all(path: string, handler: CoreHandler): unknown;
  get(path: string, handler: CoreHandler): unknown;
  post(path: string, handler: CoreHandler): unknown;
  put(path: string, handler: CoreHandler): unknown;
  delete(path: string, handler: CoreHandler): unknown;
  notFound(handler: CoreHandler): unknown;
  onError(
    handler: (error: Error, context: CoreContext) => Response | Promise<Response>,
  ): unknown;
}

export interface RuntimeVariables {
  boxImageRef: string;
  boxImageSha256: string;
  boxImageTag: string;
  sessionTtlMs: number;
  maxConcurrentWorkspaces: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_TTL_MS = 30 * DAY_MS;
export const DEFAULT_MAX_CONCURRENT_WORKSPACES = 10;

export function sessionTtlMsFromEnv(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_SESSION_TTL_MS;
  }
  const days = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3_650) {
    throw new Error("SESSION_TTL_DAYS must be an integer from 1 through 3650");
  }
  return days * DAY_MS;
}

export function maxConcurrentWorkspacesFromEnv(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_MAX_CONCURRENT_WORKSPACES;
  }
  const limit = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("MAX_CONCURRENT_WORKSPACES must be an integer from 1 through 1000");
  }
  return limit;
}

export interface CoreRuntime {
  db: Db;
  blobs: BlobStore;
  credentialMasterKey: CryptoKey;
  vars: RuntimeVariables;
  providers: {
    vm: VmProvider;
    volume: VolumeProvider;
  };
  principalSource: PrincipalSource;
  waitUntil(promise: Promise<unknown>): void;
}

export type RuntimeFactory = (context: CoreContext) => CoreRuntime;
