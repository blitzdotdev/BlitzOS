# Org credentials — delete the box wire, delete the workspace store, one org plane

Status: **design draft, 2026-09-01, revision 3.** Grounded in a code survey of
the live credential subsystem on `main` (file:line references below).
Revision 2 deleted the frozen box credential wire in favor of a self-described
HTTP API. Revision 3, after an overengineering sweep with the founder:
**workspace credentials are deleted entirely** (org scope is the only static
plane), the OpenAPI doc is **generated from the schema types** (never
hand-written), org admins read everything, and the grant-proposal machinery is
cut to its minimum (one intent form, no dedup, no narrowing rule).

## 0. The problems

1. **No native sharing.** A new workspace on the same project starts empty;
   the only path is copy-paste of values.
2. **No single point of rotation.** The same key pasted into three workspaces
   is three rows; rotating one leaves two stale.
3. **No people-shaped grants.** "The whole eng team may use this key, in any
   workspace" is inexpressible — access rides workspace membership only.
4. **The delivery vehicle freezes the API.** `blitz-cred` bakes exact wire
   shapes into a compiled binary on every box in the field
   (`DisallowUnknownFields` at `connections.go:198`, exact key-set at
   `pull-wire.ts:71-73`, three unversioned fixture corpora). Every additive
   API change breaks deployed boxes. The CLI is an API wrapper — the API
   should be the surface.

## 1. The model today (survey summary)

Three credential planes exist:

| Plane | Store | Scope | Write gate | Read path |
|---|---|---|---|---|
| Personal connection grants | `user_oauth_grants` (live key `(user_id, provider)`, 0023) + org-scoped `connections` rows (`UNIQUE(org_id, scoped_name)`, 0010:39) | person / org | self-only (`user-grants.ts:357`) | `mintOne` with `authorize()` = `isWorkspaceMember` ∧ manifest ∧ `usable_by` (`mint.ts:73-85`) |
| Workspace credentials | `workspace_credentials` (0042), AES-256-GCM under `CRED_MASTER_KEY`, AAD `wscred:<workspaceId>:<name>` (`workspace-credentials.ts:36-38`) | workspace | `requireWorkspaceAdmin` on both doors | box token alone — no role or manifest check (`pull-routes.ts:166-189`) |
| Broker harness logins | broker box disk, per-member unix homes | person | — | SSH forced command; untouched here |

Resolution for `blitz-cred get <name>` (`pull-routes.ts:161-198`): personal
grant → workspace credential → file a request and 404.

Survey facts that shape this plan:

- **The box credential wire today**: five hardcoded `/workspaces/self/...`
  routes (`controlplane.go:154-192`), closed-set decoding on both sides, a
  byte-for-byte name echo check, three incompatible name alphabets, no
  version field. This is what gets deleted.
- **Box identity is resolved server-side at call time**: machine bearer →
  `machine_token_families` → `machines.membership_id` → membership
  (`oauth.ts:238-278`, `boxCaller` at `pull-routes.ts:47-80`). This survives
  unchanged — it is the auth for raw HTTP exactly as it was for the CLI.
- **The bearer is short-lived and rotation is stateful.** Access tokens live
  15 min (`oauth.ts:18`); refresh is single-use with a cross-process flock
  (`controlplane.go:283-321`). So one dumb primitive must remain on the box:
  something that yields a valid bearer. It carries zero API schema.
- **The box caches no credential values** (`connections.go:18-22`) — every
  read is live, so org-level rotation propagates on the next call with zero
  delivery machinery.
- **The rules doc is already CP-served.** `GET /workspaces/self/agent-rules`
  (CP producer `core/agent-rules.ts`, box consumer `blitz-rules sync`) is
  exactly the "always up-to-date agents.md" channel — we extend it.
- **The workspace store is days old and small** (landed with migration 0042,
  2026-08-28; ≤50 rows per workspace). Deleting it rather than migrating it
  is cheap now and never again.

## 2. The design in six lines

1. **Delete the box credential wire.** The `blitz-cred` credential verbs,
   their Go decoders, and the three fixture corpora go away. The box keeps
   only schema-free primitives.
