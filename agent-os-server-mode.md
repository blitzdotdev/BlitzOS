# BlitzOS Server Mode — Architecture & Build Plan

**Status:** Planned (verified design, 2026-06-04). MVP build in progress.
**Companion:** `agent-os-desktop-architecture.md` (Electron mode), `CLAUDE.md`.

A deployable **third run mode**: anyone runs BlitzOS on a VPS and uses it from a browser, recovering the two capabilities the plain browser preview cannot fake — **live third-party `web` surfaces** and **in-window agent control** — by moving the browser engine to the server.

**Keystone:** `src/main/cdp.ts`'s action vocabulary is already pure CDP (`send(method, params)`), so the same primitives that drive an Electron `<webview>` drive a server-side headless Chromium unchanged. The genuinely new code is a `RemoteCdpSession` (CDP over a DevTools WebSocket), a screencast pump, a binary WS, and a `<canvas>` surface branch.

## 1. Architecture

```
  Browser (operator)                 VPS (one Docker container)
  ┌────────────────┐   SSE /api/os/events  ┌─────────────────────┐
  │ React renderer │◄──────────────────────┤ Node host           │
  │ web surface =  │   os:action create/…  │ (preview/backend.mjs+)│
  │  <canvas>  ◄───┼── jpeg frames (WS) ────┤ screencast pump     │
  │  capture input ├── input msgs (WS) ────►│ input router        │
  └────────────────┘   /api/os/stream       │  RemoteCdpSession   │
                                            └──────────┬──────────┘
                                       DevTools WS (flat targets, sessionId)
                                                       ▼
                                   Headless Chromium (1 process/tenant)
                                     Target.createBrowserContext (cookie jar/surface)
                                     Target.createTarget(url) = TOP-LEVEL page
                                     → X-Frame-Options / CSP frame-ancestors DO NOT APPLY
```

- **Why web surfaces work:** a headless-Chrome `Target.createTarget(url)` is an address-bar-equivalent top-level load; framing headers are embedding-only (never consulted), which is exactly why the plain-browser `<iframe>`/`<webview>` path renders empty and server Chrome does not.
- **Why control transfers verbatim:** every action in `cdp.ts` (`Runtime.evaluate`, `Input.dispatchMouseEvent/dispatchKeyEvent/insertText`, `Page.captureScreenshot`) is a stock CDP call with no Electron dependency; only the registry + attach/idle-detach lifecycle is Electron-specific.

### Isolation (the hard security boundary)
A Chromium **BrowserContext is a cookie-jar convenience, NOT a security perimeter** — all contexts share one privileged browser process. So: BrowserContext-per-surface *within* a tenant; one Chromium **process per tenant**, hardened to one **container per tenant**, **before a second user exists**. Amplified here because we drive *logged-in* third-party sessions.

### Auth / secrets / persistence
| Concern | MVP (single operator) | Multi-tenant (seam now) |
|---|---|---|
| App auth | one shared bearer on every route **+ the WS upgrade** | session cookie + passkeys |
| Secrets at rest | AES-256-GCM, key from `BLITZ_TOKEN_KEY` (replaces plaintext `preview/.tokens.json`) | per-user envelope encryption |
| Third-party login | operator logs in **inside the server browser** (never import cookies) | same |
| OAuth | fixed public redirect + **HMAC-signed `state`** | tenant-bound signed state |
| Layout | JSON file via existing `/api/os/state` POST | Postgres, `tenant_id`-scoped |
| Deploy/scale | one container, 4–8 GB VPS | front tier + browser-pool tier, ~1 browser/0.5–1 GB RAM, scale by adding containers |

