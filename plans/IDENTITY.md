# Identity: from one operator to users, orgs, and grants

Revised 2026-08-15, after connectivity shipped. Supersedes the pre-tunnel
draft (see git history of this file for the long form; detail lives in the
evidence files, which remain valid for the v2 reference model).

Problem: blitz core authenticates every human as the single literal principal
`operator` derived from one `OPERATOR_API_KEY`
(`packages/control-plane/core/principals.ts:79-86`). There are no users,
organizations, memberships, invites, or workspace grants. The README promises
a collaborative team product; [TODO.md](TODO.md)'s e2e customer test requires
Google SSO, member invites, workspace sharing, and revocation.

Evidence base:

- [evidence/identity-v2-model.md](evidence/identity-v2-model.md) — the
  monorepov2 production identity model. Cited as **[v2]**.
- [evidence/identity-core-auth.md](evidence/identity-core-auth.md) — blitz
  core pre-tunnel state. Line numbers there are stale; the refreshed
  current-state section below supersedes them. Cited as **[core]**.

## What connectivity changed (verified against the repo, 2026-08-15)

Tunnel-per-workspace shipped (CONNECTIVITY phase 1; commits `fc1c4e7`,
`1551382`, `befea5f`). Three consequences for this plan:

1. **The "identity to the guest" rails now exist.** The CP derives a
   per-workspace `webAppToken = HMAC-SHA256(WEBAPP_TOKEN_SECRET, workspaceId)`
   (`core/workspace-tunnels.ts:59-75`), delivers it at bootstrap to
   `/var/lib/blitz/webapp-token` (`core/cloud-init.ts:38-58,89-93`), injects
   it as `X-Blitz-WebApp-Token` on every proxied webapp request
   (`core/workspace-tunnels.ts:134-140`), and the guest gateway verifies it
   constant-time and strips it before forwarding
   (`packages/box/gateway/main.go:92-104,381-384`). The old plan's
   "genuinely new layer" — transport, per-workspace key delivery, guest
   verifier — is therefore already in production as a *static* credential.
   The ticket phase no longer invents a mechanism; it upgrades this token to
   a short-lived signed ticket carrying `{userId, role, surface, exp}`,
   keyed by the same per-workspace secret. The old open question 4 (ticket
   signing key) is resolved: per-workspace symmetric, already shipped.
2. **The CP is the only browser ingress.** The webApp calls
   `/workspaces/:id/webapp/:port/*` (`packages/webapp/src/resolver.ts:27-34`);
   the CP proxies via the tunnel (cloud VMs, `core/workspaces.ts:525-543`)
   or via the microvm host bearer (`core/providers/microvm.ts:274-282`).
   The browser never sees the tunnel hostname or any token. Consequence:
   **CP-side grant enforcement is sound on its own** — a granted-but-limited
   user cannot bypass the CP to reach the guest. Sharing can ship at the CP
   (phase 2) before guest-side tickets (phase 3). Tickets become
   defense-in-depth plus attribution, not a shipping blocker for sharing.
3. **Known gaps, closed in the ticket phase, not before:** the gateway runs
   with `authRequired=false` when the token file is absent — which is every
   microVM guest today (`main.go:369-378`); microvm enroll delivers only the
   box credential, no webapp token
   (`microvm-host/guest/blitz-microvm-enroll.js:255-258`); missing Origin is
   still accepted (`main.go:410-425`). The enroll change revs the phone-home
   fixture contract (CLAUDE.md contract table) and requires a box-image
   re-pin (cf. commit `fd3970c`).

## Decisions

Carried from the collab plan:

- **Google OAuth is the login.** GitHub is an integration only
  ([ICP-GAPS.md](ICP-GAPS.md) §B), never the sign-in.
