# MEMBER MACHINES — the workspace is a server, and every member gets a machine

Written 2026-08-28, revised same day after the ground-truth survey
(`plans/evidence/member-machines-ground-truth.md`, main @ cbf9a1fb).
Supersedes `plans/MULTI-MEMBER-BOX.md` and the workspace-templates concept.
UI mockup: `plans/mockups/session-rail.html`.

```
org
 └─ workspace "engineering"            ← its own template; nothing else is
     ├─ config: machine type · agent rules · repos · credentials (env)
     ├─ workspace_members: (membership, role)      role: admin | member | viewer
     ├─ machines: one VM per member, on by default
     └─ sessions (Build 2)
```

## 0. The idea

A workspace works like a Discord server. A workspace admin adds org members
to it with a role — only existing org members; the org roster grows through
the org's own invite system, which this plan does not touch. Each member
gets one always-on machine, provisioned the moment they are added, destroyed
when they leave.
Sessions inherit the workspace's agent rules, drive, and credentials.
Machines never appear as a user decision — only in workspace administration.

**The workspace is its own template.** There is no separate template object.
A workspace *carries* the config a template used to carry — machine type,
agent rules, repo list, workspace credentials — and "new
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
  auto_provision       INTEGER NOT NULL DEFAULT 1,  -- provision + start machine on member add
  agent_rule_id        TEXT REFERENCES agent_rules(id),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
)
-- dropped from workspaces: phase, vm_id, volume_id, ssh_*, phone_home_*,
-- tunnel_id/tunnel_hostname/dns_record_id, compute_credential_source,
-- box_update_*, org_share_role (replaced by workspace_members),
-- environment (replaced by workspace_credentials)
```

### workspace_members — membership with a stored role

Replaces the computed role and the `workspace_grants` sharing ACL. Roles are
stored, not derived. `admin` here is **workspace admin** — distinct from org
admin, with distinct powers (§3).

```sql
workspace_members (
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id),
  membership_id           TEXT NOT NULL REFERENCES memberships(id),
  role                    TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
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
belongs to a workspace and to a membership — always. Workspace members are
org members, so the membership row exists before the machine does.

**Terminology.** A **machine** is the durable per-member object this table
defines (the word already exists user-facing as "machine type"). A **vm**
is the provider-level incarnation (`vm_id`, `createVm`, `VmProvider`,
`vm_limit`). A **box** stays a word for the guest runtime — the packages,
the image, the gateway — but **the `boxes` table is deleted**: the machine
row is the guest's identity. There is one row, not two.

**Enrollment folds into the machine.** Today phone-home inserts a `boxes`
row plus a token family, and `boxes.principal_id` stores the workspace
owner — the stored principal that causes the D4 misattribution. Unified:

- Phone-home verifies `machines.phone_home_hash`, mints a token family in
  `machine_token_families` (the renamed `box_token_families`, keyed by
  `machine_id` and stamped with the `vm_id` it was minted for), and flips
  the machine to `running`. The capability re-arms at every vm provision.
- The guest calls the control plane as its machine. `boxCaller` resolves
  the acting principal from `machines.membership_id` at call time — no
  stored principal exists to go stale. D4 stops being a fix and becomes
  structure.
- `credential_leases.box_id` becomes `machine_id`; `GET /boxes/:id/feed`
  becomes `GET /machines/:id/feed`.
- A vm destroy (stop, `SetMachineType`, recreate) revokes the machine's
  token families; the stamped `vm_id` fences any stale guest that
  outlives its incarnation. The next boot enrolls fresh against the same
  machine row.

(`broker_boxes` is the broker's own fleet table and is unrelated; it
stays.)

