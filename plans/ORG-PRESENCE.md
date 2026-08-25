# Organization presence and collaboration safety

Status: Phases 1-2 implemented on `codex/org-presence-plan`; Phases 3-5 are not
shipped

## Goal

Let an organization member answer three questions without guessing:

1. Who is online in this organization?
2. Which workspace and Blitz session is each person viewing?
3. Is another person likely to conflict with an action I am about to take?

The intended experience is the awareness layer people expect from Figma or
Google Drive: an organization-level people list, workspace-level avatars, and
session-level indicators. Presence must be useful without leaking a workspace,
session, command, prompt, or file to someone who is not authorized to see it.

Presence is not itself concurrency control. This plan pairs visibility with the
state and terminal changes needed to prevent the conflicts that the UI warns
about.

## Current reality

The current product already has the necessary identity and navigation context,
but it does not publish presence:

- The control plane authenticates an organization membership and mints short-
  lived workspace tickets containing the user, membership, workspace, and role.
- The web app knows the active workspace, open main and side tabs, focused pane,
  native-chat session ID, file path, preview, and terminal tab ID.
- The gateway and actor know who opened a socket, but only inside one workspace.
  They cannot answer an organization-wide presence query and do not see Drive,
  settings, or other workspaces.

There are also real collision risks that an avatar alone would not fix:

- `core/webapp-state.ts` stores a full workspace UI document per principal, then
  returns the newest document from any principal. A 150 ms debounced full-
  document save means an idle or stale browser can replace another member's tab
  list, active tab, split layout, or drawer state.
- File editing already uses a strong ETag check and offers Reload or Overwrite
  when the file changed. This is real optimistic concurrency protection.
- Native-chat prompts are serialized by the actor and journaled with identity.
  Two people can contribute safely, although their prompts run in queue order.
- Two editors can currently type into the same terminal/tmux session. There is
  no single-driver lease, handoff, or server-enforced read-only attachment.
- Arbitrary preview applications have their own data models. Blitz cannot infer
  or guarantee conflict safety inside them.

## Product contract

### Presence states

- **Active:** at least one visible, focused client reported within 35 seconds.
- **Online:** at least one visible client reported within 35 seconds, but none
  is focused.
- **Away:** a client is still reporting while hidden/unfocused, or the last
  report is recent enough to avoid flicker but older than the active window.
- **Offline:** no non-expired connection remains. Offline rows are not retained
  as a user-visible activity history.

Server time, not the browser clock, determines expiry. A browser disconnect is
best-effort; the lease TTL is the source of truth.

### Visible activity

A connection may report the organization surface it is viewing and, when in a
workspace, up to two visible surfaces: main and side. Each surface contains only
an allowlisted descriptor:

- normalized terminal or native-chat session ID and display title;
- file tab with an opaque client surface ID and basename-only label;
- preview with an opaque client surface ID and safe label;
- panel name; or
- workspace shell with no selected surface.

The focused surface is marked separately. Prompt text, terminal commands, file
contents, full file paths, environment variables, URLs containing credentials,
and actor transcripts never enter presence storage.

### Visibility rules

- Every active organization member may see which other organization members are
  online.
- Exact workspace and session activity is returned only when the observer still
  has access to that workspace.
- Otherwise the observer sees **In another workspace**, with no workspace name,
  ID, session title, or deep link.
- The server derives member display data and authorization. It never trusts a
  name, avatar, organization ID, role, or workspace access claim from the client.
- Revoking organization membership or workspace access takes effect on the next
  heartbeat/snapshot and invalidates the associated presence detail.
- Presence APIs are membership-authenticated and same-origin. Workspace tickets
  remain for workspace transport; they are not an organization presence token.

### Multiple browsers and devices

Each browser tab gets a random `clientId` stored in `sessionStorage`. The server
stores connections separately and the response aggregates them by membership.
A member may therefore appear in multiple authorized workspaces or sessions.
The most recently focused connection is the primary activity shown in compact
UI; the popover shows the rest without duplicating the person count.

## Target architecture

### 1. Separate shared sessions from personal view state

Before presence ships broadly, replace the current newest-writer-wins workspace
document with two concepts:

**Shared session registry**

- Stable rows for collaborative terminal and native-chat sessions.
- Explicit create, rename, and archive operations with a monotonic revision.
- Server-generated string IDs; do not use a browser's incrementing tab number as
  a durable cross-user identity.
