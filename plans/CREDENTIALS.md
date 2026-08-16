# Blitz credentials — the agent IAM plan

Design locked in the 2026-08-13/14 session. No code exists yet. This expands `ICP-GAPS.md` §B into a build plan.
Revised 2026-08-13 after a 25-agent adversarial review and a `gws`-CLI end-user persona test — deltas in §6.
All `file:line` references point at branch `feat/microvm` (worktree `../blitz-core-microvm`).

## 0. The model in five lines

1. A workspace never holds a long-lived credential. The agent asks the control plane, per task. (One stated exception: the §3.9 inject opt-down for static keys.)
2. The CP mints short-lived children through each **vendor's own exchange**. The vendor validates its own tokens. We stay off the data path.
3. One connector registry, three custody backends — `cp` (default), `broker`, `proxy` (the static-key path). Custody is a routing detail.
4. Every mint must fit the workspace **manifest** intersected with the integration's **allow-list**. Every mint becomes a **lease** (a tracked loan).
5. `authorize()` is two hardcoded clauses: `admin || owner`, and mint ≤ (manifest ∩ allow-list). No policy language.

## 1. Architecture

```text
      webApp / CLI  (session cookie)                agent inside the box
      config + audit views                           (box access token, 15 min; oauth.ts:48)
           │                                               │
           │ PUT /integrations/:name                       │ blitz-cred token <integration>
           │ GET /workspaces/:id/leases                    │   → POST /workspaces/:id/credentials
           ▼                                               ▼        {integration, scopes?}
┌────────────────────── control plane (ONE worker; runs in both hosting modes) ──────────────┐
│                                                                                            │
│  requirePrincipal (app.ts:18)              authenticateBox (oauth.ts:137)                  │
│              └──────────────────┬──────────────────┘                                       │
│                                 ▼                                                          │
│  (1) authorize()      admin || owner  AND  scopes ⊆ (manifest ∩ usable_by)                 │
│                                 ▼                                                          │
│  (2) connector registry     integrations row = { provider, kind, custody, config, … }      │
│                                 ▼   custody routes the request (mirror composite.ts:29)    │
│  (3) minters/   app-jwt/github-app │ oauth │ static                                        │
│        cp custody:  root opened from its row ──► vendor-native exchange                    │
│        proxy:       real key stays here; box gets a blitz token   (static keys, proxy.ts)  │
│        broker:      not routed here — blitz-cred keeps its SSH path (ssh.go:18)            │
│                                 ▼                                                          │
│  (4) lease written    credential_leases row  +  credential_events append (audit)           │
│                                 ▼                                                          │
│  (5) MintResult       { mode: "inject" | "proxy", placements[], expiresAt }                │
└────────────────────────────────────────────────────────────────────────────────────────────┘
           │                                               │
           ▼                                               ▼
  vendor APIs validate their own children          blitz-cred applies placements
  (GitHub ~1 h · OAuth ~1 h)                       (env / file / unset) — box stays dumb

  Root storage: AES-256-GCM ciphertext on the owning row (integrations / user_connections),
  sealed with CRED_MASTER_KEY, the owning name as AAD — identical in both modes. Only the
  key's arrival differs: a Worker secret (mode a) / a platform secret in env (mode b).
```

Why mint-in-CP is the foundation and not a proxy, gateway, or external service: it is the only model that runs everywhere the CP runs — a plain Worker (mode a) **and** a blitz.dev managed app (mode b). Everything else on the survey list is a slice or a stateful service. See §3.12 for how those slot in later.

## 2. Files and schema

### New files

