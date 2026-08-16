# Cloudflare connectivity fact sheet

Current as of **2026-08-15**. “VERIFIED” means an authoritative Cloudflare source supports the claim; “UNCLEAR” means Cloudflare does not publish the requested numeric limit or guarantee.

## 1. Named Cloudflare Tunnel limits and pricing

**An account gets 1,000 `cloudflared` tunnels by default, each tunnel supports up to 25 active replicas, and Tunnel is available on every Cloudflare plan, including Free.**

Each replica normally establishes four outbound high-availability transport connections, so 25 replicas can produce up to 100 cloudflared-to-edge transport connections. These are transport connections, not a limit of 100 browser, HTTP, or WebSocket sessions.

Cloudflare does not publish a fixed per-tunnel application-connection or bandwidth quota. Its sizing guidance instead says throughput is primarily constrained by the cloudflared host’s CPU, memory, network ports, and bandwidth. Enterprise customers can request higher account limits.

Official sources:

- [Cloudflare One account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) — updated 2026-06-25
- [Tunnel configuration and replicas](https://developers.cloudflare.com/tunnel/configuration/) — updated 2026-05-21
- [Cloudflare Tunnel overview](https://developers.cloudflare.com/tunnel/) — updated 2026-05-05
- [cloudflared system requirements and sizing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/system-requirements/) — updated 2026-04-17

**Status: VERIFIED** for 1,000 tunnels, 25 replicas, HA connections, and all-plan availability; **UNCLEAR** for a numeric per-tunnel application-session or bandwidth cap because none is published.

## 2. Tunnel automation

**A remotely managed tunnel can be created, configured, routed, and run entirely through API credentials and a tunnel token; the VM does not need `cert.pem`.**

The relevant operations are:

- Create: `POST /accounts/{account_id}/cfd_tunnel`, with `config_src: "cloudflare"`.
- Configure ingress: `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations`.
- Retrieve run token: `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token`.
- Publish public DNS: `POST /zones/{zone_id}/dns_records`, creating a proxied CNAME from the workspace hostname to `<tunnel-id>.cfargotunnel.com`.

A remotely managed tunnel can run with `cloudflared tunnel run --token …` or `--token-file …`; token-file support requires cloudflared 2025.4.0 or later. Locally managed tunnels can instead use the tunnel-specific JSON credentials file. `cert.pem` is an account-management credential used by the older CLI workflow, not a runtime requirement for each VM.

Official sources:

- [Create a Cloudflare Tunnel API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/) — API reference, accessed 2026-08-15
- [Tunnel configuration API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/) — API reference, accessed 2026-08-15
- [Create DNS record API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/) — API reference, accessed 2026-08-15
- [Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/) — updated 2026-05-05
- [cloudflared run parameters](https://developers.cloudflare.com/tunnel/advanced/run-parameters/) — current 2026 documentation
- [Tunnel credential permissions](https://developers.cloudflare.com/tunnel/advanced/local-management/tunnel-permissions/) — updated 2026-04-16

**Status: VERIFIED.**

## 3. cloudflared footprint and reconnect behavior

**Cloudflare does not publish a representative idle RSS or CPU figure for one cloudflared process, but it documents automatic reconnect, exponential backoff, protocol fallback, and four HA connections per replica.**

Cloudflare describes cloudflared as lightweight enough to run on small devices, but its production sizing baseline—four CPU cores and 4 GB RAM for a host handling roughly 4,000 users—is a capacity guideline, not an idle-process measurement.

The default retry setting is five attempts with exponential delays of approximately 1, 2, 4, 8, and 16 seconds for connection or protocol errors. With protocol set to `auto`, cloudflared prefers QUIC and can fall back to HTTP/2 if UDP/QUIC is unavailable. Troubleshooting documentation describes longer QUIC retry backoff up to 64 seconds before fallback. The four HA connections reduce the effect of losing one edge path or data center.

Official sources:

- [cloudflared system requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/system-requirements/) — updated 2026-04-17
- [Tunnel configuration and HA connections](https://developers.cloudflare.com/tunnel/configuration/) — updated 2026-05-21
- [cloudflared run parameters](https://developers.cloudflare.com/tunnel/advanced/run-parameters/) — current 2026 documentation
- [Cloudflare Tunnel troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/) — updated 2026-07-29

**Status: VERIFIED** for reconnect/backoff/fallback; **UNCLEAR** for typical idle memory and CPU because Cloudflare publishes no such benchmark.

## 4. Quick Tunnels

**Quick Tunnels on `trycloudflare.com` are explicitly for testing and development, have no uptime or SLA guarantee, and are not recommended for production.**

Cloudflare applies a hard limit of 200 concurrently in-flight requests; excess requests receive HTTP 429. Server-Sent Events are not supported. Cloudflare also warns that it tests changes on this service, potentially affecting availability. No separate documented requests-per-minute limit was found.

Official source:

- [Quick Tunnels documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) — updated 2026-04-20

**Status: VERIFIED.**

## 5. Cloudflare Origin CA

**Per-host or wildcard Origin CA certificates can be issued with `POST /client/v4/certificates`, using one of seven allowed validity periods, but they are trusted only on the Cloudflare-to-origin leg—not by ordinary browsers connecting directly.**

Allowed validity values, in days, are:

`7`, `30`, `90`, `365`, `730`, `1095`, and `5475`.

Certificates may contain up to 200 SANs. Hostnames must belong to zones in the account; wildcards cover only one label level.

Disabling the proxy or exposing the origin directly causes browser trust errors because Origin CA is not a public browser-trusted CA. Thus it is suitable when traffic remains orange-cloud proxied. Cloudflare does not document an Origin-CA-specific issuance rate limit; the ordinary API limits still apply: 1,200 requests per five minutes per user or account token and 200 requests per second per source IP.

Official sources:

- [Create Origin CA certificate API](https://developers.cloudflare.com/api/resources/origin_ca_certificates/methods/create/) — API reference, accessed 2026-08-15
- [Origin CA certificates](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/) — updated 2026-08-14
- [Cloudflare API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) — updated 2026-04-20

**Status: VERIFIED** for the endpoint, validity periods, SANs, proxy-only trust model, and general API rate; **UNCLEAR** for any separate certificate-issuance rate limit.

## 6. Universal SSL coverage and multi-level hostnames

**Universal SSL covers the zone apex and one-level subdomains, so `ws-abc.example.com` is covered, while `abc.ws.example.com` normally requires an Advanced Certificate or Total TLS.**

On a full Cloudflare DNS setup, the default Universal certificate does not cover multi-level subdomains. Advanced Certificate Manager supports custom hostname coverage, including deeper subdomains, with up to 50 hostnames per advanced certificate. Total TLS—part of Advanced Certificate Manager—automatically issues individual certificates for proxied hostnames.

Total TLS does not automatically issue certificates for hostnames backed by Cloudflare Tunnel, Load Balancing, or Spectrum; a multi-level Tunnel hostname may therefore need a manually ordered Advanced certificate.

Cloudflare’s public plan page currently lists Advanced Certificate Manager at **$10/month**. Total TLS is included with that add-on rather than listed as a separate purchase.

Official sources:

- [Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/) — updated 2026-08-14
- [Advanced Certificate Manager](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/) — updated 2026-06-10
- [Total TLS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/) — updated 2026-04-16
- [Cloudflare plans and add-on pricing](https://www.cloudflare.com/plans/) — accessed 2026-08-15

**Status: VERIFIED.**

## 7. DNS record quotas and API rates

**Current DNS quotas are 200 or 1,000 records on Free depending on zone creation date, 3,500 on Pro and Business, and no per-zone limit on Enterprise, subject to an Enterprise account-wide default of one million public records.**

Current published limits:

| Plan | DNS record quota |
|---|---:|
| Free zone created before 2024-09-01 | 1,000 per zone |
| Free zone created on/after 2024-09-01 | 200 per zone |
| Pro | 3,500 per zone |
| Business | 3,500 per zone |
| Enterprise | No per-zone limit; default 1,000,000 public records per account and separately 1,000,000 internal records |

Enterprise can request higher account limits.

DNS create/delete requests fall under the standard Cloudflare API limit of 1,200 requests per five minutes per user or account token, plus 200 requests per second per IP. Cloudflare does not publish a lower create/delete-specific DNS rate. The DNS batch endpoint can reduce request count for bulk changes.

Official sources:

- [Manage DNS records and quotas](https://developers.cloudflare.com/dns/manage-dns-records/) — updated 2026-08-14
- [Cloudflare API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) — updated 2026-04-20
- [Batch DNS record changes](https://developers.cloudflare.com/dns/manage-dns-records/how-to/batch-record-changes/) — updated 2026-04-16

**Status: VERIFIED** for quotas and general API rates; **UNCLEAR** for a DNS-operation-specific rate because none is documented.

## 8. Workers as WebSocket clients

**A Worker can open an outbound WebSocket to a publicly reachable WSS origin, but open connections remain vulnerable to runtime restarts or isolate eviction, especially without Durable Objects.**

Workers support both `new WebSocket(url)` and `fetch(url, {headers: {Upgrade: "websocket"}})`. Normal Fetch restrictions still apply, including TLS, supported ports, reachability, and same-zone routing rules; “any origin” therefore does not include arbitrary private or prohibited addresses.

Current constraints:

- Maximum WebSocket message size: **32 MiB / 33,554,432 bytes**, not 1 MiB. Messages above this close with code 1009.
- Worker HTTP requests have no fixed wall-clock duration while the client remains connected.
- Runtime updates can terminate in-flight requests after a 30-second grace period.
- Network waits and idle wall time do not consume CPU time. Frame processing and event-handler execution do.
- Standard Workers billing counts the initial upgrade as a request and bills CPU milliseconds; ordinary proxied WebSocket messages are not separately counted as requests.
- Six outbound connections may be simultaneously waiting for response headers per top-level invocation. An outbound WebSocket counts during its handshake, but stops consuming one of those six slots once the upgrade response headers arrive.
- After handshake, Cloudflare says a Worker may maintain many open connections but publishes no numeric per-invocation post-upgrade cap.
- Cloudflare documents an edge idle timeout but does not publish its duration; heartbeat traffic is recommended.

Official sources:

- [Workers WebSocket client example](https://developers.cloudflare.com/workers/examples/websockets/) — updated 2026-04-23
- [Workers WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/) — updated 2026-04-23
- [32 MiB WebSocket message-size changelog](https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/) — published 2025-10-31
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — updated 2026-07-28
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — current 2026 documentation
- [Cloudflare network WebSockets](https://developers.cloudflare.com/network/websockets/) — updated 2026-08-14
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) — current 2026 documentation

**Status: VERIFIED** for outbound capability, 32 MiB messages, handshake limits, CPU accounting, restart risk, and lack of a hard HTTP wall duration; **UNCLEAR** for a numeric edge idle timeout or post-handshake connection cap.

## 9. Same-zone Worker fetches and recursion

**A Worker can fetch a proxied hostname in its own zone, but the default routing may go directly to that zone’s origin rather than back through Cloudflare’s public edge.**

Without `global_fetch_strictly_public`, a same-zone global `fetch()` is optimized directly to the zone origin. It ignores Workers mapped to the destination URL and bypasses Cloudflare security products configured on the public edge.

With `global_fetch_strictly_public`, the request follows public Internet routing. A target hostname with no applicable Worker route can then traverse the Cloudflare edge without Worker recursion. A broad route that also matches the destination can still cause looping or same-zone Worker restrictions.

Error 1000 is chiefly associated with prohibited DNS targets—such as pointing a proxied record at a Cloudflare IP—or attempting to proxy through Cloudflare twice. The more directly relevant Worker-to-Worker same-zone error is **1042** when public fetch behavior is not enabled.

A Worker on `workers.dev` may normally fetch a proxied hostname on an unrelated custom zone because it is an external-zone Fetch, subject to ordinary Fetch restrictions.

Official sources:

- [Workers compatibility flags: `global_fetch_strictly_public`](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) — updated 2026-04-23
- [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) — updated 2026-07-05
- [Cloudflare Error 1000](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1000/) — updated 2026-05-06
- [Workers errors, including 1042](https://developers.cloudflare.com/workers/observability/errors/) — updated 2026-06-16

**Status: VERIFIED.**

## 10. Locking the origin firewall to Cloudflare

**Cloudflare recommends allowlisting its published IP ranges and blocking other origin traffic, but the ranges are infrequently changed rather than immutable.**

Cloudflare publishes changes before putting new ranges into production and provides APIs for retrieving the current lists. Because ordinary ranges are shared across Cloudflare customers, allowlisting them proves the request came from Cloudflare infrastructure, not necessarily from your Cloudflare account.

Dedicated CDN Egress IPs—formerly called Aegis—provide account-exclusive source IPs for Layer 7 CDN/WAF traffic. They are an **Enterprise-only** Smart Shield Advanced feature obtained through the account team; public pricing is not listed.

Official sources:

- [Cloudflare IP address guidance](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/) — updated 2026-04-21
- [Published Cloudflare IP ranges](https://www.cloudflare.com/ips/) — accessed 2026-08-15
- [Dedicated CDN Egress IPs](https://developers.cloudflare.com/smart-shield/configuration/dedicated-egress-ips/) — updated 2026-04-16

**Status: VERIFIED.**

## 11. Cloudflare for SaaS and customer-owned zones

**Cloudflare for SaaS is relevant specifically when customers want workspace hostnames under zones they own; it does not let you mint hostnames in an unrelated zone without that zone owner’s DNS participation.**

A customer typically creates or validates a CNAME from a hostname such as `workspace.customer.com` to the SaaS provider’s fallback origin. If every workspace hostname is under your own zone, ordinary DNS and edge certificates are simpler and Cloudflare for SaaS is generally unnecessary.

Free, Pro, and Business accounts include 100 custom hostnames and allow up to 50,000. Additional hostnames are listed at **$0.10 each**. Enterprise provides custom terms and higher-scale options through sales.

Official sources:

- [Cloudflare for SaaS overview](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/) — updated 2026-04-29
- [Cloudflare for SaaS setup](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/) — current 2026 documentation
- [Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) — updated 2026-08-14

**Status: VERIFIED.**

## 12. Concurrent WebSocket caps

**Cloudflare publishes no general numeric cap on simultaneous WebSocket connections through the edge or across one deployed Worker.**

The documented “six connections” Worker limit applies only to outbound connections simultaneously waiting for response headers during one top-level invocation. An upgraded WebSocket ceases to occupy that slot after its response headers arrive.

Practical limits still arise from the Worker’s 128 MiB isolate memory, CPU allowance, per-invocation work, client disconnections, idle timeouts, and runtime restarts. Cloudflare’s edge WebSocket documentation provides no account-wide, hostname-wide, tunnel-wide, or Worker-wide concurrent-connection ceiling.

Official sources:

- [Workers connection and resource limits](https://developers.cloudflare.com/workers/platform/limits/) — updated 2026-07-28
- [Cloudflare network WebSockets](https://developers.cloudflare.com/network/websockets/) — updated 2026-08-14
- [Workers WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/) — updated 2026-04-23

**Status: UNCLEAR** for a numeric overall concurrent-WebSocket cap; **VERIFIED** that the published six-connection limit is handshake-stage only.

## 10-line design summary

1. Tunnel-per-VM reaches the default account ceiling at 1,000 VMs unless Cloudflare grants a higher Enterprise limit.

2. A tunnel has up to 25 replicas and 100 HA transport connections, but those are not application/WebSocket connection ceilings.

3. Tunnel provisioning is fully automatable; each VM needs only its tunnel token, not an account-wide `cert.pem`.

4. Cloudflare provides no authoritative idle cloudflared CPU/RAM measurement, so fleet footprint must be benchmarked on the intended VM size.

5. Quick Tunnels are unsuitable for production and have a hard 200 in-flight-request limit.

6. Direct `ws-abc.example.com` hostnames fit Universal SSL, while deeper hostname structures add certificate-management cost and complexity.

7. Direct per-VM DNS scales to 200/1,000 Free records or 3,500 Pro/Business records per zone before needing more zones or Enterprise.

8. Origin CA works well for orange-cloud traffic but does not make a directly exposed VM endpoint browser-trusted.

9. A same-zone Worker fetch may bypass Cloudflare security by default; `global_fetch_strictly_public` is important if the edge must remain in the data path.

10. A stateless Worker can proxy long-lived WebSockets, but runtime restarts or isolate eviction require robust browser and gateway reconnection logic.