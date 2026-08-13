# Blitz-core control-plane port design

Status: Phase 1 implementation contract. No runtime code is changed by this document.

## 1. Decisions and invariants

1. There is one control-plane implementation under `packages/control-plane/core/`. It contains no bare-package imports: every import in that tree begins with `./` or `../` and resolves to another file in `core/`.
2. Both targets use teenybase's Hono instance, database wrapper, raw-query API, migration model, and file-field/R2 machinery. The port does not introduce a second router, query builder, migration engine, object-store format, auth framework, or scheduler.
3. Target A is the current Wrangler Worker. It binds native D1/R2, serves the cockpit with Wrangler Assets, retains both current cron triggers, and uses `tables: []` during this cutover.
4. Target B is a source upload to a blitz.dev managed project. Its Phase 3 schema has the eight existing domain tables. Phase 4 adds one support table, `blitz_files`, because teenybase file fields require a database row to own each file reference.
5. Managed imports obey the platform briefing: `teenybase` and `virtual:teenybase` are the only non-relative runtime imports. npm package imports are forbidden. Target A may use the normal package's documented `teenybase` and `teenybase/worker` export paths.
6. Domain endpoints, wire formats, cookies, OAuth-device behavior, token rotation, Hetzner calls, and cleanup semantics remain behaviorally compatible with the 23 current tests and 9 current end-to-end checks.
7. No workaround may bypass a managed-platform limit. The sanctioned fallback for box images remains the immutable public `BOX_IMAGE_REF`; missing platform capability is recorded in `BLITZDEV-PLATFORM-ASKS.md`.

## 2. Verified teenybase contracts

All paths in citations are under `/Users/minjunes/superapp/teenybase` unless shown otherwise. `blitzdev-project-agents.md` is shorthand for `/private/tmp/claude-501/-Users-minjunes-blitz-core/04b1d3bc-f75f-42dd-8392-58b453d06f5a/scratchpad/blitzdev-project-agents.md`.

### 2.1 Import surfaces and Hono ownership

The installed package exposes the root and `./worker` subpath (`package.json:30-56`). The root exports configuration/types and schema helpers, but not the Worker runtime (`src/index.ts:2-78`). `teenybase/worker` exports `teenyHono`, `$Database`, `$Table`, `$DatabaseRawImpl`, and the native D1/R2 adapters (`src/worker/index.ts:1-48`). It does not export Hono, `html`, or cookie helpers. Target A must therefore use exactly:

```ts
import type { DatabaseSettings } from "teenybase";
import { $Database, $DatabaseRawImpl, teenyHono } from "teenybase/worker";
```

`teenyHono(createDb, app?, options?, onRequest?, beforeRoute?)` creates the Hono instance when `app` is omitted, sets `$db` in request context, calls `onRequest`, and dispatches `/api/*` through `$Database` before application routes (`src/worker/honoApp.ts:11-22,48-67`). Thus core registers routes on the returned object; it never constructs Hono.

The managed build is intentionally different. Its bundle entry extends the Worker exports with `Hono`, HTML helpers, and cookies (`src/bundle/cf-ui-entry.ts:1-15`), while the backend build entry also exports scaffold/config helpers (`backend/src/build/bundle-entry.ts:1-26`). The project gateway injects that bundle only as module `teenybase` plus `virtual:teenybase` (`project-gateway/src/index.ts:274-293`). The real briefing consequently requires every managed teenybase/Hono import from root `teenybase` and forbids npm imports (`/private/tmp/claude-501/-Users-minjunes-blitz-core/04b1d3bc-f75f-42dd-8392-58b453d06f5a/scratchpad/blitzdev-project-agents.md:91-105`; `backend/src/routes/agent-briefing.ts:189-214`). Target B must use exactly:

```ts
import { $Database, teenyHono } from "teenybase";
import config from "virtual:teenybase";
```

`teenybase/worker`, `hono`, and `hono/*` are forbidden in emitted managed files even if an esbuild external happens to recognize them.

### 2.2 Core database contract

Teenybase's query object is exactly `{ q: string; v: any[] }` (`src/sql/build/d1.ts:3-6`). Its raw API is `rawSQL<T>(query).run(): Promise<T[] | null>` and `rawSQLTransaction<T>(queries).run(): Promise<T[][] | null>` (`src/worker/$DatabaseRawImpl.ts:21-23,46-52,57-93,96-119,122-145,148-245`). Raw results discard D1 metadata and return only `results` (`src/worker/$DatabaseRawImpl.ts:74-83`). The core interface is therefore structural and exact:

```ts
export interface Query {
  q: string;
  v: any[];
}

export interface RawRun<T> {
  run(): Promise<T[] | null>;
}

export interface TransactionRun<T> {
  run(): Promise<T[][] | null>;
}

export interface Db {
  rawSQL<T = Record<string, unknown>>(query: Query): RawRun<T>;
  rawSQLTransaction<T = Record<string, unknown>>(
    queries: Query[],
  ): TransactionRun<T>;
}
```

`core/db.ts` owns only thin helpers over that interface:

