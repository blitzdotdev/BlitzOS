# Production plan (simple version)

Full test evidence: `e2e/GAPS.md`.

## Where we are

The parts work. The seams are broken.

- Control plane deploys and manages VMs correctly.
- The box image works — locally and on a Hetzner VM.
- The cockpit works end to end.
- But: a new VM never gets the box installed. The customer gets empty Ubuntu.
- And: the box never receives its credentials. Images are not downloadable. Docs drift from reality.

## The one big fix

Today, cloud-init only creates a user and pings home. Replace that ping with a **bootstrap script** that does the full job:

1. Install docker on the VM.
2. Mount the volume at `/var/lib/blitz` (state now survives destroy).
3. Pull the box image from a public registry, by digest.
4. Start the box. Give it port 22. Move the VM's own sshd to port 2222.
5. When the box is healthy, call home ourselves.
6. Save the reply (the box credentials) to disk, where the box expects it.

Why this shape: a script can read the call-home reply. Stock cloud-init cannot. That one difference is why enrollment never worked.

After this fix, "ready" means "your workspace works", and ssh goes into the box, not the VM.

Keep surfaces (terminal / chat / files) tunnel-only for v1. Hosted ingress stays closed-source. This skips the ttyd/dufs cross-origin problems instead of fighting them.

## The work, in order

**1. Bootstrap** (the fix above). Blocks everything else.
Done when `e2e/selfhost.mjs` passes all steps, including box surfaces + credentials + volume survival.

**2. Publish images.**
CI builds amd64 + arm64, pushes public ghcr, writes digests into release notes. (Today: private, and we streamed 640 MB over ssh for 4 minutes.)

**3. Harden the control plane.**
Sessions expire. Machine types filter by real availability. One `npm run deploy` command replaces the manual D1/secrets dance. Add create quotas.

**4. Ship the cockpit properly.**
Serve the ui from the same Worker (same origin = no CORS problems, ever). Make each tab say which box it talks to. Stop showing dead workspaces.

**5. Docs, CI, remaining tests.**
Fix the READMEs (paths, prerequisites, "use a dedicated Hetzner project"). Fix `smoke.sh`. Commit the fixes from the e2e run. Add e2e for: broker, volumes, failure cases, upgrades.

Steps 2–5 run in parallel behind step 1.

## Done means

1. Fresh accounts, clean machine: `selfhost.mjs` fully green.
2. Real-browser cockpit tests green in CI.
3. Broker flow tested live.
4. An agent follows the READMEs word for word and gets a working box. Zero secret knowledge.
5. Chaos run leaves zero orphan servers.

## Teenybase + blitz.dev architecture (added after discovery)

The control plane becomes a teenybase app with ONE codebase and TWO targets:

**Core** (`core/`, relative imports only, no npm): all handlers as thin functions behind two tiny interfaces — `Db` (rawSQL `{q, v}` shape; both native D1 and teenybase `$db.rawSQL` implement it) and `BlobStore`. The wire types it needs are vendored files with a drift-check test against `packages/schema`.

**Target A — self-host (own Cloudflare account).** `teenyHono()` wraps the existing routes. Keeps: native D1 + `BOX_IMAGES` R2 binding, real wrangler crons, the `/box-image/*` route, worker-first ui assets, custom domain option. First phase runs `tables: []` (runtime-only teenybase) so the live D1 is never double-created — schema ownership moves to teenybase only via a planned cutover.

**Target B — instant hosting (blitz.dev).** A build step emits `teenybase.ts` (8 tables + deny-all CRUD rules) + `worker.ts` + relative core files, uploaded via `PUT $BASE/files` (1 MB/file) + `POST $BASE/commit`. Platform facts from the probe: no crons, no WebSockets, no npm imports, no native bindings, secrets API exists, outbound fetch works, `<slug>.app.blitz.dev`, anonymous projects expire in 12 h unless claimed.

**One origin rule (both targets): the same worker serves the API and the cockpit.**

- Target A: cockpit built into worker static assets (`[assets]`, the proven v2 pattern).
- Target B: cockpit files live in the project's own R2 bucket (file-field table + one authed upload pass), streamed by an asset route via `$db.getFileObject()`. Same origin, same cookies, no CORS anywhere.
- Core hides the difference behind one assets interface with two pipes.
- Platform follow-up (we own blitz.dev): add first-class static assets to managed projects; the R2 asset route is the interim shape of exactly that feature.

Other differences handled in code, not forks:

- Janitors: lazy sweep on API traffic everywhere (rate-limited); target A ALSO keeps cron sweeps.
- Box image: target A serves `/box-image/*` from R2. Target B: attempt the same via project R2 (upload the archive parts through the file API — reuses the existing multi-part manifest mode); fall back to an external `BOX_IMAGE_REF` (ghcr) if the managed upload path caps out.
- Auth: the operator-key → opaque HttpOnly cookie flow stays custom in both targets, `SameSite=Strict` everywhere (same-origin makes that free).

Cutover safety: never point teenybase schema management at the live populated D1 without a baseline — it would generate CREATE TABLEs for existing tables.

### Implementation rules for the port (owner directive)

1. **Read teenybase properly first.** The implementing agent studies `~/superapp/teenybase` (docs/, src/, backend/) before writing code. No coding from the summary brief alone.
2. **Primitives first.** Use teenybase's own machinery wherever it fits: `DatabaseSettings` tables for target B schema, file fields + `$db.getFileObject()` for stored assets, `$db.rawSQL` for SQL, `teenyHono`, the teeny CLI for deploys. Do not build parallel bespoke machinery where a primitive exists.
3. **No hacking around platform constraints.** We own blitz.dev. When the managed platform blocks something (crons, static assets, raw large-object R2, npm policy, size caps), do NOT ship a workaround. Record it in `plans/BLITZDEV-PLATFORM-ASKS.md`: the constraint, where it lives in `~/superapp/teenybase/backend` (file:line), and the proposed lift. Implement blitz-core in the shape the lifted platform expects, degrading gracefully until the lift ships.
4. Target A's live D1 keeps the cutover safety rule regardless of primitives-first.

## Watch out for

- Hetzner capacity comes and goes (ARM was gone all day). Offer only what can actually be placed.
- The image is 640 MB. Fine for v1; slim it later.
- The test Hetzner project also holds production servers. Use dedicated projects; janitors must only touch labeled servers.