2. **The agent surface is the HTTP API**, self-described at runtime:
   `GET /agent/api` serves an OpenAPI document **generated from the schema
   types at build time** — never hand-written.
3. **Delete `workspace_credentials` — as if it never existed.** One static
   plane remains: `org_credentials`, sealed like everything else (AAD
   `orgcred:<orgId>:<name>`). No shadowing, no promote, no override tier.
4. An explicit allowlist: `org_credential_grants` — subjects are the whole
   org, a workspace, or a membership; access is `read` or `write`
   (write ⊇ read). Org admins implicitly hold both on everything.
5. Resolution is two tiers: personal connection grant → org credential the
   caller may read → refusal (which files the request, as today).
6. **Agents may propose grant changes; humans approve them** in a diff
   dialog (`plans/mockups/grant-approval.html`); what applies is what the
   human approves.

## 3. Deletions

### The box credential wire

- `blitz-cred` verbs `list`, `get`, `env`, `import`, `put`
  (`cmd/blitz-cred/main.go:98-185`) and their internals:
  `internal/workspace/connections.go` (list/mint/decode), `credentials.go`,
  `credimport.go`, the request-id plumbing in `cp.go`, and the five path
  builders in `controlplane.go:152-192`.
- The three cross-runtime contracts and their corpora:
  `fixtures/connection-pull/`, `fixtures/credential-list/`,
  `fixtures/credential-import/`, both sides' conformance tests, and their
  CLAUDE.md contract-table rows (retired with a dated note).
- The five legacy `/workspaces/self/*` credential routes, the whole of
  `pull-wire.ts`, and the filler-header and synthetic-TTL hacks
  (`pull-routes.ts:88-101`). No shim, no legacy tests, no compatibility
  window.

### The workspace credential store — as if it never existed

- The `workspace_credentials` table (dropped by the same migration that
  creates the org tables). **Values are not migrated**: same-name collisions
  across workspaces make an automatic lift ambiguous, the store is days old,
  and the org-level dotenv import re-creates a workspace's worth of keys in
  one paste. This is a stated data deletion, not an accident.
- `core/workspace-credentials.ts`, the workspace half of
  `core/workspace-credential-import.ts`, the session routes
  `PUT/DELETE /workspaces/:id/credentials*`, and the `wscred:` AAD.
- `WorkspaceView.credentials` and `CreateWorkspaceRequest.credentials[]`
  (schema + wire-drift coverage move in the same commit; the webapp is the
  only client). The create-workspace dialog loses its credentials section;
  the workspace-details Credentials tab becomes a view over org credentials
  (§9).
- `plans/MEMBER-MACHINES.md` §4's workspace plane is superseded; the plan
  gets a pointer note.

### What survives on the box (all schema-free)

- **`blitz-cred api-token`** (new, ~20 lines): prints a currently-valid
  machine bearer, reusing the existing refresh + flock machinery
  (`controlplane.go:244-321`). The ONLY local helper — everything else is
  the agent's own curl against the routes the OpenAPI doc lists.
- **Enrollment and refresh** (`enroll`, phone-home, `box-credential.json`,
  `origin`) — unchanged.
- **Broker plane** (`register`, `token claude|codex`, `watch`) — unchanged;
  SSH machinery, not API wrappers.
- **`git-helper`** — a small shell script: curl to
  `POST /agent/credentials/github/token` + `jq`.
- **`blitz connections open <provider>`** — unchanged (a local focus file).

### Image cycling — no legacy support

1. Land the new `/agent/*` routes and the new box image (verbs removed,
   `api-token` + shell `git-helper` in) in one release train.
2. Cycle the images: rebake canary per `docs/BOX-IMAGE.md`, cut the client
   prod tag; cloud-VM boxes update via `blitz-box-update`, microVM machines
   recreate their VM incarnation (volume-backed; disk state survives).
3. Delete the legacy routes in the same train. A straggler box fails loudly
   (404) and the fix is updating it — never a server-side compat path.

## 4. The self-describing agent API

### Routes