```ts
rows<T>(db, q)       // (await db.rawSQL<T>(q).run()) ?? []
first<T>(db, q)      // rows<T>(...)[0] ?? null
transaction<T>(...) // (await db.rawSQLTransaction<T>(qs).run()) ?? []
changed(db, q)       // q must contain RETURNING; result row count
```

Every query supplies a positional `v` array, including `[]`. Existing `.prepare().bind().first()` becomes `first`; `.all()` becomes `rows`; `.run()` becomes `rows` or `changed`; `.batch()` becomes `rawSQLTransaction`. A mutation that tests affected-row count must add `RETURNING` and inspect returned array length—never `meta.changes`, because that metadata is unavailable. This applies specifically to refresh-token compare-and-swap, device authorization consumption, phone-home consumption, and janitor state transitions.

`$DatabaseRawImpl` accepts a native D1 binding and wraps it with `D1Adapter` (`src/worker/$DatabaseRawImpl.ts:29-38`). `D1Adapter` maps `{q,v}` to `prepare(q).bind(...v).run()` and transaction batches to native `D1Database.batch()` (`src/worker/storage/D1Adapter.ts:15-26`); the storage contract defines batch execution as atomic (`src/worker/storage/StorageAdapter.ts:43-63`). Consequently:

- HTTP routes in both targets pass `c.get("$db")` directly as `Db`.
- Target A's `scheduled()` creates `new $DatabaseRawImpl(env.DB)` and calls core janitors.
- Core does not define a native-D1 adapter and never imports Cloudflare types.

### 2.3 Core blob contract

The read-only core abstraction is deliberately the common subset of native R2 and teenybase file reads:

```ts
export interface BlobObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

export interface BlobStore {
  get(logicalKey: string): Promise<BlobObject | null>;
}
```

Target A passes `env.BOX_IMAGES` as `BlobStore`; native R2 already has the required shape. Target B Phase 3 passes a `NullBlobStore` whose `get` returns `null`, so `/box-image/*` is unavailable while workspace bootstrap continues to use the external immutable `BOX_IMAGE_REF`. Phase 4 replaces it with a managed adapter whose `get(logicalKey)` selects the matching `blitz_files` row, reads its stored physical file name, and calls `$db.getFileObject("blitz-files/" + physicalName)`. `$Database.getFileObject(key)` is the public read API and delegates to the configured R2 bucket (`src/worker/$Database.ts:861-878`); its put/delete helpers are private (`src/worker/$Database.ts:880-918`), so managed writes must go through a file field rather than a new storage API.

`$Table` recognizes `type: "file"`, validates table file options, replaces an uploaded `File` with a normalized randomized physical name, and uses the table's `r2Base` (`src/worker/$Table.ts:111-127,671-750`). It reads through `$db.getFileObject` (`src/worker/$Table.ts:752-760`). The database upload applies content type and cache control (`src/worker/$Database.ts:998-1031`). Filename normalization removes path structure and adds a random suffix (`src/worker/util/string.ts:3-16`), which is why `blitz_files.logical_path` is required: a URL cannot be reconstructed from the R2 key alone.

## 3. Extracted core

### 3.1 Exact module set

Create this exact source tree. No other source file may be added under `core/` without updating this contract.

```text
packages/control-plane/core/
  index.ts
  app.ts
  runtime.ts
  db.ts
  blobs.ts
  wire.ts
  bootstrap.ts
  box-images.ts
  cloud-init.ts
  crypto.ts
  http.ts
  janitors.ts
  oauth.ts
  principals.ts
  registry.ts
  sessions.ts
  types.ts
  volumes.ts
  workspaces.ts
  providers/
    types.ts
    hetzner.ts
```

Responsibilities are fixed:

- `runtime.ts`: structural router/context types, `CoreRuntime`, and `RuntimeFactory`; no Hono import.
- `db.ts`: the exact `Db` contract above and query-result helpers.
- `blobs.ts`: the exact read contract above, range/conditional streaming response helpers, and logical cockpit/box lookup contracts.
- `wire.ts`: local copies of only the API/broker/machine/volume/workspace wire types and constants currently imported from `@blitzos/schema`.
- `app.ts`: `installControlPlaneRoutes(router, runtimeFactory)` and error/not-found registration.
- Remaining files retain their current named domain responsibilities; `providers/hetzner.ts` remains an implementation of the relative `providers/types.ts` interface.
- `index.ts` is the core's relative-only public barrel.

The structural router is not a router implementation. It contains only the route methods core calls (`get`, `post`, `put`, `delete`, `notFound`, and `onError`) and a handler context with `req`, `env`, `get`, `json`, `text`, `body`, `header`, and `executionCtx.waitUntil`. Each target performs one localized `as unknown as CoreRouter` cast when installing routes. `RuntimeFactory(c)` returns `{ db, blobs, vars, providers, principalSource, waitUntil }`; request code obtains dependencies from that object rather than global imports.

The wire copies are guarded by `test/wire-drift.test.ts`, which imports both `core/wire.ts` and `@blitzos/schema` outside `core/` and asserts constants and representative serialize/parse shapes match. That is the only allowed schema-package dependency in the control-plane port.

