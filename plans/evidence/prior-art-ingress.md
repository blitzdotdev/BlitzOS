| Product | Ingress mechanism | Inbound or outbound from workspace? | Auth handoff | Evidence |
|---|---|---|---|---|
| **1. Coder OSS** | Browser → `coderd` or customer-operated regional `wsproxy` → Coder Tailnet/WireGuard → direct peer or DERP relay → workspace agent. Browser traffic normally uses the proxy; native clients can establish P2P. | **Outbound-only agent.** The workspace daemon dials the control plane; no workspace ingress port is required. | Normal Coder session authorizes a narrowly scoped signed workspace-app token (“app ticket”), usually stored in path- or wildcard-subdomain-specific cookies. | [Agent connection path](https://coder.com/docs/ai-coder/agents/architecture), [workspace proxies](https://coder.com/docs/admin/networking/workspace-proxies), [app-ticket implementation](https://pkg.go.dev/github.com/coder/coder/v2/coderd/workspaceapps) |
| **2. Gitpod Classic / Flex (Ona)** | **Classic:** regional `ws-proxy`, wildcard workspace/port hosts, plus an SSH gateway. **Flex/Ona:** runner-local gateway proxy behind a managed AWS/GCP load balancer; proxy routes to environment VMs. | **Inbound on the private workspace network.** The proxy connects to workspace pods/VM ports; services must bind `0.0.0.0`. Separate management-plane egress is also required. | Classic private ports use Gitpod browser credentials/cookies. Flex/Ona sends browsers through `/auth/port/start`, which creates a port-access session and enforces creator/org/everyone admission. | [Classic `ws-proxy` source](https://github.com/gitpod-io/gitpod/blob/main/components/ws-proxy/pkg/proxy/proxy.go), [classic port URLs](https://ona.com/docs/classic/user/configure/workspaces/ports), [current port sharing](https://ona.com/docs/ona/integrations/ports), [runner LB architecture](https://ona.com/docs/ona/runners/gcp/reference-architectures) |
| **3. GitHub Codespaces** | GitHub Codespaces TLS tunnel for IDE/terminal plus Microsoft Dev Tunnels-derived port forwarding; previews use `CODESPACENAME-PORT.app.github.dev`. Microsoft explicitly lists Codespaces as a Dev Tunnels user. | **Outbound/service tunnel.** Direct Internet ingress to the VM is firewalled off. Exact Codespaces-specific relay topology is **NOT PUBLIC**. | Main connection: GitHub identity, creator only. Private preview: GitHub login and a three-hour cookie; non-browser clients can send `X-Github-Token`. Public previews are unauthenticated. | [Codespaces security](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces), [Microsoft Dev Tunnels FAQ](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/faq), [port forwarding](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace) |
| **4. Google Cloud Workstations** | Google-managed regional workstation-cluster gateway → Private Service Connect → per-VM “VM Gateway” → workstation container. Addresses are per-workstation/per-port subdomains. | **Workspace-initiated pull.** The VM Gateway pulls traffic from the cluster gateway; no public VM endpoint is needed. | Google login or authentication header plus `workstations.workstations.use` IAM. Google’s gateway authenticates and converts client HTTPS to HTTP at the workstation. | [Architecture](https://docs.cloud.google.com/workstations/docs/architecture), [HTTP port access](https://docs.cloud.google.com/workstations/docs/access-http-servers-running-on-workstations), [`host` API semantics](https://docs.cloud.google.com/workstations/docs/reference/rpc/google.cloud.workstations.v1) |
| **5. Modal** | Modal-operated private global fleet of Internet relays. The container connects to its nearest relay; browser receives a random `*.modal.host` TLS endpoint. | **Outbound tunnel from container.** | The random URL is a bearer capability and is public to anyone who knows it. Modal adds no application authentication; examples add an application token such as Jupyter’s query token. | [Modal Tunnels](https://modal.com/docs/guide/tunnels) |
| **6. E2B** | Load balancer → stateless `client-proxy` → Redis sandbox-to-node lookup → node orchestrator proxy → Firecracker VM slot IP/port. Current URLs are `https://<port>-<sandboxID>.e2b.app`. | **Inbound on the E2B private data plane.** No sandbox-initiated tunnel and no public per-VM IP. | Arbitrary ports may be public; restricted sandboxes use a per-sandbox `trafficAccessToken`. Process/files/PTTY APIs through `envd` separately require `X-Access-Token`; file URLs can be signed. | [Infrastructure architecture](https://github.com/e2b-dev/infra/blob/main/docs/ARCHITECTURE.md), [current URL format](https://e2b.dev/docs/api-reference/sandboxes/get-sandbox), [secured controller access](https://e2b.dev/docs/sandbox/secured-access) |
| **7. Daytona** | Daytona preview reverse proxy using `https://<port>-<sandboxID>.<proxy-domain>`; self-hosted deployments contain separate Proxy, Runner, and SSH Gateway services. | **Inbound from proxy to sandbox port.** Hosted fleet topology beyond the documented proxy is **NOT PUBLIC**. | Standard preview token in `x-daytona-preview-token`; alternatively a short-lived signed token embedded in the hostname. Public sandboxes need neither. | [Preview URLs and tokens](https://www.daytona.io/docs/en/preview/), [custom preview proxy](https://www.daytona.io/docs/en/custom-preview-proxy/), [OSS deployment](https://www.daytona.io/docs/en/oss-deployment/) |
| **8. Replit** | Replit-operated regional reverse proxies. IDE/session traffic uses the Eval WebSocket proxy → Conman VM → Repl. Port previews use `replit.dev` proxy → VM-local proxy → in-Repl “Port Authority.” | **Inbound on Replit’s private network.** The published design is reverse-proxying, not an outbound workspace tunnel. Exact post-2024 implementation is **NOT PUBLIC**. | IDE bootstrap returns an Eval URL plus token. Development URLs are public by default; private URLs require Replit authentication for owner/authorized team members. Exact private-preview cookie format is **NOT PUBLIC**. | [Eval architecture](https://replit.com/blog/eval), [port-proxy path](https://replit.com/blog/ports), [current development URLs](https://docs.replit.com/core-concepts/project-editor/app-setup/development-urls) |
| **9. VS Code Remote Tunnels** | Microsoft Dev Tunnels: host and client connect to an Azure-hosted nearest-region relay. `vscode.dev/tunnel/<machine>/<folder>` fronts VS Code Server; an SSH session runs through the relay tunnel. | **Outbound-only on both ends.** No listener or firewall change on the remote machine. | Same GitHub or Microsoft account at both ends; SSH supplies additional end-to-end encryption. Generic Dev Tunnel ports can also use tenant/org ACLs, anonymous access, or a 24-hour tunnel-scoped header token. | [VS Code Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels), [Dev Tunnels overview](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/overview), [security/auth](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security) |
| **10. Cloudflare Sandbox / Containers** | Preferred current Sandbox path: `cloudflared` inside the sandbox → persistent QUIC connection → Cloudflare edge; quick `*.trycloudflare.com` or named custom-zone URL. Worker-fronted proxying remains an alternative. | **Outbound-only for `sandbox.tunnels`.** Worker-fronted Container/Sandbox requests instead enter through Cloudflare’s internal Worker/Durable Object path. | Quick tunnels and Worker preview URLs are public by default. Named/custom URLs can be protected separately; Worker-fronted paths let application code perform auth. Sandbox terminal auth is developer-defined. | [Sandbox Tunnels API](https://developers.cloudflare.com/sandbox/api/tunnels/), [expose-services guidance](https://developers.cloudflare.com/sandbox/guides/expose-services/), [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), [terminal path](https://developers.cloudflare.com/sandbox/concepts/terminal/) |

This is a snapshot as of **August 15, 2026**. “Outbound” refers specifically to establishing the browser/workspace data path, not ordinary package-download or management-plane egress.

## Product details

### 1. Coder

- Web terminal, IDE, SSH, files, agent tools, and port forwarding all ultimately traverse the workspace agent’s Tailnet connection. Coder explicitly describes web terminal as WebSocket, IDE as SSH, and agent/files as the daemon’s HTTP API over the same tunnel. [Coder agent architecture](https://coder.com/docs/ai-coder/agents/architecture)

- Native clients try STUN-assisted direct WireGuard connectivity. When that fails, traffic crosses a DERP relay. Browsers cannot participate in that direct network path, so `coderd` or a selected `wsproxy` relays their traffic. [Networking](https://coder.com/docs/admin/networking), [workspace proxies](https://coder.com/docs/admin/networking/workspace-proxies)

- `wsproxy` is a deployable Coder component, normally placed regionally by the customer. It has its own wildcard app domain and authenticates to primary `coderd` with a unique proxy session token. This is a self-operated relay fleet, not a built-in commercial CDN.

- Workspace-app authorization is unusually well documented: the ordinary user session mints a signed, app-scoped token; wildcard applications use proxy-specific cookie names to avoid leaking or confusing cookies across proxy domains. [Open-source app-ticket implementation](https://pkg.go.dev/github.com/coder/coder/v2/coderd/workspaceapps)

### 2. Gitpod Classic and Flex/Ona

- Classic `ws-proxy` source describes `WorkspaceProxy` as forwarding “all inbound requests to the relevant workspace pods.” Port 3000, for example, appeared at `3000-workspace.ws-region.gitpod.io`. [Proxy source](https://github.com/gitpod-io/gitpod/blob/main/components/ws-proxy/pkg/proxy/proxy.go), [classic ports](https://ona.com/docs/classic/user/configure/workspaces/ports)

- Classic private ports require workspace access and browser credentials; cross-origin JavaScript must set `credentials: "include"`. Public ports bypass that check. SSH and JetBrains connections also entered through `ws-proxy`/SSH Gateway rather than an SSH daemon publicly exposed by each pod.

- The Flex-era product, now documented as Ona, keeps the reverse-proxy model but moves it into the regional runner. External mode is cloud LB → runner gateway proxy → environment VM; internal mode is corporate VPN/Interconnect → internal LB → proxy. [GCP reference architectures](https://ona.com/docs/ona/runners/gcp/reference-architectures)

- This is conclusively not an outbound-only tunnel: Ona says services must bind `0.0.0.0`, and localhost-only services fail because the “port-sharing proxy connects from outside the loopback interface.” Authenticated ports use the `/auth/port/start` browser-session flow. [Port-sharing details](https://ona.com/docs/ona/integrations/ports)

### 3. GitHub Codespaces

- GitHub calls the primary path a “TLS encrypted tunnel provided by the GitHub Codespaces service.” Its VM firewall blocks Internet ingress and allows outbound traffic. [Security architecture](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces)

- Microsoft’s Dev Tunnels documentation explicitly lists GitHub Codespaces as a consumer, and current Codespaces connectivity requires allowing `*.visualstudio.com`. Thus “Dev Tunnels-derived service” is well supported; the Codespaces-specific relay placement and protocol extensions remain **NOT PUBLIC**. [Dev Tunnels FAQ](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/faq), [Codespaces connection troubleshooting](https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-your-connection-to-github-codespaces)

- Forwarded ports terminate at `*.app.github.dev`, not on the VM. Private, organization, and public visibility are independent of the main creator-only IDE connection. [Port forwarding](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)

- Auth handoff is concrete: a private browser preview gets a three-hour auth cookie; API clients use the codespace’s `GITHUB_TOKEN` in `X-Github-Token`. Public ports intentionally remove auth.

### 4. Google Cloud Workstations

- Each regional workstation cluster contains a Google-managed controller and gateway. The gateway selects a workstation from the hostname, while Private Service Connect supplies the managed-service-to-VPC path. [Architecture](https://docs.cloud.google.com/workstations/docs/architecture)

- A gateway process on the VM “pulls client traffic” from the cluster gateway, authenticates and authorizes it, then forwards to the workstation container. Required VM-to-control-plane egress is TCP 980 and 443. [Firewall requirements](https://docs.cloud.google.com/workstations/docs/configure-firewall-rules)

- Default endpoints are `https://PORT-WORKSTATION.CLUSTER.cloudworkstations.dev`. Google documents that clients send HTTPS but authorized traffic reaches the workstation as HTTP, confirming TLS termination before the application container. [API reference](https://docs.cloud.google.com/workstations/docs/reference/rpc/google.cloud.workstations.v1)

- Authentication is Google identity plus IAM, delivered as a cookie or authentication header. Custom domains may add an Application Load Balancer and optional IAP, but Workstations’ own IAM authorization remains.

### 5. Modal

- Modal operates a private global network of relays. At container startup, `modal.forward` connects to the nearest relay and receives a random `*.modal.host` endpoint. This is a genuine per-container outbound tunnel over a shared relay fleet. [Modal Tunnels](https://modal.com/docs/guide/tunnels)

- TLS is terminated automatically, but Modal treats the result as an L4 TCP stream: no HTTP header injection and no HTTP/2 translation. Unencrypted raw TCP is also available through a random relay port.

- The random hostname is cryptographically difficult to guess but is still public. Modal’s own Jupyter example adds a Jupyter token because the tunnel does not hand off a Modal user session.

### 6. E2B

- E2B publishes one of the clearest implementations: wildcard LB → `client-proxy` → Redis routing catalog → node’s orchestrator proxy on port 5007 → sandbox slot IP through veth/tap networking. [Architecture source](https://github.com/e2b-dev/infra/blob/main/docs/ARCHITECTURE.md)

- The client proxy terminates the `<port>-<sandboxID>` HTTPS endpoint. It can auto-resume a paused sandbox, update the route, and retry without the browser knowing which physical node owns the VM.

- The user’s `.e2b.dev` example reflects older branding; current documentation says to construct `https://{port}-{sandboxID}.e2b.app`. [Current API reference](https://e2b.dev/docs/api-reference/sandboxes/get-sandbox)

- E2B separates arbitrary application-port auth from controller auth: restricted public traffic uses `trafficAccessToken`, while files/processes/PTTY through `envd` use `X-Access-Token` or signed file URLs. [Create response](https://e2b.dev/docs/api-reference/sandboxes/create-sandbox), [secure access](https://e2b.dev/docs/sandbox/secured-access)

### 7. Daytona

- Browser previews use a Daytona proxy domain rather than a public sandbox endpoint. WebSockets are explicitly supported, and web terminal traffic uses reserved port `22222` through the same preview mechanism. [Preview docs](https://www.daytona.io/docs/en/preview/), [custom proxy](https://www.daytona.io/docs/en/custom-preview-proxy/)

- Standard private URLs retain the sandbox ID in the hostname and require `x-daytona-preview-token`; that token rotates when the sandbox restarts.

- Signed previews replace the sandbox ID with a time-limited token in the hostname. They are intended for browsers and iframes that cannot set headers and can expire between one second and 24 hours.

- Self-hosted Daytona documents distinct Proxy, Runner, and SSH Gateway services, supporting a private reverse-proxy path. The number and geographic layout of Daytona Cloud’s hosted proxies is **NOT PUBLIC**.

### 8. Replit

- Replit’s documented IDE path uses a dedicated regional reverse-WebSocket service called Eval. The web tier returns an Eval URL and token; Eval locates the VM, connects to Conman, and copies WebSocket data for the session. [Eval design](https://replit.com/blog/eval)

- This replaced the older system where Conman VMs doubled as both workspace hosts and reverse proxies. The published migration was therefore to a dedicated proxy fleet—not to public per-VM endpoints.

- Preview traffic follows a different but still proxied path: `replit.dev` proxy → target VM → VM-local proxy → “Port Authority” inside the Repl. Port Authority makes even explicitly exposed localhost-only services reachable. [Port Authority](https://replit.com/blog/ports)

- Current development URLs are temporary `UUID.servername.replit.dev` hosts, public by default and optionally account-authenticated. I found no official evidence that Replit used WebRTC for workspace ingress; every published architecture found here uses WebSockets. [Current URL behavior](https://docs.replit.com/core-concepts/project-editor/app-setup/development-urls)

### 9. VS Code Remote Tunnels

- VS Code Remote Tunnels is explicitly built on Microsoft Dev Tunnels. The remote host and browser/desktop client both dial an Azure-hosted relay; the service chooses the nearest available region. [VS Code docs](https://code.visualstudio.com/docs/remote/tunnels), [relay overview](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/overview)

- The remote machine gets no listener or public address. VS Code then establishes SSH through the relay, providing end-to-end encryption beyond the relay transport.

- Host and client normally authenticate using the same GitHub or Microsoft account. Generic Dev Tunnel web forwarding terminates TLS at Microsoft’s service ingress and can accept OAuth, tenant/org ACLs, anonymous access, or a tunnel-scoped `X-Tunnel-Authorization` token. [Dev Tunnel security](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security)

- It is not an unlimited production transport: VS Code currently allows ten registered tunnels; Microsoft also applies tunnel, bandwidth, port, connection, and request-rate quotas.

### 10. Cloudflare Sandbox and Containers

- Current stable Sandbox guidance prefers `sandbox.tunnels`: the SDK launches `cloudflared` inside the container and creates a persistent QUIC connection to Cloudflare’s edge. Quick tunnels are random; named tunnels bind stable customer-zone hostnames. [Tunnels API](https://developers.cloudflare.com/sandbox/api/tunnels/)

- This current guidance changes the classification from the older Worker-fronted-only model: outbound Cloudflare Tunnel is now the preferred public-URL path, while `exposePort`/`proxyToSandbox` remains useful when a Worker must inject authentication or rewrite responses. [Expose-services guide](https://developers.cloudflare.com/sandbox/guides/expose-services/)

- Quick tunnels and basic preview URLs are public by default. Authentication is not automatically inherited from the Worker or Cloudflare account; the application, Worker, or separately configured Zero Trust policy must enforce it.

- Terminal sessions remain Worker-fronted: browser terminal → WebSocket → Worker → Sandbox/Container PTY. General Cloudflare Containers likewise receive HTTP/WebSocket requests through a Worker and Durable Object, not a per-container public socket. [Terminal architecture](https://developers.cloudflare.com/sandbox/concepts/terminal/), [Container architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)

## Patterns that dominate the industry

- **Shared regional proxies/relays dominate.** Per-workspace hostnames are primarily routing keys into a shared data plane—not DNS records pointing at public workspace NICs.

- **Outbound agent tunnels dominate BYOC and firewall-sensitive designs.** Coder, Codespaces/Dev Tunnels, Cloud Workstations, Modal, VS Code Remote Tunnels, and current Cloudflare Sandbox tunnels all avoid direct public ingress. This strongly supports your **per-VM tunnel plus regional relay** candidate.

- **Private reverse proxies dominate when the vendor owns the compute substrate.** Classic/current Gitpod, E2B, Daytona, and Replit accept proxy traffic over private pod/VM networking. This strongly supports a **regional reverse-proxy fleet plus routing catalog** when you control both proxy and workspace networks.

- **An edge/CDN is a front door, not the workspace-routing architecture.** Cloudflare can supply both. Other vendors commonly use cloud load balancers/backbones underneath vendor-operated proxies, but the application-layer routing catalog, wake/resume logic, WebSocket handling, and auth remain specialized services.

- **Direct per-VM public TLS endpoints have almost no support in this sample.** None of the ten clearly places the browser-facing certificate and listener directly on a publicly addressable workspace VM. That design creates certificate rotation, DDoS exposure, wake/resume routing, IP churn, and firewall problems without an evident industry benefit.

- **Meshes are useful mainly for native clients.** Coder’s Tailscale/WireGuard Tailnet is the clearest example: native clients may go P2P, but browsers still enter through `coderd`/`wsproxy`. A mesh is therefore an optimization alongside browser relays, not a replacement for them.

- **WebRTC is not a demonstrated winner here.** I found no confirmed WebRTC workspace-ingress design among the ten. Long-lived WebSockets, QUIC/HTTP2 tunnels, raw TCP relays, and WireGuard are the published choices.

- **Best-supported hybrid design:** browser → global/edge TLS and auth → nearest regional HTTP/WebSocket proxy → routing catalog. From there, use either an outbound multiplexed workspace agent for BYOC/untrusted networks or direct private-IP proxying when you own the substrate. Mint short-lived, app-scoped cookies/tickets for normal access and separately support explicit, expiring capability URLs for sharing.