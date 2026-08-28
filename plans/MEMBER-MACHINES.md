# MEMBER MACHINES — the workspace is a server, and every member gets a machine

Written 2026-08-28, revised same day after the ground-truth survey
(`plans/evidence/member-machines-ground-truth.md`, main @ cbf9a1fb).
Supersedes `plans/MULTI-MEMBER-BOX.md` and the workspace-templates concept.
UI mockup: `plans/mockups/session-rail.html`.

```
org
 └─ workspace "engineering"            ← its own template; nothing else is
     ├─ config: machine type · environment · agent rules · repos · credentials
     ├─ workspace_members: (membership, role)      role: admin | editor | viewer
     ├─ machines: one VM per member, on by default
     └─ sessions (Build 2)
```

## 0. The idea

A workspace works like a Discord server. Members are invited to it with a
role. Each member gets one always-on machine, sized by the workspace's
machine type, provisioned when the invite is sent, destroyed when they leave.
Sessions inherit the workspace's agent rules, drive, and credentials.
Machines never appear as a user decision — only in workspace administration.

**The workspace is its own template.** There is no separate template object.
A workspace *carries* the config a template used to carry — machine type,
environment, agent rules, repo list, workspace credentials — and "new
workspace from existing" clones that config. The `workspace_templates`,
`workspace_template_folders`, `workspace_template_repos`, and
`workspace_template_connections` tables are deleted; recipes re-point their
launch source at a workspace.

## 1. The data model

### workspaces — the durable, configurable thing

The workspace row loses every VM column (they move to `machines`) and gains
the config role the template used to play. A workspace has no `phase`: it is
always present; only machines have lifecycle.

```sql
workspaces (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES orgs(id),
  name                 TEXT NOT NULL,
  owner_membership_id  TEXT NOT NULL REFERENCES memberships(id), -- creator; first admin
  default_machine_type_id TEXT NOT NULL,  -- a default, never a restriction (§1a)
  auto_provision       INTEGER NOT NULL DEFAULT 1,  -- provision + start VM on invite
  environment          TEXT,              -- existing shape (0017)
  agent_rule_id        TEXT REFERENCES agent_rules(id),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
)
-- dropped from workspaces: phase, vm_id, volume_id, ssh_*, phone_home_*,
-- tunnel_id/tunnel_hostname/dns_record_id, compute_credential_source,
-- box_update_*, org_share_role (replaced by workspace_members)
```

### workspace_members — membership with a stored role

Replaces the computed role and the `workspace_grants` sharing ACL. Roles are
stored, not derived. `admin` here is **workspace admin** — distinct from org
admin, with distinct powers (§3).

```sql
workspace_members (
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id),
  membership_id           TEXT NOT NULL REFERENCES memberships(id),
  role                    TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  added_by_membership_id  TEXT REFERENCES memberships(id),
  added_at                INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, membership_id)
)
```

Org admins keep implicit reach into every workspace of the org (today's
invariant, `workspace-access.ts:39`), but implicit reach is *access*, not
workspace-admin powers — see the matrix in §3.

### machines — one VM per (workspace, member)

The machines table takes every VM column the workspace row loses. A machine
belongs to a workspace and to exactly one of: a membership (after
redemption) or an invite (between invite creation and redemption — no
membership row exists yet, so the invite is the key).