### Deploy
One Docker image = Node host + Vite-built renderer (static) + chromium, behind Caddy (TLS + fixed OAuth redirect). **`--shm-size=1g` mandatory** (Docker's 64 MB default crashes Chrome). Chrome: `--headless=new --remote-debugging-port=9222 --user-data-dir=<per-tenant> --no-first-run` + a respawn supervisor.

## 2. Capability matrix

| Electron-only capability | Server-mode alternative | Parity |
|---|---|---|
| `<webview>` embeds arbitrary sites | server Chromium top-level target → screencast to `<canvas>` | **Full** |
| In-window CDP control (`surface_control`) | `RemoteCdpSession` driving the same action core | **Full** (coords scaled to CSS px) |
| Off-screen liveness | per-tab `Page.startScreencast` keeps it painting (not a CLI flag) | **Partial→Full**, per-surface work |
| Smooth video/drag in a web surface | JPEG screencast ~4–12 fps, ack every frame | **Partial** (WebRTC "cinema mode" deferred, 1–3 focused surfaces) |
| Keychain token storage | AES-256-GCM at rest → envelope encryption | **Partial** (box now holds keys + live sessions) |
| Native app shell | n/a — it's a web app | **None** (by design) |
| OAuth / agent-socket / IPC bridge | already substituted by `preview/backend.mjs` | **Full** (works today) |

## 3. Shared vs new

**Keystone refactor:** extract `controlSession(session, action)` where `session = { send(method, params) }`. Keep `evaluate / dispatchClick / clickSelector / KEYMAP / pressKey / typeText / read / screenshot` verbatim. Two adapters: `ElectronCdpSession` (wraps `wc.debugger.sendCommand` + attach/idle-detach), `RemoteCdpSession` (flat-target CDP over a WebSocket, `Target.attachToTarget({flatten:true})`, sessionId-routed — no idle-detach machinery).

- **Reused unchanged:** surface descriptor; the 4 `os:action` types; SSE `/api/os/events`; agent-socket relay + eval-403 guard; `app`/`srcdoc`/`native` surface branches.
- **New (server-only):** browser host (spawn/supervise Chrome + DevTools-WS CDP client + `surfaceId→{targetId,sessionId,browserContextId}` map); `RemoteCdpSession`; screencast pump; `/api/os/stream` binary WS; SurfaceFrame server-mode `web` `<canvas>` branch.

## 4. MVP (ordered, each independently verifiable)

1. **Refactor `cdp.ts` → `controlSession(session, action)`** + `ElectronCdpSession`. Verify: typecheck; Electron behavior unchanged.
2. **Browser host**: spawn headless Chrome + respawn supervisor; CDP client over DevTools WS; `RemoteCdpSession`; `surfaceId→{targetId,sessionId,browserContextId}` map; wire `createBrowserContext`+`createTarget` into create/open, `closeTarget` into close.
3. **Screencast pump**: `Page.startScreencast({format:'jpeg',quality:80})`; **`Page.screencastFrameAck` FIRST** on every `screencastFrame` (else the stream freezes at `kMaxScreencastFramesInFlight=2` — not a crash), then forward over WS; off-screen → pause/`everyNthFrame`.
4. **`/api/os/stream` binary WS** (bearer-gated): frames out, input in → `controlSession`.
5. **SurfaceFrame server `web` branch**: `<canvas>` instead of `<webview>`; draw JPEG; capture pointer/wheel/key; **two-stage CSS-px coord transform** (canvas→screen ÷ screenZoom; screen→page ÷ pageScaleFactor + scrollOffset); `registerRemoteSurface`.
6. **Un-stub `surface_control`** via `controlSession`; **keep relay eval-403** + add a regression test.
7. **Harden for one box**: AES token-at-rest (`BLITZ_TOKEN_KEY`); HMAC-signed OAuth `state`; layout → `/var/blitz/layout.json`; bind `0.0.0.0` + bearer on every route **and the WS upgrade**.
8. **Deploy**: Docker image (+chromium, `--shm-size=1g`) behind Caddy.

## 5. Non-negotiable invariants
1. `eval` stays blocked over the relay (regression test).
2. One Chromium process per tenant → one container per tenant before a 2nd user. BrowserContext is never a tenant boundary.
3. Login happens inside the server browser; **no cookie import** (fragile + DBSC kills it on the sites that matter).
4. Auth gate is load-bearing on every route **and the WS upgrade** once bound to `0.0.0.0`.

## 6. Risks
- **Custody of live logged-in third-party sessions on a shared, internet-reachable box** — a worse target than a per-device Keychain. Breadth of access is the worry (sessions *are* revocable; "non-revocable cookie" framing is wrong).
- Memory-bound: ~1 isolated browser / 0.5–1 GB RAM; scale by adding containers.
- ~4–12 fps screencast over WAN — design UX for forms/reading/agent-watching, not smooth video.
- Pixels on the **binary WS**, not base64-over-SSE.
- Respawn supervisor on Chrome; off-screen tiles must throttle; anti-bot/datacenter-IP detection (per-tenant egress proxy is the seam).
