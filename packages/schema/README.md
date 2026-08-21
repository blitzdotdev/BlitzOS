# schema

One contract for the whole system.

- Workspace view types. The two enums: `phase` = `creating | ready |
  destroying | destroyed | error`, `retryAction` = `poll | destroy | create |
  null`. Broker wire. Volume shape. ACP conformance fixtures.
- The same fixture stream gates box publication and drives the webapp reducer
  tests. One pinned ACP SDK version for both sides.
- control-plane implements it · webapp imports it · box tests against it.

The fixture corpora live under [`fixtures/`](fixtures/) — one directory per
cross-runtime contract. The table mapping each contract to its fixtures and
both-side conformance tests is in the root [CLAUDE.md](../../CLAUDE.md).