### 3.2 Query conversion rules

The implementation agent applies these rules mechanically to every current statement:

| Current behavior | Core behavior |
|---|---|
| `prepare(sql).bind(...v).first<T>()` | `first<T>(db, { q: sql, v })` |
| `prepare(sql).bind(...v).all<T>()` | `rows<T>(db, { q: sql, v })` |
| unconditional insert/update/delete | `rows(db, { q: sql, v })`; ignore returned rows |
| conditional mutation whose success matters | append `RETURNING <primary-key>` and require `changed(...) === 1` |
| `db.batch(statements)` | one `rawSQLTransaction([{q,v}, ...]).run()` |

The device-grant and phone-home three-statement sequences remain three statements in one raw transaction. Refresh rotation remains one conditional `UPDATE ... RETURNING box_id`. No transaction is split into separate awaited requests.

## 4. Target A: Wrangler Worker

### 4.1 Runtime/config wiring

Add `packages/control-plane/teenybase.ts` with:

```ts
import type { DatabaseSettings } from "teenybase";

const config = {
  appName: "Blitz Control Plane",
  appUrl: "https://blitz-control-plane.blitzapp.workers.dev",
  jwtSecret: "$JWT_SECRET_MAIN",
  tables: [],
} satisfies DatabaseSettings;

export default config;
```

`tables: []` is a cutover rule, not an incomplete schema: Target A's live D1 and `migrations/0001_initial.sql` remain authoritative in this phase. It prevents teenybase schema management from interpreting an already-live database as a fresh managed schema.

Rewrite `src/worker.ts` as target glue with this shape:

```ts
import { $Database, $DatabaseRawImpl, teenyHono } from "teenybase/worker";
import config from "../teenybase";
import {
  installControlPlaneRoutes,
  maybeScheduleLazySweep,
  runInvariantSweep,
  runOrphanSweep,
  type CoreRouter,
} from "../core";

const app = teenyHono<WorkerEnv>(
  async (c) => new $Database(c, config, c.env.DB, c.env.BOX_IMAGES),
  undefined,
  { cors: false, logger: true },
  (c) => maybeScheduleLazySweep(runtimeFor(c), c.req.path),
);

installControlPlaneRoutes(app as unknown as CoreRouter, runtimeFor);

export default {
  fetch(request, env, ctx) { return app.fetch(request, env, ctx); },
  async scheduled(_event, env, ctx) {
    const db = new $DatabaseRawImpl(env.DB);
    ctx.waitUntil((async () => {
      const runtime = runtimeForScheduled(env, db);
      await runInvariantSweep(runtime);
      await runOrphanSweep(runtime);
    })());
  },
};
```

The final implementation supplies explicit Worker types and typed helper bodies; it does not change the imports, constructor choices, hook placement, or the ordered pair of scheduled calls. `$Database` accepts context, settings, a native D1 binding/adapter, and optional R2 (`src/worker/$Database.ts:42-77`). `teenyHono` requires an async database factory and supports the option and request-hook positions shown (`src/worker/honoApp.ts:11-20`).

### 4.2 Cockpit assets and crons

Keep the current `DB` D1 binding, `BOX_IMAGES` R2 binding, and both current cron expressions in `packages/control-plane/wrangler.toml`. Add:

```toml
[assets]
directory = "../ui/dist"
not_found_handling = "single-page-application"
run_worker_first = [
  "/sessions*",
  "/workspaces*",
  "/volumes*",
  "/machine-types*",
  "/oauth/*",
  "/boxes/*",
  "/box-image*",
  "/api/*"
]
```

Wrangler supports `directory`, `not_found_handling`, and `run_worker_first` in its installed config schema (`node_modules/wrangler/config-schema.json:3837-3887`). API prefixes therefore reach the Worker; other paths use the SPA fallback. Build the cockpit first with `npm --workspace @blitzos/ui run build` so `packages/ui/dist` exists.

### 4.3 Deploy decision

Use Wrangler for Target A in Phases 2–4:

```sh
npm --workspace @blitzos/ui run build
npx wrangler d1 migrations apply DB --remote --config packages/control-plane/wrangler.toml
npx wrangler deploy --config packages/control-plane/wrangler.toml
```

Do **not** run `npx teeny deploy --remote --db DB` for this cutover. The teeny CLI does accept global `--db` (`src/node/cli.ts:177-185`) and resolves it as the D1 binding (`src/node/cli-utils.ts:664-677`), but `teeny deploy` always combines migration and deploy (`src/node/cli.ts:210-249`). Its migration generation compares managed teeny metadata, defaults to cleaning SQL migration files, and deletes/rewrites the current local SQL set (`src/node/cli-utils.ts:930-1086,1006-1032`). The existing D1 was not baselined with teeny's `$settings_version`/migration state, so using it now risks treating the live schema as fresh or replacing `0001_initial.sql`. A future teeny CLI cutover requires an explicit, separately reviewed baseline procedure; it is outside this port.

### 4.4 Exact Phase 2 current-file changes

