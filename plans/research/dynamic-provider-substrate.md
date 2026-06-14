# Dynamic provider-access substrate (#51) — design

Synthesized + security-stress-tested by a workflow (survey → 2 designs → adversarial synthesis). Replaces the
closed PROVIDER_DATA (provider,resource) allowlist with a general `provider.call` primitive: the agent makes
WHATEVER request it needs to a CONNECTED provider; token injected server-side; reads broad (path-prefix patterns),
writes enumerated + human-gated; widgets read-only.

---

Every claim in both designs is verified against the real code. I have what I need: the closed registry (`widget-catalog.mjs:178-181`), token injection from Keychain/`.tokens.json`, the `${surfaceId}:${provider}` consent ledger (in-memory `Set`), the eval split (`agentSocket.ts:257` rejects relay eval, `control-server.ts` allows it on localhost), the content-share gate, and that GitHub's OAuth response echoes `scope` while Slack buries it in `authed_user` and Jira/Gmail/Discord track theirs differently.

Now I'll reconcile the two designs adversarially. Design A is more expressive (the "agent gets the unrestricted call" philosophy) but its scope-gate and server-mode write story are softer. Design B is stricter (closed route table, write-approval on both transports) but risks being too rigid for the OS's whole "out-of-distribution generalization" thesis. The right synthesis takes B's structural guarantees (route table, host re-assertion, dual-transport write gate, request-bound approval tokens) and A's expressiveness where it's provably safe (broad read path-prefixes rather than enumerated routes), then hardens both their weak spots.

Here is the final design.

---

# BlitzOS Provider-Access Substrate — Reconciled Implementation Spec (`provider.call`)

## 0. The adversarial verdict up front

Design B wins the structural argument and Design A wins the expressiveness argument. The synthesis: **a closed, declarative `PROVIDER_SPECS` capability table** (B's SSRF-proof spine) where **reads are opened broadly via validated path-prefix patterns** (A's "the agent figures out what it wants" generality) but **writes are an enumerated, risk-tagged, human-gated route set on BOTH transports** (B's anti-confused-deputy stance). Where A and B disagree, B's stricter choice is taken every time the cost of being wrong is irreversible (writes, localhost trust, server-mode), and A's looser choice is taken only where the blast radius is bounded by other controls (read breadth, normalized-shape freedom).

The decisive rejections of each design's soft spots:
- **A's "localhost writes only confirm on DELETE" is rejected.** A local prompt-injection nukes a repo with one POST. Writes are human-gated on localhost too (B's stance).
- **A's "scope inferred, may drift" is rejected.** Scopes are recorded authoritatively at connect time from the OAuth grant and re-checked pre-flight (B's stance, made mandatory).
- **A's per-provider single read grant is rejected as the *only* read gate.** Reads are bounded by a per-provider **read path-prefix allowlist** plus a sensitive-read sub-tier, not "any path under the origin."
- **B's fully-enumerated read routes are rejected as too rigid** for the OS's generalization thesis — reads use **prefix patterns**, not exact `(method,path)` tuples, so the agent rarely hits a wall.
- **Both designs' in-memory `Set` for approval tokens is rejected** — the approval-token ledger is consume-before-execute and the audit log is append-only to disk (B's risk #6, made mandatory).

---

## 1. The primitive

**One shared module: `src/main/provider-call.mjs`**, exporting `async callProvider(descriptor)`. Imported by exactly the three call sites that exist today for `fetchProviderResource`: `agentSocket.ts` (relay), `control-server.ts` (localhost), and `preview/backend.mjs` (server mode). No new IPC shape for widgets — they keep `widget:req`.

**Descriptor (the token is never in it):**
```
callProvider({
  provider,        // must be a key in PROVIDER_SPECS
  method,          // 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'  (no CONNECT/TRACE/OPTIONS/HEAD)
  path,            // PROVIDER-RELATIVE, leading '/', no scheme/host/userinfo
  query,           // optional {k:v}; keys validated, values percent-encoded by the OS
  body,            // optional; write methods only; JSON or string; 256KB cap
  caller,          // { kind:'agent'|'widget', transport:'relay'|'localhost'|'server', surfaceId? }
  approvalToken?   // single-use, request-bound; required for any write route
}) -> { ok, status, data?, headers?, truncated?, error?, code?, requiresApproval?, approvalRequest? }
```

