# Lody session sharing v2: a design exploration

Org-wide shares, links, the session viewer, fork and move.

> **This is an exploration, not a decision record.** It exists to be argued
> with. Every claim about BlitzOS or Lody below was checked by reading the code
> on 2026-09-05 (tree `9d697a3f`, `vendor/lody` at its current pin), and every
> claim that still needs a live measurement is marked **MEASURE**. The
> recommendations are one defensible path; the "questions to mull" at the end
> of the long sections are the places where a different answer would produce
> a different design. `plans/LODY-SHARING.md` is v1 and is shipped dark; this
> document only describes what changes on top of it.

## 0. The ask, in one paragraph

Share any Lody session with anyone in the organization at read or write level,
with a Google-Docs-shaped dialog and links; let org admins read every session in
every workspace whether or not they hold a seat there; let a share pull a
non-member into the workspace as a guest who can reach only what was shared;
make scope changes and revocation instant; offer read-only public links; and
copy (fork) or move a session from one workspace to another so the members of
the target workspace can carry it on.

### 0.1 How to read this

- §1 lists what was read and what each source settled, so a reader can go
  back to the evidence rather than trust this summary.
- §2 and §3 are the measured starting point: what v1 built, and what Lody does
  and does not offer.
- §4 restates the asks as constraints and corrects the ones that collide with
  the measured system.
- §5 and §6 are the one architecture decision v2 cannot dodge, with §6 the long
  form of the recommended option.
- §7 to §14 are the mechanisms, each small enough to be replaced on its own.
- §15 to §17 are phases, open decisions, and what to send upstream.
- Appendix A holds the diagrams for every option side by side.

## 1. Reading list: the research this rests on

Everything below was read in full or in the sections named. Each row says what
it contributed, so a disagreement can be traced to its source.

### 1.1 BlitzOS design records (`plans/`, `docs/`)

