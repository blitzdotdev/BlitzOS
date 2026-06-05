# BlitzOS — Working Stream

**My working notes — agent self-continuity, not a handoff doc.** For *me* to keep state across context compactions: current state, decisions + rationale, exact contracts, open threads, next actions, and the commands I use. Terse + operational + dense on purpose. I update it as I work and re-read it on resume. Last touched 2026-06-05.

---

## TL;DR — where I am

BlitzOS / "Agent OS" = an Electron macOS infinite-canvas spatial desktop of **surfaces** an AI agent drives. This session's big build was a new **server mode** (deployable browser+backend: headless Chromium per web surface, streamed to a canvas, CDP-controlled), plus merging a teammate's work, fixing security blockers, and making process management robust. Live at **https://agentos.blitzmen.com**. Immediate next: the **widget system** (design locked below, not built). Multi-agent audit found 2 blockers (FIXED) + majors (open).

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

## Widget system — build-ready design (NEXT, do this)

**Goal:** a library of widgets the user's agents browse, read the source of, instantiate, OR author new ones at runtime — backed by the connected integrations. The "agent OS" thesis.

**Pieces:**
1. **Widget library** — a registry of `srcdoc` widget definitions (source available). Store as files, e.g. `preview/widgets/<name>.html` + a manifest (`widgets.json`: `[{name, description, needs:['discord'], props?}]`). Agent tools: `list_widgets` → `[{name,description,needs}]`; `get_widget_source {name}` → html; instantiate via existing `create_surface {kind:'srcdoc', html}` (or a `spawn_widget {name, props}` convenience that reads the library + creates the surface).
2. **OS↔widget bridge** — `srcdoc` is sandboxed (no fetch/network), so widgets get data via `postMessage`: widget → parent `{type:'blitz:req', reqId, op:'data', provider, resource}` or `{op:'tool', tool, args}`; the renderer (SurfaceFrame `srcdoc` branch) relays to the backend (`fetch('/api/integrations/'+provider+'/'+resource)` or a tool route) and posts back `{type:'blitz:res', reqId, ok, data|error}`. **Consent gate:** first data/tool request per (widget, provider) prompts the user (BlitzOS holds the tokens; the widget never sees them).
3. **Data backend** — add `GET /api/integrations/:provider/:resource` to `backend.mjs` with a `PROVIDER_DATA` registry returning normalized `{items:[{label, sub?, icon?, badge?, url?}]}` (discord/guilds, github/repos to start). Reads `.tokens.json`.
4. **Agent flow:** `list_widgets` → `get_widget_source` (read code) → `create_surface srcdoc` (instantiate) OR author a new srcdoc using the bridge → `update_surface` to evolve it live.

**First slice to build:** (a) the bridge in `SurfaceFrame.tsx` srcdoc branch + the shim plumbing; (b) `/api/integrations/:provider/:resource` data route; (c) a `discord-servers.html` srcdoc widget that uses the bridge; (d) `list_widgets`/`get_widget_source` tools (both transports). Keep it `srcdoc`-based so it's agent-readable + forkable. Add a consent gate.

## Verify commands I use (re-runnable)

- **Status/up:** `bash preview/start-all.sh status`; `curl -s -o /dev/null -w '%{http_code}' https://agentos.blitzmen.com/`.
- **Get the live paste URL:** `curl -s http://127.0.0.1:8799/api/os/agent-url` → `{url}`; `$BASE = url - /agents.md`.
- **Server-mode e2e (relay):** node script — `open_window {url:example.com}` → `read_window {id}` (expect "Example Domain") → `surface_control {id,action:{action:'screenshot'}}` → `update_surface {id,url:news.ycombinator.com}` → `read_window` ("Hacker News") → `close_surface`. (Poll `/api/os/agent-url` in-process with `setTimeout` — the agent URL mints a few s after backend start; shell loops without sleep spin uselessly.)
- **Blocker re-check:** `read_window {id, script:'(document.title="PWNED")'}` must return the normal title (script ignored); stream WS `{t:'cdp',id,method:'Runtime.evaluate',...}` must NOT change the page; `{method:'Page.navigate'}` must work.
- **Renderer render check:** headless chrome via `browser-host.mjs` → `createSurface('v',{url:'http://127.0.0.1:5174'})` → `controlSession eval` → `document.getElementById('root').childElementCount` >0, `typeof window.agentOS.onMetaTap === 'function'`.
- **Real-agent test:** `claude -p "<paste-URL>; fetch it, follow it, open example.com + read the title" --dangerously-skip-permissions` (claude has Bash/curl → it POSTs the tools).
- Write throwaway node tests INSIDE `preview/` (so `ws` resolves from node_modules), run with `dangerouslyDisableSandbox`, then `rm`.

## Git state (IMPORTANT)

- **BlitzOS** — merged with origin (teammate's commits in via `4747172`). Recent local commits, most NOT pushed (security, process-mgmt, docs, working-stream). **No SSH key in sandbox → the USER pushes** (`git push origin master` from their machine). Recent: `bd020a5/0d44efb` working-stream, `777c35a` process-mgmt, `6281066` blockers, `51bfe2d` run docs, `904ae22` deploy issue, `4b92942` shim/scroll fix, `fcfcc9f` post-merge parity, `4747172` merge, `e4e876b` remote-browser, `821c889` teammate merge, `28a23a7` agents.md fix.
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

## NEXT — priority

1. **Widget system** (design above — build it; start with the first slice).
2. **Audit majors #1–#3, #5** (server-mode reliability).
3. **Server-mode polish** — binary WS frames, DPR/zoom/scroll coord transform, off-screen fps throttle.
4. **Deployment** (parked) — `issues/open/server-mode-deployment.md` (static-serve, bind 0.0.0.0 + bearer everywhere, Docker + Caddy, then multi-tenant).
5. **OS's own headless agent** — BlitzOS runs its own Claude/Codex that perceives (`list_state`/`read_window`) + acts. Now buildable.

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
