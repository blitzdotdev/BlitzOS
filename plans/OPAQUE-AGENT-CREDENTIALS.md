# Opaque agent credentials — keep upstream secrets out of workspace guests

Status: **design options draft, 2026-09-02.** This document does not lock a
product decision. It identifies the approaches that can actually prevent an
agent with arbitrary shell access from learning a provider credential, rejects
the ones that only move plaintext around, and recommends a target architecture
for discussion.

The short answer is: **make a trusted component own the authenticated network
connection and give the workspace only an opaque, constrained lease.** That can
be generic for declared HTTP bearer tokens. It cannot be transparent to every
unmodified client or to an arbitrary secret whose use Blitz does not understand.
Those cases need a protocol adapter, a typed operation, or a fail-closed refusal.

This document uses three distinct terms:

- **upstream secret** — the provider token, PAT, bot token, refresh token, or
  static org value the user entrusted to Blitz;
- **opaque capability** — a short Blitz-issued value accepted only by a Blitz
  gateway and constrained to a particular actor, target, and policy;
- **zero guest credential material** — the stronger property that the guest
  receives neither of those, including no portable Blitz machine bearer.

An opaque lease satisfies upstream-secret non-disclosure, not literal zero
credential material: the lease is itself a bearer capability and is present in
plaintext. The recommended baseline targets the upstream secret. Section 5
also describes the stronger host-gateway variant for deployments that cannot
accept any portable bearer in the guest.

This work is independent of deleting the legacy credential broker. It does not
justify keeping the broker daemon, its SSH custody path, or its Claude/Codex
overrides. The schema-free machine-auth helper may mint a control-plane bearer;
the provider secret stays in a control-plane or host-side capability gateway.

## 0. The hard constraint

A bearer token is useful because possession is enough to use it. If an
unmodified client must send a provider bearer token, that client must receive
the token bytes. A keyring, environment variable, file descriptor, credential
helper, shorter lifetime, or redacted transcript does not change that fact.

For an arbitrary workspace process, there are only three real choices:

1. **The guest receives the provider token.** The plaintext-prevention goal is
   not met.
2. **A trusted component outside the guest owns the transport.** The guest
   receives an opaque capability and asks that component to make the request.
3. **The provider accepts a different proof.** A non-exportable private key can
   sender-constrain a token, or the provider can mint a narrow delegated
   credential. This is valuable where supported, but it is not universal.

If none applies, Blitz must refuse the operation. There is no fourth mechanism
that both preserves arbitrary bearer-token clients unchanged and prevents those
clients from reading the bearer token.

