# Entitlements contract

BlitzOS core enforces limits as integers. It never learns a plan name. A
private billing service owns plans, translates one into integers, and pushes
them into core through a single route. `if (plan === "pro")` cannot appear in
core because a plan never crosses this boundary.

## Consumers

Both sides read these files, so neither can change the wire alone.

| Side | What it does | Where |
|---|---|---|
| This repository | Serves the routes and enforces the numbers | `packages/control-plane/core/entitlements.ts`, pinned by `packages/control-plane/test/entitlements-fixtures.test.ts` |
| The private billing service | Writes the numbers, verifies the handoff token, serves checkout | Separate repository; it copies this directory verbatim |

## The seam is off by default

Everything below is enabled by one Worker secret, `ENTITLEMENTS_API_KEY`.
Unset — the self-host default — means: no seat gate runs anywhere,
`PUT /orgs/:id/entitlements` answers 404, and the deployment behaves exactly as
it did before entitlements existed.

## The write

`PUT /orgs/:id/entitlements`, authenticated with
`Authorization: Bearer <ENTITLEMENTS_API_KEY>`.

| Answer | When |
|---|---|
| 204 | Written |
| 400 | Body fails `write-request-rejected.json` |
| 401 | Wrong or missing key |
| 404 | Unknown organization, or the secret is unset |

`seatLimit` is stored in `org_entitlements.seat_limit`. `vmLimit` is stored in
`orgs.vm_limit` — the existing column the workspace-create path has always
enforced. It is deliberately not copied into the new table: two rows holding
one limit is two answers to one question.

An organization with no `org_entitlements` row, on a deployment where the
secret IS set, is on the free tier: **one seat**. A solo organization is free
and the second person is the pay gate.

## The seat gates

Three, and all three are needed. Each is a predicate evaluated inside the
statement that would grant the seat, never a read followed by a write.

1. `POST /invites` — refuses early, for the person's sake. An invite is not a
   seat, so this one is soft.
2. Invite redemption, **including** the `ON CONFLICT ... DO UPDATE SET
   status = 'active'` branch. Gating only invite creation is bypassable by
   stockpiling codes while seats are free and redeeming them later.
3. Member re-activation, `PATCH /members/:id` to `status: "active"`.

Limits block **growth only**. Nothing here ever disables an existing member,
so a downgrade below the current seat count is not an error and is not
corrected: the organization simply cannot add anyone until it is back under
its limit.

A member who already holds an active seat passes every gate, at any limit:
changing their role is not growth.

## The refusal

HTTP 402 with `seat-limit-denial.json`. `paymentUrl` is
`<PAYMENT_URL>/checkout#token=<jwt>`, and the key is absent entirely where the
`PAYMENT_URL` var is empty.

The token is an HS256 JWT signed with `ENTITLEMENTS_API_KEY`, the same secret
the write route authenticates with, so the billing service verifies it without
a second key exchange. It expires 15 minutes after it is minted.

It is a **handoff, not an authorization**. It names the organization that hit
the wall and the person who was standing there; `role` is that person's role in
the organization, and at invite redemption it is the role the invite would have
granted to someone who is not a member yet. `controlPlaneOrigin` is the
deployment's own configured origin and `returnTo` is the page path that initiated
the request. The billing service validates both fields and gives Stripe that
same control-plane URL for success and cancellation. The normal BlitzOS session
authenticates the browser when it returns; nothing in the token grants anything.

## Fixtures

| Fixture | What it pins |
|---|---|
| `context.json` | The key, checkout origin, control-plane return location, and mint time every other fixture is built from |
| `write-request.json` | A body the write route accepts |
| `write-request-rejected.json` | Bodies it must refuse with 400 |
| `seat-limit-denial.json` | The 402 body, with and without a configured `PAYMENT_URL` |
| `handoff-claims.json` | The decoded claims inside that `paymentUrl` |
| `usage.json` | `GET /orgs/:id/usage`, with seat gating on and off |
| `corpus.sha256` | SHA-256 of every other fixture's filename and exact bytes, in filename order |
