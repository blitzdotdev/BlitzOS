# Running BlitzOS server mode on your domain

This is exactly how the live demo at **https://agentos.blitzmen.com** runs — the React
renderer (Vite), a Node backend in **server mode** (a headless Chromium per `web`
surface, streamed to a `<canvas>`), and a **cloudflared named tunnel** — all from
`packages/BlitzOS/`. (Server mode is the deployable browser+backend path; the real
Electron desktop is `npm run dev`.)

## One command

```bash
bash preview/start-all.sh            # = restart: clean stop, then start
bash preview/start-all.sh stop       # cleanly stop everything (incl. headless Chromium)
bash preview/start-all.sh status     # what's running + port health
```

→ live at **https://agentos.blitzmen.com**. **Hard-refresh the tab after any restart**
(the page caches the shim; a restart re-mints the agent URL).

Each service (vite, backend, tunnel) runs in its **own process group** (`setsid`) with a
pidfile in `/tmp/blitzos-run/`, so `stop` kills the whole group — the backend's headless
Chromium children die with it (no zombies, no orphaned chrome, no port squatting), and
`start` always begins from a clean slate. Logs: `/tmp/blitzos-run/{vite,backend,tunnel}.log`.

Useful overrides:
```bash
PUBLIC_BASE_URL=https://foo.example.com bash preview/start-all.sh   # different domain
SERVER_MODE=0 bash preview/start-all.sh                             # no Chromium; web surfaces show as empty frames
CHROMIUM=/path/to/chromium bash preview/start-all.sh               # explicit browser binary
BACKEND_PORT=8801 bash preview/start-all.sh                        # if 8799 is taken
```

## What it starts

| Process | Port | Role |
|---|---|---|
| Vite (`vite.renderer.preview.mjs`) | 5174 | serves the renderer + proxies `/api` (incl. the `/api/os/stream` WS) to the backend; injects the server-mode flag |
| `preview/backend.mjs` (`BLITZ_SERVER_MODE=1`) | 8799 | spawns headless Chromium, renders each `web` surface as a top-level target, streams JPEG frames; runs the agent-socket session. (Port 8799, not 8787 — wrangler's default 8787 collides.) |
| `cloudflared` (named tunnel) | — | connects the saved tunnel; CF maps the public hostname → `localhost:5174` |

## One-time setup (already done for agentos.blitzmen.com)

1. **Chromium** on the box — `command -v chromium` (or pass `CHROMIUM=/path`). Alpine: `apk add chromium`.
2. **cloudflared named tunnel** — token saved at `preview/.cf-tunnel-token` (gitignored), run by `preview/start-tunnel.sh` (auto-downloads `cloudflared` if missing). In the Cloudflare **Zero Trust → Networks → Tunnels → <tunnel> → Public Hostname**: `agentos.blitzmen.com` → Service **HTTP** → `localhost:5174` (must be **HTTP**, not HTTPS — HTTPS gives a TLS-handshake 502). The connector must run on the **same box** as the renderer (it proxies to `localhost:5174`).
   - *New domain / new tunnel:* create a tunnel in the dashboard, copy its token into `preview/.cf-tunnel-token`, add the public hostname → HTTP localhost:5174.

## Using it

- Click **`+`** (left sidebar) → a live site (Hacker News) renders server-side and streams to the canvas; type any URL in the window's address bar, click links, scroll. Try a site that blocks iframes (e.g. twitter.com) — it still renders (real top-level browser).
- **Connect AI** (toolbar) → copy the paste URL → paste into a code/HTTP-capable agent such as Codex CLI or Claude Code → it opens & controls surfaces for real.

## Notes

- Server mode renders `web` surfaces as a `<canvas>` streamed from server Chromium (bypasses `X-Frame-Options`). ~4–12 fps (paint-gated) — great for forms/reading/agent-watching.
- The CF hostname mapping persists on your account, so **next time it's just `bash preview/start-all.sh`**.
- This is the dev/preview path — **not hardened**. For a real VPS deploy (static-serve, Docker, auth on the WS, encryption): see `../issues/open/server-mode-deployment.md`. Architecture: `../plans/agent-os-server-mode.md`.
