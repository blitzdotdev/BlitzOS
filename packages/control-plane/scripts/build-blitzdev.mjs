#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_DIST_DIR = path.join(PACKAGE_DIR, ".managed-dist");
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILE_COUNT = 256;
const DEFAULT_UI_DIST_DIR = path.resolve(PACKAGE_DIR, "../ui/dist");

export const CORE_MANIFEST = Object.freeze([
  "core/index.ts",
  "core/app.ts",
  "core/runtime.ts",
  "core/db.ts",
  "core/blobs.ts",
  "core/wire.ts",
  "core/bootstrap.ts",
  "core/box-images.ts",
  "core/cloud-init.ts",
  "core/crypto.ts",
  "core/credentials/types.ts",
  "core/credentials/root-crypto.ts",
  "core/credentials/manifest.ts",
  "core/credentials/leases.ts",
  "core/credentials/minters/static.ts",
  "core/credentials/minters/app-jwt/github-app.ts",
  "core/credentials/registry.ts",
  "core/credentials/requests.ts",
  "core/credentials/mint.ts",
  "core/credentials/proxy.ts",
  "core/http.ts",
  "core/janitors.ts",
  "core/oauth.ts",
  "core/principals.ts",
  "core/registry.ts",
  "core/sessions.ts",
  "core/types.ts",
  "core/volumes.ts",
  "core/workspaces.ts",
  "core/providers/composite.ts",
  "core/providers/types.ts",
  "core/providers/hetzner.ts",
  "core/providers/microvm.ts",
]);

export const UPLOAD_MANIFEST = Object.freeze([
  "teenybase.ts",
  "worker.ts",
  ...CORE_MANIFEST,
]);

export const UPLOAD_ORDER = Object.freeze([
  ...CORE_MANIFEST,
  "teenybase.ts",
  "worker.ts",
]);

export const DENY_ALL_RULES = Object.freeze({
  name: "rules",
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
});

