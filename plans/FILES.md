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
  pre-authorized, so nothing survives revocation.
- **Large files are chunked multipart through the CP.** The client slices
  under the Workers request-body cap; the CP drives R2's standard
  multipart API. Each chunk is a fresh request with a fresh grant check —
  revoke halts a transfer mid-file at the next chunk.
- **Rejected: presigned URLs** (and any approve-once-transfer-elsewhere
  scheme). A presigned URL is a bearer capability; R2 honors it without
  consulting the CP, so its expiry window (≥ tens of seconds) outlives a
  revoke. Structurally incompatible with zero credential lifetime.
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
- **No protocol engineering.** Plain HTTPS + JSON routes + R2's standard
  multipart API via the binding. The only "engine" we write is a trivial
  LWW compare loop (B2).
- **No per-file metadata table.** D1 stores folders and grants only. File
  listings come from R2 `ListObjectsV2` through the CP. No index to keep
  consistent with the bucket. If cost or search later demands an index,
  R2 event notifications can feed one; additive, not v1.
- Cost lever, not v1: a `folders.version` counter bumped on write lets
  sync ticks skip unchanged listings with one D1 read (list polling is
  the dominant R2 op cost).

## Schema (one migration, `0010_files`)

Same three-places rule as identity: migration + `build-blitzdev.mjs`
table defs + `blitzdev-schema.test.ts` exact-set assertions.

```
folders        id, org_id, name, version, created_by_membership_id,
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
- A small guest CLI (`blitz-files`, box image addition) runs the loop:
  list via CP, walk local, compare `(mtime, size)`, transfer diffs
  through the CP routes above, N parallel, chunking large files. Down
  applies remote-newer; up applies local-newer — `--update` semantics in
  both directions.
- Stateless loop: no state files, no rename tracking, and **no delete
  propagation in v1** (a delete on one side reappears on the next down;
  document it; delete via webapp for real removal). If delete propagation
  becomes a requirement, that is the moment to add sync state — not
  before.
- Trigger: on attach, on interval, on explicit `blitz-files push/pull`.
  Watchers later if the interval feels slow.
- Every list, get, put, and chunk hits the CP first, so a revoked
  member's loop dies on its very next request — including mid-file.

## Attribution

- The CP authenticates every operation, so `edited-by` is server-set for
  all writes from day one — browser and CLI alike.
- CLI writes attribute to the workspace owner until IDENTITY.md phase 3
  tickets carry per-user identity into the guest. Say so in the UI rather
  than faking precision.

## Non-goals (v1)

Real-time co-editing, CRDTs, file versioning (R2 object versioning is a
cheap later add), per-file grants, grant inheritance trees, cross-org or
public link sharing, full-text search. Each is additive on this model;
none is needed for the TODO.md e2e.

## Phases

1. **F1 — library + sharing (needs IDENTITY phase 2's memberships).**
   `0010_files`, the routes above, webapp folder browser + share dialog
   (reuses the members list), upload/download with chunking, immediate
   revoke. Done when: member A shares a folder with member B; B browses
   and edits it from the webapp; A revokes; B's next request — including
   the next chunk of an in-flight upload — 403s.
2. **F2 — workspace materialization.** `blitz-files` CLI + attach flow +
   `/workspace/shared/<name>` (box-image re-pin). Done when: B attaches
   the shared folder in their own workspace, an agent edits a file there,
   the edit lands in the library, and A sees it in the webapp — and a
   revoke stops B's sync at its next request.

## Verify during implementation

- Workers request-body size limit for the current plan tier — sets the
  chunk size and the small-file/multipart cutoff.
- R2 multipart (`createMultipartUpload`/`uploadPart`/`complete`) via the
  Worker binding, including part-size minimums.
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
- CLAUDE.md contract table: the `blitz-files` CLI ↔ CP list/transfer
  routes are a new cross-runtime payload — add fixtures under
  `packages/schema/fixtures/` with conformance tests on both sides
  before F2 ships.
