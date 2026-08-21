# Plan: teenyapps as a first-class BlitzOS surface

Status: **plan only — nothing here ships until approved.**
Date: 2026-08-19. Sources: recon of `~/superapp/teenybase/backend` (path:line cites below), https://teenyapp.com/agents.md, the live example https://mj-plans-3.app.blitz.dev/, and the BlitzOS control plane in `~/blitz-core-aws`.

Goal: a teenyapp created inside a BlitzOS workspace belongs to your org the moment it exists, carries a platform meta navbar (share / comments / history), and can be attached to a live agent session as an observed — and eventually primary — working surface.

---

## 0. Ground truth (what the backend actually has)

| Fact | Where | Consequence |
|---|---|---|
| No org/team concept anywhere; ownership is a scalar `dynamic_projects.owner_id` | `migrations/10000`, `teenybase.ts:127` | Org support is new construction, but see D1 below for the cheap shape |
| `owner_id` is duplicated into `resources.user_id`, kept in sync by a SQL trigger, and read by a *second worker* (project-gateway) | `migrations/0000` (trigger), `project-gateway/src/index.ts:169` | Any ownership indirection must not break quota accounting or serving |
| Anonymous create → claim is one CAS UPDATE; `ownerOverride` already exists for owned creation | `dashboard.ts:1576-1589`, `projects.ts:86-157` | Claimless creation is mostly *exposing* an existing path, not building one |
| The synthetic-owner pattern is proven in production: `ANON_SENTINEL` is a `platform_users` row that owns every unclaimed project | seed script + `anon-projects.ts` | An org can be a user (D1) |
| **Platform versioning already exists**: `project_commits` + a full R2 file snapshot per commit (`…/files/<commitHash>/src/*`) | `projects.ts:769-812`, `:477` | History = expose; **restore endpoint = build** (none exists) |
| Served apps return the tenant worker's response **verbatim**; zero platform injection today; single clean seam at `project-gateway/src/index.ts:313-325` | recon §5 | Meta navbar has exactly one right home |
| The gateway worker has **no auth code at all**; the platform cookie is scoped to the apex (`blitz.dev`), not to `*.app.blitz.dev` | `dashboard.ts:98` | Cross-origin identity is the hardest problem in this plan (D3) |
| No realtime anywhere: no DO, no WS, no SSE, no write hooks, no oplog. Agents can only poll `/exec/<table>/select` | recon §6 | "Chat with app" needs a change feed we must create (D5) |
| Per-project agent briefing + tool catalog already generated: `GET …/agents.md`, `GET …/tools.json` | `projects.ts:928,995` | The "specialized agent" harness bundle already half-exists |
| Two brands, one backend; projects pinned to a `previewDomain`; dashboards disjoint per brand | `project-helpers.ts:76-146` | Org features land on the blitz.dev brand first; teenyapp.com follows free |
| Found bug: the SSR claim path (`performClaim`, `dashboard.ts:2656-2662`) updates `dynamic_projects` but **not** `resources.user_id`; the JSON path does both | recon §2 | Fix in P0 while touching the seam — quota drift is live today |

---

## 1. Load-bearing decisions

**D1 — An org is a `platform_users` row, not a new ownership axis.**
Full org tables would force rewriting ~15 scalar `owner_id = ?` predicates across two workers plus the `resources` trigger invariant. Instead: create one platform user per BlitzOS org (`role='org'`, mirroring the proven `ANON_SENTINEL` shape) and one new table `org_members(org_user_id, member_user_id, role)`. Org-owned project = `owner_id` → the org user. Everything downstream — quotas, `resources`, the gateway lookup, `project_tokens` impersonation — keeps working unchanged. The only query change: reads that mean "projects I can touch" go from `owner_id = ?` to `owner_id IN (me, my orgs…)`, and that is a handful of sites (`project-helpers.ts:178-200`, `projects.ts:390`, `dashboard.ts` list queries), not a schema rewrite.

**D2 — BlitzOS is the identity source of truth; teenyapp mirrors.**
teenyapp already has the provisioning primitive (`POST /admin/seed-user` behind `ADMIN_SERVICE_TOKEN`, `admin.ts:16`). BlitzOS pushes: on account creation/first use → seed the user; on org create → seed the org user; on membership change → upsert `org_members`. Push is `waitUntil` best-effort plus a reconcile sweep, because the teenyapp worker has no queues. The alternative (teenyapp verifies BlitzOS-signed claims at request time, no mirror) is elegant but couples every teenyapp request to BlitzOS availability; mirroring keeps teenyapp standalone for non-BlitzOS users.

