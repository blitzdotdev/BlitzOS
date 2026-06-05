# Server mode — deployment (VPS) [LATER]

**Status:** parked (user: "deployment later"). Server mode itself is built + verified
(headless Chromium per `web` surface → screencast → `<canvas>`, CDP control via the
shared `control-core.mjs`, all 9 agent tools work over the live relay). What remains
is hardening + packaging so anyone can `docker run` it on a VPS.

Full architecture + capability matrix + the verified design decisions/corrections:
see `agent-os-server-mode.md`. This issue is just the deployment checklist.

## MVP: single-operator box (do these first)

Goal: one `docker run` on a 4–8 GB VPS, one operator (their VPS, their accounts
logged in inside the server browser → **trust boundary = the box**).

- [ ] **Serve the renderer statically from the backend** (no Vite dev). `npm run build`
      already bakes the shim into `out/renderer/index.html` via the preview vite config's
      `transformIndexHtml`; have `preview/backend.mjs` serve `out/renderer/*` + `/api` +
      the `/api/os/stream` WS on ONE port. Removes the Vite-dev process entirely (this
      session burned a lot of time on stale-shim / zombie-vite / port-squat fragility —
      a single static process kills that class of problem) and IS the Docker architecture.
- [ ] **Bind `0.0.0.0` + a shared bearer** on every route AND the WS upgrade. Today the
      backend binds `127.0.0.1` (fine behind the tunnel); the moment it's public the bearer
      gate is load-bearing. **`/api/os/stream` currently has NO auth** — anyone with the URL
      can send raw CDP `Input.*` to any surface. Gate the WS upgrade before going public.
- [ ] **AES-256-GCM token-at-rest** (`BLITZ_TOKEN_KEY` env) replacing the plaintext
      `preview/.tokens.json` (`backend.mjs` writeTokens).
- [ ] **HMAC-sign the OAuth `state`** instead of the raw in-memory `pending` map
      (`backend.mjs`), and keep the one fixed public redirect `PUBLIC_BASE_URL/api/oauth/callback`.
- [ ] **Layout persistence**: write surfaces to `/var/blitz/layout.json` on the existing
      `/api/os/state` POST (so a restart restores the desktop).
- [ ] **Dockerfile**: one image = Node backend + built renderer (static) + chromium.
      - `--shm-size=1g` is **mandatory** (Docker's 64 MB default crashes Chrome).
      - Chrome launched `--headless=new --no-sandbox --disable-dev-shm-usage
        --remote-debugging-port=0 --user-data-dir=<per-tenant> --no-first-run`
        **plus a respawn-on-exit supervisor** (a crashed browser drops every surface).
      - `CHROMIUM` env points at the chromium binary.
- [ ] **Caddy** in front for TLS + the fixed OAuth redirect; `docker run` on a VPS.
- [ ] **End-to-end deploy check**: open over TLS with the bearer → paste the agent-socket
      URL into a chat → `open_window` → live third-party pixels stream to the canvas →
      `surface_control`/`read_window` act inside it.

## Multi-tenant milestone (later)

Design the seams now, build when needed:

- [ ] **Isolation = one Chromium PROCESS per tenant → one CONTAINER per tenant** (net/fs/
      PID namespaces, seccomp, own `--shm-size`) **before a second user exists**. A
      `BrowserContext` is a cookie jar, NOT a security boundary — all contexts share one
      privileged browser process. Amplified here: we drive *logged-in* third-party sessions.
- [ ] **App auth**: session cookie + WebAuthn/passkeys; the login event derives the
      secret-manager KEK.
- [ ] **Per-user envelope encryption** (random DEK + login/KMS KEK) for tokens.
- [ ] **Persistence → Postgres**: `tenant_id`-scoped users/sessions/integrations + a
      `surfaces` table mirroring the `store.ts` descriptor; write-through at the single
      `osActions` mutation point; per-tenant encrypted profile volumes.
- [ ] **Scale**: stateless front tier + browser-pool tier, `tenant_id`-sticky affinity,
      warm pool, idle-evict. Budget **~1 isolated browser per 0.5–1 GB RAM**; scale by
      adding containers, never by cranking concurrency on one box (Chromium is
      memory-bandwidth bound at scale).
- [ ] **Login happens inside the server browser** — never build a cookie-import/sync path
      (fragile; DBSC kills it on the sites that matter).
- [ ] **Per-tenant egress proxy** (`Target.createBrowserContext({proxyServer})`) for
      anti-bot / datacenter-IP detection.

## Server-mode polish (independent of deploy)

- [ ] **Binary WS frames** instead of JSON+base64 over `/api/os/stream` (~33% bandwidth +
      avoids base64 cost at fps).
- [ ] **Coordinate transform**: the canvas→CSS-px mapping in `agentos-shim.js`
      `mountServerSurface` assumes DPR=1 / no page zoom / no scroll. Do the two-stage
      transform (canvas→screen ÷ screenZoom; screen→page ÷ pageScaleFactor + scrollOffset)
      using `Page.screencastFrame` metadata — clicks land wrong on HiDPI/zoomed/scrolled pages.
- [ ] **Off-screen frame throttling**: pause / `everyNthFrame` `Page.startScreencast` for
      panned-away surfaces (else you pay full encode+bandwidth for invisible tiles). `read`
      stays the reliable way to "see" an off-screen surface; `screenshot` can be blank.
- [ ] **Per-site consent** before the agent controls a `web` surface (CDP = effectively
      root over that logged-in origin).
- [ ] **WebRTC "cinema mode"** behind the same pluggable pixel-source seam, for 1–3 focused
      surfaces only — JPEG screencast is ~4–12 fps (paint-gated), fine for forms/reading/
      agent-watching, janky for video/smooth drag. Never every tile.

## Non-negotiable invariants (keep across all of the above)

1. `eval` stays blocked over the agent-socket relay (`agentSocket.ts` / `backend.mjs`
   surface_control 403) — confirmed; add a regression test.
2. One Chromium process per tenant → one container per tenant before a 2nd user.
3. Auth/bearer is load-bearing on every route AND the WS upgrade once bound to `0.0.0.0`.
4. **Custody risk**: holding users' live logged-in third-party sessions on a shared,
   internet-reachable box is a higher-value target than a per-device Keychain. Design
   around breadth-of-access, not just secrecy.
