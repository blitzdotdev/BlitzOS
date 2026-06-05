# BlitzOS — Working Stream

**My working notes — agent self-continuity, not a handoff doc.** This is for *me* to keep state across context compactions: what I'm doing, current state, decisions, open threads, next actions. Terse + operational. I keep it updated as I work and re-read it on resume. Last touched 2026-06-05.

---

## TL;DR — where I am

BlitzOS / "Agent OS" = an Electron macOS infinite-canvas spatial desktop of **surfaces** an AI agent drives. This session's big build was a new **server mode** (deployable browser+backend) plus merging a teammate's work, fixing security blockers, and making process management robust. It runs live at **https://agentos.blitzmen.com**. The immediate next task is the **widget system** (design agreed, not yet built). A multi-agent audit found bugs — the 2 blockers are fixed; several majors remain.

## Run it

```bash
cd packages/BlitzOS
bash preview/start-all.sh            # restart (clean) — live at https://agentos.blitzmen.com
bash preview/start-all.sh stop       # kills everything incl. headless Chromium
bash preview/start-all.sh status
```
Server mode is on by default (`BLITZ_SERVER_MODE=1`, Chromium auto-detected). Backend on **:8799** (NOT 8787 — wrangler's default, collides with the agent-socket relay the other agent runs). Hard-refresh the tab after a restart (the shim is page-cached). Full recipe + one-time tunnel setup: `preview/RUNNING.md`.

## Three run modes

1. **Electron desktop** — the real app (`npm run dev`, macOS only). `src/main/*` + React renderer.
2. **Browser preview** — Vite renderer + Node backend (`preview/`) + cloudflared tunnel. For demoing without the GUI.
3. **Server mode** (NEW) — each `web` surface is a **server-side headless Chromium** top-level target (bypasses X-Frame-Options), streamed to a `<canvas>` via CDP `Page.startScreencast`, controlled via the same CDP vocabulary. The VPS-deployable path.

## Architecture + key files

- **Surface model** — `src/renderer/src/components/SurfaceFrame.tsx`, `store.ts`. Kinds: `web` (Electron `<webview>` / server `<canvas>`), `app` (`<iframe>` first-party), `srcdoc` (sandboxed iframe of agent-authored HTML), `native` (React component, e.g. `note`). Store has a `mode` ('desktop'|'canvas'); preview forces `canvas`.
- **Shared control core** — `src/main/control-core.mjs` (+ `.d.mts`): transport-agnostic CDP vocabulary (click/type/key/read/screenshot/eval) over a `{send(method,params)}` session. Electron adapter = `src/main/cdp.ts` (`webContents.debugger`). Server adapter = inside `preview/browser-host.mjs` (CDP over the DevTools WebSocket, flat targets, sessionId-routed).
- **Server mode** — `preview/backend.mjs` (`BLITZ_SERVER_MODE`): OS bridge (SSE `/api/os/events` for agent actions; `/api/os/stream` WS for screencast frames out + input in), agent-socket session, OAuth integrations, `reconcileSurfaces`. `preview/browser-host.mjs` (spawn/supervise headless Chromium, per-surface targets + per-context cookie jars + screencast pump). `preview/agentos-shim.js` (browser `window.agentOS`: fetch + SSE + stream-WS; `mountServerSurface` draws frames + forwards input as CDP). `vite.renderer.preview.mjs` (injects server-mode flag, proxies `/api` incl. `ws:true`).
- **Agent transport** — agent-socket relay (paste a URL into any chat, no MCP). Tools defined in `src/main/agentSocket.ts` (Electron) and `preview/backend.mjs` OS bridge (server). **9 tools:** `create_surface`, `open_window`, `move_surface`, `update_surface`, `close_surface`, `go_to_primary`, `list_state`, `read_window`, `surface_control`.
- **Integrations** — OAuth SSO (gmail/github/jira/discord). `src/main/{integrations,oauth,tokenStore}.ts` (Electron, Keychain) + `preview/backend.mjs` (server, plaintext `preview/.tokens.json`, gitignored). **Connected but barely consumed** — only identity at connect time. This is what the widget system will use.

## What's done this session (high level)

- Explored BlitzOS; compared to the `claude-mono` vision doc (parked, gitignored — "ignore Claude Mono").
- Built the **browser preview** (fetch backend + cloudflared **named tunnel** at agentos.blitzmen.com; token saved `preview/.cf-tunnel-token`, CF dashboard maps the hostname → HTTP localhost:5174).
- **OAuth integrations** connected: gmail, github, jira, **discord** (all real; tokens on the sandbox).
- **In-window control (CDP)** — extracted the shared `control-core.mjs`; Electron `cdp.ts` adapter; adversarially reviewed + fixed.
- **Merged** the teammate's agent-socket **surface model** (base), then later their **`read_window` + `update_surface` tools + `mode` + UI** (resolved conflicts keeping everything; ported their tools into the server backend).
- **Server mode** — built + verified end-to-end (headless Chromium → screencast → canvas → CDP control), including over the tunnel and driven by a real **`claude -p`** agent (opened example.com + read the title via the tools). Made web surfaces a usable remote browser (URL bar navigates the server page).
- **agent-socket relay fix** — root-caused "AI recites agents.md instead of calling tools": the relay now prepends a canonical "how to call tools" preamble. Committed in the agent-socket repo (`f5b12d2`); **handed off to the other agent**, who built on it (added task caps, a `preamble.ts`). Not mine to push/deploy.
- **Re-synced** the preview to the surface model + agent bridge; fixed the **black-page crash** (shim missing `onMetaTap`/`reportWebview`) and **scroll** (canvas wheel/down now `stopPropagation`).
- **Ultracode audit** (33 agents) — found 2 blockers + majors. **Fixed both blockers.**
- **Robust process management** — `start-all.sh` is now `start|stop|restart|status` with setsid process groups + pidfiles (stop kills the backend's Chromium children too; no zombies). Verified 8 chromium → 0 on stop.
- Docs: `agent-os-server-mode.md` (architecture), `issues/open/server-mode-deployment.md` (deploy checklist, parked), `preview/RUNNING.md` (run recipe), this file.

## Verified working

Server-mode e2e over the live relay (all 9 tools): `open_window`→`read_window` ("Example Domain")→`surface_control` screenshot→`update_surface`→navigate→"Hacker News"→`close`. Build + typecheck green. Renderer renders (no crash). Real `claude -p` agent drives it. Both security blockers closed. Clean stop/start cycles.

## Git state (IMPORTANT)

- **BlitzOS** — many local commits; the user has pushed periodically but the **most recent ones are NOT pushed** (security blockers, process mgmt, deployment issue, run docs). **The sandbox has no GitHub SSH key — the user must `git push origin master` from their machine.** Branch is merged with origin (the teammate's commits are in via merge `4747172`).
- **agent-socket** (separate repo) — relay fix committed (`f5b12d2`); owned by the other agent now.

## Open issues — audit findings (TODO, not yet fixed except the 2 blockers)

**Blockers — FIXED (commit `6281066`):**
- `read_window {script}` was raw eval over the relay (bypassed the eval-403 guard) → now safe DOM read only.
- `/api/os/stream` WS had zero auth + forwarded arbitrary CDP → now rejects cross-origin + Input/Page-only method allowlist.

**Majors — STILL OPEN (fix before any real deploy):**
1. **createSurface race** (`browser-host.mjs`) — `surfaces.set` happens after 3 awaits, so `has()` stays false; the agent handler + `reconcileSurfaces` both pass the guard → double-creates + **leaks** a Chromium target. Fix: reserve the id synchronously (an `inflight` Set; `has()` checks both).
2. **Browser/WS death never rejects in-flight CDP** (`browser-host.mjs:25-29`) — only `once('open')`/`once('error')`; pending `send()` promises (and the agent request awaiting them) hang forever. Fix: a `_fail()` that rejects+clears `pending` on terminal WS state; per-command timeout.
3. **No respawn supervisor** — `child.on('exit')` only inside the startup promise. After a Chromium crash, `host` keeps stale surfaces → unrecoverable until manual restart. Fix: persistent exit handler that clears state + nulls/respawns.
4. **Resize not propagated** — viewport/screencast pinned at creation; `update_surface` only handles `url`. Responsive pages stay locked + the JPEG is CSS-stretched (blurry). (Clicks still land correctly — `toPage` rescales.) Fix: `host.resize(id,w,h)` → `Emulation.setDeviceMetricsOverride` + restart screencast; call from `update_surface` + a reconcile geometry diff.
5. **createSurface partial-failure leaks the Chromium context** (no try/catch) → reconcile retries forever, blank canvas, no signal. Fix: try/catch that disposes partial target/context + emits a one-time error.
6. **Plaintext OAuth tokens** (`preview/.tokens.json`) — fine behind loopback today; AES-256-GCM (`BLITZ_TOKEN_KEY`) before going off-localhost (in the deploy issue).

**Minors:** `mountServerSurface` declared 3-arg but implemented 2 (the `opts.w/h` is dropped; remove the 3rd arg + the w/h effect deps — the real fix is server-side resize #4, NOT consuming geometry in the shim). Per-mousemove CDP flood (throttle `onMove` in the shim). Full report was at `/tmp/claude-*/tasks/we3qbpvd3.output`.

## NEXT — priority order

1. **The widget system** (user-requested, agreed design — build this next):
   - **Goal:** a library of widgets the user's agents browse, read the source of, pick from, OR author new ones at runtime — backed by the connected integrations. "A proper agent OS."
   - **Primitive (important):** NOT compiled `native` React components (an agent can't read/fork/author those at runtime). Use **`srcdoc`** (sandboxed HTML/JS the agent can read + write live).
   - **Widget library** = a registry of `srcdoc` widget definitions (source available); agent tools `list_widgets` + `get_widget_source` + instantiate + fork.
   - **OS↔widget bridge** = a `postMessage` API so sandboxed widgets (which can't fetch/network) request integration data (`discord/guilds`, `github/repos`, …) or call OS tools — mediated by BlitzOS, which holds the tokens + a **consent gate**.
   - **Agent flow:** list library → read a widget's code → instantiate it, OR write a new `srcdoc` widget (using the bridge) → evolve it live with `update_surface`.
   - **First slice:** the bridge + the library registry + a Discord "your servers" widget as the first entry (srcdoc using the bridge). Note: I had started a backend route `GET /api/integrations/:provider/:resource` + verified the Discord token works (65 guilds) — but the *aligned* approach is the bridge, not a native component, so reuse the data route via the bridge, not a compiled widget.
2. **Fix the remaining audit majors** (esp. #1-#3, #5 — they affect server-mode reliability; do before relying on it).
3. **Server-mode polish** — binary WS frames (drop base64), DPR/zoom/scroll coordinate transform, off-screen fps throttle. (In the deploy issue + audit minors.)
4. **Deployment** (parked per user) — `issues/open/server-mode-deployment.md`: static-serve renderer, bind 0.0.0.0 + bearer everywhere, Docker + Caddy, then multi-tenant.
5. **The OS's own headless agent** — the arch-doc thesis: BlitzOS running its own Claude/Codex agent that perceives (`list_state`/`read_window`) + acts via the tools. Now buildable since the tool surface + server browser exist.

## Key docs

- `agent-os-desktop-architecture.md` — Electron-mode plan/backlog.
- `agent-os-server-mode.md` — server-mode architecture + capability matrix + verified design decisions.
- `issues/open/server-mode-deployment.md` — VPS deploy checklist (parked).
- `preview/RUNNING.md` — how to run server mode on the domain.
- `CLAUDE.md` — BlitzOS package guidance (teammate-authored).

## Gotchas / lessons

- **Process mgmt:** always use `preview/start-all.sh` (setsid groups + pidfiles). Do NOT `nohup &` + `pkill` ad-hoc — it caused recurring zombies / stale-shim / port-squat chaos all session.
- **Sandbox is musl** (Alpine): `workerd`/`wrangler dev` won't run (needs glibc). Headless Chromium IS available at `/usr/bin/chromium` — so server mode is fully testable here (unlike the Electron GUI, which needs a display).
- **Backend port 8799** (8787 = wrangler default; the other agent runs the relay there).
- **No SSH key in the sandbox** → the user pushes from their machine.
- **Tokens live on the sandbox** in preview/server mode (plaintext, gitignored), not a Keychain.
- The CF tunnel hostname mapping persists on the user's CF account; the token is saved → next time it's just `start-all.sh`.