Create `core/**` and `teenybase.ts`; rewrite `src/worker.ts` and `src/index.ts`; migrate then remove these duplicate implementations from `src/`: `app.ts`, `bootstrap.ts`, `box-images.ts`, `cloud-init.ts`, `crypto.ts`, `http.ts`, `janitors.ts`, `oauth.ts`, `principals.ts`, `registry.ts`, `sessions.ts`, `types.ts`, `volumes.ts`, `workspaces.ts`, `providers/types.ts`, and `providers/hetzner.ts`. Update `package.json`, root lockfile, `tsconfig.json`, `wrangler.toml`, `worker-configuration.d.ts`, `README.md`, `test/env.d.ts`, and the test import/helper files. Pin Target A's dependency as exact `"teenybase": "0.0.15"`, matching the studied package (`/Users/minjunes/superapp/teenybase/package.json:2-3,30-56`); do not use a caret/range. Do not edit `migrations/0001_initial.sql`, `TODO.md`, `vitest.config.ts`, or UI source.

## 5. Target B: emitted managed project

### 5.1 Complete eight-table `teenybase.ts`

The repository source is `packages/control-plane/targets/blitzdev/teenybase.ts`; the emitter copies it to managed root `teenybase.ts`. This is the complete Phase 3 file—no table factory or hidden defaults:

```ts
import type { DatabaseSettings, TableRulesExtensionData } from "teenybase";

const denyAllRules: TableRulesExtensionData = {
  name: "rules",
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
};

const config = {
  appName: "Blitz Control Plane",
  appUrl: "https://blitz-core-probe-caae.app.blitz.dev",
  jwtSecret: "$JWT_SECRET_MAIN",
  tables: [
    {
      name: "principals",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "unix_name", type: "text", sqlType: "text", notNull: true },
        { name: "harnesses", type: "text", sqlType: "text", notNull: true },
      ],
      extensions: [denyAllRules],
    },
    {
      name: "sessions",
      fields: [
        { name: "token_hash", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "principal_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
      ],
      extensions: [denyAllRules],
    },
    {
      name: "workspaces",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "owner_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
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
      ],
      indexes: [
        { name: "owner", fields: ["owner_id", "created_at"] },
        { name: "phase", fields: ["phase", "updated_at"] },
      ],
      extensions: [denyAllRules],
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
      extensions: [denyAllRules],
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
      extensions: [denyAllRules],
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
      extensions: [denyAllRules],
    },
    {
      name: "broker_boxes",
      fields: [
        { name: "box_id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid", foreignKey: { table: "boxes", column: "id", onDelete: "CASCADE" } },
        { name: "host", type: "text", sqlType: "text", notNull: true },
        { name: "port", type: "integer", sqlType: "integer", notNull: true },
        { name: "ssh_host_public_key", type: "text", sqlType: "text", notNull: true },
      ],
      extensions: [denyAllRules],
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
      extensions: [denyAllRules],
    },
  ],
} satisfies DatabaseSettings;

export default config;
```

The `appUrl` literal is the real disposable project's canonical origin from its managed briefing (`blitzdev-project-agents.md:20-23`). A later claimed production project must change this one literal to that project's canonical same origin before its first source upload; it must not reuse the probe URL or derive the value from a request header.

`DatabaseSettings` requires `tables`, `jwtSecret`, and `appUrl` (`src/types/config.ts:257-290`). The table/field/index keys above are the real `TableData`, `TableFieldData`, and `SQLIndex` shapes (`src/types/table.ts:4-81`; `src/types/field.ts:5-47`; `src/types/sql.ts:69-75`). A rules extension with every operation `null` denies non-admin traffic, while admin requests bypass the rules (`src/worker/extensions/tableRulesExtension.ts:22-30,68-82`; `src/types/tableExtensions.ts:3-30`). Domain code uses raw SQL through `$db`; exposing generic CRUD to callers is neither necessary nor allowed.

The definitions reproduce all columns, nullability, defaults, checks, foreign keys, uniqueness, and index field sets in `packages/control-plane/migrations/0001_initial.sql:3-81`. Teenybase always renders index identifiers as `idx_<table>_<name>` (`src/sql/schema/tableQueries.ts:43-55`), so managed index names intentionally differ from the legacy hand-written names while their semantics match. The unique `identity` index is the teenybase representation of the current unnamed table-level broker-key constraint. Do not add `allowWildcard: true`: although present in the `TableData` type, the real config validator rejects it as unsupported (`src/types/zod/tableDataSchema.ts:65-68`); admin view calls and core raw SQL do not need it.

### 5.2 Managed `worker.ts`

The repository source is `packages/control-plane/targets/blitzdev/worker.ts`; emitted root path is `worker.ts`:

```ts
import { $Database, teenyHono } from "teenybase";
import config from "virtual:teenybase";
import {
  installControlPlaneRoutes,
  maybeScheduleLazySweep,
  type CoreRouter,
} from "./core/index";

const app = teenyHono<ManagedEnv>(
  async (c) => new $Database(c, config, c.env.TEENY_PRIMARY_DB, c.env.TEENY_PRIMARY_R2),
  undefined,
  { cors: false, logger: true },
  (c) => maybeScheduleLazySweep(runtimeFor(c), c.req.path),
);

installControlPlaneRoutes(app as unknown as CoreRouter, runtimeFor);
export default app;
```

