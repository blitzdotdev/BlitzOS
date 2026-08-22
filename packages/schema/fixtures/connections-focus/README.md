# Connections-focus fixtures

The `blitz connections open <provider>` CLI writes a single "focus" marker to
`/var/lib/blitz/connections-focus.json`; the Go gateway reads it at
`GET /connections-focus` and returns `{ "focus": <marker> }` or
`{ "focus": null }`. The webApp polls that route and opens the workspace
connections panel with the named provider selected — the agent's way of
sending a person to authorize a provider whose tools just went dark.

Each fixture pairs the marker file content (`input`) with the canonical
gateway response (`expected`). `input: null` represents an absent marker
file. The gateway rejects a marker that is not version 1, whose provider is
not 1-64 characters matching `[a-z0-9][a-z0-9._-]*` (catalog ids and
member-named generic connections; 64 is the cap templates and create requests
already enforce on connection names), or whose `requestedAt` is not a safe
non-negative integer; a rejected marker yields `{ "focus": null }`.

The marker is written by the in-box agent's own uid, so the CLI's validation
is convenience rather than a boundary and every reader repeats it. The
provider charset rule is the load-bearing one: the browser interpolates the
provider into panel state and the connect grid's selection, so a name no
catalog or connection row could carry is dropped before it renders.

Conformance: the Go gateway reader is tested in
`packages/box/gateway/main_test.go`; the CLI producer is tested in
`packages/box/actor/test/connections-focus-conformance.test.ts`; the browser
consumer (`fetchWorkspaceConnectionsFocus` / `parseConnectionsFocus` in
`packages/webapp/src/connections-focus.ts`) is tested in
`packages/webapp/test/connections-focus.test.ts`.
