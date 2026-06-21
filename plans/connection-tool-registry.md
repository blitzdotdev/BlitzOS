# Connection Tool Registry — a first-party, server-hosted library of vetted per-source tools

> Status: PLAN (no code yet). Decided direction (Palash): a **registry server we control**, holding **manually
> vetted** per-source tools. The agent **queries** it, gets the tool JSON, and **adds it to its own
> `tools.json`** — it is **not directly executable from the registry**; execution always goes through the
> existing effect-verified `connection_call_tool`. **No community tier** right now — only tools our team vetted.

## Why
When the agent connects a tab/window it can already bank reusable per-source scripts in
`<workspace>/.blitzos/connections/<safeSourceId>/tools.json` (keyed on the site host / app bundle id — see
the per-source tool store in `connection-ops.mjs`, and the doctrine in `blitzos-agents.md`). But every agent on
every machine starts each new source from a blank `tools.json` and re-derives the same operations (read Gmail's
unread count, archive the top email, read a Google Doc's text…). A shared library of **known-good** snippets
lets the agent start from a vetted tool instead of re-deriving — faster, more reliable, and the selectors are
ones we've tested.

## What it is (the decided shape)
- A **registry service we host and control** (not bundled-local, not peer-to-peer). It stores vetted tools
  keyed the same way `tools.json` is — by `sourceId` (origin host for tabs, bundle id for windows).
- Each registry entry is the **same shape** as a `tools.json` entry plus provenance:
  `{ name, description, kind:'read'|'act', code?(tab JS) | steps?(window recipe), sourceId, version, contentHash,
    vettedBy, vettedAt }`.
- The agent **queries** the registry (by `sourceId` + optional intent), **chooses** an entry, and **writes it
  into its own `tools.json`** through the normal save path. From then on it is an ordinary saved tool, run via
  `connection_call_tool` (effect-verified). **The registry is a source of candidates, never an execution path.**
- **First-party only.** Every entry is authored/curated and vetted by us. No community submission, no auto-import
  of third-party code. (This is the single biggest safety lever — see Safety.)

## Prior art (grounding — full sourced report in the research that produced this doc)
- **Userscript libraries are the closest analog** — Greasy Fork / OpenUserJS are **host-keyed**
  (`/scripts/by-site/<host>`), exactly our `sourceId` keying, with tens of thousands of per-site JS scripts.
  We adopt the host-keyed model but **reject their trust model** (open community submission + reactive-only
  moderation) in favor of first-party vetting.
- RPA marketplaces (UiPath certification tiers; Power Automate review) and the **Anthropic MCP registry**
  (namespace-ownership verification) show the curated/verified end of the spectrum we're aiming at.
- Across all ecosystems studied, **scale and review depth are inversely correlated** — nobody has both. We
  deliberately choose depth (manual vetting) over scale (community), at least initially.

## Sourcing the tools (how we populate it)
1. **LLM-generate → effect-verify → human-vet.** Generate a candidate `code`/`steps`, run it through the
   existing effect-verified `connection_act`/`connection_call_tool` against a live site, keep only tools that
   produce the expected effect, then a human reviews before publish. This is BlitzOS's natural advantage — we
   already have a live connector + effect verification.
2. **Seed from Mind2Web** (CC BY 4.0; 137 real sites, 2000+ tasks with stored selectors/actions) and possibly
   WebLINX (larger; verify its data license separately). These convert into per-site read/act tools with
   attribution. The API corpora (ToolBench ~16k APIs) are NOT useful — they're REST/function-calling, no DOM.
3. Start narrow: hand-vet the **top ~20 sites** the agent actually touches (Gmail, Google Docs/Sheets/Slides,
   GitHub, Calendar, Notion, Slack, Linear/Jira…), then widen.

## Selector rot is the dominant maintenance cost
Site DOMs drift; selectors silently break. (~half of Mind2Web's tasks expired within ~2 years.) So:
- Registry tools are **self-healing candidates, not frozen artifacts.** The existing `{stale:true}` signal is
  the detection trigger; pair it with an **LLM-reauthor → effect-verify** loop.
- Prefer durable anchors — **role / visible text / `data-testid`** over brittle nested CSS chains (Playwright's
  locator guidance; self-healing approaches report 60–80% less maintenance).
- A stale-report path from clients can feed our vetting queue (which tools are breaking in the wild), so we
  refresh the registry proactively. (Aggregate signal only — see Safety re: not phoning home page content.)

## Safety model (the reason for every constraint above)
A per-source tool is **JavaScript that runs inside the user's logged-in session**, as the user, on the real
origin. The research is unambiguous: **every major supply-chain disaster** (The Great Suspender 2M; Cyberhaven
2.6M — stole cookies+session tokens; RedDirection 2.3M — shipped clean then a malicious *update*; postmark-mcp —
one added BCC line; the Waze userscript credit-card scraper) came through **exactly this model: distributing
executable code that runs in an authenticated context.** And the usual defenses are weak here: signing proves
*origin not safety*; sandboxing scopes *where* not *what damage on an allowed origin*; review is bypassed by the
*update channel*; "verified/rated" badges create false trust. **No ecosystem has solved untrusted code in a
logged-in session.** So our safety rests entirely on **never accepting untrusted code**:

- **First-party vetting is the trust boundary.** Only our team's reviewed tools enter the registry. No community
  tier. This is what makes copy-into-`tools.json` acceptable here when it is catastrophic elsewhere.
- **The registry is a candidate source, never an execution path.** Retrieved tools land in `tools.json`;
  execution always goes through `connection_call_tool` (effect-verified) — the user/agent stay in the loop.
- **Content-hash + version pinning.** Each entry carries a `contentHash` + `version`. A saved tool records the
  hash it came from; if the registry later changes that tool, the agent re-fetches deliberately (re-vetted),
  never a silent swap (defeats the rug-pull pattern, e.g. CVE-2025-54136). No silent auto-update.
- **Tool `description` is untrusted text** to the LLM (the tool-poisoning vector) — sanitize/flag
  instruction-like content even though we authored it, to keep the discipline.
- **We host it, so we control distribution + can revoke.** A bad/regressed tool can be pulled or flagged
  server-side; clients check the registry rather than caching forever.

## Integration with what exists (no new architecture, mirrors `connection_*`)
New tools added once in `os-tools.mjs` (`makeOsTools(ops)`), bound on all three transports like the existing
`connection_*` tools:
- `connection_registry_search { sourceId? , query? }` → vetted entries for that host/app (and/or intent match),
  returning `{ name, description, kind, version, contentHash, vettedBy }` (NOT auto-saved, NOT executed).
- `connection_registry_get { sourceId, name }` → the full entry incl. `code`/`steps` for the agent to inspect.
- The agent then `connection_save_tool`s the chosen entry into its `tools.json` (optionally a thin
  `connection_registry_add` convenience = get + save, marked with `version`/`contentHash`/`source:'registry'`)
  — still landing as an ordinary saved tool, run later via `connection_call_tool`.

Doctrine update (`blitzos-agents.md`): extend the reuse-first toolkit guidance — *before deriving from scratch,
check local `connection_list_tools` AND `connection_registry_search`; prefer a vetted registry tool; only derive
when none fits.* (Builds on the reuse-first + branch-don't-clobber doctrine already added.)

The registry server itself: a controlled HTTP endpoint (standalone, or alongside the relay infra). Stores
entries by `sourceId`; supports host lookup + optional intent search (text / embeddings over name+description).
Auth: read access for connected BlitzOS clients; write access internal-only (our vetting pipeline).

## Locked decisions (build pass 1)
- **Server home: a CLOUDFLARE WORKER** (`registry-server/worker.mjs`) — same infra family as the agent-socket
  relay. Built as **one router core + two thin transports** (no parallel impl): the Worker for prod, a Node http
  server (`registry-server/server.mjs`) for local dev, both binding the SAME `registry-core.mjs` + vetted
  `registry-data.mjs`. Client base URL is configured via `BLITZ_TOOL_REGISTRY_URL` (the deployed Worker domain;
  for local dev, `wrangler dev` on `http://127.0.0.1:8787` or the Node server on `http://127.0.0.1:7700`). Unset
  → the registry tools return a clear "not configured" error (never a hard failure).
  - Data ships **bundled in the Worker** from the `tools/*.json` seeds (no KV/D1/R2) — redeploy IS the
    internal-only write path. `contentHash` is computed with **Web Crypto** (`crypto.subtle`) so it is identical
    in Node and Workers with no compat flags.
- **Auth: OPEN READ.** Vetted tools are first-party and non-secret; any connected client can read. WRITE is
  internal-only (our vetting pipeline / the seed files) — not exposed to clients.
- **Sequencing: CONTRACT-FIRST.** The HTTP contract below is the single spec; the client tools are built against
  it and the Worker (+ the Node dev server) implement exactly it (`registry-server/`).
- **Search: host-exact to start** (we already have the `sourceId` key); `q` (intent) is accepted and may be a
  no-op substring match in pass 1, upgraded to embedding search later — same contract.
- **Surfacing: agent-only first** (the agent pulls vetted tools); a user-facing "browse the toolkit" island UI
  is later.
- **Versioning: saved copies are PINNED** by `contentHash`; the agent re-fetches deliberately, and the natural
  re-fetch trigger is a `{stale}` failure. No silent auto-update.

## HTTP contract (v1) — the single spec for client + server
Base URL = `BLITZ_TOOL_REGISTRY_URL`. All client calls are **GET, open read, JSON responses.**

- `GET /v1/tools?sourceId=<host|bundleId>&q=<intent?>`
  → `200 { sourceId, entries: [{ name, description, kind, sourceId, version, contentHash, vettedBy, vettedAt }] }`
  — **metadata only, NO `code`/`steps`** (discovery is cheap; bodies are a second, deliberate fetch).
- `GET /v1/tool?sourceId=<host|bundleId>&name=<name>`
  → `200 { entry: { name, description, kind, code?(tab) | steps?(window), sourceId, version, contentHash, vettedBy, vettedAt } }`
  → `404 { error }` when absent.
- `GET /v1/health` → `200 { ok: true }`.

`contentHash` = `sha256` of the canonical `code`/`steps` body (the pin a saved tool records). `version` is a
monotonic string per (sourceId,name). `vettedBy`/`vettedAt` are provenance shown to the agent/user.

## Client tools (added once in os-tools.mjs, bound on all 3 transports)
- `connection_registry_search { connection?|sourceId?, query? }` → resolves the sourceId (from a live `connection`
  or an explicit `sourceId`), returns `{ sourceId, entries }` (metadata only — never executes).
- `connection_registry_get { sourceId, name }` → `{ entry }` (full, incl. code/steps) for the agent to inspect.
- `connection_registry_add { connection?|sourceId?, name }` → get + write into `tools.json` (upsert by name),
  stamped `{ source:'registry', version, contentHash }`. Guard: the entry's `sourceId` must equal the target.
  It lands as an ordinary saved tool — run later via the effect-verified `connection_call_tool`, never directly.

Risk note: `connection_registry_add` writes only FIRST-PARTY VETTED code, and execution still flows through
`connection_call_tool` — so it is strictly safer than the already-open `connection_save_tool` (which writes
arbitrary agent-authored code). No extra transport gate beyond what `save_tool` has.

## Verified seed tools + a known-hard case (from a live Google Docs run, 2026-06)
- **`docs.google.com` `rename_doc(title)` — VERIFIED, vetted.** Sync-DOM: set `.docs-title-input` value + commit
  with Enter; `document.title` reflects the committed name. Full registry path verified on a live Doc:
  `registry_get → registry_add → call_tool` renamed in ~0.3s (vs the agent's minutes doing it ad-hoc).
- **`share_doc` is NOT shippable as a pure-JS tool — deliberately omitted.** Evidence from the live Doc: (1) the
  Share dialog's email field renders in a **cross-origin iframe** (`clients6.google.com/static/proxy`), so page
  JS can't reach it; (2) the Drive API (`googleapis.com`) returns **403** with cookies — no OAuth token, and
  BlitzOS is browser-first with no OAuth subsystem by design; (3) Safari `do JavaScript` is **synchronous** —
  can't `await fetch` even if a token existed. So sharing a Doc is a genuine **computer-use** task (real clicks
  into the cross-origin iframe), inherently slower — not a registry-tool gap to paper over with a fake snippet.
  (Chrome's extension path can `await fetch`, but still has no Drive token, so it hits the same 403 wall.)

## Still open (later passes)
- **Stale-report telemetry:** do clients report `{stale}` tool ids back to our vetting queue? (Aggregate id +
  version only — never page content — to respect the no-phone-home-of-user-data posture.)
- **Sub-type granularity / `appliesTo`:** the registry is host-keyed like `tools.json`, so Docs/Sheets/Slides
  share `docs.google.com` — entries use the distinct-name variant convention (`read_text_sheets`) and could
  carry an `appliesTo` URL/path hint once that field exists.
- **Embedding/intent search**, and the **user-facing browse UI**.