The final file defines `ManagedEnv` and `runtimeFor` locally using only imported relative core types. It exports no `scheduled` handler because managed projects dispatch HTTP only; the platform briefing states that cron, queues, Durable Objects, service bindings, and other handlers are unavailable (`blitzdev-project-agents.md:121-132`). `c.env.TEENY_PRIMARY_DB` and `c.env.TEENY_PRIMARY_R2` are the exact managed RPC binding names supplied by the gateway (`project-gateway/src/index.ts:280-291`) and shown by the managed briefing (`blitzdev-project-agents.md:96-103`).

### 5.3 Emitter and upload set

Create `packages/control-plane/scripts/build-blitzdev.mjs`. It emits into gitignored `packages/control-plane/.managed-dist/` with this one-to-one upload set:

```text
teenybase.ts                         <- targets/blitzdev/teenybase.ts
worker.ts                            <- targets/blitzdev/worker.ts
core/index.ts                        <- core/index.ts
core/app.ts                          <- core/app.ts
core/runtime.ts                      <- core/runtime.ts
core/db.ts                           <- core/db.ts
core/blobs.ts                        <- core/blobs.ts
core/wire.ts                         <- core/wire.ts
core/bootstrap.ts                    <- core/bootstrap.ts
core/box-images.ts                   <- core/box-images.ts
core/cloud-init.ts                   <- core/cloud-init.ts
core/crypto.ts                       <- core/crypto.ts
core/http.ts                         <- core/http.ts
core/janitors.ts                     <- core/janitors.ts
core/oauth.ts                        <- core/oauth.ts
core/principals.ts                   <- core/principals.ts
core/registry.ts                     <- core/registry.ts
core/sessions.ts                     <- core/sessions.ts
core/types.ts                        <- core/types.ts
core/volumes.ts                      <- core/volumes.ts
core/workspaces.ts                   <- core/workspaces.ts
core/providers/types.ts              <- core/providers/types.ts
core/providers/hetzner.ts            <- core/providers/hetzner.ts
```

The emitter copies normalized TypeScript source without bundling or transpiling it, preserves the paths above, and lets the managed build perform compilation. It produces one source upload per file. Its mandatory preflight:

1. Reject a `core/**` import not starting `./` or `../`.
2. Reject a managed `worker.ts` import other than `teenybase`, `virtual:teenybase`, or relative paths; reject a config import other than type-only `teenybase`.
3. Reject any file over 1 MiB or more than 256 files. The backend enforces both limits (`backend/src/routes/project-files.ts:14-15,199-255`).
4. Print path, byte size, and SHA-256 for every output plus a release-set hash.
5. Default to `--dry-run`, which performs no HTTP mutation. `--upload --no-commit` PUTs source files only. `--commit` is a separate explicit flag and is invalid without `--upload`.

Upload source sequentially with `PUT $BASE/files?path=<path>`: relative `core/**` files first, then `teenybase.ts`, then `worker.ts`. Read the current `x-save-version` from `GET $BASE/files`, send it as `If-Match` for each PUT (use `0` only for the first mutation of a fresh project), then take the next version from the response. Inspect `result.config.ok` and `result.bundle.ok` even on HTTP 200 and stop at the first failure. These are the platform's exact save/build concurrency contracts (`blitzdev-project-agents.md:136-169`; backend implementation at `backend/src/routes/project-files.ts:199-255`). After the set is build-clean, fetch `GET $BASE/@migration`, print the proposed SQL and schema hashes, and require human review before `--commit`. Never retry a version conflict by overwriting an unknown newer version.

### 5.4 Rate-limited lazy sweeps

The hook is `teenyHono`'s `onRequest`, before control-plane route handling (`src/worker/honoApp.ts:48-55`). `core/janitors.ts` owns:

```ts
export const LAZY_SWEEP_INTERVAL_MS = 5 * 60_000;
let lastAttemptAt = 0;
let inFlight: Promise<void> | undefined;
```

`maybeScheduleLazySweep(runtime, path)` returns immediately unless the path equals/begins with one of `"/sessions"`, `"/workspaces"`, `"/volumes"`, `"/machine-types"`, `"/oauth/"`, or `"/boxes/"`, and five minutes have elapsed. It therefore excludes `/assets/`, SPA paths, teenybase `/api/` CRUD, and box-image byte routes. When eligible it sets `lastAttemptAt` before starting, reuses `inFlight` within the isolate, invokes invariant then orphan sweep, catches/logs without failing the request, clears `inFlight` in `finally`, and passes the promise to `runtime.waitUntil`. SQL remains idempotent and uses conditional updates/transactions.

The five-minute limiter is per isolate, not a global lease. There is no teenybase cron/lease primitive for managed projects and no need to create a bespoke coordination table merely to suppress harmless duplicate idempotent work. Target A uses the same hook as defense in depth and retains both exact cron triggers as the primary schedule.

### 5.5 Phase 4 cockpit file table and exact upload/serve flow

