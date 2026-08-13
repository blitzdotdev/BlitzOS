# schema

One contract for the whole system.

- Workspace view types. The two enums: `phase` = `creating | ready |
  destroying | destroyed | error`, `retryAction` = `poll | destroy | create |
  null`. Broker wire. Volume shape. ACP conformance fixtures.
- The same fixture stream gates box publication and drives the ui reducer
  tests. One pinned ACP SDK version for both sides.
- control-plane implements it · ui imports it · box tests against it.

Decisions: the package TODOs + `sessions/2026-08-11-box-redesign-acp-docker.md`.