- **DB-backed sessions stay.** A browser session is a row in the
  `sessions` table: the cookie carries a random token, the server stores
  only its SHA-256 hash, and every request joins that hash to the
  principal (`core/principals.ts:61-77`). v2 instead signed the whole
  session into the cookie and kept no server row. We keep the row scheme —
  revocation is a row delete, org switch is a row update — and add
  `membership_id`; membership revalidation (org, role, `status='active'`)
  rides the existing join. No stateless HMAC cookie port.
- **No localStorage tab/chat state — now, not later.** Server-side webApp
  state is **phase 1**, ahead of identity. It needs only a server home
  keyed by `(principal, workspace)`, and the single `operator` principal is
  a valid key today; rows re-key to the first real user by the same
  bootstrap-demotion backfill as everything else. Once state lives server
  side, the localStorage namespace question disappears with it.
- **Teenybase check stays, timeboxed** (first step of phase 1). The worker already runs on
  teenybase (`src/worker.ts` imports it), so audit only its users/OAuth/
  session primitives. v2 hand-rolls all of this on D1 with Web Crypto and it
  is portable [v2]; the audit exists to avoid double-building, not to pick a
  framework.

### Teenybase auth audit (0.0.15, 2026-08-16)

| Primitive | Use / skip | Reason |
|---|---|---|
| Auth-table user records | Skip | Its email/username auth shape cannot preserve the required Google-`sub` identity key, profile refresh, nullable membership, and bootstrap backfill transaction. |
| Google OAuth redirect flow | Skip | It owns callback routing and mints framework JWT sessions, while this design must bind a DB session row to a selected membership and run one-shot bootstrap logic atomically. |
| OAuth state cookie | Skip | The built-in 10-minute CSRF cookie is unsigned and the installed flow does not provide the plan's signed state payload and constant-time verification contract. |
| JWT access tokens | Skip | Revocation and org rebinding require the existing hash-only D1 session row, not a stateless bearer token. |
| KV refresh-token sessions | Skip | Rotation is useful but conflicts with the deliberate DB-backed browser-session decision and adds a second session store. |
| Auth cookie integration | Skip | It transports teenybase JWTs; the existing `blitz_session` cookie transports an opaque token whose hash is stored in D1. |
| Auth row rules (`auth.*`) | Skip | Core routes already resolve a `Principal`; membership-aware authorization remains application SQL and explicit route checks. |

Newly resolved (previously open questions 1, 3, 4, 5):

- **Signup is self-serve, through an explicit create-org page.** A first
  Google login with no membership lands on a create-org page — one name
  field and a create button. `POST /orgs` (deliberately absent in v2)
  exists here, gated to users with no active membership; it creates the
  org with a default `vm_limit`, an active admin membership, and rebinds
  the session. Invite and stub-claim logins skip the page. TODO.md's e2e
  branch (b) — "types one prompt and sets it up" — requires self-serve.
  Cut with this decision: untargeted org-creating invites, invite-gated
  signup, silent auto-created orgs, and v2's paid-claim path. If signup
  gating is ever needed, it is an allowlist env flag, not an invite
  machine.
- **Invites always target an org.** `target_org_id NOT NULL`; no
  `created_org_id` column.
- **No `/choose` flow, no pending-identity cookie.** v2 needed them because
  its sessions were stateless cookies. With DB sessions, login binds the
  most recently used active membership (else the newest), and switching org
  is a plain authenticated endpoint that rebinds the session row. A member
  of two orgs (personal + team — the normal e2e case) switches via the org
  menu.
- **API keys land with ICP-GAPS §B**, not here. Schema reserved, nothing
  built.
- **Org slugs**: slugified display name plus a short random suffix on
  collision; orgs are renameable. Closed.
- **Viewer ships in the ticket phase, not sharing v1.** Read-only terminal
  and replay-only chat need enforcement the CP alone cannot give cleanly
  (`ro` is a ttyd URL arg the CP can force, but replay-only chat means
  filtering ACP frames in the Worker — protocol coupling we refuse). Sharing
  v1 grants **editor only**, which covers the e2e test. The grants schema
  admits `viewer` from day one; the grant API rejects it until phase 3.