| Source | What it settled here |
|---|---|
| `plans/LODY-SHARING.md` (v1, phases 6 and 7) | The whole shipped sharing design: `session_shares`, the ticket claim, the shared route prefix, the bridge ACL and its `meta` projection, one-box-at-a-time mounting, the `readOnly` seam patch, and the "proven / not proven" ledger. §6.1 measured the four vendor changes a multi-box renderer needs; §10.1 found that `meta` is plain JSON and therefore projectable; §10.5 recorded that the permission card is gated on presence. |
| `plans/LODY-SESSIONS.md` | §0 bias rule (vendor Lody's UI, no hybrids, cheap upstream merges); §0.1 the user-locked v1 sharing contract; §4 the sharing architecture sketch and its three corrections; §12 open questions; §13 the release order (bake, advertise, flip). |
| `plans/LODY-RUNTIME-DESIGN.md` §7–§11 | The vocabulary: the bridge, the four doors, protocol v7, the session document; the `window.ipc` seam and why `__LODY_LOCAL_BRIDGE__` exists; the per-phase "what is proven" convention this document copies. |
| `plans/LODY-V1-SCOPE.md` | What the vendored surface keeps, kills and hides; upstream's own "Share with team" and "Copy URL" rows are suppressed because "the host serves sharing itself". |
| `plans/LODY-WORKSPACE-KEEPALIVE.md` | Per-surface IPC clients replaced the single `window.ipc` read; the keep-alive pool (capacity two, keyed by daemon identity) is what makes switching between an owned and a shared surface warm. It is a browser-side keep-alive, not a box keep-alive. |
| `plans/LODY-DAEMON-FROM-TREE.md`, `docs/LODY-MERGE.md` | The daemon is built from `vendor/lody`; every vendor divergence is a numbered seam patch in `vendor/lody/BLITZ-PATCHES.md`; nothing merges upstream unattended. This is why v2 avoids daemon changes and names the two it would make as upstream PRs. |
| `docs/LODY-MODELS.md` | Model discovery is a passthrough from the agent CLI to the machine flock; the composer's selectors are `acpCapability` rows, which is why a grantee has no selectors until the flock is projected. |
| `plans/MEMBER-MACHINES.md` §1, §3 | One machine per (workspace, member); viewers hold none; the role matrix and the org admin's implicit workspace-admin reach; "Build 2: sessions as objects" was never built. |
| `plans/IDENTITY.md` | Tickets, the drain, and the invariant everything inherits: the browser never holds a box credential, so every byte to a box passes the control plane's grant check. |
| `vendor/lody/BLITZ-PATCHES.md` | The seven seam patches in force, their hunks and anchors; what a new vendor prop costs at merge time. |
| Fixture corpora: `packages/schema/fixtures/webapp-ticket/`, `lody-share-claim/`, `lody-data-plane/`, `machine-stats/` | The pinned shapes v2 extends (the claim, the bridge decisions, the frame framing) and the producer/consumer pattern a box-pushed report already follows. |

### 1.2 BlitzOS code read directly

`core/session-shares.ts`, `core/webapp-tickets.ts`, `core/workspaces.ts`
(`webApp`, `machineForRequest`, `machineForTarget`, `GET /workspaces`),
`core/workspace-access.ts`, `core/workspace-drain.ts`,
`migrations/0009_identity.sql`, `0041_member_machines.sql`,
`0045_session_shares.sql`, `box/gateway/main.go` (`serveLody`, the viewer
guards, `parseShareClaim`), `box/rootfs/usr/local/libexec/blitz-lody-bridge`
and `blitz-lody-projects`, `webapp/src/SessionShareDialog.tsx`,
`webapp/src/lody/shared-sessions.ts`, `use-shared-sessions.ts`,
`LodySessionsRegion.tsx`, `resolver.ts`, `shell/WorkspaceStrip.tsx`,
`api-adapter.ts`, `wrangler.toml.example` (bindings: D1, one R2 bucket, no
Durable Objects in use).

### 1.3 Lody sources read (`vendor/lody`)

| Area | Files | What they settled |
|---|---|---|
| Document model | `packages/shared/src/schema.ts` (session doc `:1088-1096`, `SessionMeta` `:766-922`, `getPendingUserTurnActivationId` `:923-948`), `index.ts:370-417` (room ids), `machine-flock.ts`, `workspace-flock.ts` | What a session is on the wire; no per-session ACL field anywhere; `WorkspaceDoc` is dead code. |
| Local data plane | `packages/shared/src/local-loro-data-plane.ts`, `local-loro-data-plane-server.ts`, `local-loro-transport.ts`, `node/local-ipc.ts` | Zero auth on the plane; peers are random UUIDs; presence is pushed to every connection; the ephemeral store is a stub in the renderer's local transport. |
| Cloud access | `packages/cloud-api/src/index.ts`, `packages/platform/src/{capabilities,provider,cloud-port,local}.ts`, `packages/shared/src/loro-streams-auth.ts`, `code-collab.ts:1858-1904`, `components/src/lib/session-sharing.ts`, `session-visibility.ts` | Sharing is per machine and per local project; cloud access is binary membership; one opaque per-workspace sync token; the local identity oracle allows one id. |
| Session operations | `apps/cli/src/session/session-fork-service.ts`, `session-dispatch-logic.ts:186-252`, `session-edit-and-resend-service.ts`, `lib/local-project-history-sync-service.ts`, `lib/machine-lifecycle.ts:123-181`, `components/src/hooks/use-session-actions.ts`, `providers/workspace-writer-impl.ts` | Dual authoring; fork is same-machine only; no move; the one capability-token pattern; native history import. |
| Presence and the rail | `packages/shared/src/presence.ts`, `apps/cli/src/lib/loro/presence.ts`, `components/src/atoms/presence.ts`, `components/sessions/session-list-rows.ts:175-230`, `sidebar-row-shared.tsx:34-155`, `session-tab-bar.tsx`, `lib/session-mention-drag.ts`, `lib/session-read-receipt.ts`, `hooks/use-workspace-badge.ts`, `sidebar-filter-popover.tsx` | What the rail's indicator, badges, tabs, mentions and filters actually read, and therefore what a Blitz-drawn shared row can and cannot reproduce. |
| Identity | `apps/cli/src/lib/cli-platform.ts:47-135`, `local-workspace-catalog.ts`, `session-access-policy.ts`, `session-user-resolver.ts`, `node/local-session-control.ts:437-465` | `local:<id>` and `lw_<id>`; the catalog schema; identity is client-supplied and structurally validated only. |
| Docs | `site-docs/content/docs/en/(features)/team.mdx`, `mention.mdx`, `public/_docs-assets/llms-full.txt` | Lody's own description of team features: machines private by default, only the owner shares, sessions on unshared machines do not sync to teammates. |

### 1.4 External

- Lody repository README (`github.com/LodyAI/Lody`): architecture, Loro and
  Flock, "moving toward full local-first", the cloud backend is not open.
- Loro sync protocol (`github.com/loro-dev/protocol`): rooms, the
  `SimpleServer` with an `authenticate` callback answering read, write or
  deny, `onLoadDocument`/`onSaveDocument` hooks, ephemeral state. This is what
  an M2 hub would speak.
- Loro ephemeral store docs (`loro.dev/docs/tutorial/ephemeral`): timestamped
  last-write-wins presence outside the document.

## 2. What v1 already gives us

| Piece | Where | State |
|---|---|---|
| Grant rows: one member → one member, `ro`/`rw`, inside one workspace | `migrations/0045_session_shares.sql`, `core/session-shares.ts` | shipped |
| Ticket `share` claim: `{target, scope: "sessions"\|"all", read[], write[]}`, 64-id cap | `core/webapp-tickets.ts:73-83`, gateway `main.go:217-240` | shipped, fixture-pinned |
| Routing a grantee to another member's box | `/workspaces/:id/shared/:membershipId/webapp/7445/…`, `core/workspaces.ts:882-996` | shipped |
| Relay ACL: room join/update verdicts, `meta` projection, RPC and project-door allowlists, `/control` refused, `/platform` narrowed | `box/rootfs/usr/local/libexec/blitz-lody-bridge` | shipped, fixture-pinned |
| Workspace admins and org admins hold implicit read-only on every session (`scope: "all"`) | `core/session-shares.ts:99-119` | shipped |
| Grantee surface: "Shared with you" rail, one box mounted at a time, `readOnly` vendor prop | `webapp/src/lody/use-shared-sessions.ts`, `SessionSurface.tsx`, seam patch 4 | shipped |
| Revocation: delete row, then `/admin/drain` the grantee's connections to that box when their last grant goes | `core/session-shares.ts:289-329`, `core/workspace-drain.ts` | shipped |
| Owner-side dialog (workspace members only, three levels) | `webapp/src/SessionShareDialog.tsx` | shipped |

Known v1 limits that v2 must lift, each already named in the tree:

- A grantee must be a member of the workspace (`core/session-shares.ts:235-240`).
- A level change never drains, so a downgrade from `rw` to `ro` leaves a live
  socket writable until the tab reconnects (`core/session-shares.ts:247-256`
  upserts and returns).
- `rw` is a co-driver, not an editor: title, archive, pin, agent config and
  `session/terminate` are withheld, and the composer has no model/effort/mode
  selectors because the machine flock is admin-only (v1 §10.2, §10.3).
- An org admin who is not a workspace member sees the workspace tile but gets
  409 on open, because the own-machine proxy finds no machine
  (`core/workspaces.ts:612-634`).
- A share on a stopped box is drawn but never mounts, with no way to wake it
  (`use-shared-sessions.ts:44-50`).
- A grantee's connection receives the owner's whole presence snapshot, granted
  sessions or not (§10.1 below).
- No links, no expiry, no fork across boxes, no move.

## 3. What Lody actually offers, measured

The premise "Lody has strong sharing and multiplayer fundamentals" is half
right, and it matters which half.

**What is there and is worth leaning on:**

- The dual-author model. Almost every session operation is a CRDT write with
  RPC as a latency fast path: prompting is a `history` push plus the
  `latestUserMsgId` dispatch pointer, cancelling is `lastCanceledTurn`,
  answering a permission request is a history-item write, renaming and pinning
  are doc-meta writes (`workspace-writer-impl.ts`, `use-session-actions.ts`).
  A co-driver therefore needs doc write plus a handful of RPCs and nothing
  else, which is why v1 worked without touching the daemon.
- Multi-writer serialization exists: the `mq` movable list with an `isEditing`
  five-minute lease (`apps/cli/src/lib/loro/doc.ts:2952-2979`), the
  `latestUserMsgId`/`lastHandledUserMsgId`/`processingUserMsgId` triple with one
  authority function (`schema.ts:923-948`), and `session/steer` fenced by
  `expectedTurnId`.
- Attribution fields exist: `history[].userId` and `SessionMeta.userId`
  (`schema.ts:565`, `:780`), plus `transferSessionOwner`.
- Same-machine fork is complete: `session/fork` with `targetContext`
  `shared` or `new-worktree`, forking at a finished assistant turn, with a
  durable operation record for crash recovery
  (`session-fork-service.ts`, `message-schemas.ts:768-847`).
- A presence vocabulary exists, including "user U is viewing session S"
  (`presence.ts:26-42`).
- A native-history import path exists: `origin: 'external-acp'` turns a
  coding CLI's own on-disk transcript into a Lody session
  (`local-project-history-sync-service.ts`).
- A capability-token precedent exists for daemon-verified requests:
  `verifyMachineLifecycleRequest` (`machine-lifecycle.ts:123-181`).

**What is not there, anywhere in the open tree:**

- No per-session ACL, field, or API. Cloud sharing is a per-machine and
  per-local-project "share with team" flag; session visibility is derived from
  those (`session-sharing.ts:120-176`), and only the machine owner may flip it.
- No read-only. The renderer has no viewer concept (v1 added the `readOnly`
  prop as seam patch 4). The local data plane has zero auth: peers are random
  UUIDs, the only server check is workspace match, and security is the 0700
  run directory (`node/local-ipc.ts:212-285`). Cloud sync uses one opaque
  per-workspace token for every room (`loro-streams-auth.ts:4-22`).
- No cross-machine session operations. Execution is pinned to
  `SessionMeta.machineId`; fork inherits the machine and refuses another one
  (`session-fork-service.ts:438-445`, `:680`); there is no move.
- No share links, no public access, no expiry. "Share and copy link" is the
  session route URL after flipping the machine flag.
- Presence in local mode is a one-way CLI → renderer push; the ephemeral store
  is a stub (`local-loro-transport.ts:259-272`).
- Identity is trusted from the client everywhere except two machine-lifecycle
  RPCs; the local identity oracle allows exactly one `local:` id
  (`platform/src/local.ts:95-112`).

**Conclusion.** Lody gives us a multiplayer-ready *document model*. The
*authorization plane* is ours, and v1 already put it in the right place: a
relay in front of the daemon, because a read-only CRDT peer is exactly "a peer
whose writes the relay does not apply". Nothing in Lody's cloud can be reused
for that plane, since it is closed and coarser than what we need. v2 keeps the
daemon unpatched for everything except attribution and presence (§14), and
contributes those two upstream (§17).

## 4. Constraint corrections

The asks are sound; several collide with the measured shape of the system.
Each collision below comes with the constraint I propose instead.

**C1. "Everyone in workspace B can continue the session" versus one machine
per session.** A session executes on exactly one box, and BlitzOS boxes are per
member. *Proposed:* a fork or move lands on the acting member's own box in the
target workspace (or, for a workspace admin, a named member's box) and is
auto-shared with that workspace at read-write. "Everyone continues" then means
"everyone is an editor of a session that has a home", which is what continuing
means on this platform.

**C2. "Leverage Lody's sharing" versus Lody having no ACL.** *Proposed:* leverage
the document model and the fork service; own the grant, claim, relay and audit
layers (as v1 does); send the two daemon-touching pieces upstream.

**C3. "Read-only public link" versus "the browser never reaches a box without a
control-plane grant" and "a box is a member's development machine".** A public
link that proxies anonymous traffic to a member's box is a denial-of-service
surface, needs the box up, and breaks the ticket invariant. *Proposed:* public
links serve a control-plane-held snapshot of the transcript, never the box. Org
links serve the live surface, because org visitors are authenticated members.

**C4. "Write access has the owner's capability ceiling" versus "the agent runs
on the owner's box with the owner's credentials".** An editor can make the
owner's agent run commands on the owner's box, and the box pulls credentials as
the owner's member. That is the owner's ceiling by definition, and the owner
grants it deliberately. *Proposed:* keep the ask, and constrain it: editors
must be authenticated org members (never public); the dialog says what
read-write means on the owner's machine; every editor action is attributed and
audited; deleting, moving and re-sharing the session stay with the owner unless
"editors can share" is on.

**C5. "Instant" revocation versus replicated state.** Access can be cut
instantly (row plus drain). What the grantee already synced to their browser
cannot be recalled, the same way a cached Google Doc cannot. *Proposed:* define
instant as "no new bytes after the change lands", state the residue, and clear
the local replica on the client when it learns it was revoked.

**C6. "Admins read everything" versus "every session is private by default".**
This is already the invariant (workspace and org admins hold implicit
read-only). *Proposed:* keep it, make it visible in the share dialog ("Workspace
and organization admins can always view this session"), and audit admin opens.

**C7. "The workspace appears in the bar for a non-member" versus `role: null`
meaning "disabled tile".** *Proposed:* a computed **guest** reach: any org member
holding at least one session grant in a workspace sees its tile with a shared
badge, and opening it mounts a viewer-only shell (no own machine, no terminal,
no files), listing only the sessions shared with them. No membership row is
written; workspace admins see guests listed separately.

**C8. "Admin reads all sessions" versus sessions living only on boxes.** With no
server-side copy, an admin reads everything on *running* boxes by dialling each
one. Reading sessions on stopped boxes, and an org-wide list without dialling,
require a control-plane mirror, which the v1 design deliberately refused. This
is the one architecture decision v2 cannot dodge; §5 and §6 make it.

**C9. Workspace-role viewers.** They still receive read-only at most. Nothing
in the asks contradicts this; it is restated so it is not lost.

## 5. Where session truth lives: the three options

**M0. Box only (today).** Every read and write goes to the owner's box. Admin
"all sessions" is a fan-out of one short `meta` read per running box. Boxes
that are off are invisible. Public links are impossible under C3. Fork and move
need the source box up.

**M1. Box is truth; the control plane holds a non-authoritative catalog and
snapshots.** A small node service on every box (a protocol-v7 peer of the
daemon, the same building block the bridge already is) pushes a session index
to the control plane and, for sessions that need it, a snapshot of the session
document. The control plane never parses a CRDT: the index is plain JSON, the
snapshot is opaque bytes plus a rendered Markdown export. Authorization stays
"claim ∩ what the daemon holds" for every live path; the catalog is a cache
used for listing, search, offline rows, public links and transfer sources, and
is explicitly allowed to be stale.

**M2. A live hub.** A Durable Object per workspace speaks the Loro sync
protocol; boxes dial out and keep rooms synced; browsers connect to the hub
rather than to boxes; the hub enforces the ACL with Blitz identities and hosts
presence. This is how Lody's own cloud is shaped. It is a from-scratch sync
server, a transport swap in the vendored renderer (which assumes exactly one
local plane on `window.ipc`), and the same box-side mirror client M1 needs.

**Recommendation: M1, built so that M2 remains reachable.** M1 is a strict
subset of M2's box-side work, it needs no vendor change, and it is what unlocks
every ask that M0 cannot: admin lists across an org, rows for boxes that are
off, public read-only links, and fork or move from a source that is not
running. M2 becomes worth it only if the product needs one live rail across
several boxes at once, which nothing in the ask requires. Appendix A draws all
three side by side with a tradeoff table; §6 is M1 in depth.

## 6. M1 in depth

This section is longer than it needs to be for a decision, on purpose. Each
subsection names the alternative it rejected and the question a different
product answer would reopen.

### 6.1 Components and responsibilities

```
 +---------------------------- CONTROL PLANE (Worker) -----------------------------+
 |  routes                                          stores                          |
 |   /workspaces/:ws/(shared/:o/)webapp/7445/*       D1  session_shares (kinds,     |
 |     live proxy + ticket mint        (v1, unchanged)    links, expiry)            |
 |   /workspaces/self/session-catalog     <--- push      session_share_links       |
 |   /workspaces/self/session-snapshots   <--- push      session_locations         |
 |   /workspaces/self/session-bundles     <--> transfer  session_transfers         |
 |   /workspaces/:ws/sessions             ---> admin     session_catalog  (CACHE)  |
 |   /p/<token>                           ---> public    session_share_events      |
 |                                                   R2  snapshots/<org>/<ws>/<sid>/|
 |                                                         session.loro, session.md,|
 |                                                         meta.json               |
 |                                                       bundles/<transferId>/     |
 +----------------------------------------------------------------------------------+
          ^ live (down)                                 |  pushes (up)
          |  tickets, 60 s                              |  machine credential
 +--------|-----------------------------------------------|----------- BOX ---------+
 |  gateway (Go) --> blitz-lody-bridge --> lody daemon (loro-repo, SQLite)          |
 |      ticket verify        share ACL           ^                                  |
 |                                               | v7 frames on the data-plane sock |
 |                                    blitz-lody-agent (node, CommonJS)             |
 |                                      - joins meta room      -> catalog reports   |
 |                                      - joins flagged docs   -> snapshots         |
 |                                      - export / import      <- /transfer door    |
 |                                        (worktree bundle, harness files,          |
 |                                         attachments)                             |
 +----------------------------------------------------------------------------------+
```

Responsibilities, one line each:

| Component | Owns | Never does |
|---|---|---|
| gateway | who may reach which door | inspect a frame |
| bridge | what a claim may say in a room or RPC | know who someone is |
| daemon | the documents, the agent process, execution | see a Blitz identity |
| agent (new) | reporting and transport: catalog, snapshots, bundles | authorize a reader |
| control plane | grants, claims, catalog, snapshots, links, transfers | parse a CRDT |

The agent is a **sibling of the bridge, not part of it**. The bridge is on the
request path of every live connection and is deliberately small; the agent is
a background reporter with retries and debounces. Putting them in one process
would put the reporter's failure modes on the live path. **Alternative
rejected:** having the agent read `repo.sqlite3` directly. The daemon owns
that file, loro-repo compacts it on its own schedule, and the protocol-v7
frames are the contract the bridge already pins with fixtures; a second
reader of the SQLite file would be a second contract with none.

### 6.2 Why the agent is a peer, and what that means

A protocol-v7 peer is a full replica: it joins a room and receives the whole
document, then deltas. The bridge is such a peer for the browser; the agent
is one for the control plane. Three properties follow.

1. **The agent sees everything on the box.** It runs as the box user with the
   daemon's socket, exactly like the bridge, so it holds the same trust as
   the bridge: it is the box's own component, not a grantee. What it *sends*
   is governed by policy (§6.5), not by an ACL on what it can read.
2. **It needs `loro-crdt` for the document, not for the catalog.** The `meta`
   room is plain `flock-json`, so titles, status, `lastMessageAt`, archived
   and project come out as JSON with no CRDT parsing (v1 §10.1). A snapshot
   is different: the session document's body arrives as Loro update bytes,
   and producing a compact snapshot or a Markdown rendering means holding a
   `LoroDoc`. The box already has `loro-crdt` inside the installed Lody
   package, so the agent uses it and the bridge stays dependency-free, with
   one exception (§10.1).
3. **It authors nothing.** The agent joins rooms and never sends an `update`,
   so it cannot corrupt a session. The one place it writes is the import side
   of a transfer (§13.2), and there it writes a brand-new document.

### 6.3 The five data flows

**(a) Catalog push.** Debounced on `meta` changes; one report per box, not per
session.

```
 daemon meta room ---delta---> agent: fold into in-memory index
                               debounce (30 s, or immediately on a status change)
                               POST /workspaces/self/session-catalog
                                 { machineId, reportedAt, sessions:[{id,title,status,
                                   isArchived,lastMessageAt,project,ownerLocalId}] }
 control plane: upsert session_catalog rows keyed (ws, owner membership, session id)
                delete rows the report no longer names (the report is complete)
```

**(b) Snapshot push.** Only for flagged sessions (§6.5).

```
 agent: join doc:session-<id>  ---> LoroDoc replica
        on change, debounce 20 s ---> export({mode:"snapshot"})  -> session.loro
                                 ---> render Markdown             -> session.md
                                 ---> project SessionMeta         -> meta.json
        PUT /workspaces/self/session-snapshots/<id>   (multipart, size-capped)
 control plane: write R2 snapshots/<org>/<ws>/<sid>/{session.loro,session.md,meta.json}
                stamp session_catalog.snapshot_key and snapshot_at
```

**(c) Live view.** Unchanged from v1: browser → proxy → gateway → bridge →
daemon. The catalog is not consulted; the claim is minted from grant rows and
the bridge intersects it with what the daemon holds.

**(d) Offline row.** A shared session whose owner's box is not running.

```
 rail: GET /workspaces/:ws/session-shares (received)  --> which sessions, at what level
       GET /workspaces/:ws/sessions?owner=<o>          --> catalog rows: title, status,
                                                          last message, snapshot_at
 row drawn muted: "<owner>'s machine is off · last seen 14:02"
 click: if snapshot exists -> read-only snapshot page (session.md, or session.loro
        loaded into an in-memory repo if the vendored viewer is used)
        else -> "Nothing to show until their machine is back" + wake button (§9)
```

**(e) Public link.**

```
 GET /p/<token>
   control plane: hash token -> session_share_links row (audience public, not disabled,
                  not expired) -> catalog snapshot_key -> R2 session.md
                  render static page (title, transcript, diff stats); cache with the
                  token hash as the key; 404 the moment the link is disabled
   no ticket is minted, no box is contacted, no cookie is required
```

**(f) Admin console.** Org-wide list of sessions across workspaces.

```
 GET /orgs/:org/sessions?workspace=&owner=&status=&q=
   gate: org admin (implicit reach), or workspace admin for one workspace
   source: session_catalog joined to workspaces, members, machines (running?)
   result rows link to the live view (shared prefix) when the box is running,
   or to the snapshot page when one exists
```

### 6.4 Trust and authority: what may decide what

The single rule: **the catalog answers "what is there" questions and never
"may I" questions.**

| Question | Answered by | Never by |
|---|---|---|
| May M read session S on O's box? | grant rows at mint, intersected with what the daemon holds | the catalog |
| Which sessions exist on O's box, right now? | the daemon's `meta` room | the catalog (a hint, possibly stale) |
| What does S say, live? | the daemon, through the bridge | a snapshot |
| What does S say while O's box is off? | the snapshot, if S was flagged | the daemon |
| What may the public see of S? | the snapshot, gated by the link token | anything live |
| Who may see catalog rows? | the same access rules as the live view (owner, grantee, admin) | the agent |

Two consequences worth stating:

- **A stale catalog can only under- or over-list, never over-grant.** A ghost
  row (session deleted on the box, report not yet arrived) draws a row that
  answers `session_not_found` on click. A missing row hides a session that
  exists until the next report. Neither changes what a ticket may do.
- **The v1 rule "the control plane has no session list" becomes "the control
  plane has no *authoritative* session list".** `session_shares.session_id`
  stays opaque and unvalidated; the catalog is written by boxes and read by
  humans.

### 6.5 What gets snapshotted, and who decides

A snapshot is transcript content at rest on the control plane. The default
should be conservative and the policy visible:

| Trigger | Snapshot? | Why |
|---|---|---|
| every session | catalog row only | listing needs titles, not transcripts |
| a public link exists | yes, while the link is live | the public page has no other source |
| owner ticks "keep readable while my machine is off" | yes | explicit consent, per session |
| org policy `sessionMirroring: all` | yes, for every session | for orgs that want offline admin reading and search |
| session archived or deleted | snapshot deleted on the next report | retention follows the session |

Storage keys carry the org and workspace so deletion is a prefix operation
when either goes. Encryption at rest with an org-held key is possible but
changes the public-page path (the Worker would decrypt per request); it is
listed as a question, not assumed.

### 6.6 Staleness model

| Surface | Source | Lag |
|---|---|---|
| mounted live session | daemon via bridge | none |
| working / waiting indicator on a shared row (box running) | presence over the open per-box socket (§10.1) | none |
| title, archived, last message on a shared row (box running) | `meta` over the same socket | none |
| the same on a row whose box is off | catalog | last report before the box stopped |
| admin console | catalog | up to one debounce window, plus whatever a stopped box never reported |
| offline read of a snapshotted session | snapshot | up to one snapshot debounce before the box stopped |
| public page | snapshot | one snapshot debounce, and cached per token |

The point of the table: **nothing a person can act on is stale.** Every write
path goes to a live daemon; the stale surfaces are lists and read-only pages,
and each of them says when it was last refreshed.

### 6.7 Failure modes

| Failure | Effect | Handling |
|---|---|---|
| owner's box off | live view impossible; rows go muted; snapshots still serve | wake button for admins and allowed editors; offline row states the last-seen time |
| agent crashed, daemon fine | catalog and snapshots freeze; live view unaffected | s6 restarts it; `reportedAt` age surfaces as "last reported" on rows; watchdog alert past a threshold |
| control plane unreachable from the box | reports queue in memory and are dropped on overflow; the next successful report is complete, so nothing is lost permanently | same as machine-stats today |
| catalog names a session the daemon no longer holds | a row that answers `session_not_found` | next report removes it; the click shows the reason |
| snapshot exists for a session whose share was revoked | the offline row disappears with the grant; the public page 404s with the link | rows and pages are gated by grants and links, not by the snapshot's existence |
| snapshot upload exceeds the cap | refused; catalog row marks `snapshotTooLarge` | Markdown is still rendered from a truncated tail; Loro bytes are skipped |
| two boxes report the same session id (after a fork with a preserved id) | ambiguity in the catalog | forks always mint a new id (§13.1), so this cannot happen by construction |

### 6.8 Security review of the new surfaces

- **Agent → control plane routes** authenticate with the machine credential,
  which acts as the box's member, and are scoped to `/workspaces/self`. A
  compromised box can lie about its own sessions and nothing else, which is
  the same blast radius machine-stats already has.
- **Public page** is the only unauthenticated surface. It serves Markdown and
  diff stats from R2 by token hash, never proxies, never mints a ticket, and
  is rate-limited per token. A leaked token is revoked by disabling the link.
  Everything in the page was already on the transcript; the page adds no
  worktree access.
- **Catalog reads** use the workspace access rules: a member sees their own
  rows and rows for sessions shared with them; admins see all rows in their
  reach. A guest sees only rows for sessions they hold grants on.
- **Bundles** are size-capped, written by the source machine, read by the
  target machine, deleted after import or after a day, and named by a
  transfer id the control plane minted for exactly that pair of machines.
- **Presence projection (§10.1)** closes a v1 leak on the live path; it is a
  bridge change, not an agent change, but it belongs in the same review.

### 6.9 Cost and sizing

| Piece | Size | Note |
|---|---|---|
| agent: meta subscription + catalog reports | S | the bridge's frame code, reused |
| agent: snapshot export + Markdown render | M | needs `loro-crdt` and Lody's Markdown renderer or a port of it |
| control plane: catalog routes + table + janitor | S | mirrors machine-stats |
| control plane: snapshot routes + R2 layout + retention | M | |
| public page | M | one route, one template, caching, rate limit |
| admin console | M | one query, one list view |
| fixtures: catalog report, snapshot manifest, public page shape | S each | mandatory under CLAUDE.md |
| offline rows and wake button in the rail | S | |

### 6.10 Why M1 stays reachable to M2

The agent *is* the mirror client M2 needs on every box: a v7 peer that
follows rooms and forwards them outbound. The catalog *is* the index a hub
would keep. The snapshot *is* the hub's document persistence. Moving to M2
later means adding the hub and swapping the renderer's transport, not
rebuilding the box side. Conversely, nothing in M1 forces M2: if one live rail
across boxes never becomes a product need, M1 is complete on its own.

### 6.11 Questions to mull

1. Is "catalog for everything, snapshots on consent" the right default, or
   should orgs opt in to the catalog too? What does an org that forbids any
   transcript leaving its boxes lose? (Answer: public links, offline reading,
   and the org-wide console; everything else works.)
2. Should the public page render from Markdown (simple, no WASM, loses
   interactivity) or load `session.loro` into the vendored viewer in the
   browser (faithful, heavy, needs the Lody chunk on a public route)?
3. Is a 30-second catalog debounce acceptable for the admin console, or does
   the console need the same open-socket freshness the rail gets (§10.1)?
4. Should the agent live on the box at all, or could the bridge report on the
   owner's own connections as a side effect? (Rejected above because the
   owner is often not connected; but it would be smaller.)
5. Where should a viewer's own last-read time live: browser storage (private,
   device-bound) or a control-plane row (follows the user, one more table)?
6. Does the org-wide console want search over transcript text? That is only
   possible for snapshotted sessions and would push toward `sessionMirroring:
   all`.

## 7. Data model

### 7.1 Grants generalize by principal kind

```sql
-- session_shares gains a principal kind and link support; existing rows are kind 'member'.
ALTER TABLE session_shares ADD COLUMN grantee_kind TEXT NOT NULL DEFAULT 'member'
  CHECK (grantee_kind IN ('member', 'workspace', 'org', 'public'));
-- grantee_membership_id becomes nullable: NULL for every kind but 'member'.
ALTER TABLE session_shares ADD COLUMN via_link_id TEXT REFERENCES session_share_links(id);
ALTER TABLE session_shares ADD COLUMN expires_at INTEGER;   -- NULL = never
-- UNIQUE (workspace_id, session_id, grantee_kind, grantee_membership_id) replaces the v1 key.

CREATE TABLE session_share_links (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id),
  session_id               TEXT NOT NULL,
  owner_membership_id      TEXT NOT NULL REFERENCES memberships(id),
  audience                 TEXT NOT NULL CHECK (audience IN ('org', 'public')),
  level                    TEXT NOT NULL CHECK (level IN ('ro', 'rw')),   -- public is always 'ro'
  token_hash               TEXT NOT NULL UNIQUE,                          -- rotate = new row, old disabled
  disabled_at              INTEGER,
  expires_at               INTEGER,                                       -- public default: 30 days
  created_at               INTEGER NOT NULL,
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id)
);

CREATE TABLE session_share_events (   -- append-only, like credential_events
  id, workspace_id, session_id, actor_membership_id, action, subject, level, at
);
```

Semantics:

- `member`: as v1. May carry `via_link_id` when it was created by an org link
  visit (§12); disabling the link deletes those rows.
- `workspace`: everyone who is a member, admin or viewer of the workspace at
  mint time, including members added later. Viewers are demoted to read at mint
  as today.
- `org`: never a mint-time principal. It exists only as a link audience; a
  visit materializes a `member` row tagged `via_link_id`, so the mint path stays
  one indexed read.
- `public`: never mints a box ticket. It is served by the snapshot path (§6.3e).
- `expires_at`: the v1 decision ("nobody asked") is reversed by this ask. It is
  checked at mint and by a janitor that deletes and drains.

The `session_shares` "who may grant" rules stay: the owner, or a workspace
admin naming an owner. Two additions: an editor may grant when the session's
`editors_can_share` flag is on (a column on a new `session_settings` row keyed
by session, owner-writable), and grants to non-members are refused unless the
org policy `sharing.nonMemberEditors` allows read-write for them (default:
read-only for non-members is allowed, read-write needs the policy on; §16
question 2).

### 7.2 Locations, lineage and transfers

```sql
CREATE TABLE session_locations (    -- written only on share, link, fork or move; not on creation
  session_id           TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  owner_membership_id  TEXT NOT NULL REFERENCES memberships(id),
  forked_from          TEXT,        -- session id
  moved_to             TEXT,        -- session id; set on the SOURCE of a move
  updated_at           INTEGER NOT NULL
);

CREATE TABLE session_transfers (
  id, mode CHECK (mode IN ('fork','move')),
  source_workspace_id, source_owner_membership_id, source_session_id,
  target_workspace_id, target_owner_membership_id, target_session_id,
  state CHECK (state IN ('requested','exporting','uploaded','importing','done','failed')),
  bundle_key TEXT, error TEXT, requested_by_membership_id, created_at, updated_at
);
```

### 7.3 The catalog (M1)

```sql
CREATE TABLE session_catalog (      -- box-written cache; never authorizes anything
  workspace_id, owner_membership_id, session_id,
  title, status, is_archived INTEGER, last_message_at INTEGER, project_summary TEXT,
  snapshot_key TEXT, snapshot_at INTEGER,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, owner_membership_id, session_id)
);
```

Producer: the box agent (§6.1) over the machine credential,
`POST /workspaces/self/session-catalog`, debounced. Contract: a fixture corpus
under `packages/schema/fixtures/session-catalog/` with conformance on both sides,
in the shape `machine-stats` already uses.

## 8. Access model and claim computation

`WorkspaceAccess` gains one computed field:

```ts
interface WorkspaceAccess {
  stored: WorkspaceMemberRole | null;
  orgAdmin: boolean;
  owner: boolean;
  guest: boolean;   // holds ≥1 live session grant in this workspace, and nothing else
}
```

Effects, by route:

- `GET /workspaces`: a guest's workspace is listed with `role: null` and a new
  `reach: "member" | "admin" | "guest"` field. The strip enables the tile for
  guests and draws a shared badge. `plans/MEMBER-MACHINES.md` §3's matrix gains a
  "Guest" column with exactly one tick: "watch or drive the sessions shared with
  them".
- `webAppWorkspaceForRequest`: a guest is admitted **only** on the shared prefix.
  Their ticket carries `role: "viewer"` (no corpus change: the four-value role
  stays as pinned) plus the share claim, which the gateway already admits to
  `/lody/*` and nothing else (`main.go:620`). The mint's viewer demotion keys off
  `access.stored === "viewer"`, and a guest's stored role is null, so a guest's
  `rw` row survives. **MEASURE:** that no other viewer-role guard in the gateway
  or bridge downgrades a guest's writes.
- `shareCaller` (the `session-shares` routes): guests may read `received`;
  they may never grant.
- The mint (`shareClaimForTarget`) unions `member` rows for the caller with
  `workspace` rows when the caller holds a stored role or is the owner, applies
  expiry, applies the viewer demotion, and keeps `scope: "all"` for admins.

An org admin opening a workspace with no seat: `webAppWorkspaceForRequest`
already admits them; the shell (not the control plane) decides between the
owned shell and the viewer-only shell by whether `WorkspaceView.machines`
contains one of theirs.

## 9. The session viewer surface

One surface, three rail configurations, one mount rule.

| Who | Rail sections | Own runtime |
|---|---|---|
| Member with a machine | My sessions · Shared with me · (admin) All sessions · Terminals | yes |
| Org admin without a seat | All sessions · Shared with me | no |
| Guest | Shared with me | no |

- **All sessions** (admins): one row per session per member, grouped by
  member. Source, Phase A: one `meta` read per *running* box over the shared
  prefix (`scope: "all"` returns the whole room), widening
  `webapp/src/lody/shared-sessions.ts` from titles to a summary (title,
  status, archived, `lastMessageAt`, project). Source, Phase B: the catalog, with
  rows for stopped boxes drawn muted ("machine off; last seen …"). Opening a row
  is exactly v1's shared mount.
- **Mount rule** stays "one box at a time" (v1 §10.2, measured), softened by
  the keep-alive pool. A viewer-only shell has no own runtime to tear down, so
  it is the simpler case.
- **Wake on view**: a row on a stopped box offers "Start their machine" to
  workspace admins (who may already start any member machine) and to editors
  when the owner has allowed it; viewers see the offline state. This replaces
  the silent non-mount.
- The vendored zone is unchanged. The native sections are props
  (`afterSessionListContent`), as v1 established.

## 10. Write access is the editor ceiling

Everything below is a bridge allowlist change plus one projection; no daemon
change. `packages/schema/fixtures/lody-share-claim/decisions.json` grows a row
per case.

Session settings are already in reach: permission mode, model and effort live
in the session document (`acpRuntimeConfig`, per-turn `inputConfig`), so a
read-write room already covers them. What v1 withheld and v2 opens for `rw`:

| Surface | v1 | v2 for `rw` |
|---|---|---|
| doc-meta fields | `latestUserMsgId`, `lastMissingHistoryUserMsgId`, `lastMessageAt` | adds `title`, `titleSource`, `isPinned`, `isArchived`, `agentConfigId`, `agentRoleId`, `agentRoleRevision` |
| withheld forever | — | `machineId`, `userId` (owner), `project`, `origin`, `lastReadAt` |
| RPC | `session/cancel`, `steer`, `dispatch-turn` | adds `session/terminate`, `session/fork` (same box; the browser then asks the control plane to copy the source's grants onto the fork), `session/edit-and-resend`, `code-collab/save-text`, `code-collab/init-directory` |
| flock-doc (machine flock) | refused | read, projected: keep `agentConfig`, `agentConfigIndex`, `acpCapability`, `agentRole`; withhold `localProject` and every `cmd` family. This is v1 §10.3's follow-up and it is what gives editors the model, effort and mode selectors |
| attachments | none | a bridge door that accepts bytes for a granted session into `/workspace/.blitz-attachments/<sessionId>/` (the gateway keeps dufs closed to share tickets) |
| `/control` | refused | still refused: `session/create` and `file-send-local` are box-level acts |

Read-only is unchanged.

### 10.1 The leading status indicator on shared rows, and a v1 leak

The rail's leading indicator is waiting-permission over working over unread
(`sidebar-row-shared.tsx:116-155`). Working and waiting come from live
presence; unread is `lastMessageAt > lastReadAt` on the session's own meta
(`session-list-rows.ts:175-230`). Shared rows can carry all three, and the
first two are not optional to handle:

- **Presence already reaches every connection.** The daemon registers any
  connection that sends a frame as a presence receiver and pushes the whole
  workspace snapshot on every change (`local-loro-data-plane-server.ts:239-240`,
  `:397-400`, `:439-446`). The bridge forwards it untouched. A grantee's
  `/sync` connection therefore receives the owner's complete presence snapshot
  today, naming every session on the box and its live status, granted or not,
  and the grantee's mounted surface decodes it
  (`create-workspace-runtime.ts:2748-2755`). This is the same class of leak the
  `meta` projection closed in v1 §10.1. **Phase A closes it with a presence
  projection at the bridge.**
- **Projection, not suppression.** The payload is a Loro `EphemeralStore`
  snapshot (`apps/cli/src/lib/loro/presence.ts:110`), so filtering it means
  decoding with `loro-crdt`, dropping the non-granted session entries, keeping
  the machine entry, and re-encoding. The bridge is dependency-free by design;
  `loro-crdt` is already on the box inside the installed Lody package, so this
  is a deliberate dependency, not a blocker, and it is the first place the
  bridge's "JSON filtering only" stance cannot hold. Dropping the frame instead
  would take the permission card away from co-drivers, because that card is
  gated on presence (v1 §10.5).
- **The rail then gets working and waiting for free.** The native reader keeps
  its per-box `/sync` connection open instead of closing it after the `meta`
  read, decodes presence with the same `loro-crdt` module the mounted surface
  already loads, and computes the indicator exactly as Lody does. Machine
  online state (fresh heartbeat, never stored `lastSeen`) comes with it.
- **Unread is per viewer, not per session.** `lastReadAt` encodes Lody's
  one-user assumption. A shared row compares the owner's `lastMessageAt` with
  the viewer's own last-read time, kept in browser storage keyed by session (or
  a control-plane row if it should follow the user across devices). The meta
  write allowlist keeps withholding `lastReadAt` from grantees, so reading a
  shared session never marks it read for its owner.

What a Blitz-drawn shared row still cannot do, and only M2 would: be a tab
beside the viewer's own sessions, be dragged into the viewer's composer as a
session mention, count toward the viewer's badge, and take part in Lody's own
pins, filters and search across the list.

## 11. Instant scope change and revocation

Two layers, both already partly in place:

- **Durable** (the row): every HTTP door mints per request under a 60-second
  ticket, so a change is effective on the next request.
- **Live** (the socket): the bridge reads the claim once at upgrade. v2 drains
  on **every** change that narrows access (revoke, `rw` to `ro`, expiry), not
  only when the last grant goes; the drain call takes the grantee and the
  bridge closes only that grantee's sockets. A change that widens access
  (`ro` to `rw`, new grant) needs no drain; the client re-dials when its
  `received` list changes (polling today; a cheap `grantsVersion` on the
  workspace poll makes that one comparison).
- **Residue**: on learning of a revoke, the client disposes the shared surface
  and deletes the local `loro-repo` IndexedDB store for that box. What was on
  screen was seen; nothing further arrives.
- **Links**: rotate (new token, old disabled), disable, expire. Disabling an
  org link deletes its `via_link_id` rows and drains them. Disabling a public
  link makes the snapshot route answer 404 immediately; the snapshot object is
  deleted by the janitor.

The v1 property that makes all of this safe is kept verbatim: the browser
never holds a box credential, so every byte to a box passes the mint.

## 12. Share links

**Org link** (`audience: 'org'`, `ro` or `rw`): the URL is
`/s/<token>`. A signed-in org member who opens it gets a `member` row created
for them (`via_link_id` set, level from the link), is redirected to
`/workspaces/:id/chat/shared/:owner/:session`, and becomes a guest if they hold
no seat. A signed-out visitor is sent through login first. Revoking the link
revokes those rows.

**Public link** (`audience: 'public'`, always `ro`): the URL is `/p/<token>`
and is served by the control plane from the snapshot (§6.3e): a static
transcript page rendered from Lody's own Markdown export
(`packages/shared/src/conversation-markdown.ts`) plus diff stats, refreshed when
the box pushes a new snapshot (debounced, tens of seconds behind a live
session). No box traffic, no ticket, works when the box is off. Expires by
default; org policy can forbid public links entirely.

**Copy link** for a restricted session copies the deep link; it works for
anyone who already holds access and is a 403 for anyone else.

## 13. Fork and move across workspaces

### 13.1 Semantics

- **Fork**: anyone with read access to the source may fork it into a workspace
  where they have a machine (or, as workspace admin there, onto a named
  member's machine). The result is a new session id on the target box, owned by
  the target box's member, with `forked_from` recorded. Optional and default-on
  in the dialog: share the result with the target workspace at `rw` (C1).
- **Move**: the owner or a source-workspace admin may move. Move is fork plus:
  the source is archived with a `movedTo` marker in its meta, `session_locations`
  records the redirect, the source's grants and links are re-created on the
  target and deleted at the source (with drains), and the old deep link
  redirects. The source document is never deleted by a move.
- Same-box fork into a new worktree is Lody's own `session/fork` and needs
  nothing from this section.

### 13.2 The bundle and the box agent

The agent of §6.1 serves the third of its three jobs here. A transfer bundle
(`manifest.json`, versioned and fixture-pinned):

| Part | Content | Note |
|---|---|---|
| `session.loro` | full snapshot export of the session document | opaque to the control plane |
| `meta.json` | the projected `SessionMeta` (title, cli/agent type, agent config kind, branch, base branch, `acpSessionId`, parent link) | never `machineId`, never the local user id |
| `harness/` | the agent CLI's native session files (`~/.claude/projects/<cwd-key>/<acpSessionId>.jsonl` and its directory for Claude; the Codex rollout for Codex) | best effort; what makes "continue" mean continued context |
| `worktree.bundle` | `git bundle` of the session branch against its base | remote-agnostic |
| `attachments/` | `/workspace/.blitz-attachments/<sessionId>/` | |

Import on the target box, with new session id `S'`:

1. Recreate the worktree from the bundle in the target's clone of the same
   repository (registered through `local-project/add`, as `blitz-lody-projects`
   does); with no matching repo the session lands as a plain chat in
   `/workspace`.
2. Place the harness files under the project directory that matches the new
   worktree path, keeping the native session id so the adapter's resume path
   finds it. **MEASURE:** that Claude Code resumes a transplanted `.jsonl`
   whose recorded `cwd` differs from the new one; if not, fall back to Lody's
   `external-acp` import, and if that fails, to a fresh native session with the
   transcript as context.
3. Load `session.loro` into a `LoroDoc`, set `session.id` to `S'`, rewrite
   attachment namespaces the way `session-fork-service.ts:64-89` does, export.
4. Write existence and meta records for `session-S'` into the `meta` room
   (`machineId` = the target box, `userId` = its local id, project = the new
   worktree, `blitz.forkedFrom` = source), then push the document as an
   `update` in `doc:session-S'`. This is exactly how a browser creates a session
   today, so the daemon needs no new operation.

### 13.3 Orchestration

`POST /workspaces/:id/sessions/:sessionId/transfers` creates a
`session_transfers` row and drives it: the control plane calls the source
bridge's `/transfer/export` (a new door; the actor's ticket must cover the
session for read), the agent uploads to R2 under the machine credential, the
control plane calls the target bridge's `/transfer/import` (the actor must own
the target box or be its workspace admin), the agent imports and reports
`targetSessionId`, and the control plane finishes: `session_locations`, grants,
the optional workspace share, and for a move the archive-and-redirect step on
the source. Every state is polled by the dialog; failures leave the source
untouched. Bundles are deleted after import or after a day.