| Path | Purpose |
|---|---|
| `packages/control-plane/core/credentials/types.ts` | `Integration`, `MintKind`, `Custody`, `MintRequest`, `MintResult`, `Placement` (value-carrying), `Minter`, `Lease` |
| `packages/control-plane/core/credentials/registry.ts` | CRUD over `integrations`; validates `provider`/`kind`/`custody` and the allow-list; dispatch table of minters |
| `packages/control-plane/core/credentials/mint.ts` | the router: authorize → (manifest ∩ allow-list) check → minter → lease + event → result |
| `packages/control-plane/core/credentials/leases.ts` | lease store: create / revoke (state + `token_hash = NULL` in one statement) / cascade; `runLeaseSweep` |
| `packages/control-plane/core/credentials/manifest.ts` | parse + ceiling check (`.blitz/manifest.json` v0); narrow-only merge against the template base |
| `packages/control-plane/core/credentials/root-crypto.ts` | AES-256-GCM seal/open for root columns; one `CRED_MASTER_KEY`, the owning name as `additionalData` — one implementation, both modes |
| `packages/control-plane/core/credentials/connections.ts` | per-user OAuth vault + 3LO consent routes (inherit mode, phase 6) |
| `packages/control-plane/core/credentials/proxy.ts` | static-key header-swap route at `/proxy/:leaseId/*` — default custody for kind `static` (phase 3) |
| `packages/control-plane/core/credentials/requests.ts` | access-request lifecycle (§3.13): auto-file on denied mint, pending-dedup, approve → ceiling widen + `approved` event, deny |
| `packages/control-plane/core/credentials/minters/app-jwt/github-app.ts` | provider module for `github` — kind `app-jwt` keeps a folder, one file per provider: RS256 app JWT → narrowed installation token (port the v2 flow, single-tenant) |
| `packages/control-plane/core/credentials/minters/oauth.ts` | kind engine for `oauth`: generic 3LO + refresh → access exchange, driven by per-provider descriptors (the long tail) |
| `packages/control-plane/core/credentials/minters/static.ts` | kind engine for `static`: no vendor call; proxy handle by default, TTL-gated inject as opt-down |
| `packages/control-plane/migrations/0003_credentials.sql` | schema below |
| `packages/schema/src/credential.ts` | wire types shared by CP, box, ui (export from `src/index.ts:1-5`) |
| `packages/broker/internal/workspace/cp.go` | box-side CP mint call + placement apply (env / file / unset-env) |
| `packages/webapp/src/settings/IntegrationsPanel.tsx` + leases view | webApp config + audit surfaces; built-in provider templates + the access-request inbox (phase 4) |
| `e2e/credentials.mjs` (or `coverage.mjs --suite credentials`) | the gates in §4 |

### Modified files

| Path | Change |
|---|---|
| `core/app.ts:26-30` | add `addCredentialRoutes(router, runtimeFactory, requirePrincipal)` |
| `core/runtime.ts` | `CoreRuntime` gains the imported `CRED_MASTER_KEY` (an AES-GCM `CryptoKey`) — same construction in BOTH targets |
| `core/workspaces.ts` | destroy: prepend the lease-revoke statement **inside** the existing `transaction()` batch (:300-310), not as a separate call; create accepts optional `manifest` (narrow-only vs the template base) |
| `core/janitors.ts:44-56, 92-118` | `runOrphanSweep` repeats the box delete — prepend the same revoke statement there; lazy hook adds `runLeaseSweep` |
| `src/worker.ts:108-115, 128-142` | `scheduled()` adds the lease sweep; wire `CRED_MASTER_KEY` |
| `scripts/build-blitzdev.mjs:16-40` | `CORE_MANIFEST` adds every `core/credentials/` file (list is explicit, no glob — :575-592 maps it); emitted `teenybase.ts` adds **five** tables deny-all with `box_id onDelete: "SET NULL"` and unique `token_hash`; update the pinned counts in `test/blitzdev-schema.test.ts` and `test/blitzdev-emitter.test.ts` |
| `packages/broker/cmd/blitz-cred/main.go:48-57` | `token` dispatch: `claude\|codex` keep the broker SSH path (`ssh.go:18`); any other name goes to the CP; add `sync` and `git-helper`; denied mints print the request id on stderr (§3.7, §3.13) |
| `packages/box/Dockerfile` | `blitz-cred` is already installed (`:98-103`) and the box credential already lands on disk (`store.go:16-37`, `bootstrap.ts:345-349`); add two small files: `/etc/profile.d/blitz-creds.sh` (sources `/var/lib/blitz/creds/env.d/`) and the gitconfig `credential.helper` lines (§3.7) |

### Routes added

```text
POST   /workspaces/:id/credentials       box-authed (authenticateBox; ownership check like registry.ts:60-69); body {integration, scopes?}; omit integration = mint everything the ceiling allows (the sync path) and return the array; the box calls `:id` = `self` — the CP resolves it from the box token, so the box never needs its workspace id
GET    /workspaces/:id/leases            session-authed; audit view
DELETE /leases/:id                       session-authed; revoke now
GET    /integrations                     session-authed; names + status, never values
PUT    /integrations/:name               session-authed; provider + kind + config + one pasted secret
DELETE /integrations/:name               session-authed; kill switch for the whole integration
GET    /requests?state=pending           session-authed; the approval feed — webApp, §D connectors, webhooks all poll this (phase 4)
POST   /requests/:id/approve             session-authed; widens the workspace ceiling within usable_by; `approved` event (phase 4)
POST   /requests/:id/deny                session-authed (phase 4)
GET    /connect/:integration             session-authed; 3LO start (phase 6)
GET    /connect/:integration/callback    the FIXED public callback path — the exact redirect URI users paste into vendor consoles (phase 6)
ALL    /proxy/:leaseId/*                 static-key data path; the blitz token rides the Authorization header, never the URL (phase 3)
```

### Schema — `0003_credentials.sql`

