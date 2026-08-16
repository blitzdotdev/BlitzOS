# Files: the org file library and Drive-like folder sharing

Written 2026-08-16. Answers [TODO.md](TODO.md)'s "share some folder/file …
Google-drive like last-edit is saved model" bullets. Consumes the identity
invariants from [IDENTITY.md](IDENTITY.md) (membership grantee, the
`(resource, membership, role)` grant pattern, CP as chokepoint). Model B1
(org file library) with B2 (workspace materialization) as the follow-on.

## The forcing facts

- Workspace files live on VM disk under one `blitz` Unix user and die with
  the workspace. Drive-like sharing needs a home that outlives workspaces.
- The control plane already binds D1 and R2. R2 speaks the S3 API and has
  zero egress fees. The storage home exists; no new vendor.
- **Revocation is immediate, with zero credential lifetime** (decision,
  shared with workspace sharing in IDENTITY.md). No token, URL, or
  credential handed to a client may outlive its grant. This single rule
  fixes the transfer architecture below.

## Decisions

- **The share unit is a folder.** Files inherit access from their folder.
  No per-file grants, no nested grant inheritance in v1 — a folder is the
  grantable root, arbitrary paths exist inside it. (Early-Dropbox shape.)
- **Last-write-wins is the sync model.** "Last-edit is saved", literally:
  newest mtime replaces. No CRDTs, no merge, no lock. Two agents editing
  one file clobber each other; accepted and documented.
- **Every byte passes the CP.** All transfers are CP routes streaming
  through the R2 binding; every request checks the grant first. Revoke
  deletes the grant row and the very next request 403s. Nothing is
  pre-authorized, so nothing survives revocation. (A request already
  in flight when the revoke lands completes — standard semantics; no NEW
  request is ever authorized after the grant dies.)
- **Small files are one streamed request; big files are chunked
  multipart through the CP.** The client slices under the Workers
  request-body cap (~100–200 MB by plan tier); the CP drives R2's
  standard multipart API. Every chunk is a fresh request with a fresh
  grant check — revoke halts a transfer mid-file at the next chunk. Max
  file size is then set by R2's part-count limit, not by Workers:
  hundreds of GB in practice.
- **No guest sync agent.** B2's sync loop runs in the CP against the
  guest's existing WebDAV files surface (details below). This cuts a
  custom binary, a box-image re-pin, and a whole new cross-runtime
  contract; revocation also simplifies, because the syncer is CP code
  that just stops.
- **Rejected: presigned URLs** (and any approve-once-transfer-elsewhere
  scheme). A presigned URL is a bearer capability; R2 honors it without
  consulting the CP, so its expiry window outlives a revoke.
  Structurally incompatible with zero credential lifetime.
- **Rejected: rclone + R2 temporary access credentials.** Same disease,
  longer incubation: standing S3 credentials stay valid until TTL after a
  revoke, and R2 has no verified early-revocation for issued temp
  credentials. Recorded so nobody re-litigates without new facts.
- **The Worker in the data path is cost-noise** (estimate 2026-08-16, at
  300 MB + 200 transfers/user/day, 5-minute sync ticks, 10 GB/user
  stored): total ≈ $9/mo at 20 active users, ≈ $115/mo at 500, ≈
  $1,120/mo at 5,000 — and the Worker request+CPU share of that is $0,
  ~$2, ~$27 respectively. R2 operations and storage dominate and are
  identical under any transfer design; Workers bill CPU-ms, not bytes or
  duration, and R2 egress is free. Re-check the price sheet at
  implementation time.
- **No protocol engineering.** Plain HTTPS + JSON routes, the R2 binding
  (including its standard multipart API), and the guest's existing WebDAV
  surface. The only "engine" we write is a trivial LWW compare loop in
  the CP (B2).
- **No per-file metadata table.** D1 stores folders and grants only. File
  listings come from R2 `ListObjectsV2` through the CP. No index to keep
  consistent with the bucket. If cost or search later demands an index,
  R2 event notifications can feed one; additive, not v1.
- Cost lever, not v1: list polling dominates R2 op cost; when that bill
  matters, add a folder version counter (a column added then, not now)
  so sync ticks skip unchanged listings with one D1 read.

## Schema (one migration, `0010_files`)

Same three-places rule as identity: migration + `build-blitzdev.mjs`
table defs + `blitzdev-schema.test.ts` exact-set assertions.

```
folders        id, org_id, name, created_by_membership_id,
               created_at, updated_at
folder_grants  id, folder_id, membership_id,
               role CHECK('editor','viewer'),
               granted_by_membership_id, created_at,
               UNIQUE(folder_id, membership_id)
```

- Object keys: `org/<orgId>/<folderId>/<relative-path>`. The prefix is the
  authorization boundary; no route ever reads or writes across it.
- Object metadata: `x-amz-meta-mtime` (LWW input), `x-amz-meta-edited-by`
  (set server-side — the CP handles every write, so it always knows the
  actor it authenticated).
- Creator's membership gets an implicit owner role (same convention as
  workspaces: owner + org admin control; grants add editor/viewer).
- Folder viewer is real in v1 (unlike workspace viewer): read-only is
  pure CP route logic — GET allowed, PUT 403 — with no guest enforcement
  involved.
- Folder delete removes grants, then objects by prefix, then the row.
  (Folders are CP-owned rows with no VM lifecycle — no tombstones.)

## Routes

