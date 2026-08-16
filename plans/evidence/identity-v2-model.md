# Organization/membership identity model

The inspected production control plane is not using teenybase authentication primitives. It is a custom Hono Worker backed by Cloudflare D1; its only runtime dependencies are Hono and Zod, and identity, OAuth, cookies, invitations, and authorization are implemented locally. [package.json:12-15](/Users/minjunes/monorepov2/packages/control-plane/package.json:12) [index.ts:1-2](/Users/minjunes/monorepov2/packages/control-plane/src/index.ts:1)

## 1. Identity

### User representation

The application-defined user record is `identities`, not a teenybase `users` or auth collection:

```sql
CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  github_user_id INTEGER,
  github_login TEXT,
  name TEXT NOT NULL,
  avatar_url TEXT,
  platform_operator INTEGER NOT NULL DEFAULT 0 CHECK(platform_operator IN (0, 1)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
);
```

GitHub user ID and login have separate partial unique indexes. [0001_init.sql:16-33](/Users/minjunes/monorepov2/packages/control-plane/migrations/0001_init.sql:16)

`github_user_id` is the durable provider identity. On login, `resolveIdentity` first finds by GitHub user ID and refreshes login/name/avatar. It can also claim an admin-created stub whose `github_login` matches and whose `github_user_id` is still null. A completely new login is inserted by `ensureIdentity`. [githubAuth.ts:211-267](/Users/minjunes/monorepov2/packages/control-plane/src/githubAuth.ts:211) [githubAuth.ts:269-297](/Users/minjunes/monorepov2/packages/control-plane/src/githubAuth.ts:269)

`platform_operator` is an identity-wide Boolean, separate from organization roles. `requirePlatformOperator` resolves the identity through the current membership and checks that flag. [middleware.ts:97-109](/Users/minjunes/monorepov2/packages/control-plane/src/routes/middleware.ts:97)

An ancillary table records GitHub-side organization snapshots:

```sql
CREATE TABLE github_identity_organizations (
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  github_org_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(identity_id, github_org_id)
);
```

A later migration adds nullable GitHub role values `'admin' | 'member'`. This table has a GitHub organization ID, not a Blitz `org_id`, so it is distinct from Blitz memberships. [0012_github_identity_organizations.sql:1-11](/Users/minjunes/monorepov2/packages/control-plane/migrations/0012_github_identity_organizations.sql:1) [0014_github_organization_roles.sql:1-3](/Users/minjunes/monorepov2/packages/control-plane/migrations/0014_github_organization_roles.sql:1)

### Authentication

All authentication in this control plane is application-defined:

| Mechanism | Exact implementation |
|---|---|
| Browser session | `blitz_session`, seven-day HMAC-SHA256 signed payload cookie. Membership sessions are `{v:2,membershipId,orgId,role,exp}`; identity-only onboarding sessions are `{v:3,identityId,exp}`. [auth.ts:10-40](/Users/minjunes/monorepov2/packages/control-plane/src/auth.ts:10) |
| Cookie security | `HttpOnly; Secure; SameSite=Lax`, scoped to the portal hostname. [auth.ts:209-220](/Users/minjunes/monorepov2/packages/control-plane/src/auth.ts:209) |
| Session validation | Verifies the HMAC and expiry, reloads the membership, then requires matching org, matching role, and `status='active'`. Identity-only sessions reload the identity and choose its first active membership when one exists. [auth.ts:153-205](/Users/minjunes/monorepov2/packages/control-plane/src/auth.ts:153) |
| GitHub OAuth | Custom authorization-code flow with PKCE, signed `oauth_flow` cookie, constant-time state comparison, and a ten-minute expiry. [githubAuth.ts:25-37](/Users/minjunes/monorepov2/packages/control-plane/src/githubAuth.ts:25) [githubAuth.ts:346-379](/Users/minjunes/monorepov2/packages/control-plane/src/githubAuth.ts:346) |
| OAuth token custody | The callback exchanges the code, fetches `/user`, and uses the token transiently to enumerate accessible installations; the code explicitly says it is never persisted. [githubAuth.ts:402-442](/Users/minjunes/monorepov2/packages/control-plane/src/githubAuth.ts:402) |
| Agent API keys | Org-scoped `blitz_…` opaque keys. Only SHA-256 hashes are stored, and each key acts as the still-active membership that created it. [0028_agent_api.sql:14-27](/Users/minjunes/monorepov2/packages/control-plane/migrations/0028_agent_api.sql:14) [auth.ts:301-339](/Users/minjunes/monorepov2/packages/control-plane/src/auth.ts:301) |
| CLI login token | A one-hour version-2 signed session payload minted at `POST /api/cli/token`. [machine.ts:482-503](/Users/minjunes/monorepov2/packages/control-plane/src/routes/machine.ts:482) |