```sql
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                    -- instance name the user picks ("github-prod")
  provider TEXT NOT NULL,                       -- the member: 'github', 'google', 'slack', 'anthropic', 'hetzner', … open set
  kind TEXT NOT NULL,                           -- mechanism: 'app-jwt' | 'oauth' | 'static'
  custody TEXT NOT NULL DEFAULT 'cp',           -- 'cp' | 'broker' | 'proxy'
  config TEXT NOT NULL DEFAULT '{}',       -- non-secret: app id, install id, descriptor, placement template
  root_ciphertext TEXT,                         -- base64(12-byte IV ‖ AES-256-GCM root)
  usable_by TEXT,                              -- who may use it: {"owners":[…]}; NULL = any workspace
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE user_connections (                 -- inherit mode: Alice's own grants
  user_id TEXT NOT NULL REFERENCES principals(id),
  integration_id TEXT NOT NULL REFERENCES integrations(id),
  refresh_ciphertext TEXT NOT NULL,             -- her refresh token, AES-256-GCM sealed
  scopes TEXT NOT NULL,                         -- frozen at consent; the outer bound
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (user_id, integration_id)
);

CREATE TABLE credential_leases (                -- one row per mint; rows are NEVER deleted
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  box_id TEXT REFERENCES boxes(id) ON DELETE SET NULL,  -- audit: which box received it; survives the box hard-delete on destroy
  integration_id TEXT NOT NULL REFERENCES integrations(id),
  user_id TEXT,                                 -- set when minted from a user_connection
  scopes TEXT NOT NULL,                         -- the scopes actually GRANTED, verified at mint (§3.8)
  mode TEXT NOT NULL CHECK (mode IN ('inject','proxy')),
  token_hash TEXT UNIQUE,                       -- set only when mode='proxy'; NULLed by revoke/expiry (phone_home_hash idiom)
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','revoked','expired'))
);
CREATE INDEX leases_workspace ON credential_leases(workspace_id, state);
CREATE INDEX leases_expiry   ON credential_leases(state, expires_at);
CREATE INDEX leases_token    ON credential_leases(token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE credential_events (                -- append-only; never UPDATE, never a value
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id TEXT REFERENCES credential_leases(id),   -- NULL for denied mints
  event TEXT NOT NULL CHECK (event IN ('minted','revoked','denied','approved')),
  detail TEXT,                                  -- JSON: integration, scopes, box id, reason; no secrets
  created_at INTEGER NOT NULL
);

CREATE TABLE credential_requests (              -- the approval loop (§3.13); a state machine, so not an event
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  integration_name TEXT NOT NULL,               -- integrations.name is UNIQUE; the row may not exist yet
  requested_scopes TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX requests_pending ON credential_requests(state, created_at);
CREATE UNIQUE INDEX requests_dedup
  ON credential_requests(workspace_id, integration_name, requested_scopes)
  WHERE state = 'pending';

ALTER TABLE workspaces ADD COLUMN manifest TEXT;   -- ceiling snapshot at create
```

Notes.

- Our own tokens stay hash-only (`crypto.ts:14`). Roots are encrypted columns on their owning rows, sealed with `CRED_MASTER_KEY`, the owning name as AES-GCM `additionalData` — a ciphertext cannot move to another row. `credential_leases` holds current state; `credential_events` is the append-only CloudTrail. Denied mints get an event with `lease_id = NULL`.
- **Lease rows are never `DELETE`d** — state moves to `revoked`/`expired`. That is what makes FKs into leases safe without cascade clauses.
- **`box_id` carries `ON DELETE SET NULL` deliberately.** Workspace destroy hard-deletes the box row (`workspaces.ts:301`, repeated in `janitors.ts:45`); a bare FK would abort that batch, strand the workspace in `destroying`, and keep the box token family alive. Verified on real D1 during review. Every other child of `boxes` in `0001_initial.sql` already carries an explicit action; this matches.
- **There is no `proxy_tokens` table.** The proxy token hash lives on the lease (`token_hash TEXT UNIQUE`, nullable), the repo's own `phone_home_hash` idiom — revoke kills the token in the same statement that flips state.
- Enum policy. `provider`, `kind`, and `custody` carry no SQL CHECK on purpose. They name code, and the code registry is the authority: `PUT /integrations` refuses values the registry cannot serve, and mint fails closed on a row the registry no longer recognizes. Adding a provider is a descriptor or one module — never a migration. `kind` grows only when a genuinely new mint *mechanism* exists (three today). SQL CHECKs stay only where the schema itself owns the value set as a state machine: `state`, `event`, `mode`.

## 3. Design overview

### 3.1 Principals and authorize()

Today one principal exists (`operator`, `principals.ts:79-87`). The identity plane (ICP-GAPS §C) slots underneath without changing this plan — `workspaces.owner_id` already references `principals(id)` (`0001_initial.sql:17`). `authorize()` is one function with two clauses, called in exactly one place (`mint.ts`):