Phase 4 appends this ninth support table to `tables`. The eight domain definitions above do not change:

```ts
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
  extensions: [denyAllRules],
}
```

`allowMultipleFileRef: true` requires `idInR2` false and `autoDeleteR2Files` false (`src/types/table.ts:13-34`; validation/default handling in `src/worker/$Table.ts:121-127`). Immutable file generations also avoid the managed RPC multi-delete defect recorded as platform ask 5.

Cockpit upload is exact:

1. Build `packages/ui/dist`. Walk regular files in lexical order and form a manifest with normalized leading-slash `logical_path`, detected `media_type`, `size_bytes`, SHA-256, and one `release_id`.
2. Derive stable row id as lowercase hex SHA-256 of `"cockpit\0" + logical_path`. Read it with `GET $BASE/exec/blitz_files/view/<url-encoded-id>` using the agent token; a missing record is the insert case. The managed proxy explicitly permits `/view/:id` as a read-safe admin call (`backend/src/routes/project-exec.ts:14-23,87-143`).
3. For a missing row, send `POST $BASE/exec_write/blitz_files/insert` with `Authorization: Bearer <agent-token>`, `X-Project-Password`, and `FormData`. `@jsonPayload` is a JSON string containing `{ "values": { "id": ..., "kind": "cockpit", "logical_path": ..., "object": "@filePayload.0", "media_type": ..., "size_bytes": ..., "sha256": ..., "release_id": ..., "created_at": ... }, "returning": ["id", "object", "sha256"] }`; append the asset `File` as `@filePayload`. Do not set `Content-Type` manually.
4. For an existing row with the same hash, skip. For a changed row, send `POST $BASE/exec_write/blitz_files/edit/<id>` with `@jsonPayload` equal to `{ "object": "@filePayload.0", "media_type": ..., "size_bytes": ..., "sha256": ..., "release_id": ... }` and the replacement `File` as `@filePayload`. The standard `/edit/:id` handler treats that body as `setValues` (`src/worker/extensions/tableCrudExtention.ts:117-135`). Keep `autoDeleteR2Files: false`; never construct direct R2 writes.
5. Teenybase parses `@jsonPayload` plus numbered `@filePayload` parts (`src/worker/util/parseRequestBody.ts:6-49,83-104`), and the standard insert endpoint is `/api/v1/table/<table>/insert` (`src/worker/extensions/tableCrudExtention.ts:102-114`). Managed `/exec_write` streams the request body after validating `X-Project-Password` and injects admin authorization (`backend/src/routes/project-exec.ts:43-85,87-143,150-152`), which is the sanctioned way to bypass the table's deny-all rules.
6. After every write, read the row again through `/view/<id>` and verify logical path, returned physical `object`, SHA, and size. Do not switch the active `release_id`/manifest until all files verify.

Managed serving is a custom logical-path route because the platform does not provide an Assets binding. `/assets/*` selects `kind='cockpit'`; `/` and non-API routes select cockpit `/index.html`; API and box-image paths never fall through to the SPA. The route obtains the file with `$db.getFileObject("blitz-files/" + row.object)`, copies stored HTTP metadata, sets the manifest media type, ETag, and content length, and streams `object.body`. Hashed assets get `Cache-Control: public,max-age=31536000,immutable`; HTML gets `Cache-Control: no-cache`. The built-in teeny file route addresses table/record/file names and is not rules-aware (`src/worker/$Database.ts:1182-1207`), so it cannot implement stable cockpit URLs.

The uploader never deletes old physical objects until platform ask 5 is fixed and an audited generation-GC operation exists. This is bounded operational debt, not a hidden direct-R2 workaround.

### 5.6 Box-image-parts attempt

Use the same `blitz_files` table and upload protocol with `kind='box-image'`. Preserve the current manifest and part logical keys byte-for-byte. The stable id hash input is `"box-image\0" + logical_path`; `release_id` is the immutable archive digest/tag. Upload parts sequentially, skip verified identical rows, and reselect/verify each write. Serve the existing manifest and part routes through the same logical lookup plus `$db.getFileObject` stream.

Attempt the existing prebuilt part set without changing its part size or inventing adaptive rechunking, presigned upload, direct S3 calls, or another object store. First prove the flow with a tiny fixture. Then attempt the real set and record the first exact platform response if it fails. Activate managed box-image URLs only after every manifest/part hash and size verifies. On any cap, timeout, or incomplete set, retain the immutable external public `BOX_IMAGE_REF` (GHCR) and file the/lift the managed large-object ask; do not partially switch.

### 5.7 Secrets, variables, commit, and migrations

Before source upload, verify `GET $BASE/secrets/JWT_SECRET_MAIN` reports the protected system secret exists; never print its value. Set `HETZNER_API_TOKEN` and `OPERATOR_API_KEY` with `PUT $BASE/secrets/<name>` body `{ "value": "..." }`. The backend's secret API and 8192-byte value cap are at `backend/src/routes/project-vars.ts:157-210`; protected platform-owned secret names cannot be modified (`backend/src/routes/project-vars.ts:14-25,178-180`). Set non-secret immutable references such as `BOX_IMAGE_REF`, `BOX_IMAGE_TAG`, and `BOX_IMAGE_SHA256` through the variables endpoints (`backend/src/routes/project-vars.ts:74-127`). The emitter reads values from process environment or explicit secret-file paths, redacts them, and never serializes them into `.managed-dist`, logs, manifests, or source uploads.