export const BLITZDEV_CONFIG = Object.freeze({
  appName: "Blitz Control Plane",
  appUrl: "$APP_URL",
  jwtSecret: "$JWT_SECRET_MAIN",
  tables: [
    {
      name: "principals",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "unix_name", type: "text", sqlType: "text", notNull: true },
        { name: "harnesses", type: "text", sqlType: "text", notNull: true },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "sessions",
      fields: [
        { name: "token_hash", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "principal_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "expires_at", type: "integer", sqlType: "integer", notNull: true, default: { l: 0 } },
      ],
      indexes: [
        { name: "expires_at", fields: "expires_at" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "workspaces",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "owner_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "machine_type_id", type: "text", sqlType: "text", notNull: true, default: { l: "unknown" } },
        { name: "phase", type: "text", sqlType: "text", notNull: true, check: "phase IN ('creating', 'ready', 'destroying', 'destroyed', 'error')" },
        { name: "revision", type: "integer", sqlType: "integer", notNull: true, check: "revision > 0" },
        { name: "vm_id", type: "text", sqlType: "text" },
        { name: "volume_id", type: "text", sqlType: "text" },
        { name: "ssh_host", type: "text", sqlType: "text" },
        { name: "ssh_port", type: "integer", sqlType: "integer" },
        { name: "ssh_user", type: "text", sqlType: "text" },
        { name: "ssh_host_public_key", type: "text", sqlType: "text" },
        { name: "error", type: "text", sqlType: "text" },
        { name: "phone_home_hash", type: "text", sqlType: "text" },
        { name: "phone_home_used", type: "bool", sqlType: "integer", notNull: true, default: { l: 0 }, check: "phone_home_used IN (0, 1)" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "updated_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "manifest", type: "text", sqlType: "text" },
      ],
      indexes: [
        { name: "owner", fields: ["owner_id", "created_at"] },
        { name: "phase", fields: ["phase", "updated_at"] },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "device_authorizations",
      fields: [
        { name: "device_hash", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "user_hash", type: "text", sqlType: "text", notNull: true, unique: true },
        { name: "client_id", type: "text", sqlType: "text", notNull: true },
        { name: "principal_id", type: "text", sqlType: "text", foreignKey: { table: "principals", column: "id" } },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "last_poll_at", type: "integer", sqlType: "integer" },
        { name: "consumed_at", type: "integer", sqlType: "integer" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "boxes",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "principal_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "workspace_id", type: "text", sqlType: "text", unique: true, foreignKey: { table: "workspaces", column: "id" } },
        { name: "broker_box_id", type: "text", sqlType: "text", foreignKey: { table: "broker_boxes", column: "box_id", onDelete: "SET NULL" } },
        { name: "is_broker", type: "bool", sqlType: "integer", notNull: true, default: { l: 0 }, check: "is_broker IN (0, 1)" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
      ],
      indexes: [
        { name: "broker", fields: "broker_box_id" },
        { name: "principal", fields: "principal_id" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "box_token_families",
      fields: [
        { name: "box_id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid", foreignKey: { table: "boxes", column: "id", onDelete: "CASCADE" } },
        { name: "access_hash", type: "text", sqlType: "text", notNull: true, unique: true },
        { name: "refresh_hash", type: "text", sqlType: "text", notNull: true, unique: true },
        { name: "access_issued_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "generation", type: "integer", sqlType: "integer", notNull: true },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "broker_boxes",
      fields: [
        { name: "box_id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid", foreignKey: { table: "boxes", column: "id", onDelete: "CASCADE" } },
        { name: "host", type: "text", sqlType: "text", notNull: true },
        { name: "port", type: "integer", sqlType: "integer", notNull: true },
        { name: "ssh_host_public_key", type: "text", sqlType: "text", notNull: true },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "broker_keys",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "box_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "boxes", column: "id", onDelete: "CASCADE" } },
        { name: "pubkey", type: "text", sqlType: "text", notNull: true },
        { name: "operation", type: "text", sqlType: "text", notNull: true, check: "operation IN ('mint', 'deposit')" },
      ],
      indexes: [
        { name: "box", fields: "box_id" },
        { name: "identity", unique: true, fields: ["box_id", "pubkey", "operation"] },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "integrations",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "name", type: "text", sqlType: "text", notNull: true, unique: true },
        { name: "provider", type: "text", sqlType: "text", notNull: true },
        { name: "kind", type: "text", sqlType: "text", notNull: true },
        { name: "custody", type: "text", sqlType: "text", notNull: true, default: { l: "cp" } },
        { name: "config", type: "text", sqlType: "text", notNull: true, default: { l: "{}" } },
        { name: "root_ciphertext", type: "text", sqlType: "text" },
        { name: "usable_by", type: "text", sqlType: "text" },
        { name: "created_by", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "revoked_at", type: "integer", sqlType: "integer" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "user_connections",
      fields: [
        { name: "user_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "integration_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "integrations", column: "id" } },
        { name: "refresh_ciphertext", type: "text", sqlType: "text", notNull: true },
        { name: "scopes", type: "text", sqlType: "text", notNull: true },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "revoked_at", type: "integer", sqlType: "integer" },
      ],
      indexes: [
        { name: "identity", unique: true, fields: ["user_id", "integration_id"] },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "credential_leases",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "workspace_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "workspaces", column: "id" } },
        { name: "box_id", type: "text", sqlType: "text", foreignKey: { table: "boxes", column: "id", onDelete: "SET NULL" } },
        { name: "integration_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "integrations", column: "id" } },
        { name: "user_id", type: "text", sqlType: "text" },
        { name: "scopes", type: "text", sqlType: "text", notNull: true },
        { name: "mode", type: "text", sqlType: "text", notNull: true, check: "mode IN ('inject','proxy')" },
        { name: "token_hash", type: "text", sqlType: "text", unique: true },
        { name: "issued_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "expires_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "state", type: "text", sqlType: "text", notNull: true, check: "state IN ('active','revoked','expired')" },
      ],
      indexes: [
        { name: "workspace", fields: ["workspace_id", "state"] },
        { name: "expiry", fields: ["state", "expires_at"] },
        { name: "token", fields: "token_hash", where: { q: "token_hash IS NOT NULL" } },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "credential_events",
      fields: [
        { name: "id", type: "integer", sqlType: "integer", primary: true, autoIncrement: true, noUpdate: true, noInsert: true },
        { name: "lease_id", type: "text", sqlType: "text", foreignKey: { table: "credential_leases", column: "id" } },
        { name: "event", type: "text", sqlType: "text", notNull: true, check: "event IN ('minted','revoked','denied','approved')" },
        { name: "detail", type: "text", sqlType: "text" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "credential_requests",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "workspace_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "workspaces", column: "id" } },
        { name: "integration_name", type: "text", sqlType: "text", notNull: true },
        { name: "requested_scopes", type: "text", sqlType: "text", notNull: true },
        { name: "state", type: "text", sqlType: "text", notNull: true, check: "state IN ('pending','approved','denied')" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "resolved_at", type: "integer", sqlType: "integer" },
        { name: "resolved_by", type: "text", sqlType: "text" },
      ],
      indexes: [
        { name: "pending", fields: ["state", "created_at"] },
        { name: "dedup", unique: true, fields: ["workspace_id", "integration_name", "requested_scopes"], where: { q: "state = 'pending'" } },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "microvm_hosts",
      fields: [
        { name: "name", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "url", type: "text", sqlType: "text" },
        { name: "updated_at", type: "integer", sqlType: "integer" },
        { name: "source", type: "text", sqlType: "text", check: "source IN ('static', 'registered')" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "blitz_files",
      r2Base: "blitz-files",
      autoDeleteR2Files: false,
      allowMultipleFileRef: true,
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "kind", type: "text", sqlType: "text", notNull: true, check: "kind IN ('cockpit', 'box-image')" },
        { name: "logical_path", type: "text", sqlType: "text", notNull: true },
        { name: "object", type: "file", sqlType: "text", notNull: true },
        { name: "media_type", type: "text", sqlType: "text", notNull: true },
        { name: "size_bytes", type: "integer", sqlType: "integer", notNull: true, check: "size_bytes >= 0" },
        { name: "sha256", type: "text", sqlType: "text", notNull: true },
        { name: "release_id", type: "text", sqlType: "text", notNull: true },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
      ],
      indexes: [
        { name: "logical", unique: true, fields: ["kind", "logical_path"] },
        { name: "release", fields: ["kind", "release_id"] },
      ],
      extensions: [DENY_ALL_RULES],
    },
  ],
});

function tsValue(value, depth = 0) {
  if (value === DENY_ALL_RULES) return "denyAllRules";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const indent = "  ".repeat(depth + 1);
    return `[\n${indent}${value.map((item) => tsValue(item, depth + 1)).join(`,\n${indent}`)},\n${"  ".repeat(depth)}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const indent = "  ".repeat(depth + 1);
    return `{\n${indent}${entries.map(([key, item]) => `${key}: ${tsValue(item, depth + 1)}`).join(`,\n${indent}`)},\n${"  ".repeat(depth)}}`;
  }
  return JSON.stringify(value);
}

export const TEENYBASE_SOURCE = normalizeSource(`import type { DatabaseSettings, TableRulesExtensionData } from "teenybase";

const denyAllRules: TableRulesExtensionData = ${tsValue({ ...DENY_ALL_RULES })};

const config = ${tsValue(BLITZDEV_CONFIG)} satisfies DatabaseSettings;

export default config;
`);

export const WORKER_SOURCE = normalizeSource(`import { $Database, teenyHono } from "teenybase";
import config from "virtual:teenybase";
import {
  CompositeVmProvider,
  credentialMasterKeyFor,
  createOperatorPrincipalSource,
  HetznerProvider,
  installControlPlaneRoutes,
  MicrovmPoolProvider,
  maybeScheduleLazySweep,
  maxConcurrentWorkspacesFromEnv,
  sessionTtlMsFromEnv,
  blobResponse,
  first,
  type BlobObject,
  type BlobStore,
  type CoreContext,
  type CoreRouter,
  type CoreRuntime,
  type Db,
} from "./core/index";

type ManagedBindings = {
  APP_URL: string;
  RESPOND_WITH_ERRORS: string | boolean;
  RESPOND_WITH_QUERY_LOG: string | boolean;
  TEENY_PRIMARY_DB: ConstructorParameters<typeof $Database>[2];
  TEENY_PRIMARY_R2: ConstructorParameters<typeof $Database>[3];
  HETZNER_API_TOKEN: string;
  JWT_SECRET_MAIN: string;
  OPERATOR_API_KEY: string;
  BOX_IMAGE_REF: string;
  BOX_IMAGE_SHA256: string;
  BOX_IMAGE_TAG: string;
  SESSION_TTL_DAYS?: string;
  MAX_CONCURRENT_WORKSPACES?: string;
  MICROVM_HOSTS?: string;
  CRED_MASTER_KEY: string;
};

type ManagedEnv = {
  Bindings: ManagedBindings;
  Variables: {
    settings: typeof config;
    $db: $Database;
    $credentialMasterKey: CryptoKey;
  };
};

interface ManagedContext {
  readonly env: ManagedBindings;
  get(name: string): unknown;
  readonly executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

interface CockpitContext {
  readonly req: { readonly raw: Request };
  get(name: "$db"): $Database;
  json(value: { error: string; retryAction: null }, status: number): Response;
}

interface ManagedFileRow {
  object: string;
  media_type: string;
  size_bytes: number;
}

function dynamicBinding(env: ManagedBindings, name: string): unknown {
  return Reflect.get(env, name);
}

function providersFor(env: ManagedBindings, db: Db): CoreRuntime["providers"] {
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

const API_PREFIXES = [
  "/sessions",
  "/workspaces",
  "/volumes",
  "/machine-types",
  "/hosts/",
  "/oauth/",
  "/boxes/",
  "/integrations",
  "/leases/",
  "/requests",
  "/proxy/",
  "/box-image",
  "/api/",
];

function managedBlobStore(db: $Database, kind: "box-image" | "cockpit"): BlobStore {
  return {
    async get(logicalPath): Promise<BlobObject | null> {
      const row = await first<ManagedFileRow>(db, {
        q: "SELECT object, media_type, size_bytes FROM blitz_files WHERE kind = ? AND logical_path = ? LIMIT 1",
        v: [kind, logicalPath],
      });
      if (row === null) return null;
      const object = await db.getFileObject("blitz-files/" + row.object);
      if (object === null) return null;
      return {
        body: object.body,
        size: row.size_bytes,
        httpEtag: object.httpEtag,
        writeHttpMetadata(headers) {
          object.writeHttpMetadata(headers);
          headers.set("content-type", row.media_type);
        },
      };
    },
  };
}

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname === (prefix.endsWith("/") ? prefix.slice(0, -1) : prefix) || pathname.startsWith(prefix));
}

async function cockpitResponse(context: CockpitContext, logicalPath: string): Promise<Response> {
  const object = await managedBlobStore(context.get("$db"), "cockpit").get(logicalPath);
  if (object === null) return context.json({ error: "not found", retryAction: null }, 404);
  const response = blobResponse(object, context.req.raw);
  response.headers.set(
    "cache-control",
    logicalPath.startsWith("/assets/") && /-[A-Za-z0-9_-]{8,}\\.[^/]+$/u.test(logicalPath)
      ? "public,max-age=31536000,immutable"
      : "no-cache",
  );
  return response;
}

function runtimeFor(context: CoreContext): CoreRuntime;
function runtimeFor(context: ManagedContext): CoreRuntime;
function runtimeFor(context: CoreContext | ManagedContext): CoreRuntime {
  const env = context.env as ManagedBindings;
  const db = context.get("$db") as Db;
  return {
    db,
    blobs: managedBlobStore(context.get("$db") as $Database, "box-image"),
    credentialMasterKey: context.get("$credentialMasterKey") as CryptoKey,
    vars: {
      boxImageRef: env.BOX_IMAGE_REF,
      boxImageSha256: env.BOX_IMAGE_SHA256,
      boxImageTag: env.BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(env.SESSION_TTL_DAYS),
      maxConcurrentWorkspaces: maxConcurrentWorkspacesFromEnv(env.MAX_CONCURRENT_WORKSPACES),
    },
    providers: providersFor(env, db),
    principalSource: createOperatorPrincipalSource(env.OPERATOR_API_KEY),
    waitUntil: (promise) => context.executionCtx.waitUntil(promise),
  };
}

const app = teenyHono<ManagedEnv>(
  async (c) => {
    c.set("$credentialMasterKey", await credentialMasterKeyFor(c.env.CRED_MASTER_KEY));
    return new $Database(c, config, c.env.TEENY_PRIMARY_DB, c.env.TEENY_PRIMARY_R2);
  },
  undefined,
  { cors: false, logger: true },
  async (c) => {
    const runtime = runtimeFor(c);
    await runtime.providers.microvm?.syncStaticHosts();
    maybeScheduleLazySweep(runtime, c.req.path);
  },
);

installControlPlaneRoutes(app as unknown as CoreRouter, runtimeFor);
app.get("/assets/*", (c) => cockpitResponse(c, c.req.path));
app.get("/", (c) => cockpitResponse(c, "/index.html"));
app.get("*", (c) => isApiPath(c.req.path)
  ? c.json({ error: "not found", retryAction: null }, 404)
  : cockpitResponse(c, "/index.html"));
export default app;
`);

export function normalizeSource(source) {
  return source.replace(/\r\n?/gu, "\n").replace(/\s+$/u, "") + "\n";
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const MEDIA_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
});

export function mediaTypeForPath(filePath) {
  return MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function managedFileId(kind, logicalPath) {
  if (kind !== "cockpit" && kind !== "box-image") throw new Error(`unsupported file kind: ${kind}`);
  return sha256(`${kind}\0${logicalPath}`);
}

async function sha256File(filePath, aggregate) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
    aggregate?.update(chunk);
  }
  return digest.digest("hex");
}

async function walkRegularFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walkRegularFiles(directory, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

function assetReleaseId(files) {
  return sha256(files.map((file) =>
    `${file.logicalPath}\0${file.sizeBytes}\0${file.sha256}\0${file.mediaType}\n`).join(""));
}

export async function createCockpitAssetSet(distDir = DEFAULT_UI_DIST_DIR) {
  const relativePaths = await walkRegularFiles(distDir);
  if (!relativePaths.includes("index.html")) throw new Error(`cockpit build is missing ${path.join(distDir, "index.html")}`);
  const files = await Promise.all(relativePaths.map(async (relativePath) => {
    const sourcePath = path.join(distDir, relativePath);
    const metadata = await stat(sourcePath);
    return {
      kind: "cockpit",
      logicalPath: `/${relativePath.split(path.sep).join("/")}`,
      mediaType: mediaTypeForPath(relativePath),
      sizeBytes: metadata.size,
      sha256: await sha256File(sourcePath),
      sourcePath,
    };
  }));
  const releaseId = assetReleaseId(files);
  const uploadFiles = [
    ...files.filter(({ logicalPath }) => logicalPath !== "/index.html"),
    ...files.filter(({ logicalPath }) => logicalPath === "/index.html"),
  ];
  return {
    kind: "cockpit",
    releaseId,
    files: uploadFiles.map((file) => ({ ...file, releaseId })),
  };
}

function validateBoxPart(part) {
  if (part === null || typeof part !== "object" || typeof part.name !== "string" || typeof part.sha256 !== "string") {
    throw new Error("box-image manifest contains an invalid part");
  }
  if (part.name !== path.basename(part.name) || part.name === "." || part.name === "..") {
    throw new Error(`box-image part name is not a basename: ${part.name}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(part.sha256)) throw new Error(`box-image part has invalid SHA-256: ${part.name}`);
}

export async function createBoxImageAssetSet(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest.parts) || typeof manifest.totalSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.totalSha256)) {
    throw new Error("invalid box-image manifest");
  }
  const directory = path.dirname(manifestPath);
  const aggregate = createHash("sha256");
  const partFiles = [];
  for (const part of manifest.parts) {
    validateBoxPart(part);
    const sourcePath = path.join(directory, part.name);
    const metadata = await stat(sourcePath);
    const actual = await sha256File(sourcePath, aggregate);
    if (actual !== part.sha256) throw new Error(`box-image part SHA-256 mismatch: ${part.name}`);
    partFiles.push({
      kind: "box-image",
      logicalPath: `box-image/${part.name}`,
      mediaType: "application/octet-stream",
      sizeBytes: metadata.size,
      sha256: actual,
      sourcePath,
      releaseId: manifest.totalSha256,
    });
  }
  if (aggregate.digest("hex") !== manifest.totalSha256) throw new Error("box-image aggregate SHA-256 mismatch");
  const manifestMetadata = await stat(manifestPath);
  const manifestFile = {
    kind: "box-image",
    logicalPath: "box-image/manifest.json",
    mediaType: "application/json; charset=utf-8",
    sizeBytes: manifestMetadata.size,
    sha256: await sha256File(manifestPath),
    sourcePath: manifestPath,
    releaseId: manifest.totalSha256,
  };
  return { kind: "box-image", releaseId: manifest.totalSha256, files: [...partFiles, manifestFile] };
}

export function importSpecifiers(source) {
  const imports = [];
  const staticPattern = /\b(?:import|export)\s+(type\s+)?(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']/gu;
  const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of source.matchAll(staticPattern)) {
    imports.push({ specifier: match[2], typeOnly: match[1] !== undefined });
  }
  for (const match of source.matchAll(dynamicPattern)) {
    imports.push({ specifier: match[1], typeOnly: false });
  }
  return imports;
}

function isRelative(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

export function validateUploadSet(entries) {
  const paths = entries.map((entry) => entry.path);
  const duplicates = paths.filter((entryPath, index) => paths.indexOf(entryPath) !== index);
  if (duplicates.length > 0) throw new Error(`duplicate output paths: ${duplicates.join(", ")}`);
  if (entries.length > MAX_FILE_COUNT) throw new Error(`upload set has ${entries.length} files; maximum is ${MAX_FILE_COUNT}`);

  for (const entry of entries) {
    const bytes = Buffer.byteLength(entry.source);
    if (bytes > MAX_FILE_BYTES) throw new Error(`${entry.path} is ${bytes} bytes; maximum is ${MAX_FILE_BYTES}`);
    const imports = importSpecifiers(entry.source);
    if (entry.path.startsWith("core/")) {
      const forbidden = imports.filter(({ specifier }) => !isRelative(specifier));
      if (forbidden.length > 0) throw new Error(`${entry.path} has forbidden import ${forbidden[0].specifier}`);
    } else if (entry.path === "worker.ts") {
      const forbidden = imports.filter(({ specifier }) =>
        !isRelative(specifier) && specifier !== "teenybase" && specifier !== "virtual:teenybase");
      if (forbidden.length > 0) throw new Error(`worker.ts has forbidden import ${forbidden[0].specifier}`);
    } else if (entry.path === "teenybase.ts") {
      const forbidden = imports.filter(({ specifier, typeOnly }) => specifier !== "teenybase" || !typeOnly);
      if (forbidden.length > 0) throw new Error("teenybase.ts may only type-import teenybase");
    }
  }
}

export function createUploadSet(coreSources) {
  const entries = [
    { path: "teenybase.ts", source: TEENYBASE_SOURCE },
    { path: "worker.ts", source: WORKER_SOURCE },
    ...CORE_MANIFEST.map((uploadPath) => {
      const source = coreSources.get(uploadPath);
      if (source === undefined) throw new Error(`missing source for ${uploadPath}`);
      return { path: uploadPath, source: normalizeSource(source) };
    }),
  ];
  validateUploadSet(entries);
  const files = entries.map((entry) => ({
    ...entry,
    bytes: Buffer.byteLength(entry.source),
    sha256: sha256(entry.source),
  }));
  const releaseHash = sha256(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""));
  return { files, releaseHash };
}

export async function readCoreSources(packageDir = PACKAGE_DIR) {
  const entries = await Promise.all(CORE_MANIFEST.map(async (uploadPath) => {
    const relative = uploadPath.slice("core/".length);
    return [uploadPath, await readFile(path.join(packageDir, "core", relative), "utf8")];
  }));
  return new Map(entries);
}

export async function emitUploadSet({ packageDir = PACKAGE_DIR, distDir = DEFAULT_DIST_DIR } = {}) {
  const uploadSet = createUploadSet(await readCoreSources(packageDir));
  await rm(distDir, { recursive: true, force: true });
  for (const file of uploadSet.files) {
    const destination = path.join(distDir, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.source, "utf8");
  }
  return { ...uploadSet, distDir };
}

export function redactSecrets(value) {
  return String(value)
    .replace(/\btp__[A-Za-z0-9_-]+\b/gu, "[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,"'}]+/giu, "$1[REDACTED]")
    .replace(/(x-project-password\s*:\s*)[^\s,"'}]+/giu, "$1[REDACTED]")
    .replace(/(\/agent\/)[^/\s]+(\/agents\.md)/gu, "$1[REDACTED]$2")
    .replace(/(["'](?:token|agent_link|password)["']\s*:\s*["'])[^"']+/giu, "$1[REDACTED]");
}

function printManifest(uploadSet) {
  for (const file of uploadSet.files) {
    process.stdout.write(`${file.path}\t${file.bytes}\t${file.sha256}\n`);
  }
  process.stdout.write(`release\t${uploadSet.files.length}\t${uploadSet.releaseHash}\n`);
}

function parseCli(argv) {
  const options = {
    upload: false,
    noCommit: false,
    commit: false,
    uploadCockpit: false,
    attemptBoxImage: false,
    probeFile: undefined,
    projectPasswordFile: undefined,
    boxImageManifest: undefined,
    distDir: DEFAULT_DIST_DIR,
    uiDistDir: DEFAULT_UI_DIST_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") continue;
    if (arg === "--upload") options.upload = true;
    else if (arg === "--no-commit") options.noCommit = true;
    else if (arg === "--commit") options.commit = true;
    else if (arg === "--upload-cockpit") options.uploadCockpit = true;
    else if (arg === "--attempt-box-image") options.attemptBoxImage = true;
    else if (["--probe-file", "--project-password-file", "--box-image-manifest", "--dist", "--ui-dist"].includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--probe-file") options.probeFile = value;
      else if (arg === "--project-password-file") options.projectPasswordFile = value;
      else if (arg === "--box-image-manifest") options.boxImageManifest = path.resolve(value);
      else if (arg === "--ui-dist") options.uiDistDir = path.resolve(value);
      else options.distDir = path.resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.commit && !options.upload) throw new Error("--commit is invalid without --upload");
  if (options.noCommit && !options.upload) throw new Error("--no-commit is invalid without --upload");
  if (options.upload && options.commit === options.noCommit) {
    throw new Error("--upload requires exactly one of --no-commit or --commit");
  }
  if (options.upload && options.probeFile === undefined) throw new Error("--upload requires --probe-file");
  if ((options.uploadCockpit || options.attemptBoxImage) && options.probeFile === undefined) {
    throw new Error("managed file upload requires --probe-file");
  }
  if ((options.uploadCockpit || options.attemptBoxImage) && options.projectPasswordFile === undefined) {
    throw new Error("managed file upload requires --project-password-file");
  }
  if (options.attemptBoxImage && options.boxImageManifest === undefined) {
    throw new Error("--attempt-box-image requires --box-image-manifest");
  }
  if (options.noCommit && (options.uploadCockpit || options.attemptBoxImage)) {
    throw new Error("data uploads cannot run before the schema is committed");
  }
  return options;
}

async function projectAccess(probeFile) {
  const probe = JSON.parse(await readFile(probeFile, "utf8"));
  if (typeof probe.slug !== "string" || typeof probe.agent_link !== "string") {
    throw new Error("probe file must contain slug and agent_link");
  }
  const agentUrl = new URL(probe.agent_link);
  const match = /^\/agent\/([^/]+)\/agents\.md$/u.exec(agentUrl.pathname);
  if (agentUrl.origin !== "https://blitz.dev" || match === null) throw new Error("invalid probe agent_link");
  return {
    base: `https://blitz.dev/api/v1/projects/${encodeURIComponent(probe.slug)}`,
    appUrl: `https://${probe.slug}.app.blitz.dev`,
    token: decodeURIComponent(match[1]),
  };
}

async function apiRequest(access, route, init = {}) {
  const response = await fetch(`${access.base}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${access.token}`,
      ...init.headers,
    },
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Text endpoints (including migration previews) are valid responses.
  }
  if (!response.ok) throw new Error(`API ${response.status}: ${redactSecrets(typeof body === "string" ? body : JSON.stringify(body))}`);
  return { response, body };
}

async function managedDataRequest(access, route, init = {}, { allowMissing = false, fetcher = fetch } = {}) {
  const response = await fetcher(`${access.base}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${access.token}`,
      ...init.headers,
    },
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Preserve the managed platform's exact text response for a redacted diagnostic.
  }
  if (allowMissing && response.status === 404) return { response, body: null };
  if (!response.ok) {
    throw new Error(`managed data API ${response.status}: ${redactSecrets(typeof body === "string" ? body : JSON.stringify(body))}`);
  }
  return { response, body };
}

function assertManagedFileRow(row, file) {
  if (
    row === null ||
    typeof row !== "object" ||
    typeof row.object !== "string" ||
    row.object.length === 0 ||
    row.logical_path !== file.logicalPath ||
    row.sha256 !== file.sha256 ||
    row.size_bytes !== file.sizeBytes
  ) {
    throw new Error(`managed file verification failed: ${file.kind} ${file.logicalPath}`);
  }
}

async function readManagedFileRow(access, file, fetcher) {
  const id = managedFileId(file.kind, file.logicalPath);
  const selected = await managedDataRequest(
    access,
    `/exec/blitz_files/view/${encodeURIComponent(id)}`,
    {},
    { allowMissing: true, fetcher },
  );
  return selected.body;
}

async function fileFormData(file, existing) {
  const blob = await openAsBlob(file.sourcePath, { type: file.mediaType });
  const payload = existing === null
    ? {
        values: {
          id: managedFileId(file.kind, file.logicalPath),
          kind: file.kind,
          logical_path: file.logicalPath,
          object: "@filePayload.0",
          media_type: file.mediaType,
          size_bytes: file.sizeBytes,
          sha256: file.sha256,
          release_id: file.releaseId,
          created_at: Date.now(),
        },
        returning: ["id", "object", "sha256"],
      }
    : {
        object: "@filePayload.0",
        media_type: file.mediaType,
        size_bytes: file.sizeBytes,
        sha256: file.sha256,
        release_id: file.releaseId,
      };
  const form = new FormData();
  form.append("@jsonPayload", JSON.stringify(payload));
  form.append("@filePayload", blob, path.basename(file.sourcePath));
  return form;
}

export async function uploadManagedAssets(assetSet, access, projectPassword, { fetcher = fetch } = {}) {
  if (typeof projectPassword !== "string" || projectPassword.length === 0) throw new Error("project password is empty");
  const result = { inserted: 0, replaced: 0, skipped: 0, verified: 0 };
  for (const file of assetSet.files) {
    const existing = await readManagedFileRow(access, file, fetcher);
    if (existing !== null && existing.sha256 === file.sha256 && existing.size_bytes === file.sizeBytes) {
      assertManagedFileRow(existing, file);
      result.skipped += 1;
      result.verified += 1;
      continue;
    }
    const id = managedFileId(file.kind, file.logicalPath);
    const form = await fileFormData(file, existing);
    const route = existing === null
      ? "/exec_write/blitz_files/insert"
      : `/exec_write/blitz_files/edit/${encodeURIComponent(id)}`;
    await managedDataRequest(access, route, {
      method: "POST",
      headers: { "X-Project-Password": projectPassword },
      body: form,
    }, { fetcher });
    const verified = await readManagedFileRow(access, file, fetcher);
    assertManagedFileRow(verified, file);
    if (existing === null) result.inserted += 1;
    else result.replaced += 1;
    result.verified += 1;
  }
  return result;
}

function saveVersion(response, body) {
  const header = response.headers.get("x-save-version") ?? response.headers.get("etag")?.replace(/^W\//u, "").replace(/^"|"$/gu, "");
  const resultVersion = typeof body === "object" && body !== null && typeof body.result?.version === "number"
    ? String(body.result.version)
    : undefined;
  return resultVersion ?? header;
}

function migrationText(body) {
  if (typeof body === "string") return body;
  const candidates = [body?.result?.content, body?.result?.text, body?.result?.sql, body?.content, body?.text, body?.sql];
  const value = candidates.find((candidate) => typeof candidate === "string");
  if (value === undefined) throw new Error("migration response did not contain SQL text");
  return value;
}

export async function uploadManagedSet(uploadSet, probeFile, { commit = false } = {}) {
  const access = await projectAccess(probeFile);
  await apiRequest(access, "/vars/APP_URL", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: access.appUrl }),
  });
  const listed = await apiRequest(access, "/files");
  let version = saveVersion(listed.response, listed.body);
  if (version === undefined) throw new Error("file listing omitted x-save-version");
  const byPath = new Map(uploadSet.files.map((file) => [file.path, file]));
  const saves = [];
  const started = performance.now();

  for (const uploadPath of UPLOAD_ORDER) {
    const file = byPath.get(uploadPath);
    if (file === undefined) throw new Error(`upload set omitted ${uploadPath}`);
    const saveStarted = performance.now();
    const saved = await apiRequest(access, `/files?path=${encodeURIComponent(file.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8", "If-Match": version },
      body: file.source,
    });
    if (typeof saved.body !== "object" || saved.body === null || saved.body.success !== true) {
      throw new Error(`save failed for ${file.path}: ${redactSecrets(JSON.stringify(saved.body))}`);
    }
    const result = saved.body.result;
    if (result?.config?.ok !== true || result?.bundle?.ok !== true) {
      throw new Error(`build failed for ${file.path}: ${redactSecrets(JSON.stringify({ config: result?.config, bundle: result?.bundle }))}`);
    }
    const nextVersion = saveVersion(saved.response, saved.body);
    if (nextVersion === undefined) throw new Error(`save response omitted version for ${file.path}`);
    version = nextVersion;
    saves.push({ path: file.path, configOk: true, bundleOk: true, durationMs: Math.round(performance.now() - saveStarted) });
    process.stdout.write(`saved\t${file.path}\tconfig.ok\tbundle.ok\t${saves.at(-1).durationMs}ms\n`);
  }

  const migrationResponse = await apiRequest(access, "/files?path=%40migration.sql");
  const migration = normalizeSource(migrationText(migrationResponse.body));
  process.stdout.write(`migration-schema-sha256\t${byPath.get("teenybase.ts").sha256}\n`);
  process.stdout.write(`migration-sql-sha256\t${sha256(migration)}\n`);
  process.stdout.write(migration);

  if (commit) {
    const committed = await apiRequest(access, "/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `blitz-core managed release ${uploadSet.releaseHash}` }),
    });
    if (typeof committed.body !== "object" || committed.body === null || committed.body.success !== true) {
      throw new Error(`commit failed: ${redactSecrets(JSON.stringify(committed.body))}`);
    }
  }

  return {
    saves,
    durationMs: Math.round(performance.now() - started),
    migration,
    migrationSha256: sha256(migration),
    committed: commit,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const emitted = await emitUploadSet({ distDir: options.distDir });
  printManifest(emitted);
  if (options.upload) await uploadManagedSet(emitted, options.probeFile, { commit: options.commit });
  if (options.uploadCockpit || options.attemptBoxImage) {
    const access = await projectAccess(options.probeFile);
    const projectPassword = (await readFile(options.projectPasswordFile, "utf8")).replace(/[\r\n]+$/u, "");
    if (options.uploadCockpit) {
      const cockpit = await createCockpitAssetSet(options.uiDistDir);
      const result = await uploadManagedAssets(cockpit, access, projectPassword);
      process.stdout.write(`cockpit-assets\t${cockpit.files.length}\t${cockpit.releaseId}\t${JSON.stringify(result)}\n`);
    }
    if (options.attemptBoxImage) {
      process.stdout.write("box-image-attempt\texplicit\texternal-fallback-retained\n");
      const boxImage = await createBoxImageAssetSet(options.boxImageManifest);
      const result = await uploadManagedAssets(boxImage, access, projectPassword);
      process.stdout.write(`box-image-assets\t${boxImage.files.length}\t${boxImage.releaseId}\t${JSON.stringify(result)}\n`);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${redactSecrets(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  });
}