- Allowlisted coordination metadata only. Agent transcripts and terminal output
  remain in the box/actor, not D1.

**Per-member view document**

- Active workspace, open file/preview/panel tabs, active main/side surface,
  drawer state, widths, ordering, and other layout preferences.
- Keyed by membership and workspace, with revision/ETag protection so two tabs
  owned by the same member cannot silently replace a newer view.
- References shared session IDs where a terminal or native-chat session is open.

The control plane exposes operation-oriented shared-session endpoints rather
than accepting a full shared tab array. Existing V1 documents are read during a
compatibility window, normalized once, and never allowed to overwrite V2 rows.

Suggested tables:

```text
workspace_sessions
  id, workspace_id, kind, title, created_by_membership_id,
  revision, created_at, updated_at, archived_at, metadata_json

workspace_member_views
  workspace_id, membership_id, revision, doc, updated_at
```

Database uniqueness and foreign keys must prevent a session from being attached
to a different workspace. Any session lookup must join through current workspace
authorization.

### 2. Organization presence service

V1 uses short D1 leases and polling. This works in both the self-hosted Worker
and the generated blitz.dev target without adding a Durable Object binding or a
new always-on service.

Suggested table:

```text
presence_connections
  membership_id, client_id, workspace_id, view_json,
  focused, visible, last_seen_at, created_at

primary key (membership_id, client_id)
index (last_seen_at)
index (workspace_id, last_seen_at)
```

Organization ID and principal identity are derived through the membership row.
If denormalizing organization ID is needed for query performance, it must be
server-populated and covered by a consistency test. `view_json` is parsed with a
strict schema and size limits; it is not an open-ended telemetry payload.

Routes:

```text
PUT    /presence/connections/:clientId
DELETE /presence/connections/:clientId
GET    /presence
```

`PUT` upserts only the caller's connection after validating current membership,
workspace access, and every referenced normalized session. `DELETE` can delete
only the caller's connection. `GET` returns a server-redacted organization
snapshot and never returns raw connection rows.

Client behavior:

- Report immediately after sign-in and on workspace, visible-surface, focus, or
  visibility changes.
- Send a heartbeat every 15 seconds while the document is open.
- Poll the snapshot every 5 seconds while visible and every 30 seconds while
  hidden. Refresh immediately after a local navigation change.
- Attempt `sendBeacon`/keepalive deletion on page hide or unload, but rely on the
  35-second server expiry.
- Apply jitter and backoff after failures. Presence failure never blocks normal
  workspace use.
- Sweep expired rows lazily on bounded API traffic, consistent with the current
  two-target control-plane model. A scheduled sweep may supplement self-hosted
  deployments but cannot be required for correctness.

The shared schema belongs in `packages/schema` because the browser and control
plane both consume it. The control plane's vendored wire mirror and drift checks
must be updated in the same change.

### 3. User experience

Organization shell:

- Show a compact avatar stack in the persistent header.
- Clicking opens a keyboard-accessible popover grouped into **Here**, **Other
  workspaces**, and **Online**.
- A permitted activity is a deep link to its workspace/session. Redacted
  activity is plain text, never a disabled link that embeds hidden identifiers.

Workspace list:

- Show avatars next to each workspace for members whose visible connection is in
  that workspace.
- Keep the list stable; avatars do not reorder workspaces on every heartbeat.

Workspace sessions:

- Show avatars on terminal and native-chat tabs when other members have that
  normalized session visible.
- Show a lighter file/preview indicator scoped to the reporting client surface.
  Two tabs with the same filename are not assumed to be the same file unless
  their authorized resource identity matches.
- Announce joins/leaves accessibly without repeatedly stealing focus or flooding
  screen readers during heartbeat refreshes.

Presence is advisory. Conflict-specific copy must describe the actual guard:
**Brandon is viewing this file** is different from **This file changed on disk**,
and **Alex is driving this terminal** is different from **Alex has this terminal
open**.

### 4. Conflict controls

**Files**

Keep the existing ETag compare-before-save behavior. Add viewers/editors near the
file tab and include member context in the conflict surface when available, but
do not replace the ETag with presence. A disconnected client can still modify a
file through another route.

**Native chat**