All routes: cross-org → 404, same-org without a grant → 403 (IDENTITY.md
convention). Every route re-checks the grant; there is no other path to
the bucket.

| Route | Auth | Behavior |
|---|---|---|
| `POST /folders` | active membership | create; creator = owner |
| `GET /folders` | active membership | org list, role-annotated per row |
| `DELETE /folders/:id` | owner-or-admin | grants, objects, row |
| `POST /folders/:id/grants` | owner-or-admin | editor or viewer |
| `DELETE /folders/:id/grants/:gid` | owner-or-admin | **immediate**: next request 403s |
| `GET /folders/:id/objects` | any grant | R2 `ListObjectsV2`, paginated |
| `GET /folders/:id/objects/:key` | any grant | stream from R2 binding |
| `PUT /folders/:id/objects/:key` | editor+ | stream to R2 binding (small files) |
| `POST /folders/:id/objects/:key/multipart` | editor+ | create multipart upload |
| `PUT /folders/:id/objects/:key/multipart/:uploadId/:part` | editor+ | one chunk, grant-checked per chunk |
| `POST /folders/:id/objects/:key/multipart/:uploadId/complete` | editor+ | assemble |

## Sync up/down (B2 — after B1 proves the store)

- Explicit attach: "add folder to workspace" materializes it at
  `/workspace/shared/<name>`. **No auto-sync into every workspace** — that
  multiplies transfer and conflict surface unasked. An "auto" flag can
  come later. (This answers TODO.md's "decide:" question: no.)
- **The CP drives the sync; the guest runs nothing new.** The guest
  already serves workspace files over WebDAV — the webapp files panel
  uses that surface today (`webapp/src/CloudApp.tsx:415`,
  `FilesSidebar.tsx:257`, `FileEditor.tsx:242,379`). The syncer is CP
  code: on a tick (cron, plus an immediate pass after webapp-side
  writes), list R2, `PROPFIND` the guest through the existing
  authenticated proxy path, compare `(mtime, size)`, copy the newer side.
  `--update` semantics in both directions.
- Stateless: no state files, no rename tracking, and **no delete
  propagation in v1** (a one-sided delete reappears on the next tick;
  delete via webapp for real removal; documented). Add sync state only
  when delete propagation becomes a requirement.
- Freshness is one tick for guest-side edits; webapp edits push at once.
  If that lag ever matters, the upgrade is a ten-line guest watcher that
  POSTs "folder dirty" to the CP — a nudge, not a sync engine. Not v1.
- Worker limits bound one tick (subrequests, CPU); big folders sync
  across consecutive ticks.
- Revocation: the syncer is CP code. It re-checks the grant each tick and
  stops. There is no client-side credential or loop to cut off.

## Attribution

- The CP authenticates every webapp write, so `edited-by` is server-set
  from day one.
- Guest-side edits arrive via the syncer and attribute to the workspace
  owner until IDENTITY.md phase 3 tickets carry per-user identity into
  the guest. Say so in the UI rather than faking precision.

## Non-goals (v1)

Real-time co-editing, CRDTs, file versioning (R2 object versioning is a
cheap later add), per-file grants, grant inheritance trees, cross-org or
public link sharing, full-text search. Each is additive on this model;
none is needed for the TODO.md e2e.

## Phases

1. **F1 — library + sharing (needs IDENTITY phase 2's memberships).**
   `0010_files`, the routes above, webapp folder browser + share dialog
   (reuses the members list), upload/download with chunking for big
   files, immediate revoke. Done when: member A shares a folder with
   member B; B browses and edits it from the webapp; A revokes; B's next
   request — including the next chunk of an in-flight upload — 403s.
2. **F2 — workspace materialization.** Attach flow + the CP-driven sync
   loop over the guest's existing WebDAV surface. No guest changes, no
   image re-pin. Done when: B attaches the shared folder in their own
   workspace, an agent edits a file there, the next tick lands it in the
   library and A sees it in the webapp — and a revoke stops B's sync at
   its next tick and 403s B's webapp access.

## Verify during implementation

- Workers request-body cap for the current plan tier — sets the chunk
  size and the small-file/multipart cutoff.
- R2 multipart via the binding (`createMultipartUpload` / `uploadPart` /
  `complete`): part-size minimum and part-count limit — together they set
  the practical max file size.
- Which guest service serves the WebDAV files surface, whether `PROPFIND`
  mtimes are reliable enough for LWW, and PUT behavior through the proxy
  path.
- Workers cron subrequest and CPU limits per invocation — sets the
  per-tick batch size.
- Current Workers and R2 price sheet (the estimate above uses 2026-01
  knowledge: Workers $5 base, $0.30/M requests, $0.02/M CPU-ms; R2
  $0.015/GB-mo, $4.50/M Class A, $0.36/M Class B, free egress).

## Cross-references

- [TODO.md](TODO.md): covers the folder/file-sharing bullets of the
  common stream; workspace sharing stays in IDENTITY.md — different
  object, same immediate-revoke rule.
- [IDENTITY.md](IDENTITY.md): memberships/grant pattern consumed as-is;
  phase 3 tickets upgrade guest attribution here; zero-credential-lifetime
  revocation is the shared decision.
- CLAUDE.md contract table: B2 adds **no new cross-runtime contract** —
  the syncer consumes the same guest WebDAV surface the webapp files
  panel already uses. If that surface later gets pinned fixtures, the
  syncer rides them.
