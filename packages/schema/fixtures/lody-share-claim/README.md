# Lody share claim (gateway → bridge)

What a verified session-share claim looks like on the way from the Go gateway to
`blitz-lody-bridge`, and what the bridge is required to do with it.

At HEAD the box still installs the transition `lody@0.88.1` npm artifact and
its compiled patches until plan PR C; the target daemon is built from
`vendor/lody`. The catalog recapture rule and upstream procedure are in
`docs/LODY-MERGE.md`.

## Why this is a BlitzOS contract

The claim starts life in the control plane, inside a webApp ticket
(`fixtures/webapp-ticket/`, which pins that half on three runtimes). The gateway
verifies the ticket and forwards the claim it found on `X-Blitz-Lody-Share`,
stripping any inbound copy first, so by the time the bridge sees one it is the
control plane's word rather than the browser's.

That hand-off is a payload crossing Go → node, and the decisions the bridge makes
from it are what stand between one member's session and another member's box. Two
hand-written readers for one wire format is exactly the arrangement CLAUDE.md's
cross-runtime rule exists for.

| Side | Code | What it does with a claim |
|---|---|---|
| gateway (Go) | `packages/box/gateway/main.go` | verifies it inside the ticket, refuses every path but `/lody/*`, forwards it on the header |
| bridge (node) | `packages/box/rootfs/usr/local/libexec/blitz-lody-bridge` | enforces the room ACL on `/sync`, scopes `/rpc` and `/project`, refuses `/control`, narrows `/platform` |

Design: `plans/LODY-SHARING.md` §3, §4.

## Catalog provenance

`catalog-full.json` is daemon-authored transition evidence and
`catalog-shared.json` is its bridge-derived projection. When reviewed semantic
behavior requires recapture, record: “Captured from the daemon built from
`vendor/lody` at `<upstreamSha>` (`distSha256` `<sha>`).” Use real stamp values
and regenerate the shared projection through the real bridge.

## Shape

- `claims.json` — three named claims and the exact header bytes each encodes to.
  A read-only grantee, a grantee holding both levels at once, and a workspace
  admin's implicit read-only (`scope: "all"`, both lists empty).
- `decisions.json` — the ACL, as a table rather than as prose.
  - `frames[]` — one protocol-v7 client frame each, with the verdict the bridge
    must reach: `forward`, `drop`, or `refuse`.
  - `requests[]` — one HTTP body each, with whether the door must pass it.
- `catalog-full.json` / `catalog-shared.json` — the daemon's own workspace
  catalog, and the projection a shared `/platform` request gets instead. The
  owner's request is still served byte-for-byte; a grantee gets the
  identity/workspace/machine triple, because the catalog also names every
  session on the box.
- `metaProjections[]` — the `meta` room's own projection, as a pair of frames:
  what the daemon sent, and what a claim of each kind receives. Phase 7 added
  this; see below.

## The `meta` room, and why it is projected rather than refused

Phase 6 refused `meta` outright for `scope: "sessions"`. That was right about
the leak — the room is loro-repo's document registry and names every document
on the box — and wrong about the cost, because **SessionMeta lives only there**:
a session's title, project, machineId, status and diff stats are metadata
records, not document body, so a grantee refused the room has nothing to render
(`plans/LODY-SHARING.md` §10.1 records the measurement).

The room is now served through a per-document projection, and the projection is
affordable because of what the room's payload turned out to be: `flock-json`, a
plain `{version, entries}` object whose keys are JSON-encoded paths —
`["e",<docId>]` for an existence record, `["m",<docId>,<field>]` for one
metadata field. Entries are self-contained last-write-wins records, which is the
property the protocol's own chunker already leans on, so dropping some of them
leaves the rest importable exactly as they arrived. **No CRDT is parsed and no
loro build is needed on the box.**

Two consequences worth naming:

- **This is the one place "server → client needs no filter" stops holding.** It
  held, and still holds for every other room, because the daemon addresses
  frames to the peers subscribed to a room and a grantee never joins the others.
  `meta` is the exception because the grantee does join it.
- **`meta` is read for every claim and write for none**, `rw` included. §0.1
  enumerates what a co-driver may do — prompt, steer, cancel, answer a
  permission request — and each of those is a session-document write or a
  machine RPC. Rename, archive and pin are meta writes and are not on the list.

## The three verdicts, and why they are three

`forward` and `refuse` are ordinary. `drop` is the interesting one, and it is
what read-only MEANS on a CRDT plane: a peer told its write failed tears the room
down and retries, while a peer whose write simply never lands keeps a divergent
local replica and re-converges from the owner's state on the next sync. So an
`update` a claim may not make is dropped silently and counted, and only a `join`
it may not make is refused — there the client is waiting on a `joined` that will
never come, and the refusal is `terminal` so a reconnect loop does not retry a
grant it does not have.

## Conformance

- Gateway (producer): `packages/box/gateway/main_test.go`
- Bridge (consumer): `packages/box/guest-tests/test/lody-bridge-share.test.ts`