**D3 — The meta plane lives in the gateway, and the tenant app never sees its credentials.**
Three parts:
1. **Inject**: wrap `resp` at `project-gateway/src/index.ts:313-325` with `HTMLRewriter` when `content-type: text/html` — mount a navbar script/iframe. Slug, project row, brand are already in scope there. Survives forks and rebuilds; zero changes to user files.
2. **Meta API**: the gateway intercepts `/__meta/*` (identity, share, comments, history) *before* `fetcher.fetch`, exactly as it already does for `/agents.md|/clone|/fork` (`index.ts:226-245`). Tenant code cannot shadow these routes.
3. **Identity without leaking the platform session**: never widen the apex cookie to `.blitz.dev` — every tenant *worker* would receive it in the Cookie header. Instead a per-app handshake: navbar bounces to `blitz.dev/__meta/authorize?app=<slug>` (apex cookie proves you), which 302s back with a short-lived signed token; the gateway sets it as an app-origin cookie with narrow claims (user, project, role, exp). The gateway **strips that cookie from every request it forwards to the tenant worker**, so even the scoped token never reaches user code. Gateway gains one JWT verify + one new secret binding — it currently has none.

**D4 — "Checkout" is forward-only restore, and it restores code, not data.**
`POST …/restore/:commitHash` copies the R2 snapshot `…/<hash>/src/*` over `HEAD/src/*` and runs the existing buildAndCommit — producing a *new* commit, git-revert style. No history rewrite. Be honest in the UI: tenant D1 migrations are explicitly irreversible (`agent-briefing.ts:292`), so restoring old code against newer schema can mismatch; the stored `config_json` per commit lets us diff and warn before restoring.

**D5 — App observation is an injected oplog; poll first, push later.**
Tenant data lives in per-project D1 the platform only reaches through the loaded isolate — no change feed exists. The pragmatic ladder:
- **v1 (poll)**: `save_version` ETag for file changes (already exposed with `If-Match` semantics) + periodic `/exec/<table>/select` reads.
- **v2 (oplog)**: the build pipeline already applies platform-authored migrations to tenant D1; append a meta-migration installing a `_changes` table + SQLite triggers on tenant tables, then a `/__meta/changes?since=` contract. Tenant writes produce rows with zero tenant-code cooperation.
- **v3 (push)**: a gateway Durable Object per project fanning out SSE to subscribed agents. Only if v2 polling proves too slow — it probably won't for "the founder clicked around in the app".

---

## 2. Feature plans

### 2.1 Auto-provisioned account + org membership
Reuse: `platform_users`, JWT auth extension, `POST /admin/seed-user`.
Build (teenyapp): `org_members` table + migration; owner-set resolution helper used by the ~15 read predicates; `role='org'` user seeding.
Build (BlitzOS): `teenyapp_identity` mapping table (blitzos user/org → teenyapp user ids); push hooks on signup/org-create/membership-change; reconcile sweep.
Note: teenyapp accounts hang off Google email today — BlitzOS logins are Google too, so seeded users share the email and a later direct login just works (`email_verified` set by the seed).

### 2.2 Claimless creation from a workspace
Reuse: `ownerOverride` in `provisionProjectInsert`; `X-Blitz-Agent` parsing; token minted synchronously in the create response.
Build (teenyapp): a **separate trusted route** — `POST /api/v1/orgs/new-project/<slug>` with `Authorization: Bearer <workspace credential>`. Not a flag on the anon route: its tripwire, rate limit, and rollback logic all assume sentinel ownership (`anon-projects.ts:337-340`), and `ownerOverride` currently *requires* `expires_at`/`anon_meta` and skips `checkResourceLimits` (`projects.ts:88,106`) — the trusted route sets owner = org user, `expires_at NULL`, re-enables limits, and returns no `claim_url`.
Build (BlitzOS): the workspace credential is just a **connection** (see `plans/CONNECTIONS_UX.md`): a `teenyapp` provider whose lease drops `TEENYAPP_TOKEN` + a skill into the box. teenyapp validates it against a shared signing secret and resolves workspace → user → org. The agent inside the workspace then runs the exact flow from agents.md, minus claiming.
Response contract: same shape as today with `claim_url` absent and `owner` present — agents keying on `claim_url` simply have nothing to nag about.