This is the same property described by
[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html): a bearer token is usable
by any party in possession of it. Proof-of-possession mechanisms such as
[DPoP](https://www.rfc-editor.org/rfc/rfc9449.html) and
[OAuth mTLS](https://www.rfc-editor.org/rfc/rfc8705.html) reduce replay by
requiring a key as well, but only when the authorization server and resource
server implement them.

## 1. What reaches an agent today

`POST /agent/credentials/:name/token` has two materially different outcomes:

- an org credential is decrypted and returned as both `token` and `env.value`
  (`core/agent-routes.ts:184-209`);
- a connection delegates to `mintOne`, which returns either the real provider
  secret or an opaque lease according to the provider's custody mode
  (`core/connections/minters/grant.ts:59-98`).

The built-in providers currently split this way:

| Provider or secret | Current delivery | Does upstream plaintext enter the guest? |
|---|---|---|
| GitHub | `cp` / inject | Yes: user access token or pasted PAT |
| Discord | `cp` / inject | Yes: bot token |
| Linear | proxy | No: opaque lease token |
| Google Workspace | proxy | No: opaque lease token |
| YouTrack | proxy | No: opaque lease token |
| Any org credential (`GH_PAT`, `*_API_KEY`, etc.) | raw `token` + `env` | Yes: stored value |

The list route is names-only and access is server-filtered. That prevents
accidental disclosure while browsing, but it is not a confidentiality boundary:
the same machine bearer can call the token route. Lody, Codex, and interactive
terminals run as the same `blitz` Unix user, which can also read the mode-0600
machine access/refresh pair. Once a permitted raw value is serialized to the
guest, arbitrary same-user code can print it, save it, inspect a child process,
or send it elsewhere.

Existing controls remain valuable:

- the machine's active membership is resolved at call time;
- connection use requires workspace membership plus the workspace manifest;
- a personal provider grant belongs to the acting member, never implicitly to
  the workspace owner;
- org credential reads require a covering org, workspace, or membership grant
  (and org admins implicitly read all org credentials);
- credentials are AES-256-GCM sealed at rest;
- mints, denials, revocations, and org-credential reads write metadata audit
  events;
- machine access tokens live for 15 minutes and refresh tokens rotate.

Those controls answer **who may use a secret**. They do not answer **whether an
authorized agent may learn its bytes**.

## 2. Goal, adversary, and non-goals

### Goal

After migration, no provider token, refresh token, PAT, bot token, or org token
value intended for agent use crosses into a managed workspace guest. The guest
may hold an opaque capability that authorizes constrained operations through a
Blitz gateway, but that value is not accepted by the upstream provider.

The optional stronger profile also removes the guest-readable machine bearer
and opaque lease. A separately privileged host gateway authenticates over a
local channel and holds every portable credential. This profile can authorize
the workspace as a whole; distinguishing individual agents additionally
requires separate Unix identities, namespaces, or supervisor-issued channels,
because all current sessions share the `blitz` UID.

### Adversary

Assume an agent or repository process can:

- run arbitrary commands and binaries as `blitz`;
- read every same-user file, environment, argument, pipe, and `/proc` surface
  the kernel permits;
- invoke credential helpers directly and call documented or discovered
  control-plane routes;
- inspect its own traffic before TLS and make arbitrary outbound requests;
- encode output to bypass simple secret-pattern redaction;
- keep any opaque lease it receives and exercise every operation that lease
  authorizes.

Assume it cannot compromise the control-plane runtime, the provider, TLS, or a
separately privileged host service. A malicious provider is out of scope: a
provider that already knows its own token can deliberately reflect it in a
response. Accidental reflection must still be tested and redacted where
possible.

### Non-goals

- Preventing an authorized agent from seeing the provider data it requested.
- Making an opaque capability harmless. A stolen live lease can still perform
  its allowed actions through Blitz until it expires or is revoked.
- Hiding credentials from the trusted control plane or its master key.
- Preserving every existing third-party CLI unchanged. Hard-coded TLS origins
  are a compatibility constraint, not permission to fall back to plaintext.
- Treating a shorter-lived upstream token as “not plaintext.” It is still an
  upstream credential while live.

## 3. Required invariants

1. **No upstream secret in the guest.** Agent responses, environment, argv,
   files, helper stdout, logs, and packet captures contain only opaque Blitz
   capabilities.
2. **The gateway owns authentication.** It decrypts or refreshes the provider
   secret only after authorizing a request and injects it only into the outbound
   provider request.
3. **No arbitrary forward proxy.** Every lease is pinned to a provider,
   normalized HTTPS origin, credential version, member, machine, workspace,
   allowed transport, and policy ceiling.
4. **Live authorization.** Membership, grants, connection state, and workspace
   manifest are rechecked for every use, not only when the lease is minted.
5. **Fail closed.** Unknown transports, unsupported clients, invalid redirects,
   missing metadata, and old raw-delivery clients get a clear refusal. There is
   no `allowRaw` escape hatch on managed machines.
6. **Revocation is effective.** Disconnect, grant removal, membership removal,
   credential rotation, machine destruction, and lease expiry stop the next
   gateway request.
7. **Secrets never enter durable telemetry.** Request bodies, authentication
   headers, decrypted values, and upstream refresh responses are excluded from
   logs and audit events.
8. **Use is attributable.** Every gateway call records member, machine,
   workspace, connection, normalized operation, response status, and timing,
   without request/response bodies or tokens.
9. **Previously exposed credentials are rotated.** Stopping future delivery
   does not make old PATs, bot tokens, or copied org values secret again.

## 4. Options

| Option | Keeps provider plaintext out of guest? | Compatibility | Universal? | Role |
|---|---:|---|---|---|
| Control-plane capability proxy + opaque lease | Yes | Good when base URL or transport is adaptable | Generic for declared HTTP tokens; adapters elsewhere | **Recommended core** |
| Typed provider actions / connector service | Yes | Agent calls Blitz operations, not vendor CLI | No; operations are implemented deliberately | Recommended high-assurance layer |
| Privileged host-side transport gateway | Yes, if it owns TLS and is outside guest UID | Can serve local sockets and streaming protocols | Same protocol limits as remote proxy | Optional data plane |
| Provider-issued delegated or sender-constrained token | Usually the agent still sees a token; replay is reduced | Provider-dependent | No | Defense in depth |
| Allowlisted command runner with hidden env | Only for a closed, trusted command set | Poor for arbitrary tools and plugins | No | Narrow special cases only |
| Keyring, memfd, pipe, credential helper, or ephemeral env | No | High | Yes, but fails the goal | Reject as confidentiality control |
| Transparent HTTPS interception | A proxy can hide the upstream token | Broad until pinning/custom TLS breaks | Not reliably | Reject |
| Output redaction, scanners, or per-use approval | No | High | Broad | Defense in depth only |

### Option A — expand the existing opaque-lease proxy

This is the shortest path because Linear, Google Workspace, and YouTrack
already use the right custody property. `mintFromGrant` creates a random lease
token, persists only its hash, and the proxy substitutes the real grant secret
after validating the lease. Extend that model until `custody: "cp"` and raw org
credential reads no longer exist.

The generic unit is not “an environment variable.” It is a **token connection
descriptor**:

```yaml
name: example
transport: https
origins:
  - https://api.example.com
authentication:
  placement: header        # header | basic-password | query | form
  name: Authorization
  prefix: "Bearer "
policy:
  methods: [GET, POST]
  pathPrefixes: [/v1/]
  maxRequestBytes: 1048576
  maxResponseBytes: 8388608
```

The control plane validates the descriptor when a person creates the
connection. The agent cannot supply or override an origin, authentication
placement, header name, or redirect destination when it uses a lease.

Strengths:

- one implementation covers conventional bearer headers, API-key headers,
  Basic-password tokens, and legacy query/form tokens;
- rotation and revocation take effect without changing the guest;
- the upstream refresh token and access token both remain encrypted in the
  control plane;
- an opaque lease may safely be returned by existing env-oriented interfaces,
  provided the corresponding base URL points to Blitz rather than the vendor;
- current grant, manifest, lease, and audit concepts remain usable.

Limits:

- a client with a hard-coded vendor origin must be configured, wrapped, or
  replaced;
- a standard HTTP `CONNECT` proxy cannot inject a header into end-to-end TLS;
  doing so requires TLS interception;
- WebSocket credentials sent inside frames, challenge/response registry auth,
  database handshakes, SSH, and vendor-specific signing need adapters;
- a generic path proxy authorizes everything the upstream token and path policy
  allow. Typed actions can narrow that further.

### Option B — typed actions over the same custody layer

Expose provider operations such as `github.create_pull_request`,
`calendar.create_event`, or `discord.send_message`. The agent supplies typed
arguments; trusted code constructs the provider request and injects the secret.

This produces the best authorization, validation, and audit boundary. It also
avoids giving a generic proxy enough freedom to reach every endpoint a broad
token can reach. The cost is explicit provider and operation coverage. It should
be layered over the same grants, refresh logic, and gateway egress code rather
than becoming a second secret system.

A generic HTTP action may be offered for low-risk connections, but it must still
take a connection name plus a relative path. Accepting an arbitrary URL would
turn credential custody into an SSRF and credential-forwarding service.

### Option C — privileged host-side transport gateway

Put a small gateway outside the workspace guest or at least outside the
`blitz` UID. The agent talks to a Unix socket or loopback endpoint with an opaque
lease; the gateway retrieves the provider secret and owns the upstream TLS
connection.

This is useful for long-lived WebSockets, Git smart HTTP, large uploads, or
providers that exceed a Worker runtime's streaming limits. It is not useful if
the local service merely returns a token to the caller. It must own the
transport. Running it as `blitz` would also fail the threat model because the
agent could inspect or debug it as the same Unix user.

This is not a resurrection of the credential broker. It has no per-user SSH
homes, Claude/Codex token custody, provider-selection override, or token-printing
command. It accepts only control-plane-issued capabilities and fixed transport
requests.

### Option D — provider-native delegation and proof of possession

Prefer provider-native narrow credentials where available:

- OAuth token exchange can mint audience- and scope-specific delegated tokens
  ([RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html));
- DPoP and OAuth mTLS bind tokens to a private key;
- GitHub App installation tokens expire after one hour and can be limited to
  selected repositories and permissions
  ([GitHub documentation](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)).

These reduce blast radius. They do not universally meet the stated goal. A
short-lived bearer remains plaintext, and sender constraint works only if the
private key is inaccessible to the guest and the provider verifies it. If a
host gateway holds that key and owns requests, this becomes an additional
gateway control rather than an alternative.

Changing GitHub from user-to-server tokens to installation tokens also changes
commit and API attribution from the member to the App. That is a product choice,
not a transparent security upgrade.

### Option E — command runner, secret handles, and redaction

A supervisor can launch `gh` with `GH_TOKEN` set while hiding the value from the
model's initial prompt. That prevents accidental model disclosure, but an agent
allowed arbitrary commands can ask the supervisor to run `env`, use a CLI hook,
read `/proc`, or make the child print or upload the value. An allowlisted command
runner is defensible only for a small audited command/argument grammar with no
plugin, shell, config-exec, or arbitrary-file escape.

OS keyrings, Docker/Git credential helpers, anonymous pipes, sealed memfds, and
short-lived environment variables have the same limitation: the consumer
eventually receives the bearer. Git's credential-helper protocol explicitly
returns a username/password to Git
([Git documentation](https://git-scm.com/docs/gitcredentials.html)). A helper is
safe here only when the “password” it returns is an opaque Blitz lease accepted
by a Blitz Git gateway.

Transcript redaction, exact-secret log filters, shell-history suppression, and
per-use user confirmation are worthwhile backstops. None prevents deliberate
encoding or network exfiltration after plaintext delivery.

### Option F — transparent TLS interception

A forced forward proxy could install a private CA in the guest, terminate every
TLS connection, and inject provider authentication while preserving hard-coded
hostnames. Reject this design:

- it makes Blitz a universal TLS man-in-the-middle for the workspace;
- certificate pinning, custom trust stores, QUIC, SSH, and non-HTTP protocols
  bypass or break it;
- every new origin becomes a credential-forwarding policy problem;
- a proxy or CA compromise exposes all workspace traffic, not one connection;
- debugging becomes indistinguishable from a network attack.

Explicit gateway URLs and protocol adapters are less magical and fail safely.

## 5. Recommended target architecture

```text
                              control-plane trust domain
                           +-----------------------------+
agent -- machine bearer -->| lease issuer                |
                           |  live member/grant/manifest |
                           +-------------+---------------+
                                         |
                                  opaque lease only
                                         v
agent/client ------------------> capability gateway ----------------> provider
 relative operation + lease       validate every request              real token
                                  decrypt/refresh at last moment       added here
```

Use one authorization model and two execution surfaces:

1. **Generic capability gateway** for declared HTTP token connections and
   protocols with a bounded adapter.
2. **Typed action gateway** for high-risk operations and clients that cannot
   safely target the generic gateway.

The gateway may run at the control-plane edge for bounded HTTP calls and in a
separate streaming service for Git, large bodies, and long-lived WebSockets.
Both consume the same signed/hashed lease semantics and the same live
authorization decisions. No provider secret is cached on a workspace VM.

For the stronger **zero guest credential material** profile, replace both
bearer-bearing arrows with a host-owned gateway outside the guest trust domain:

```text
agent/client --> local Unix socket --> privileged host gateway --> provider
                  no portable token     machine identity + lease   real token
```

The host gateway holds the machine access/refresh pair, obtains or represents
the lease server-side, and owns upstream TLS. The guest's authority is its
ability to reach the socket, not a value it can copy off the machine. This
requires replacing `blitz-cred api-token` and direct `/agent/*` curl for managed
guests. Merely moving those same printable values into a daemon running as
`blitz` does not meet the stronger profile.

### Lease shape

Replace the ambiguous token response with an explicit capability response:

```json
{
  "name": "github",
  "mode": "proxy",
  "lease": {
    "id": "non-secret-row-id",
    "token": "opaque-random-capability",
    "endpoint": "https://control-plane.example/capabilities/<id>",
    "expiresAt": 0
  },
  "adapters": ["http", "git-smart-http"]
}
```

The lease token needs at least 256 bits of entropy and is stored only as a
hash. It is still sensitive: possession authorizes operations through Blitz.
Use a short default lifetime, one live lease per machine/connection, explicit
revocation, rate limits, and optional host-held proof of possession to prevent
off-machine replay. Never describe it as harmless merely because the vendor
does not accept it.

### Request boundary

For every request, the gateway must:

1. authenticate the lease and load its machine, workspace, member, connection,
   grant, secret version, and policy;
2. recheck active membership, connection state, grant, and workspace manifest;
3. construct the destination from a stored HTTPS origin plus a normalized
   relative path — never concatenate an agent-supplied absolute URL;
4. enforce method, path, body-size, response-size, and rate ceilings;
5. strip all inbound authorization, cookie, proxy, forwarding, and hop-by-hop
   headers;
6. decrypt or refresh the upstream credential only after those checks;
7. inject authentication after destination validation;
8. handle redirects manually, revalidating every hop and never forwarding
   authentication across origins;
9. strip provider cookies and sensitive response headers not declared by the
   adapter;
10. record a body-free, token-free per-call audit event.

Exact-secret response filtering should catch accidental provider reflection,
including common header/error shapes. It is defense in depth, not a guarantee
against a malicious provider capable of encoding its own token.

## 6. Making current providers work without raw tokens

### Linear, Google Workspace, and YouTrack

Keep their current proxy custody and move them to the stricter capability
gateway. Add live membership/manifest checks on every proxy call, per-call
audit, bounded responses, redirect policy, and a versioned connection
descriptor. Existing lease responses provide the characterization baseline.

### GitHub REST and GraphQL

Change GitHub from `custody: "cp"` to proxy custody. Keep the member's GitHub App
user token encrypted in the control plane so API actions retain human
attribution. The gateway targets only GitHub's declared API origins and injects
the user access token after policy checks. GitHub user access tokens expire
after eight hours by default; the refresh token stays in the control plane
([GitHub documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)).

`gh` does not become safe merely because a credential helper hides the value.
Spike its supported host/base-URL configuration against the gateway. For
commands that cannot target a non-GitHub TLS origin cleanly, expose typed GitHub
actions or an audited wrapper with a closed mapping. Do not retain `GH_TOKEN`
raw delivery as fallback.

### Git clone, fetch, and push

Add a Git smart-HTTP adapter. Rewrite managed remotes from
`https://github.com/OWNER/REPO.git` to a Blitz gateway URL. The Git credential
helper returns an opaque lease as the password; the gateway sends the actual
GitHub token upstream. Git smart HTTP uses ordinary `info/refs`,
`git-upload-pack`, and `git-receive-pack` HTTP exchanges
([Git protocol v2](https://git-scm.com/docs/protocol-v2)).

The compatibility suite must cover:

- clone, fetch, pull, and push with protocol v0/v1/v2 negotiation;
- redirects without cross-origin credential forwarding;
- Git LFS batch requests and object transfers;
- HTTPS submodules and nested relative URLs;
- credential rejection, re-authentication, rotation, and mid-operation expiry;
- large pack streaming without buffering into a Worker or a log;
- preservation of the member's Git commit and API attribution.

SSH remotes do not use the GitHub bearer and are a separate design. Prefer
short-lived SSH certificates or force managed repositories to the smart-HTTP
gateway; never copy a long-lived SSH private key into the guest as the token
fix.

### Discord

REST calls fit the generic gateway. Discord's Gateway WebSocket sends the bot
token inside an Identify payload, so it needs a protocol-aware relay that owns
the upstream WebSocket and substitutes the token in the trusted domain. The
relay can hand the library a Blitz WebSocket URL and rewrite discovery
responses. If a library cannot accept that URL, it is unsupported until an
adapter exists; raw `DISCORD_BOT_TOKEN` delivery does not remain as fallback.

### Future providers

A new provider cannot select inject custody. Its manifest must declare one of:

- generic HTTPS token placement and fixed origins;
- a reviewed transport adapter;
- typed actions only;
- provider-native workload identity whose proof key stays outside the guest.

CI rejects a manifest that can serialize a provider secret to an agent
response or environment.

## 7. What happens to org credentials

An arbitrary named value has no safe universal use because Blitz does not know
where or how it should be presented. Split the product concept:

1. **Token connection:** a secret plus reviewed origin, placement, transport,
   and policy metadata. Agents use it through an opaque lease.
2. **Typed secret operation:** a key used by a trusted signer, decryptor, cloud
   adapter, or other narrow service. The operation returns the result, not the
   key.
3. **Exportable human secret:** a value people may store, but managed agents
   cannot read or lease. This preserves storage use cases without pretending
   they satisfy agent isolation.

The existing `org_credentials` rows cannot be auto-converted safely: a name
like `API_KEY` does not identify an origin, header, protocol, or allowed path.
Migration should inventory each live row and ask a writer or org admin to:

- bind it to a token connection descriptor;
- bind it to a typed operation;
- mark it human-only; or
- revoke it.

Until classified, agent reads fail closed. Rotation preserves grants but not an
unsafe raw-delivery mode. Any value previously delivered to a workspace must be
rotated at its provider before the migration is considered complete.

Local cryptographic use deserves the same honesty. If arbitrary agent code must
sign or decrypt locally, it either receives the key or asks a trusted signing /
decryption service. A non-exportable key in a separately privileged service can
support algorithms, but not arbitrary “give me these bytes” semantics.

## 8. API and storage direction

The exact wire comes after the transport spikes, but the ownership should be
clear:

```text
GET  /agent/capabilities
POST /agent/capabilities/:name/leases
POST /agent/actions/:provider/:operation
ALL  /capabilities/:leaseId/*
```

- `GET /agent/capabilities` remains names and metadata only.
- The lease route returns only a Blitz capability and supported adapters.
- The generic gateway accepts a relative operation, never a raw destination.
- Typed actions use the same connection and grant lookup without first
  serializing a lease if the call is one-shot.
- The legacy token route is deleted after box convergence. It never answers raw
  org or inject values in a compatibility mode.

Extend leases with at least:

- acting membership and machine;
- connection and immutable secret/grant version;
- transport and policy version;
- issued, expires, revoked, and last-used timestamps;
- hashed lease token and optional proof-of-possession public key;
- byte and request counters for bounded capabilities.

Do not store decrypted provider tokens, request authentication headers, request
bodies, response bodies, or capability plaintext in lease/event rows.

## 9. Migration sequence

### Phase 0 — measure and close expansion

- Inventory every built-in and database connection with inject custody.
- Inventory org credential reads by name, member, workspace, and calling
  workflow from existing audit data; do not log values.
- Add a lint/schema gate: no new managed provider may select `custody: "cp"`.
- Add sentinel credentials in a test org and an adversarial guest harness that
  attempts env, argv, `/proc`, helper, file, crash-dump, trace, and direct-route
  extraction.
- Document unsupported workflows before changing delivery.

### Phase 1 — capability gateway v2

- Add versioned token-connection descriptors and validate their fixed origins.
- Issue short opaque leases with hash-only storage.
- Recheck authorization per call and add per-call metadata audit.
- Harden redirects, headers, request/response limits, streaming, rate limits,
  cancellation, and secret-free structured errors.
- Move the three existing proxy providers onto the new path without changing
  their agent-facing tools.

### Phase 2 — GitHub without plaintext

- Proxy REST and GraphQL with the member's user-to-server grant.
- Ship and test the Git smart-HTTP gateway and remote rewriting.
- Replace the current Git credential helper's upstream token with a lease.
- Cover `gh` through supported base-URL configuration, typed actions, or a
  closed wrapper based on the spike; never raw fallback.
- Prove clone/fetch/push/LFS/submodules on canary before removing inject.

### Phase 3 — Discord and non-HTTP adapters

- Proxy Discord REST.
- Add the Gateway WebSocket Identify relay and end-to-end bot tests.
- Establish an adapter interface only after two real protocols need it; avoid a
  framework designed from hypothetical providers.

### Phase 4 — classify static org secrets

- Add token-connection and human-only UX.
- Block new raw-agent org credentials.
- Have writers/admins classify or revoke existing rows.
- Rotate every previously delivered PAT, API key, and bot token.

### Phase 5 — remove plaintext paths

- Delete `Custody = "cp"`, inject minting, raw token/env response fields, and
  agent org-secret decryption.
- Delete `GH_TOKEN`, `GITHUB_TOKEN`, `DISCORD_BOT_TOKEN`, and arbitrary org
  value injection from agent rules and helpers.
- Revoke all old leases and re-authorize/rotate provider grants that ever
  crossed into guests.
- Cycle box images. Old clients fail closed with a versioned upgrade error.
- Keep output redaction as defense in depth, not as the release criterion.

Rollback may restore gateway availability or an earlier adapter. It must never
restore plaintext delivery on managed machines.

## 10. Acceptance gates

### Confidentiality

- With sentinel upstream tokens, an adversarial `blitz` process cannot recover
  any sentinel byte sequence or accepted encoding from responses, env, argv,
  filesystem, `/proc`, helper protocols, core dumps, traces, logs, or a guest
  packet capture.
- The same tests prove the provider receives the correct sentinel through the
  trusted gateway.
- Calling every documented agent route directly never returns upstream
  credential material.
- No built-in provider manifest or org credential carries a raw-agent delivery
  mode.

### Authorization and revocation

- A lease cannot change provider, origin, transport, method/path ceiling,
  workspace, member, machine, or secret version.
- Membership removal, manifest disconnect, grant revoke, credential rotation,
  machine destruction, explicit lease revoke, and expiry each refuse the next
  request.
- A superseded lease is rejected, and only a hash remains after revocation.
- Redirects never carry authentication to another origin.
- An agent cannot turn a connection into a general forward proxy or SSRF path.

### Compatibility

- Linear, Google Workspace, and YouTrack retain their supported workflows.
- GitHub REST, GraphQL, clone, fetch, push, LFS, and submodules work without an
  upstream token entering the VM.
- Supported `gh` workflows have an explicit adapter; unsupported ones explain
  the missing capability rather than requesting `GH_TOKEN`.
- Discord REST and Gateway sessions work without a bot token entering the VM.
- Unknown org secrets are unavailable to agents until classified.

### Operations

- Audits record every lease mint and gateway call with actor and target metadata
  but no secrets or bodies.
- Gateway latency, error rate, stream duration, and provider rate-limit headers
  are observable without credential logging.
- Large Git traffic and WebSockets do not exceed runtime memory/duration limits.
- Control-plane or gateway unavailability fails closed and never asks the user
  to paste a token into the workspace.
- The repository's three standard gates pass, plus cross-runtime fixtures for
  every new lease and adapter wire.

## 11. Decisions required before implementation

1. **Confidentiality target:** prevent upstream-secret disclosure while allowing
   opaque guest leases, or require the stronger zero-guest-credential profile
   with a privileged host gateway?
2. **Compatibility policy:** is failing closed acceptable for a CLI that only
   accepts a raw token and hard-coded origin? It must be if plaintext prevention
   is the invariant.
3. **Gateway placement:** can the existing edge runtime stream Git packs and
   WebSockets within its limits, or does Blitz need a dedicated egress service?
4. **GitHub identity:** preserve member attribution through proxied user tokens,
   or deliberately move selected automation to narrower App installation
   tokens?
5. **Generic proxy breadth:** relative-path HTTP for all endpoints allowed by
   the token, or typed operations for write-capable/high-risk providers?
6. **Org-secret product:** retain human-only storage, or delete arbitrary secret
   storage once token connections exist?
7. **Lease replay:** is short-lived bearer capability sufficient, or should a
   host-held key sender-constrain gateway requests?
8. **Call audit retention:** duration, visibility, and redaction policy for
   operation metadata.

## 12. Recommendation

Approve the invariant and Phase 0 first. Then evolve the existing proxy into a
single opaque capability gateway, with typed actions and protocol adapters on
top. Treat provider-native short-lived or sender-constrained credentials as
additional protection. Treat redaction and approvals as additional protection.
Do not treat secret handles, ephemeral env, credential helpers, or a renamed
broker as plaintext prevention.

Most importantly, define “universal” narrowly and truthfully: **universal for a
token whose transport, destination, and placement are declared, because Blitz
can own that transport.** An arbitrary opaque value used by arbitrary code is
not safely proxyable. Supporting it means returning plaintext, and returning
plaintext means the goal is not met.