When the source box is off and a snapshot exists, a fork can proceed from the
snapshot (transcript only, no worktree or harness files) with the dialog saying
so.

## 14. Attribution, presence, audit

- **Audit (Phase A)**: `session_share_events` for every grant, level change,
  revoke, link event, admin open and transfer. The bridge already knows the
  claim per connection; it additionally reports `dispatch-turn`, `steer`,
  `cancel`, `terminate` and meta writes per grantee to the control plane
  (machine credential), so "who prompted" is answerable even while the document
  itself says the owner did.
- **In-document attribution (Phase D)**: today a grantee authors under the
  owner's `local:` id because the daemon's identity oracle allows exactly that
  id. A small seam patch lets the oracle accept a configured set of ids, and the
  grantee's surface authors under `local:blitz-<membershipId>`; names and
  avatars come from a narrowed `/platform` projection. This is the right shape
  to upstream: Lody's own local platform says it is "moving toward full
  local-first" and a multi-identity local oracle is on that path.
- **Presence (Phase D)**: every viewer of a box's sessions is connected to that
  box's bridge, so the bridge can publish "viewing" presence in Lody's own
  `LodySessionViewingPresenceState` shape into each connection's stream. The
  renderer's local ephemeral store is a stub, so the UI half is a seam patch
  or an upstream change. Worth doing only once the viewer surface is in daily
  use.