1. The caller is admin or owns the workspace.
2. Requested scopes ⊆ (workspace manifest ∩ `integrations.usable_by`). The manifest is the caller-side narrowing; the allow-list is the resource-side bound — who may use this integration at all. `usable_by = NULL` keeps day one frictionless.

Swapping the internals later (roles) touches nothing else. No Cedar, no OPA — decided.

### 3.2 Connector registry and the Minter interface

```ts
type MintKind = "app-jwt" | "oauth" | "static";
// kinds are mechanisms, closed in code; the list grows only when a new mechanism exists

type Placement =
  | { kind: "env"; name: string; value: string }
  | { kind: "file"; path: string; value: string; mode?: number }
  | { kind: "unset-env"; name: string };                 // e.g. a stray ANTHROPIC_API_KEY outranks the minted token

type MintResult = {
  integration: string;            // names the env.d file box-side; attributes mint-all items
  mode: "inject" | "proxy";
  placements: Placement[];        // the CP decides placement in BOTH modes; blitz-cred just applies
  expiresAt: number;
};

interface Minter {
  kind: MintKind;
  providers?: string[];   // set on provider modules ("github"); unset on kind engines (oauth, static)
  mint(root: string | null, integration: IntegrationRow, req: MintRequest): Promise<MintResult>;
}
```

