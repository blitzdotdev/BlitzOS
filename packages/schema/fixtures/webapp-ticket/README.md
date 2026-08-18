# webApp ticket v1 contract

The control plane mints a ticket for every proxied request to a box, and two
independent verifiers on the guest read it: the Go gateway (port 7445) and the
Node actor (port 7444). Three hand-written parsers for one wire format is
exactly the arrangement these fixtures exist to pin — a claim added on one
side and missed on another does not fail loudly, it changes who is allowed to
do what.

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
`box/gateway/main_test.go`, `box/actor/test/auth-conformance.test.ts`.
