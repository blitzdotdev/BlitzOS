# ACP fixtures
Matched to stable protocol v1 in `@agentclientprotocol/sdk@1.3.0`.
Each line is one JSON-RPC frame; file order is stream order.
The same stream gates box publication and drives UI reducer tests.
Unknown and malformed fixtures are intentional negative cases.

Blitz phase-3 extensions use `params.actor` on journaled `session/update`
notifications and `blitz/permission_answered` to fan out the attributed
permission decision. `session/list` uses ACP's standard session shape and
stores `id`, `provider`, and `createdBy` in `_meta` for cross-device discovery.

`blitz/auth_required` announces that the box could not mint a credential for
the session's harness, so the reader has to sign that harness in again. Typed
in `schema/src/acp.ts`; `provider` is read off `HARNESSES`, so the ACP client
can never offer a sign-in the broker does not serve. The frame is live-only —
the actor never journals it, because replaying it onto tomorrow's attach would
demand a sign-in the session no longer needs. `auth-required.jsonl` therefore
carries the pair the actor really emits: the notification, then the ordinary
`session/update` prose bubble that IS the persisted half of the same event.