**The volume is the durable machine; the VM is an incarnation.** Machine
state is volume-backed (#88), so the VM fields are replaceable while the
machine row and its volume persist. This is what makes machine types
per-member and mutable (§1a): a type change destroys the VM, keeps the
volume, and creates a new VM of the new type.

```sql
machines (
  id                         TEXT PRIMARY KEY,
  workspace_id               TEXT NOT NULL REFERENCES workspaces(id),
  membership_id              TEXT NOT NULL REFERENCES memberships(id),
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
  UNIQUE (workspace_id, membership_id)
)
```

The change sites for the old stored-principal path are known
(`workspaces.ts:1252-1256`, `mint.ts:243`); both now read the machine row
instead.

### §1a Machine types are per machine, not per workspace

The workspace holds only a **default**. The model must never restrict which
types a workspace can hold. Three consequences:

1. At provision, a machine takes an explicit type when one is given (per
   member at create or add), else the workspace default.
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

### workspace_credentials — the statics the workspace adds

Sealed static keys, scoped to the workspace, managed by the **workspace
admin** in workspace settings (and at create time). Values are AES-256-GCM
sealed with the existing `CRED_MASTER_KEY`, AAD =
`wscred:<workspaceId>:<name>`. Note:
this deliberately reverses migration 0028's ruling ("ad-hoc secrets are a
workspace file"); the reversal is intended and recorded here.

```sql
workspace_credentials (
  id                        TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspaces(id),
  name                      TEXT NOT NULL,   -- the env var name: STRIPE_API_KEY, ...
  label                     TEXT,
  ciphertext                TEXT NOT NULL,
  created_by_membership_id  TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  revoked_at INTEGER
)
-- one live row per (workspace_id, name): partial unique index WHERE revoked_at IS NULL
```

**One store, one read — this table replaces `workspaces.environment`.**
Today's two half-systems (plaintext workspace env vars; sealed but
org-scoped connections) unify here. A row is a name and a sealed value,
and the only consumer is `blitz-cred`:

- `blitz-cred get <name>` / `blitz-cred env <name>` serve the value on
  demand, behind the §4 resolution rule (personal grant first).
- Nothing is exported ambiently. An agent or program that wants an env var
  sets it itself, scoped as the agent rules already teach:
  `STRIPE_API_KEY=$(blitz-cred get STRIPE_API_KEY) cmd`.

An add is available at once — the next `blitz-cred` call reads the store
live; no sync, no restart. A revoke refuses the next call. No value ever
sits in a file on the machine.

**The `env.d` delivery path is deleted with this.** It existed only for
`workspaces.environment`: the broker-written `creds/env.d/00-workspace.sh`,
its profile sourcing, the `tmux -e` pass in `blitz-term`, the env merge
into chat turns, and the `workspace-environment` cross-runtime contract
with its fixtures all retire. `blitz-cred` becomes the single door to
every secret on the box.

### Wire types

```ts
type WorkspaceRole = 'admin' | 'member' | 'viewer';
type MachineState  = 'provisioning' | 'running' | 'stopped' | 'error'
                   | 'destroying' | 'destroyed';

interface MachineView {
  id: string;
  state: MachineState;
  machineTypeId: string;         // this machine's type; workspace holds only a default
  volumeId: string | null;       // the durable half; survives SetMachineType
  membershipId: string;
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
  members?: { membershipId: string; role: WorkspaceRole;
              machineTypeId?: string }[];
                                  // existing org members only, added immediately
                                  // machineTypeId: per-member override of the default
  agentRuleId?: string;
  repos?: string[];
  credentials?: { name: string; label?: string; value: string }[];
                                  // name is the env var name
                                  // create-time only path where a value is sent;
                                  // the creator is the first workspace admin
  cloneFromWorkspaceId?: string;  // copy config (never credential values, never members)
}
```

## 2. Lifecycle rules

1. **Member added** (workspace admin picks an active org member, at create
   or later): the `workspace_members` row is written immediately. If
   `auto_provision = 1` (the default), a machine row is created in the same
   act and provisions to `running`. If `auto_provision = 0`, no machine
   yet; it provisions on first open or by workspace-admin action.
2. **Viewer role**: no machine, ever. Viewers watch sessions; they do not
   run them.
   *(Amendment 2026-09-03: a member whose OWN machine is `stopped` opens the
   workspace to a pane that offers Start, and the shell dials nothing until
   the machine runs. The legacy `phase` projects `stopped` as `ready` on
   purpose, so the webapp reads the state off `members[].machine` instead —
   `workspace-store.ts`, `lifecycleStatusFor`. Before that the shell treated
   the workspace as running and every box call answered 409.)*
3. **Member removed from workspace / leaves org**: their machines in that
   scope are destroyed after a grace snapshot; volume retention (existing
   7-day sweep) covers restore.
4. **Workspace deleted**: all machines destroy; the workspace row tombstones
   after the last machine is gone.
5. **vm_limit** counts `machines` rows in live states; `vmsUsed` and the
   entitlements fixtures move to the same definition.
6. **SetMachineType**: destroy the VM incarnation, keep the volume,
   provision the new type on the same volume. Sessions restart; disk state
   survives. Refuse a cross-location type until the volume move lands (§5).
7. **Org invites are out of scope.** The org roster grows through the
   existing org invite system. A new org member holds no machines until a
   workspace admin adds them to a workspace.

## 3. Permissions

Three workspace roles, one implicit reach. In one line each:

- **Workspace admin** runs the workspace: members, roles, machines,
  settings, workspace credentials. The creator is the first admin.
- **Member** works in it: own machine, own sessions, credential use,
  drive write.