- **One DTO truth: `role`.** The server annotates each workspace with the
  caller's `role` (`owner | admin | editor | viewer`) and a joined
  `owner {name, avatarUrl}`. No serialized `canControl`/`shared` booleans —
  the webApp derives affordances from `role`; the server enforces
  regardless. This kills v2's dead owner badge and client-derived capability
  drift [v2].

## Reference model (v2) — what to port, what to skip

Full detail in [evidence/identity-v2-model.md](evidence/identity-v2-model.md).
Port exactly: `users`(=identities)/`orgs`/`memberships` shapes and enums
(role `'admin'|'member'`, status `'invited'|'active'|'disabled'`,
`UNIQUE(user_id, org_id)`, no org-type column, `platform_operator` flag);
hash-only invite codes (32 random bytes → base64url, 43-char SHA-256 hash
stored, states `'ready'|'redeemed'|'revoked'|'expired'`, one shared TTL
constant, redemption inside the OAuth callback, atomic); stub memberships
claimed at first login; last-active-admin protection;
`canControlWorkspace` = same org AND (admin OR owner membership); error
convention cross-org → 404, same-org unauthorized → 403.

Do not copy v2's defects: UI/server TTL drift, missing members UI, owner
badge with no data, client-derived capabilities, the incomplete observe
authz. v2 has no grants, no viewer for ordinary members, no presence, and no
attribution — those are additive here, not ports.

## Current state (verified 2026-08-15)

- `Principal` is `{id, unixName, harnesses}`; login compares
  `OPERATOR_API_KEY` and returns literal `operator`
  (`core/principals.ts:13-17,79-86`).
- Migrations run 0001–0007. 0006/0007 add `tunnel_id`, `tunnel_hostname`,
  `dns_record_id` to `workspaces`. No identity tables anywhere.
- Workspace routes: list is owner-filtered (`core/workspaces.ts:492-499`);
  the webapp proxy requires `row.owner_id === principal.id`
  (`core/workspaces.ts:502-507`) — this single check is where the grant
  check will mount; destroy is owner-equality (`:563-568`); there is no
  `GET /workspaces/:id`; allowed webapp ports are exactly 7444 (→ `/acp`)
  and 7445 (`:513-516`, `core/workspace-tunnels.ts:10`).
- Literal-`"operator"` superuser bypasses remain in credentials
  (`mint.ts:68-74`, `leases.ts:126-130,159-163`, `requests.ts:223-230`).
- Volumes routes and integrations PUT/DELETE are any-principal, unscoped
  (`core/volumes.ts:25-44`, `core/credentials/registry.ts:352-379,404-420`).
- The webApp still fabricates tenancy: synthetic `/me` with membership
  `personal`, role `admin` (`packages/webapp/src/api-adapter.ts:58-73`);
  every workspace maps to `ownerMembershipId: "personal"` (`:99-103`).
  `CockpitRail` is now `WebAppRail.tsx`; `packages/ui` is `packages/webapp`.
- Actor sessions store only `{id, provider, cwd, resume_id}` — no creator or
  ACL (`box/actor/src/journal.ts:18-23`); ops are new/load/prompt/cancel
  with no caller checks and no `session/list`
  (`actor.ts:256-277`, `server.ts:63-71`).
- ttyd runs `--writable` with URL-arg passthrough; nothing server-side
  forces `ro` (`box/rootfs/.../ttyd/run:5`). The microvm host strips auth
  headers and cookies before the guest (`microvm-host/http.go:147-150`).

## Target design

### Server-side webApp state (phase 1, before identity lands)

