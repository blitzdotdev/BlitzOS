# CLAUDE.md — BlitzOS (agent-os)

Guidance for Claude Code working in `agent-os/`. The root repo (`../CLAUDE.md`, teenybase) rules also apply.

## What this is

BlitzOS is an Electron macOS desktop for human+agent collaboration on live **surfaces** (browser windows, post-its, blitz.dev apps, agent-authored HTML). The human drives it, and so can an AI agent over the [agent-socket](https://agentsocket.dev) relay (paste a URL / "connect to blitz os", no MCP).

**Navigation model (the infinite canvas).** Both the Electron app and the browser/server preview run on **one infinite canvas** (store `mode: 'canvas'`): free pan (drag the background / ⌘-scroll) and zoom (⌃-scroll). To tame the "desert-fog" disorientation of an unbounded plane, the human can **lock the view** — double-tap ⌘ (or the toolbar lock button): locking freezes the canvas at its current frame (pan/zoom off; a background drag becomes marquee-select) so they can work inside surfaces without it drifting, and double-tap ⌘ again to unlock. A fixed bounded **desktop** mode (`mode: 'desktop'`) still lives in the store but is **dormant** (not reachable from the UI). The canvas is also the seam for *multiple* desktops/workspaces (now shipped as folder-backed workspaces) and agent-driven **follow mode** later, where the agent moves the human's view to whatever needs it. Rationale (HCI): the infinite plane is great for the *agent* (it teleports by id, no nav cost); the on-demand lock gives the *human* a bounded frame when they want one. See `../plans/agent-os-desktop-architecture.md`.

**Agent-runtime model (why BlitzOS exists).** BlitzOS is an *OS for an agent*: it turns ANY connected agent (Claude Code today over agent-socket, any agent, a built-in chat client later) into an autonomous one with **zero per-task code**. The agent supplies intelligence; BlitzOS supplies the loop. Four parts: **syscalls** (the surface tools, the agent's hands), **perception** (a content-agnostic world stream, the agent's eyes), **a scheduler** (coalesced "moments" that *wake* the agent with a snapshot, the interrupt), and the **agent as swappable policy** (it decides significance and action). The whole point is **out-of-distribution generalization**: perception is dumb-but-rich and the agent decides what matters, so a new task (coach my chess, draft this email, summarize this PDF) needs no new BlitzOS code. **Never hand-build a per-task watch loop** — make perception and wake general, and let the agent's policy handle the task. See "Agent runtime" under Architecture.

Prototype stage; roadmap/backlog in `../plans/agent-os-desktop-architecture.md`, integration research in `../plans/agent-os-integrations-oauth.md`.

## Commands

```bash
npm run dev        # electron-vite dev (the GUI; macOS only)
npm run build      # compile main + preload + renderer to out/
npm run typecheck  # tsc --noEmit
```

There is **no display in CI / headless sandboxes**, so you cannot see the GUI. Verify behavior instead by: launching `npm run dev > /tmp/aos.log 2>&1`, then reading the log for `did-finish-load`, the printed control-API token, the agent-socket paste URL, and `[guest] loaded:` lines; and by driving the app via the control API or agent-socket tools (below) and checking `list_state`. Never claim the pixels look right, that's the user's to confirm.

## Stack & layout

electron-vite + React + TypeScript + zustand.

```
src/main/        Electron main (Node)
  index.ts         window, webview prefs, wires everything
  osActions.ts     THE control plane: create/move/close surfaces, getState. IPC to renderer.
  control-server.ts  localhost HTTP control API (local agent path)
  agentSocket.ts   connects to the agent-socket relay; tools -> osActions (remote agent path)
  cdp.ts           in-window control of `web` surfaces via CDP (webContents.debugger): click/type/key/read/screenshot
  integrations.ts  OAuth SSO registry + flows; tokenStore.ts = Keychain (safeStorage); oauth.ts = loopback code flow
  config.ts (inline in integrations.ts)  reads integrations.config.json
src/preload/index.ts   contextBridge api: onAction, sendState, onAgentSocketUrl, integrations.*
src/renderer/src/
  store.ts         zustand: transform, surfaces[], integrations[], actions
  App.tsx          desktop/canvas modes, renders surfaces + integration widgets + sidebar + toolbar
  components/SurfaceFrame.tsx  ONE frame, four renderers (web/app/srcdoc/native)
  components/NoteWidget.tsx    native 'note' = post-it
  components/{Sidebar,IntegrationWidget,ConnectPanel,PrimarySpace}.tsx
vendor/agent-socket-sdk/   vendored @agent-socket/sdk dist (see "Gotchas")
integrations.config.json   gitignored; OAuth client ids/secrets
```

## Architecture

- **Surface model (the core abstraction).** One descriptor `{id, kind, x, y, w, h, title, url?, html?, component?, props?}`; `SurfaceFrame` switches on `kind`:
  - `web` → `<webview>` (real browsing context, framing-protections don't apply; for third-party sites). Each is a full process, so use sparingly.
  - `app` → `<iframe src>` (first-party blitz.dev apps you control).
  - `srcdoc` → `<iframe sandbox="allow-scripts" srcdoc>` (agent-authored HTML; isolated, no same-origin, no backend).
  - `native` → a built-in React component by `component` name (currently `note`).
  Pick the lightest kind that fits; agent-written code must be `srcdoc` (sandboxed), never `native`.
- **Control plane.** `osActions.ts` is the single source of truth for desktop mutations. Both the **local control server** (HTTP on 127.0.0.1) and **agent-socket** call it; it sends `os:action` IPC to the renderer, which applies it to the zustand store. The renderer pushes `os:state` back so `list_state` works. The agent↔OS contract is plain HTTP/JSON, **not MCP** (deliberate).
- **agent tools:** `create_surface`, `open_window` (web shortcut), `move_surface`, `update_surface`, `close_surface`, `go_to_primary`, `list_state`, `read_window` (read a web surface's DOM), `surface_control` (act inside a web surface), `/events` (the autonomy/watch loop), plus workspace/widget/`new_app`/`say`/`customize_widget` tools. **Defined ONCE in `src/main/os-tools.mjs`** (`makeOsTools(ops)`) — the single shared registry for ALL THREE transports: Electron relay (`agentSocket.ts`) + Electron localhost (`control-server.ts`) bind it via `electron-os-tools.ts` (`electronOps` → osActions IPC+CDP); the server (`preview/backend.mjs`) binds it via `serverOps` (SSE broadcast + headless Chromium). To add/change a tool, edit `os-tools.mjs` once. agentSocket.ts mints a paste URL surfaced via the in-app "Connect AI" button. The sandboxed-widget `blitz.tool` subset is the parallel shared registry `widget-tools.mjs` (`makeWidgetToolHandlers(ops)`), bound to the same `ops`.
- **In-window control (`surface_control`).** Acting *inside* a surface routes through `osActions.osControlSurface(id, action)`, keyed on `surface.kind`: **`web`** (a `<webview>` guest) → **CDP** via `webContents.debugger` (`cdp.ts`) — the only mechanism giving trusted input (`isTrusted`), no same-origin requirement, and off-screen reach; **`app`/`srcdoc`** (iframes) → cooperative `postMessage` (planned, not wired); **`native`** → store mutation. The debugger is single-client and attached lazily, then detached on idle/close so it never locks the user out of DevTools. The renderer reports each web guest's `getWebContentsId()` on `dom-ready` (`os:register-webview`). **Security:** raw `eval` is allowed only on the localhost-bearer control server, **never over the relay** (`surface_control` rejects it).
- **Agent runtime (perception → moments → wake).** The autonomy half (see "Agent-runtime model" above). *Sensors* (`osActions.ts` `INJECT`) are injected into every web surface: input (key/click/input), **navigation**, **content change** (a `MutationObserver` — this is what catches drag interactions and async loads that fire no click), and **idle-after-activity**. A 350ms drain feeds raw signals to the *coalescer* (`events.ts`), which batches them into **moments** — framed snapshots `{trigger, signals, user[], snapshot, url, title}` — and emits one on a ~15s cadence OR immediately on a significant transition (nav / idle). `/events {since, wait}` long-polls moments; the agent runs ONE loop and is **woken** per moment, never per keystroke. Content-only churn (a running clock, an animation) refreshes the snapshot but does **not** wake the agent — only user signals do. **Generalization rule:** keep BlitzOS perception content-agnostic; the agent interprets significance and acts. No per-task detection (e.g. no "game over" logic) belongs in BlitzOS. **Transports:** agent-socket now (the agent runs the watch loop; BlitzOS drives by what it emits); a built-in chat client later gets more control (true push of turns, action gating).
- **Navigation modes (`store.mode`).** `canvas` (default, both Electron + server): the infinite pan/zoom plane — free pan (background drag / ⌘-scroll) and zoom (⌃-scroll); `PrimarySpace` marker shown; `go_to_primary` zooms-to-fit the primary region. A **view lock** (`store.locked`, toggled by double-tap ⌘ or the toolbar button) freezes the camera at its current frame: pan/zoom off, and a background drag becomes marquee-select — so the human can work inside surfaces without drift. `desktop` (dormant): a fixed bounded screen (scale 1 centered, no pan/zoom; windows z-stack, cascade, and clamp so the title bar stays on-screen); kept in the store but not reachable from the UI. The **dock** (Sidebar) + draggable **titlebar** move/focus windows in both.
- **Integrations.** OAuth SSO only (no token paste). `oauth.ts` runs a loopback authorization-code flow (system browser → `http://127.0.0.1:8723/callback` → token exchange in main → encrypted in Keychain via `safeStorage`). Each provider needs a one-time client id/secret in `integrations.config.json`.

## Gotchas / conventions

- **The SDK is ESM-only; Electron main is CJS.** So `@agent-socket/sdk` is **bundled** into main via `externalizeDepsPlugin({ exclude: ['@agent-socket/sdk'] })` in `electron.vite.config.ts`, not `require()`d. `ws` stays external.
- **The SDK is vendored** at `vendor/agent-socket-sdk/` (its own repo is `~/agent-socket`, github.com/repalash/agent-socket). To update: rebuild it (`cd ~/agent-socket/sdk && npm run build`) then re-copy `dist` + `package.json` into `vendor/agent-socket-sdk/`.
- **Never commit secrets.** `integrations.config.json` (real client secrets) is gitignored; so are `node_modules/`, `out/`. Verify before any commit.
- **OAuth redirect is fixed:** `http://127.0.0.1:8723/callback` — register it on every provider's OAuth app. Use `127.0.0.1`, not `localhost` (providers treat them as different hosts).
- **No layout persistence yet** — surfaces are in-memory; a restart clears them.
- **Off-screen liveness:** `backgroundThrottling: false` on the window and all webview guests, so panned-away surfaces keep running for the agent.
- **Webview popup policy** (`allowpopups` + `setWindowOpenHandler` in `index.ts`): `window.open` must return a window inside guests or sites fall back to `top.location = url` and hijack the surface (Gmail's contact hovercard did). Policy: `about:blank` → hidden child; `accounts.google.com` → visible auth window; widget/helper URLs → deny + swallow the matching `will-navigate` fallback; any other http(s) → deny + open as a NEW web surface. Never "allow as hidden window" for URLs that fail to load top-level — that create/fail/destroy churn use-after-free'd Electron 31's guest-view manager (the 2026-06-09 SIGSEGV).
- Relay default is `agentsocket.dev` (`aisocket.dev` = same Worker); override with `AGENT_SOCKET_RELAY`.
- **Kernel fault model:** one instance per machine (`requestSingleInstanceLock`; a second launch focuses the first). `<root>/.blitzos/state.json` is the runtime journal: boot returns to the **last-active workspace** (a `BLITZ_WORKSPACE` pin overrides), and a boot after an unclean shutdown announces the crash to the human (chat line) + the agent (`trigger:'system'` moment, kind `crash`), enriched from macOS DiagnosticReports when possible. `markClean` runs LAST in `before-quit`/`gracefulExit` — "clean" means state flushed first. Two hosts on one root are detected via the journal's pid+heartbeat (loud warning today; refuse-enforcement pending decision). Tests: `node scripts/test-root-state.mjs`.
- **Effect-verified syscalls (`ok` = it happened + is durable):** `surface_control` click resolves the **visible, hit-testable** match (not the first `querySelector` hit — sites keep hidden twins; a selector matching only hidden/covered elements is a loud error), and click/type/key return an `effect` (typed value back, url/dom change) so the agent verifies in-band. Surface mutations are **authoritative-on-write**: main/serverOps apply create/update/move/close to `cached`/`osState` immediately (a `pendingCreates` set covers the pre-renderer-echo race), return `ok:false` for an unknown id (no more silent no-ops), and force a **durable flush at call time** on create/update/close so an `ok` ack survives a crash (the gap that lost a note). Tests: `node preview/test-control-effects.mjs` (needs CHROMIUM/Chrome).
- **Restart continuity / cross-workspace addressing** (item 4): surface ids already survive a restart (item 2's durable flush persists the workspace.json node at call time — verified). The remaining gap, **cross-workspace addressing**, is `findSurfaceWorkspace`/`relocateSurface` (workspace.mjs) + host `locateSurface`/`bringSurfaceHere`: an op on an id NOT in the active workspace no longer dead-ends — `move_surface` BRINGS the window into the active workspace (its content file is moved across folders, **id preserved**), while update/close/read return a navigable error naming the workspace ("move_surface it here, or switch_workspace"). The agent decides: just-this-window → move; whole-desktop → switch. Tests: `node scripts/test-cross-workspace.mjs`.
- **Guest capability contract** (`guest-capabilities.ts` + pure `popup-policy.mjs`): a web guest's browser-initiated escapes are handled by **what kind of action it is, never which site** (the old `accounts.google.com`/`contacts.google.com` popup regexes are deleted). Popups: sized `features`→real window (generalizes OAuth), `about:blank`→hidden child, link-disposition→new surface, else→deny+swallow the `top.location` hijack. Downloads→stream into the active workspace folder (→ a file tile). Permissions→real browser-parity **Allow/Block** prompt (the `consent-card` UI in App.tsx), remembered per-origin in the root journal (`getPermission`/`setPermission`); sensitive set prompts, harmless auto-allowed, unknown denied. `beforeunload`→auto-accept so close/nav always wins. Session-level handlers (download/permission) set once on `persist:agentos`; per-guest popup/unload in `did-attach-webview`. Tests: `node scripts/test-popup-policy.mjs`.
