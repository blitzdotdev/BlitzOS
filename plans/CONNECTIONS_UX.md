# Plan: Connections — reachable, one-click, and usable as `@name`

Status: **plan.** The `integrations → connections` rename is live on this branch; everything else here waits for approval.
Date: 2026-08-19, revised same day after the ownership-model decision (per-user grants only — see §1).
Grounding: full audit of the credential subsystem in `~/blitz-core-aws` (citations use pre-rename names where the code still has them).

The question this answers: *how does a person put a connection into a workspace without vim, how does a template come with connections attached, can Figma/Linear be one click, and how does "use @figma for X" just work in any harness?*

---

## 0. Audit: the state of a user's ability to add a connection today

| Capability | State | Where |
|---|---|---|
| See requests / leases / events per workspace | ✅ side-rail panel (shipped with the panes work) | `WorkspaceDrawer.tsx:273-302` |
| **Create** a connection from the workspace panel | ❌ none — the panel is read/approve-only | — |
| Create from settings | ✅ admin-only, `/settings/connections`, 5 hardcoded templates, kinds `app-jwt` + `static` only | `settings/ConnectionsPanel.tsx` |
| `kind:'oauth'` | ❌ enum accepted, then rejected at PUT — no oauth minter exists (`minters = [githubApp, static]`) | `registry.ts:22,308-334` |
| Custody `broker` | ❌ enum only, every combination rejected | `registry.ts:331-333` |
| Per-user grants | ❌ `user_oauth_grants` table exists with zero readers/writers; `credential_leases.user_id` never populated | `0003:15-23,30`, `0017` |
| OAuth authorize/callback for third parties | ❌ none (Google login and the box device flow are unrelated) | — |
| Workspace templates carrying connections | ❌ templates = name + machine type + ≤16 folders, nothing else | `0016`, `workspace-templates.ts:34-56` |
| `POST /workspaces` accepting connections | ❌ only `manifest`, which is a *ceiling* (deny-list), not a provisioner | `workspaces.ts:89-134` |
| Pre-mint at workspace ready | ❌ first mint happens when a human opens a shell (`blitz-creds.sh:23-27`) | — |
| Inject MCP/skills/CLI config into the box | ❌ nothing; ACP `session/new` hardcodes `mcpServers: []` | `smoke.sh:198`, actor tests |
| Generic file delivery into the box | ✅ **`file` placements already write arbitrary paths+modes atomically** — the load-bearing existing capability | `cp.go:383-400`, `registry.ts:109-131` |

Hard wire constraints that shape everything below: the shipped box's Go decoder uses `DisallowUnknownFields` — new payloads must ride **inside `placements`**, never as new top-level keys on the mint response; refresh is pull-only (shell login / `blitz-cred sync`), so anything delivered as a placement inherits that cadence.

---

## 1. Ownership model (decided): per-user grants only

There are no org grants. A connection is a **provider config** plus **personal grants**:

- **Provider config** (the declaration): `figma` — auth method, custody, surfaces, scope catalog. Stock providers come from the catalog with zero ceremony; custom/static providers (self-hosted base URLs, generic tokens) are declared org-wide so templates can name them. No secret lives here.
- **Grant**: one member authed one provider with their own account (OAuth or personal PAT). Stored per (user, provider) in `user_oauth_grants` — the table the rename just cleared the name for. Every action a connection performs attributes to a human.
- **Lease**: minted material in a box, backed by exactly one grant.

Four rules complete the model:

1. **The workspace's identity spine is its owner.** A box is one disk and one env; `FIGMA_TOKEN` holds one value, and detached agents have no "current user". So every mint resolves against the **owner's** grants. `credential_leases.user_id` = owner, always.
2. **Sharing means borrowing the owner's identities — disclosed, not prevented.** An editor in a shared workspace operates under the owner's connections. The share dialog lists which connections ride along; the workspace shows a "agents here act as <owner> on figma, linear" banner to joiners. Per-operator attribution inside one box is explicitly not promised.
3. **Connections are enabled per workspace, not everywhere.** Because sharing exists, grants must not auto-flow into every workspace the owner has. The per-workspace enablement list maps onto the existing `workspaces.manifest` ceiling primitive.
4. **Proxy custody is the default and the security model.** With personal grants on shareable boxes, the raw token must never touch disk. Proxy leaves only a per-workspace, revocable lease token in the box (`${origin}/proxy/${leaseId}` — already implemented for static). Unshare/revoke is one delete; the personal credential is never exfiltratable from the box. Static-on-disk (`cp` custody) becomes the exception for providers that cannot ride a proxy.

What this deletes from the design space: grant precedence, org-secret rotation policy, the admin/member split for connections (`canManageCredentials` gates come out of the rail and panel; workspace *viewer* stays read-only — that is workspace sharing, not org role), and the approve/deny loop (§3).

Named costs, accepted:
- **Service continuity ties to people.** Long-running automation uses the owner's token; offboarding or ownership transfer means the new owner re-connects. Escape hatch with zero product surface: a bot user with its own grants can own a workspace.
- **The GitHub App minter is org-shaped** (App ID + private key is inherently a shared secret). GitHub becomes user OAuth / user PAT like everything else; `app-jwt` is parked — code kept, catalog entry dropped.

## 2. Reachable: the add flow moves into the workspace panel

- The side-rail Connections panel gains **Connect**: provider picker from the catalog → personal PAT paste or OAuth (§4) → done. Same flow for every member; the only account you can manage is your own.
- Settings keeps the fleet view (your grants across providers, revoke, re-auth); the panel is the in-context path. Same catalog component both places.
- This closes the original dogfood pain end-to-end: rail icon → panel → connect → next shell login has the env var. The `.env`-by-vim workaround stops being the only path.