## 15. Phases

| Phase | Delivers | Touches | Size |
|---|---|---|---|
| **A. Sharing that reaches the org** | principal kinds, expiry, org links, guest reach, viewer-only shell, admin All sessions (fan-out), editor ceiling, presence projection at the bridge and live status on shared rows (§10.1), drain on every narrowing, editors-can-share, audit events, dialog v2 | control plane, webapp, bridge decisions and fixtures; no new box service, no vendor change | L |
| **B. The mirror** | box agent, catalog contract, snapshots for linked or flagged sessions, public links, offline rows, org-wide admin console (§6) | new guest service and two fixture corpora, control plane routes, R2 keys, a public route and page | L |
| **C. Fork and move** | transfer bundle, export and import doors, orchestration, redirects, auto-share on landing, snapshot-source forks (§13) | agent, bridge, control plane, dialog; one **MEASURE** on harness resume | L |
| **D. Multiplayer feel** | in-document attribution, viewing presence, replica clearing on revoke (§14) | two seam patches with upstream PRs | M |

A and B are independent once A's data model is in. C needs B's agent. D is
independent of C.

Exit tests follow the repo's rule: fixture corpora for every new
cross-runtime payload (the claim decisions, the catalog report, the snapshot
manifest, the transfer manifest, the public page shape), and one daemon-gated
test per phase that proves the claim on a real daemon rather than on paper.
Phase A's are v1's five tests extended for a guest, an org admin without a
seat, a downgrade drain, and a presence frame that reaches a grantee with only
their sessions in it. Phase C's decisive one is a moved Claude session
answering a follow-up with the transplanted context.