Keep actor-side prompt serialization and identity attribution. Show participants
and an explicit queued/sending state. Do not hard-lock chat to one writer unless
product evidence shows that serialized contributions are confusing.

**Terminal**

Add a server-authoritative driver lease per terminal session:

- At most one membership owns the write lease at a time.
- Lease renewal is tied to an authorized live terminal connection, not merely a
  browser presence heartbeat.
- Other members attach read-only even if their workspace role normally permits
  edits.
- Request, approve, decline, release, disconnect, expiry, and admin takeover are
  explicit audited transitions.
- The gateway/box enforces read-only input. Hiding the input field in React is
  not a security or conflict boundary.
- An editor ticket minted for a read-only terminal attachment must be scoped so
  it cannot be reused to gain write access to another session or surface.
- Older box images that cannot enforce a secondary read-only attachment must
  reject that attachment rather than allow two writers.

Terminal output remains shared and ephemeral according to existing tmux/session
behavior. This phase does not add collaborative cursor positions or per-command
version control.

## Phased delivery

Each phase has an independently testable exit condition. Phase 2 may be developed
behind a feature flag while Phase 1 lands, but the user-facing rollout follows
the dependency order below.

### Phase 0 — Contract and regression harness

1. Add shared presence request/response fixtures and parser tests.
2. Add a two-member browser regression proving the current V1 state collision.
3. Add authorization tests for same-org/different-workspace redaction.
4. Record baseline D1 query count and snapshot payload size for a representative
   organization so later phases have an explicit budget.

Exit: the desired state, redaction behavior, and known collision are executable
tests rather than plan-only prose.

### Phase 1 — Shared-session and personal-view V2

Implementation status: complete on `codex/org-presence-plan`.

1. Add `workspace_sessions` and `workspace_member_views` migrations.
2. Add CRUD/operation routes for shared sessions and revision-checked personal
   view reads/writes.
3. Update web app storage and lifecycle hooks to consume V2.
4. Dual-read V2 then V1; migrate a V1 document on first authorized write.
5. Stop selecting the newest UI document across principals.
6. Preserve stable terminal/native-chat session IDs across reloads and users.
7. Add cleanup rules for archived sessions and removed memberships.

Exit: two members can independently navigate, split panes, and open local tabs
without replacing each other's UI; both can intentionally open the same shared
terminal or native-chat session.

### Phase 2 — Presence backend and client lifecycle

Implementation status: complete on `codex/org-presence-plan`.

1. Add the presence migration, strict shared schema, and control-plane routes.
2. Add membership/workspace/session authorization and response redaction.
3. Add the browser connection ID, heartbeat, visibility/focus events, polling,
   aggregation, backoff, and unload cleanup.
4. Include `/presence` and new core modules in self-hosted and blitz.dev build
   manifests, route-prefix tests, schema table lists, and import-count gates.
5. Add lazy expiry and bounded query/payload limits.

Exit: two authenticated browsers see correct active/online/away transitions,
multiple tabs aggregate into one member, expired clients disappear within the
documented window, and unauthorized activity is indistinguishable beyond **In
another workspace**.

### Phase 3 — Presence UI

1. Add the organization avatar stack and presence popover.
2. Add workspace-row avatars.
3. Add authorized session-tab/file/preview presence indicators.
4. Add deep links that open the correct shared session without overwriting the
   observer's personal view.
5. Cover narrow screens, empty/large organizations, keyboard navigation,
   screen-reader announcements, and reconnect/flicker behavior.

Exit: a member can tell who is online, who is in the current workspace/session,
and safely navigate to an authorized collaborator from desktop or mobile.

### Phase 4 — Conflict-safe collaboration

1. Surface file presence alongside the existing ETag conflict protection.
2. Show native-chat participant and queued-contribution states.
3. Implement terminal driver leases in the control plane and enforce them at the
   gateway/box boundary.
4. Add handoff/takeover UI and audit events.
5. Test lost connections, stale leases, reconnect races, membership revocation,
   role downgrade, box restart, and old-image behavior.

Exit: the UI never claims a conflict is prevented unless the file ETag, actor
queue, or terminal driver enforcement actually provides that guarantee.

### Phase 5 — Push and scale only when measured

Keep D1 polling while it meets the product budget. If measured latency, read
volume, or organization size makes it inadequate, place the presence service
behind a storage/transport interface and add an organization-scoped Durable
Object/WebSocket implementation.