## 3. The request loop becomes a connect prompt

`credential_requests` stops being an approval queue and becomes the **connect inbox**: the agent wanted `@figma`, the owner has no grant, the panel (and the skill file's error text) shows one click to fix it. Approve/deny UI goes away with the role split. Denial events remain in the audit trail.

## 4. `@figma` in any harness: surfaces are files, and the skill *is* the resolver

The trick that keeps this harness-agnostic: **don't build an @-mention parser.** A connection's lease ships a skill file; a skill named `figma` is exactly what makes "use @figma for X" work in Claude Code, Codex, or any harness that reads skills/AGENTS.md — the model resolves the tag by reading its own surfaces. `@` is a naming convention, not a protocol.

Delivery ladder:
- **Phase A — zero box changes, works with the image running today.** The provider's surfaces compile to extra `file` placements on the existing lease: `~/.claude/skills/figma/SKILL.md` (how to auth from `$FIGMA_TOKEN`, API base, canonical calls), optionally `~/bin/figma` wrapper. `applyFilePlacements` already writes arbitrary paths and modes atomically. Refresh cadence = lease sync (login-time) — fine for docs/skills.
- **Phase B — MCP passthrough (needs one actor change + image rebuild).** Leases additionally write `/var/lib/blitz/connections/mcp.json`; the actor reads it and passes real entries instead of the hardcoded `mcpServers: []` at `session/new`. The same rebuild can add sync-on-session-start, closing the login-freshness gap.
- **Phase C — UI sugar.** The webApp chat input autocompletes `@` from the workspace's active leases. Purely cosmetic; the semantics never depend on it.

Revocation symmetry matters: when a lease is revoked (including on unshare), the sync that removes the env var must also remove the surface files — a stale skill for a dead connection gaslights the agent. Phase A ships an empty-overwrite; Phase B adds a proper `remove-file` placement to the next box image.

## 5. Templates: reference providers, prompt SSO at instantiate

- Templates embed **provider names + a `required` flag** — never grants, never secrets (`workspace_template_connections` join beside the existing folders join).
- **Create-from-template shows a connect checklist before create**: green check per provider you already have a grant for, Connect button per missing one, inline OAuth/PAT. You become the workspace owner, so it is your SSO. `required` blocks create until connected; optional ones skip and prompt later from the panel.
- `POST /workspaces` gains `connections?: string[]` (template-fed or ad-hoc). `manifest` stays the ceiling; the new field is the provision list; ceiling wins on conflict.
- **Mint-at-ready**: on the phone-home ready transition (`workspaces.ts:705`), pre-mint the enabled connections from the owner's grants so the first shell opens with env and skills on disk.
- The demo this exists for: "new workspace from template `frontend` → checklist shows figma ✓ linear ✓ github Connect → one SSO → workspace opens `@`-able in the first prompt."

## 6. OAuth mechanics (per-user)

1. `GET /connect/:provider/start` → 302 to the provider authorize URL, `state` via the generalized CSRF helper (`core/identity/oauth-state.ts` is Google-login-bound today).
2. `GET /connect/:provider/callback` → code exchange → encrypt tokens into `user_oauth_grants` for the signed-in user.
3. **New oauth minter**: at mint, exchange refresh → access for the *owner's* grant; lease TTL from `expires_in`; rotate stored refresh when the provider rotates (Figma does).
4. Provider registry entries carry client ids; client secrets are worker secrets; redirect URIs are per-deployment ops work — documented per provider in the manifest.
5. Blunt sequencing: **personal PATs deliver most agent value this week** (Linear API keys, Figma PATs) through the same grant table with no OAuth code. Ship PAT-grants first, OAuth after surfaces.

## 7. Sequencing

| Phase | Ships | Note |
|---|---|---|
| **0** (done, live) | rename integrations → connections: routes (+aliases), persisted panel enum (+fold), D1 0017, UI, schema types | version `2b0e781b` |
| **1** | provider catalog + per-user PAT grants (`user_oauth_grants` goes live) + panel Connect flow + connect inbox + owner-spine mint resolution | kills the vim workaround |
| **2** | surfaces Phase A (skills/env via file placements) + per-workspace enablement + templates w/ SSO checklist + mint-at-ready | `@figma` works in CLI harnesses on the current box image |
| **3** | OAuth (`/connect/*`, oauth minter) for Figma + Linear | one-click |
| **4** | MCP passthrough + sync-on-session-start + `remove-file` placement (actor + image rebuild train) | needs a box release |

## 8. Risks

1. **The frozen box wire** bounds everything: new data rides inside `placements`; any new top-level mint-response key 500s every running box (`DisallowUnknownFields`, pinned by test).
2. **Shared-box exposure is by design, so disclosure must be loud**: share-dialog listing + join banner are part of Phase 1's definition of done, not polish.
3. **Skill staleness**: surfaces refresh on sync, not push, until Phase 4. Document that surfaces are login-fresh.
4. **Owner offboarding**: leases die with the owner's grants; ownership transfer re-prompts SSO. Surface this in the transfer flow, not in a support ticket.
5. **Scope consent**: the per-provider scope catalog is what makes "Connect figma" honest about what the agent will hold. Ship it with Phase 1, hand-written is fine.
6. **Naming collision**: "connection" also means sockets in box/gateway/chat code. The rename constrained itself to the credential product noun; `user_connections` → `user_oauth_grants` cleared the clash.