**The volume is the durable machine; the VM is an incarnation.** Machine
state is volume-backed (#88), so the VM fields are replaceable while the
machine row and its volume persist. This is what makes machine types
per-member and mutable (§1a): a type change destroys the VM, keeps the
volume, and creates a new VM of the new type.

```sql
machines (
  id                         TEXT PRIMARY KEY,
  workspace_id               TEXT NOT NULL REFERENCES workspaces(id),
  membership_id              TEXT REFERENCES memberships(id),
  invite_id                  TEXT REFERENCES invites(id),
  state                      TEXT NOT NULL CHECK (state IN
                               ('provisioning','running','stopped','error',
                                'destroying','destroyed')),
  machine_type_id            TEXT NOT NULL,   -- per machine; defaulted, overridable, mutable
  compute_credential_source  TEXT NOT NULL CHECK (compute_credential_source IN ('org','deployment')),
  vm_id                      TEXT,
  volume_id                  TEXT,
  ssh_host TEXT, ssh_port INTEGER, ssh_user TEXT, ssh_host_public_key TEXT,
  phone_home_hash TEXT, phone_home_used INTEGER,
  tunnel_id TEXT, tunnel_hostname TEXT, dns_record_id TEXT,
  error                      TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  CHECK ((membership_id IS NULL) <> (invite_id IS NULL)),
  UNIQUE (workspace_id, membership_id)
)
```

`boxes.workspace_id UNIQUE` becomes `boxes.machine_id UNIQUE`. The box
principal is the machine's member, not the workspace owner — this is the D4
identity fix, and the change site is known (`workspaces.ts:1252-1256`,
`mint.ts:243`).

### §1a Machine types are per machine, not per workspace

The workspace holds only a **default**. The model must never restrict which
types a workspace can hold. Three consequences:

1. At provision, a machine takes an explicit type when one is given (per
   member at create or invite), else the workspace default.
2. A machine's type is mutable. `SetMachineType` destroys the VM, keeps the
   volume, and provisions a new VM of the new type on the same volume. The
   member's disk state survives; running sessions restart.
3. Different members of one workspace can hold different types at the same
   time.

One provider constraint carries over: a volume attaches within its own
location. A type change keeps the volume when the new type is in the same
location. A cross-location change needs a volume move — deferred (§5).
Automatic resize on pressure is also deferred; `SetMachineType` is the
manual path until then.

### invite_workspaces — what an invite grants

Invites stay org-scoped (they must: the user does not exist yet). An invite
carries workspace assignments. Redemption creates the `workspace_members`
rows and re-keys each invite-held machine to the new membership.

```sql
invite_workspaces (
  invite_id        TEXT NOT NULL REFERENCES invites(id),
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  role             TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  machine_type_id  TEXT,   -- NULL = workspace default (§1a)
  PRIMARY KEY (invite_id, workspace_id)
)
```

### workspace_credentials — the statics the workspace adds

Sealed static keys, scoped to the workspace, managed by the **org admin** in
workspace settings (and at create time). Values are AES-256-GCM sealed with
the existing `CRED_MASTER_KEY`, AAD = `wscred:<workspaceId>:<name>`. Note:
this deliberately reverses migration 0028's ruling ("ad-hoc secrets are a
workspace file"); the reversal is intended and recorded here.

```sql
workspace_credentials (
  id                        TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspaces(id),
  name                      TEXT NOT NULL,   -- 'stripe-test', 'sentry', ...
  label                     TEXT,
  ciphertext                TEXT NOT NULL,
  delivery                  TEXT NOT NULL CHECK (delivery IN ('env','header')),
  env_name                  TEXT,            -- when delivery = 'env'
  created_by_membership_id  TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  revoked_at INTEGER
)
-- one live row per (workspace_id, name): partial unique index WHERE revoked_at IS NULL
```

### Wire types

```ts
type WorkspaceRole = 'admin' | 'editor' | 'viewer';
type MachineState  = 'provisioning' | 'running' | 'stopped' | 'error'
                   | 'destroying' | 'destroyed';

interface MachineView {
  id: string;
  state: MachineState;
  machineTypeId: string;         // this machine's type; workspace holds only a default
  volumeId: string | null;       // the durable half; survives SetMachineType
  membershipId: string | null;   // null while invite-held
  inviteId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SetMachineTypeRequest {
  machineTypeId: string;         // same-location: VM recreates on the same volume
}

interface WorkspaceMemberView {
  membershipId: string;
  name: string;
  role: WorkspaceRole;
  machine: MachineView | null;   // null: not provisioned (auto_provision off, or viewer)
}

interface WorkspaceView {
  id: string;
  orgId: string;
  name: string;
  ownerMembershipId: string;
  defaultMachineTypeId: string;  // a default only; each machine carries its own
  autoProvision: boolean;
  myRole: WorkspaceRole;
  members: WorkspaceMemberView[];
  credentials: { name: string; label: string | null; createdAt: number }[];
                                  // names only; a value never crosses the wire
}

interface CreateWorkspaceRequest {
  name: string;
  defaultMachineTypeId: string;
  autoProvision?: boolean;        // default true
  members?: { membershipId?: string; email?: string; role: WorkspaceRole;
              machineTypeId?: string }[];
                                  // membershipId: existing org member, added directly
                                  // email: creates an org invite + invite_workspaces row
                                  // machineTypeId: per-member override of the default
  environment?: Record<string, string>;
  agentRuleId?: string;
  repos?: string[];
  credentials?: { name: string; label?: string; value: string;
                  delivery: 'env' | 'header'; envName?: string }[];
                                  // create-time only path where a value is sent;
                                  // org-admin caller required when present
  cloneFromWorkspaceId?: string;  // copy config (never credential values, never members)
}
```

## 2. Lifecycle rules

1. **Invite sent** (existing member assigned, or email invite created): if
   `auto_provision = 1`, a machine row is created (invite-keyed for email
   invites, membership-keyed for existing members) and provisioned to
   `running`. If `auto_provision = 0`, no machine; it provisions on first
   open or by workspace-admin action.
2. **Invite redeemed**: `workspace_members` rows created from
   `invite_workspaces`; invite-held machines re-key to the membership.
3. **Viewer role**: no machine, ever. Viewers watch sessions; they do not
   run them.
4. **Member removed from workspace / leaves org**: their machines in that
   scope are destroyed after a grace snapshot; volume retention (existing
   7-day sweep) covers restore.
5. **Unredeemed invite**: janitor destroys invite-held machines and expires
   the invite after 14 days.
6. **Workspace deleted**: all machines destroy; the workspace row tombstones
   after the last machine is gone.
7. **vm_limit** counts `machines` rows in live states; `vmsUsed` and the
   entitlements fixtures move to the same definition.
8. **SetMachineType**: destroy the VM, keep the volume, provision a new VM
   of the new type, reattach. Sessions restart; disk state survives. Refuse
   a cross-location type until the volume move lands (§5).

## 3. Permissions

| Action | Org admin | WS admin | Editor | Viewer |
| --- | --- | --- | --- | --- |
| Create workspace | ✓ | — | — | — |
| Workspace settings (name, machine type, auto_provision, config) | ✓ | ✓ | — | — |
| Manage member roles in the workspace | ✓ | ✓ | — | — |
| Invite / add / remove workspace members | ✓ | ✓ | — | — |
| Manage members' machine lifecycle (provision, stop, start, recreate, destroy) | ✓ | ✓ | own stop/start | — |
| Change a machine's type, keep its volume (SetMachineType) | ✓ | ✓ | — | — |
| Workspace credentials: add, rotate, revoke | ✓ | — | — | — |
| Workspace credentials: use in sessions | ✓ | ✓ | ✓ | — |
| Run sessions on own machine | ✓ | ✓ | ✓ | — |
| Watch workspace-visible sessions | ✓ | ✓ | ✓ | ✓ |
| Delete workspace | ✓ | ✓ | — | — |

Workspace admin and org admin are distinct on purpose: the workspace admin
runs the team (roles, machines); the org admin holds the org's secrets and
billing. Org-admin implicit access remains, as today.

## 4. Credentials — two planes, one resolution rule

**Personal plane.** All of a member's personal credentials are available on
that member's machine, in every workspace: connection grants (GitHub, model
keys) resolve against the *machine's member*, and harness logins roam via
the broker exactly as today (`broker_members` is already per-principal).
This replaces today's owner-resolution (`mint.ts:243`) — the machine's
member IS the identity, so nothing is borrowed and no disclosure banner is
needed.