Migration `0008_webapp_state`: one table
`webapp_state (principal_id, workspace_id NULL, doc, updated_at,
UNIQUE(principal_id, workspace_id))`. Per-workspace rows hold tabs, tab
types, titles, chat session ids, and drawer state; the workspace-NULL row
holds globals (active workspace, workspace order). `doc` is JSON parsed at
the boundary into a named, versioned type (house rules). GET/PUT under the
session principal; last-write-wins. The webApp swaps `storage.ts`
persistence for these routes; device-local ephemera (e.g. rail collapse)
stays in localStorage. Chat session ids stored server-side give
cross-device chat resume before the actor grows `session/list`. Rows key on
the `operator` principal today and re-key at bootstrap demotion.

Lifecycle: workspace destroy tombstones the `workspaces` row
(`phase = 'destroyed'`, `core/workspaces.ts:640-646`) — it never deletes
it — so `ON DELETE CASCADE` would never fire. Cleanup is therefore
explicit, in both places the repo already deletes per-workspace rows:
`DELETE FROM webapp_state WHERE workspace_id = ?1` in the destroy batch
(next to the boxes delete, `core/workspaces.ts:636-638`) and in the orphan
sweep (`core/janitors.ts:63-72`), which re-runs the same deletes for
workspaces stuck in `destroying`. The FK is plain
`REFERENCES workspaces(id)`, matching `credential_leases` — no cascade
that can never fire. The workspace-NULL global row survives destroy and
may reference dead ids; the webApp reconciles it against the live
workspace list on load, which it needs anyway because another device can
destroy a workspace while a stored doc is stale.

### Identity schema — one migration, `0009_identity`

All identity tables land together (they are inert until their routes ship;
each migration keeps the three-places rule to a single sync: migration +
`build-blitzdev.mjs` table defs + `blitzdev-schema.test.ts` exact-set
assertions, index names per [PORT-DESIGN.md](PORT-DESIGN.md)).

```
users              id, google_user_id UNIQUE, email UNIQUE (lowercased),
                   name, avatar_url, platform_operator INTEGER CHECK(0,1),
                   created_at, updated_at
orgs               id, slug UNIQUE, name, vm_limit, created_at, updated_at
memberships        id, user_id, org_id,
                   role CHECK('admin','member'),
                   status CHECK('invited','active','disabled'),
                   UNIQUE(user_id, org_id)
invites            id, code_hash (43-char b64url SHA-256), email NULL,
                   target_org_id NOT NULL, role,
                   state CHECK('ready','redeemed','revoked','expired'),
                   created_by_membership_id, redeemed_by_user_id,
                   created_at, expires_at, redeemed_at
workspace_grants   id, workspace_id, membership_id,
                   role CHECK('editor','viewer'),   -- API grants editor only until phase 3
                   granted_by_membership_id, created_at,
                   UNIQUE(workspace_id, membership_id)
sessions           + membership_id
workspaces         + org_id, + owner_membership_id (nullable, backfilled at
                   bootstrap demotion)
```

- `principals` stays as the resolved request actor: routes keep consuming
  `Principal`, which becomes a view over `users` + the session's membership.
  `boxes.principal_id` and `workspaces.owner_id` migrate by backfill, not
  rewrite-the-world.
- Quota moves from per-owner to per-org `vm_limit`.
- Grants hold only `editor`/`viewer`. Owner and org-admin rights come from
  the membership (`canControlWorkspace`), never from grant rows.

### Authentication (Google, in v2's shape)

- Authorization-code + PKCE; signed 10-minute state cookie; constant-time
  state compare; ID-token/userinfo used transiently, never persisted.
  Identity key is Google `sub` → `users.google_user_id`; profile refreshed
  each login.
- **Stub-claim by verified email**: `POST /members` creates a user stub
  keyed on lowercased email + an `'invited'` membership; first Google login
  with a matching **verified** email binds and activates it. Unverified
  emails never claim. (This is TODO.md's "add members by email" without
  needing email-sending infrastructure.)
- **Invite links**: org-targeted only, v2 mechanics (hash-only storage,
  shared TTL constant, status page `/invite/:code`, redemption inside the
  OAuth callback, atomic membership+redeem+session).
