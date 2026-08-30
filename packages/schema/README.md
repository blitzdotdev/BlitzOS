# schema

One contract for the whole system.

- Workspace view types. The two enums: `phase` = `creating | ready |
  destroying | destroyed | error`, `retryAction` = `poll | destroy | create |
  null`. Broker wire. Volume shape. Cross-runtime conformance fixtures.
- The same corpora gate box publication and pin the webapp, control-plane and
  Go readers of each contract.
- control-plane implements it · webapp imports it · box tests against it.

The fixture corpora live under [`fixtures/`](fixtures/) — one directory per
cross-runtime contract. The table mapping each contract to its fixtures and
both-side conformance tests is in the root [CLAUDE.md](../../CLAUDE.md).