The push upgrade must preserve the same schema, authorization/redaction logic,
TTL semantics, and polling fallback. It is an optimization, not a prerequisite
for correctness and not a reason to fork the self-hosted and managed products.

Exit: a documented load test demonstrates why push is needed and both deployment
targets either support it or degrade to the tested polling contract.

## Implementation map

Expected control-plane changes:

- `packages/control-plane/migrations/0029_*.sql` and following migrations
- `packages/control-plane/core/presence.ts`
- `packages/control-plane/core/workspace-sessions.ts`
- `packages/control-plane/core/webapp-state.ts` during V1-to-V2 compatibility
- `packages/control-plane/core/app.ts` and `core/index.ts`
- `packages/control-plane/core/wire.ts` and drift tests
- `packages/control-plane/scripts/lib/worker-source.mjs`
- managed schema/emitter/import-closure and route-prefix tests

Expected shared/browser changes:

- `packages/schema/src/presence.ts` and cross-runtime fixtures
- `packages/webapp/src/api.ts`
- a focused `use-org-presence.ts` lifecycle hook
- workspace persistence/storage V2
- `CloudApp`, `DriveRail`, `WebAppHeader`, and tab components
- browser component, persistence, and two-member integration tests

Expected enforcement changes in Phase 4 only:

- workspace ticket minting/scoping in the control plane
- terminal connection authorization in `packages/box/gateway`
- actor participant/queue presentation where needed
- Go and TypeScript fixtures/tests updated together for any cross-runtime ticket
  or lease contract

Exact filenames may move during implementation, but the ownership boundaries do
not: organization presence belongs in the control plane, terminal write safety
belongs at the gateway/box boundary, and personal navigation belongs to the
browser member view.

## Test and rollout matrix

Minimum automated scenarios:

- two members in the same organization and workspace/session;
- same organization without access to the active workspace;
- different organizations;
- viewer, editor, workspace admin, and organization admin roles;
- two tabs and two devices for one membership;
- split main/side surfaces and focus changes;
- hidden tab, offline laptop, abrupt close, reconnect, and clock skew;
- membership removal and workspace-role downgrade during an active connection;
- stale/malformed/oversized surface descriptors;
- concurrent personal-view revisions and shared-session operations;
- file ETag conflict, chat queue ordering, terminal lease race and takeover;
- self-hosted Worker and generated blitz.dev artifact parity.

Rollout sequence:

1. Ship migrations and V2 compatibility code dark.
2. Migrate personal view state with metrics for V1 fallback and rejected writes.
3. Enable presence for internal organizations, then a small organization cohort.
4. Monitor D1 writes/reads, response bytes, heartbeat errors, expiry delay, and
   redaction failures. Never log raw view payloads.
5. Enable presence UI broadly.
6. Enable terminal driver enforcement only after the compatible box image is
   registered and workspace capability negotiation is tested.
7. Remove V1 state reads only after the fallback metric is zero for the agreed
   retention window and rollback no longer requires them.

Repository gates remain the documented root gates:

```bash
npm run typecheck
npm run lint:gate
npm test
```

Run focused web app, control-plane, schema fixture, and Go gateway tests during
each phase rather than waiting for the final gate.

## Explicit non-goals and limits

- Presence cannot prove that a person is paying attention; it reports recent
  browser activity.
- Direct SSH activity cannot be attributed to an organization member while SSH
  uses a shared guest/workspace identity. Solving that requires personal SSH
  credentials and a separate audit design.
- No character-level collaborative file editing, CRDT, shared cursor, or live
  selection model is included. File safety remains optimistic ETag concurrency.
- No prompt, command, terminal output, file content, or detailed historical
  surveillance is stored in the presence service.
- Blitz cannot provide generic conflict control inside arbitrary preview apps.
- Presence does not broaden workspace access and is never an authorization
  shortcut.
- A green presence dot alone must never be presented as proof that writes are
  conflict-safe.

## Definition of done

The feature is complete when two invited organization members can see each
other's permitted workspace/session activity, independently navigate without
state loss, and understand the actual safety level of files, chats, and
terminals. Unauthorized observers receive only redacted organization-level
presence; stale clients expire; both deployment targets behave the same; and
every conflict-prevention claim is backed by server-side behavior and tests.