There is no password, email-login, persistent session, or refresh-token table in this model; browser identity is GitHub-backed and session state is contained in signed cookies whose membership is revalidated against D1. [0001_init.sql:16-47](/Users/minjunes/monorepov2/packages/control-plane/migrations/0001_init.sql:16) [auth.ts:153-205](/Users/minjunes/monorepov2/packages/control-plane/src/auth.ts:153)

With multiple available memberships, OAuth redirects through `/api/auth/github/choose`; a signed ten-minute pending-identity cookie binds the choice to the identity. [githubAuth.ts:465-504](/Users/minjunes/monorepov2/packages/control-plane/src/githubAuth.ts:465) [githubAuth.ts:507-579](/Users/minjunes/monorepov2/packages/control-plane/src/githubAuth.ts:507)

## 2. Organizations and membership

### Schemas and enums

```sql
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider_vm_limit INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

[0001_init.sql:6-14](/Users/minjunes/monorepov2/packages/control-plane/migrations/0001_init.sql:6)

```sql
CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('invited', 'active', 'disabled')),
  ...
  UNIQUE(identity_id, org_id)
);
```

[0001_init.sql:35-47](/Users/minjunes/monorepov2/packages/control-plane/migrations/0001_init.sql:35)

Exact enums:

- Membership role: `'admin' | 'member'`; there is no `'owner'` role. [db.ts:1](/Users/minjunes/monorepov2/packages/control-plane/src/db.ts:1)
- Membership status: `'invited' | 'active' | 'disabled'`. [db.ts:2](/Users/minjunes/monorepov2/packages/control-plane/src/db.ts:2)
- Platform-operator privilege is the separate identity flag described above. [0001_init.sql:22](/Users/minjunes/monorepov2/packages/control-plane/migrations/0001_init.sql:22)

### Personal versus team organizations

There is no `type`, `personal`, `owner_identity_id`, or equivalent discriminator on `orgs`. A “personal” organization is only a creation convention; a “team” is the same row after additional memberships are added. [0001_init.sql:6-14](/Users/minjunes/monorepov2/packages/control-plane/migrations/0001_init.sql:6)

Personal tenant creation has two production paths:

1. Redeeming an untargeted platform invite creates an org named from the GitHub login, gives it VM limit `1`, creates an active membership using the invite role, and defaults that role to `admin`. The untargeted path rejects an identity that already has any active membership. [invites.ts:65-92](/Users/minjunes/monorepov2/packages/control-plane/src/invites.ts:65) [invites.ts:190-243](/Users/minjunes/monorepov2/packages/control-plane/src/invites.ts:190)
2. Paid beta-seat fulfillment similarly creates a login-named org with VM limit `1` and an active admin membership, only when the identity has no active membership. [claim.ts:248-322](/Users/minjunes/monorepov2/packages/control-plane/src/routes/claim.ts:248)

There is no `POST /orgs` route. Org routes only list, fetch, and admin-rename the current session org. [orgs.ts:23-63](/Users/minjunes/monorepov2/packages/control-plane/src/routes/orgs.ts:23)

A team is formed through either:

- `POST /api/members` or `/api/v1/members`, where an admin creates an `'invited'` membership for a GitHub login. [members.ts:63-118](/Users/minjunes/monorepov2/packages/control-plane/src/routes/members.ts:63)
- An operator-minted invite with `targetOrgId`, which redeems directly into the existing org. [platform.ts:23-28](/Users/minjunes/monorepov2/packages/control-plane/src/routes/platform.ts:23) [invites.ts:190-243](/Users/minjunes/monorepov2/packages/control-plane/src/invites.ts:190)

Admins may change role/status but cannot manually promote `invited` to `active`; acceptance must occur through identity login. The update also prevents removal or disabling of the last active admin. [members.ts:138-181](/Users/minjunes/monorepov2/packages/control-plane/src/routes/members.ts:138)

## 3. Invites

### A. Opaque platform invite links

The `invites` table stores:

```sql
id, code_hash, target_org_id, role, label, state,
created_by_membership_id, redeemed_by_identity_id, created_org_id,
created_at, expires_at, redeemed_at
```

`code_hash` must be 43 characters; roles are `'admin' | 'member'`; states are `'ready' | 'redeemed' | 'revoked' | 'expired'`. [0001_init.sql:55-77](/Users/minjunes/monorepov2/packages/control-plane/migrations/0001_init.sql:55)

Creation uses 32 cryptographically random bytes encoded as base64url. Only its SHA-256 base64url hash is stored, and the raw code is returned once. Server expiry is exactly seven days. [auth.ts:277-280](/Users/minjunes/monorepov2/packages/control-plane/src/auth.ts:277) [invites.ts:9](/Users/minjunes/monorepov2/packages/control-plane/src/invites.ts:9) [invites.ts:65-112](/Users/minjunes/monorepov2/packages/control-plane/src/invites.ts:65)

Acceptance is indirect:

1. `GET /invite/:code` renders the SPA and checks `GET /api/invites/:code`. [main.tsx:54-63](/Users/minjunes/monorepov2/packages/ui/src/main.tsx:54) [machine.ts:660-667](/Users/minjunes/monorepov2/packages/control-plane/src/routes/machine.ts:660)
2. The user follows `GET /api/auth/github/start?return_to=/invite/<code>`. There is deliberately no invite-accept POST route. [InviteRedeemPage.tsx:77-86](/Users/minjunes/monorepov2/packages/ui/src/InviteRedeemPage.tsx:77)
3. `GET /api/auth/github/callback` resolves or creates the identity and calls `redeemInvite`. [githubAuth.ts:402-409](/Users/minjunes/monorepov2/packages/control-plane/src/githubAuth.ts:402) [githubAuth.ts:445-462](/Users/minjunes/monorepov2/packages/control-plane/src/githubAuth.ts:445)
4. Redemption atomically creates the org when untargeted, creates the active membership, marks the invite redeemed, records the identity and new org, and returns a membership-scoped session cookie. [invites.ts:202-287](/Users/minjunes/monorepov2/packages/control-plane/src/invites.ts:202)

Revocation changes only a `ready` invite to `revoked`; expiration similarly updates only ready rows. Public status also treats an overdue row as expired before the maintenance write occurs. [invites.ts:127-137](/Users/minjunes/monorepov2/packages/control-plane/src/invites.ts:127) [invites.ts:290-302](/Users/minjunes/monorepov2/packages/control-plane/src/invites.ts:290)

Exact management routes, all platform-operator gated:

| Route | Function |
|---|---|
| `GET /api/platform/invites` | List up to 500 invites. |
| `POST /api/platform/invites` | Mint; optional `email`, `targetOrgId`, and role. |
| `DELETE /api/platform/invites/:id` | Revoke a ready invite. |
| `GET /api/platform/orgs/:orgId/workspaces` | Observe an invite-created tenant. |

[platform.ts:79-85](/Users/minjunes/monorepov2/packages/control-plane/src/routes/platform.ts:79) [platform.ts:104-144](/Users/minjunes/monorepov2/packages/control-plane/src/routes/platform.ts:104) [platform.ts:146-195](/Users/minjunes/monorepov2/packages/control-plane/src/routes/platform.ts:146)

A daily scheduled job marks overdue ready invitations expired. [index.ts:393-402](/Users/minjunes/monorepov2/packages/control-plane/src/index.ts:393)

There is a UI/server inconsistency: the UI says invite links last “one day,” but the server TTL is seven days. [InviteRedeemPage.tsx:7-11](/Users/minjunes/monorepov2/packages/ui/src/InviteRedeemPage.tsx:7) [invites.ts:9](/Users/minjunes/monorepov2/packages/control-plane/src/invites.ts:9)

### B. Pending organization memberships

`POST /api/members` and `/api/v1/members` do not mint an invite token or expiry. They create or reuse an identity keyed by lowercased GitHub login and insert an `'invited'` membership. [members.ts:81-135](/Users/minjunes/monorepov2/packages/control-plane/src/routes/members.ts:81)

At GitHub login, the stub identity is bound to the GitHub user ID; choosing that membership changes it from `invited` to `active` and issues the session. [githubAuth.ts:243-267](/Users/minjunes/monorepov2/packages/control-plane/src/githubAuth.ts:243) [githubAuth.ts:323-344](/Users/minjunes/monorepov2/packages/control-plane/src/githubAuth.ts:323)

Pending membership management routes are available under both `/api` and `/api/v1`:

- `GET /members`
- `POST /members`
- `PATCH /members/:id`
- `DELETE /members/:id`

Both route groups require an admin session. [members.ts:63-81](/Users/minjunes/monorepov2/packages/control-plane/src/routes/members.ts:63) [index.ts:219-237](/Users/minjunes/monorepov2/packages/control-plane/src/index.ts:219)

Deletion is permitted only for an unbound, still-invited stub. Otherwise the member must be disabled through PATCH. [members.ts:206-223](/Users/minjunes/monorepov2/packages/control-plane/src/routes/members.ts:206)

## 4. Authorization and workspace scoping

### Concrete middleware/helpers

| Function | Responsibility |
|---|---|
| `authenticateSessionCookie` | Verify signed session and revalidate identity/membership. [auth.ts:153-205](/Users/minjunes/monorepov2/packages/control-plane/src/auth.ts:153) |
| `apiKeyOrSession` | On `/api/v1/*`, resolve a presented Agent API key; invalid bearers cannot fall back to cookies. [middleware.ts:11-36](/Users/minjunes/monorepov2/packages/control-plane/src/routes/middleware.ts:11) |
| `requireSession` | Require an active membership context, unless an API-key principal was already installed. [middleware.ts:38-61](/Users/minjunes/monorepov2/packages/control-plane/src/routes/middleware.ts:38) |
| `requireIdentitySession` | Allow identity-only onboarding sessions for `/me`, checkout, and claim flows. [middleware.ts:63-74](/Users/minjunes/monorepov2/packages/control-plane/src/routes/middleware.ts:63) |
| `requireSessionPrincipal` | Prevent API keys from managing orgs, members, or keys. [middleware.ts:76-88](/Users/minjunes/monorepov2/packages/control-plane/src/routes/middleware.ts:76) |
| `requireAdmin` | Require `auth.role === 'admin'`. [middleware.ts:90-95](/Users/minjunes/monorepov2/packages/control-plane/src/routes/middleware.ts:90) |
| `requirePlatformOperator` | Require `identities.platform_operator === 1`. [middleware.ts:97-109](/Users/minjunes/monorepov2/packages/control-plane/src/routes/middleware.ts:97) |
| `canControlWorkspace` | Same org and either admin or exact owner membership. [db.ts:126-132](/Users/minjunes/monorepov2/packages/control-plane/src/db.ts:126) |

The global route stack makes `/api/*` session-only and `/api/v1/*` session-or-Agent-key. Org/member governance is explicitly session-only even under v1. [index.ts:213-241](/Users/minjunes/monorepov2/packages/control-plane/src/index.ts:213)

### Workspace ownership

Current workspace rows carry both tenant and individual ownership:

```sql
id TEXT PRIMARY KEY,
org_id TEXT NOT NULL,
owner_membership_id TEXT NOT NULL,
...
FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
FOREIGN KEY (owner_membership_id) REFERENCES memberships(id) ON DELETE RESTRICT
```

[0033_drop_workspace_creation_columns.sql:6-49](/Users/minjunes/monorepov2/packages/control-plane/migrations/0033_drop_workspace_creation_columns.sql:6)

Any authenticated active member may create a workspace. Creation passes the caller’s `orgId` and `membershipId`, and the insert records them as `org_id` and `owner_membership_id`. [workspaces.ts:138-164](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:138) [provisioning.ts:87-145](/Users/minjunes/monorepov2/packages/control-plane/src/provisioning.ts:87)

`GET /workspaces` returns every non-destroyed workspace in the current org, not merely those owned by the caller. `GET /workspaces/:id` also checks `workspace.org_id === auth.orgId`. [workspaces.ts:116-136](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:116) [workspaces.ts:184-198](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:184)

For a non-admin viewing another member’s workspace, the server still returns metadata but nulls `ingressLabel`, `bridgeUrl`, and `sessionUrl`. [workspaces.ts:37-84](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:37)

PATCH, exec submission/status, refresh, resume, and delete all repeat the same concrete sequence: org equality followed by `canControlWorkspace`; cross-org is returned as 404, same-org non-controller as 403. [workspaces.ts:200-233](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:200) [workspaces.ts:245-303](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:245) [workspaces.ts:305-369](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:305)

### Terminal/chat ingress

Caddy applies `forward_auth` to `/api/ingress/authz` before proxying the workspace host and strips the Blitz cookie/key before traffic reaches the VM. [Caddyfile:42-48](/Users/minjunes/monorepov2/packages/ingress/caddy/Caddyfile:42) [Caddyfile:82-91](/Users/minjunes/monorepov2/packages/ingress/caddy/Caddyfile:82)

The authz route derives the workspace from `X-Forwarded-Host`. Base workspace hosts—terminal, files, and chat—require `canControlWorkspace`, while preview hosts require only same-org membership. [ingress.ts:53-95](/Users/minjunes/monorepov2/packages/control-plane/src/routes/ingress.ts:53)

Therefore ordinary members may open another member’s preview application, but only the owner or an org admin may open that workspace’s terminal, files, or chat bridge. [ingress.ts:64-92](/Users/minjunes/monorepov2/packages/control-plane/src/routes/ingress.ts:64)

## 5. Cockpit contract

### Viewer DTO

Actual `GET /api/me` and `/api/v1/me` response:

```ts
{
  githubAppSlug,
  identity: {
    id, githubLogin, name, avatarUrl, platformOperator
  },
  membership: {
    id, role, status
  } | null,
  org: {
    id, slug, name, providerVmLimit
  } | null
}
```

[routes/auth.ts:36-82](/Users/minjunes/monorepov2/packages/control-plane/src/routes/auth.ts:36) [index.ts:200-203](/Users/minjunes/monorepov2/packages/control-plane/src/index.ts:200)

The cockpit intentionally declares narrower types:

```ts
export type MembershipRecord = {
  id: string;
  role: 'admin' | 'member';
};

export type OrgRecord = {
  id: string;
  slug: string;
  name: string;
};
```

[protocol.ts:32-48](/Users/minjunes/monorepov2/packages/ui/src/protocol.ts:32)

Thus it ignores server fields including identity `id`, membership `status`, and `providerVmLimit`. The server model permits nullable `github_login`, while the cockpit declares `githubLogin: string`. [db.ts:24-33](/Users/minjunes/monorepov2/packages/control-plane/src/db.ts:24) [protocol.ts:32-37](/Users/minjunes/monorepov2/packages/ui/src/protocol.ts:32)

The org-summary DTO used by `/orgs` and `/orgs/:id` is:

```ts
{ id, slug, name, providerVmLimit, createdAt, updatedAt }
```

The list endpoint always returns only the currently selected session org as a one-element array. [orgs.ts:12-40](/Users/minjunes/monorepov2/packages/control-plane/src/routes/orgs.ts:12)

The member DTO is:

```ts
{
  id, githubLogin, name, avatarUrl,
  role, status, bound, createdAt, updatedAt
}
```

`bound` means `github_user_id !== null`. [members.ts:20-45](/Users/minjunes/monorepov2/packages/control-plane/src/routes/members.ts:20)

### Workspace DTO and `shared`/`canControl`

The server workspace presenter returns IDs, org/owner/blueprint references, gated connection URLs, name/status/error, VM details, and lifecycle timestamps. It receives a computed `canControl` Boolean but does not serialize either `canControl` or `shared`; it uses the Boolean only to suppress connection URLs. [workspaces.ts:37-84](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:37)

The cockpit’s transport type expects the core subset:

```ts
type V2WorkspaceResponse = {
  id: string;
  ownerMembershipId: string;
  ingressLabel: string | null;
  sessionUrl: string | null;
  name: string;
  status: WorkspaceRecord['status'];
  errorDetail: string | null;
  vm: { machineType: string };
  createdAt: number;
  updatedAt: number;
};
```

[api.ts:161-174](/Users/minjunes/monorepov2/packages/ui/src/api.ts:161)

Contrary to the premise in the task, `shared` and the serialized cockpit `canControl` are computed client-side:

```ts
const canControl = this.viewer === null
  || this.viewer.membership.role === 'admin'
  || workspace.ownerMembershipId === this.viewer.membership.id;

shared: this.viewer !== null
  && workspace.ownerMembershipId !== this.viewer.membership.id
```

[api.ts:394-404](/Users/minjunes/monorepov2/packages/ui/src/api.ts:394)

The shared contract is declared as:

```ts
ownerMembershipId: string;
canControl: boolean;
shared?: boolean;
owner?: { name: string; avatarUrl: string | null };
```

[protocol.ts:15-30](/Users/minjunes/monorepov2/packages/ui/src/protocol.ts:15)

The server performs no owner-identity join and does not return `owner`, so the rail’s owner badge normally has no data to render. [workspaces.ts:120-135](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:120) [CockpitRail.tsx:70-81](/Users/minjunes/monorepov2/packages/ui/src/CockpitRail.tsx:70)

### Cockpit surfaces

- The left rail has a current-org dropdown, but it contains only the current org; there is no post-login org-switch action. [CockpitRail.tsx:151-183](/Users/minjunes/monorepov2/packages/ui/src/CockpitRail.tsx:151)
- Non-controllable `shared` workspaces are rendered as links to `/observe/<orgId>?workspace=…`. [CockpitRail.tsx:245-265](/Users/minjunes/monorepov2/packages/ui/src/CockpitRail.tsx:245)
- `/platform/invites` is an operator-only mint/list/copy/observe console. The page has no revoke control even though the server has a DELETE route. [PlatformInvitesPage.tsx:35-69](/Users/minjunes/monorepov2/packages/ui/src/PlatformInvitesPage.tsx:35)
- `/invite/<code>` is the public invite-status and GitHub-login surface. [InviteRedeemPage.tsx:46-73](/Users/minjunes/monorepov2/packages/ui/src/InviteRedeemPage.tsx:46)
- `/observe/<orgId>` is the operator read-only terminal surface. [ObservePage.tsx:7-10](/Users/minjunes/monorepov2/packages/ui/src/ObservePage.tsx:7)
- Settings exposes only Profile, Credentials, Machines, and Billing. It displays current org and role, but there is no member/invite-management section consuming `/members`. [sessions-page-state.ts:1-14](/Users/minjunes/monorepov2/packages/ui/src/sessions-page-state.ts:1) [SettingsPage.tsx:35-40](/Users/minjunes/monorepov2/packages/ui/src/SettingsPage.tsx:35) [SettingsPage.tsx:131-136](/Users/minjunes/monorepov2/packages/ui/src/SettingsPage.tsx:131)

## 6. Multiplayer and session sharing

### What exists

- The same tmux terminal session can have multiple attached clients. A tab maps to `<type>-<key>`, and reconnecting the same key uses `tmux new -A`. Ordinary attaches are writable. [cloud-init.yaml:83-105](/Users/minjunes/monorepov2/packages/box/golden/cloud-init.yaml:83)
- The terminal is configured so the most recently active writable client controls geometry; tests explicitly exercise two simultaneous clients. [tmux.conf:7-8](/Users/minjunes/monorepov2/packages/box/golden/etc/tmux.conf:7) [golden.test.mjs:264-294](/Users/minjunes/monorepov2/packages/box/golden/golden.test.mjs:264)
- Chat supports multiple WebSocket clients joined by exact agent session ID. Each connection owns a separate engine stream, while user turns and SDK output are fanned out to other clients in the same session. [bridge.mjs:256-289](/Users/minjunes/monorepov2/packages/box/bridge/bridge.mjs:256) [bridge.mjs:410-450](/Users/minjunes/monorepov2/packages/box/bridge/bridge.mjs:410) [bridge.mjs:614-645](/Users/minjunes/monorepov2/packages/box/bridge/bridge.mjs:614)
- Tests verify that one client’s user turn and engine response reach the other client, and that disconnected clients leave the fan-out set. [bridge.test.mjs:219-253](/Users/minjunes/monorepov2/packages/box/bridge/test/bridge.test.mjs:219) [bridge.test.mjs:297-307](/Users/minjunes/monorepov2/packages/box/bridge/test/bridge.test.mjs:297)
- Tab layout is workspace-local durable state in `~/.blitz/layout.json`. Mutations are serialized, all authorized devices read the same manifest, while active focus remains device-local and refresh occurs on focus/visibility. [layout.mjs:90-143](/Users/minjunes/monorepov2/packages/box/bridge/layout.mjs:90) [CloudApp.tsx:912-1010](/Users/minjunes/monorepov2/packages/ui/src/CloudApp.tsx:912)
- An owner and an org admin can therefore concurrently access the same workspace terminal/chat. An ordinary member cannot, because both DTO URL disclosure and ingress use the admin-or-owner gate. [workspaces.ts:47-71](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:47) [ingress.ts:79-95](/Users/minjunes/monorepov2/packages/control-plane/src/routes/ingress.ts:79)

### Read-only mode

A real VM-enforced terminal observer mode exists. `TtydTerminal readOnly` sends no input or resize frames and adds `arg=ro`; `blitz-session` attaches to an existing tmux session with `tmux attach-session -r`. [TtydTerminal.tsx:218-265](/Users/minjunes/monorepov2/packages/ui/src/TtydTerminal.tsx:218) [cloud-init.yaml:88-96](/Users/minjunes/monorepov2/packages/box/golden/cloud-init.yaml:88)

The only UI using it is the platform-operator Observe page, which is limited to invite-created orgs and hardcodes tab key `1` for Claude or terminal. [platform.ts:146-188](/Users/minjunes/monorepov2/packages/control-plane/src/routes/platform.ts:146) [ObservePage.tsx:43-88](/Users/minjunes/monorepov2/packages/ui/src/ObservePage.tsx:43)

However, the current end-to-end operator observer path is authorization-incomplete: `ObservePage` checks `platformOperator`, but ingress authz never checks that flag and still requires same-org admin-or-owner control. Therefore the read-only WebSocket succeeds only if the operator also has a controlling membership in the target org. This is an inference from the two concrete gates. [ObservePage.tsx:21-41](/Users/minjunes/monorepov2/packages/ui/src/ObservePage.tsx:21) [ingress.ts:79-95](/Users/minjunes/monorepov2/packages/control-plane/src/routes/ingress.ts:79)

Likewise, the rail’s “shared” link sends an ordinary member to the operator-only Observe page, whose unauthorized state renders “Not found”; it does not grant team-member viewing. [CockpitRail.tsx:259-263](/Users/minjunes/monorepov2/packages/ui/src/CockpitRail.tsx:259) [ObservePage.tsx:21-41](/Users/minjunes/monorepov2/packages/ui/src/ObservePage.tsx:21)

### What does not exist

- No ordinary-member read-only terminal or chat mode exists; ordinary members see other members’ workspace metadata but receive no terminal/chat URLs. [workspaces.ts:116-135](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:116)
- There is no read-only chat protocol. The documented chat frames are start, user, interrupt, approval, and permission-mode messages; read-only is implemented only by `TtydTerminal`/tmux. [bridge.mjs:11-23](/Users/minjunes/monorepov2/packages/box/bridge/bridge.mjs:11)
- There is no user presence roster, online/offline event, cursor, typing indicator, or identity-bearing participant protocol. `SessionClients` only maintains an in-memory session-to-connections set and silently joins/leaves clients. [bridge.mjs:256-287](/Users/minjunes/monorepov2/packages/box/bridge/bridge.mjs:256)
- Chat attribution is only caller-supplied `'human' | 'orchestrator'`; it is not tied to a membership or identity. [bridge.mjs:20-23](/Users/minjunes/monorepov2/packages/box/bridge/bridge.mjs:20) [bridge.mjs:619-632](/Users/minjunes/monorepov2/packages/box/bridge/bridge.mjs:619)
- Shared layout changes are not broadcast live; another device sees them when it reloads, refocuses, or becomes visible. [CloudApp.tsx:938-1009](/Users/minjunes/monorepov2/packages/ui/src/CloudApp.tsx:938)

## Portability notes

No identity, membership, invitation, workspace, or authorization piece above depends on a teenybase runtime primitive. They are application SQL, Hono middleware, Zod validation, and Web Crypto code. [package.json:12-15](/Users/minjunes/monorepov2/packages/control-plane/package.json:12) [auth.ts:68-109](/Users/minjunes/monorepov2/packages/control-plane/src/auth.ts:68)

For a teenybase-backed blitz-core adoption:

- `orgs`, `memberships`, `invites`, and the `workspaces.org_id`/`owner_membership_id` model are portable application collections/tables. Preserve the unique identity-org membership, exact enums, and admin-or-owner workspace rule. [0001_init.sql:6-80](/Users/minjunes/monorepov2/packages/control-plane/migrations/0001_init.sql:6) [db.ts:126-132](/Users/minjunes/monorepov2/packages/control-plane/src/db.ts:126)
- If teenybase supplies users, OAuth, and sessions, its user ID can replace or back `identities.id`; the custom GitHub OAuth cookies and HMAC session payloads need not be copied. The membership context still must be selected and revalidated per request because authorization is membership-scoped, not merely user-scoped. [auth.ts:15-40](/Users/minjunes/monorepov2/packages/control-plane/src/auth.ts:15) [auth.ts:153-205](/Users/minjunes/monorepov2/packages/control-plane/src/auth.ts:153)
- Invite token generation, hash-only storage, expiry/state transitions, and personal-org creation are portable logic, though D1’s `DB.batch` transaction behavior must be replaced with the destination datastore’s transaction mechanism. [invites.ts:65-112](/Users/minjunes/monorepov2/packages/control-plane/src/invites.ts:65) [invites.ts:202-277](/Users/minjunes/monorepov2/packages/control-plane/src/invites.ts:202)
- The current cockpit should either receive authoritative `canControl`, `shared`/`canObserve`, and owner DTOs from the server, or preserve its present client re-derivation exactly. Today the server and client independently implement related capability logic. [workspaces.ts:37-84](/Users/minjunes/monorepov2/packages/control-plane/src/routes/workspaces.ts:37) [api.ts:394-404](/Users/minjunes/monorepov2/packages/ui/src/api.ts:394)
- Terminal/chat collaboration is not SQL-portable identity logic: it depends on Caddy forward-auth, ttyd, tmux, and the VM-local bridge. [Caddyfile:82-91](/Users/minjunes/monorepov2/packages/ingress/caddy/Caddyfile:82) [cloud-init.yaml:83-105](/Users/minjunes/monorepov2/packages/box/golden/cloud-init.yaml:83) [bridge.mjs:256-289](/Users/minjunes/monorepov2/packages/box/bridge/bridge.mjs:256)