- **Onboarding**: a login with no active membership gets an identity-only
  session (`membership_id NULL`) and the webApp routes to the create-org
  page (see decision). Invite redemption and stub claims bind a membership
  inside the callback and skip that page.
- **Bootstrap demotion**: `OPERATOR_API_KEY` stops authenticating routes;
  it becomes a one-shot bootstrap secret that marks the first Google login
  `platform_operator = 1`, seeds its org + admin membership, and backfills
  rows owned by principal `operator` to that membership. The literal
  `"operator"` bypasses in mint/leases/requests are replaced by the flag.

### Authorization

Capability matrix (viewer column activates in phase 3):

| Capability | viewer | editor | owner / org admin |
|---|---|---|---|
| Workspace metadata (org list, `GET /workspaces/:id`) | yes | yes | yes |
| Terminal | forced `ro` | read-write | read-write |
| Chat | replay only | prompt | prompt |
| Files | read | write | write |
| Leases, requests, credential actions | — | — | yes |
| Destroy, rename, grant management | — | — | yes |

Route deltas from today:

| Route | Today | Target |
|---|---|---|
| `POST /workspaces` | any principal; quota per owner | active membership; sets `org_id` + `owner_membership_id`; quota per org |
| `GET /workspaces` | owner filter (`:492-499`) | org filter; per-row `role` + `owner{name,avatarUrl}`; webapp URLs nulled below the capability line |
| `GET /workspaces/:id` | absent | add; cross-org → 404, same-org ungranted → 403 |
| `ALL /workspaces/:id/webapp/:port/*` | owner equality (`:502-507`) | grant check per capability; CP owns the upstream URL and query (forces `arg=ro` for viewers in phase 3, strips client-supplied args) |
| `DELETE /workspaces/:id` | owner (`:563-568`) | owner-or-admin — never editor |
| Leases/requests | owner or literal `"operator"` | owner-or-admin of the workspace's org; `platform_operator` replaces the literal |
| Volumes | any principal, unscoped | org-scoped; ownership check on attach |
| Integrations PUT/DELETE | any principal, global | org-scoped rows, org-admin gated; `created_by` exposed and maintained |
| Machine types, host register, phone-home, `/proxy/:leaseId` | as today | unchanged mechanically |

Preview ports: none exist today (7444/7445 only). When preview ports land,
adopt v2's same-org rule. Not designed further here.

### Sharing v1 — CP-enforced (phase 2)

Grant CRUD (editor only), revoke, org-scoped list annotation, share +
members UI. Enforcement lives entirely in the CP webapp-proxy and workspace
routes. Soundness rests on consequence 2 above: the browser never holds the
tunnel hostname/token or host bearer, so every guest-bound request passes
the CP's grant check first. Editors share the owner's tmux session, agent
sessions, and permission prompts un-attributed — acceptable for
mutually-trusting collaborators; attribution and guest enforcement are
phase 3.

**Revocation is immediate** (decision). Two moves in one action: the CP
deletes the grant row — every HTTP request re-checks, so non-ws surfaces
403 at once — and calls a new gateway endpoint (`POST …/admin/drain`,
authenticated by the existing webapp token, reached over the existing
proxy path) that closes every live WebSocket on that workspace. Clients
already recover from a forced close unaided (verified 2026-08-16): the
terminal auto-reconnects with backoff and reattaches the same tmux
session with a full redraw (`webapp/src/TtydTerminal.tsx:333`,
`box/rootfs/.../blitz-term:66`, proven by `box/test/smoke.sh:157-175`),
and chat reconnects, re-issues `session/load` with the kept session id,
and merges the replay without duplicates
(`webapp/src/chat/ChatPanel.tsx:94-130`). The revoked user's reconnect
fails the grant check. Coarse but immediate — revokes are rare. Phase 3
tickets identify connections and turn the drain into a per-user
disconnect. The drain is a small gateway addition, so phase 2 carries a
box-image re-pin. One known fix ships with it: a close during an
in-flight prompt strands chat in `running`/"Working…"
(`ChatPanel.tsx:182-197`, `chat/reducer.ts:97-107`) — reconcile `running`
on reconnect. Implementation check: confirm the microvm 7444 path passes
the gateway; if it proxies straight to the actor, the actor needs the
same drain hook.

