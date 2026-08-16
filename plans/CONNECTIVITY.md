# Workspace connectivity: eliminate manual SSH tunnels

Problem: every non-microVM workspace needs manual SSH forwards to reach its
terminal, ACP chat, files, and previews from the cockpit. MicroVM workspaces
already ride the control-plane surface proxy. Cloud-VM workspaces (Hetzner
today, any `VmProvider` tomorrow) do not. This must work automatically, at
fleet scale, with low multi-region latency.

Constraints (given):

- Control plane stays on Cloudflare Workers.
- Boxes already have refreshable control-plane identities.
- Prefer outbound-only connectivity from each workspace.
- Preserve authentication, ownership checks, streaming, WebSockets,
  backpressure.
- No Durable Objects (single-region placement adds latency).

Evidence base: [evidence/cloudflare-facts.md](evidence/cloudflare-facts.md)
(Cloudflare limits, cited docs) and
[evidence/prior-art-ingress.md](evidence/prior-art-ingress.md) (ten
production products), researched 2026-08-15.

## Decision

**Named Cloudflare Tunnel per workspace, with the control plane remaining the
authenticated front door.** The box dials out; nothing inbound opens. The
surface proxy the microVM leg already uses becomes the single data path for
every provider.

```
browser ── wss ──> CP Worker (session auth, ownership/grants)
                     │ fetch upgrade
                     ▼
        https://ws-<id>.<zone>  (proxied CNAME → <tunnel-id>.cfargotunnel.com)
                     │ Cloudflare edge → QUIC tunnel (outbound from box)
                     ▼
             cloudflared in box ──> 127.0.0.1:7445 gateway
                                      ├─ /terminal/ws → ttyd
                                      ├─ /preview/<port>/*
                                      └─ (7444 actor via ingress rule)
```

Why this shape:

1. **It is the industry pattern for BYO compute.** Coder agents, GitHub
   Codespaces (Dev Tunnels), Google Cloud Workstations, Modal, VS Code Remote
   Tunnels, and Cloudflare's own Sandbox product all use outbound agent
   tunnels. None of the ten products surveyed puts a public TLS listener on
   the workspace VM itself. Blitz runs on the customer's cloud, so the BYOC
   pattern applies.
2. **The relay fleet is rented, not built.** Cloudflare Tunnel is the regional
   relay + routing catalog that Replit (Eval) and Coder (wsproxy) had to
   build themselves. It is free on all plans and fully API-automatable.
3. **One data path for all providers.** The CP surface route already
   authenticates, checks ownership, and passes WebSockets for microVMs. Cloud
   VMs plug into the same route; only the upstream URL differs. Future
   workspace sharing enforces grants in exactly one place, for every
   provider.
4. **Constraints check.** Outbound-only: strict (box opens no port; SSH stays
   as-is for power users). No DO: none used. Streaming/WS/backpressure:
   proven on the microVM leg; Workers allow 32 MiB WS messages, no wall-clock
   cap on open sockets, idle time costs no CPU. Multi-region: browser hits
   the nearest colo; Worker-to-tunnel stays on Cloudflare's backbone.

## Workspace lifecycle

Create (CP, during provision):

1. `POST /accounts/{account}/cfd_tunnel` — remotely managed tunnel,
   `config_src: "cloudflare"`.
2. `PUT .../cfd_tunnel/{id}/configurations` — ingress:
   `ws-<workspaceId>.<zone>` → `http://127.0.0.1:7445`.
3. `POST /zones/{zone}/dns_records` — proxied CNAME `ws-<workspaceId>` →
   `<tunnel-id>.cfargotunnel.com`.
4. Deliver the tunnel run token to the box the same way the box credential
   arrives (bootstrap user-data / phone-home), mode 0600.

Box: image ships `cloudflared`; an s6 service runs
`cloudflared tunnel run --token-file …` when the token file exists.
MicroVM guests skip it (host path already covers them).

Destroy: delete the DNS record and the tunnel with the workspace. Tunnel
count therefore tracks *concurrent* workspaces, not historical ones.

Surface resolution: the provider records the workspace's surface base URL
(`https://ws-<id>.<zone>`). `proxySurface` for cloud VMs fetches it exactly
like the microVM path fetches the host agent, maps port 7444 to the
gateway's `/acp/*` route, strips cookies, and injects
`X-Blitz-Surface-Token` = HMAC-SHA256(`SURFACE_TOKEN_SECRET`, workspaceId).
The tunnel hostname is publicly reachable, so the gateway REQUIRES that
header on every route whenever `/var/lib/blitz/surface-token` exists
(constant-time compare; absent file keeps microVM/local behavior). Tunnel
deletion uses `?cascade=true` — a plain DELETE fails while edge connections
are still draining. Expect ~10–20 s between workspace ready and first
tunnel connect; the cockpit's reconnect covers it.

## Scale and limits (verified numbers)

