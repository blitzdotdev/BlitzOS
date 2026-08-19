# Preview-focus fixtures

The `blitz preview open` CLI writes a single "focus" marker to
`/var/lib/blitz/preview-focus.json`; the Go gateway reads it at
`GET /preview-focus` and returns `{ "focus": <marker> }` or `{ "focus": null }`.

Each fixture pairs the marker file content (`input`) with the canonical gateway
response (`expected`). `input: null` represents an absent marker file. The
gateway rejects a marker that is not version 1, whose port is out of the
1024-65535 range or reserved by the box, or whose path does not start with `/`;
a rejected marker yields `{ "focus": null }`.

Conformance: the Go gateway reader is tested in
`packages/box/gateway/main_test.go`; the CLI producer is tested in
`packages/box/actor/test/preview-focus-conformance.test.ts`. The browser
consumer lands in a later wave.