## 16. Decisions needed

1. **Mirroring policy.** May the control plane hold transcript content at rest?
   Proposed default: catalog for every session; snapshots only for sessions with
   a public link or an explicit "readable while my machine is off" flag; an org
   policy to widen or forbid it (§6.5).
2. **Read-write for non-members.** Proposed default: allowed, behind an org
   policy that admins can turn off, with the dialog stating what it means.
3. **Public links.** Allowed by default with a 30-day expiry, or off until an
   admin enables them for the org?
4. **Move identity.** New session id plus redirect (proposed), or the same id
   on the new box?
5. **Fork and move landing.** Actor's own box in the target workspace
   (proposed), with admins able to name another member's box.
6. **Admin write.** Keep admins at implicit read-only with auditable self-grant
   (proposed), or give them implicit read-write?
7. **"Share with workspace" is dynamic** (future members included). Proposed:
   yes, as Google's org-wide access behaves.
8. **Attribution in v2.** Accept cosmetic in-document attribution plus the
   bridge audit for A through C, with the identity seam in D?
9. **`loro-crdt` in the bridge.** Accept it for the presence projection
   (§10.1), or keep the bridge pure and accept that co-drivers lose the
   permission card while the leak is closed another way?

## 17. Upstream opportunities

Each of these makes BlitzOS's merge cheaper and is plausibly wanted by Lody:

- the `readOnly` surface prop (drafted in v1);
- a multi-identity local platform (identity oracle accepting a set);
- ephemeral presence over the local data plane, and a per-room rather than
  per-workspace presence push so a relay can scope it without decoding;
- `session/export-bundle` and `session/import-bundle` as daemon operations,
  which would retire our v7-peer importer;
- a `machineId` transfer for moving a session between machines in one
  workspace, which their own multi-machine workspaces lack today.

## Appendix A. Architecture diagrams and tradeoffs

### A.0 The live path every option shares (v1, shipped)

```
  browser (owner)                     browser (editor / viewer / admin / guest)
     |                                          |
     | /workspaces/:ws/webapp/7445/lody/*       | /workspaces/:ws/shared/:owner/webapp/7445/lody/*
     v                                          v
 +----------------------------------------------------------------------------+
 | CONTROL PLANE (Worker + D1)                                                |
 |   resolve caller -> machine of :owner (or own)                             |
 |   read session_shares -> claim {target, scope, read[], write[]}            |
 |   mint 60 s ticket {ws, user, membership, role, share?} ; proxy via tunnel |
 +-------------------------------------+--------------------------------------+
                                       |  ticket header on every request / upgrade
                                       v
 +----------------------------------------------------------------------------+
 | OWNER'S BOX                                                                |
 |   gateway (Go)   verify ticket; a share ticket reaches /lody/* and nothing |
 |       |          else; forwards X-Blitz-Lody-Share: <claim>                |
 |       v                                                                    |
 |   blitz-lody-bridge (node)                                                 |
 |       owner connection : dumb pipe, byte for byte                          |
 |       share connection : room ACL (join/update verdicts), meta projection, |
 |                          RPC + project allowlists, /control refused        |
 |       |  unix sockets: v7 frames (sync) + control (rpc/session/project)    |
 |       v                                                                    |
 |   lody daemon  --  loro-repo (SQLite): session docs, meta flock, machine   |
 |       |            flock; one identity local:<id>; one workspace lw_<id>   |
 |       v ACP                                                                |
 |   claude / codex  --  worktree under /workspace, owner's credentials       |
 +----------------------------------------------------------------------------+
```