All box-authed through `boxCaller` (machine bearer), under `/agent/`:

```text
GET  /agent/api                        the OpenAPI 3.1 document — generated, see below
GET  /agent/credentials                list: [{name, scope: 'connection'|'org', comment, writable}]
POST /agent/credentials/:name/token    resolve + mint through the §6 rule;
                                       {name, scope, token, env[], header, expiresAt}
PUT  /agent/credentials/:name          create or rotate an org credential; {value, comment?}
                                       (create needs an active membership; rotate needs write)
POST /agent/credentials/dotenv         org-level import; {text, dryRun?} — same parser, new door
POST /agent/credentials/grant-proposals  propose grant changes (§7a)
GET  /agent/grant-proposals/:id          poll a proposal (§7a)
```

Refusals keep the request-filing behavior: a miss files a
`credential_requests` row and returns `404 {error, request_id}`; the rules
keep teaching `blitz connections open <provider>` as the recovery.

### The doc is generated — never hand-written

`packages/schema` already holds the wire types; the doc derives from them:

- A build-time generator emits `agent-api.json` from the schema types plus a
  small route manifest (method, path, request/response type names) that
  lives beside the route registrations. No hand-authored JSON Schema,
  anywhere, ever.
- `GET /agent/api` serves the generated artifact.
- Two gates keep it honest: a **bidirectional route-coverage test** (every
  registered `/agent/*` route appears in the doc; every doc path is
  registered) and **one doc-conformance test** that replays each agent
  route's happy-path response against the generated schemas. The drift-sweep
  runbook gains one line.

### The agent rules (the CP-hosted agents.md)

The credentials section of the global rules
(`box/rootfs/opt/blitz/skel/agent-rules.md`, mirrored by `AGENT_RULES_DOC`
in `core/agent-rules.ts` — one edit, two pinned copies, existing drift test)
is rewritten. Sketch:

```markdown
## Calling the platform API

The box has no credential CLI. You call the control plane over plain HTTP.
One local helper prints a valid bearer; the origin is on disk:

    CP=$(cat /var/lib/blitz/origin)
    curl -sS -H "Authorization: Bearer $(blitz-cred api-token)" "$CP/agent/credentials"

The full endpoint list with schemas and arguments is the API itself:

    GET /agent/api            # OpenAPI; always current — read it, then call what it lists

Scope a secret to the one command that needs it, and never print one:

    GH_TOKEN=$(curl -sS -X POST -H "Authorization: Bearer $(blitz-cred api-token)" \
      "$CP/agent/credentials/github/token" | jq -r .token) gh pr list

A 404 with a request_id means the credential is not connected or not granted
here: run `blitz connections open <provider>`, tell the user, and retry after
they connect it.
```

Because this file is served by the CP (`blitz-rules sync`), the instructions
update the moment the API does — no image release.

## 5. Org credentials — schema

```sql
CREATE TABLE org_credentials (
  id                        TEXT PRIMARY KEY,
  org_id                    TEXT NOT NULL REFERENCES orgs(id),
  name                      TEXT NOT NULL,   -- env var name: ^[A-Za-z][A-Za-z0-9_]{0,127}$
  comment                   TEXT,            -- what the key is FOR; survives rotation (tri-state semantics)
  ciphertext                TEXT NOT NULL,   -- base64(12-byte IV ‖ AES-256-GCM), AAD orgcred:<orgId>:<name>
  created_by_membership_id  TEXT NOT NULL REFERENCES memberships(id),
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  revoked_at                INTEGER
);
CREATE UNIQUE INDEX org_credentials_live
  ON org_credentials(org_id, name) WHERE revoked_at IS NULL;
CREATE INDEX org_credentials_org ON org_credentials(org_id, created_at);

CREATE TABLE org_credential_grants (
  id                        TEXT PRIMARY KEY,
  credential_id             TEXT NOT NULL REFERENCES org_credentials(id),
  subject_kind              TEXT NOT NULL CHECK (subject_kind IN ('org','workspace','membership')),
  subject_id                TEXT,            -- NULL for 'org'; workspaces.id / memberships.id otherwise
  access                    TEXT NOT NULL CHECK (access IN ('read','write')),
  created_by_membership_id  TEXT NOT NULL REFERENCES memberships(id),
  created_at                INTEGER NOT NULL
);
CREATE UNIQUE INDEX org_credential_grants_subject
  ON org_credential_grants(credential_id, subject_kind, coalesce(subject_id, ''));
```

