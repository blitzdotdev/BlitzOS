# CLAUDE.md — BlitzOS (agent-os)

Guidance for Claude Code working in `agent-os/`. The root repo (`../CLAUDE.md`, teenybase) rules also apply.

## What this is

BlitzOS is an Electron macOS desktop: an **infinite canvas** of live **surfaces**. The human drives it, and so can an AI agent over the [agent-socket](https://agentsocket.dev) relay (paste a URL into any chat, no MCP). Prototype stage; the roadmap/backlog lives in `../plans/agent-os-desktop-architecture.md` and integration research in `../plans/agent-os-integrations-oauth.md`.

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
  App.tsx          canvas (pan/zoom), renders surfaces + integration widgets + sidebar + toolbar
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
- **agent-socket tools:** `create_surface`, `open_window` (web shortcut), `move_surface`, `close_surface`, `go_to_primary`, `list_state`, `surface_control`. Defined in `agentSocket.ts`; mints a paste URL surfaced via the in-app "Connect AI" button.
- **In-window control (`surface_control`).** Acting *inside* a surface routes through `osActions.osControlSurface(id, action)`, keyed on `surface.kind`: **`web`** (a `<webview>` guest) → **CDP** via `webContents.debugger` (`cdp.ts`) — the only mechanism giving trusted input (`isTrusted`), no same-origin requirement, and off-screen reach; **`app`/`srcdoc`** (iframes) → cooperative `postMessage` (planned, not wired); **`native`** → store mutation. The debugger is single-client and attached lazily, then detached on idle/close so it never locks the user out of DevTools. The renderer reports each web guest's `getWebContentsId()` on `dom-ready` (`os:register-webview`). **Security:** raw `eval` is allowed only on the localhost-bearer control server, **never over the relay** (`surface_control` rejects it).
- **Integrations.** OAuth SSO only (no token paste). `oauth.ts` runs a loopback authorization-code flow (system browser → `http://127.0.0.1:8723/callback` → token exchange in main → encrypted in Keychain via `safeStorage`). Each provider needs a one-time client id/secret in `integrations.config.json`.

## Gotchas / conventions

- **The SDK is ESM-only; Electron main is CJS.** So `@agent-socket/sdk` is **bundled** into main via `externalizeDepsPlugin({ exclude: ['@agent-socket/sdk'] })` in `electron.vite.config.ts`, not `require()`d. `ws` stays external.
- **The SDK is vendored** at `vendor/agent-socket-sdk/` (its own repo is `~/agent-socket`, github.com/repalash/agent-socket). To update: rebuild it (`cd ~/agent-socket/sdk && npm run build`) then re-copy `dist` + `package.json` into `vendor/agent-socket-sdk/`.
- **Never commit secrets.** `integrations.config.json` (real client secrets) is gitignored; so are `node_modules/`, `out/`. Verify before any commit.
- **OAuth redirect is fixed:** `http://127.0.0.1:8723/callback` — register it on every provider's OAuth app. Use `127.0.0.1`, not `localhost` (providers treat them as different hosts).
- **No layout persistence yet** — surfaces are in-memory; a restart clears them.
- **Off-screen liveness:** `backgroundThrottling: false` on the window and all webview guests, so panned-away surfaces keep running for the agent.
- Relay default is `agentsocket.dev` (`aisocket.dev` = same Worker); override with `AGENT_SOCKET_RELAY`.
