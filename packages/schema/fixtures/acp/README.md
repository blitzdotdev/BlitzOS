# ACP fixtures
Matched to stable protocol v1 in `@agentclientprotocol/sdk@1.3.0`.
Each line is one JSON-RPC frame; file order is stream order.
The same stream gates box publication and drives UI reducer tests.
Unknown and malformed fixtures are intentional negative cases.

Blitz phase-3 extensions use `params.actor` on journaled `session/update`
notifications and `blitz/permission_answered` to fan out the attributed
permission decision. `session/list` uses ACP's standard session shape and
stores `id`, `provider`, and `createdBy` in `_meta` for cross-device discovery.
