# Plan: Connections — reachable, one-click, and usable as `@name`

Status: **plan.** The `integrations → connections` rename is in flight on this branch; everything else here waits for approval.
Date: 2026-08-19. Grounding: full audit of the credential subsystem in `~/blitz-core-aws` (citations below use pre-rename names where the code still has them).

The question this answers: *how does a person put a connection into a workspace without vim, how does a template come with connections attached, can Figma/Linear be one click, and how does "use @figma for X" just work in any harness?*

---

## 0. Audit: the state of a user's ability to add a connection today

| Capability | State | Where |
|---|---|---|
| See requests / leases / events per workspace | ✅ side-rail panel (shipped with the panes work) | `WorkspaceDrawer.tsx:273-302` |
| **Create** a connection from the workspace panel | ❌ none — the panel is read/approve-only | — |
| Create from settings | ✅ admin-only, `/settings/integrations`, 5 hardcoded templates, kinds `app-jwt` + `static` only | `settings/IntegrationsPanel.tsx:9-19,259` |
| `kind:'oauth'` | ❌ enum accepted, then rejected at PUT — no oauth minter exists (`minters = [githubApp, static]`) | `registry.ts:22,308-334` |
| Custody `broker` | ❌ enum only, every combination rejected | `registry.ts:331-333` |
| Per-user grants | ❌ `user_connections` table exists with zero readers/writers; `credential_leases.user_id` never populated | `0003:15-23,30` |
| OAuth authorize/callback for third parties | ❌ none (Google login and the box device flow are unrelated) | recon §5 |
| Workspace templates carrying connections | ❌ templates = name + machine type + ≤16 folders, nothing else | `0016`, `workspace-templates.ts:34-56` |
| `POST /workspaces` accepting connections | ❌ only `manifest`, which is a *ceiling* (deny-list), not a provisioner | `workspaces.ts:89-134` |
| Pre-mint at workspace ready | ❌ first mint happens when a human opens a shell (`blitz-creds.sh:23-27`) | — |
| Inject MCP/skills/CLI config into the box | ❌ nothing; ACP `session/new` hardcodes `mcpServers: []` | `smoke.sh:198`, actor tests |
| Generic file delivery into the box | ✅ **`file` placements already write arbitrary paths+modes atomically** — the load-bearing existing capability | `cp.go:383-400`, `registry.ts:109-131` |
| Member (non-admin) path to a connection | ⚠️ half: denial auto-files a `credential_request` an admin can approve, but there is no "request Figma" affordance — you only get a request by *failing* | `mint.ts:121-137` |

Hard wire constraints that shape everything below: the shipped box's Go decoder uses `DisallowUnknownFields` — new payloads must ride **inside `placements`**, never as new top-level keys on the mint response; refresh is pull-only (shell login / `blitz-cred sync`), so anything delivered as a placement inherits that cadence.

---

## 1. The model: a connection is a **provider manifest**, not a secret with a label

Today a connection is `{name, provider(free text), kind, custody, config blob}` and the only "registry" is a 5-item literal in the webApp. Everything the user asked for — one-click OAuth, templates, `@figma` — falls out of promoting the provider to a first-class, control-plane-owned manifest:

```
provider: figma
  auth:      oauth   { authorize_url, token_url, scopes[], refresh: rotating }  |  static { field hints }
  custody:   proxy (default) | cp
  surfaces:                       ← what a lease drops into the box
    env:     FIGMA_TOKEN
    skill:   ~/.claude/skills/figma/SKILL.md      ← "@figma" lives here
    mcp:     figma entry for the box mcp registry ← phase 3
    docs:    api base, rate limits, example calls  (inlined into the skill)
  meta:      icon, docs_url, scope catalog for the consent screen
```

The manifest is data (a versioned TS structure in the control plane, later editable), and the existing lease machinery is the delivery truck. Nothing about minting changes; the manifest just decides *what placements a lease carries*.

## 2. Reachable: the add flow moves into the workspace panel

- The side-rail Connections panel gains **Add connection**: provider picker from the manifest catalog → static-token form or OAuth button → done. Admins create in place (same `PUT` the settings page uses); **members get "Request <provider>"**, which files the `credential_request` proactively instead of via a failed mint — the approve/deny UI for admins already exists in this very panel.
- Settings keeps the fleet view (all connections, revoke, replace); the panel is the in-context path. Same catalog component both places.
- This closes the original dogfood pain end-to-end: rail icon → panel → add → next shell login has the env var. The `.env`-by-vim workaround stops being the only path.

## 3. One-click OAuth (Figma, Linear)

Blunt sequencing note first: **for agent CLI/API use, static PATs already deliver most of the value today** — Linear ships personal API keys, Figma ships PATs, and the generic static template plus a good skill file works this week. One-click OAuth buys: no secret ever touches the user's clipboard, real scopes, clean revocation, and per-user identity later. Build it, but after the surfaces (§4), not before.

