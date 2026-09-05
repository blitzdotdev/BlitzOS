# Lody sharing: opt-in per-session shares inside a workspace

> **Historical design record.** As of 2026-09-04, daemon provenance and every
> upstream-merge instruction are governed by `docs/LODY-MERGE.md` and
> `plans/LODY-DAEMON-FROM-TREE.md`. References below to the npm daemon are dated
> measurements, not a current selection rule.

The design for phase 6 of `plans/LODY-SESSIONS.md`. It implements §0.1 (the
sharing contract, user-locked) and the sharing-architecture block in §4, and it
is written before the code so the four hard questions — where a grantee's browser
is routed, what the ticket carries, what the relay lets through, and what the
grantee's runtime mounts — are settled in one place rather than discovered one
slice at a time.

Read `plans/LODY-RUNTIME-DESIGN.md` §7–§11 first. Everything below assumes its
vocabulary: the bridge, the four doors, protocol v7, the session document.

## 0. The contract, restated in one paragraph

Every session is private to the member whose box runs it. Its owner, and any
workspace admin, may grant another member of the same workspace read-only or
read-write access to ONE session. Read-only follows the transcript and the
session's diffs and can write nothing. Read-write is a full co-driver: prompt,
steer, cancel, and answer a permission request, where the first answer wins.
Workspace admins additionally hold implicit read-only on every session in the
workspace with no grant row at all. A member whose workspace role is `viewer`
may receive read-only and never read-write. A share carries read access to that
session's worktree — diffs and file views — and nothing else on the owner's box.

## 1. Where the state lives

### 1.1 `session_shares` (D1, migration 0045)

```sql
CREATE TABLE session_shares (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id               TEXT NOT NULL,
  owner_membership_id      TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  grantee_membership_id    TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  level                    TEXT NOT NULL CHECK (level IN ('ro', 'rw')),
  created_at               INTEGER NOT NULL,
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, session_id, grantee_membership_id)
);
CREATE INDEX session_shares_by_grantee ON session_shares (workspace_id, grantee_membership_id);
CREATE INDEX session_shares_by_owner   ON session_shares (workspace_id, owner_membership_id);
```

Three things this schema deliberately does NOT do.

**It does not validate `session_id`.** The control plane has no session list and
must not grow one: the daemon on the owner's box is the only thing that knows
which sessions exist, and a mirror in D1 would be a second source of truth that
goes stale the moment a session is archived on a box the control plane cannot
reach. A row naming a session that does not exist grants access to nothing,
because the relay's ACL is an intersection with what the daemon actually holds.
`session_id` is bounded text (256 bytes) and otherwise opaque.

**It does not encode the admin's implicit read-only.** That is a role, not a
grant, so it is computed at mint time from the caller's workspace role. Writing
admin rows would mean writing one per session — see the paragraph above for why
the control plane cannot enumerate sessions — and revoking admin would mean
deleting them.

**It does not carry an expiry.** §0.1 asks for grant and revoke; a time-boxed
share is a product question nobody has asked yet, and a column nothing sets is a
column that will be read wrong later.

`owner_membership_id` is who the grant routes to. It is the caller's own
membership when the caller is the session's owner, and an explicitly named member
when a workspace admin grants on someone else's behalf. It cannot be verified —
the control plane cannot ask a box "do you hold this session?" without a
box-facing call that does not exist — so a wrong value routes the grantee at a
box that answers `session_not_found`, and grants nothing.

### 1.2 Authority rules

| Action | Who |
|---|---|
| grant / change level on a session | the session's owner (a caller naming themselves as `ownerMembershipId`), or any workspace admin naming any member |
| revoke | the row's owner, or any workspace admin |
| list grants for a session | the row's owner, or any workspace admin |
| list grants received | every member, for themselves |
| receive `rw` | any member whose workspace role is `admin`, `owner` or `editor` |
| receive `ro` | any member of the workspace, `viewer` included |

`viewer` cannot receive `rw`, and the refusal is a 400 naming the role. This is
the one place the workspace role and the share level interact, and it is enforced
on the WRITE, not at mint time, so the refusal reaches the person who made the
mistake. A member later demoted to `viewer` while holding an `rw` row is handled
at mint time too — see §3.3 — because demotion must not leave a live grant that
outranks the new role.

### 1.3 Routes