Two dimensions, deliberately separate. `provider` is the **member** — an open TEXT set. `kind` is the **mechanism** the code dispatches on — three exist. Resolution mirrors `composite.ts:29-33`: a provider module wins when one exists (`github` → `app-jwt/github-app.ts`; provider modules live in their kind's folder); otherwise the row's kind engine takes it (`slack` → `oauth.ts` plus its descriptor). A new OAuth vendor is a registry row plus a descriptor — no schema change, no new module, no migration.

The OAuth descriptor (in `config`) carries everything a real provider needs — the persona test proved the small version was not enough:

```jsonc
{
  "client_id": "…",
  "authorization_url": "https://accounts.google.com/o/oauth2/v2/auth",
  "token_url": "https://oauth2.googleapis.com/token",
  "authorization_params": { "access_type": "offline", "prompt": "consent" },
  "pkce": true,
  "default_scopes": ["https://www.googleapis.com/auth/drive.readonly"],
  "placements": [{ "kind": "env", "name": "GOOGLE_WORKSPACE_CLI_TOKEN" }]   // template; mint fills values
}
```

Descriptors for known providers ship as built-in webApp templates (phase 4); pasting a descriptor by hand is the escape hatch, not the norm.

Per-provider cost by kind (machinery is written once; providers are mostly declarations):

| Kind | Per-provider cost | Examples |
|---|---|---|
| `oauth` | a descriptor + a client-id registration at the vendor; odd vendors get a small `normalize()` hook | Slack, Jira, Notion, Google (inherit) |
| `app-jwt` | one bounded provider module (~50–150 lines): JWT claims + exchange + narrowing | GitHub, Salesforce |
| `static` | zero code — a registry row | Hetzner, Resend, anything |

### 3.3 Custody models

| Custody | Root lives | Mint by | For |
|---|---|---|---|
| `cp` (default) | encrypted on its `integrations` row | the CP | everyone; zero extra infra; both hosting modes; API-billing users with no broker box |
| `broker` | broker box disk | broker, over SSH forced-command (`ssh.go:39-84`) | "credential never touches the CP or the box" buyers |
| `proxy` | on its row; never leaves the CP | no vendor mint; we validate | kind `static` — its default path (phase 3) |

One registry, one mint endpoint, one lease table across all three. The broker repositions as the optional high-assurance backend; `blitz-cred`'s decision stays one line: broker-registered integration → SSH path; otherwise → CP endpoint.

### 3.4 Mint mechanics per kind

| Root | Exchange | Child | Sharp edges |
|---|---|---|---|
| GitHub App private key | sign 9-min RS256 JWT → `POST /app/installations/:id/access_tokens` with `repositories[]` + `permissions{}` | ~1 h installation token | TTL vendor-fixed; ceiling = install-time grant; clock skew |
| OAuth refresh token | token-endpoint exchange | ~1 h access token | scopes frozen at consent; narrowing at exchange only where the vendor honors the RFC 6749 `scope` param — **Google does not** |
| Static key (incl. Anthropic/OpenAI console-minted keys) | none | none — proxy handle (default) or TTL-gated inject | expiry is ours via the proxy; inject is the opt-down floor; a stray `ANTHROPIC_API_KEY` outranks placements in every SDK — placements include `unset-env` |

Anthropic and OpenAI are deliberately absent as minters. **Anthropic's Admin API cannot create or delete API keys** (Console-only — review-verified against official docs), and at both vendors the real-world pattern is org members minting dashboard keys. Both run as kind `static` under proxy custody: the pasted console key gets expiry and per-task leases from us, with zero vendor-specific code.

### 3.5 Leases

Every mint writes one row: workspace, integration, granted scopes, issued/expires, state. Three behaviors follow.

- **Re-mint**: the agent re-runs `blitz-cred token`; every mint is a fresh lease under a fresh `authorize()`; the old one expires on its own.
- **Revocation**: `DELETE /leases/:id` → one statement sets `state = 'revoked'` AND `token_hash = NULL`. Nothing lives upstream to chase: every child either expires at the vendor or dies with our proxy token.
- **Cascade**: the lease-revoke statement is **prepended inside the existing destroy `transaction()` batch** (`workspaces.ts:300-310`) and inside `runOrphanSweep`'s copy of it (`janitors.ts:44-56`) — never a separate call, so a mid-flight failure cannot leave active leases pointing at a dead box. `runLeaseSweep` expires overdue rows; proxy validation independently checks `expires_at`, so a late sweep is bookkeeping, not exposure. Self-host runs it in `scheduled()` (`worker.ts:128-142`); managed mode rides `maybeScheduleLazySweep` (`janitors.ts:92-118`).

The lease table is the audit answer to "what could this task touch, and until when."

### 3.6 Manifest

A small reviewable file per workspace template — the caller-side credential **ceiling**:

```jsonc
// .blitz/manifest.json  (v0 is JSON: mode (b) allows no npm imports, so no YAML parser in core)
{
  "integrations": {
    "github-app": { "repos": ["blitz-core"], "permissions": { "contents": "write", "pull_requests": "write" } },
    "google-workspace": { "scopes": ["https://www.googleapis.com/auth/drive.readonly"] },
    "hetzner": {}
  }
}
```

Provenance rule (review fix): the **base** manifest comes from the template or the deployment default; a `manifest` field in the create body may only **narrow** that base, never widen it. After create, the ceiling widens only through an approved access request (§3.13) — human-authorized, event-recorded, still inside `integrations.usable_by`. The snapshot lands in `workspaces.manifest`. Missing manifest = allow-all-with-logging, so day one stays frictionless. v0 has no mutation route: tightening a live workspace = edit the repo file (a PR) and recreate — the product's existing immutable idiom.

Honest taxonomy: the manifest is a caller-authored narrowing bound. The *resource-side* bounds are `integrations.usable_by` plus the vendor's own grant (install-time grant, consent scopes). The octo-sts steal is the reviewability property — policy lives in the repo, changes are PRs.

The rule connecting the pieces: **every mint fits (manifest ∩ allow-list); every mint becomes a lease.**

### 3.7 Delivery — the agent never learns the credential model

The box already has everything: `blitz-cred` is in the image (`Dockerfile:98-103`), the box credential and origin are on disk (`bootstrap.ts:345-349`, `store.go:16-37`), and box auth is the bearer access token with 15-min refresh (`oauth.ts:48-161`, `controlplane.go:136-211`).

The agent-visible surface is **nothing**. The agent reaches for `git push`, `wrangler deploy`, `gws drive files list`, or an SDK env var — and it works. One lazy rule makes that true, in two places:

1. **The profile hook syncs at shell spawn.** `/etc/profile.d/blitz-creds.sh` checks one local cache file. Fresh → source `/var/lib/blitz/creds/env.d/` and go (~0 ms). Stale or missing → `blitz-cred sync` mints the ceiling's integrations (one CP call — `POST /workspaces/:id/credentials` with no `integration` field), rewrites `env.d/`, then sources (~200 ms, once per TTL window). Env can enter a process only at spawn, and agents run discrete commands — so the spawn is the one moment that matters, and the freshness check lives exactly there. `flock` on the cache file settles concurrent spawns; a 2-second timeout falls back to stale values so the hook can never hang a shell.
2. **git mints lazily.** The image gitconfig routes `https://github.com` through `blitz-cred git-helper`: plain `git clone`/`push` triggers the mint at call time, cached for the lease lifetime. The helper mints the integration named exactly `github` — a naming convention, not discovery machinery; the phase-4 webApp tile uses that name by default. `gh` reads `GH_TOKEN` from the same env.d.

There is no delivery daemon and no boot pre-mint. Both would do work no process can observe before its next spawn; the first command after boot or after expiry pays one ~200 ms sync instead — and boot gets faster. `file` placements (ADC-style JSON, kubeconfig) refresh in the same sync. Proxy-custody integrations deliver the same way — a base-URL env plus a token env; the tool never knows a proxy exists. Failure UX: a denied or unconfigured integration surfaces as the tool's own auth error — and the mint path has already filed an access request; the approval loop is §3.13. Approval recovery is the same rule: the next command's sync mints, and the retry works.

The explicit CLI remains, not as required knowledge:

```text
blitz-cred token <integration>     # mint one integration now; apply placements; print expiry
```

Placements always come from the CP (`MintResult.placements`, values filled at mint) — env, file, or `unset-env`; the box stays dumb. Mints use the integration's `default_scopes`; the wire field `scopes?` stays for future narrower requests. No long-lived credential ever lands on disk (§3.9's inject opt-down is the stated exception). The existing seam already fits: the box actor feeds harnesses through `getOAuthToken` (`packages/box/actor/src/adapters/claude.ts:41`). Workspace templates (ICP-GAPS §E) later run the same sync during bootstrap to clone the repo before the agent starts.

