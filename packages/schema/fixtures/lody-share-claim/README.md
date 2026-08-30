# Lody share claim (gateway → bridge)

What a verified session-share claim looks like on the way from the Go gateway to
`blitz-lody-bridge`, and what the bridge is required to do with it.

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
