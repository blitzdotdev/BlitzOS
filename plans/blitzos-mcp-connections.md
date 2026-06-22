# BlitzOS MCP Connections — MCP as an invisible tool provenance

**Status:** Built + adversarially reviewed + live-tested (2026-06-22). The invisible surface, runtime `mcp.<domain>` discovery, the broker (DCR + PKCE + refresh), the encrypted token store, and proactive-wake are implemented and GREEN: `npm run check` (typecheck + parity + build) passes, connections 94/0, all four MCP suites pass. Two adversarial-review rounds (13 findings) all fixed. LIVE-VERIFIED: the proactive wake moment fires for real (a `linear.app` integration moment landed in an agent's `/events` feed). NOT yet proven live: a clean end-to-end unlock → one-tap approve → MCP-data-call run (see Live findings under Provisioning).

**Goal.** A connected source's toolkit gains powerful server-side tools, and the agent never knows MCP exists. MCP is a third **provenance** inside the per-source connection tool registry you already have (alongside banked-JS and vetted tools). The agent's whole vocabulary stays `connection_list_tools` / `connection_call_tool` / `connection_save_tool`. BlitzOS is the broker (DCR + OAuth + token refresh + MCP client), purely internal. Scope is **DCR-only** providers (Notion, Sentry, Linear, ...); detection auto-filters to them.

## Decision: MCP is invisible — a third provenance in the existing registry

Today a source's toolkit has two provenances: **banked JS** (`connection_save_tool`) and **vetted-registry** tools. Add **MCP** as a third and hide the seam:
- `connection_list_tools(sourceId)` returns the **union** of all three as a flat list of `{name, description, inputSchema?}`. Provenance is never exposed.
- `connection_call_tool(sourceId, name, args)` routes internally by provenance: JS runs in the page, MCP goes through the broker with a live token. The agent can't tell which.
- `connection_save_tool` is unchanged — the agent keeps adding its own tools as it goes; the union just grows.

No `connection_connect_mcp`, no `mcp` flag, no word "MCP" in the doctrine. From the agent's POV a source simply *has a toolkit* it lists, calls, and extends. This is the clean realization of "a connection is a per-source TOOL PROVIDER" — MCP is just one more provider feeding that registry.

Why invisible (vs the earlier explicit `connection_connect_mcp`):
- **Agents don't get confused / don't fall back to `claude mcp add`.** They only know one toolkit vocabulary. (The live failure on 2026-06-22 was exactly this: with MCP exposed, the agent reached for its native `claude mcp add` and hit the mid-session no-hot-reload wall.)
- **One uniform surface**, agent-authored and BlitzOS-provisioned tools side by side.
- Still headless + sidesteps Claude's OAuth bugs (the agent never configures a server or sees a `WWW-Authenticate`).

## Proven live (the backend rests on facts)

- **DCR self-registration** (2026-06-22): BlitzOS POSTed Notion's `registration_endpoint` and got a `client_id`, no pre-registration, no user interaction.
- **Authorize + PKCE + exchange + refresh**: the probe ran the full loopback flow and minted/refreshed tokens.
- **Upstream MCP client** (streamable HTTP `initialize` → `tools/list` → `tools/call`, `mcp-session-id` + SSE/JSON): the probe called real tools; the built broker test passes 6/6 against live public MCP servers.
- **Detection signal**: an endpoint's `/.well-known/oauth-protected-resource<path>` → `authorization_servers` + `scopes_supported`; the AS metadata's `registration_endpoint` is the DCR discriminator (Notion has it; Google's `accounts.google.com` does not).
- **Why DCR-only**: Google-class servers (no DCR) additionally gate data ops behind full Google app **verification** (raw Drive API tolerates an unverified app, the `drivemcp` gateway does not). Deferred until BlitzOS ships a verified app; the broker already supports it later (swap DCR for a pre-registered client).
- **Stale fact**: Notion's `/mcp` now requires a token even for `initialize` (was unauth) — so the tool list can only be fetched AFTER approval (see the constraint below).

## Backend (invisible) — keep what we built

`src/main/mcp-broker.mjs` (BlitzOS as MCP client + auth owner): `dcrRegister`, two-phase `startLoopback`/`armAuthorize`, `exchangeCode`, `refresh`, `mcpInitialize/mcpListTools/mcpCallTool` (session + SSE/JSON). `src/main/mcp-detect.mjs`: the cascade (well-known → curated map → protected-resource confirm → AS-metadata DCR filter) + TTL cache + SSRF guard. Token store `src/main/mcp-token-store.mjs`: `<workspace>/.blitzos/mcp/<safeSourceId>/tokens.json`, encrypted via `safeStorage`, refresh-token reuse, boot rehydrate. All three already built, tested, and adversarially reviewed; they stay as-is, just stop being agent-visible.

## The unified tool registry (the core change)

A tool descriptor carries an INTERNAL `provider: 'js' | 'vetted' | 'mcp'` the agent never sees:
- js / vetted: `{name, description, kind:'read'|'act', code}` (existing per-source `tools.json`).
- mcp: `{name, description, provider:'mcp', endpoint, mcpName, inputSchema}` — no code; routed to the broker. Cached after a post-auth `tools/list` at `<workspace>/.blitzos/mcp/<safeSourceId>/tools.json` (sibling to the token file).

- **`connection_list_tools(sourceId)`** → returns `{ tools: [{name, description, inputSchema?}], unlock?: [...] }`. `tools` is the merged USABLE set: banked-JS + vetted + cached-MCP (only the authed ones). On a name collision across provenances, prefer MCP (server-side, robust) and drop the JS duplicate. Provenance is never exposed.
- **Lockable integrations — the affordance, crystal clear.** When a source has a DETECTED official integration that is NOT yet authed, `connection_list_tools` ALSO returns it under `unlock`, e.g. `unlock: [{ source:'linear.app', label:'Linear', prompt:'Approve Linear access to unlock its tools' }]`. So the agent always sees, for a source: its usable tools, PLUS a short "these unlock after a one-time account approval" note. The agent can then proactively offer it ("I can connect your Linear for full access — approve?") or just reach for the capability and let `needsApproval` pop the card. It NEVER sees "MCP" — only a source that has tools and an optional account it can unlock. After approval the integration's tools move into `tools` and its `unlock` entry disappears. (A source can be usable via JS today AND have a richer integration to unlock — both show at once.)
- **`connection_call_tool(sourceId, name, args)`** → look the tool up, route by `provider`: js/vetted run in the page (unchanged); mcp → `liveToken` (refresh if expired) → `mcpCallTool` → return the REAL result honestly (incl. `isError`, capped by `READ_CAP`). If the MCP tool is not authed, or a refresh 401s, return a connection-level `{ needsApproval:true, source, prompt:'Approve <Source> access' }` (never the word MCP/OAuth) which pops the approval card.
- **`connection_save_tool`** → unchanged; bank JS tools as before. The union grows.

## Provisioning + the one human step (a connection-level account approval)

The OAuth consent can't be removed, but it stops being "MCP" and becomes a normal account approval:
- **Trigger.** When a source with a detected official integration is connected (or first listed), BlitzOS surfaces a one-time card: "Let BlitzOS use your <Source> account?" (account-access wording, no MCP/OAuth jargon). Also lazily: a `needsApproval` from `connection_call_tool` pops the same card.
- **Proactive wake — DO NOT rely on the agent polling (the Figma lesson, 2026-06-22).** Detection is an async network probe, so the `unlock` affordance can miss a freshly-connected source's FIRST `connection_list_tools` (a real failure observed: Agent 46 connected `www.figma.com`, listed tools before detection landed, saw no `unlock`, and just drove the WebGL canvas — it never knew the integration existed). Fix (DONE in `connectionBind`): when detection LANDS a lockable integration for a connected source, BlitzOS emits a connection **moment** that wakes the connecting agent (verb: "has an official integration — connection_unlock to unlock its tools"), so discovery never depends on a re-poll. The synchronous cache still feeds `unlock` on later lists. (Note the secondary lesson: Figma's MCP is read/Dev-Mode and can't draw a shape, so even surfaced, "make a circle" correctly uses the canvas — exercise the unlock flow with an MCP-suited task like a Notion search or Linear issues.)
- **Live findings (2026-06-22 relaunch test).** With the new build running, the proactive moment FIRED for real: `connection has an official integration — connection_unlock { sourceId: 'linear.app' }` landed in an agent's feed. But no agent completed the end-to-end flow yet, for two reasons that are NOT mechanism bugs: (1) **heavy concurrency rate-limiting** — ~10 agents running at once produced 600+ Anthropic "temporarily limiting requests" errors that stalled agents mid-flow (one got the Linear moment, then immediately rate-limited and went idle); (2) **agents default to scraping** — an agent that didn't catch the moment connected Linear and drove its GraphQL API from the page instead of unlocking. Mitigation (DONE): the doctrine now says check `connection_list_tools` FIRST and prefer an official integration over driving the page (the `run_js` rule defers to it). OPEN: prove the full unlock → one-tap approve → MCP data call with a SINGLE agent on one source (no rate-limit contention).
- **On approve** → broker runs internally (DCR → loopback authorize → tokens stored) → `tools/list` → cache → the source's MCP tools now appear in `connection_list_tools`. On dismiss → no MCP tools; the agent uses the JS/browser path. After approval, refresh is silent forever.
- **Constraint (honest):** auth-gated servers (Notion) can't be tool-listed pre-auth. So detection only tells BlitzOS *that an integration exists*; approving it is what *unlocks the tools* for that source. There is no agent-facing "connect" step — the tools simply appear after the user approves.

## Discovery — resolve at RUNTIME, don't hardcode (implemented 2026-06-22)

Discovery is a runtime cascade; the first step to yield an endpoint wins, and that endpoint is then CONFIRMED (protected-resource metadata + DCR) before it is trusted, so a wrong guess is rejected:
1. **`.well-known/mcp.json`** on the origin — the standard, fully general, no data. Notion uses it.
2. **Curated EXCEPTIONS** — a MINIMAL list, only providers that neither self-advertise nor follow the convention (e.g. Sentry's MCP is on `mcp.sentry.dev`, a different TLD; GitHub is `api.githubcopilot.com`). NOT a per-site catalog.
3. **Remote registry** (`registry-server/`) — optional authoritative superset, only when `BLITZ_TOOL_REGISTRY_URL` is set.
4. **`mcp.<domain>` convention** — a runtime heuristic with ZERO curated data: guess `https://mcp.<apex>/mcp`. It is only a guess, but SAFE because the confirm step validates it.

**Why this, not a hardcoded map (the Linear lesson + the better fix):** Linear has a live, DCR-capable MCP server but does NOT self-advertise (`linear.app/.well-known/mcp.json` → 404), which made a curated map seem necessary — and the original map was stranded behind an unconfigured Worker, so Linear silently failed. But a per-site map is the wrong shape (project rule: no per-site hardcoding). The convention is the fix: probed live 2026-06-22, `mcp.<domain>/mcp` resolves a real MCP server for the majority of providers with NO per-site data — Notion, Linear, Cloudflare, Asana, PayPal, Figma, Canva, Intercom, Webflow, Wix, Neon, Prisma (13 of 22 sampled) — and a brand-new site is found the same way. Verified: `detectMcp('figma.com')` and `detectMcp('asana.com')` resolve via convention with no map entry; `x.com`/`google.com` correctly reject (the confirm step gates bad guesses). Hardcoding shrinks from "every provider" to a tiny exceptions list. Tools still come live post-auth; nothing MCP is hardcoded as a tool.

## Doctrine (`src/main/blitzos-agents.md`) — never says "MCP"

Replace the MCP-mentioning bullet added 2026-06-22 with the invisible framing: "Each connected source has a toolkit. `connection_list_tools` returns its usable `tools` AND any `unlock` integrations (a source can be usable now AND have a richer official integration to unlock). `connection_call_tool` runs a tool; `connection_save_tool` banks a new one. When you see an `unlock` entry (or a call returns `needsApproval`), OFFER it to the user in plain words ('I can connect your Linear for full access, approve?') and retry after they approve, that one tap is the only step. NEVER add tools to your own harness (no `claude mcp add` / `codex mcp` / `/mcp` / session restart)." No `connection_connect_mcp`, no `mcp` flag, no word "MCP" anywhere in the doctrine. **Strengthened 2026-06-22 (the scrape-default lesson):** the doctrine now tells the agent to call `connection_list_tools` FIRST on a connected source and PREFER an official integration over driving the page, and the "a tab is a JS world, do everything with `connection_run_js`" rule explicitly defers to an integration when one exists — otherwise agents scrape by habit (Figma drew on the canvas, Linear queried its GraphQL from the page) and never surface the `unlock`.

## Scope

- **V1 IN:** MCP as an invisible provenance; the union in `connection_list_tools`/`connection_call_tool`; the connection-level account-approval card + `needsApproval`; broker/detect/token-store internals (built); DCR-only; the integration map.
- **REMOVED from the agent surface:** the `connection_connect_mcp` tool and the `mcp` flag on `connection_list` (the op stays internal).
- **DEFERRED:** non-DCR providers (Google verified app); variant (b) local proxy with native `mcp__*`; native-app (`window`) MCP.

## Surface refactor of what we built

1. Drop `connection_connect_mcp` from `os-tools.mjs`; keep `connectMcp` as an internal op (rename e.g. `ensureMcp(sourceId)`), invoked by the connect/approval flow, not registered as an agent tool. Remove the agent-facing `mcp` flag from `connection_list`.
2. **Detection: runtime `mcp.<domain>` convention** (DONE in `mcp-detect.mjs`) — well-known → minimal EXCEPTIONS map → optional remote registry → `mcp.<apex>/mcp` convention, all validated by the protected-resource + DCR confirm. No per-site catalog (the Linear/Figma fix); `BLITZ_TOOL_REGISTRY_URL` stays an optional remote superset. And `connection_list_tools` returns `{tools, unlock}`: usable tools merged (collision-prefer MCP) + detected-but-unauthed integrations under `unlock`.
3. `connection_call_tool` (connection-ops) — route by provenance; emit `needsApproval` for un-authed MCP tools.
4. Provisioning trigger on source connect/detect + the account-approval card (island UI, connection-level wording).
5. `blitzos-agents.md` — replace the 2026-06-22 MCP bullet with the invisible framing above.
6. Tests — list_tools-merge + call_tool-routing + needsApproval (extend the built `scripts/tests/test-mcp-*` + connections test).

## Risks / watch

- Provenance collision/dedup (prefer MCP, don't show duplicates).
- Pre-auth empty toolkit: the source shows only JS tools until approved — the approval card must make the unlock obvious without the agent narrating MCP.
- `needsApproval` loop: cap re-prompts; if dismissed, fall back to JS cleanly.
- `connection_call_tool` honesty (real effect, no silent no-op) applies to MCP results too.
- Security: BlitzOS holds refresh tokens — `safeStorage` at rest, loopback-only, never logged, per workspace+sourceId.

## File touch list

- `src/main/connection-ops.mjs` — merge MCP into `connection_list_tools`; route + `needsApproval` in `connection_call_tool`; internal `ensureMcp`; provisioning-on-connect.
- `src/main/os-tools.mjs` — remove `connection_connect_mcp` + the `mcp` flag.
- `src/main/mcp-broker.mjs` / `mcp-detect.mjs` / `mcp-token-store.mjs` — built; keep (add the cached `tools.json` write if not already).
- `registry-server/` — the `sourceId → integration` map (built as `/v1/mcp`).
- `src/main/blitzos-agents.md` — replace the MCP bullet with the invisible framing.
- island UI — the connection-level account-approval card.
- `scripts/tests/` — merge + routing + needsApproval coverage.