### A.1 M0: box only (today, extended with fan-out and guests)

```
  admin or guest browser
        |
        |  one short WebSocket per box it wants to list (fan-out over meta room)
        |  then ONE live mount at a time against the chosen box
        v
 +-------------+        +--------------+   +--------------+   . . . . . . . . .
 | CP proxy    |------->| box A        |   | box B        |   . box C (off)   .
 | mint claim  |------->| gw->bridge   |   | gw->bridge   |   .  invisible    .
 | per box     |        | daemon       |   | daemon       |   .  no rows      .
 +------+------+        | sessions a1..|   | sessions b1..|   .  no links     .
        |               +--------------+   +--------------+   . . . . . . . . .
   D1: session_shares (+kinds, links, expiry), session_locations
   no session list, no content
```

### A.2 M1: box is truth, control plane holds a catalog and opt-in snapshots (recommended)

```
    browsers (owner / editor / viewer / admin / guest)         public visitor
        |  live paths exactly as A.0 (unchanged)                     |  /p/<token>
        v                                                            v
 +---------------------------------------------------------------------------+
 | CONTROL PLANE                                                             |
 |   proxy + mint (A.0)                                                      |
 |   D1: session_shares, session_share_links, session_locations,             |
 |       session_transfers, session_catalog  <-- cache, never authorizes     |
 |   R2: snapshots (session.loro + rendered .md), transfer bundles           |
 |   admin console / offline rail rows  <--  catalog rows (stale is fine)    |
 |   public transcript page             <--  snapshot .md, no box traffic    |
 +------------------^-------------------------------------^------------------+
                    | live proxy (down)                    | outbound push (up)
                    v                                      |  machine credential
 +---------------------------------------------------------------------------+
 | BOX                                                                       |
 |   gateway -> bridge (ACL) -> daemon  <----- blitz-lody-agent (v7 peer)    |
 |                                |  ^           subscribes meta + docs      |
 |                                v  |           debounced catalog reports   |
 |                          agent process        snapshot export (flagged)   |
 |                          worktree             bundle export / import      |
 +---------------------------------------------------------------------------+
```

