# Agent OS Desktop: Architecture & Build Plan

**Status:** Building. Prototype slice #1 (canvas + live windows) in progress.
**Date:** 2026-06-03
**Companion doc:** `plans/agent-os-integrations-oauth.md` (per-provider auth research).

---

## 1. Product vision (the spatial desktop)

An Electron Mac app that opens to a literal virtual desktop on an **infinite 2D canvas**. A headless **Claude Code or Codex** runs in the background as the agent.

- **Ground plane** (one shared z): **widgets** (live tiles: daily summary, next tasks, meetings today) and **icons** (launchers). They never overlap. Created dynamically by the agent or picked from a library.
- **Window plane** (above the ground, each window its own z): **windows** are full apps, they overlap by depth, and they can be **live web apps** (Google Sheets, agent-built webapps) that the agent or human drives. Windows stay alive when panned off-screen.
- **Primary space**: a rectangle at the origin `(0,0)`, the "home" region for what you're actively working on. A button and keyboard shortcut recenter/zoom-to-fit there.
- Widgets and icons open windows. Most apps pin a widget back onto the canvas.
- No taskbar yet. Wayfinding (minimap / task manager) is a later decision.

## 2. v1 decisions (locked 2026-06-03)

- **Electron Mac desktop app** (reverses the earlier "pure web app").
- **Fully local auth**: tokens/credentials in the **macOS Keychain**, no backend broker by default. Per-provider local-friendly auth (see integrations doc table). Caveat: Jira/Slack need either a paste-token method or a tiny exchange proxy (open question).
- **Agent-to-OS control via a local HTTP API, NOT MCP** (user preference: "HTTP or something simpler").
- **v1 integrations**: Discord (bot), Gmail, Jira, Slack, GitHub. (Linear parked; Calendar/Notion/Drive/Sheets/Salesforce/LinkedIn deferred.)
- **Sequence**: canvas + live windows first, then everything else.

## 3. Architecture

### 3.1 Process model
- **Main process**: window lifecycle, the localhost control server, Keychain access (`safeStorage`), spawning/supervising the headless agent, and per-webview CDP control.
- **Renderer (one BrowserWindow)**: the infinite canvas UI (React). Holds the ground plane and the window chrome. `webviewTag: true`, `contextIsolation: true`, `nodeIntegration: false`.
- **Live web windows**: `<webview>` tags inside the renderer's transformed canvas (DOM nodes, so they pan/zoom and stack with CSS) with `backgroundThrottling: false` so off-screen apps keep running.
- **Headless agent**: Claude Code or Codex run as a child process; it talks to the OS over the local HTTP API; it drives embedded web apps via CDP.

### 3.2 Control API (localhost HTTP, not MCP)
A small HTTP server in the main process, bound to `127.0.0.1` on a random port, token-guarded (a per-session bearer the agent is given on spawn). Shape (v1 target is a minimal subset):
```
GET  /state                      -> full desktop state (entities, transform, focus)
POST /windows        {url,x,y,w,h,title}        -> open a live window, returns id
POST /windows/:id/move           {x,y} / close / focus / resize
POST /windows/:id/control        {action:'click'|'type'|'eval', ...}  -> CDP into the webview
POST /widgets        {type,x,y,props}           -> create a ground-plane widget
POST /canvas/arrange {mode:'cleanup'|'stack'|'tile'}
POST /canvas/goToPrimary
```
Auth, schema, and the agent loop are slice #2. Slice #1 ships only `POST /windows` + `GET /state` to prove the path.

### 3.3 Spatial model + coordinates
- **World space** is the infinite canvas. The renderer keeps a single transform `{x, y, scale}`; everything is positioned in world coords and rendered via one CSS `transform: translate() scale()` on a `#world` layer. Pan = change translate; zoom = change scale about the cursor.
- **Ground plane**: widgets/icons snap to a **grid** (e.g. 8px base, tiles sized in grid units). "No overlap" is enforced by the grid + a collision check on drop (occupied cells push or reject). One z-index band.
- **Window plane**: a higher z band. Each window has an integer z; focus raises it to top-of-band. Windows free-drag (no grid) and overlap.
- **Primary space**: a fixed world-space rect centered on origin (e.g. 1440x900 world units). `goToPrimary` animates the transform to fit it. Shortcut: `Cmd+0` (and a button).

