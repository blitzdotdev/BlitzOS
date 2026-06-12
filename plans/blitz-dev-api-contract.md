# blitz.dev / teenybase project API — the working contract

What it actually takes to provision, deploy, and operate a blitz.dev project from an agent or
script. Every line here was paid for empirically while building the telemetry backend
(`plans/blitzos-telemetry.md`, 2026-06-11) — twice, because the first project hit the anon TTL
and was deleted with all its server-side state. Read this before touching any blitz.dev project.

## Provisioning & lifecycle

- Create (no auth, one call): `POST https://blitz.dev/api/v1/new-project/<slug>?template=empty`
  → `{project_id, agent_link, claim_url, preview_url, expires_at}`.
- **Anonymous projects are DELETED ~12h after creation unless a human claims them** at the
  `claim_url`. Deletion takes the D1 data, R2 objects, secrets, and worker with it. Two rules
  follow: (1) tell the human to claim immediately, (2) keep every source file IN THE REPO and
  deploy with a script, so a TTL loss costs one re-provision run, not a rebuild
  (see `telemetry/` + `scripts/telemetry-push.mjs` for the pattern).
- Save the anon-create JSON response somewhere durable but NOT in git (it contains the agent
  token). Convention: `~/.blitzos/<project>-project.json`.
- `agent_link` (`https://blitz.dev/agent/<token>/agents.md`) serves the per-project API doc; the
  `<token>` inside is the Bearer token for everything below.

## Per-project management API

`$BASE = https://blitz.dev/api/v1/projects/<slug>`, header `Authorization: Bearer <token>`.

- Files: `GET $BASE/files` (list), `GET $BASE/files?path=X` (read; `etag` = save version),
  `PUT $BASE/files?path=X` (raw text body) / `PATCH` (str-replace `{old_str,new_str}`) with
  `If-Match: <etag>` (use `0` for the first mutation; 409 → re-read, re-apply, retry).
- **Every save auto-builds and deploys the worker CODE immediately** — check the response's
  `result.config.ok` and `result.bundle.ok` (build errors come back HTTP 200 with `output[]`
  lines, not thrown).
- **But the RUNTIME CONFIG is the COMMITTED one.** `POST $BASE/commit {message}` promotes the
  config and executes `@migration.sql` against D1. Until you commit, schema/config changes leave
  every route failing validation (see next section) even though the code deployed. Code-only
  worker edits go live on save; anything touching `teenybase.ts` needs a commit.
- Secrets: `GET $BASE/secrets` (names only), `PUT $BASE/secrets/:name {"value": "..."}`.
- Data proxies: `GET|POST $BASE/exec/<table>/list|select|view/:id` (read, admin-injected),
  `$BASE/exec_write/...` (needs `X-Project-Password`). Full catalog: `GET $BASE/tools.json`.

## Config (`teenybase.ts`) gotchas

- Runtime zod validation is STRICTER than the save-time build: **every table must have an
  `extensions` array, even empty** (`extensions: []`). The build said `config.ok=true` while the
  deployed worker 400'd every request on this.
- `tableField(name, type, sqlType, options)` — both `type` AND `sqlType` explicit, every field.
- `baseFields` is an ARRAY — spread it (`...baseFields`), don't call it.
- Indexes: `indexes: [{ fields: ['col'], unique?: true }]` — the key is `fields`, not `columns`.
- Rules: omit the rules extension (or set rules `null`) = deny-all. `'true'` = public.

## Worker (`worker.ts`) gotchas

- `teenyHono(dbFactory)` takes ONE argument. Register extensions INSIDE the factory
  (`await db.registerExtension(new OpenApiExtension(db, true))`) — passing an extensions/options
  second argument crashes every route.
- `$Table.select(data)` returns a **plain array** of rows. `{items, total}` only when you pass
  `countTotal: true`. (`result.records` does not exist — that mistake read as "deny-all is
  blocking superadmin" and burned an hour.)
- `$Table.insert({ values })` — the CALLER mints `id` (`crypto.randomUUID()`); omitting it hits
  NOT NULL. `view(id, opts)` does NOT take an options object (it spreads strings into chars).
- Upserts / counter bumps: prefer `db.rawSQL({ q: 'UPDATE ... SET n=n+? WHERE k=?', v: [...] }).run()`
  — parameterized, and the only sane path where `$Table` can't express the query. rawSQL bypasses
  RLS; audit inputs.
- **File FIELDS (type:'file') are buggy on custom routes** (insert rollback "Failed to delete
  files"). Store plain text key columns and use the R2 accessors directly:
  `(db as any).putFileObject(key, bytesOrStream)` (private in TS, callable at runtime) and
  `db.getFileObject(key)` → `new Response(obj.body)`.
- Auth for service routes: `ADMIN_SERVICE_TOKEN` is a locked system secret you cannot read or
  set. Mint your OWN secret (`PUT $BASE/secrets/INGEST_KEY`), check it in the route
  (`await db.secretResolver.resolve('$INGEST_KEY')`), then elevate
  `db.auth = { uid: '...', role: 'superadmin', superadmin: true }` — superadmin bypasses
  deny-all rules. Same trust model as the framework's service path, your own key.
- Multipart in a custom route: `const form = await c.req.raw.formData()` — define your own field
  contract (the telemetry pipeline uses `values` = JSON string + `file` = blob).

## Operational gotchas

- Cloudflare 403s `python-urllib`'s default User-Agent on `*.app.blitz.dev` — set ANY custom UA.
  curl is fine.
- The preview URL is live after the first successful save; `?_nocache` busts its cache.
- PocketUI admin sits at `/api/v1/pocket/` (credentials in the per-project agents.md).

## The reference implementation in this repo

- `telemetry/teenybase.ts` + `telemetry/worker.ts` — a complete schema + key-gated worker with
  R2 objects, SQL-side aggregates, and a served SPA.
- `scripts/telemetry-push.mjs` — deploy script (files + commit + secrets) reading creds from
  `~/.blitzos/telemetry-project.json`.
- `scripts/telemetry-verify.mjs` — the 17-check post-deploy battery (gate, ingest, aggregates,
  byte-perfect R2 roundtrips, UI serving). Pattern to copy for any future blitz.dev backend.