Managed build computes schema changes from `DatabaseSettings`, with user migration numbering beginning at 10000 (`backend/src/build/pipeline.ts:241-315`; generator behavior in `src/sql/schema/generateMigrations.ts:10-74`). Commit applies the reviewed migration atomically through `MigrationHelper`, records settings version, then snapshots/promotes the build (`backend/src/routes/projects.ts:499-520,545-732,767-834`; transaction/version behavior in `src/worker/migrationHelper.ts:25-130`). Required flow:

1. Upload source with `--upload --no-commit`; both client and server builds must be successful.
2. Fetch and archive the exact `@migration` preview. P3 stops with a preview that creates exactly the eight domain tables and their indexes. Because P3 does not commit, P4's preview on the same probe must create those eight plus `blitz_files` and all specified indexes in one migration.
3. P3 ends after step 2. In P4, human confirms the nine-table probe diff contains no drops, renames, or unexpected alterations.
4. Invoke the managed commit endpoint once with the expected source/build version.
5. Poll commit/build status; verify migration applied, active version matches, health endpoint passes, and a privileged raw smoke query sees the expected tables.
6. Only after the P4 schema commit upload cockpit/box files. Data writes never precede their schema migration.

## 6. Primitives-first audit

| Current/bespoke concern | Port decision |
|---|---|
| Direct `new Hono()` and request DB middleware | Replace with `teenyHono`; core only registers routes on its returned router. |
| Direct native D1 `prepare`, `all`, `first`, `run` | Replace with `$db.rawSQL({q,v}).run()` through the exact structural `Db`. |
| Native D1 `batch` | Replace with `$db.rawSQLTransaction([...]).run()`. |
| Cron-side native D1 adapter | Replace with `$DatabaseRawImpl(env.DB)` in Target A. |
| Ad hoc affected-row metadata | Replace with SQL `RETURNING` and raw-result length; teenybase discards D1 metadata. |
| Managed schema SQL/migration runner | Replace with `DatabaseSettings`, teeny's generated migration preview, commit, and `MigrationHelper`. |
| Target A live migration management | Keep Wrangler migrations temporarily; teeny CLI cannot safely infer a baseline for the existing D1, so switching now would violate cutover safety. |
| Direct R2 reads | Use native R2 as the core structural `BlobStore` in A and `$db.getFileObject` in B. |
| Managed R2 writes/object naming | Replace with `$Table` file fields through `/exec_write`; retain a row mapping logical to generated physical names. |
| Target A static-file route | Replace with Wrangler `[assets]` and SPA fallback. |
| Managed static-file route | Keep a small custom logical lookup/stream route because the managed platform has no Assets binding; storage itself remains teenybase file fields. |
| Managed scheduled janitors | Use teenyHono `onRequest` plus `waitUntil` and a per-isolate rate limit; no managed scheduled primitive exists. |
| Session bearer-cookie protocol | Keep custom. Teeny auth is a table-user JWT system and does not match operator session hashes, device grants, box access/refresh families, or current wire contracts. |
| OAuth device authorization state machine | Keep custom for the same protocol-compatibility reason; it still uses teeny raw transactions. |
| Hashing, random tokens, timing-safe comparison | Keep Web Crypto helpers; teenybase has no compatible domain-token primitive. |
| JSON/body/cookie/status response conventions | Keep the existing minimal domain HTTP helpers behind structural context types; behavior and size limits are public API contracts, not an alternate web framework. |
| Hetzner lifecycle/provider calls | Keep custom behind `providers/types.ts`; teenybase has no infrastructure-provider primitive. |
| `@blitzos/schema` runtime/type imports | Replace with relative local wire definitions plus an out-of-core drift test because managed source cannot install npm dependencies. |
| Box-image manifest/parts protocol | Keep the protocol because boxes consume it; replace only storage/read implementation with file fields/getFileObject. |
| Managed secret persistence | Replace manual source/env embedding with `$BASE/secrets`; use vars for non-secrets. |
| Cross-isolate sweep lock | Do not add one. No fitting primitive exists, and duplicate idempotent sweeps are safer than bespoke coordination state. |

## 7. Phase execution plan and gates

### P2 — core extraction plus Target A

Files created:

- `packages/control-plane/core/index.ts`, `app.ts`, `runtime.ts`, `db.ts`, `blobs.ts`, `wire.ts`, `bootstrap.ts`, `box-images.ts`, `cloud-init.ts`, `crypto.ts`, `http.ts`, `janitors.ts`, `oauth.ts`, `principals.ts`, `registry.ts`, `sessions.ts`, `types.ts`, `volumes.ts`, `workspaces.ts`, `providers/types.ts`, `providers/hetzner.ts`
- `packages/control-plane/teenybase.ts`
- `packages/control-plane/test/db-contract.test.ts`, `core-imports.test.ts`, `wire-drift.test.ts`