### 3.8 Inherit mode — Alice's agents act as Alice (AgentCore shape)

- One-time 3LO consent per provider in the webApp → her refresh token is vaulted in `user_connections` keyed `(user, integration)`.
- The callback is the **fixed public path** `GET /connect/:integration/callback`; the webApp shows it verbatim so the user can paste it into the vendor's redirect-URI field.
- Her workspace carries `owner_id`; mint exchanges **her** refresh token; the lease records `user_id`.
- Upstream, the agent **is** Alice — vendor audit logs show her; our lease adds the task/workspace join.
- Ceilings compose, with a review-forced correction: consent scopes are the outer bound, and narrowing at exchange works only where the vendor honors it. **Google returns the full consent bundle on refresh — no per-task narrowing.** So the mint verifies the token's actually-granted scopes against (manifest ∩ allow-list) and denies — or records the wider grant honestly on the lease. `credential_leases.scopes` always stores what was *granted*, not what was asked.
- GitHub needs one registration: the same GitHub App serves installation tokens (org identity) and user-to-server tokens (Alice).
- Offboarding Alice kills her agents' access — for this ICP that is a feature. This is the ToS-clean shape; consumer-subscription sharing stays quarantined in the broker.

### 3.9 Static keys go through the proxy (phase 3)

The agreed split: **cred proxy for static keys, vendored expiry for everything else.** A static key has no vendor exchange, so expiry must come from the only party we control: ourselves.

Mechanics after the review fixes: the box gets a blitz token and a base URL `…/proxy/<leaseId>`; the token rides the **`Authorization` header — never the URL path**, because both worker shells log the path **and query string** of every request (`hono/logger` via `teenyHono` prints `METHOD /path?query`, verified at `src/worker/honoApp.ts:28`; Workers Logs record `<Method> <URL>` platform-side regardless). Validation is one indexed statement on `credential_leases.token_hash` (+ state + expiry) joined to `integrations` for `root_ciphertext`/`config`, then `matchesStoredHash` — the `authenticateBox` idiom. The proxy swaps the header for the real key, streams, and logs metadata. The lease row's `box_id` records which box received the handle — audit, not a second auth factor. Synthetic scoping (method/path rules from `config`) becomes possible for vendors that offer none. The box never holds anything worth stealing, and a leaked blitz token dies in an hour.

Boundaries. `proxy` is the default for kind `static` only — for every other kind the vendor's own expiry beats a middlebox (availability asymmetry + protocol treadmill; the session's Centaur verdict). Per integration, `custody: cp` opts a static key down to plain TTL-gated inject — for tools that cannot override their base URL, or when the data-plane hop through the Worker is unwanted (e.g. streaming a plain-key LLM vendor). Phase 1 ships that inject floor first; phase 3 flips the default to `proxy`.

### 3.10 Dual-target constraints (the decisive ones)

- **No npm imports (mode b)**: every minter uses `fetch` + WebCrypto only. RS256 = `crypto.subtle.importKey("pkcs8") → sign("RSASSA-PKCS1-v1_5")`. GitHub ships PKCS#1 PEMs; the webApp converts to PKCS#8 at paste time.
- **No crons (mode b)**: lease sweep joins the existing lazy-sweep hook. Real cron in mode (a).
- **Explicit emit list**: `CORE_MANIFEST` (`build-blitzdev.mjs:16-40`) must name every `core/credentials/` file, the emitted `teenybase.ts` must add the five new tables deny-all, and the pinned test counts (`blitzdev-schema.test.ts`, `blitzdev-emitter.test.ts`) must move — nothing is picked up automatically.
- **Root storage, one shape**: roots are AES-256-GCM ciphertext columns on the rows that own them, one key, the owning name as `additionalData` — identical in both modes. The platform secrets API cannot serve runtime roots — a write only reaches the worker as an env binding at isolate load, and the loader cache key is the bundle hash, so a freshly pasted secret is invisible until eviction (verified: loader id is `project-${slug}-${bundleHash}`, `project-gateway/src/index.ts:267-294`). It carries exactly one deploy-time constant: `CRED_MASTER_KEY` (passes `NAME_RE`, `backend/src/routes/project-vars.ts:26`). This makes `PUT /integrations/:name` the same code path in both modes.