### 3.4 Live web windows (the hard pillar)
- **Path A (v1): `<webview>` in the transformed canvas.** It's a DOM element, so it pans/zooms/stacks naturally. Set `backgroundThrottling: false` and keep the element mounted when off-screen so its WebContents stays alive. Verify off-screen liveness with a known-moving page (timer/video) parked outside the viewport.
- **Path B (reserve): offscreen rendering (OSR).** Each app renders to a bitmap we composite onto the canvas at any transform; fully decoupled from viewport, elegant for zoom, heavier and input-forwarding is manual. Switch to this if `<webview>` z-order/perf bites at scale.
- **Known risk:** many sites refuse framing. `<webview>` is a real top-level browsing context (not an iframe), so framing-protections (`X-Frame-Options`, `frame-ancestors`) do **not** block it the way they block iframes. This is why webview (or OSR), not iframe, is the embed mechanism.

### 3.5 Agent driving embedded apps
`webContents.debugger.attach()` on each webview gives the agent CDP: `Input.dispatchMouseEvent/Key`, `Runtime.evaluate` for DOM reads, etc. This is how "the agent controls Google Sheets" works, on-screen or off. Exposed through `POST /windows/:id/control`.

### 3.6 Auth/token storage
Local only. `safeStorage.encryptString` (Keychain-backed) for tokens, persisted in a small local store. Per-provider methods in the integrations doc. No tokens leave the machine in v1.

## 4. Tech stack (proposed, override welcome)
- **electron-vite + React + TypeScript** (fast HMR, typed, standard main/preload/renderer split).
- **zustand** for renderer state (canvas transform + entity maps). Lightweight, no boilerplate.
- Plain CSS (no UI kit yet); the canvas is custom.
- Node's built-in `http` for the control server (no framework).
- Location: **`agent-os/`** at the repo root (isolated from teenybase core; trivial to relocate or split into its own repo later).

## 5. Prototype slice #1 — Canvas + live windows (CURRENT TARGET)

**Scope:**
- App launches full-window to an infinite canvas.
- Pan (drag / trackpad) and zoom (scroll / pinch) about the cursor.
- Ground plane with a few placeholder widgets + icons snapped to a grid, no overlap.
- Window plane: open a live `<webview>` window (e.g. a URL) by clicking an icon; windows drag, focus-to-raise, overlap by z.
- A window panned off-screen stays alive (`backgroundThrottling:false`) — provable with a moving page.
- Primary-space rectangle drawn at origin; button + `Cmd+0` recenters/zoom-to-fit.
- Minimal control path: `POST /windows` opens a window programmatically (proves the agent path).
- No taskbar.

**Acceptance:** the user runs `npm run dev` on their Mac and can pan/zoom, open and drag a live web window, jump to primary, and see an off-screen window keep running.

**Not in slice #1 (deferred to backlog):** collision *resolution* (push neighbors) beyond reject-on-overlap, window resize handles, persistence of layout, the full control API + agent loop, any real integration/auth, minimap.

## 6. Backlog — what's left (so we don't forget)

**Window manager**
- Window resize handles + min/max + snap.
- Arrange modes: `cleanup` (re-pack ground plane), `stack`, `tile`, focus-follows.
- Ground-plane collision *resolution* (push/reflow neighbors), not just reject.
- Layout persistence (save/restore canvas + entities to local store).
- Minimap / task-manager for off-screen windows (replaces taskbar). Wayfinding.
- Multi-monitor / multiple canvases.