**Who can call it (the three-tier capability ceiling):**

| Caller | Reads | Writes |
|---|---|---|
| **Widget** (sandboxed srcdoc) | GET only, via `blitz.data`/`blitz.fetch`, path matched against the per-provider **widget read template allowlist** (a *subset* of the agent read prefixes), per-`(surfaceId,provider)` consent | **Never.** No verb to express method/body/approvalToken. Structurally unreachable. |
| **Agent over relay** (untrusted infra) | GET, path matched against provider read prefixes; connection is the read grant; non-sensitive reads ungated, **sensitive reads** gated per-provider once | Per-call human approval via request-bound `approvalToken`. No standing write grant. |
| **Agent over localhost** (session bearer) | Same as relay reads (localhost does NOT widen the read surface — it only widens *eval/CDP*, never the provider API) | **Same per-call human approval as relay.** Localhost trust is deliberately NOT inherited for destructive provider calls. |
| **Server mode** (`preview/.tokens.json` plaintext) | GET only | **Hard-refused.** Server mode returns `code:'write_unavailable'` for every write method until it has Keychain-equivalent secret protection. (A's risk #7, taken as a hard rule.) |

**Token injection (server-side, last hop, unchanged invariant):** `callProvider` resolves the provider record from its *own* store — `loadRecord(provider).secrets` (Electron, decrypted via `safeStorage`) or `readTokens()[provider].secrets` (server) — exactly as `fetchProviderResource` does today at `widget-catalog.mjs:188`. Per-provider auth quirks live in the spec's `auth(record)` resolver, not in caller input:
- GitHub/Gmail/Discord: `Authorization: Bearer ${secrets.access_token}`.
- Slack: `Authorization: Bearer ${secrets.authed_user.access_token}` (the user token, per `integrations.ts:211`).
- Jira: `Authorization: Bearer ${secrets.access_token}` **and** base URL rewritten to `https://api.atlassian.com/ex/jira/${secrets.cloudId}` (cloudId from `integrations.ts:240`).

Any caller-supplied `Authorization`/`Cookie`/`Host`/`X-Forwarded-*` header is **stripped**, not merged. Caller headers are limited to a per-provider allowlist (`accept`, `content-type`, `accept-language`, plus e.g. GitHub `X-GitHub-Api-Version`).

**Host confinement (the entire SSRF boundary — built as defense-in-depth, three independent layers):**
1. **`baseUrl(record)` is OS-constructed**, never caller-supplied (`api.github.com`, `discord.com/api/v10`, `gmail.googleapis.com`+`www.googleapis.com`, `slack.com/api`, `api.atlassian.com/ex/jira/<cloudId>`).
2. **Path is matched against a spec pattern** before URL construction. `:param` slots are filled from validated args and percent-encoded; the caller's strings fill *slots in a template*, never form the URL string.
3. **Post-construction re-assertion:** `const u = new URL(builtPath, baseUrl)` then assert `spec.hosts.includes(u.host)` AND `u.protocol === 'https:'` AND no `u.username`/`u.password`. Reject protocol-relative (`//evil`), encoded traversal (`..%2f`), trailing-dot hosts, and `@`-userinfo. `redirect:'manual'` — a 3xx is returned to the caller, never followed, so the bearer cannot bounce off-origin.

This is strictly more expressive than today's `(provider,resource)→URL` map and still SSRF-safe: the token can only ever reach the provider's own literal host allowlist.

---

## 2. Security argument

**Why the token stays secret.** Identical invariant to today (verified at `widget-catalog.mjs:188-191`, `widgets.ts:50`, `backend.mjs:831`): the token is read inside `callProvider` at fetch time and never serialized into any descriptor, IPC message, relay frame, or response field. `publicEntry()` (`integrations.ts:99-112`) still exposes zero secrets. A leaked relay link grants only *consented, gated calls* — never the credential. Two new leak vectors that the closed map didn't have are closed explicitly: (a) **off-origin redirect** → `redirect:'manual'`; (b) **token-shaped data in read responses** (Slack oauth echoes, webhook URLs, integration configs) → every route declares a `redact` rule and `callProvider` applies a **default-deny response filter**: a route with no explicit `responseShape` passes the body through *only* after stripping any key matching `/token|secret|password|authorization|refresh|client_secret|webhook/i` at any depth. (Closes B's risk #5 — default-deny, not opt-in.)

**Why no destructive misuse.** Three locks in series, all of which must be picked:
1. **Scope lock (capability = granted scope, recorded authoritatively).** At connect time, `connectProvider` already has the grant: GitHub echoes `secrets.scope` (`integrations.ts:191-193`), Slack's granted scopes live in `secrets.authed_user.scope`, Gmail/Jira/Discord scopes are the requested constants. We persist a normalized `grantedScopes: string[]` onto the record at connect time (NOT inferred later). `callProvider` pre-flights: if the matched route's `scopeReq` is not in `grantedScopes`, return `code:'scope_insufficient'` with a "reconnect with broader scope" hint — *before* constructing any request. Today only GitHub `repo` carries write scope; Gmail (`gmail.readonly`), Slack, Jira (`read:*`), Discord are read-only, so their write routes are unreachable until the user reconnects with write scope. A fully-trusted localhost agent *still cannot* POST to Gmail.
2. **Route lock (writes are enumerated, never prefix-matched).** Reads use prefix patterns; **writes must match an exact `(method, path-pattern)` route tagged `risk:'write'|'destructive'`.** An unknown write path is rejected 404-style. `destructive` verbs (DELETE repo, PUT merge, force-push) additionally require the spec's `destructive:true` flag and surface a distinct, un-skippable confirmation copy.
3. **Human-approval lock (per call, both transports, request-bound).** A write route with no valid `approvalToken` does NOT execute: `callProvider` mints `approvalRequest = { id, provider, method, route, humanSummary, paramsPreview, bodyHash, expiresAt: now+60s }`, surfaces it as an in-canvas approval card (same UI lane as the existing content-share toggle, `backend.mjs:1030`), and returns `code:'approval_required'`. The human clicks Allow → the **renderer** (the consent authority, never the agent) POSTs to mint an `approvalToken` bound to `(approvalRequest.id, hash(method+path+body))`, single-use. The agent retries; `callProvider` recomputes the hash from the *materialized* request and verifies it matches, consumes the token, then executes. **The token is bound to the exact bytes that will be sent, so a token minted for "create issue X" cannot be replayed for "delete repo Y."** Deny → no token, retry fails closed. This holds on localhost too — the one place we deliberately reject A's localhost asymmetry.

**Why widgets are safe.** A widget's only channel is the `postMessage` bridge authenticated by `event.source === iframe.contentWindow` object identity (`SurfaceFrame.tsx:175` — unforgeable, since sandboxed srcdoc origin is literally `"null"`). The bridge exposes `data`/`fetch` ops that the renderer maps to `callProvider` with **`method` hard-pinned to `'GET'`**, `body` forbidden, `approvalToken` never forwarded from a widget sender, and `path` drawn from the per-provider **widget read template allowlist**. A widget has no field in which to express a write, a non-allowlisted path, or an approval. Its worst case is reading data the user already consented to per `(surfaceId,provider)` — exactly today's ceiling. The OS-minted `surfaceId` (not caller-supplied) means a widget cannot forge a grant for a surface it doesn't own; the html-reload revoke (`SurfaceFrame.tsx:246`) still wipes consent so new widget code re-earns approval.

---

## 3. Widget data path

Two paths, in preference order — **both keep the token server-side and neither gives the sandbox a write verb:**

1. **Agent pre-fetch → props (primary, zero new widget capability).** The agent calls `callProvider` for reads, shapes the result into *any* structure it wants (not a fixed `{items:[]}`), and seeds it via `spawn_widget`/`update_surface` `props`. The widget renders from `window.blitz.props()`/`onProps` (already wired, `widget-bridge.ts:64-68`) and never touches the network. This is A's "agent figures out what it wants and builds it" path, intact. The agent's read is audited.

2. **Consent-gated generic bridge read (for live, self-refreshing widgets).** Keep `window.blitz.data(provider, resource)` working unchanged (back-compat). Add `window.blitz.fetch(provider, {path, query})` — **GET-only, path-only** — whose `path` must match the provider's **widget read template allowlist** (a curated subset, e.g. github `/user/repos`, `/repos/:owner/:repo`; NOT the full agent read surface). The renderer's `serveData` (`SurfaceFrame.tsx:177`) gates per `(surfaceId,provider)` as today, then calls `callProvider` with `caller.kind:'widget'`. The widget receives only the parsed body. A "write widget" is explicitly out of scope for v1; if ever added, `blitz.action(name)` would route through the *same* human-approval gate as the agent path.

Net: **agent = broad authed reads + enumerated gated writes; widget = pre-fed props (no network) or a narrow GET-template bridge.**

---

## 4. Migration from `PROVIDER_DATA` (zero widget breakage)

The closed allowlist becomes the *seed* of `PROVIDER_SPECS`; every existing entry re-expresses as a GET route carrying its `normalize` byte-for-byte, so no widget and no widget test changes.

- **Step 1 (additive, no behavior change).** Add `PROVIDER_SPECS` in `src/main/provider-specs.mjs`. Each current `PROVIDER_DATA` entry (`widget-catalog.mjs:134-163`) maps to a `resource:true` GET route: `github.repos` → `{ name:'repos', method:'GET', path:'/user/repos', query:{per_page:50,sort:'updated'}, risk:'read', scopeReq:'repo', resource:true, normalize:<existing fn> }`; `discord.guilds` → `{ name:'guilds', method:'GET', path:'/users/@me/guilds', resource:true, normalize:<existing fn> }`. Also add `apiBase`, `hosts`, `auth(record)`, and `grantedScopes` capture. Record `grantedScopes` on connect (`integrations.ts` `connectProvider` return), reading GitHub `tok.scope`, Slack `authed_user.scope`, and the requested-scope constants for the rest.
- **Step 2 (the shim).** Implement `callProvider`. Reimplement `fetchProviderResource(provider, resource, token)` as a **thin shim** that calls `callProvider({provider, method:'GET', resource→route, caller:{kind:'widget'}})` then `normalize`. Same outputs, so `widgets.ts:52` and `backend.mjs:833` keep their exact call sites — phase 1 needs no renderer/IPC change.
- **Step 3 (capability unlock).** Add **read prefix patterns** broadly (github `/user`, `/repos/:owner/:repo`, `/repos/:owner/:repo/issues`, `/notifications`; gmail `/users/me/messages`, `/users/me/messages/:id`; jira `/rest/api/3/search`, `/rest/api/3/issue/:key`; slack `conversations.history`, `users.info`; discord existing) — agent-callable, ungated except sensitive-read tier (gmail message bodies, private repo contents flagged `sensitive:true`). Add **enumerated write routes** tagged `write`/`destructive` (github POST/PATCH issues = write, DELETE repo / PUT merge = destructive; gmail send = write *but unreachable until reconnect with write scope*; jira POST/transition issue = write) — agent-callable only behind the approval token.
- **Step 4 (transports).** Add `/provider_call` tool to `agentSocket.ts` (mirroring the `/surface_control` eval-split pattern at `:255-257`) and to `control-server.ts`; both delegate to `callProvider` with the right `caller.transport`. Add the approval-card UI + `POST /api/os/provider-approval` mint endpoint (mirroring `content-share` at `backend.mjs:1030`). Add the **append-to-disk** audit log + Integrations-panel activity feed, and the persistent single-use approval-token ledger.
- **Step 5 (cleanup).** Once the renderer's `data` verb is repointed and verified, `PROVIDER_DATA` can shrink to nothing — `PROVIDER_SPECS` (`routes.filter(r=>r.resource)`) becomes the single source of truth, and `WIDGET_AUTHORING_MD` (`widget-catalog.mjs:248-251`) generates its resource list from it. Update `blitzos-agents.md` to document `/provider_call` with the host/scope/consent rules.

---

## 5. Build order + what's headless-provable

There is no display in CI (per BlitzOS CLAUDE.md), so every step is proven via Node unit tests, the localhost control API, and the server-mode backend — never pixels.

1. **`PROVIDER_SPECS` + path matcher + host re-assertion.** *Headless-provable now:* a **fuzz unit test** is the load-bearing one (both designs flag host confinement as the entire SSRF boundary). Assert that `//evil.com`, `https://evil`, `..%2f..%2f`, `%2e%2e/`, `foo@evil.com`, `path?@evil`, trailing-dot hosts, IDN homographs, and query-key smuggling all reject; valid paths resolve to a host in `spec.hosts`. Assert `:param` values are percent-encoded and cannot inject `/` or `?`.
2. **`callProvider` reads + `fetchProviderResource` shim.** *Provable:* existing widget tests pass unchanged (same normalized outputs); a new test drives `callProvider` against a mock fetch and asserts the token is attached server-side and never appears in the returned object, and that caller `Authorization` headers are stripped.
3. **Scope pre-flight + `grantedScopes` capture.** *Provable:* unit-test that a record with `grantedScopes:['gmail.readonly']` returns `scope_insufficient` for a gmail write route *before any fetch is attempted* (mock fetch asserted not-called); GitHub `repo` passes the gate.
4. **Write-approval state machine + request-bound token.** *Provable:* unit-test the full mint→retry→consume cycle: a write without a token returns `approval_required`; a token minted for `(POST /issues, bodyHash=A)` is rejected when replayed against `(DELETE /repo, bodyHash=B)`; a consumed token is rejected on second use; an expired token (>60s) is rejected. Persistence test: ledger survives a simulated restart and a consumed token stays consumed (closes B's restart-amortization risk).
5. **Transport wiring + dual-transport write gate.** *Provable via the real localhost control server and server backend:* POST `/provider_call` with a GET read to a connected provider returns data; a write over **both** localhost and relay returns `approval_required` (proves localhost asymmetry is NOT inherited); server mode returns `write_unavailable` for any write; relay GET of a `sensitive:true` route returns `consent_required` until granted.
6. **Default-deny response redaction + audit log.** *Provable:* feed `callProvider` a mock response containing `{access_token, webhook_url, items}` and assert only `items` survives; assert every call (allowed/gated/denied/rate-limited) appends one line to the on-disk audit log with `{provider, method, route, caller, risk, decision, status, ts}`.
7. **Rate limits.** *Provable:* token-bucket unit test — reads 60/min, writes 5/min, 500ms floor per `(caller,provider,method,pathTemplate)`, lifetime write ceiling per session trips a hard stop requiring re-arm; `429 code:'rate_limited'`.

The first GUI-only confirmation (the approval card rendering, the activity feed) is the user's to verify per the CLAUDE.md headless rule — everything behind it (gate logic, token binding, SSRF rejection, scope pre-flight, redaction) is fully headless-provable and is where the security actually lives.

---

## Stress tests — break it, confirm the defense

- **Malicious widget tries to write / reach an arbitrary endpoint.** It can only emit `data`/`fetch` over `postMessage`; the renderer hard-pins `method:'GET'`, forbids `body`, never forwards `approvalToken`, and matches `path` against the *widget* template subset. No field expresses a write or a non-allowlisted path. Forging another surface's grant fails — `surfaceId` is OS-minted and the sender is checked by object identity. **Defended.**
- **Hostile agent over the relay tries a destructive write.** `callProvider` matches the route, sees `risk:'destructive'`, finds no `approvalToken`, refuses and returns `approval_required`. No human click → no token → no execution. Same on localhost. **Defended.**
- **Destructive write with a stolen/replayed approval.** Token is single-use, 60s TTL, and bound to `hash(method+path+body)` recomputed from the materialized request; a token for "create issue" fails the hash check against "delete repo," and a consumed token fails reuse (ledger persists across restart). **Defended.**
- **Token exfiltration via SSRF.** Caller supplies only a path; three independent layers (template match, OS-built baseUrl, post-construction `hosts.includes` + protocol + no-userinfo assertion) plus `redirect:'manual'` mean the bearer can only ever reach the provider's literal host allowlist. Fuzz-tested. **Defended.**
- **Token exfiltration via read response.** Default-deny response filter strips token-shaped keys at any depth before returning; routes may add explicit `redact`. **Defended.**
- **Scope drift (OS thinks read-only, token is write-capable, or vice-versa).** `grantedScopes` is recorded authoritatively from the OAuth grant at connect time, not inferred; write routes pre-flight against it and fail clean with a reconnect hint rather than firing a confused write. **Defended.**
- **Server-mode plaintext-token write.** Hard-refused (`write_unavailable`); server mode is reads-only until it has Keychain-equivalent protection. **Defended.**

The capability table grew from `(provider,resource)→URL` into `(provider, method, route)→template + risk + scope + gate`, but it is **still closed, still SSRF-proof, and now expressive enough that the agent rarely needs anything outside it** — while every irreversible action requires a fresh, request-bound human act on every transport.