Files changed/removed:

- Rewrite `packages/control-plane/src/worker.ts` and `src/index.ts`.
- Remove the migrated duplicate domain files enumerated in section 4.4.
- Update `packages/control-plane/package.json`, root lockfile, `tsconfig.json`, `wrangler.toml`, `worker-configuration.d.ts`, `README.md`, `test/env.d.ts`, `test/helpers.ts`, `test/apply-migrations.ts`, `test/bootstrap.test.ts`, and `test/control-plane.test.ts` only where imports/runtime construction require it.
- Leave `packages/control-plane/TODO.md` and `vitest.config.ts` unchanged.
- Leave `packages/control-plane/migrations/0001_initial.sql` byte-identical.

Gates before deploy:

1. Existing 23 tests green plus the three new contract tests.
2. Typecheck green; `core-imports.test.ts` proves every `core/**` import is relative.
3. Migration file SHA-256 equals its pre-P2 hash.
4. Cockpit production build green; `wrangler deploy --dry-run` green with the Assets configuration.
5. Local/miniflare smoke covers API-first routing, SPA fallback, native R2 box image, both scheduled callbacks, and lazy-sweep error isolation.
6. After staged deploy, all 9 existing end-to-end checks green. No Target B work begins from a regressed core.

### P3 — Target B emitter and upload dry-run

Files created:

- `packages/control-plane/targets/blitzdev/teenybase.ts`
- `packages/control-plane/targets/blitzdev/worker.ts`
- `packages/control-plane/scripts/build-blitzdev.mjs`
- `packages/control-plane/test/blitzdev-schema.test.ts`
- `packages/control-plane/test/blitzdev-emitter.test.ts`

Files changed:

- `packages/control-plane/package.json`, root lockfile only if dependency/script changes require it, and repository `.gitignore` for `packages/control-plane/.managed-dist/`.

Gates:

1. Generated schema snapshot matches the existing migration: eight domain tables, all constraints/indexes, no ninth table yet, and deny-all rules on every table.
2. Import allow-list, 1 MiB/file, 256-file, deterministic manifest, and secret-redaction tests green.
3. Local teeny config validation and migration generation green.
4. Against a disposable managed project, `--upload --no-commit` yields successful client/server builds and an `@migration` preview containing exactly the expected creates. Dry run is the default.
5. Do not invoke `--commit` in P3. Preserve the eight-table preview and build evidence for P4; existing core and Target A gates remain green.

### P4 — cockpit assets in both pipes and box-image attempt

Files changed:

- Append `blitz_files` to `packages/control-plane/targets/blitzdev/teenybase.ts`.
- Extend `packages/control-plane/targets/blitzdev/worker.ts` with the managed blob adapter and cockpit/box logical serving routes.
- Extend `packages/control-plane/scripts/build-blitzdev.mjs` with asset manifest, multipart insert/edit, verify, and box-image attempt subcommands.
- Finalize `packages/control-plane/wrangler.toml` `[assets]` configuration and `src/worker.ts` Target A routing if P2 smoke found a precedence issue.
- Update `worker-configuration.d.ts`, `package.json`, lockfile, and the Phase 4 tests only as required. UI source remains unchanged unless a real same-origin path bug is proven.
- Add `packages/control-plane/test/assets.test.ts` and `box-image-files.test.ts`.

Gates:

1. Target A serves hashed UI assets and SPA deep links while every API prefix reaches the Worker; cookies and same-origin requests work in a browser.
2. Managed P4 migration preview on the uncommitted P3 probe creates the eight domain tables plus `blitz_files` and all declared indexes, with no drops/alters. After explicit review, the disposable probe commit and health/raw-table smoke pass before data upload.
3. Multipart insert, replacement/edit, row verification, logical lookup, `getFileObject`, ETag/content type/cache headers, missing-file behavior, and SPA/API precedence pass against a disposable managed project.
4. A browser can load and use the cockpit against both Target A and Target B.
5. Tiny box fixture passes end-to-end. The real immutable part set is attempted once; all parts verify before activation, otherwise the external immutable reference remains active and the exact platform failure is attached to ask 3.
6. All P2/P3 tests, current 23 tests, and current 9 end-to-end checks remain green.

## 8. Blockers and platform dependencies

No constraint blocks P2 or the P3 source/schema upload dry run; P3 performs no commit. P4 may commit the reviewed nine-table migration to the disposable probe solely to validate file-field integration. Production promotion of Target B has one determinism blocker: the managed gateway/build currently resolves the latest teenybase bundle rather than the project-recorded version (platform ask 4). There is no atomic way for the emitter to pin what commit and runtime will load, so a production Target B commit waits for that lift; version observation and post-commit smoke tests are evidence, not a substitute for pinning.

P4 serving is implementable with immutable file generations. Safe replacement cleanup is blocked by the managed R2 RPC single-key/multi-key delete mismatch (platform ask 5), so `autoDeleteR2Files` stays false and no GC runs. Large box-image ingestion remains an explicit capability attempt governed by existing ask 3 and never blocks the cockpit or control-plane cutover.