**Control + agent**
- Full localhost HTTP control API (§3.2) with bearer auth + JSON schemas.
- Headless agent runner: spawn Claude Code / Codex as a child, hand it the control token + base URL, define the task loop.
- In-window control (`surface_control` tool + `POST /surfaces/:id/control`) — **built (compile-verified)**, wired onto the surface model. Routes via `osActions.osControlSurface(id, action)` keyed on `surface.kind`: **`web`** → CDP (`webContents.debugger`, `src/main/cdp.ts`) with `click` (selector or x,y), `type` (Input.insertText + `perKey` real key events), `key` (Enter/Tab/arrows via dispatchKeyEvent), `read`, `screenshot`, and `eval` (localhost-bearer only). Lazy attach + idle/close detach so DevTools isn't locked out. `app`/`srcdoc`/`native` return an explicit "not supported" (cooperative postMessage/store path planned). Security: relay path rejects `eval`. Decision basis: the in-window-control eval (CDP is the only trusted-input, no-same-origin, off-screen mechanism for third-party sites; do **not** migrate web surfaces to WebContentsView — breaks the canvas). Behavioral verify pending `npm run dev` on Mac. Not yet: `wait-for`, AX-tree reads, per-site consent UI, postMessage contracts for app/srcdoc.
- Agent-built webapps opened as windows (same path as any live window).

**Integrations / auth — DONE (OAuth SSO), with caveats**
- 5 widgets (Discord, Gmail, Jira, Slack, GitHub), greyed when disconnected, green dot when connected. Built + verified loading.
- **OAuth SSO only** (user rejected paste/typing). Loopback authorization-code flow: click -> system browser opens the provider's real sign-in (uses existing session) -> Allow -> redirect to `http://127.0.0.1:8723/callback` -> token exchange -> tokens encrypted in Keychain (`safeStorage`). `oauth.ts` + `integrations.ts`.
- One-time per provider: register an OAuth app (client_id + secret) in `agent-os/integrations.config.json`. Redirect to register = `http://127.0.0.1:8723/callback`.
- Open items: live round-trips for github/slack/jira/discord need the user's client_ids to test (gmail pattern is the proven one). **Slack** may reject http loopback (needs https/custom-scheme). **Discord** SSO = identify/guilds; the support **bot token + Gateway** (Message Content intent, always-on caveat) is a separate flow still to build. Refresh-token rotation handling (jira/slack/github) to add.

**Computer-use credential provisioning (user direction) — NEXT**
- Goal: zero manual setup. Instead of the user registering OAuth apps, a per-provider **skill** drives the provider's web UI to create the OAuth app / bot and capture the client_id+secret (or token), feeding the same store.
- Mechanism: open the provider site in an Agent OS window (`<webview>`), drive it via **CDP** (`webContents.debugger`: Input/Runtime/DOM). This is the same "agent controls embedded apps" capability used for Google Sheets etc.
- Human-in-the-loop: the user logs into the provider once (the agent never handles primary credentials / 2FA); the persistent `persist:agentos` partition keeps the session for subsequent providers on the same domain.
- Skills: `SKILL.md`-style per-provider step + selector scripts the headless agent executes; vision+DOM hybrid for resilience as UIs change.
- Provisioning difficulty (easiest -> hardest): Jira API token < GitHub OAuth app < Discord bot < Slack app < Google OAuth client. Prototype the easiest/highest-value first.
- Risks to flag: provider anti-automation/bot-detection, selector drift, login/2FA/captcha require the human.

**Widgets**
- Widget library + dynamic widget creation by the agent.
- First real widgets from live data: meetings-today, next-tasks (Jira/GitHub issues), daily-summary (Gmail/Discord). (Note: meetings-today implies adding Calendar back.)
- Widget pinning from windows into the primary space.

**Open product/architecture questions**
- Jira/Slack: paste-token vs minimal exchange proxy (Flag 1).
- Linear back in or out (Flag 2).
- Discord always-on relay vs local-only (Flag 3).
- Path A `<webview>` vs Path B OSR if perf/z-order bites.
- Security: CDP is powerful; scope what the agent can drive and require user consent per window.

## 7. Verification reality
The GUI runs on the user's Mac (no display in the dev sandbox). I compile-check headlessly; behavioral verification is the user running `npm run dev`. Iterate from there.