### Tickets — guest-verified identity (phase 3)

Upgrade the shipped static token, same header, same secret, same verifier:

1. CP mints per-request tickets `{workspaceId, userId, membershipId, role,
   surface, exp}` signed with the workspace's `webAppToken` secret.
2. Microvm parity: enroll delivers `/var/lib/blitz/webapp-token` — a
   phone-home contract change (fixtures on both sides per CLAUDE.md) and a
   box-image re-pin.
3. Gateway parses tickets, enforces per surface: appends `arg=ro`
   server-side for viewers; passes verified identity to the actor
   connection. `authRequired` becomes unconditional; missing-Origin
   acceptance is removed.
4. Actor grows the access model: sessions gain `created_by` +
   participants; new `session/list` (also unblocks resume-from-any-device);
   `load`/`prompt`/`cancel` check role; viewers replay only; permission
   responses record the responding identity; events carry `{userId, name}`.
5. Viewer becomes grantable.
6. Explicit non-goal, unchanged: collaborators share the single `blitz`
   Unix user, one home, one tmux namespace, one SSH key. Isolation is at
   the grant/ticket layer, not the OS layer.

### Credential attribution (phase 3)

- Lease creation records the acting human (`credential_leases.user_id`,
  today always NULL); requests gain a requester column; denials append a
  resolution event; mint/revoke/deny event detail names the acting
  principal; an event-list route + webApp view.
- Integrations, two modes (TODO.md): org-level static tokens = org-scoped
  `integrations` rows, admin-gated (phase 2 scoping gives this); member
  personal OAuth = `user_connections` with real user ids — flows land with
  ICP-GAPS §B.

## e2e customer-test mapping ([TODO.md](TODO.md) common stream)

| TODO.md bullet | Covered by | Notes |
|---|---|---|
| Org admin does Google SSO | Phase 1 | first login lands on create-org (name field + create button) |
| Adds members by email or invite link | Phase 2 | email = stub-claim; link = org-targeted invite |
| Any member creates a dedicated workspace | Phase 2 | org quota |
| Share `/workspace` with members XYZ | Phase 2 (editor), phase 3 (viewer) | |
| Revoke access | Phase 2 | immediate: grant delete + ws drain |
| Share a folder/file, Drive-like last-edit model | [FILES.md](FILES.md) | folder-unit shares |
| Sign up → new workspace → open claude → log in | Phase 1 | harness login unchanged; boxes bind the owner user |

Answers to TODO.md's inline questions:

- *"view access, what happens right now?"* Today: nothing — a non-owner
  gets 404 at the CP; no grant concept exists. After phase 2: `viewer` is
  not yet grantable. After phase 3: ro terminal, chat replay, file read.
- *"edit access, what happens right now?"* Today: impossible. After
  phase 2: read-write terminal, chat prompt, file write; no destroy, no
  credential actions, no grant management.
- *"do shared folders/files sync into /workspace/shared?"* Storage-plane
  decision, deliberately outside this plan; either answer works on this
  model (see next paragraph). Specified in [FILES.md](FILES.md).

**Drive-like file sharing — why this model stays flexible.** Identity
deliberately fixes only the invariants file sharing will need: (a) the
grantee is always a `membership_id` and the person anchor is `users` —
stable keys any future `file_grants`/`share_links` table reuses untouched;
(b) grants follow one pattern `(resource_id, membership_id, role)` —
`workspace_grants` is the first instance, not a special case; (c) all file
traffic passes the CP chokepoint where per-resource checks mount; (d) the
phase-3 ticket carries `userId` into the guest, which is exactly the
"last-edited-by" attribution a Drive-like model needs. What identity cannot
answer is where shared files live (sync service, shared volume,
`/workspace/shared` materialization) — that is storage architecture,
orthogonal and unblocked. Cross-org/external sharing is out of scope; if it
ever lands, it keys on `users`, not memberships.

