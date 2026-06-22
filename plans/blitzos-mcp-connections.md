# BlitzOS MCP Connections — prefer official MCP over injected JS

**Status:** Researched + live-verified (2026-06-22). NOT implemented. Awaiting go.

**Goal.** When a connected source (a web tab today) has an official MCP server, the agent should use it instead of injected JS. Injected JS is fragile on JS-hostile sites (Google Docs canvas, Trusted-Types pages); the site's own MCP is clean, server-side, and uses real OAuth. We can't predict which site a user connects, so detection must be general (no per-site code in core).

**Key decision: BlitzOS does NOT host an MCP client.** Both supported harnesses (Claude Code, Codex) ship their own MCP client that takes a remote server by URL and runs the OAuth themselves. BlitzOS already spawns and controls those processes, so its job is install + auth-trigger + reload. No MCP client, no token store, no dynamic tools in `os-tools.mjs`. The MCP tools live in the harness as native `mcp__*` tools, not as BlitzOS connection tools.

## Verified live (evidence)

- **Detection signal is rock-solid.** Hitting any remote MCP endpoint unauthenticated returns a uniform RFC 9728 signal. Confirmed identical on Notion, Sentry, Linear:
  `HTTP 401` + `www-authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.<host>/.well-known/oauth-protected-resource/mcp"`. The `oauth-protected-resource` doc then returns `authorization_servers`.
