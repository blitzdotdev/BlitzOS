# BlitzOS session telemetry — the feedback-loop instrument

**Goal:** replay any user session as completely as possible — visually (like watching a screen
recording) and machinery-wise (every surface mutation, agent tool call, perception moment, and
error) — with the simplest, most robust moving parts. This is the data stream the improvement
loop runs on: watch sessions, mine errors, measure agent UX, run experiments, hand findings to
the next agent.

## Architecture (3 pieces)

```
BlitzOS (Electron main)                blitz.dev project `blitzos-telemetry`
┌──────────────────────────┐           ┌─────────────────────────────────────┐
│ taps ──> spool.jsonl     │  30s gz   │ worker.ts  /ingest/* (key-gated)    │
│  act    (osActions       │ ────────> │   D1: sessions/segments/frames      │
│  state   broadcast)      │  multipart│   R2: telemetry/<sid>/seg-*.gz      │
│  tool   (os-tools tap)   │           │               frame-*.jpg           │
│  moment (perception tap) │   4s jpg  │ /dash  the dashboard SPA            │
│  err    (console/process)│ ────────> │   sessions index + aggregates       │
│ capturePage JPEG frames  │           │   session replay (film + timeline)  │
└──────────────────────────┘           │   analytics (errors/builds/days)    │
                                       └─────────────────────────────────────┘
```

**Replay = the scene graph, not pixels.** BlitzOS's renderer feed is already serializable, so the
event stream IS the replay; the 4s JPEG track (window compositor includes webviews) is the visual
anchor. No video encoding, no rrweb, no in-page instrumentation.

## App side (`src/main/telemetry.ts`)

- **One line per event** into an append-only local spool (crash-safe by construction):
  `act` every `osActions.broadcast` (surface mutations, chat, terminal output — the renderer's
  entire feed) · `state` throttled ~20s compact layout keyframe (os:state push) · `tool` every
  tool call on every transport (`setToolTap` in os-tools.mjs — the instrument() wrapper) ·
  `moment` every perception moment, snapshot dropped (`setMomentTap` in perception-core.mjs) ·
  `err` console.error/warn + uncaughtException/unhandledRejection · `boot`.
- Spool rotates to an outbox at 512KB; every 30s the uploader gzips segments → `/ingest/segments`
  with per-type counts + first error excerpts computed at ship time (no spool state), and ships
  4s deduped `capturePage` JPEGs (1100px, q55) → `/ingest/frames`. Order preserved; on failure it
  stops and retries next tick. Outbox capped at 300MB (oldest dropped loudly).
- **Enablement:** ONLY when `~/.blitzos/telemetry.json` exists (`{url, key}`); `BLITZ_TELEMETRY=0`
  kills it. No config file = off (the default for users until consent UX exists).
- 8KB per-line cap (a huge chat thread can't bloat the stream); frames skipped while hidden;
  identical frames not re-shipped; telemetry can never throw into the app.

## Backend (repo sources `telemetry/{teenybase.ts,worker.ts}` — infra as code)

The deployed blitz.dev project is REPRODUCIBLE from this repo: `scripts/telemetry-push.mjs`
(PUT files + commit + secrets via the project agent API; creds in `~/.blitzos/telemetry-project.json`,
never committed). The previous project was lost to the 12h anon TTL — sources now live here so
that can never cost more than one push. **Claim the project to stop the TTL.**

- Tables `sessions` (sid unique + running aggregates: events/errors/tools/frames/segs/t0/t1),
  `segments` (sid, seq, t0/t1, lines, errn, counts, errs, R2 key), `frames` (sid, t, key).
  ALL CRUD rules deny; every route in worker.ts gates on the `INGEST_KEY` secret
  (header `x-ingest-key` or `?k=`) then elevates `db.auth.superadmin`.
- `/ingest/sessions|segments|frames` (multipart `values` JSON + `file`), `/dash/data`,
  `/dash/sdata/:sid`, `/seg/:id` (raw gz; client inflates via DecompressionStream),
  `/frame/:id`, `/ping`. Counter bumps are SQL-side arithmetic (rawSQL, parameterized).
- `/dash` — single-file vanilla SPA: sessions index w/ totals; per-session replay (filmstrip
  player w/ play/scrub/speed/arrow keys + synchronized, filterable, searchable event timeline —
  click an event to seek the film); analytics (errors+volume by build, sessions/day, recent
  errors across sessions). HTML is public; every data call is key-gated.

## Verification (run after any change)

- `node scripts/telemetry-verify.mjs` — 17-check synthetic battery: gate/403, upsert, segment+frame
  ingest, counter aggregates, byte-perfect R2 roundtrips, dash data routes. All green 2026-06-11.
- Real e2e (2026-06-11): dev boot with taps live → sessions appeared in `/dash/data` with
  events/tools/errors/frames; replay reconstructed boot/state/act/err streams from gz segments;
  dashboard verified rendering REAL data headlessly (Chrome `--dump-dom`): index totals, session
  rows, filmstrip img + 337 act/8 tool/13 moment/4 err timeline entries.
- The first real capture immediately demonstrated the loop: the error stream surfaced a
  MaxListenersExceededWarning (`did-stop-loading` listeners, webcontents-view-host) worth a look.

## teenybase/blitz.dev API lessons (hard-won, keep)

> The full platform contract + operational runbook lives in `plans/blitz-dev-api-contract.md` —
> this section is the telemetry-relevant subset.

- Runtime config validation is STRICTER than save-time build: every table needs `extensions: []`
  even when empty, and **the runtime uses the COMMITTED config** — schema/config changes need
  `POST /commit` (which also runs `@migration.sql`); code-only worker changes go live on save.
- `$Table.select(data)` returns a **plain array** (`{items,total}` only with `countTotal=true`).
  `insert({values})` — caller mints `id` (`crypto.randomUUID()`). `view(id, opts)` does NOT take
  an options object. File-FIELD machinery is buggy on custom routes — use text key columns +
  `putFileObject(key, bytes)` (private but callable) / `getFileObject(key)` → stream `.body`.
- `secretResolver.resolve('$NAME')` for secrets; `ADMIN_SERVICE_TOKEN` is locked — mint your own
  secret and elevate `db.auth` yourself after checking it.
- Cloudflare 403s `python-urllib` UA on the app domain — set any custom User-Agent.

## The `user_say` syscall (test-rig input path)

`POST /user_say {text, session?}` on the **localhost transport only** (403 over the relay):
enters a chat message through the exact same path as the human composer
(`osUserMessage`: appendChat('user') + emitUserMessage + brain spawn). Exists so a co-located
test agent can drive BlitzOS as a real user (the VM rig's missing input path — Electron exposes
no AX windows in the VM, so OS-level keyboard injection is impossible). An external agent must
never be able to forge user input; hence the transport gate, same trust model as raw eval.

## Live endpoints

- Dashboard: `https://blitzos-telemetry.app.blitz.dev/dash` (key required; ingest key doubles as
  view key for now)
- Device config: `~/.blitzos/telemetry.json` `{url, key}`; key also at `~/.blitzos/telemetry-ingest.key`
- Project agent creds: `~/.blitzos/telemetry-project.json` (anon-create response; claim to persist)

## Next (loop tooling)

- A `scripts/telemetry-pull.mjs` analysis CLI (sessions → merged event log → grep/stats) for
  agent-side data science without the browser.
- Real consent UX + privacy story before any non-dev install ships with a config file.
- Auth split: per-viewer dashboard keys (today the ingest key is the view key).
- True scrub-replay: feed recorded acts into the server-mode renderer for a pixel-free rebuild.
