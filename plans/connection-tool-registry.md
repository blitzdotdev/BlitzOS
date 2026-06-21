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

## Open questions / decisions for later
- **Search:** host-exact only (free — we already have the key) to start, or add intent/embedding search now?
- **Server home:** standalone registry service vs part of the existing relay/control infra?
- **Agent vs user surfacing:** agent-only (the agent silently pulls vetted tools) — or also a user-visible
  "browse the toolkit" UI in the island? (Default: agent-only first.)
- **Refresh/versioning UX:** when a registry tool the agent saved gets a new vetted version, notify + re-fetch
  on next use, or leave saved copies pinned until a stale failure? (Default: pinned; re-fetch on stale.)
- **Stale-report telemetry:** do clients report `{stale}` tool ids back to our vetting queue? (Aggregate id +
  version only — never page content — to respect the no-phone-home-of-user-data posture.)
- **Sub-type granularity:** the registry is keyed on host like `tools.json`, so Docs/Sheets/Slides share
  `docs.google.com` — registry entries should use the same distinct-name variant convention (`read_text_sheets`)
  and carry an `appliesTo` hint if/when we add that field.