### 2.3 Meta navbar: sharing, comments, history
Mechanics per D3. Content:
- **Share**: shows owner (member or org) + org members (mirrored, so prelisted); actions: move ownership member↔org, toggle `visibility` (column exists; today it gates fork/explore only — decide whether "private" should finally gate *serving* in the gateway, which currently serves every open project publicly. Recommend: yes, add `visibility='org'` enforced at the gateway via the D3 token — that's the first real access control on served apps).
- **History**: list `project_commits` (exists) + restore per D4. Per-commit diffstat is computable from the two R2 prefixes.
- **Comments**: new platform tables `app_comments(project_id, author_user_id, path, anchor JSON, body, resolved, created_at)` + thread replies. v1 anchors = page path + click-point pin (Figma/Vercel style), not DOM-range annotation — Google-Docs-grade anchoring on arbitrary user-generated DOM is a tarpit; pins deliver 90% of the collaboration value. Poll on focus; no realtime dependency.
- Navbar renders as a slim bottom-right pill expanding to a drawer, injected iframe from the apex origin so its DOM/CSS cannot collide with the tenant app.

### 2.4 Chat with app
BlitzOS webApp: teenyapp cards (TeenyappsPanel) get a "Connect to agent" action listing the workspace's open agent tabs (chat tabs with `chatSessionId`, claude/codex terminals). Connecting stores the binding in the workspace doc.
Box side: the **actor** (which already brokers ACP sessions) runs the watcher — it polls the app per D5 using the leased `tp_` token, diffs, and injects compact change events into the bound session as context messages ("user created row X in `plans`"). CP relays nothing; box talks to teenyapp directly.
Navbar side: the app's navbar shows the live "watched by <agent tab>" state via `/__meta`, closing the loop the user asked for: click chat icon in the app → pick an open panel.

### 2.5 Specialized agent (stretch)
Promote an agent tab so the teenyapp *is* its harness. The bundle mostly exists on the teenyapp side already: per-project `agents.md` (briefing) + `tools.json` (tool catalog) + `/exec`//`exec_write` + files API + the D5 change feed. "Promote" = spawn/rebind a chat session whose system context is that bundle plus the lease. mj-plans-3 is the proof of shape: an app the agent reads and writes as structured, versioned memory (26/3/5 versions, ACTIVE status) — not a preview it once produced. v1 is a context-bundle convention, not new infrastructure; the infrastructure (D5 v2/v3) is what makes it feel alive.

---

## 3. BlitzOS-side wiring

- **TeenyappsPanel sections come alive**: "BlitzOS" grid ← `GET /api/v1/orgs/:org/projects` (new, teenyapp); "My teenyapps" ← existing owned-project list for the mapped user, brand-filtered to blitz.dev. Cards deep-link `preview_url` and (later) surface share/watch state. The panel shipped with honest empty states waiting on exactly these two calls.
- **The teenyapp connection** is the single credential artery: workspace-scoped token for claimless create, agent `tp_` access, and the navbar deep links. One lease, all three features.
- Org rename etc. propagate through the D2 mirror push (BlitzOS has no org-rename API today — that gap exists independently and should be fixed with it).

## 4. Phasing

| Phase | Ships | Size |
|---|---|---|
| **P0** | org-as-user + `org_members` + owner-set reads; seed/mirror push from BlitzOS; trusted create route; teenyapp connection provider; TeenyappsPanel list APIs; fix the SSR-claim `resources` bug | ~1 wk of focused work, all backend |
| **P1** | gateway meta plane: HTMLRewriter navbar, `/__meta/*`, D3 handshake; share + history list + restore | the security-sensitive week — review the handshake hard |
| **P2** | comments v1 (pins); visibility='org' gating at the gateway | small once P1 exists |
| **P3** | chat-with-app: `_changes` meta-migration + actor watcher + connect UI | medium; box/actor change ⇒ image rebuild train |
| **P4** | specialized agent bundle; SSE DO only if polling disappoints | small on top of P3 |

## 5. Risks and landmines

1. **Cookie scope** is the one place a wrong choice is a security incident: widening the apex cookie hands the platform session to every tenant worker. D3's strip-before-forward keeps even the scoped token out of user code. Do not ship any navbar that authenticates another way.
2. **`resources` trigger invariant**: org-as-user keeps it intact, but the P0 reviewer should still exercise fork/claim/create against quota accounting; the existing SSR-claim bug shows this seam already drifts.
3. **Restore vs schema**: D4's warning path must land with restore, or the first restore against a migrated schema produces a confusing broken app.
4. **Mirror drift**: membership pushes are best-effort; the reconcile sweep is not optional.
5. **Brand bleed**: org features must respect `previewDomain` filtering or BlitzOS orgs will surface on teenyapp.com dashboards.
6. **Anon path regressions**: the trusted route must not share mutable state with `anon-projects.ts`; its tripwire/RL protects the open internet and should not learn about orgs.

## 6. Open questions

1. Default owner for workspace-created apps: the org (recommended — matches "no claiming, automatically added", and sharing is then free) or the creating member with an org grant?
2. Should `visibility` finally gate *serving* (org-private apps), or stay fork/explore-only for now? Recommended: gate, in P2.
3. Comments: are click-point pins acceptable for v1, or is text-range annotation a hard requirement?
4. Does teenyapp.com (non-BlitzOS brand) get orgs in the same release, or after BlitzOS proves the model?