## Phases (dependency order)

1. **One real human.** In order: the timeboxed teenybase auth audit
   (use/skip table appended here; gaps filed in
   [BLITZDEV-PLATFORM-ASKS.md](BLITZDEV-PLATFORM-ASKS.md); default per v2
   evidence: hand-rolled on D1); server-side webApp state
   (`0008_webapp_state`, GET/PUT state routes, webApp drops localStorage
   for tabs, chat session ids, titles, order, active workspace, drawer);
   then identity (`0009_identity` with the three-places sync, Google OAuth
   routes, session `membership_id`, create-org onboarding page, first-admin
   seeding, operator-key demotion + backfill of all operator-owned rows,
   `webapp_state` included). Done when: the operator key no longer
   authenticates routes; login is Google; a new user lands on create-org
   and reaches a working webApp; `/me` is real; a fresh device restores
   tabs and chats.
2. **Team + sharing — the e2e milestone.** Org-filtered workspace routes +
   `GET /workspaces/:id`; volume and integration scoping; role-annotated
   DTOs; webApp sheds the synthetic tenant; members/invites UI;
   last-active-admin protection; org switcher; grants live (editor only)
   with share + revoke UI, the grant check at the webapp proxy, the
   gateway drain endpoint for immediate revoke (box-image re-pin), and
   the chat `running`-state reconcile on reconnect. Done when:
   **TODO.md's e2e passes** — a second human joins via email stub or
   invite link, sees org workspaces as metadata only (cross-org is 404),
   gets an editor grant, works in the shared workspace's terminal and
   chat, and loses all access on revoke immediately — live terminal and
   chat sockets included, with the others reconnecting seamlessly.
3. **Guest identity + attribution.** Tickets (upgrade the static token);
   microvm token delivery (phone-home fixture rev + box-image re-pin);
   gateway role enforcement with server-side `arg=ro`; actor ACL,
   `session/list`, attributed permission decisions; viewer becomes
   grantable; revoke drain becomes a per-user disconnect; `authRequired`
   unconditional and missing-Origin acceptance
   removed; credential-attribution columns, events, and the event-list
   view. Done when: the guest enforces role without trusting the proxy
   path; a viewer gets ro terminal + replay-only chat; every permission
   decision and mint names a human; a second device discovers and resumes
   sessions via `session/list`.

## Open questions (remaining)

1. Viewer chat "replay-only" transport detail — resolved inside phase 3
   design (ticket-gated subscribe vs. actor-side op filtering).
2. Storage architecture for folder/file sharing — resolved in
   [FILES.md](FILES.md); this doc only guarantees the identity invariants.
3. Preview-port access rule — v2's same-org default, decided when preview
   ports exist at all.

## Cross-references

- [TODO.md](TODO.md): the e2e customer test this plan must enable; phase 2
  is its done-when.
- [CONNECTIVITY.md](CONNECTIVITY.md): phase 1 shipped (the tunnel facts
  above); its phase 2 "sharing integration" is phases 2–3 here; its phase 3
  ticket pattern is phase 3 here.
- [ICP-GAPS.md](ICP-GAPS.md): §C expanded here (Google swapped in, orgs
  restored); §B owns API keys, GitHub App, and member OAuth connections.
- [README-GAPS.md](README-GAPS.md) §A done-when 1–6 map to phases 2–3;
  resume-any-device maps to phases 1 and 3.
- [CREDENTIALS.md](CREDENTIALS.md) /
  [BLITZDEV-PLATFORM-ASKS.md](BLITZDEV-PLATFORM-ASKS.md): broker
  positioning and teenybase asks.