### 3.11 Security invariants

- No credential value in our storage or logs, ever: our tokens hash-only, roots encrypted, leases/events metadata-only, `GET /integrations` names-only.
- **No secret ever appears in a URL path or query string; secrets travel in headers or bodies only.** (Testable: a captured `wrangler tail` transcript of a full proxied call contains the lease id and no token substring.)
- Mint auth = box access token bound to the same workspace id (ownership check as `registry.ts:60-69`).
- TTL: `proxy` tokens default to 60 min — we validate, so expiry is real. `app-jwt` and `oauth` TTLs are vendor-fixed (~1 h); the lease mirrors them. Inject-static expires nothing — its lease TTL only gates logging and re-mint.
- Kill switches, cheapest first: wait out the TTL → revoke the lease → delete the integration → rotate the root.
- Audience: the lease records the receiving `box_id` (surviving destroy via SET NULL) as audit metadata — the lease token is a proxy call's only auth. Vendor children are delivery-bound only — stated plainly in docs.

### 3.12 Modularity — what future trends plug into

Four owned contracts make everything else addable: the **mint endpoint**, the **`authorize()` seam**, the **lease/event log**, the **connector registry**.

- **MCP gateway later** = another consumer of the mint endpoint (per-tool-call, minutes-TTL) or a `proxy`-custody connector. Zero core change. MCP servers inside the box already work day one — they read the same injected creds as every CLI.
- **Defined roles later** = swap `authorize()` internals. One callsite.
- **Vault / Nango / Secretless / SPIFFE** = optional custody backends or root sources behind the registry, never core.
- **Biscuit-style capabilities** = a possible future internal token for subagent delegation under the manifest ceiling; vendors will never verify them; noted, not built.

Contracts outlive transports — that is the bet.

### 3.13 Access requests — the approval loop

The anchor is the mint path, not any session protocol. A mint that fails `authorize()` does three things: writes the `denied` event, files (or dedups into) a **pending access request**, and returns the request id.

The box side speaks two protocol-free channels, so an arbitrary harness needs zero blitz knowledge:

- **stderr on the failing command.** `blitz-cred` and the git helper print one line: `access to github requested (R-123), awaiting approval`. Every harness reads command output — the message lives where the failure lives.
- **Silent recovery closes the loop.** On approval, the next command's sync mints and refreshes the placements, so the harness's natural retry succeeds — even a harness that understood nothing.

The human side is one feed: `GET /requests?state=pending`. Every surface is a poll subscriber — the webApp inbox (phase 4), Slack/Discord through the ENTRYPOINTS §D connectors (approve/deny buttons posting back to `POST /requests/:id/approve|deny`), any webhook, and — optionally, for interactive models — the ACP actor dropping a notice into the session. ACP is one subscriber among several, never the transport. No WebSockets needed in either hosting mode.

Approval is a real grant, not a nudge: it widens `workspaces.manifest` by exactly the requested slice — still bounded by `integrations.usable_by` and the template base — and writes an `approved` event recording who and why. The approver passes the same `authorize()` check. Deny leaves the wall standing; stale requests stay pending until a human denies them — the dedup index bounds the pile.

Two walls this loop does not cover, honestly. A vendor-side 403 on a validly narrowed vendor-native token is invisible to the mint path — the agent reports it wherever it reports errors, and the human widens the ceiling in the webApp, recording the same `approved` event. (Under proxy custody the CP *does* see the 403 — a small extra argument for the static-key proxy default.) And a brand-new provider stays a human act: the request names the missing integration and the inbox card deep-links to the add-integration form, but the paste is yours.

Why a table and not events: a request is a state machine (`pending → approved | denied`) with pending-dedup — an append-only log cannot hold "still pending."

### 3.14 Non-goals

No policy language. No central gateway. No universal credential proxy. No SPIFFE deployment. Broker stays optional. Action approvals ("may the agent run this command") stay at the ACP layer; this plane owns exactly one approval type — access requests (§3.13) — and any surface subscribes to its feed.

## 4. Build order (dependency order only)