Mechanics (all control-plane; the box is untouched):
1. `GET /connect/:provider/start` → 302 to the provider's authorize URL. Generalize the CSRF state helper that Google login already uses (`core/identity/oauth-state.ts`) instead of writing a second one.
2. `GET /connect/:provider/callback` → code exchange → encrypt the refresh token as the connection's `root_ciphertext` (same envelope the static kind uses), `kind:'oauth'`, custody `proxy` by default.
3. **New oauth minter** beside `githubAppMinter`: at mint time exchange refresh → access, lease TTL from the provider's `expires_in`, rotate the stored refresh when the provider rotates (Figma does). GitHub App minting already proves the "short-lived derived credential" path.
4. Provider registry entries carry client ids; client secrets are worker secrets. Redirect URIs must be registered per deployment — a real operational step per instance, worth documenting in the manifest.
5. **Org-level first** (one connection the org's agents share), because that is what agents need. **Per-user second**: the dead `user_connections` table (being renamed `user_oauth_grants`) finally gets its writer — rows per (user, connection), mint resolves the *requesting user's* grant, and `credential_leases.user_id` finally gets populated. That is also the moment `custody:'broker'` stops being a dead enum, if per-user secrets shouldn't sit in CP custody.

Custody default: `proxy`. The secret never lands in the box, the box gets a revocable lease token and `${origin}/proxy/${leaseId}` — already implemented and running for static.

## 4. `@figma` in any harness: surfaces are files, and the skill *is* the resolver

The trick that keeps this harness-agnostic: **don't build an @-mention parser.** A connection's lease ships a skill file; a skill named `figma` is exactly what makes "use @figma for X" work in Claude Code, Codex, or any harness that reads skills/AGENTS.md — the model resolves the tag by reading its own surfaces. `@` is a naming convention, not a protocol.

Delivery ladder:
- **Phase A — zero box changes, works with the image running today.** The manifest's surfaces compile to extra `file` placements on the existing lease: `~/.claude/skills/figma/SKILL.md` (how to auth from `$FIGMA_TOKEN`, API base, canonical calls, when to prefer which endpoint), optionally `~/bin/figma` wrapper. `applyFilePlacements` already writes arbitrary paths and modes atomically; `placementTemplate` already validates them. Refresh cadence = lease sync (login-time) — fine for docs/skills.
- **Phase B — MCP passthrough (needs one actor change + image rebuild).** Leases additionally write `/var/lib/blitz/connections/mcp.json`; the actor reads it and passes real entries instead of the hardcoded `mcpServers: []` at `session/new`. Now a Figma MCP server appears in chat-panel sessions too, not just CLI harnesses.
- **Phase C — UI sugar.** The webApp chat input autocompletes `@` from the workspace's active leases. Purely cosmetic; the semantics never depend on it.

Revocation symmetry matters: when a lease expires or is revoked, the sync that removes the env var must also remove the surface files (the existing `unset-env` placement has no file-removal sibling — the skill file for a revoked connection should not linger and gaslight the agent; Phase A can ship an empty-overwrite, Phase B adds a proper `remove-file` placement to the *next* box image).

## 5. Templates with pre-configured connections

- Schema: `workspace_template_connections(template_id, connection_name, scopes?)` join table beside the existing folders join.
- `POST /workspaces` gains `connections?: string[]` (template-fed or ad-hoc), validated against the org's catalog. Keep `manifest` exactly what it is — the ceiling; the new field is the *provision list*. Ceiling still wins on conflict.
- **Mint-at-ready**: on the phone-home ready transition (`workspaces.ts:705`), pre-mint the provisioned connections so the first shell (and the first agent session) opens with `$FIGMA_TOKEN` and the skills already on disk. Denials fall back to today's request flow, visible in the panel.
- UI: CreateWorkspaceDialog grows a connections checklist sourced from the org catalog; template editor persists it. "New workspace from template `frontend` → Figma, Linear, GitHub attached, `@`-able in the first prompt" is the demo this exists for.

## 6. Sequencing

| Phase | Ships | Note |
|---|---|---|
| **0** (in flight) | rename integrations → connections: routes (+aliases), persisted panel enum (+fold), D1 tables/columns, UI, schema types | this branch |
| **1** | provider manifest structure + panel Add/Request flow + member request affordance | kills the vim workaround |
| **2** | surfaces Phase A (skills/env via file placements) + templates + mint-at-ready | `@figma` works in CLI harnesses with the current box image |
| **3** | OAuth org-level (Figma, Linear) via /connect/* + oauth minter | one-click |
| **4** | MCP passthrough (actor + image rebuild train) + remove-file placement + per-user grants (`user_oauth_grants` goes live) | needs a box release |

## 7. Risks

1. **The frozen box wire** is the boundary everything above respects: new data rides inside `placements`; any new top-level mint-response key 500s every running box (`DisallowUnknownFields`). The rename work is adding a test that pins those exact keys.
2. **Skill staleness**: surfaces refresh on sync, not push. An admin editing a connection should bump lease expiry so the next login rewrites files; document that surfaces are login-fresh, not instant.
3. **Secret sprawl in templates**: templates reference connections *by name*, never carry secret material. Provisioning fails soft (request filed) when the connection is missing in the target org.
4. **Scope consent**: the manifest's scope catalog is what makes the approve screen honest; without it, "approve figma" is a blind yes. Ship the catalog with Phase 1, even if hand-written.
5. **Naming collision**: "connection" also means sockets in box/gateway/chat code. The rename constrains itself to the credential product noun; `user_connections` (the dead table) gets renamed away from the collision.
