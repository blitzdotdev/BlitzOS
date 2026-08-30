# webApp ticket v1 contract

The control plane mints a ticket for every proxied request to a box, and the
Go gateway (port 7445) verifies it on the guest. Two hand-written parsers for
one wire format is exactly the arrangement these fixtures exist to pin — a
claim added on one side and missed on the other does not fail loudly, it
changes who is allowed to do what.

## Format

```
v1.<base64url(claims)>.<base64url(HMAC-SHA256(workspaceToken, "v1." + payload))>
```

`workspaceToken` is `base64url(HMAC-SHA256(rootSecret, workspaceId))`. The
control plane derives it from the root secret; a guest reads it from
`/var/lib/blitz/webapp-token`, so each side signs and checks with the value it
natively holds.

Claims are exactly these five, no more and no fewer:

- `workspaceId` — must equal the box's own id
- `userId`, `membershipId` — who the request is for
- `role` — `owner`, `admin`, `editor`, or `viewer`
- `exp` — expiry in seconds; `exp <= now` is expired

…plus ONE optional sixth, `share`, present only on a ticket routed to ANOTHER
member's machine (`plans/LODY-SHARING.md` §3):

- `target` — the membership whose machine the request is routed to
- `scope` — `sessions` for an ordinary grantee, `all` for a workspace admin's
  implicit read-only over every session on that machine
- `read` — session ids this ticket may read
- `write` — session ids this ticket may also write, disjoint from `read`

All four keys are required when `share` is present, and an unrecognized key
INSIDE it is refused exactly like an unrecognized claim outside it. Two lists
rather than one level, because a grantee can hold read-only on one session and
read-write on another on the same box; the write predicate then never mentions
`scope`, which makes the admin's implicit access read-only by construction. At
most 64 ids in total, which is what keeps the header under every proxy default
in the path.

An ordinary ticket carries no `share` key at all, which is what keeps it
verifiable by every box image in the field. A ticket that DOES carry one is
refused by an older gateway — its decoder disallows unknown fields, on purpose
— so the control plane refuses the shared-session route on an older VM rather
than letting the box answer a 403 nobody can read.

A credential that does not start with `v1.` is compared against the static
per-workspace token, which predates tickets and presents as the owner. That
path is temporary — see `TODO(identity-phase-4)`.

## Fixtures

`context.json` carries the root secret, workspace id, derived workspace token,
and the fixed clock every case is evaluated against. Each file under
`tickets/` holds a `credential`, the `expect` every verifier must agree on, and
a `note` saying what the case is for. `expect.valid` false means refuse;
`expect.kind` distinguishes a real ticket from the static-token compatibility
path.

Conformance suites: `control-plane/test/webapp-ticket-conformance.test.ts`,
`box/gateway/main_test.go`.