### A.3 M2: live hub (Lody-cloud shape; deferred)

```
    browsers (all roles)                           public visitor
        |  WebSocket to the hub, Blitz identity          |
        v                                                v
 +---------------------------------------------------------------------------+
 | CONTROL PLANE                                                             |
 |   Durable Object per workspace = Loro sync relay + ACL + presence         |
 |     rooms: meta, session-*, flocks      per-socket authz: read / write    |
 |     storage: update log + snapshots     public: read-only room view       |
 +----------^--------------------------^--------------------------^----------+
            | outbound WS              | outbound WS              |
 +----------+----------+   +-----------+---------+   +------------+---------+
 | box A               |   | box B               |   | box C                |
 |  mirror client      |   |  mirror client      |   |  mirror client       |
 |   <-> daemon        |   |   <-> daemon        |   |   <-> daemon         |
 |  (v7 peer, full     |   |                     |   |                      |
 |   replica)          |   |                     |   |                      |
 +---------------------+   +---------------------+   +----------------------+
   RPCs that need the machine (dispatch, diffs, files) travel hub -> mirror -> daemon
   the renderer's single local plane (window.ipc) must be swapped for a hub transport
```

### A.4 Tradeoffs

| | M0 box only | M1 box truth + mirror | M2 live hub |
|---|---|---|---|
| Admin: all sessions in one workspace | fan-out to running boxes | catalog, instant | hub, instant |
| Admin: org-wide console | impractical (dial every box) | yes | yes |
| Read while owner's box is off | no | snapshot, read-only, tens of seconds stale | yes, hub replica |
| Public read-only link | no (C3) | yes, snapshot page | yes, hub-served |
| Live co-driving (rw) | yes | yes, same path | yes, relayed |
| Presence across viewers | per box, bridge-synthesized (Phase D) | same | native, all boxes |
| Own + shared sessions in one rail (native sections beside the vendored list) | yes, shared rows from grants + one meta read per box | yes, shared rows from grants + catalog; near-live if meta subscriptions stay open | yes |
| One LIVE cross-box session mirror (Lody's own list features, tabs and mentions spanning boxes) | no, one box mounted at a time | no, same constraint; the leading status indicator IS piped through (§10.1); surface switch is warm via the keep-alive pool | yes |
| Fork/move source when box is off | no | transcript only, from snapshot | yes |
| New components | none | box agent, 3 contracts, public page | DO sync server, update storage, mirror client, renderer transport |
| Vendor changes | none | none | structural (the four changes v1 §6.1 measured and declined) |
| Control plane holds content | no | catalog always; snapshots opt-in | everything, always |
| Authority | box relay | box relay; CP only for snapshots | hub |
| Dependence on box uptime | total | live: total; reads of snapshotted sessions: none | live turns only |
| Staleness of what viewers see | none | none live; snapshot lag for offline/public | none |
| Upstream merge cost | low | low | high |
| Size | done | L | XL |

Reading: M1 is a strict subset of M2's box-side work (the agent is the mirror
client), so choosing M1 first loses nothing if M2 is wanted later.

### A.5 Claim computation with principal kinds (all options)

```
 request on /shared/:owner/...   caller M, workspace W, target owner O
   |
   +-- M is org admin, or holds W-admin seat?  --> scope "all" (read every session on O's box)
   |
   +-- rows kind=member,    grantee=M, owner=O, not expired         --> read / write ids
   +-- rows kind=workspace, owner=O, M holds any seat in W            --> read / write ids
   |        (viewer seat, or workspace policy => demoted to read)
   +-- org link visited earlier  ==> a member row tagged via_link_id  (already counted)
   +-- public link               ==> never here; served by /p/<token> from the snapshot
   |
   v
 claim {target:O, scope, read[], write[]}  -->  gateway  -->  bridge ACL
 guest (no seat in W) ==> ticket role "viewer" + claim; admitted to /lody/* only
 narrowing change (revoke, rw->ro, expiry) ==> row write, then /admin/drain for M on O's box
```

### A.6 Fork and move (Phase C)

```
 actor browser       control plane                source box A              target box B
     |  POST transfer     |                            |                         |
     |------------------->| transfers: requested       |                         |
     |                    |--- /transfer/export ------>| agent: join doc,        |
     |                    |    actor ticket must       |  export session.loro,   |
     |                    |    cover the session       |  meta, harness files,   |
     |                    |                            |  git bundle, attachments|
     |                    |<-- PUT bundle to R2 -------|                         |
     |                    | transfers: uploaded        |                         |
     |                    |--- /transfer/import ---------------------------------->| agent: worktree
     |                    |    actor owns B's box,     |                          |  from bundle,
     |                    |    or is W_B admin naming  |                          |  harness files
     |                    |    a member's box          |                          |  at new cwd,
     |                    |                            |                          |  doc S' + meta,
     |                    |<-- done {targetSessionId} --------------------------- |  update frame
     |                    | locations(forked_from), grants copied,                |
     |                    | optional workspace-wide rw share on S'                |
     |                    | move only: archive source, movedTo, redirect -------->|
     |<-- poll: done -----|                                                       |
   failure at any step leaves the source untouched; bundles deleted after import
```