**Workspace plane.** The workspace box only *adds* the workspace
credentials from §1. Every member's machine in the workspace can use them
(viewer excepted — no machine). Audit rows name the machine and its member.

**Resolution rule for `blitz-cred get <name>`:**
1. The member's own grant for `<name>`, if one exists — personal wins, so
   the agent acts as the member whenever it can.
2. Else the workspace credential `<name>`.
3. Else the existing refusal + connection request flow.

Injection-at-use (values out of transcripts) rides the existing seams
(`canUseTool.updatedInput`, the git-helper pattern) and lands with Build 4.

## 5. Deferred

- **Auto-upgrade on pressure** (the old D2 resize): deferred. This is a
  later optimization. Until then, `SetMachineType` is the manual path.
- **Cross-location type change**: deferred. It needs a volume move
  (snapshot + restore in the new location). Until then, `SetMachineType`
  refuses a type whose location differs from the volume's.
- Per-session credential audit dimension: lands with sessions (Build 2+).

## 6. The workspace details page (revamp target)

The dialog at `/workspaces/:id` ("Workspace details", annotated for revamp)
becomes the workspace administration surface. Tabs:

1. **Members** — one row per member: name, role selector (WS admin), machine
   state chip, machine type selector (SetMachineType, with a "keeps the
   disk" note), and lifecycle controls (provision / stop / start / recreate
   / destroy) per the matrix. Invite control at the top, with a per-member
   type override.
2. **Credentials** — workspace credential list: name, label, created-by,
   created-at; add/rotate/revoke for org admins. Values are write-only.
3. **Settings** — name, machine type (with "applies to new machines" note),
   auto_provision toggle, environment, agent rules, repos, clone action,
   delete.

Today's Compute/Storage panels collapse into the per-member machine rows;
per-machine detail (vCPU, RAM, disk, volume) opens from the row.

## 7. Builds (revised)

**Build 1 — workspaces, members, machines.** The schema in §1 minus
credentials; migration off the template tables; invite assignments;
provision-on-invite with the auto_provision toggle; destroy-on-leave;
janitors re-pointed at `machines`; `vm_limit`/`vmsUsed` re-based; the
details-page Members tab. Done when: an invited member's first open lands
on a running machine, a removed member's machine destroys with a grace
snapshot, and a WS admin can stop and start any member machine from the
page.

**Build 2 — sessions as objects.** Unchanged from the prior revision
(control-plane `agent_sessions`, the three-column rail, promote the ACP
actor). Grounding: the survey's Build-2 section.

**Build 3 — sharing.** Unchanged: visibility enforcement, watch, send with
attribution, fork.

**Build 4 — credentials.** Member-resolution mint (D4 fix),
`workspace_credentials` + the Credentials tab, resolution rule §4,
injection-at-use, use-audit events.

**Build 5 — pricing alignment.** Unchanged, plus the fixtures move for
`vmsUsed`.

Build 1 and Build 2 stay independent. Build 4's D4 fix can ship inside
Build 1 (it is one resolution change once boxes are member-keyed).

## Appendix — standing decisions

- Sessions default to workspace-visible; private is the exception.
- Attribution follows the credential; shared context never authorizes a
  personal-credential action.
- A "send" turn runs as the machine's owner, attributed to the sender,
  `Co-authored-by` on commits; Fork is the identity escape.
- Free plan is BYOK twice (compute + model keys); sponsored trials (#104)
  are the only exception. #104 must land before Build 5.
- Always-on machines; no sleep state in the product. Economics recorded in
  the prior revision and the ground-truth survey.