Registered in `core/session-shares.ts`, installed before `addWorkspaceRoutes` so
the literal paths win the match (`core/app.ts`'s existing ordering rule).

```
GET    /workspaces/:id/session-shares
PUT    /workspaces/:id/session-shares
DELETE /workspaces/:id/session-shares/:shareId
```

`GET` answers `{ granted: SessionShareView[], received: SessionShareView[] }`.

- `granted` — rows the caller may manage: their own as owner, or every row in the
  workspace if the caller is a workspace admin.
- `received` — rows whose grantee is the caller.

One route rather than three, because the two lists have exactly one client each
and both are read on the same screen: the share dialog reads `granted` for the
session it is open on, the rail reads `received` to decide which shared sessions
to draw. A `sessionId` query parameter narrows `granted` when the dialog asks.

`PUT` takes `{ sessionId, granteeMembershipId, level, ownerMembershipId? }` and
upserts on the unique key, so re-granting at a different level is the same call.
It answers `201` for a new row and `200` for a level change.

`DELETE` removes one row and then DRAINS — see §5.

### 1.4 Wire types

`SessionShareView`, `ListSessionSharesResponse` and `GrantSessionShareRequest`
are added to `packages/schema/src/workspace.ts` and copied into
`control-plane/core/wire.ts`, with the `expectTypeOf` equality assertions and the
fully-populated `SharedShape` literals `test/wire-drift.test.ts` requires. No
field is optional except `ownerMembershipId` on the request, which is what makes
the common case — an owner sharing their own session — a three-field body.

## 2. Routing a grantee to the owner's box

### 2.1 The problem

`core/workspaces.ts`'s `webApp` handler proxies to the REQUESTING member's
machine, and says so: "A workspace holds one VM per member now, so 'the
workspace's VM' is not a thing that exists; the ticket already names who is
asking." A shared session lives on somebody else's VM, so the grantee needs a way
to name a DIFFERENT member's machine, and the control plane needs a way to refuse
that when no grant backs it.

### 2.2 The shape: a distinct path prefix

```
/workspaces/:id/shared/:membershipId/webapp/7445/<surface>
```

beside the existing

```
/workspaces/:id/webapp/7445/<surface>
```

`:membershipId` is the OWNER's membership — the target. Everything after
`/webapp/` is unchanged, so `isWebAppSurfacePath` and the whole `webapp-surface`
contract apply byte-for-byte, and the resolver builds a grantee's endpoint set by
swapping one prefix.

Three alternatives were weighed and rejected:

- **A query parameter (`?target=`).** The query string is forwarded to the box
  verbatim, so a target parameter would arrive at dufs and at the bridge as
  noise, and it would have to be stripped in exactly one place or leak.
- **A request header.** Invisible in a log, invisible in a bug report, and the
  browser's `fetch` is not the only client — a WebSocket upgrade cannot set
  arbitrary headers from a browser at all, which alone disqualifies it for
  `/lody/sync`.
- **Inferring the target from the session id in the URL.** `/lody/sync` carries
  no session id: one connection serves every room the grantee joins.

A distinct prefix also has the property the other three lack: a caller who FORGETS
to name a target reaches their own box, which is the safe answer, rather than
silently reaching someone else's.

### 2.3 What the handler does

The shared handler is the same function as `webApp`, with the machine lookup and
the ticket claims parameterized:

1. Resolve the caller through `webAppWorkspaceForRequest`, exactly as today.
2. Read the caller's grants against `:membershipId` (§3.2). If the caller is a
   workspace admin, they hold `scope: "all"` whether or not rows exist.
   Otherwise, no rows means `403 no shared session on that member's machine`.
3. Resolve the TARGET's machine with the existing `machineFor(db, workspaceId,
   targetMembershipId)`. A destroyed or unprovisioned target machine is the same
   409 the own-machine path answers, worded for the target.
4. Mint the ticket with the `share` claim (§3).
5. Proxy, exactly as today.

The viewer guard is unchanged: a `viewer` still needs a VM booted from an image
with `webAppViewerGuardsSinceMs`, because the ticket they carry still says
`role: "viewer"` and the guest's own read-only enforcement is what backs it.

**The requester's own machine is never reachable through this prefix**, even by
naming your own membership id: the handler refuses `:membershipId ===
access.membershipId` with a 400 that names the other route. One address, one
meaning.

## 3. The ticket claim

### 3.1 Why additive, and what that costs

`webApp ticket v1` is a three-runtime pinned contract (CLAUDE.md): the control
plane mints it, the Go gateway verifies it, and the fixture corpus in
`packages/schema/fixtures/webapp-ticket/` is the source of truth for both. Its
verifier refuses an UNRECOGNIZED claim rather than ignoring one — `unknown-claim.json`
pins exactly that, and the reason is in its note: "a verifier that skips a field
it does not know cannot enforce it."

So the new claim is added as a RECOGNIZED optional claim on both sides, and
`unknown-claim.json` stays valid because `scope` at the top level is still not a
claim anybody knows.

The cost is real and is accepted deliberately: **a ticket carrying `share`
reaching a box image older than this change is REFUSED**, because that gateway's
`DisallowUnknownFields` sees a claim it does not know. That is fail-closed, and it
is confined to the sharing feature — an ordinary request mints no `share` claim
and keeps working on every image in the field. The provider capability that gates
this is `webAppSharedSessionsSinceMs`, and a share request to an older VM is
refused by the control plane with a message that names the fix ("shared sessions
arrive when that member's machine is recycled") rather than by a gateway 403
nobody can read.

**No provider advertises it yet, and that is deliberate.** The two cutoffs beside
it were each set when a specific image became the pin; the image carrying this
gateway has not been baked, so a cutoff in the past would mark every VM created
today as capable and hand a real member exactly the unreadable 403 the capability
exists to prevent. Undefined is "never", so sharing is refused everywhere until
phase 7 bakes the image and advertises it — which is the same "ship it dark, flip
it on canary" order `LODY-SESSIONS.md` §9 sets for the rest of this port. It is
the one line phase 7 must not forget, and `BOX_IMAGE_SHARED_SESSIONS_SINCE_MS`
says so where it is declared.

### 3.2 The shape

```ts
interface WebAppShareClaim {
  /** The membership whose machine this ticket is routed to. */
  target: string;
  /** "all" is a workspace admin's implicit read-only over every session on
   *  that machine. "sessions" is an ordinary grantee. */
  scope: "sessions" | "all";
  /** Session ids the ticket may READ. */
  read: string[];
  /** Session ids the ticket may also WRITE. Disjoint from `read`. */
  write: string[];
}
```

Exactly four keys, checked as an exact set the way the five top-level claims
already are.

**Why two arrays instead of one `level`.** A grantee can hold `ro` on one session
and `rw` on another on the same box, so a single level cannot describe a
connection. Two disjoint id lists describe it exactly, and the two ACL predicates
fall out with no branching:

- may JOIN room `doc:session-<id>` ⟺ `scope === "all" || id ∈ read ∪ write`
- may UPDATE room `doc:session-<id>` ⟺ `id ∈ write`

The second predicate does not mention `scope`, which is what makes the admin's
implicit access read-only BY CONSTRUCTION rather than by a rule somebody has to
remember. An admin who also holds a real `rw` grant gets that session in `write`
and everything else read-only, which is the right answer and needed no extra case.

**The cap is 64 ids.** A ticket rides in a request header and the mint is per
request; 64 uuid-shaped ids is roughly 3 KB of header, which is the last size that
is comfortably under every proxy default in the path. Beyond 64 the control plane
carries the 64 most recently granted and logs the truncation. This is a v1 limit
with a number, not a silent behaviour: `MAX_TICKET_SHARE_SESSIONS` is one
constant, and the day somebody has 65 shares from one member is the day it moves
or the claim learns to name a grant set by id instead.

### 3.3 What mint refuses

- A grantee whose workspace role is `viewer` gets every row demoted to `read`,
  whatever the row says. Demotion to viewer must not leave a live write grant, and
  the row is left alone rather than rewritten so a re-promotion restores it.
- `scope: "all"` is minted only for a workspace admin, and its `write` array is
  whatever real `rw` rows exist — never populated from the role.
- An empty ticket (`scope: "sessions"` with both arrays empty) is never minted;
  §2.3 step 2 has already answered 403.

### 3.4 Fixtures, on all three sides

`packages/schema/fixtures/webapp-ticket/tickets/` gains:

| Case | What it pins |
|---|---|
| `valid-share-ro.json` | a grantee ticket with one id in `read` and an empty `write` |
| `valid-share-rw.json` | mixed `read` and `write` on one ticket |
| `valid-share-admin-all.json` | `scope: "all"` with both arrays empty |
| `share-unknown-key.json` | an extra key INSIDE `share` is refused, like an extra claim outside it |
| `share-bad-scope.json` | `scope` is a closed set of two |
| `share-overlapping-ids.json` | an id in both arrays is refused rather than resolved |

`README.md` grows the claim's description. The conformance suites on both sides
(`control-plane/test/webapp-ticket-conformance.test.ts`,
`gateway/ticket_conformance_test.go`) read the corpus as they do today, so a case
added on one side and missed on the other fails.

The third runtime is the bridge, which does not verify tickets — it consumes the
claim the gateway hands it (§4.1). That hand-off is its own two-runtime contract
with its own corpus, `packages/schema/fixtures/lody-share-claim/`.

## 4. Enforcement on the box

The split is: **the gateway decides WHERE a request may go, the bridge decides
WHAT it may say.** The gateway is Go with no toolchain here and a compile that
only CI proves, so it gets the small, path-shaped half; the bridge is node,
already parses nothing, and is where the frame and body parsing has to live
anyway.

### 4.1 Gateway

Three changes:

1. `webAppTicketClaims` grows the optional `Share *webAppShareClaim` field, and
   `webAppCredential` validates it: exact key set, closed `scope`, disjoint
   arrays, non-empty `target`.
2. A ticket carrying `share` may reach `/lody/*` and NOTHING else. Not dufs, not
   `/preview/`, not `/terminal/ws`, not `/ports`, not `/diag`, not `/admin/drain`.
   §0.1's "nothing else on the owner's box" is one `if` at the top of `ServeHTTP`,
   and it is stated as an allowlist so a surface added later is refused until
   somebody thinks about it.
3. `serveLody`'s viewer refusal becomes: refuse a viewer WITHOUT a share claim.
   A viewer with an `ro` share is exactly what §0.1 asks to allow. The gateway
   then sets `X-Blitz-Lody-Share` on the upstream request to the compact JSON of
   the verified claim, after stripping any inbound copy — the same treatment
   `X-Blitz-WebApp-Token` already gets.

The header is set on the WebSocket upgrade too, which is where it matters most:
the bridge holds the claim for the life of that connection.

### 4.2 Bridge: the room ACL

The bridge stops copying bytes on `/sync` and starts parsing frames. That is the
change `plans/evidence/lody-phase1.md` and the two `TODO(lody-phase6)` markers
anticipated, and it is why `packages/schema/fixtures/lody-data-plane/` exists.

A connection with NO share header behaves exactly as today: every frame crosses
untouched, in both directions. The parsing cost is paid only by a shared
connection, and the owner's own path keeps its "dumb pipe" property.

For a connection WITH a share claim, each client frame is parsed with
`LocalLoroDataPlaneClientMessageSchema` and then judged:

| Frame | Policy |
|---|---|
| `ping` | always forwarded. Liveness belongs to the peers. |
| `leave`, `detach` | always forwarded. They only unsubscribe the sender. |
| `join` | forwarded iff the room is permitted (below). Otherwise NOT forwarded, and the bridge answers a `room_forbidden` `error` frame on the connection. |
| `update` | forwarded iff the room is a `doc` room whose session id is in `write`. Otherwise DROPPED SILENTLY and counted. |
| `machine-monitor` | never forwarded. It is machine-level telemetry, not session state, and no share carries it. |
| anything unparseable | dropped and counted, exactly as the corpus's `invalid/` cases require of every reader. |

Permitted rooms:

| Room | `scope: "sessions"` | `scope: "all"` |
|---|---|---|
| `doc:session-<id>` | iff `id ∈ read ∪ write` | yes |
| `doc:*` (task, preview-comment, session-comment) | no | no |
| `meta` | **no** | yes |
| `flock-doc:*` | no | yes |

`meta` is the interesting refusal. It is the workspace's document-metadata room,
and joining it hands over the id and title of every document on the owner's box —
which is the owner's whole session list, and precisely what "opt-in per session"
means to withhold. A workspace admin already holds implicit read-only on all of
them, so for `scope: "all"` the room leaks nothing they are not entitled to.

**An `update` is dropped, not refused.** A CRDT peer that is told its write failed
retries and then tears the room down; a peer whose write simply never lands keeps
a divergent local replica and re-converges from the owner's state on the next
sync. Read-only in a CRDT world is exactly "the relay does not apply what you
send", and the design in `LODY-SESSIONS.md` §4 says so. The counts are logged once per shared
connection when it closes, because silence would make "the grantee says nothing
lands" and "the grantee is not connected" the same log line.

**Server → client needs no filter.** The daemon addresses frames to the peers
subscribed to a room, and this bridge is one socket per browser connection, so a
room the grantee never joined has no path to them. That property is the reason
`ONE SOCKET PER CONNECTION` was chosen in phase 1, and it is now load-bearing.

### 4.3 Bridge: RPC scoping

`/rpc` (machine RPC) is the only door a grantee needs beyond `/sync`, and every
method on its union except `file/preview` and `file/preview-local` carries
`params.sessionId`. So the rule is two conditions, not a per-method table of
special cases:

1. the method is on the level's allowlist, and
2. `params.sessionId` is in the permitted set (`read ∪ write` for a read method,
   `write` for a write method; `scope: "all"` reads anything).

| Level | Methods |
|---|---|
| read | `code-collab/get-file-index`, `code-collab/open-text`, `code-collab/refresh-text`, `code-collab/open-current-diff`, `code-collab/open-all-changes-diff`, `code-collab/open-turn-diff`, `code-collab/lsp-definition`, `code-collab/lsp-references` |
| write (adds) | `session/cancel`, `session/steer`, `session/dispatch-turn` |
| never | `file/preview`, `file/preview-local` (no session id, arbitrary paths), `code-collab/save-text`, `code-collab/init-directory` (writes to the worktree, which §0.1 grants READ access to), `session/fork`, `session/edit-and-resend`, `session/prepare`, `session/prepare-cancel`, `session/terminate`, `session/preview-endpoint-acquire`, `session/preview-endpoint-release` |

`session/terminate` is on the never list on purpose: an RW co-driver may cancel a
TURN, which is what §0.1 says, and killing the session's agent process is not the
same act.

The other three doors:

| Door | With a share claim |
|---|---|
| `/control` (session control) | refused entirely. Everything read-write needs is on `/rpc`; `session/create` would create a session on someone else's box, and `session/file-send-local` would write bytes into the owner's `/workspace`. |
| `/project` (local-project control) | `worktree/list-files` and `worktree/read-file` only, and only for a permitted session id. That pair IS the "read access scoped to that session's worktree" §0.1 grants. Every `local-project/*` request names a PROJECT, not a session, so none can be scoped and all are refused. |
| `/platform` | served NARROWED: `identity`, `workspaces` and `machine`, and nothing else. This is the `TODO(lody-phase6)` at the top of the bridge — the daemon's catalog also names every session on the box. The OWNER's request is still served byte-for-byte, so the projection is a share-only act and its fixture pair lives with the claim's. |

**Answering a permission request is not on any of these lists, and that is
correct.** Upstream brokers permissions entirely through the session document:
the daemon writes `permissionRequest` onto the tool-call history item
(`apps/cli/src/lib/acp/history.ts:1244`), any peer writes
`permissionRequest.outcome`, and the daemon's subscription picks the change up
(`apps/cli/src/lib/message-handler.ts:8336` states the whole loop in a comment).
So an RW grantee answers by writing to `doc:session-<id>`, which §4.2 already
permits, and an RO grantee's answer is dropped by the same rule that drops every
other write. No new door, and no permission-specific code anywhere in BlitzOS.

**First response wins is the daemon's, and it already holds.**
`resolveWithOutcome` guards on a local `resolved` flag and `checkForOutcome`
fires on the first mirror tick carrying any outcome (`message-handler.ts:8541`,
`:8643`), so whichever write the daemon observes first is what the agent is told;
a later write is ignored because the promise is already settled. The CRDT register
underneath is last-write-wins, so the two clients may briefly disagree about what
was clicked — but not about what the agent was told. That is upstream's
behaviour, BlitzOS adds no arbitration, and phase 6's exit test asserts the agent
side of it rather than the display side.

### 4.4 The gateway → bridge contract

`X-Blitz-Lody-Share` is a payload crossing Go → node, so it is a cross-runtime
contract under CLAUDE.md and gets `packages/schema/fixtures/lody-share-claim/`:
the header's JSON encoding, and a table of ACL decisions (frame or request ⇒
allowed / dropped / refused) that both the Go producer test and the bridge
consumer test read. The `lody-data-plane` corpus is extended with the
`room_forbidden` error frame the bridge now emits, synthesized from the schema
and labelled as such the way `room-status-reconnecting.json` already is.

## 5. Revoking

Three things must happen, and only the first two are in the delete handler:

1. **The row goes.** The next mint sees no grant and answers 403.
2. **The live connection is severed.** The gateway already tracks every hijacked
   connection by identity and closes them on `POST /admin/drain` with
   `{"membershipId": ...}`; nothing in the control plane has ever called it. The
   delete handler now does, against the OWNER's machine, naming the grantee. A
   failed drain does not fail the revoke — the row is already gone, so the
   grantee's next connect is refused either way — but it is logged, because the
   difference between "revoked" and "revoked and disconnected" is a minute of a
   live session.
3. **Nothing is cleaned up on the box.** The grantee's browser holds a CRDT
   replica of the session document, and it will keep it until the tab closes.
   That is inherent to a local-first replica and is not a hole this design can
   close: what revocation stops is receiving further updates and sending any.

The 60-second ticket TTL is what bounds the gap for a request-shaped door; the
drain is what bounds it for the WebSocket, which is checked once at upgrade.

## 6. The grantee's runtime — the hard question

### 6.1 What was measured

Lody's renderer supports many machines per workspace, but not many LOCAL machines.
Measured against the vendored tree:

- `attachLocalLoroDataPlaneTransport` (`create-workspace-runtime.ts:2669`) has a
  `transportAttached` once-only guard and registers the transport under the
  literal id `'local'`.
- `createLocalLoroDataPlaneConnection` (`local-loro-data-plane-connection.ts:4`)
  **takes no arguments at all**: it reads the process-global `getIpcServices()`,
  which is `window.ipc`.
- `WorkspaceTargetPlane` is `'local' | 'cloud'`
  (`workspace-target-router.ts:15`), and `resolveTransportRoute` can only ever
  emit those two ids.
- `canUseLocalMachineRpc` (`workspace-machine-rpc-facade.ts:116`) reaches the same
  single global, and the `machineId` in the payload selects nothing about the
  transport.

So "mount the owner's box as a second machine" needs four vendor changes, three of
them structural (parameterize the connection, lift the once-only guard and give
transports per-machine ids, widen the plane enum). That is larger than the rest of
phase 6 combined, and `LODY-SESSIONS.md` §5.3's patch policy exists precisely to
stop a change of that size landing inside `vendor/`.

The transport itself is not the obstacle: `LocalLoroTransportAdapter` already
takes its `connection` as an injected dependency, and BlitzOS's own bridge is
already parameterized by `LodyLocalBridgeEndpoints`. A second bridge pointed at a
second box is constructible today. What it cannot do is install itself anywhere
the vendored renderer will look, because the renderer looks in exactly one place.

### 6.2 The decision

**Phase 6 ships the owner's half and the enforcement, and defers the grantee's
mounted surface.** Concretely:

- The control plane, the ticket claim, the target-member route, the gateway and
  the bridge ACL all ship and are proven end to end against two ticket identities
  and a real daemon (§7). Those are the four exit tests that decide whether the
  feature is SAFE, and they do not need the vendored renderer to be involved: a
  protocol-v7 client is a first-class peer, and BlitzOS already owns one
  (`webapp/src/lody/data-plane-connection.ts`).
- The owner-side UI ships: right-click Share on a rail session row, and a native
  BlitzOS dialog to grant and revoke.
- The grantee-side surface — a shared session appearing in the grantee's rail and
  opening against the owner's box — is a scoped follow-up, written up in §8.

This is the escape hatch the phase brief names, taken for the reason it names.
Shipping a half-mounted grantee surface would mean either a large vendor fork or a
BlitzOS re-implementation of the session page, and §0's bias rule forbids the
second as firmly as §5.3 forbids the first.

### 6.3 What the follow-up will most likely do, and why it is not free

The smallest thing that satisfies the product without touching `vendor/` is to
mount the surface against ONE box at a time: opening a shared session tears down
the runtime and rebuilds it with the owner's endpoint set, so the renderer still
sees exactly one local machine and needs no change at all. It costs a second
WebSocket, a second IndexedDB repo and a second WASM instance per switch, and it
means the rail cannot show the grantee's own sessions and their shared sessions in
one live list — the shared rows would come from the control plane's `received`
list plus a cheap read of the owner's box, not from the local session mirror.

Whether that is the right product answer, or whether the four upstream changes in
§6.1 are worth opening as a PR, is the decision the follow-up starts with. It is
recorded here rather than guessed at, because the measurement above is the
expensive part and it is done.

One thing the follow-up must not forget: with `scope: "sessions"` the grantee
cannot join `meta` (§4.2), and `LoroRepo` uses that room for document metadata.
Either the shared surface opens a doc it already knows the id of without meta, or
the ACL grows a per-document meta projection. That is the first thing to measure.

## 7. Exit tests

Two ticket identities against one daemon, one real bridge and a gateway stand-in
that verifies claims the way `main_test.go` proves the real one does.

| # | Test | Where |
|---|---|---|
| 1 | an RO grantee joins a granted session's room, receives its updates, and its own `update` frames are dropped at the relay | `webapp/test/lody-sharing-relay.test.ts` |
| 2 | an RW grantee's `update` is forwarded, and a permission request answered by the RW grantee is the one the agent receives | same file, live half behind `BLITZ_LODY_LIVE_TURN=1` |
| 3 | revoke: the next mint refuses, and `/admin/drain` closes the live connection | `control-plane/test/session-shares.test.ts` + the relay test |
| 4 | a workspace admin with no grant row mints `scope: "all"` and reads every room | both files |
| 5 | the rail's Share item opens the dialog, and the dialog grants and revokes | `webapp/test/lody-session-rail.test.tsx` (the item) + `webapp/test/session-share-dialog.test.tsx` (the dialog) |

The live-turn budget is two, both reserved for test 2. Everything else is free:
the relay ACL is a property of frames, and a frame costs nothing.

*(§9.1 is what those tests actually measured. The live half of test 2 was NOT
spent, and §9.1 says exactly what that leaves unproven and when it is worth
buying.)*

## 8. Follow-up, precisely scoped

**"Mount a shared session in the grantee's browser."** Everything the control
plane, the gateway and the bridge need is done and tested; a protocol-v7 peer
already follows a shared session end to end (§9.1). What remains is the browser
half:

1. Decide between the one-box-at-a-time remount (§6.3) and the four upstream
   changes (§6.1). Measure the `meta`-room question first — it may decide it.
2. `webapp/src/resolver.ts` grows a shared-endpoint builder over the
   `/workspaces/:id/shared/:membershipId/webapp/7445` prefix. One function.
3. The rail gains a "Shared with you" section. `LoroSidebar`'s
   `afterSessionListContent` already hosts a second `SessionList` (Terminals is
   one), and `SessionListRow` is a plain data type with no provenance check, so
   the rows themselves need no vendor change.
4. Opening one of those rows drives the surface at the owner's box, by whichever
   answer step 1 gives.
5. The exit tests that need a mounted grantee, and the live turns to spend on
   them: an RO grantee sees the transcript render and the diff view open; an RW
   grantee sends from the real composer and answers a permission request the
   agent then acts on. That last one is the only claim phase 6 makes on paper
   rather than in a test, and it is one turn (§9.1).

## 9. What building it measured

Written after the code, in the form `LODY-RUNTIME-DESIGN.md` §7–§10 use: what
this document said, what shipped, and why.

| # | This document said | What shipped | Why |
|---|---|---|---|
| 1 | §8 step 3: a "Shared with you" section needs `afterSessionListContent` and rows a host builds | Not built, and the OWNER's affordance needed no new prop either | `SessionList` already draws a Share entry in its row context menu, gated on the row carrying a `sharing` state and the list carrying `onShareSessionWithTeam` (`session-list.tsx:820`, `:1134`), and the row's "⋯" opens that same menu by synthesizing a `contextmenu` event (`sidebar-row-shared.tsx:507`). So right-click Share is two props and **no vendor hunk** — the "minimal upstreamable extra-menu-items prop" the brief allowed for was not needed. |
| 2 | §4.2: the bridge parses frames | …only for a SHARED connection | The owner of the box keeps the phase-1 dumb-pipe path byte for byte, so the parsing cost and the parsing RISK are paid by the share alone. `lody-bridge-share.test.ts` asserts it directly: every frame the corpus refuses or drops for a claim is forwarded untouched without one. |
| 3 | §4.3: `/platform` is served narrowed | …for a shared request only | The owner's request is still `fs.readFileSync` piped out byte for byte, which is what keeps that response Lody's contract rather than ours. The narrowing is a projection BlitzOS authors, so it — and only it — has a fixture pair. |
| 4 | — (not anticipated) | The Go struct that DECODES the ticket also ENCODES it in the gateway's own tests, so `Share json.RawMessage` needed `omitempty` | Without it a nil claim marshals as `"share": null`, every test ticket carried one, and the parser refused all of them. The failure is loud and instant, which is the good case; the interesting part is that it only exists because one struct plays both roles. |
| 5 | — (not anticipated) | `packages/box/gateway`'s Go suite had been RED, and CI does not run it | One case there deliberately requests a path that is not a lody door, which falls through to dufs — and the test's handler had no dufs proxy, so it panicked the whole suite. CI runs `go test` for `packages/broker` only; the gateway is compiled by the box-image build, which does not run its tests. Fixed in passing (a proxy at an invalid host), because phase 6 needed the suite to mean something. |
| 6 | §3.2: the cap is 64 session ids | Unchanged, and now stated in two places that must agree | `MAX_TICKET_SHARE_SESSIONS` in `core/webapp-tickets.ts` and `maxTicketShareSessions` in `main.go`. The corpus does not pin it — a 65-id fixture would be 3 KB of noise — so the two constants carry a comment naming each other, which is the weakest link in this contract and is recorded here as such. |
| 7 | §3.1: `webAppSharedSessionsSinceMs` is "set the way `webAppViewerGuardsSinceMs` already is" | Declared, and advertised by NO provider | Those cutoffs are historical facts — the moment a specific image became the pin. The image carrying this gateway has not been baked, so a cutoff in the past would mark every VM created today as capable and produce exactly the unreadable 403 the capability prevents. Shipped dark instead; phase 7 advertises it with the bake. |
| 8 | — (not anticipated) | A daemon-backed suite's `beforeAll` timeout is part of the lock's contract | The harness lock serializes those suites and now waits up to 900 s, so a 180 s boot hook fires on QUEUEING rather than on anything being wrong — which is how the relay suite first failed. `HARNESS_BOOT_TIMEOUT_MS` is the lock's wait plus a suite's own boot, and it is exported so the two numbers cannot drift apart. |

### 9.1 Exit tests: what is proven, and what is not

**Proven, free, gating every merge:** the grant/revoke routes and their authority
rules, including the viewer demotion at mint time and the admin's `scope: "all"`
with no row (`control-plane/test/session-shares.test.ts`); the ticket claim on
both verifiers, including the two shapes the two parsers could have disagreed
about (`fixtures/webapp-ticket/`, both conformance suites); the gateway's path
allowlist, its header forwarding and its stripping of a forged inbound copy
(`gateway/main_test.go`); the whole relay ACL, frame by frame and door by door,
against the real bridge script (`box/guest-tests/test/lody-bridge-share.test.ts`);
and the share dialog's read, grant, revoke and viewer refusal
(`webapp/test/session-share-dialog.test.tsx`).

**Proven, free, against a REAL daemon** (`webapp/test/lody-sharing-relay.test.ts`,
daemon-gated like every other phase's): a read-only grantee joins the owner's
session room and reads the transcript out of it; its own write does not reach the
owner's replica while a read-write grantee's does; a workspace admin reads every
room with no grant row and still writes none; a room the claim does not name is
refused terminally; and a granted session's diff RPC is routed while
`session/cancel` on the same session is refused.

**Proven, free, with a daemon** (`webapp/test/lody-session-rail.test.tsx`): the
Share entry appears on a session row's own context menu and reports the session
id.

**NOT proven, and named rather than implied:**

- **A grantee's MOUNTED surface.** §6.2's decision. What a protocol peer proves
  is the relay and the claim; what it cannot prove is a rendered transcript in
  somebody else's browser, because that needs the runtime work §8 scopes.
- **The permission answer, live.** The mechanism is a CRDT write into
  `doc:session-<id>` and nothing else (§4.3), and the relay test proves that
  exact write lands for a read-write claim and is dropped for a read-only one.
  What a paid turn would add is that the DAEMON accepts an outcome authored by a
  non-owner peer and that its first-response-wins guard behaves as the shipped
  bundle reads. That is a real gap and it is worth a turn the day the grantee
  surface mounts, when the same turn also buys the rendered card.
- **The drain, against a real gateway.** `control-plane/test/session-shares.test.ts`
  proves the control plane calls `/admin/drain` with the grantee's membership
  when the last grant goes, and `gateway/main_test.go` proves the gateway closes
  the matching connections. Nothing runs both halves together, because the Go
  gateway has no toolchain in this tree and the harness's shim is not it.

---

## 10. Phase 7: the grantee's mounted surface (2026-08-30)

§8's five steps, built. What follows is what they measured, in the form §9 and
`LODY-RUNTIME-DESIGN.md` §7–§11 use.

### 10.1 The `meta` question, measured first — and it decided the approach

§8 step 1 says to measure the `meta`-room question before choosing between the
one-box-at-a-time remount (§6.3) and the four upstream changes (§6.1), because
"it may decide it". It did, and it decided a third thing neither option named.

**Measured, against a real `lody@0.88.1` daemon** (the probe stood the phase-2
harness up, created two sessions, and joined `{scope:"meta"}` as a plain
protocol-v7 peer):

| # | Question | Answer |
|---|---|---|
| 1 | Can a shared surface open a document it already knows the id of, without `meta`? | **No.** `SessionMeta` — title, project, `machineId`, status, diff stats — is document METADATA, not document body. `joinDocRoom(docId)` carries the body alone; `repo.getDocMeta` reads the meta flock and nothing else, and `docMetaSubscriptionAtom` (`atoms/doc-meta.ts:508`) is the only writer of `sessionMetaCacheAtom`. A grantee refused `meta` has a transcript with no session around it, and `isMachineRemoved` (`session-chat-interface.tsx:2074`) is `true` because the machine document is metadata too — which disables the composer even for a read-write grant. |
| 2 | Does a refused `meta` join break the runtime? | No. `ensureMetaRoomSynced` (`create-workspace-runtime.ts:2954`) catches the join failure, marks the sync failed and RETURNS. So the failure mode is silent and partial, not loud — which is worse for a reader, and is why this needed measuring rather than guessing. |
| 3 | What does the `meta` room actually put on the wire? | **Plain JSON.** The payload kind is `flock-json`, a `{version, entries}` bundle. Keys are JSON-encoded paths: `["e",<docId>]` for an existence record, `["m",<docId>,<field>]` for one metadata field, `["ef",<flockDocId>]` for a Flock doc's. Values are `{c: <clock>, d: <value>}`. |
| 4 | Are the entries independently importable? | Yes, and upstream already depends on it: `chunkFlockBundle` (`shared/src/local-loro-data-plane.ts:408`) splits an oversized bundle by repartitioning `entries`, and its comment says "Flock entries are self-contained LWW records, so every bundle — including one chunk of a split oversized delta — is independently importable." |

Answers 3 and 4 are the finding. §6.3's note said the follow-up must "either open
a doc it already knows the id of without meta, or grow a per-document meta
projection", and read the second as the expensive branch. It is the cheap one:
**the projection is a JSON filter over `entries`, so no CRDT is parsed and no
loro build is needed on the box.**

### 10.2 The decision

**One box at a time (§6.3), plus a per-document `meta` projection at the bridge.
The four vendor changes of §6.1 are NOT taken, and stay not taken.**

- Opening a shared session tears the runtime down and rebuilds it against the
  owner's endpoints, keyed by the owner's membership. The renderer therefore
  still sees exactly one local machine, which is the whole reason §6.1's four
  changes existed.
- **EXACTLY ONE SURFACE IS MOUNTED AT A TIME, and that is not a preference.**
  Phase 7 first built two — the grantee's own surface hidden but alive, so the
  rail kept its session list — and it does not work, because `window.ipc` is one
  global and `sendIpc` re-reads it on EVERY call
  (`lib/electron-ipc-client.ts`). A second mounted surface does not get a second
  bridge; it takes the first one's. Measured, not reasoned about: with both
  alive, the OWNER's own `session/dispatch-turn` came back `share_forbidden`,
  having been routed to the grantee's endpoints. §6.1 called the singleton a
  reason not to mount two machines in one runtime; it is equally a reason not to
  mount two runtimes in one document.
- So §6.3's cost is paid as §6.3 wrote it: the rail's vendored zone lists
  whichever box is mounted. What keeps that navigable is that the native
  sections — "Shared with you" and Terminals — are PROPS, so they follow the
  mount, and "+ New session" goes back to the grantee's own landing.

What the projection keeps, and what it withholds, is a fixture table rather than
prose: `packages/schema/fixtures/lody-share-claim/decisions.json`,
`metaProjections[]`. In one line: the granted sessions' records, plus the machine
document with `sessions` emptied and `localProjects` withheld.

Three consequences, each recorded because each is a place the design changed:

1. **§4.2's `meta` row is superseded.** The room is `read` for BOTH scopes now,
   not admin-only.
2. **`meta` is write for a THREE-FIELD allowlist and nothing else.** The first
   answer here was "write for nobody", on the reasoning that §0.1's verbs are all
   session-document writes or machine RPCs. That is wrong about one of them, and
   a live turn is what showed it: `latestUserMsgId` is the DURABLE DISPATCH
   POINTER (`use-session-actions.ts:858`), so a co-driver who may prompt must be
   able to write it or their prompt lands in the document and nothing runs it.
   The allowlist is `latestUserMsgId`, `lastMissingHistoryUserMsgId` (cleared in
   the same patch) and `lastMessageAt`. `title`, `isArchived`, `isPinned`,
   `agentConfigId`, `status` and `project` stay withheld — renaming and archiving
   somebody else's session are not on §0.1's list — so an RW grantee's rename
   converges away rather than landing, and the relay's ACL is what says so.
3. **§4.2's "server → client needs no filter" now has exactly one exception.**
   The reasoning held and still holds for every other room: the daemon addresses
   frames to the peers subscribed to a room, and a grantee never joins one the
   claim does not name. `meta` is the exception because the grantee does join it,
   so a shared connection's server frames are parsed on the way out. An unshared
   connection is still the phase-1 dumb pipe, byte for byte, and
   `lody-bridge-share.test.ts` asserts that with the same frame.

### 10.3 What the grantee's surface needs beyond the projection

| Need | Where it comes from | Note |
|---|---|---|
| the daemon identity, workspace and machineId | `/lody/platform`, already narrowed for a share (phase 6) | The grantee's surface therefore authors CRDT writes as the OWNER's daemon user id. That is required, not incidental: `createLocalCloudPort`'s access oracle (`platform/src/local.ts:103`) allows exactly that id, so a BlitzOS identity here is refused at dispatch. Attribution inside the document is cosmetic; the relay is what authorizes. |
| the session's title, for the rail row | one `join {scope:"meta"}` on the owner's box, read as JSON | `webapp/src/lody/shared-sessions.ts`. No `LoroRepo`, no WASM, no IndexedDB: the bundle is JSON and the titles are `["m","session-<id>","title"]`. This is also the cheapest possible proof that the projection works, and it runs on every rail render. |
| the composer's model / mode / effort selectors | **nothing — they are absent** | Those are `acpCapability` rows in the machine FLOCK, and `flock-doc` stays admin-only because the same document carries the owner's registered local projects. An RW grantee's composer therefore sends with the session's own last configuration (`resolveSessionConversationConfig` reads the session document, not the flock) and offers no selector. Named here rather than discovered later. |
| the agent-config bootstrap | **skipped** | It writes to the owner's machine Flock, which the ACL refuses. `SessionSurface` takes `shared` and does not mount `LodyAgentConfigBootstrap` under it. |
| the durable dispatch pointer | the metadata write allowlist (§10.2 item 2) | Found by a live turn, not by reading. |

**The one follow-up this scopes.** Letting a grantee read the machine FLOCK
through the same kind of projection — keep `agentConfig`, `agentConfigIndex` and
`acpCapability`, withhold `localProject` and the command families — would give an
RW co-driver their model, effort and permission-mode selectors back. The room's
payload is the same `flock-json` shape, so the code is the same JSON filter. It
is not phase 7 because nothing in §0.1 needs it: a co-driver's send inherits the
session's own last configuration, which is the owner's.

### 10.4 Read-only had to become a vendor prop

There is no read-only mode upstream: every member of a Lody workspace may drive
every session they can see, so `SessionChatInterface` has no notion of a viewer.
The composer's existing suppressions are `isArchivedSession` and
`isMachineRemoved`, and borrowing either would put a false statement on the
screen — the session is neither archived nor on a removed machine.

So phase 7 adds **seam patch 4**: `readOnly?: boolean` on `SessionDetail` and on
`SessionChatInterface`, in the same shape as their existing `hideHeader` /
`hideMessageArea` props. It suppresses the composer and the permission card's
buttons, and nothing else. Four hunks in two files, strictly additive, drafted
upstream at `plans/evidence/lody-readonly-prop-pr.md`, recorded in
`vendor/lody/BLITZ-PATCHES.md`. The expected vendor file count moves from five to
seven.

The alternative considered and rejected was a CSS rule of ours hiding their
composer. It needs a selector their markup does not offer — the composer's shell
class is computed by `getSessionChatInputAreaShellClassName` out of tailwind
utilities — so it would key off layout position and break silently at the next
merge, which is the failure mode `BLITZ-PATCHES.md` exists to prevent.

### 10.5 Exit tests: what is proven, and what is not

| # | What | Where |
|---|---|---|
| 1 | the projection — every entry kind, both scopes, the metadata write allowlist, and an unshared connection's bytes unchanged | `box/guest-tests/test/lody-bridge-share.test.ts` (free) |
| 2 | the shared endpoint builder and the shared chat address round-trip, with the rail's title reader pinned to the bridge's own corpus | `webapp/test/lody-shared-endpoints.test.ts` (free) |
| 3 | the rail's "Shared with you" section: a row per received grant, its level, its title off the owner's box, and what a click resolves to | `webapp/test/lody-shared-rail.test.tsx` (free) |
| 4 | a grantee reads a real session's title out of the projected meta room and cannot read an ungranted one's; an admin reads both | `webapp/test/lody-sharing-relay.test.ts` (daemon-gated, free) |
| 5 | the grantee's MOUNTED surface: another member's session renders — title, transcript — from their box, with a composer for `rw` and none for `ro` | `webapp/test/lody-shared-surface.test.tsx` (daemon-gated, free) |
| 6 | an RW grantee answers a permission request through the rendered card, and the agent acts on it | same file, behind `BLITZ_LODY_LIVE_TURN=1` |

**Proven live (three paid turns).** Each bought a finding the free path could not
reach, and the last one did not finish.

| Turn | What it bought |
|---|---|
| 1 | **The daemon cancels a permission request when no peer is on the room.** With the turn dispatched before the grantee's surface mounted, the daemon held its turn history writes waiting for the user turn to sync, gave up after 20 s, and then cancelled the request itself: "could not be attached to an active assistant entry; cancelling to avoid waiting for an unobservable permission outcome". The agent asks and nobody can answer. So the order is load-bearing: **attach, then dispatch** — and the dispatch has to be plain HTTP to the owner's own `/rpc`, because the owner's runtime cannot be alive at the same time as the grantee's surface (§10.2). |
| 2 | **The card renders on a grantee's mounted surface, for a turn another member dispatched.** Seen: `Permission Required`, `Write GRANTEE_ANSWERED.md`. This is the claim phase 6 made on paper and §9.1 named as unproven. The turn also found the `latestUserMsgId` hole in the metadata ACL (§10.2). |
| 3 | **The card's real options, and where they live in the DOM**: `Deny`, `Allow Once`, `Always Allow`. The card's header and its body are separate children, so "the last element containing the header text" is the header, which has no buttons — which is why turn 3 clicked nothing. |

**NOT proven, and named rather than implied: the answer's round trip.** That the
daemon accepts a permission outcome authored by a non-owner peer, and that the
agent then acts on it, is still unmeasured. Turn 2 clicked an approval and the
daemon did not act inside five minutes; turn 3 reproduced the card but the test's
own selector never reached a button. The two are not distinguishable from here:
the selector is now fixed, and whether what remains is a relay problem or was
only ever the selector is one run away.

The mechanism itself is proven everywhere else it can be: the outcome is a plain
session-document write (`workspace-writer-impl.ts:151`), `lody-sharing-relay.test.ts`
proves that exact write lands for a read-write claim and is dropped for a
read-only one, and `lody-bridge-share.test.ts` proves the relay forwards it. What
a fourth turn would add is the daemon's side of it. The assertion is written and
gated in `lody-shared-surface.test.tsx`; the phase-7 budget was two turns and
three were spent, so it stops here.

One flake worth recording for whoever spends that turn: **the card is gated on
PRESENCE** (§8.6), and presence lapses. Between turn 2 and turn 3 the same card
was present in one run and gone in the other at the same point. Poll for it
rather than reading once.