- **Detection verified live end-to-end against Google (2026-06-22).** Simulated the agent opening Drive/Gmail/Calendar/Docs/Sheets cold: each `sourceId` resolved via the directory map to a LIVE Google MCP endpoint, confirmed by its protected-resource metadata. Live Google first-party servers: `drivemcp`, `gmailmcp`, `calendarmcp`, `docsmcp`, `sheetsmcp`, `slidesmcp`, `chatmcp` (all `*.googleapis.com/mcp/v1`); `people/tasks/meet/forms/keep` 404. `x.com` correctly fell through to no-MCP. Map refinement: point `docs.google.com`→`docsmcp` and `sheets.google.com`→`sheetsmcp` (dedicated servers with `documents`/`spreadsheets` scopes), the exact JS-adversarial sites this whole feature targets.
- **Two auth classes (setup cost differs).** Notion-class = Dynamic Client Registration + self-advertised `.well-known/mcp.json` = zero-setup, `add` then approve. Google-class = NO public DCR (`accounts.google.com` exposes no `registration_endpoint`) = needs a PRE-REGISTERED OAuth client (id/secret). So for Google-class providers BlitzOS must ship its own Google-verified OAuth client (as Anthropic does for the claude.ai connectors) or walk the user through a GCP client. This is the main real-world friction, and it is per-provider, not per-site. **Google end-to-end VERIFIED 2026-06-22:** a self-made GCP **Desktop** OAuth client (testing mode, self as test user) + `claude mcp add --client-id/--client-secret` → `/mcp` Authenticate → connected, authenticated, 8 Drive tools against `drivemcp.googleapis.com/mcp/v1`. Desktop client type is REQUIRED (loopback redirect on any port/path); a Web client fails the exact redirect-URI match. (This covers connect + auth + tools-list ONLY; Google data CALLS are blocked by a verification gate, see CALL-level below.) Product implication: BlitzOS ships its own Google-verified OAuth client so users skip the GCP setup entirely. Google adds one more developer-side gotcha: each service is gated behind enabling ITS api in the backing Cloud project (e.g. `drivemcp.googleapis.com` must be Enabled, separately from `gmailmcp`, `docsmcp`...), though ONE OAuth client covers all of them. BlitzOS absorbs both the client and the per-API enablement by owning the project. None of this exists for non-Google (Notion-class) providers. **CALL-level: TWO gates found (2026-06-22, direct token probe).** **Gate 1 (fixed):** the raw Drive API returned `403 SERVICE_DISABLED service=drive.googleapis.com consumer=projects/118090436804` because the project had only the gateway API (`drivemcp.googleapis.com`) enabled, not the product API (`drive.googleapis.com`); enabling `drive.googleapis.com` made the RAW Drive API return files. So each Google MCP needs BOTH the `*mcp` gateway AND the product API enabled. **Gate 2 (the real blocker):** the MCP GATEWAY still returns "caller does not have permission" for EVERY data op (search/list/get) with EVERY scope (full `drive`, `drive.readonly`, `drive.file`), with a fresh token, even after switching the OAuth app Testing→Production, while the raw Drive API accepts the exact same tokens. Ruled out by direct test: API-enablement, scope, quota-project (`x-goog-user-project`), resource-binding (Google ignores `resource`), propagation, per-file access, and publishing status. The only remaining variable is Google app **VERIFICATION/approval**: the raw Drive API tolerates an unverified app (test-user warning), but the Drive MCP gateway refuses data ops for an unverified, self-made consumer OAuth app. Working paths: a Google-VERIFIED app (the claude.ai connector works precisely because Anthropic's app is verified), a Workspace **Internal** app (skips verification), or BlitzOS shipping its OWN verified Google app. **TAKEAWAY for BlitzOS:** for Google-class providers, ship a verified app or use the agent's native verified connector; a from-scratch user OAuth client can use the raw Drive API but NOT Google's MCP gateway for data ops. **Native-connector path confirmed both ways (2026-06-22):** Claude Code inherits the claude.ai Google connectors (Anthropic-verified), and Codex ships native Gmail/Drive plugins (`codex plugin list` shows them; a Drive connected in ChatGPT auto-appears in Codex) riding OpenAI's verified connector. So for Google-class, BlitzOS can lean on each harness's own verified connector instead of shipping its own app, the recommended V1 path. (The MCP server flattens the real reason to "caller does not have permission", so always reproduce against the underlying API to diagnose. My earlier "drive.googleapis.com disabled = the whole fix" was only Gate 1; Gate 2 is the deeper one.)
- **Per-site `.well-known/mcp.json` works and is keyed by the tab's origin.** `https://www.notion.com/.well-known/mcp.json` → `{"name":"Notion","endpoint":"https://mcp.notion.com/mcp",...}`. `www.notion.com` IS the tab `sourceId`. Adoption is partial (Linear 404s), so it's tier-1, not the only path.
- **Official registry is a noisy seed.** `registry.modelcontextprotocol.io/v0/servers?search=notion` returns community wrappers (Smithery, mcparmory), not first-party `mcp.notion.com`. Use it as a fallback index, prefer the well-known probe + the Anthropic directory for first-party.
- **Claude Code install is clean.** `claude mcp add --transport http <name> <url> --scope local` writes `~/.claude.json` under the project key; `claude mcp get` then shows `Status: ! Needs authentication` (it detects the 401). OAuth is interactive (browser), tokens → macOS Keychain.
- **Codex install is ROUGH (must work around).** `codex mcp add --url <url>` writes the `[mcp_servers.X]` TOML block but then BLOCKS on server validation (it needs OAuth) and never returns — had to `kill -9` twice. So BlitzOS must NOT shell `codex mcp add` in an unattended spawn. Write the TOML block directly, then `codex mcp login` separately. **End-to-end VERIFIED 2026-06-22** (Notion, v0.141.0, gpt-5.5): `codex mcp login` ran full OAuth (DCR + PKCE + loopback callback), and a `codex exec` turn imported the tool and called `blitz_notion/notion-search` successfully (the openai/codex #20009 "tools never import" bug did NOT reproduce). The ONLY Codex rough edge is the `add` hang, so write the TOML block.
- **Agents are BlitzOS-managed children.** `index.ts` selects only `AGENT_RUNTIME_CLAUDE` (default) / `AGENT_RUNTIME_CODEX_SERVERLESS`, launched via `prepareAgentLaunch` → `spawnTerminal` (tmux child, `cwd=workspace`, `--session-id`/`--resume`). BlitzOS owns cwd, env, argv, restart. So install + reload is always possible for in-island agents. An external agent over agent-socket = suggest-only fallback.

## Flow

1. **Detect** (per connected source, cached per `sourceId` with TTL):
   a. Probe `https://<sourceId>/.well-known/mcp.json` (and the apex if it's a subdomain). 200 → take `endpoint`.
   b. Miss → look up `sourceId` in BlitzOS's curated map (the registry Worker, seeded from the Anthropic directory).
   c. With an endpoint, fetch its protected-resource metadata at `<origin>/.well-known/oauth-protected-resource<path>` → `authorization_servers` + `scopes_supported` (the universal needs-auth + auth-discovery + scopes signal). Do NOT rely on a 401 alone: Google's endpoint 200s on a bad `initialize` yet still serves the PRM.
2. **Surface.** `connection_list` gains `mcp: { available, endpoint?, needsAuth?, installed?, authed? }`.
3. **Ask.** Agent `ask`s the user ("Notion has an official integration. Connect it? It's cleaner than driving the page.").
4. **Install** (BlitzOS, backend-specific — see below), on yes.
5. **Auth.** The harness runs OAuth (browser); BlitzOS surfaces the browser (it drives it anyway); user approves; harness stores the token.
6. **Reload.** Claude: restart-resume the tmux process so it loads the new server. Codex-serverless: next `codex exec` turn reads config.toml, no restart.
7. **Prefer.** Doctrine: once a source has native `mcp__*` tools, use them over `connection_run_js`.

## Per-backend install mechanics

- **Claude Code:** `claude mcp add --transport http <name> <endpoint> --scope local` (writes `~/.claude.json` under the workspace project), OR write a project `.mcp.json` in the workspace. Then restart-resume (`--resume <sid>`, keeps context). OAuth fires on first MCP call (the 401) → browser. No hot reload, so the restart is required.
- **Codex:** write `[mcp_servers.<name>]\nurl = "<endpoint>"` to the workspace `.codex/config.toml` DIRECTLY (do not shell `codex mcp add`, it hangs). Then `codex mcp login <name>` for OAuth. codex-serverless reads config each turn, so no restart. VERIFY tools actually import (issue #20009).

## What BlitzOS owns vs the harness

- BlitzOS owns: detection (probe + curated map), the `mcp` field on connections, the ask, the per-backend install (config write), the restart-resume, the doctrine. New agent tool, e.g. `connection_connect_mcp { connId | sourceId }` → does the install + reload for the active backend and returns status.
- The harness owns: the MCP client, the OAuth flow, token storage (Keychain / codex). BlitzOS holds NO MCP tokens — less secret-handling liability.

## Detection map (registry Worker)

Extend the existing vetted Worker (`registry-server/`) with a `sourceId → { endpoint }` map, seeded from the Anthropic Connectors Directory + the official registry. Data, not code, so no per-site hardcoding in core (same pattern as `registry-data.mjs`). The live `.well-known` probe is tier-1; the map covers sites that don't self-advertise yet.

## Risks / must-verify before ship

- **Codex end-to-end — RESOLVED (verified 2026-06-22).** Direct TOML write + `codex mcp login` + tool import + a real `notion-search` call all worked (v0.141.0/gpt-5.5); #20009 did not reproduce. Remaining rule: never shell `codex mcp add` (it hangs), write the TOML block.
- **Claude end-to-end — VERIFIED 2026-06-22.** `/mcp` → Authenticate → browser approve → `blitz-notion connected, 17 tools`. OAuth + import confirmed.
- **Restart-resume mid-task** keeps context AND loads the new server (claude). Verify.
- **Browser OAuth surfaces** where the user can approve inside BlitzOS.

## Scope

- **v1 IN:** web tabs (`sourceId = host`), detection cascade, `connection_list.mcp`, the ask, Claude install (clean) + Codex install (TOML-direct + login), restart-resume, prefer-MCP doctrine.
- **DEFER:** native-app/window MCP (bundle ids, mostly stdio), large-scale auto-seeding of the map, any BlitzOS-hosted client (not needed).

## Files to touch

- `src/main/connection-ops.mjs` — detection + enrich `connectionList` with `mcp`.
- `registry-server/` — curated `sourceId → endpoint` map + query endpoint.
- `src/main/os-tools.mjs` — `mcp` field on `connection_list`; new `connection_connect_mcp`.
- `src/main/agent-runtime.mjs` + `index.ts` — per-backend install + restart-resume; per-agent config path (`.mcp.json` / `.codex/config.toml` in cwd, or `CLAUDE_CONFIG_DIR`).
- `src/main/blitzos-agents.md` — doctrine: prefer MCP over `run_js`; the ask/install flow.
- `scripts/tests/` — detection cascade + codex-write-direct.