The same migration drops `workspace_credentials` (§3).

Notes.

- **No `label` column.** `comment` is the one human-facing annotation; the
  dotenv importer writes nothing else.
- Grant rows hard-delete on revoke (ACL state, not audit — audit lives in
  `credential_events`). The credential row soft-revokes (rotation history).
- `subject_kind` is TEXT-open: `'team'` slots in later without a migration.
  Today "the whole eng team" is `subject_kind='org'` or a multi-select of
  memberships.
- Subjects validate at write time against the same org; membership subjects
  must be `active`. A membership that leaves the org fails resolution at
  read time regardless (the janitor prune is deferred, §10).
- Caps: value ≤ 8 KiB, comment ≤ 256, ≤ 200 live credentials per org,
  ≤ 100 grants per credential.

## 6. Authorization and resolution

One access function:

```
orgCredentialAccess(cred, {workspaceId?, membershipId?, orgRole}):
  write ← orgRole === 'admin'
        ∨ ∃ grant(subject covers caller, access='write')
  read  ← write
        ∨ ∃ grant(subject_kind='org')                          with access ∈ {read,write}
        ∨ ∃ grant(subject_kind='workspace',  subject_id=workspaceId)
        ∨ ∃ grant(subject_kind='membership', subject_id=membershipId)
```

- **Org admins read and write everything.** Implicit, both in the UI and on
  machine reads. No self-granting ceremony.
- **Create**: any active org member; the creator's membership automatically
  receives a `write` grant in the same transaction.
- **Rotate / revoke / edit grants**: `write`.
- **Machine read (`POST /agent/credentials/:name/token`)**: `read`,
  evaluated against the machine's `(workspace_id, membership_id)` from
  `boxCaller`. A workspace grant serves every member machine in that
  workspace; a membership grant follows the person onto any of their
  machines in the org.
- **Read requires a resolved active membership.** A machine whose member
  left the org (`membershipId: null`, `oauth.ts:304`) gets nothing.

Resolution for `POST /agent/credentials/:name/token`:

1. org `connections` row named `<name>` → personal-plane mint (unchanged,
   `mint.ts`);
2. live `org_credentials` row where `orgCredentialAccess(...).read`;
3. else file the request, `404 {error, request_id}`.

Every org-credential read writes a `credential_events` row with
`lease_id NULL` and detail `{org_credential, credential_id, box_id,
workspace_id, acting_principal}` (the `recordWorkspaceCredentialUse` idiom).
Grant add/remove are recorded as `approved`/`revoked` events with a
discriminating `detail.kind`.

## 6a. Unifying the connections tab's org secrets (decided 2026-09-02)

The connections subsystem holds a second, older org-secret slot: a
`connections` row can carry a sealed org root (`root_ciphertext`,
`registry.ts:385-415`), gated by `usable_by` and surfaced as the
`orgCredential: true` badge — an org-shared static wearing provider
clothes. That overlaps the new plane. Proposed split:

- **Org credentials own every org-shared static.** Delete
  `connections.root_ciphertext`, `usable_by`, the `legacyRootMint` path
  (`mint.ts:293,424`), and the `orgCredential` wire flag. An org-shared
  Linear key is an org credential named `LINEAR_API_KEY`, granted like any
  other.
- **Connections keep what is genuinely provider-shaped**: the catalog
  (env names, header shapes, proxy custody, OAuth descriptors), per-user
  OAuth/PAT grants (`user_oauth_grants` — personal identity with refresh
  machinery and vendor attribution; a different animal from a shared
  static), the GitHub app integration, and the workspace manifest
  enablement for those personal grants.
- Precedence stays personal-first: a provider name resolves the member's own
  grant; env-var names resolve org credentials. The two alphabets barely
  overlap in practice; where they collide, personal wins, as today.