1. **Skeleton + static (inject floor)**: migration 0003, `types/registry/mint/leases/manifest/root-crypto`, `static.ts`, routes, `blitz-cred` CP branch + placements + passive delivery (env.d + the sync hook), emit-list update. Gate: paste the Hetzner key once; a fresh shell in a live box sees `HCLOUD_TOKEN` with zero agent action; lease + `minted` event visible; **destroy succeeds while an active lease exists — the `boxes` row and its token family are gone, the lease row survives with `box_id` NULL and state `revoked`**; a non-allow-listed mint is denied with a `denied` event.
2. **GitHub App minter** (WebCrypto RS256; port the v2 flow single-tenant). Gate: in-box **plain** `git clone` of a private repo — the helper mints on demand, token narrowed to one repo; lease shows the granted scopes.
3. **Static-key proxy**: `proxy.ts` on `credential_leases.token_hash`; kind `static` defaults to `custody: proxy`. Gate: the box calls the vendor through `/proxy/:leaseId/*` with the token in the header; the real key never appears in the box; a captured console/tail transcript contains no token substring; a leaked token dies at expiry.
4. **WebApp surfaces**: Integrations panel with built-in provider templates (add → paste → test-mint → green dot), the exact `/connect/:integration/callback` URL displayed for OAuth providers, Anthropic/OpenAI tiles that paste a console-minted key (kind `static`, proxy custody, labeled honestly), named error states ("API disabled", "OAuth app blocked by admin", "refresh revoked"), workspace Leases view, and the **access-request inbox** (`requests.ts` + routes land here; Slack/Discord subscribe via the ENTRYPOINTS §D connectors, the ACP actor optionally in-chat). CLI parity `npx blitz integration add`.
5. **Mode-(b) parity**: emit `core/credentials/`; set `CRED_MASTER_KEY` once via the platform secrets API before the commit; probe validation. (Blocked on the user-owned unlocks: PR #11 deployed, `teenybase@0.0.15` published.)
6. **Inherit mode**: `user_connections` + 3LO routes + fixed callback path + granted-scope verification + owner-root selection. First descriptors: Google Workspace (the `gws` persona case), Slack. (Blocked on identity plane C.)

Phases 1→2→3 are the spine: the demo ("repo cloned via a scoped 9-minute-JWT token, every mint in the log") plus the agreed static-key story. 5 can run any time after 1; 6 waits on identity plane C. The frozen `selfhost.mjs` gate stays untouched; credentials get their own suite.

## 5. Dependencies and open decisions

- **Identity plane C** (ICP-GAPS §C) is required for inherit mode and per-user attribution. Everything except inherit mode (phase 6) runs under today's `operator` principal unchanged; `usable_by` ships in phase 1 and bites fully when C lands.
- Open: manifest file name is `.blitz/manifest.json` in v0; YAML arrives only as CLI-side conversion, never a core parser.
- One-time vendor setup the product can only document: OAuth client registrations.
- Filed platform asks stay in `BLITZDEV-PLATFORM-ASKS.md` (scheduled triggers would upgrade the mode-b janitor). The HKDF-per-project ask is withdrawn — the plan no longer stores roots through the platform secrets API.

## 6. Review deltas (2026-08-13)

Folded from a 25-agent adversarial workflow (8 confirmed findings, 12 refuted) and a `gws`-CLI end-user persona test:

1. Anthropic/OpenAI vendor minters removed — Anthropic's Admin API cannot create or delete keys (Console-only), and org members mint dashboard keys at both vendors anyway; both run as kind `static` through the proxy.
2. Root storage unified to encrypted D1 columns in both modes; the platform secrets API carries only `CRED_MASTER_KEY` (runtime writes never reach a loaded isolate).
3. `credential_leases.box_id` now `ON DELETE SET NULL`; revoke runs inside the destroy transaction — a bare FK bricked destroy and the orphan sweep (reproduced on real D1).
4. Proxy route is `/proxy/:leaseId/*` with the token in the `Authorization` header; new no-secrets-in-URLs invariant + tail-transcript gate.
5. Resource-side bound added: `integrations.usable_by`; authorize() clause 2 is now (manifest ∩ allow-list); manifest gained a narrow-only provenance rule.
6. `proxy_tokens` table removed — `token_hash` lives on the lease (`phone_home_hash` idiom).
7. `Placement` carries values and gained `unset-env`; the OAuth descriptor gained `client_id`, `authorization_params`, `default_scopes`, `placements`.
8. Fixed public OAuth callback path specified; leases record **granted** scopes with mint-time verification (Google refresh cannot narrow).

## 7. Deferred (2026-08-14)

Cut to keep v1 thin. Each returns as one module or one column when real demand appears; `kind` and `custody` are TEXT, so none needs a migration: the `sts` kind + `federation` custody (AWS), `google-sa` DWD, `blitz-cred exec`, the `helper` placement, per-request `reason`, the `expired`, `delivered`, and `requested` events (no flow writes them — the flows write four), the delivery daemon (`watch` lease renewal, boot pre-mint, `status.json` — one sync hook replaced them), the `--scope` flag, the manifest `network:` egress field + broker lease-reporting, HKDF per-name root keys (name-as-AAD keeps the row binding with one key), the redacting request logger (hono's logger never prints headers or bodies; the no-secrets-in-URLs gate is the control), proxy audience enforcement (`box_id` stays as audit — the lease token is the only auth a proxy call carries), request auto-expiry (the dedup index bounds the inbox; deny is manual), the `rotating_refresh` descriptor flag + per-family serialization (Atlassian-only; needs locking mode (b) does not have).
