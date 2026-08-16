# Connectivity e2e report — tunnel-per-workspace

Run: 2026-08-16T01:06–01:09Z, live against
`https://blitz-control-plane.blitzapp.workers.dev` (worker version
`cfc0509b`), box image `blitz-box:20260815d-amd64`, zone `blitzos.app`.
Script: `e2e/connectivity-e2e.mjs` (session-cookie auth only — the exact
browser flow; zero SSH forwards; no special headers from the client).

## Result: PASS (all steps)

| Step | Proof |
|---|---|
| Login | `POST /sessions` with operator key → `blitz_session` cookie |
| Create | `cpx11@ash` workspace `a45d6f80…`; control plane provisioned tunnel + ingress + proxied CNAME `ws-a45d6f80….blitzos.app`, delivered tunnel + surface tokens via user-data |
| Ready | phase `ready` after ~102 s (VM boot + image pull + phone-home) |
| Terminal | ttyd over `/workspaces/:id/surface/7445/terminal/ws`; typed a command, received `blitz-42-proof` output. One 530 retry at ready+0.5 s; connected by ready+25 s (tunnel startup race, absorbed by cockpit-style reconnect) |
| Chat | ACP `initialize` over `/surface/7444` (gateway `/acp` route) → `{"protocolVersion":1,…,"agentInfo":{"name":"BlitzOS box"}}` |
| Files | dufs JSON index over `/surface/7445/?json` |
| Preview | started a node HTTP server on port 4321 through the terminal, fetched `tunnel-preview-proof` via `/surface/7445/preview/4321/` |
| Leases | `GET /workspaces/:id/leases` → `{"leases":[]}` |
| Destroy | `DELETE` → 20 s later the DNS record and the tunnel are both gone from Cloudflare (cascade delete) |

Security spot-checks during the run:

- Direct unauthenticated hit on the tunnel hostname (`/ports`) → 403 from
  the gateway surface-token check.
- Before the flag-order fix, a dead tunnel returned 530 at the edge; the
  gateway was never reachable without the tunnel.

## Defects found live and fixed

1. `cloudflared tunnel run --no-autoupdate` fails: global flags must precede
   the subcommand. Fixed to `cloudflared --no-autoupdate tunnel run`;
   image republished as `20260815d`, pins flipped.
2. Tunnel deletion with active edge connections is rejected. Fixed with
   `DELETE …/cfd_tunnel/{id}?cascade=true`.
3. Expected behavior, documented: the tunnel registers ~10–20 s after the
   workspace reports ready. The cockpit's auto-reconnect covers the gap.

## Residue

- No test workspaces remain; `ws-*` tunnels and DNS records on the account: 0.
- The in-repo `cloudflared` s6 run script now also waits for the surface
  token before starting (hardening added after the `20260815d` build). The
  next image build picks it up; the published image waits on the tunnel
  token only.