- The admin "org root" form in the connections panel retires; its use case
  moves to the org Credentials panel.

## 7. Session-plane routes (webapp)

All under `requireMembershipPrincipal`:

```text
GET    /orgs/:id/credentials                 list visible; {credentials: OrgCredentialView[]}
PUT    /orgs/:id/credentials                 create or rotate; {name, value, comment?, grants?[]}
DELETE /orgs/:id/credentials/:name           soft revoke (write)
PUT    /orgs/:id/credentials/:name/grants    replace the grant set atomically (write)
POST   /orgs/:id/credentials/dotenv          org-level import; same parser
```

Wire types (packages/schema, every field required per wire-drift policy):

```ts
interface OrgCredentialGrantView {
  subjectKind: 'org' | 'workspace' | 'membership';
  subjectId: string | null;         // null iff subjectKind === 'org'
  access: 'read' | 'write';
}
interface OrgCredentialView {
  id: string;
  name: string;
  comment: string | null;
  createdByMembershipId: string;
  createdAt: number;
  updatedAt: number;
  grants: OrgCredentialGrantView[]; // full set for writers/admins; [] for plain readers
}
```

Visibility (names/comments, never values): grant-holders see the credentials
they can read; org admins see all.

## 7a. Agent-driven grant operations — propose, approve, apply

Agents may perform every grant-modifying operation on behalf of the user —
but **no grant change applies without a human approval**, and what applies
is what the human approves.

### One intent form

The agent proposes an explicit change list — no server-side bulk sugar; an
agent that wants "copy workspace A's grants to B" lists A's grants through
the API and computes the changes itself:

```text
{changes: [{name, action: 'add'|'remove', subjectKind, subjectId, access}],
 reason: string}
```

Proposal-time validation: every change must be within the acting member's
own authority (`write` on that credential); anything past it fails the whole
proposal with a 403 naming the offending changes — the agent narrows and
retries.

### Proposals live in memory — no row, no migration

```ts
interface GrantProposal {
  id: string;
  orgId: string;
  machineId: string;                // which machine asked
  membershipId: string;             // the acting member; the approver
  reason: string | null;            // shown verbatim in the dialog
  proposed: GrantChange[];
  applied: GrantChange[] | null;    // what actually went through
  state: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: number;
}
```

Held in an in-memory store on the CP runtime, TTL ~1 h. Nothing is
persisted: the durable record of an approval is the grant rows it writes and
their `credential_events`. A worker recycle can drop a pending proposal —
the poll returns `expired` and the agent proposes again.

### Routes

```text
POST /agent/credentials/grant-proposals    {changes[], reason} → {id, state:'pending'}
GET  /agent/grant-proposals/:id            poll → {state, applied[]?}
GET  /orgs/:id/grant-proposals?state=pending    the approval feed (webapp poll)
POST /orgs/:id/grant-proposals/:pid/resolve     {approve: bool, changes[]}
```

Resolve rules:

- The approver is the acting member or an org admin. The submitted changes
  pass the **same write-authority checks as any grant write** — no special
  narrowing rule; the dialog constrains editing, the server checks
  authority.
- Every change is revalidated at apply time (credential revoked meanwhile →
  no-op, reported in `applied`); survivors apply in one transaction, one
  `credential_events` row per change.
- The agent's poll returns `applied` — which may differ from `proposed` —
  and the rules teach the agent to continue from `applied`. Deny resolves
  the poll with `state:'denied'` and no changes.

### What the rules doc gains

Served fresh from the CP, so it updates with the API. The addition,
verbatim:

```markdown
## Sharing a credential (grant changes need a human)

You may propose grant changes — sharing a credential with a workspace or an
org member, or revoking a grant — but nothing applies until the user
approves it in a panel that shows your proposal as an editable diff.

    curl -sS -X POST -H "Authorization: Bearer $(blitz-cred api-token)" \
      "$CP/agent/credentials/grant-proposals" \
      --data '{"changes":[...], "reason":"one sentence; the user reads this"}'

Change shapes are in GET /agent/api. A 403 names changes past your user's
own authority — narrow and retry.

Tell the user a proposal is waiting for them, then poll:

    GET /agent/grant-proposals/<id>        # until state leaves "pending"

Continue from the "applied" list, never from what you asked for — the user
can edit or skip any part of your proposal before approving. "denied" and
"expired" mean no grants changed; re-propose only with a narrower ask or a
better reason.
```

