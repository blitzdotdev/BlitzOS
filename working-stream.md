# BlitzOS — Working Stream

**My working notes — agent self-continuity, not a handoff doc.** For *me* to keep state across context compactions: current state, decisions + rationale, exact contracts, open threads, next actions, and the commands I use. Terse + operational + dense on purpose. I update it as I work and re-read it on resume. Last touched 2026-06-05.

---

## TL;DR — where I am

BlitzOS / "Agent OS" = an Electron macOS infinite-canvas spatial desktop of **surfaces** an AI agent drives. Earlier this session: a new **server mode** (deployable browser+backend: headless Chromium per web surface, streamed to a canvas, CDP-controlled), a teammate merge, security blockers fixed, robust process mgmt. Live at **https://agentos.blitzmen.com**. **LATEST (2026-06-05): the widget system is BUILT + verified end-to-end in a real browser + adversarially reviewed (8 findings fixed).** Agents now browse/spawn/fork/author sandboxed `srcdoc` widgets backed by the user's OAuth integrations, over a consent-gated `window.blitz` bridge. Next: server-mode audit majors (browser-host.mjs), then deploy.

## Run it

```bash
cd packages/BlitzOS
bash preview/start-all.sh            # restart (clean) — live at https://agentos.blitzmen.com
bash preview/start-all.sh stop       # kills everything incl. headless Chromium
bash preview/start-all.sh status
```
Server mode default (`BLITZ_SERVER_MODE=1`, Chromium auto-detected at `/usr/bin/chromium`). Backend **:8799** (NOT 8787 — wrangler's default; the other agent runs the relay there). Vite :5174. Hard-refresh the tab after restart (shim is page-cached → re-mints the agent URL). Recipe + one-time tunnel setup: `preview/RUNNING.md`.

## Three run modes

1. **Electron desktop** — the real app (`npm run dev`, macOS only). `src/main/*` + React renderer. Can't run here (needs a display).
2. **Browser preview** — Vite renderer + Node backend (`preview/`) + cloudflared tunnel. Web surfaces = empty frames (no `<webview>` in a browser).
3. **Server mode** (NEW) — each `web` surface is a **server-side headless Chromium** top-level target (bypasses X-Frame-Options), streamed to a `<canvas>` via CDP `Page.startScreencast`, controlled via the shared CDP vocabulary. The VPS-deployable path. **Fully testable here** (headless Chromium, no display needed).

## Decisions log (so I don't relitigate)

- **CDP (`webContents.debugger` / raw CDP), not `WebContentsView`, for web surfaces.** Verified: CDP is the only mechanism with trusted input (`isTrusted`), no same-origin requirement, AND off-screen reach. `WebContentsView` is a native overlay positioned by `setBounds` → can't honor the `#world` CSS transform → breaks the canvas. (`<webview>` stays for Electron; server uses a streamed `<canvas>`.)
- **Server mode = top-level Chromium target per web surface.** A `Target.createTarget(url)` is an address-bar navigation, so framing headers (X-Frame-Options / frame-ancestors) never apply — recovers exactly what the plain-browser iframe/webview path can't do. JPEG screencast ~4–12 fps (paint-gated); fine for forms/reading/agent-watching, not smooth video.
- **Widgets = `srcdoc` + a bridge, NOT compiled `native` React.** An agent must be able to read/fork/author widgets at runtime → they must be source (HTML/JS), which only `srcdoc` gives. `native` (compiled React) stays only for built-in chrome primitives (note). See "Widget system" below.
- **`claude-mono`** (`claude-mono (1).md`, gitignored) = a broader cloud-SaaS "run a whole startup with AI employees" vision. **Parked** ("ignore Claude Mono"). Different deployment model than BlitzOS (local/desktop); shares the integrations + agent-as-operator thesis only.
- **agent-socket** is the user's own relay project (separate repo `packages/agent-socket`, github `blitzdotdev`). BlitzOS is one consumer. The other agent owns agent-socket now.

## Architecture + key files

- **Surface model** — `src/renderer/src/components/SurfaceFrame.tsx`, `store.ts`. Kinds: `web` (Electron `<webview>` / server `<canvas>`), `app` (`<iframe>` first-party, same-origin), `srcdoc` (sandboxed iframe of agent-authored HTML — no network/same-origin), `native` (React component by name, e.g. `note`/`NoteWidget`). Store `mode` ('desktop'|'canvas'); preview forces `canvas` (App.tsx effect: `if serverMode setMode('canvas')`). Descriptor: `{id, kind, x, y, w, h, z, title, url?, html?, component?, props?}`.
- **Shared control core** — `src/main/control-core.mjs` (+ `.d.mts`): transport-agnostic CDP vocabulary over a `{send(method,params)=>Promise}` session. Functions: `evaluate, dispatchClick, clickSelector, KEYMAP/pressKey, typeText(perKey), read, screenshot`, and `controlSession(session, action)` returning `{ok,result?}|{ok:false,error}`. Electron adapter = `cdp.ts` `ElectronCdpSession` (wraps `webContents.debugger.sendCommand` + lazy attach/idle-detach). Server adapter = `browser-host.mjs` `session(id)` (CDP over the DevTools WS).
- **Server mode files** — `preview/backend.mjs` (`BLITZ_SERVER_MODE`): HTTP + SSE `/api/os/events` (agent actions to renderer) + `/api/os/stream` WS (screencast frames out, input in) + OAuth + agent-socket session + `reconcileSurfaces`. `preview/browser-host.mjs` (headless Chromium + CDP-over-WS). `preview/agentos-shim.js` (browser `window.agentOS`). `vite.renderer.preview.mjs` (injects `__BLITZ_SERVER_MODE__`, proxies `/api` with `ws:true`, target `:${BACKEND_PORT||8799}`).
- **Agent transport** — agent-socket relay (paste a URL into any chat, no MCP). Tools in `agentSocket.ts` (Electron) + `backend.mjs` OS bridge (server). Backend's `OS_AGENTS_MD` ships the calling-instructions preamble (the relay also prepends one now).

## Tool contracts (the 9 agent-socket tools)

All POST `$BASE/<tool>` (JSON body). `$BASE` = paste-URL minus `/agents.md`.
- `create_surface {kind, x?,y?,w?,h?,title?, url?(web/app), html?(srcdoc), component?,props?(native)}` → `{id}`. Server mode: web kind also creates the host target directly.
- `open_window {url, x?,y?,w?,h?,title?}` → `{id}` (web shortcut; server creates target).
- `move_surface {id, x, y}` → `{ok}`.
- `update_surface {id, html?,props?,url?,title?,x?,y?,w?,h?}` → `{ok}` (broadcasts `os:action {type:'update', patch}`; server navigates the host target on `url` change).
- `close_surface {id}` → `{ok}` (server closes the host target + disposes context).
- `go_to_primary` → `{ok}`.
- `list_state` → `osState` (`{surfaces:[{id,kind,x,y,w,h,title,url}]}`, pushed by the renderer via `sendState`).
- `read_window {id}` → `{result:{title,url,text}}` — **safe DOM read only** (the `script` param was REMOVED — it was an eval bypass; see audit).
- `surface_control {id, action:{action:'click'|'type'|'key'|'read'|'screenshot', selector?,x?,y?,text?,perKey?,key?}}` → web surfaces only; server mode. **`eval` action is rejected over the relay** (localhost-bearer only).

SDK handler return shape gotcha: a return with no numeric `status` is wrapped as HTTP 200 → map failures to `{status:4xx, body:{error}}`; success returns `{result}`/`{image}`/`{text}`/`{ok}`.

## `window.agentOS` surface (shim ↔ preload parity — keep in sync!)

The renderer calls these; the browser shim (`agentos-shim.js`) MUST mirror the Electron preload (`src/preload/index.ts`) or the renderer crashes (that's the onMetaTap bug). Required methods: `serverMode`(bool), `mountServerSurface`, `serverNavigate`, `serverReload`, `onAction`, `sendState`, `onAgentSocketUrl`, `registerWebview`, `unregisterWebview`, `reportWebview`(electron-only→shim no-op), `onMetaTap`(electron-only→shim no-op returning unsub), `integrations.{list,connect,disconnect,openExternal,onUpdated}`. **When the teammate adds a preload method, add a shim equivalent.** `mountServerSurface(canvas, surfaceId)` opens the stream WS, draws JPEG frames, forwards pointer/wheel/key as CDP (`Input.*`), `stopPropagation` so it doesn't pan the canvas.

## browser-host.mjs internals (the audit majors live here)

- `CdpClient(wsUrl)`: `send(method,params,sessionId?)` id-correlated via a `pending` Map; `onEvent(cb)`; `_msg` routes replies by id, events to handlers. **Only `once('open')/once('error')` — no persistent close/error drain (audit major #2).**
- `startBrowserHost({onFrame, chromiumPath})`: spawns chromium (`--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --remote-debugging-port=0 --user-data-dir=<mkdtemp blitz-chrome-*>`), parses stderr for the `ws://…` DevTools URL, connects `CdpClient`. On `Page.screencastFrame`: **ack first** (`Page.screencastFrameAck`) then `onFrame(surfaceId, base64jpeg, metadata)`. **`child.on('exit')` only inside the startup promise — no supervisor (major #3).**
- Returns: `createSurface(id,{url,width,height,quality})` = `Target.createBrowserContext` → `createTarget` → `attachToTarget({flatten:true})` → `Page.enable` → `Page.startScreencast({format:jpeg,quality,maxWidth,maxHeight})`. **`surfaces.set` runs after 3 awaits → `has()` false during creation → race + leak (major #1); no try/catch → partial-failure leak (major #5).** `closeSurface(id)` = `closeTarget` + `disposeBrowserContext`. `session(id)` → `{send:(m,p)=>client.send(m,p,sessionId)}`. `has/ids/navigate(id,url)/stop()`.

## Integrations data (for widgets)

Tokens: `preview/.tokens.json` (gitignored). Shape `{provider:{provider,label,secrets:{access_token,...},connectedAt}}`. Read token = `rec.secrets.access_token`. **Connected:** discord (palash, **65 guilds** verified), gmail, github, jira (slack not configured).
- discord guilds: `GET https://discord.com/api/v10/users/@me/guilds` (Bearer) → `[{id,name,icon,owner,...}]`; icon URL `https://cdn.discordapp.com/icons/{id}/{icon}.png`.
- github repos: `GET https://api.github.com/user/repos?sort=updated` (needs `User-Agent`).
- gmail/jira: more API shape work (gmail messages = list+get; jira needs `cloudId`+`siteUrl` from `secrets`).
- **NOTE:** I designed a `GET /api/integrations/:provider/:resource` route + a `PROVIDER_DATA` registry but did NOT add it (pivoted to the bridge after the alignment chat). Build it as the bridge's data backend.

## Widget system — BUILT (full loop verified in a real browser, 2026-06-05)

**The "agent OS" thesis, working:** agents browse a library, read/fork widget source, spawn them, OR author new ones at runtime — all backed by the user's connected integrations, over a consent-gated bridge. Verified e2e (headless Chromium + real relay): spawn discord-servers → consent overlay → Allow → 73 real Discord guilds render in the sandbox; author via save_widget → appears in library; code-swap re-prompts consent.

**Pieces (all built):**
1. **Shared catalog** `src/main/widget-catalog.mjs` (+`.d.mts`) — ONE source of truth for BOTH transports (mirrors control-core.mjs). `listWidgets/getWidgetSource/saveWidget`, the **closed** `PROVIDER_DATA` registry (`discord/guilds`, `github/repos`) + `fetchProviderResource(provider,resource,token)` (10s timeout, 5MB cap, own-property guard), and `WIDGET_AUTHORING_MD`.
2. **Library** `widgets/` — `widgets.json` manifest + `discord-servers.html` + `github-repos.html` (builtin, tracked). Authored widgets → `widgets/authored/` (gitignored). Each uses `window.blitz`.
3. **Bridge** `src/renderer/src/widget-bridge.ts` (`BRIDGE_SHIM`, the injected `window.blitz`: `data/tool/props/onProps/ready`, per-instance nonce reqId) + `SurfaceFrame.tsx` srcdoc branch (ref + shim-injected srcDoc + `onLoad` init + `window 'message'` listener authenticated by **`event.source===iframe.contentWindow`**). Consent overlay + per-generation local consent gate.
4. **Data + consent (server)** `preview/backend.mjs` — `GET /api/integrations/:provider/:resource?surface=ID` (closed registry, **consent-gated per (surface,provider)**, rate-limited), `POST /api/os/consent`, `POST /api/os/consent/revoke`, `GET /api/widget-authoring.md`. Consent pruned on close + revoked on code-swap.
5. **Tools (both transports)** — `list_widgets, get_widget_source, spawn_widget, save_widget, list_integrations, get_widget_authoring`. Server in `backend.mjs`; Electron in `agentSocket.ts` (+`widgets.ts` ipc `widget:req/consent/consent:revoke` via tokenStore Keychain, `dropConsent` from osActions on close). OS_AGENTS_MD + AGENTS_MD have a `## Widgets` section.

**Security model (post-review, 8 findings fixed):** token NEVER crosses into the widget (only normalized `{items}`). **srcdoc surface ids are server-minted** (agent can't pick one to inherit a grant). Consent is keyed `(surfaceId,provider)`, **revoked when html changes** (renderer clears a per-generation `consented` set → new code re-prompts; deterministic, not race-dependent) and **pruned on close**. Bridge replies are **window-checked** (`postRes` only delivers to the issuing `contentWindow`) so a reload can't cross-deliver. Closed `PROVIDER_DATA` (own-property lookup) = no SSRF. Rate-limited + size-capped + timed-out fetches.

**Not yet done (widget follow-ups):** generic consent-gated `op:'fetch'` escape-hatch so an authored widget can hit a NOT-yet-registered provider/resource without a backend edit (today PROVIDER_DATA is the closed allowlist — discord/guilds, github/repos only); a CSP on the srcdoc iframe to block data egress (defense-in-depth; deferred — the data is already user-consented); more provider resources (gmail messages, jira issues).

## Verify commands I use (re-runnable)

- **Status/up:** `bash preview/start-all.sh status`; `curl -s -o /dev/null -w '%{http_code}' https://agentos.blitzmen.com/`.
- **Get the live paste URL:** `curl -s http://127.0.0.1:8799/api/os/agent-url` → `{url}`; `$BASE = url - /agents.md`.
- **Server-mode e2e (relay):** node script — `open_window {url:example.com}` → `read_window {id}` (expect "Example Domain") → `surface_control {id,action:{action:'screenshot'}}` → `update_surface {id,url:news.ycombinator.com}` → `read_window` ("Hacker News") → `close_surface`. (Poll `/api/os/agent-url` in-process with `setTimeout` — the agent URL mints a few s after backend start; shell loops without sleep spin uselessly.)
- **Blocker re-check:** `read_window {id, script:'(document.title="PWNED")'}` must return the normal title (script ignored); stream WS `{t:'cdp',id,method:'Runtime.evaluate',...}` must NOT change the page; `{method:'Page.navigate'}` must work.
- **Renderer render check:** headless chrome via `browser-host.mjs` → `createSurface('v',{url:'http://127.0.0.1:5174'})` → `controlSession eval` → `document.getElementById('root').childElementCount` >0, `typeof window.agentOS.onMetaTap === 'function'`.
- **Real-agent test:** `claude -p "<paste-URL>; fetch it, follow it, open example.com + read the title" --dangerously-skip-permissions` (claude has Bash/curl → it POSTs the tools).
- Write throwaway node tests INSIDE `preview/` (so `ws` resolves from node_modules), run with `dangerouslyDisableSandbox`, then `rm`.

## Git state (IMPORTANT)

- **BlitzOS** — merged with origin (teammate's commits in via `4747172`). Recent local commits, most NOT pushed. **No SSH key in sandbox → the USER pushes** (`git push origin master` from their machine). Recent: `9ef28d5` working-stream expand, `777c35a` process-mgmt, `6281066` blockers, `51bfe2d` run docs, `4b92942` shim/scroll fix, `4747172` merge, `e4e876b` remote-browser.
- **WIDGET SYSTEM = COMMITTED** `52830bc`. **MERGED with teammate's autonomy kernel** `4781b47` (merged `origin/agent-runtime-moments`: `events.ts` perception→moments→wake, `/events` long-poll on both transports, page-sensor INJECT in `osActions`, `surfaceAction` callback hook, `sessionFile.ts`, `control-server` /events, App.tsx surface-action forwarding). Both halves compose: a widget's `surfaceAction` "approve" → moment → wake, + my `window.blitz` data bridge. Typecheck + full electron-vite build pass. NOT pushed (user pushes). Live demo running via `start-all.sh` → agentos.blitzmen.com (server mode; widgets work there, autonomy kernel is Electron-only so far).
- **ARCHITECTURE DOC (NEW):** `agent-os-dynamic-architecture.md` (the dynamic AI-driven OS: L1–L5 layers, perceive→reason→act loop spec, persistence/profile schema, P0–P6 roadmap, primitive-reuse table). Supersedes `agent-os-desktop-architecture.md` (pointer added). Built via a 14-agent ultracode workflow + reconciled with the user's locked decisions (see §0 of that doc).
- **agent-socket** (separate repo) — my relay fix `f5b12d2`; the other agent built on it (`preamble.ts`, task caps). Not mine to push/deploy.

## Open audit findings (we3qbpvd3; 2 blockers FIXED, majors OPEN)

**Blockers FIXED (`6281066`):** read_window-script eval bypass (→ safe read only); /api/os/stream open WS (→ cross-origin reject + Input/Page method allowlist).

**Majors OPEN (fix before relying on server mode / deploy):**
1. `createSurface` race → double-creates + leaks a Chromium target (`surfaces.set` after awaits). Fix: synchronous `inflight` Set; `has()` checks both.
2. Browser/WS death never rejects in-flight CDP → `send()`/agent request hangs forever. Fix: `_fail()` rejecting `pending` on close/error + per-cmd timeout.
3. No respawn supervisor (`child.on('exit')` only in startup). Fix: persistent exit handler clears surfaces + nulls/respawns `host`.
4. Resize not propagated (viewport/screencast pinned at create; `update_surface` only handles url). Fix: `host.resize` → `Emulation.setDeviceMetricsOverride` + restart screencast. (Clicks land fine — `toPage` rescales.)
5. `createSurface` partial-failure leaks the context (no try/catch). Fix: try/catch disposes partial + emits error.
6. Plaintext tokens (`.tokens.json`) — AES-256-GCM (`BLITZ_TOKEN_KEY`) before off-localhost.

**Minors:** `mountServerSurface` 3-arg contract lie (drop the 3rd arg + w/h effect deps — real fix = server resize #4). Per-mousemove CDP flood (throttle `onMove`).

## NEXT — priority (per `agent-os-dynamic-architecture.md` §6 roadmap + §0 decisions)

0. **P0 — close the `/events` privacy leak — ✅ DONE (Electron).** Per-surface **content-share consent** (`events.ts` `contentShared` Set + `setContentShare`/`isContentShared`/`redactMoment`/`dropContentShare`, default OFF). The **relay (untrusted)** now gates ALL 3 content egresses by `isContentShared`: `/events` redacts un-shared moments to metadata (`redactMoment`), `read_window` + `surface_control:read/screenshot` 403 `not_shared`. The **localhost control-server (trusted, where the resident brain runs) stays full**. UI: a 👁 share toggle on each web surface's title bar (`SurfaceFrame`, Electron-only via `!serverMode`) → `preload.setContentShare` → `os:content-share` IPC. Dropped on close (`osCloseSurface`). App.tsx hardening: `__blitz:navigate` requires http(s); `surfaceAction` payload capped 4KB. Typecheck + build pass. **Follow-up:** server-mode (`backend.mjs`) has no `/events` kernel so no proactive leak there, but its relay `read_window`/`surface_control` content isn't yet gated — fold into P5 server parity. Runtime behavior verifiable only via `npm run dev` on the Mac (Electron, no display here).
1. **First-milestone arc = the end-to-end vertical slice** (decided): P0 → P1 (resident loop, observe-only) → P2 (governor + consent/STOP gate, Suggest mode) → P3 (act tier: `focus`/`follow` os:action driving the built-but-unreachable `store.focusAndZoom`; new `op:'tool'` `send_reply` bridge path; agent-composed structured reads; suggested-reply context-widget). Drivable by `claude -p` over `/events` to demo.
2. ~~Widget system~~ **DONE** `52830bc`. Follow-ups folded into the roadmap: generic `op:'fetch'` escape-hatch (= the perception-framework decision), srcdoc CSP, more provider resources.
3. **Audit majors #1–#3, #5** (server-mode reliability, browser-host.mjs) — still OPEN; feed roadmap P5 (always-on reliability).
3. **Server-mode polish** — binary WS frames, DPR/zoom/scroll coord transform, off-screen fps throttle.
4. **Deployment** (parked) — `issues/open/server-mode-deployment.md` (static-serve, bind 0.0.0.0 + bearer everywhere, Docker + Caddy, then multi-tenant). Note: user said CF Access handles external auth on the tunnel, so app-layer `/api` gate is deprioritized.
5. **OS's own headless agent** — BlitzOS runs its own Claude/Codex that perceives (`list_state`/`read_window`) + acts. Now buildable.

## Widget system verify recipe (re-runnable, server mode)

Bring up backend+vite (no tunnel): two background tasks running `node preview/backend.mjs` (env `BLITZ_SERVER_MODE=1 BACKEND_PORT=8799 PUBLIC_BASE_URL=http://127.0.0.1:5174`) and `npx vite --config vite.renderer.preview.mjs` (env `BLITZ_SERVER_MODE=1 BACKEND_PORT=8799`). **Run node in the task's foreground (NO `&`)** or it gets orphaned/killed. Restart vite after editing `agentos-shim.js` (it `readFileSync`s the shim once at config load).
- **Catalog** (no server): `node` import `../src/main/widget-catalog.mjs`; `fetchProviderResource('discord','guilds', <token from preview/.tokens.json>)` → 65 guilds; `'__proto__'`/`'constructor'` → 404.
- **Relay tools + data route + consent**: `$BASE` = `GET :8799/api/os/agent-url` minus `/agents.md`; POST `$BASE/{list_widgets,get_widget_source,spawn_widget,save_widget,list_integrations,get_widget_authoring}`. Data route is backend HTTP (not a relay tool): `GET :8799/api/integrations/discord/guilds?surface=ID` → 403 w/o consent; `POST :8799/api/os/consent {surfaceId,provider}` → 200; revoke → 403; close_surface prunes; 2 rapid → 429.
- **Full bridge render** (headless chromium, auto-attach to the iframe target via `Target.setAutoAttach`): load `:5174`, spawn_widget over relay, poll for the parent's "Allow" button, `.click()` it, read the iframe session's `document.body.innerText` → guild names. Code-swap test: `update_surface {id, html:new}` → "Allow" button RE-APPEARS (consent-reuse fix). NOTE: discord rate-limits guild fetches hard after many runs (their 429 → our 502); retry with delay.

## Key docs

- `agent-os-desktop-architecture.md` — Electron-mode plan/backlog.
- `agent-os-server-mode.md` — server-mode architecture + capability matrix + verified decisions.
- `issues/open/server-mode-deployment.md` — VPS deploy checklist (parked).
- `preview/RUNNING.md` — how to run on the domain.
- `CLAUDE.md` — BlitzOS guidance (teammate-authored).

## Gotchas / lessons

- **Process mgmt:** ALWAYS use `preview/start-all.sh` (setsid groups + pidfiles). Never `nohup &` + `pkill` ad-hoc — caused recurring zombies / stale-shim / port-squat chaos all session. `pkill -f` patterns self-match shells whose cmdline contains the word; kill by exact PID or `[x]` regex trick.
- **Sandbox is musl** (Alpine): `workerd`/`wrangler dev` won't run (glibc). `ss`/`fuser` flaky. Headless Chromium at `/usr/bin/chromium` works → server mode testable here; Electron GUI is NOT (needs display) → typecheck/build only, behavior = `npm run dev` on the user's Mac.
- **Foreground `sleep` is blocked** by the harness — use `curl --retry` or in-process `setTimeout` (node), never `sleep` in a script I run via Bash.
- **Backend :8799** (8787 = wrangler default; other agent's relay).
- **No SSH key** → user pushes.
- **Tokens on the sandbox** (plaintext, gitignored), not a Keychain.
- CF tunnel hostname mapping persists on the user's CF account; token saved → next time just `start-all.sh`.
- After any restart: **hard-refresh** the tab (cached shim) + the agent URL re-mints.