- **Viewer** watches: workspace-visible sessions and drive read. No
  machine, no sessions of their own, no credential use.
- **Org admin** is not a workspace role. Org admins hold implicit
  workspace-admin reach in every workspace of the org (today's invariant),
  plus the org-only concerns: the org roster and invites, billing, the org
  compute credential, and workspace creation.

| Action | WS admin | Member | Viewer |
| --- | --- | --- | --- |
| Workspace settings (name, default type, auto_provision, rules, repos) | ✓ | — | — |
| Add / remove workspace members (active org members only) | ✓ | — | — |
| Manage member roles | ✓ | — | — |
| Machine lifecycle on any member machine (provision, stop, start, recreate, destroy) | ✓ | own stop/start | — |
| SetMachineType on any member machine (keep volume) | ✓ | — | — |
| Workspace credentials: add, rotate, revoke | ✓ | — | — |
| Workspace credentials: use in sessions | ✓ | ✓ | — |
| Run sessions on own machine | ✓ | ✓ | — |
| Watch workspace-visible sessions | ✓ | ✓ | ✓ |
| Drive: write / read | ✓ / ✓ | ✓ / ✓ | — / ✓ |
| Delete workspace | ✓ | — | — |

Org admins pass every ✓ in the WS-admin column through implicit reach.
Workspace creation is org-admin only for now; a later revision can open it.

Naming note: the workspace role `member` and the org `memberships` table
are different things. A person is an org member through `memberships`, and
holds a workspace role (`admin | member | viewer`) per workspace.

## 4. Credentials — two planes, one resolution rule

**Personal plane.** All of a member's personal credentials are available on
that member's machine, in every workspace: connection grants (GitHub, model
keys) resolve against the *machine's member*, and harness logins roam via
the broker exactly as today (`broker_members` is already per-principal).
This replaces today's owner-resolution (`mint.ts:243`) — the machine's
member IS the identity, so nothing is borrowed and no disclosure banner is
needed.

**Workspace plane.** *Superseded 2026-09-02: the workspace credential store
is deleted; the static plane is org-scoped — see plans/ORG-CREDENTIALS.md.*
The workspace box only *adds* the workspace
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
   / destroy) per the matrix. An add-member control at the top — a picker
   over active org members — with a per-member type override.
2. **Credentials** — workspace credential list: name, label, created-by,
   created-at; add/rotate/revoke for workspace admins. Values are
   write-only.
3. **Settings** — name, machine type (with "applies to new machines" note),
   auto_provision toggle, agent rules, repos, clone action,
   delete.

Today's Compute/Storage panels collapse into the per-member machine rows;
per-machine detail (vCPU, RAM, disk, volume) opens from the row.

## 6a. Sidecar — the strip and the rail, before sessions

A UI refactor that ships independently of every build. **The canonical
reference is the mockup**: `plans/mockups/session-rail.html`, live at
https://blitzos-session-rail.app.blitz.dev/. Adopt its `#strip` and
`#rail` as designed — structure, dimensions, and visual vocabulary come
from the mockup, not from this document. Its stylesheet is the visual
spec (`--paper/--ink/--accent` tokens, radii, the 48px/252px columns);
port those values into `tokens.css` rather than restyle by taste.

**Scope.** Columns 1 and 2 only. No change to the right icon strip
(`WorkspaceRailStrip`), the tab strip (`WebAppHeader`), the terminal and
editor panes, or the mobile drawer semantics. **No sessions yet** — the
rail lists the managed tab types that already exist under a workspace
(`claude | codex | terminal | chat` from `webapp_state`), one workspace
at a time. Build 2 later swaps the rail's data source to session rows;
the mockup already draws the end state, so no second layout change comes.

**Element-by-element mapping** — mockup element → what feeds it now →
what changes at Build 2:

| Mockup element | Now (pre-sessions) | At Build 2 |
| --- | --- | --- |
| `.app` grid `48px 252px 1fr` | replaces `drive-shell`'s `264px` rail column; the right icon strip stays as a fourth column | unchanged |
| `#strip` `.orgmark` | org mark; the org-switcher popover moves onto it | unchanged |
| `#strip` `.wtile` per workspace | tile with 2–3 letter code, name tooltip, `wtile--on` ring on the active one | `.beat` live dot when a session is live |
| `#strip` "+" tile | create workspace (per the §3 matrix) | unchanged |
| `#strip` surface icons (Files, Ports, Connections) | present per the mockup; they focus the same panels the right strip toggles today | Keys and Members surfaces join (§6) |
| `#strip` `.av` avatar | user/settings menu | unchanged |
| `#rail` `.rhead` name + `.sub` + share icon | workspace name; `.sub` slot stays empty (the mockup shows RAM; machines are not user-facing — open mapping, see below); share opens `ShareWorkspaceDialog` | `.sub` = live-session count or member count; share becomes the session share popover (Build 3) |
| `.newbar` "New session" | pinned action; opens the same menu as the tab strip's "+" | spawns a real session via the launcher |
| `.s` row: `.g` gutter · `.s__t` title · `.s__a` time — "never more" | gutter = tab-type glyph; title = tab title; `.s__a` stays empty (tabs have no clock) | gutter = empty for own / face for others; `.s__a` = time, green when live |
| `.asleep` pane | not rendered; workspace `creating`/`error` states keep their existing main-pane copy | not rendered (D3: no sleep state) |
| launcher pane ("What should we build?") | deferred — it creates sessions | ships with Build 2 |

A row click activates that tab in the tab strip; a strip click switches
the workspace. Non-workspace pages (Drive, settings) keep the strip and
use the remaining width. The Templates and Recipes nav rows die with the
template concept (Recipes is already hidden, #103).

**Open mapping to confirm:** the mockup's `.rhead .sub` shows the
workspace RAM. Per-member machines have no single RAM figure, and D3
hides machines. The slot stays; the feed is a product call.

**Order of work** (from the ground-truth survey):

1. Land or rebase `feat/operator-console` first — it collides with
   `DriveRail`, `CloudApp`, and `sessions-page-state`.
2. Split `CloudApp.tsx` into rail container, work-pane container, route
   switch, and dialog stack. This is the first commit, before visuals.
3. Migrate the ~20 class-selector test assertions to role/label queries.
4. Build Strip and Rail as new components against the mockup; delete
   `DriveRail`; rewire the 8 `railFor` call sites.

## 6b. Member and machine-type configuration UI

Per-member machine types (§1a) need UI in two places: workspace create and
workspace edit. The design reuses what exists; two components are new.
Implementation ships with Build 1.

**Existing parts to reuse** (from the ground-truth survey):

- `MachineCatalogGrid` — the radio-card type grid, with `groupMachineTypes`
  (provider + location groups) and `monthlyPriceLabel`. Stays the picker
  for the **workspace default**.
- `ShareWorkspaceDialog` — its people search over org members, suggestion
  list, and per-person role selects are exactly the member-picker pattern.
  The pattern is lifted; the dialog itself retires with `workspace_grants`.
- `WebAppSelectMenu` — the listbox popover (outside-click, Escape, focus
  return). Base for the compact type select.
- `DriveAvatar` — member avatars in rows.

**New component 1 — `MachineTypeSelect`.** A compact select on
`WebAppSelectMenu`. One option per machine type: name, vCPU/RAM, monthly
price, grouped by provider + location like the grid. First option:
"Workspace default (<type>)". Two contexts gate its option list: at add
time, all locations; on a live machine (`SetMachineType`), only types in
the volume's location, others visible but disabled with a "volume is in
<location>" note (§1a constraint).

**New component 2 — `WorkspaceMembersEditor`.** One list, two modes.
Row = avatar · name · role select (`admin | member | viewer`) ·
`MachineTypeSelect` · remove. A viewer row hides the type select (no
machine, §2). Header = the lifted people search over active org members,
plus Add.

- *Draft mode* (inside `CreateWorkspaceDialog`): edits local state only;
  submit sends `CreateWorkspaceRequest.members[]`. The creator appears
  pinned as the first workspace admin.
- *Live mode* (details-page Members tab, §6): each edit calls the API at
  once. Rows gain the machine state chip and the lifecycle menu from §6;
  the type select performs `SetMachineType` with a "keeps the disk"
  confirmation.

`CreateWorkspaceDialog` gains a Members section holding the draft-mode
editor, below the machine-type grid (which now labels itself "Default
machine type"). The details page embeds live mode. Nothing else changes.

## 7. Builds (revised)

**Build 1 — workspaces, members, machines.** The schema in §1 minus
credentials; migration off the template tables; provision-on-add with the
auto_provision toggle; destroy-on-leave; janitors re-pointed at `machines`;
`vm_limit`/`vmsUsed` re-based; the details-page Members tab. Done when: an
added member's first open lands on a running machine, a removed member's
machine destroys with a grace snapshot, and a WS admin can stop and start
any member machine from the page.

**Build 2 — sessions as objects.** Control-plane `agent_sessions`; promote
the ACP actor. The rail shell already exists via the sidecar (§6a); this
build swaps its data source and adds clock, live state, owner, visibility.
Grounding: the survey's Build-2 section.

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