### The approval dialog

Canonical reference: **`plans/mockups/grant-approval.html`** (interactive).
The spec the implementation must keep:

- **One merged list, "Grants after approval,"** only the affected
  credentials. Per credential: the key name as a plain section label
  (outside any card) with its comment on the line below, then one row per
  grant — the full resulting grant set in a single column. Every grant
  receiver carries an explicit kind tag (`workspace` / `member` / `org`,
  the machine-chip pill idiom) — kind is never conveyed by text colour
  alone.
- **Kept grants render plainly; changes are inline diff rows**: additions
  green with `+`, removals red with `−`, sitting where the grant sits.
- **Every diff row is editable**: additions carry a read/write toggle and a
  skip (✕); removals carry a skip ("keep this grant"). Skipped rows fade to
  an outlined no-op with an undo (↺); "Restore proposal" reverts everything.
- **Redundant additions get an inline hint** (e.g. "covered by org-wide
  read") rather than being silently dropped.
- **The request is an explicit card under the title**: agent glyph, which
  agent, which session, which workspace, and the agent's stated reason
  verbatim inside the card.
- **The approve button is the receipt**: live count, `(edited)` marker when
  the set differs from the proposal, disabled at zero. The resolved state
  says what was applied and that the agent has been told.
- **Close is neither approve nor reject**: a round close button top right
  (the workspace-details-header idiom) leaves the proposal `pending`,
  reopenable from the requests feed until it expires. Only Reject sends the
  agent a denial.
- **Styling is the settings-surface canon**: the workspace-details-dialog
  frame (`--paper`, `--rule`, `--r-card`, `--lift`), `cfg-` headings
  (sentence case, never all-caps), every colour a `tokens.css` token — diff
  tints resolve from `--ansi-green` / `--ansi-red`, so it holds up in light
  theme too.

## 8. Contracts and tests

- **Retired**: connection pull v1, credential list v1, credential import v1 —
  corpora deleted, contract-table rows moved to the retired section with the
  date. The routes are deleted too; there is no shim to pin.
- **New contract**: the generated agent API doc ↔ the CP router — pinned by
  the bidirectional route-coverage test and the single doc-conformance test
  (§4).
- New CP tests: `org-credentials.test.ts` (store, access function, session
  routes, the membership-null refusal), `agent-api.test.ts` (the `/agent/*`
  routes end to end, both tiers through one pull), `grant-proposals.test.ts`
  (propose → resolve-with-edits → applied; deny; expiry).
- Agent-rules fixtures update with the rewritten sections (existing
  conformance + drift tests carry it).
- Wire-drift coverage moves with the `WorkspaceView.credentials` deletion in
  the same commit.

## 9. UI

- **Org settings → Credentials panel** (new, beside Connections): list with
  name / comment / created-by / grant chips; add (name, value, comment,
  grant picker); rotate (write-only value field); grants editor — subjects
  picker over workspaces and active members, org-wide toggle, read/write per
  row. Follows the `cfg-` settings-surface canon.
- **Workspace details → Credentials tab** becomes a filtered view: org
  credentials readable in this workspace (via a workspace grant, an org-wide
  grant, or the viewer's own membership grant), with add/rotate opening the
  same org-level forms. No local store, no promote, no shadow states.
- **Grant-approval dialog** (§7a): pops when a pending proposal targets the
  signed-in member; mock at `plans/mockups/grant-approval.html`.
- The connect-inbox flow is untouched.

## 10. Build order

1. **Delete the box wire and the workspace store; stand up the agent API;
   cycle the images.** Remove the five `blitz-cred` credential verbs + Go
   wire internals; delete the three corpora, the legacy `/workspaces/self/*`
   credential routes, `pull-wire.ts`, and the whole workspace credential
   store (§3) — table, core module, session routes, wire fields, dialog
   section; add `blitz-cred api-token`; reimplement `git-helper`; add the
   `/agent/*` credential routes; the doc generator + both gates; rewrite the
   rules sections; rebake canary, cut the prod tag, roll the fleet.
   Gate: on the new image, an agent following only the served rules lists,
   reads, and stores an org credential with curl + `api-token`; plain
   `git push` still mints through the new helper; the route-coverage test
   fails on an undocumented `/agent/*` route; grep proves no
   `workspace_credentials` reference and no `/workspaces/self/credentials`
   handler remains.
2. **Org credentials: store + grants + resolution.** Migration (two tables
   in, one dropped), `core/org-credentials.ts`, tier 2 in the `/agent/*`
   resolution, events, `scope`/`writable` on the list.
   Gate: a value stored at org scope with a workspace grant serves
   `POST /agent/credentials/:name/token` on machines in two different
   workspaces; rotating it once changes both on the next call; an ungranted
   workspace gets the 404 + request; a membership grant follows a member
   into a workspace with no grant; a machine with a dangling membership gets
   nothing; an org admin's machine reads everything.
3. **Session routes.** The five §7 routes, wire types, schema export,
   wire-drift coverage.
4. **Grant proposals + approval loop.** The in-memory store, the four §7a
   routes (in the generated doc from day one), the approval dialog built to
   the mock, the §7a rules addition.
   Gate: an agent's proposal shows in the dialog, the user skips one row and
   downgrades one write to read, the agent's poll returns exactly the edited
   set; a denied proposal changes nothing; a proposal past the acting
   member's authority 403s naming the offenders.
5. **Webapp.** Org Credentials panel + the workspace-tab filtered view.
6. **Connections unification (§6a).** Delete `root_ciphertext` /
   `usable_by` / `legacyRootMint` / the `orgCredential` flag; retire the
   admin org-root form. Existing org roots are not migrated (same reasoning
   as the workspace store: paste once into the org Credentials panel).
7. **Later / deferred**: team subjects, grant-pruning janitor, widening the
   `credential_events` CHECK.

## 11. Alternatives considered

- **Keep the CLI, version the wire.** Rejected: the CLI is an API wrapper
  whose compiled schemas make every API change a box release.
- **Zero box code (pure curl).** Almost achieved: the 15-min bearer with
  single-use, flock-serialized refresh needs one local primitive.
  `api-token` is the floor — it embeds no endpoint and no shape. A wrapper
  CLI above it (`blitz api ...`) was considered and cut: agents read the
  OpenAPI doc and drive curl themselves.
- **A local gateway proxy that injects auth.** Workable, but a resident
  process and a port where a subshell substitution suffices.
- **Keep workspace credentials as an override tier.** Rejected by decision:
  it bought three-tier resolution, shadowing rules, shadow UI, and a promote
  flow for a store that was days old. Org-only, delete the rest.
- **Migrate workspace values instead of deleting them.** Rejected: the AAD
  reseal cannot run in SQL, same-name collisions need a human, and the
  org-level dotenv import re-creates a workspace's keys in one paste.
- **Generalize the `connections` plane instead of a new table.** Rejected:
  provider slugs are not env-var names; `usable_by` has no workspace/org
  subjects and no read/write split. The unification runs the other way —
  connections *shed* their org-secret slot (§6a).

## 12. Decisions (all settled 2026-09-02 — none open)

1. **Create gate: any active member.** The creator's membership gets a
   `write` grant in the same transaction.
2. **ACL edit gate: write-holders + org admins.** The person who owns a key
   manages its audience; admins can always step in.
3. **`subject_kind='org'` may carry `write`**, with a loud UI warning
   ("anyone in the org can rotate this").
4. Org-only static plane, no value migration (§3).
5. Connections shed their org-root slot, no root migration (§6a).
6. Org admins implicitly read and write everything (§6).
7. The OpenAPI doc is generated from schema types, never hand-written (§4).