| Limit | Value | Effect |
|---|---|---|
| Tunnels per account | 1,000 default; Enterprise raisable | Ceiling on concurrent cloud-VM workspaces per CF account |
| DNS records per zone | 200 Free (new) / 3,500 Pro+Biz / ~unbounded Ent | Same ceiling, cheaper to raise |
| CF API | 1,200 req / 5 min | ~4 calls per create, 2 per destroy → hundreds of lifecycle ops per 5 min |
| WS message | 32 MiB | ttyd/ACP frames are KB-scale; fine |
| Worker WS duration | no wall-clock cap; restarts possible (30 s grace) | cockpit already auto-reconnects; ACP journal replays |
| Worker CPU per connection | accumulates over the WS lifetime (no per-message reset outside DOs); breach = error 1102, socket cancelled | set `limits.cpu_ms` to the 300,000 max; passthrough stays dumb (no per-frame parsing); reconnect gets a fresh budget ([evidence](evidence/worker-cpu-websockets.md)) |
| Quick tunnels | 200 in-flight, no SLA | lab/dev only — never production |

At >1,000 concurrent cloud-VM workspaces: ask Cloudflare for a limit raise,
or graduate to phase 3 (below). Do not build a relay fleet before that.

## Rejected options

| # | Option | Why not |
|---|---|---|
| 2 | Shared tunnel per host/cluster | Already shipped for microVM hosts (host agent + registered tunnel). Cloud VMs are one-VM-one-workspace; there is no host layer to share. Generalizing it means building connector VMs = option 3. |
| 3 | Custom regional relay fleet (WS/QUIC) | The correct >1k-scale successor (Replit Eval, Coder wsproxy prove it). A stateful multi-region fleet is a heavy standing cost; deferred until tunnel limits actually bind. |
| 4 | Reverse SSH bastions | Port-allocation churn, zombie forwards, no HTTP/WS semantics, weak backpressure. No surveyed product uses it. |
| 5 | WireGuard/Tailscale mesh + ingress proxies | Browsers cannot join a mesh; you still need the proxy fleet (Coder's browsers go through coderd/wsproxy anyway). Workers cannot speak WireGuard. Adds a control plane (Headscale) or a vendor (Tailscale). |
| 6 | Direct HTTPS/WSS on every VM (mTLS/JWT) | Zero industry support in the survey. Public listener on every box: DDoS exposure, cert issuance/rotation per VM, IP churn, inbound firewall on customer clouds. Violates outbound-only. Origin CA certs are proxied-leg-only anyway. |
| 7 | Regional Envoy/HAProxy/nginx fleet | Option 3 without the outbound leg; requires inbound to boxes or morphs into 3. Same standing-fleet cost. |
| 8 | Managed relays (Fly/AWS/GCP/K8s) | A second cloud vendor to run what Cloudflare Tunnel already provides as a service on the account we require anyway. |
| 9 | WebRTC + TURN | No surveyed product uses it for workspace ingress. Bypasses the CP, so ownership/grant enforcement would move into every box; TURN fleet + signaling complexity. |
| 10 | SSH-over-WebSocket gateways | Still a gateway fleet, plus an SSH indirection our surfaces do not need — they are already HTTP/WS behind the gateway. |

## Phases

1. **Tunnel-per-workspace + unified surface path.** SHIPPED 2026-08-16.
   - CP: tunnel/DNS lifecycle in the cloud-VM provider; migration 0006
     (`tunnel_id`, `surface_hostname`, `dns_record_id`); `proxySurface` for
     cloud VMs; janitor sweep for orphaned tunnels; vars/secrets
     `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `WORKSPACE_SURFACE_ZONE`,
     `CLOUDFLARE_API_TOKEN` (Tunnel + DNS edit), `SURFACE_TOKEN_SECRET`.
   - Box: `cloudflared` 2026.7.3 pinned in the image, s6 unit gated on the
     token file, gateway surface-token auth + `/acp` route. Note: global
     flags precede the subcommand (`cloudflared --no-autoupdate tunnel run`).
   - UI: resolver returns CP-origin surface URLs for every workspace; the
     localhost-forward hint path is gone.
   - E2E (live, 2026-08-16): create cpx11@ash → terminal echo, ACP
     initialize, files listing, preview fetch, leases — all through the
     tunnel with zero local forwards; destroy removed tunnel + DNS.
     Zone: blitzos.app. Setup guide: docs/TUNNEL.md.
2. **Sharing integration.** Grants enforced at the one surface route (see the
   collaborative-platform plan). Viewer `ro` forcing and file-write blocking
   happen at the CP for all providers.
3. **Only if scale demands:** direct edge path with CP-minted signed tickets
   verified by the gateway (Coder app-ticket pattern), or a self-run relay
   fleet. Additive; same hostnames, same gateway.

## Prerequisites and notes

- The operator needs a Cloudflare zone (any domain) on the account that runs
  the control plane. Workers-dev-only deployments keep working for microVM
  workspaces; cloud-VM auto-connect requires the zone. Document this.
- `ws-<id>.<zone>` is one DNS label → covered by Universal SSL on every plan.
  Per-port preview hostnames (`<port>-ws-<id>`) are also single-label if ever
  needed; previews stay path-based for now.
- If a self-hoster serves the CP on the *same* zone as workspace hostnames,
  same-zone `fetch()` from the Worker goes straight to origin unless
  `global_fetch_strictly_public` is set. Our default (workers.dev CP,
  separate zone for workspaces) avoids this; document the flag for the
  same-zone layout.
- cloudflared idle footprint is unpublished; benchmark on the smallest
  supported VM during phase 1 and record it.
- The microVM host-agent path and `microvm_hosts` self-registration stay
  as-is; they are the shared-tunnel (option 2) instance of the same
  architecture, and the lab NAT case remains the documented edge case.
